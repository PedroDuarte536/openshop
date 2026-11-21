import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHmac, hkdfSync } from "node:crypto";
import { DuplicateKeyError } from "@openshop/db";
import { audit } from "./audit.ts";
import type { Db, User } from "./types.ts";
import { CONFIG } from "./config.ts";

const scryptAsync = (pw: string, salt: Buffer, len: number, o: { N: number; r: number; p: number }) =>
  new Promise<Buffer>((res, rej) => scrypt(pw, salt, len, { ...o, maxmem: 256 * o.N * o.r + 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));

// Versioned format so the cost can be raised later (rehash on sign-in). Older hashes ("salt:hash") stay valid.
const COST = { N: 16384, r: 8, p: 1 };
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${COST.N}$${COST.r}$${COST.p}$${salt.toString("hex")}$${(await scryptAsync(pw, salt, 64, COST)).toString("hex")}`;
}
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  let salt: string | undefined, hash: string | undefined, o = { N: 16384, r: 8, p: 1 };
  if (stored.startsWith("scrypt$")) {
    const [, n, r, p, s, h] = stored.split("$");
    o = { N: Number(n), r: Number(r), p: Number(p) };
    // Bounded, so a corrupt or hostile stored value can't make a sign-in burn memory or CPU.
    if (!(o.N >= 1024 && o.N <= 2 ** 20 && (o.N & (o.N - 1)) === 0 && o.r >= 1 && o.r <= 32 && o.p >= 1 && o.p <= 4)) return false;
    salt = s; hash = h;
  } else [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  if (!expected.length) return false;
  const actual = await scryptAsync(pw, Buffer.from(salt, "hex"), expected.length, o);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const mac = (body: string, key: Buffer) => b64(createHmac("sha256", key).update(body).digest());

/** Who a token is for. Each audience signs with its own key derived from AUTH_SECRET, and the claim is checked too. */
export type Audience = "admin" | "customer";
const keys = new Map<string, Buffer>();
function keyFor(secret: string, aud: Audience): Buffer {
  const id = `${aud}\0${secret}`;
  let k = keys.get(id);
  if (!k) { k = Buffer.from(hkdfSync("sha256", secret, "openshop-token", `openshop:${aud}`, 32)); keys.set(id, k); }
  return k;
}

export function signToken(sub: string, secret: string, ttlSec = CONFIG.auth.adminSessionSeconds, aud: Audience = "admin", extra: Record<string, string | number> = {}): string {
  const body = b64(JSON.stringify({ ...extra, sub, aud, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  return `${body}.${mac(body, keyFor(secret, aud))}`;
}
/** Why a token was refused (for the activity log), or its claims. */
export function checkToken(token: string, secret: string, aud: Audience = "admin"): { claims: { sub: string } & Record<string, unknown> } | { reason: "bad_token" | "expired" } {
  const [body, sig] = token.split(".");
  if (!body || !sig) return { reason: "bad_token" };
  const good = Buffer.from(mac(body, keyFor(secret, aud))), got = Buffer.from(sig);
  if (good.length !== got.length || !timingSafeEqual(good, got)) return { reason: "bad_token" };
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    if (typeof p.sub !== "string" || p.aud !== aud) return { reason: "bad_token" };
    return p.exp > Date.now() / 1000 ? { claims: p } : { reason: "expired" };
  } catch { return { reason: "bad_token" }; }
}
/** The token's claims, only if the signature, the audience and the expiry are all valid. */
export function verifyClaims(token: string, secret: string, aud: Audience = "admin"): ({ sub: string } & Record<string, unknown>) | null {
  const r = checkToken(token, secret, aud);
  return "claims" in r ? r.claims : null;
}
export const verifyToken = (token: string, secret: string, aud: Audience = "admin"): string | null => verifyClaims(token, secret, aud)?.sub ?? null;

/** Admin session token for a staff member: carries the session version, so sessions can be ended server-side. */
export const staffToken = (u: User, secret: string) => signToken(u.id, secret, 8 * 3600, "admin", { sv: u.sessionVersion ?? 0 });

export const normalizeStaffEmail = (email: string) => email.trim().toLowerCase();

/** Creates the owner (sudo) account and reserves its email. */
export async function createSudo(db: Db, email: string, password: string): Promise<User> {
  const e = normalizeStaffEmail(email), id = randomUUID(), at = new Date().toISOString();
  try { await db.staffEmails.insert({ id: e, userId: id }); } catch (err) { if (!(err instanceof DuplicateKeyError)) throw err; await db.staffEmails.update(e, { userId: id }); }
  const u = await db.users.insert({
    id, email: e, name: e.split("@")[0], passwordHash: await hashPassword(password), status: "active", sudo: true,
    sessionVersion: 0, version: 1, createdAt: at, createdBy: null, activatedAt: at, lastLoginAt: null,
  });
  await audit(db, "system", "create-owner", "staff", u.id, undefined, { email: e, name: u.name, sudo: true });
  return u;
}

/**
 * Start-up handling of ADMIN_EMAIL / ADMIN_PASSWORD, fenced to the owner (owner decision D3 keeps today's behaviour):
 * - no users yet: create the owner;
 * - the owner's email equals ADMIN_EMAIL: set its password if it differs (which ends the owner's sessions);
 * - otherwise: change nothing. It never creates a second owner and never touches staff accounts.
 * Run `migrateIam` first on databases from before IAM.
 */
export async function ensureAdmin(db: Db, email: string, password: string): Promise<"created" | "reset" | "unchanged" | "ignored"> {
  const e = normalizeStaffEmail(email);
  const [sudo] = await db.users.find({ sudo: true }, { limit: 1 });
  if (!sudo) {
    if (await db.users.count()) throw new Error("Users exist but none is the owner: run migrateIam first.");
    await createSudo(db, e, password);
    return "created";
  }
  if (sudo.email !== e) {
    console.warn(`ADMIN_EMAIL (${e}) is not the owner account (${sudo.email}): ADMIN_PASSWORD was ignored.`);
    return "ignored";
  }
  if (sudo.passwordHash && (await verifyPassword(password, sudo.passwordHash))) return "unchanged";
  await db.users.updateWhere(sudo.id, { sudo: true }, { set: { passwordHash: await hashPassword(password), mustChangePassword: false }, inc: { sessionVersion: 1 } });
  await audit(db, "system", "password-reset", "staff", sudo.id, undefined, { by: "ADMIN_PASSWORD" });
  return "reset";
}

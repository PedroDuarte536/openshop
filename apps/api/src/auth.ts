import { randomBytes, scrypt, timingSafeEqual, createHmac } from "node:crypto";
import { promisify } from "node:util";
import type { Db } from "./types.ts";

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${(await scryptAsync(pw, salt, 64)).toString("hex")}`;
}
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [s, h] = stored.split(":");
  if (!s || !h) return false;
  const expected = Buffer.from(h, "hex");
  const actual = await scryptAsync(pw, Buffer.from(s, "hex"), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const mac = (body: string, secret: string) => b64(createHmac("sha256", secret).update(body).digest());

export function signToken(sub: string, secret: string, ttlSec = 8 * 3600): string {
  const body = b64(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  return `${body}.${mac(body, secret)}`;
}
export function verifyToken(token: string, secret: string): string | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const good = Buffer.from(mac(body, secret)), got = Buffer.from(sig);
  if (good.length !== got.length || !timingSafeEqual(good, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    return typeof p.sub === "string" && p.exp > Date.now() / 1000 ? p.sub : null;
  } catch { return null; }
}

/** Creates the admin if missing; updates the password if the user exists. */
export async function ensureAdmin(db: Db, email: string, password: string) {
  const e = email.toLowerCase();
  const passwordHash = await hashPassword(password);
  const [u] = await db.users.find({ email: e }, { limit: 1 });
  if (u) await db.users.update(u.id, { passwordHash });
  else await db.users.insert({ email: e, passwordHash });
}

import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { hashPassword, signToken, verifyClaims } from "./auth.ts";
import type { AccountLink, Customer, Db } from "./types.ts";
import { CONFIG } from "./config.ts";

// Customer accounts without an email server (owner decision D5): the owner creates a one-time link in the backoffice
// and shares it; the customer sets a password. Only activated customers can sign in, so "signed in" means "known to
// the owner", which is what makes customer prices and profiles safe (a typed email never unlocks them).

export const SESSION_COOKIE = "cs";
const SESSION_TTL = CONFIG.accounts.sessionSeconds;
export const LINK_TTL_MS = CONFIG.accounts.linkTtlMs;
export const PASSWORD_MIN = CONFIG.accounts.passwordMinLength;

/** The signed-in customer and the active profiles they belong to (with shopper-facing labels). */
export interface Account { customer: Customer; profileIds: string[]; profileLabels: Record<string, string> }

export function readCookie(req: FastifyRequest, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const publicCustomer = (c: Customer) => {
  const { passwordHash: _p, sessionVersion: _s, ...rest } = c;
  return { ...rest, activated: !!(c.passwordHash && c.activatedAt) };
};

/** Active profiles of a customer: membership not expired, profile not paused. */
export async function activeProfiles(db: Db, customerId: string, now = Date.now()): Promise<{ ids: string[]; labels: Record<string, string> }> {
  const members = (await db.profileMembers.find({ customerId })).filter((m) => !m.validUntil || Date.parse(m.validUntil) > now);
  if (!members.length) return { ids: [], labels: {} };
  const profiles = await db.profiles.find({ id: { $in: members.map((m) => m.profileId) }, status: "active" });
  return { ids: profiles.map((p) => p.id), labels: Object.fromEntries(profiles.map((p) => [p.id, p.publicLabel])) };
}

export function createAccounts(db: Db, secret: string) {
  // A real scrypt hash to verify against when the email is unknown, so timing doesn't reveal which accounts exist.
  const dummyHash = hashPassword(randomBytes(16).toString("hex"));

  async function account(req: FastifyRequest): Promise<Account | null> {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) return null;
    const claims = verifyClaims(token, secret, "customer");
    if (!claims) return null;
    const customer = await db.customers.get(claims.sub);
    if (!customer || !customer.passwordHash || !customer.activatedAt) return null;
    if ((customer.sessionVersion ?? 0) !== claims.sv) return null;
    const p = await activeProfiles(db, customer.id);
    return { customer, profileIds: p.ids, profileLabels: p.labels };
  }

  function signIn(reply: FastifyReply, customer: Customer) {
    const token = signToken(customer.id, secret, SESSION_TTL, "customer", { sv: customer.sessionVersion ?? 0 });
    reply.header("set-cookie", `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL}`);
  }
  function signOut(reply: FastifyReply) {
    reply.header("set-cookie", `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
  }

  /** Creates a one-time link (and revokes earlier unused links of the customer). Returns the token once. */
  async function createLink(customerId: string, purpose: AccountLink["purpose"], createdBy: string): Promise<{ token: string; path: string; expiresAt: string }> {
    const at = new Date().toISOString();
    for (const l of await db.accountLinks.find({ customerId, usedAt: null })) await db.accountLinks.updateWhere(l.id, { usedAt: null }, { set: { usedAt: at } });
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + LINK_TTL_MS).toISOString();
    await db.accountLinks.insert({ customerId, purpose, tokenHash: hashToken(token), expiresAt, usedAt: null, createdAt: at, createdBy });
    return { token, path: `/shop/account/${purpose}/${token}`, expiresAt };
  }

  /** A link that is unused, not expired and for this purpose. */
  async function findLink(token: string, purpose: AccountLink["purpose"]): Promise<AccountLink | null> {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
    const [l] = await db.accountLinks.find({ tokenHash: hashToken(token) }, { limit: 1 });
    if (!l || l.purpose !== purpose || l.usedAt || Date.parse(l.expiresAt) <= Date.now()) return null;
    return l;
  }

  /** Uses the link exactly once and sets the password; every existing session of the customer ends. */
  async function setPassword(link: AccountLink, password: string): Promise<Customer | null> {
    if (!(await db.accountLinks.updateWhere(link.id, { usedAt: null }, { set: { usedAt: new Date().toISOString() } }))) return null;
    const c = await db.customers.get(link.customerId);
    if (!c) return null;
    const passwordHash = await hashPassword(password);
    return db.customers.updateWhere(c.id, {}, { set: { passwordHash, activatedAt: c.activatedAt ?? new Date().toISOString() }, inc: { sessionVersion: 1 } });
  }

  return { account, signIn, signOut, createLink, findLink, setPassword, dummyHash };
}
export type Accounts = ReturnType<typeof createAccounts>;

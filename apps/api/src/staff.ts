import { createHash, randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { effective, PERMISSIONS } from "@openshop/iam";
import { hashPassword } from "./auth.ts";
import { recordActivity } from "./activity.ts";
import type { Db, StaffGroup, StaffLink, User } from "./types.ts";

// Staff accounts without an email server: the owner creates a one-time link (invite or password reset) and sends it
// by hand. Same rules as customer account links: 32 random bytes, only the hash stored, single use, expiring, and
// revocable at any time. The token travels in the URL fragment (/join#token), which browsers never send to servers.

export const LINK_TTL_MS = { invite: 72 * 3600 * 1000, reset: 24 * 3600 * 1000 } as const;
export const MAX_STAFF = 200;
export const MAX_GROUPS = 50;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** What the API shows about a staff member: never the password hash or the session version. */
export const publicStaff = (u: User) => ({
  id: u.id, email: u.email, name: u.name, status: u.status, sudo: !!u.sudo, version: u.version ?? 1,
  createdAt: u.createdAt ?? null, createdBy: u.createdBy ?? null, activatedAt: u.activatedAt ?? null, lastLoginAt: u.lastLoginAt ?? null,
  removedAt: u.removedAt ?? null, removedBy: u.removedBy ?? null, mustChangePassword: !!u.mustChangePassword,
});

export type LinkState = "pending" | "used" | "revoked" | "expired";
export function linkState(l: StaffLink, now = Date.now()): LinkState {
  if (l.usedAt) return "used";
  if (l.revokedAt) return "revoked";
  return Date.parse(l.expiresAt) <= now ? "expired" : "pending";
}

/** `backofficeUrl` (BACKOFFICE_URL) makes the links absolute; otherwise the backoffice prefixes its own address. */
export function createStaff(db: Db, opts: { backofficeUrl?: string } = {}) {
  async function revokeLinks(userId: string, by: string, req?: FastifyRequest): Promise<number> {
    const at = new Date().toISOString();
    let n = 0;
    for (const l of await db.staffLinks.find({ userId, usedAt: null, revokedAt: null })) {
      if (await db.staffLinks.updateWhere(l.id, { usedAt: null, revokedAt: null }, { set: { revokedAt: at, revokedBy: by } })) {
        n++;
        await recordActivity(db, "link_revoked", { userId: by, targetUserId: userId, purpose: l.purpose }, req);
      }
    }
    return n;
  }

  /** A new link; earlier unused links of the member are revoked. The token is returned once and never stored. */
  async function createLink(userId: string, purpose: StaffLink["purpose"], by: string, req?: FastifyRequest) {
    await revokeLinks(userId, by, req);
    const token = randomBytes(32).toString("base64url");
    const at = new Date(), expiresAt = new Date(at.getTime() + LINK_TTL_MS[purpose]).toISOString();
    await db.staffLinks.insert({ userId, purpose, tokenHash: hashToken(token), expiresAt, usedAt: null, createdAt: at.toISOString(), createdBy: by, revokedAt: null, revokedBy: null });
    await recordActivity(db, "link_created", { userId: by, targetUserId: userId, purpose }, req);
    const path = `/join#${token}`;
    return { path, url: opts.backofficeUrl ? new URL(path, opts.backofficeUrl).toString() : null, expiresAt, purpose };
  }

  /** The link, only if unused, not revoked and not expired. */
  async function findLink(token: string): Promise<StaffLink | null> {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
    const [l] = await db.staffLinks.find({ tokenHash: hashToken(token) }, { limit: 1 });
    return l && linkState(l) === "pending" ? l : null;
  }

  /**
   * Uses the link exactly once (the check and the change are one atomic statement, guarded on both "unused" and
   * "not revoked", so a revoke and a use can't both win), sets the password, activates an invited member and ends
   * every existing session.
   */
  async function consume(link: StaffLink, password: string): Promise<User | null> {
    if (Date.parse(link.expiresAt) <= Date.now()) return null;
    const user = await db.users.get(link.userId);
    if (!user || user.status === "removed") return null;
    if (!(await db.staffLinks.updateWhere(link.id, { usedAt: null, revokedAt: null }, { set: { usedAt: new Date().toISOString() } }))) return null;
    const at = new Date().toISOString();
    return db.users.updateWhere(user.id, { status: { $ne: "removed" } }, {
      set: { passwordHash: await hashPassword(password), mustChangePassword: false, status: user.status === "invited" ? "active" : user.status, activatedAt: user.activatedAt ?? at },
      inc: { sessionVersion: 1 },
    });
  }

  async function groupsOf(userId: string): Promise<StaffGroup[]> {
    const m = await db.staffMemberships.find({ userId });
    return m.length ? db.staffGroups.find({ id: { $in: m.map((x) => x.groupId) } }, { sort: { name: 1 } }) : [];
  }

  /** Each permission, whether the member has it and from which groups. */
  async function permissionSources(user: User) {
    const groups = await groupsOf(user.id);
    const eff = effective(user, groups);
    return PERMISSIONS.map((p) => ({
      id: p.id, area: p.area, label: p.label, granted: eff.has(p.id),
      groups: user.sudo ? [] : groups.filter((g) => effective({ sudo: false }, [g]).has(p.id)).map((g) => ({ id: g.id, name: g.name })),
    }));
  }

  return { createLink, revokeLinks, findLink, consume, groupsOf, permissionSources };
}
export type Staff = ReturnType<typeof createStaff>;

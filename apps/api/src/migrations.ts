import { DuplicateKeyError } from "@openshop/db";
import { identityId } from "./identity.ts";
import { forgetSettings, getSettings } from "./settings.ts";
import { PERMISSION_IDS } from "@openshop/iam";
import { audit } from "./audit.ts";
import type { Db, StaffGroup } from "./types.ts";

/**
 * One-time backfill (owner decision P-b): orders placed before discounts existed count towards "first N orders".
 * Counts non-cancelled orders per identity (normalised email).
 */
export async function migrateIdentities(db: Db): Promise<void> {
  const s = await getSettings(db);
  if (s.migrations?.identities) return;
  const counts = new Map<string, number>();
  for (const o of await db.orders.find({})) {
    if (o.status === "cancelled") continue;
    const id = o.identityId ?? identityId(o.customer.email);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const [id, orders] of counts) {
    try { await db.identities.insert({ id, orders }); }
    catch (e) { if (!(e instanceof DuplicateKeyError)) throw e; await db.identities.update(id, { orders }); }
  }
  await db.settings.update("shop", { migrations: { ...(s.migrations ?? {}), identities: new Date().toISOString() } });
  forgetSettings(db);
}

/**
 * One-time upgrade to staff accounts (IAM v2). Before, every backoffice user was a full admin.
 * - One user becomes the owner (sudo): the only user; else the one whose email is ADMIN_EMAIL; else the first by email (with a warning).
 * - Every other user becomes an active member of a new "Shop manager (migrated)" group with all 17 permissions, so nobody
 *   loses anything they could do before (team and security functions didn't exist).
 * - Everyone gets a name, a session version (tokens from before the upgrade are refused: one sign-in after deploying)
 *   and an email reservation. Duplicate emails (not expected) keep the first user; the others are suspended.
 */
export async function migrateIam(db: Db, opts: { adminEmail?: string } = {}): Promise<void> {
  const s = await getSettings(db);
  if (s.migrations?.iam) return;
  const users = (await db.users.find({})).sort((a, b) => a.email.localeCompare(b.email));
  const legacy = users.filter((u) => u.status === undefined);
  if (legacy.length) {
    const admin = opts.adminEmail?.trim().toLowerCase();
    const hasSudo = users.some((u) => u.sudo === true);
    const sudo = hasSudo ? null : legacy.length === 1 ? legacy[0] : legacy.find((u) => u.email === admin) ?? legacy[0];
    if (sudo && legacy.length > 1 && sudo.email !== admin) console.warn(`IAM migration: ${sudo.email} became the owner account (set ADMIN_EMAIL to choose).`);
    const at = new Date().toISOString();
    let group: StaffGroup | null = null;
    const seen = new Set(users.filter((u) => u.status !== undefined).map((u) => u.email));
    for (const u of legacy) {
      const dup = seen.has(u.email);
      seen.add(u.email);
      const isSudo = u.id === sudo?.id;
      await db.users.update(u.id, {
        name: u.name ?? u.email.split("@")[0], status: dup ? "suspended" : "active", sudo: isSudo, sessionVersion: u.sessionVersion ?? 0, version: 1,
        createdAt: u.createdAt ?? at, createdBy: null, activatedAt: u.activatedAt ?? at, lastLoginAt: u.lastLoginAt ?? null,
      });
      if (dup) { console.warn(`IAM migration: duplicate email ${u.email}; the later account was suspended.`); continue; }
      try { await db.staffEmails.insert({ id: u.email, userId: u.id }); } catch (e) { if (!(e instanceof DuplicateKeyError)) throw e; }
      if (!isSudo) {
        group ??= await db.staffGroups.insert({ name: "Shop manager (migrated)", description: "Created by the upgrade for backoffice users who had full access before.", permissions: [...PERMISSION_IDS], template: "shop-manager", createdAt: at, updatedAt: at, createdBy: "system", version: 1 });
        try { await db.staffMemberships.insert({ id: `${group.id}:${u.id}`, groupId: group.id, userId: u.id, addedAt: at, addedBy: "system" }); } catch (e) { if (!(e instanceof DuplicateKeyError)) throw e; }
      }
    }
    await audit(db, "system", "migrate", "staff", "iam", undefined, { owner: sudo?.email ?? null, members: legacy.length - (sudo ? 1 : 0) });
  }
  await db.settings.update("shop", { migrations: { ...((await getSettings(db)).migrations ?? {}), iam: new Date().toISOString() } });
  forgetSettings(db);
}

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { DuplicateKeyError } from "@openshop/db";
import { AREAS, AREA_LABELS, effective, MIN_LENGTH_BOUNDS, normalizePermissions, PERMISSION_IDS, PERMISSIONS, policyErrors, SUDO_FUNCTIONS, TEMPLATES, type PasswordPolicy } from "@openshop/iam";
import { normalizeStaffEmail } from "./auth.ts";
import { strictValidator } from "./strict.ts";
import { audit } from "./audit.ts";
import { csvRow, negotiate } from "./negotiate.ts";
import { ACTIVITY_KINDS, pruneActivity, queryActivity } from "./activity.ts";
import { getSecurity, RETENTION_CHOICES } from "./security.ts";
import { linkState, MAX_GROUPS, MAX_STAFF, publicStaff, type Staff } from "./staff.ts";
import type { ActivityKind, Db, StaffGroup, StaffLink, User } from "./types.ts";

const strict = { validatorCompiler: strictValidator };
const sudo = { config: { perm: "sudo" as const } };
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const idList = (max: number) => ({ type: "array", maxItems: max, items: { type: "string", maxLength: 64 } }) as const;
const inviteSchema = { type: "object", additionalProperties: false, required: ["email", "name"], properties: { email: { type: "string", maxLength: 254 }, name: { type: "string", minLength: 1, maxLength: 120 }, groupIds: idList(MAX_GROUPS) } } as const;
const groupProps = {
  name: { type: "string", minLength: 1, maxLength: 120 }, description: { type: "string", maxLength: 500 },
  permissions: { type: "array", maxItems: PERMISSION_IDS.length, items: { type: "string", enum: PERMISSION_IDS } }, template: { type: ["string", "null"], maxLength: 40 },
} as const;
const policySchema = { type: "object", additionalProperties: false, required: ["minLength", "requireClasses", "disallowEmail", "blockCommon"], properties: { minLength: { type: "integer", minimum: MIN_LENGTH_BOUNDS.min, maximum: MIN_LENGTH_BOUNDS.max }, requireClasses: { type: "integer", minimum: 0, maximum: 4 }, disallowEmail: { type: "boolean" }, blockCommon: { type: "boolean" } } } as const;

export function registerStaffAdmin(admin: FastifyInstance, { db, staff }: { db: Db; staff: Staff }) {
  const me = (req: FastifyRequest) => req.staff!.id;
  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: "not found" });
  const invalid = (reply: FastifyReply, field: string, message: string) => reply.code(400).send({ error: "Please fix the highlighted fields.", fields: [{ field, message }] });
  const conflict = (reply: FastifyReply, error: string, code: string, extra: object = {}) => reply.code(409).send({ error, code, ...extra });
  /** The owner account and the caller can't be suspended, removed or signed out through the team screens. */
  const protectedTarget = (reply: FastifyReply, req: FastifyRequest, u: User) => {
    if (u.sudo) return conflict(reply, "The owner account can't be changed here.", "sudo");
    if (u.id === me(req)) return conflict(reply, "You can't do this to your own account.", "self");
    return null;
  };

  // ------------------------------------------------------------------ views
  const names = async () => new Map((await db.users.find({})).map((u) => [u.id, u.status === "removed" ? `${u.name} (removed)` : u.name]));
  async function listView(filter: "active" | "removed" | "all") {
    const [users, memberships, groups, links] = await Promise.all([db.users.find({}, { sort: { name: 1 } }), db.staffMemberships.find({}), db.staffGroups.find({}), db.staffLinks.find({ usedAt: null, revokedAt: null })]);
    const gById = new Map(groups.map((g) => [g.id, g]));
    const now = Date.now();
    return users
      .filter((u) => filter === "all" || (filter === "removed") === (u.status === "removed"))
      .sort((a, b) => Number(b.sudo) - Number(a.sudo) || a.name.localeCompare(b.name))
      .map((u) => {
        const gs = memberships.filter((m) => m.userId === u.id).map((m) => gById.get(m.groupId)).filter((g): g is StaffGroup => !!g).sort((a, b) => a.name.localeCompare(b.name));
        const pending = links.filter((l) => l.userId === u.id && linkState(l, now) === "pending").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        return {
          ...publicStaff(u), groups: gs.map((g) => ({ id: g.id, name: g.name })),
          permissions: PERMISSION_IDS.filter((p) => effective(u, gs).has(p)),
          pendingLink: pending ? { purpose: pending.purpose, expiresAt: pending.expiresAt } : null,
          inviteExpired: u.status === "invited" && !pending,
        };
      });
  }
  const linkView = (l: StaffLink, who: Map<string, string>) => ({
    id: l.id, purpose: l.purpose, createdAt: l.createdAt, createdBy: who.get(l.createdBy) ?? l.createdBy, expiresAt: l.expiresAt,
    state: linkState(l), stateAt: l.usedAt ?? l.revokedAt ?? (linkState(l) === "expired" ? l.expiresAt : null), revokedBy: l.revokedBy ? who.get(l.revokedBy) ?? l.revokedBy : null,
  });
  async function detailView(u: User) {
    const who = await names();
    const links = await db.staffLinks.find({ userId: u.id }, { sort: { createdAt: -1 }, limit: 20 });
    const [row] = (await listView("all")).filter((x) => x.id === u.id);
    return { ...row, createdByName: u.createdBy ? who.get(u.createdBy) ?? null : null, removedByName: u.removedBy ? who.get(u.removedBy) ?? null : null, permissionSources: await staff.permissionSources(u), links: links.map((l) => linkView(l, who)) };
  }
  const groupView = async (g: StaffGroup) => {
    const members = await db.staffMemberships.find({ groupId: g.id });
    const users = members.length ? await db.users.find({ id: { $in: members.map((m) => m.userId) } }, { sort: { name: 1 } }) : [];
    return { ...g, memberCount: users.length, members: users.map((u) => ({ id: u.id, name: u.name, email: u.email, status: u.status })) };
  };

  // ------------------------------------------------------------------ catalogue
  admin.get("/api/permissions", sudo, async () => ({
    areas: AREAS.map((a) => ({ id: a, label: AREA_LABELS[a] })), permissions: PERMISSIONS, templates: TEMPLATES, sudoOnly: SUDO_FUNCTIONS,
  }));

  // ------------------------------------------------------------------ members
  admin.get<{ Querystring: { status?: string } }>("/api/staff", sudo, async (req, reply) => {
    const f = req.query.status === "removed" ? "removed" : req.query.status === "all" ? "all" : "active";
    const items = await listView(f);
    reply.header("vary", "Accept").header("cache-control", "no-store");
    const type = negotiate(req.headers.accept, ["application/json", "text/csv"]);
    if (!type) return reply.code(406).send({ error: "not acceptable" });
    if (type === "text/csv") {
      const label = new Map(PERMISSIONS.map((p) => [p.id, p.label]));
      const body = "\uFEFF" + csvRow(["name", "email", "status", "owner", "groups", "permissions", "last sign-in", "invited"])
        + items.map((i) => csvRow([i.name, i.email, i.status, i.sudo ? "yes" : "", i.groups.map((g) => g.name).join("; "), i.sudo ? "All permissions" : i.permissions.map((p) => label.get(p)).join("; "), i.lastLoginAt ?? "", i.createdAt ?? ""])).join("");
      return reply.type("text/csv; charset=utf-8").header("content-disposition", `attachment; filename="team.csv"`).send(body);
    }
    return { items, total: items.length };
  });

  admin.get<{ Params: { id: string } }>("/api/staff/:id", sudo, async (req, reply) => {
    const u = await db.users.get(req.params.id);
    return u ? detailView(u) : notFound(reply);
  });

  async function checkGroups(reply: FastifyReply, ids: string[]) {
    if (!ids.length) return true;
    const found = new Set((await db.staffGroups.find({ id: { $in: ids } })).map((g) => g.id));
    const gone = ids.filter((i) => !found.has(i));
    if (gone.length) { invalid(reply, "groupIds", `unknown groups: ${gone.join(", ")}`); return false; }
    return true;
  }
  async function setGroups(userId: string, groupIds: string[], by: string) {
    const want = new Set(groupIds), at = new Date().toISOString();
    const have = await db.staffMemberships.find({ userId });
    for (const m of have) if (!want.has(m.groupId)) await db.staffMemberships.delete(m.id);
    for (const g of want) if (!have.some((m) => m.groupId === g)) {
      try { await db.staffMemberships.insert({ id: `${g}:${userId}`, groupId: g, userId, addedAt: at, addedBy: by }); } catch (e) { if (!(e instanceof DuplicateKeyError)) throw e; }
    }
  }
  const activeCount = async () => (await db.users.find({})).filter((u) => u.status !== "removed").length;

  // Invite: the email is reserved first (primary key = email), so two invites of the same address can't both succeed.
  admin.post("/api/staff", { ...sudo, ...strict, schema: { body: inviteSchema } }, async (req, reply) => {
    const b = req.body as { email: string; name: string; groupIds?: string[] };
    const email = normalizeStaffEmail(b.email), name = b.name.trim();
    if (!EMAIL.test(email)) return invalid(reply, "email", "must be an email address");
    if (!name) return invalid(reply, "name", "required");
    const groupIds = [...new Set(b.groupIds ?? [])];
    if (!(await checkGroups(reply, groupIds))) return reply;
    if ((await activeCount()) >= MAX_STAFF) return conflict(reply, `A shop can have at most ${MAX_STAFF} staff members.`, "limit");
    const id = randomUUID();
    try { await db.staffEmails.insert({ id: email, userId: id }); }
    catch (e) {
      if (!(e instanceof DuplicateKeyError)) throw e;
      const owner = await db.staffEmails.get(email);
      const existing = owner ? await db.users.get(owner.userId) : null;
      if (existing?.status === "removed") return conflict(reply, `${existing.name} was removed from your team. Restore them instead.`, "removed_member", { userId: existing.id, name: existing.name });
      return reply.code(409).send({ error: "This person is already on your team.", code: "exists", fields: [{ field: "email", message: "already on your team" }] });
    }
    const at = new Date().toISOString();
    let u: User;
    try {
      u = await db.users.insert({ id, email, name, passwordHash: null, status: "invited", sudo: false, sessionVersion: 0, version: 1, createdAt: at, createdBy: me(req), activatedAt: null, lastLoginAt: null, removedAt: null, removedBy: null });
      await setGroups(id, groupIds, me(req));
    } catch (e) { await db.staffEmails.delete(email); await db.users.delete(id); throw e; }
    const link = await staff.createLink(u.id, "invite", me(req), req);
    await audit(db, me(req), "invite", "staff", u.id, undefined, { email, name, groupIds });
    return reply.code(201).send({ member: await detailView(u), link });
  });

  admin.post<{ Params: { id: string } }>("/api/staff/:id/restore", sudo, async (req, reply) => {
    const u = await db.users.get(req.params.id);
    if (!u) return notFound(reply);
    if (u.status !== "removed") return conflict(reply, "Only removed members can be restored.", "not_removed");
    if ((await activeCount()) >= MAX_STAFF) return conflict(reply, `A shop can have at most ${MAX_STAFF} staff members.`, "limit");
    const r = await db.users.updateWhere(u.id, { status: "removed", sudo: false }, { set: { status: "invited", removedAt: null, removedBy: null, passwordHash: null }, inc: { sessionVersion: 1, version: 1 } });
    if (!r) return conflict(reply, "This member changed at the same time. Reload and try again.", "version_conflict");
    const link = await staff.createLink(u.id, "invite", me(req), req);
    await audit(db, me(req), "restore", "staff", u.id, { status: "removed" }, { status: "invited" });
    return { member: await detailView(r), link };
  });

  admin.patch<{ Params: { id: string } }>("/api/staff/:id", {
    ...sudo, ...strict, schema: { body: { type: "object", additionalProperties: false, required: ["version"], properties: { name: { type: "string", minLength: 1, maxLength: 120 }, version: { type: "integer" } } } },
  }, async (req, reply) => {
    const u = await db.users.get(req.params.id);
    if (!u) return notFound(reply);
    const b = req.body as { name?: string; version: number };
    const name = b.name?.trim();
    if (b.name !== undefined && !name) return invalid(reply, "name", "required");
    const r = await db.users.updateWhere(u.id, { version: b.version }, { set: name ? { name } : {}, inc: { version: 1 } });
    if (!r) return conflict(reply, "This member was changed by someone else. Reload and try again.", "version_conflict");
    if (name && name !== u.name) await audit(db, me(req), "rename", "staff", u.id, { name: u.name }, { name });
    return detailView(r);
  });

  admin.put<{ Params: { id: string } }>("/api/staff/:id/groups", { ...sudo, ...strict, schema: { body: { type: "object", additionalProperties: false, required: ["groupIds"], properties: { groupIds: idList(MAX_GROUPS) } } } }, async (req, reply) => {
    const u = await db.users.get(req.params.id);
    if (!u) return notFound(reply);
    if (u.sudo) return conflict(reply, "The owner has every permission and isn't in groups.", "sudo");
    if (u.status === "removed") return conflict(reply, "Restore this member first.", "removed");
    const ids = [...new Set((req.body as { groupIds: string[] }).groupIds)];
    if (!(await checkGroups(reply, ids))) return reply;
    const before = (await db.staffMemberships.find({ userId: u.id })).map((m) => m.groupId).sort();
    await setGroups(u.id, ids, me(req));
    await audit(db, me(req), "groups", "staff", u.id, { groupIds: before }, { groupIds: [...ids].sort() });
    return detailView(u);
  });

  admin.post<{ Params: { id: string } }>("/api/staff/:id/links", { ...sudo, ...strict, schema: { body: { type: "object", additionalProperties: false, required: ["purpose"], properties: { purpose: { type: "string", enum: ["invite", "reset"] } } } } }, async (req, reply) => {
    const u = await db.users.get(req.params.id);
    if (!u) return notFound(reply);
    const { purpose } = req.body as { purpose: "invite" | "reset" };
    if (purpose === "invite" && u.status !== "invited") return conflict(reply, "Invitation links are for members who haven't joined yet.", "not_invited");
    if (purpose === "reset" && !(u.status === "active" || u.status === "suspended")) return conflict(reply, "Password reset links are for members who have joined.", "not_active");
    if (u.sudo) return conflict(reply, "The owner changes their password in My account.", "sudo");
    const link = await staff.createLink(u.id, purpose, me(req), req);
    await audit(db, me(req), `link-${purpose}`, "staff", u.id, undefined, { expiresAt: link.expiresAt });
    return reply.code(201).send(link);
  });

  admin.post<{ Params: { id: string } }>("/api/staff/:id/links/revoke", sudo, async (req, reply) => {
    const u = await db.users.get(req.params.id);
    if (!u) return notFound(reply);
    const revoked = await staff.revokeLinks(u.id, me(req), req);
    if (revoked) await audit(db, me(req), "link-revoke", "staff", u.id, undefined, { revoked });
    return { revoked };
  });

  const statusChange = (action: "suspend" | "reactivate" | "sign-out") =>
    admin.post<{ Params: { id: string } }>(`/api/staff/:id/${action}`, sudo, async (req, reply) => {
      const u = await db.users.get(req.params.id);
      if (!u) return notFound(reply);
      const p = protectedTarget(reply, req, u);
      if (p) return p;
      const r = action === "suspend" ? await db.users.updateWhere(u.id, { status: "active", sudo: false }, { set: { status: "suspended" }, inc: { sessionVersion: 1, version: 1 } })
        : action === "reactivate" ? await db.users.updateWhere(u.id, { status: "suspended", sudo: false }, { set: { status: "active" }, inc: { version: 1 } })
          : await db.users.updateWhere(u.id, { sudo: false }, { inc: { sessionVersion: 1 } });
      if (!r) return conflict(reply, action === "suspend" ? "Only active members can be suspended." : action === "reactivate" ? "Only suspended members can be reactivated." : "Not possible.", "status");
      await audit(db, me(req), action, "staff", u.id, { status: u.status }, { status: r.status });
      return detailView(r);
    });
  statusChange("suspend");
  statusChange("reactivate");
  statusChange("sign-out");

  // Soft delete (owner decision D2): sign-in blocked and sessions ended at once; the record, email and history are kept.
  admin.delete<{ Params: { id: string } }>("/api/staff/:id", sudo, async (req, reply) => {
    const u = await db.users.get(req.params.id);
    if (!u) return notFound(reply);
    const p = protectedTarget(reply, req, u);
    if (p) return p;
    const at = new Date().toISOString();
    const r = await db.users.updateWhere(u.id, { status: { $ne: "removed" }, sudo: false }, { set: { status: "removed", passwordHash: null, mustChangePassword: false, removedAt: at, removedBy: me(req) }, inc: { sessionVersion: 1, version: 1 } });
    // Clean-up is idempotent: a repeated DELETE finishes an interrupted one.
    await staff.revokeLinks(u.id, me(req), req);
    const memberships = await db.staffMemberships.find({ userId: u.id });
    for (const m of memberships) await db.staffMemberships.delete(m.id);
    if (r) await audit(db, me(req), "remove", "staff", u.id, { status: u.status, groupIds: memberships.map((m) => m.groupId) }, { status: "removed" });
    return reply.code(204).send();
  });

  // ------------------------------------------------------------------ groups
  admin.get("/api/staff-groups", sudo, async () => Promise.all((await db.staffGroups.find({}, { sort: { name: 1 } })).map(groupView)));
  admin.get<{ Params: { id: string } }>("/api/staff-groups/:id", sudo, async (req, reply) => {
    const g = await db.staffGroups.get(req.params.id);
    return g ? groupView(g) : notFound(reply);
  });

  admin.post("/api/staff-groups", { ...sudo, ...strict, schema: { body: { type: "object", additionalProperties: false, required: ["name", "permissions"], properties: groupProps } } }, async (req, reply) => {
    const b = req.body as { name: string; description?: string; permissions: string[]; template?: string | null };
    const name = b.name.trim();
    if (!name) return invalid(reply, "name", "required");
    if ((await db.staffGroups.count()) >= MAX_GROUPS) return conflict(reply, `A shop can have at most ${MAX_GROUPS} groups.`, "limit");
    const at = new Date().toISOString();
    const g = await db.staffGroups.insert({ name, description: (b.description ?? "").trim(), permissions: normalizePermissions(b.permissions), template: b.template ?? null, createdAt: at, updatedAt: at, createdBy: me(req), version: 1 });
    await audit(db, me(req), "create", "staff-group", g.id, undefined, { name: g.name, permissions: g.permissions });
    const dup = (await db.staffGroups.count({ name })) > 1;
    return reply.code(201).send({ ...(await groupView(g)), ...(dup ? { warning: "Another group has the same name." } : {}) });
  });

  admin.patch<{ Params: { id: string } }>("/api/staff-groups/:id", { ...sudo, ...strict, schema: { body: { type: "object", additionalProperties: false, required: ["version"], properties: { ...groupProps, version: { type: "integer" } } } } }, async (req, reply) => {
    const cur = await db.staffGroups.get(req.params.id);
    if (!cur) return notFound(reply);
    const { version, ...b } = req.body as { name?: string; description?: string; permissions?: string[]; template?: string | null; version: number };
    const set: Partial<StaffGroup> = { updatedAt: new Date().toISOString() };
    if (b.name !== undefined) { if (!b.name.trim()) return invalid(reply, "name", "required"); set.name = b.name.trim(); }
    if (b.description !== undefined) set.description = b.description.trim();
    if (b.permissions !== undefined) set.permissions = normalizePermissions(b.permissions);
    if (b.template !== undefined) set.template = b.template;
    const updated = await db.staffGroups.updateWhere(cur.id, { version }, { set, inc: { version: 1 } });
    if (!updated) return conflict(reply, "This group was changed by someone else. Reload it and try again.", "version_conflict");
    await audit(db, me(req), "update", "staff-group", cur.id, { name: cur.name, description: cur.description, permissions: cur.permissions }, { name: updated.name, description: updated.description, permissions: updated.permissions });
    const view = await groupView(updated);
    return { ...view, affectedMembers: view.members.filter((m) => m.status !== "removed").length };
  });

  admin.delete<{ Params: { id: string } }>("/api/staff-groups/:id", sudo, async (req, reply) => {
    const g = await db.staffGroups.get(req.params.id);
    if (!g) return notFound(reply);
    const members = await db.staffMemberships.find({ groupId: g.id });
    for (const m of members) await db.staffMemberships.delete(m.id);
    await db.staffGroups.delete(g.id);
    await audit(db, me(req), "delete", "staff-group", g.id, { name: g.name, permissions: g.permissions, memberIds: members.map((m) => m.userId) });
    return reply.code(204).send();
  });

  admin.post<{ Params: { id: string } }>("/api/staff-groups/:id/members", {
    ...sudo, ...strict, schema: { body: { type: "object", additionalProperties: false, properties: { add: idList(500), remove: idList(500) } } },
  }, async (req, reply) => {
    const g = await db.staffGroups.get(req.params.id);
    if (!g) return notFound(reply);
    const b = req.body as { add?: string[]; remove?: string[] };
    const add = [...new Set(b.add ?? [])];
    const users = add.length ? await db.users.find({ id: { $in: add } }) : [];
    for (const id of add) {
      const u = users.find((x) => x.id === id);
      if (!u) return invalid(reply, "add", `unknown member ${id}`);
      if (u.sudo) return invalid(reply, "add", "the owner has every permission and isn't in groups");
      if (u.status === "removed") return invalid(reply, "add", `${u.name} was removed; restore them first`);
    }
    const at = new Date().toISOString();
    let added = 0, removed = 0;
    for (const userId of add) {
      try { await db.staffMemberships.insert({ id: `${g.id}:${userId}`, groupId: g.id, userId, addedAt: at, addedBy: me(req) }); added++; }
      catch (e) { if (!(e instanceof DuplicateKeyError)) throw e; }
    }
    for (const userId of b.remove ?? []) if (await db.staffMemberships.delete(`${g.id}:${userId}`)) removed++;
    if (added || removed) await audit(db, me(req), "members", "staff-group", g.id, undefined, { add, remove: b.remove ?? [] });
    return { added, removed, ...(await groupView(g)) };
  });

  // ------------------------------------------------------------------ activity
  admin.get<{ Querystring: Record<string, string | undefined> }>("/api/activity", sudo, async (req, reply) => {
    const q = req.query;
    const iso = (v?: string) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : undefined);
    const kinds = (q.kinds ?? "").split(",").filter((k): k is ActivityKind => (ACTIVITY_KINDS as string[]).includes(k));
    reply.header("vary", "Accept").header("cache-control", "no-store");
    const type = negotiate(req.headers.accept, ["application/json", "text/csv"]);
    if (!type) return reply.code(406).send({ error: "not acceptable" });
    const csv = type === "text/csv";
    const r = await queryActivity(db, { kinds, userId: q.userId || undefined, ip: q.ip || undefined, from: iso(q.from), to: iso(q.to), q: q.q, before: q.before || undefined, limit: csv ? 10_000 : Math.min(Number(q.limit) || 50, 200) });
    const users = new Map((await db.users.find({})).map((u) => [u.id, u]));
    const items = r.items.map((e) => {
      const u = e.userId ? users.get(e.userId) : undefined, t = e.targetUserId ? users.get(e.targetUserId) : undefined;
      return { ...e, userName: u?.name ?? (e.userId === "system" ? "System" : null), userStatus: u?.status ?? null, targetName: t?.name ?? null };
    });
    if (csv) {
      const body = "\uFEFF" + csvRow(["time", "kind", "person", "person status", "detail", "permission", "reason", "method", "count", "ip", "browser"])
        + items.map((e) => csvRow([e.at, e.kind, e.userName ?? "", e.userStatus ?? "", e.kind === "change" ? `${e.action} ${e.entity} ${e.entityId}` : e.targetName ? `${e.purpose ?? ""} ${e.targetName}` : e.path ?? "", e.permission ?? "", e.reason ?? "", e.method ?? "", e.count ?? 1, e.ip ?? "", e.userAgent ?? ""])).join("");
      return reply.type("text/csv; charset=utf-8").header("content-disposition", `attachment; filename="activity.csv"`).send(body);
    }
    return { items, next: r.next };
  });

  // The full change (before → after) behind a "change" event.
  admin.get<{ Params: { id: string } }>("/api/activity/changes/:id", sudo, async (req, reply) => (await db.audit.get(req.params.id)) ?? notFound(reply));

  // ------------------------------------------------------------------ security settings
  const securityView = async () => {
    const s = await getSecurity(db);
    return { passwordPolicy: s.passwordPolicy, enforceStaffPolicyAtSignIn: s.enforceStaffPolicyAtSignIn, activityRetentionDays: s.activityRetentionDays, version: s.version, updatedAt: s.updatedAt, bounds: { minLength: MIN_LENGTH_BOUNDS, retention: RETENTION_CHOICES } };
  };
  admin.get("/api/security-settings", sudo, securityView);
  admin.patch("/api/security-settings", {
    ...sudo, ...strict,
    schema: { body: { type: "object", additionalProperties: false, required: ["version"], properties: {
      passwordPolicy: { type: "object", additionalProperties: false, properties: { staff: policySchema, customers: policySchema } },
      enforceStaffPolicyAtSignIn: { type: "boolean" }, activityRetentionDays: { type: "integer", enum: [...RETENTION_CHOICES] }, version: { type: "integer" },
    } } },
  }, async (req, reply) => {
    const b = req.body as { passwordPolicy?: { staff?: PasswordPolicy; customers?: PasswordPolicy }; enforceStaffPolicyAtSignIn?: boolean; activityRetentionDays?: 30 | 90 | 180 | 365; version: number };
    const cur = await getSecurity(db);
    const passwordPolicy = { staff: b.passwordPolicy?.staff ?? cur.passwordPolicy.staff, customers: b.passwordPolicy?.customers ?? cur.passwordPolicy.customers };
    for (const realm of ["staff", "customers"] as const) {
      const errs = policyErrors(passwordPolicy[realm]);
      if (errs.length) return invalid(reply, `passwordPolicy.${realm}`, errs.join("; "));
    }
    const set = { passwordPolicy, enforceStaffPolicyAtSignIn: b.enforceStaffPolicyAtSignIn ?? cur.enforceStaffPolicyAtSignIn, activityRetentionDays: b.activityRetentionDays ?? cur.activityRetentionDays, updatedAt: new Date().toISOString(), updatedBy: me(req) };
    const updated = await db.security.updateWhere("security", { version: b.version }, { set, inc: { version: 1 } });
    if (!updated) return conflict(reply, "The security settings were changed by someone else. Reload and try again.", "version_conflict");
    const pick = (s: typeof cur) => ({ passwordPolicy: s.passwordPolicy, enforceStaffPolicyAtSignIn: s.enforceStaffPolicyAtSignIn, activityRetentionDays: s.activityRetentionDays });
    await audit(db, me(req), "update", "security-settings", "security", pick(cur), pick(updated));
    if (set.activityRetentionDays < cur.activityRetentionDays) await pruneActivity(db, set.activityRetentionDays);
    return securityView();
  });
}

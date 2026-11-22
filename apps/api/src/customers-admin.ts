import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { DuplicateKeyError } from "@openshop/db";
import { addLocalDays, describeEffect, discountState, parseLocal, zonedToInstant } from "@openshop/pricing";
import { strictValidator } from "./strict.ts";
import { audit } from "./audit.ts";
import { sendList } from "./negotiate.ts";
import { getSettings } from "./settings.ts";
import { identityId } from "./identity.ts";
import { publicCustomer, type Accounts } from "./accounts.ts";
import type { PricingService } from "./pricing-service.ts";
import type { Customer, Db, DiscountProfile } from "./types.ts";
import type { Authorizer } from "./authorize.ts";
import type { Requirement } from "@openshop/iam";

const perm = (p: Requirement) => ({ config: { perm: p } });

const strict = { validatorCompiler: strictValidator };
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const customerCreate = {
  type: "object", additionalProperties: false, required: ["email", "name"],
  properties: { email: { type: "string", maxLength: 254 }, name: { type: "string", minLength: 1, maxLength: 200 }, address: { type: "string", maxLength: 1000 } },
} as const;
const customerPatch = { type: "object", additionalProperties: false, properties: { name: { type: "string", minLength: 1, maxLength: 200 }, address: { type: "string", maxLength: 1000 } } } as const;
const linkSchema = { type: "object", additionalProperties: false, required: ["purpose"], properties: { purpose: { type: "string", enum: ["activate", "reset"] } } } as const;
const profileProps = {
  name: { type: "string", minLength: 1, maxLength: 120 }, publicLabel: { type: "string", minLength: 1, maxLength: 80 },
  description: { type: "string", maxLength: 500 }, status: { type: "string", enum: ["active", "paused"] },
} as const;
const profileCreate = { type: "object", additionalProperties: false, required: ["name", "publicLabel"], properties: profileProps } as const;
const profilePatch = { type: "object", additionalProperties: false, required: ["version"], properties: { ...profileProps, version: { type: "integer" } } } as const;
const membersSchema = {
  type: "object", additionalProperties: false,
  properties: {
    add: { type: "array", maxItems: 500, items: { type: "object", additionalProperties: false, required: ["customerId"], properties: { customerId: { type: "string", maxLength: 64 }, lastDay: { type: ["string", "null"], maxLength: 10 } } } },
    remove: { type: "array", maxItems: 500, items: { type: "string", maxLength: 64 } },
  },
} as const;

export function registerCustomersAdmin(admin: FastifyInstance, { db, accounts, pricing, shopUrl }: { db: Db; accounts: Accounts; pricing: PricingService; shopUrl?: string; authz: Authorizer }) {
  const userOf = (req: FastifyRequest) => req.userId ?? "unknown";
  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: "not found" });
  const invalid = (reply: FastifyReply, field: string, message: string) => reply.code(400).send({ error: "Please fix the highlighted fields.", fields: [{ field, message }] });
  const now = () => Date.now();

  // ---------------------------------------------------------------- customers
  admin.get("/api/customers", perm("customers.view"), async () => {
    const [customers, members, profiles] = await Promise.all([db.customers.find({}, { sort: { email: 1 } }), db.profileMembers.find({}), db.profiles.find({})]);
    const names = new Map(profiles.map((p) => [p.id, p.name]));
    return customers.map((c) => ({ ...publicCustomer(c), profiles: members.filter((m) => m.customerId === c.id).map((m) => ({ id: m.profileId, name: names.get(m.profileId) ?? "" })) }));
  });

  admin.post("/api/customers", { ...perm("customers.manage"), schema: { body: customerCreate }, ...strict }, async (req, reply) => {
    const b = req.body as { email: string; name: string; address?: string };
    const email = b.email.trim().toLowerCase();
    if (!EMAIL.test(email)) return invalid(reply, "email", "must be an email address");
    if (await db.customers.count({ email })) return reply.code(409).send({ error: "A customer with this email already exists.", fields: [{ field: "email", message: "already a customer" }] });
    const c = await db.customers.insert({ email, name: b.name.trim(), address: (b.address ?? "").trim(), createdAt: new Date().toISOString(), sessionVersion: 0 });
    await audit(db, userOf(req), "create", "customer", c.id, undefined, { email, name: c.name });
    return reply.code(201).send(publicCustomer(c));
  });

  admin.patch<{ Params: { id: string } }>("/api/customers/:id", { ...perm("customers.manage"), schema: { body: customerPatch }, ...strict }, async (req, reply) => {
    const c = await db.customers.get(req.params.id);
    if (!c) return notFound(reply);
    const updated = (await db.customers.update(c.id, req.body as Partial<Customer>))!;
    await audit(db, userOf(req), "update", "customer", c.id, { name: c.name, address: c.address }, req.body);
    return publicCustomer(updated);
  });

  // Everything the owner needs on one screen: account state, profiles, personal offers and codes, usage, orders.
  admin.get<{ Params: { id: string } }>("/api/customers/:id", perm("customers.view"), async (req, reply) => {
    const c = await db.customers.get(req.params.id);
    if (!c) return notFound(reply);
    const identity = identityId(c.email);
    const [members, codes, usage, links, orders, discounts] = await Promise.all([
      db.profileMembers.find({ customerId: c.id }), db.voucherCodes.find({ assignedCustomerId: c.id }), db.discountUsage.find({ identityId: identity }),
      db.accountLinks.find({ customerId: c.id }), db.orders.find({ "customer.email": c.email }, { sort: { createdAt: -1 }, limit: 100 }), db.discounts.find({}),
    ]);
    const profiles = await db.profiles.find({ id: { $in: members.map((m) => m.profileId) } });
    const dName = (id: string) => discounts.find((d) => d.id === id)?.name ?? "Deleted offer";
    const pending = links.filter((l) => !l.usedAt && Date.parse(l.expiresAt) > now()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return {
      ...publicCustomer(c),
      pendingLink: pending ? { purpose: pending.purpose, expiresAt: pending.expiresAt } : null,
      profiles: members.map((m) => { const p = profiles.find((x) => x.id === m.profileId); return { id: m.profileId, name: p?.name ?? "Deleted profile", publicLabel: p?.publicLabel ?? "", status: p?.status ?? "paused", validUntil: m.validUntil }; }),
      personalOffers: discounts.filter((d) => d.audience?.type === "customers" && d.audience.customerIds.includes(c.id)).map((d) => ({ id: d.id, name: d.name, state: discountState({ ...d, usedCount: Number(d.usedCount) || 0 }, now()), effect: describeEffect(d) })),
      codes: codes.map((v) => ({ code: v.id, discountId: v.discountId, offer: dName(v.discountId), kind: v.kind, usedCount: v.usedCount })),
      usage: usage.map((u) => ({ discountId: u.discountId, offer: dName(u.discountId), orders: u.orders, amount: u.amountCents / 100 })),
      identityOrders: (await db.identities.get(identity))?.orders ?? 0,
      orders: orders.map((o) => ({ id: o.id, createdAt: o.createdAt, status: o.status, total: o.total, discountTotal: o.discountTotal ?? 0 })),
    };
  });

  // A one-time link to set a password (activation or reset). Shown once; share it any way you like.
  admin.post<{ Params: { id: string } }>("/api/customers/:id/links", { ...perm("customers.accounts"), schema: { body: linkSchema }, ...strict }, async (req, reply) => {
    const c = await db.customers.get(req.params.id);
    if (!c) return notFound(reply);
    const { purpose } = req.body as { purpose: "activate" | "reset" };
    const link = await accounts.createLink(c.id, purpose, userOf(req));
    await audit(db, userOf(req), `link-${purpose}`, "customer", c.id, undefined, { expiresAt: link.expiresAt });
    return reply.code(201).send({ path: link.path, url: shopUrl ? new URL(link.path, shopUrl).toString() : null, expiresAt: link.expiresAt });
  });

  admin.post<{ Params: { id: string } }>("/api/customers/:id/sign-out", perm("customers.accounts"), async (req, reply) => {
    const c = await db.customers.updateWhere(req.params.id, {}, { inc: { sessionVersion: 1 } });
    if (!c) return notFound(reply);
    await audit(db, userOf(req), "sign-out", "customer", c.id);
    return publicCustomer(c);
  });

  /**
   * Deletes a customer's personal data: the customer, their account links and profile memberships; unused personal
   * codes are deleted and used ones unassigned; they are removed from offers for specific customers (an offer left
   * with nobody is archived). Orders keep their own copy of the order details.
   */
  admin.delete<{ Params: { id: string } }>("/api/customers/:id", perm("customers.delete"), async (req, reply) => {
    const c = await db.customers.get(req.params.id);
    if (!c) return notFound(reply);
    for (const m of await db.profileMembers.find({ customerId: c.id })) await db.profileMembers.delete(m.id);
    for (const l of await db.accountLinks.find({ customerId: c.id })) await db.accountLinks.delete(l.id);
    for (const v of await db.voucherCodes.find({ assignedCustomerId: c.id })) {
      if (v.usedCount > 0) await db.voucherCodes.update(v.id, { assignedCustomerId: null }); else await db.voucherCodes.delete(v.id);
    }
    for (const d of await db.discounts.find({ "audience.type": "customers" })) {
      if (d.audience.type !== "customers" || !d.audience.customerIds.includes(c.id)) continue;
      const rest = d.audience.customerIds.filter((x) => x !== c.id);
      if (rest.length) await db.discounts.updateWhere(d.id, {}, { set: { audience: { type: "customers", customerIds: rest } }, inc: { version: 1 } });
      else await db.discounts.updateWhere(d.id, {}, { set: { status: "archived" }, inc: { version: 1 } });
    }
    await db.customers.delete(c.id);
    await audit(db, userOf(req), "delete", "customer", c.id);
    pricing.invalidate();
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------- profiles
  const profileView = async (p: DiscountProfile) => {
    const t = now();
    const members = await db.profileMembers.find({ profileId: p.id });
    const rules = (await db.discounts.find({ "audience.type": "profiles" })).filter((d) => d.audience.type === "profiles" && d.audience.profileIds.includes(p.id));
    return {
      ...p, memberCount: members.length, activeMembers: members.filter((m) => !m.validUntil || Date.parse(m.validUntil) > t).length,
      rules: rules.map((d) => ({ id: d.id, name: d.name, label: d.label, state: discountState({ ...d, usedCount: Number(d.usedCount) || 0 }, t), effect: describeEffect(d) })),
    };
  };

  admin.get("/api/discount-profiles", perm("discounts.view"), async () => Promise.all((await db.profiles.find({}, { sort: { name: 1 } })).map(profileView)));
  admin.get<{ Params: { id: string } }>("/api/discount-profiles/:id", perm("discounts.view"), async (req, reply) => {
    const p = await db.profiles.get(req.params.id);
    return p ? profileView(p) : notFound(reply);
  });

  admin.post("/api/discount-profiles", { ...perm("discounts.manage"), schema: { body: profileCreate }, ...strict }, async (req, reply) => {
    const b = req.body as { name: string; publicLabel: string; description?: string; status?: "active" | "paused" };
    const at = new Date().toISOString();
    const p = await db.profiles.insert({ name: b.name.trim(), publicLabel: b.publicLabel.trim(), description: (b.description ?? "").trim(), status: b.status ?? "active", createdAt: at, updatedAt: at, version: 1 });
    await audit(db, userOf(req), "create", "profile", p.id, undefined, p);
    return reply.code(201).send(await profileView(p));
  });

  // Profiles are live: a change applies to every member straight away. The response says how many that is.
  admin.patch<{ Params: { id: string } }>("/api/discount-profiles/:id", { ...perm("discounts.manage"), schema: { body: profilePatch }, ...strict }, async (req, reply) => {
    const cur = await db.profiles.get(req.params.id);
    if (!cur) return notFound(reply);
    const { version, ...patch } = req.body as Partial<DiscountProfile> & { version: number };
    const updated = await db.profiles.updateWhere(cur.id, { version }, { set: { ...patch, updatedAt: new Date().toISOString() }, inc: { version: 1 } });
    if (!updated) return reply.code(409).send({ error: "This profile was changed by someone else. Reload it and try again.", code: "version_conflict" });
    await audit(db, userOf(req), "update", "profile", cur.id, cur, updated);
    pricing.invalidate();
    const view = await profileView(updated);
    return { ...view, affectedMembers: view.activeMembers };
  });

  admin.delete<{ Params: { id: string } }>("/api/discount-profiles/:id", perm("discounts.manage"), async (req, reply) => {
    const p = await db.profiles.get(req.params.id);
    if (!p) return notFound(reply);
    const view = await profileView(p);
    if (view.memberCount) return reply.code(409).send({ error: "Remove the members first.", code: "in_use" });
    if (view.rules.some((r) => r.state !== "archived")) return reply.code(409).send({ error: "Archive this profile's offers first.", code: "in_use" });
    await db.profiles.delete(p.id);
    await audit(db, userOf(req), "delete", "profile", p.id, p);
    return reply.code(204).send();
  });

  admin.get<{ Params: { id: string } }>("/api/discount-profiles/:id/members", perm({ all: ["discounts.view", "customers.view"] }), async (req, reply) => {
    const p = await db.profiles.get(req.params.id);
    if (!p) return notFound(reply);
    const members = await db.profileMembers.find({ profileId: p.id }, { sort: { addedAt: 1 } });
    const customers = new Map((await db.customers.find({ id: { $in: members.map((m) => m.customerId) } })).map((c) => [c.id, c]));
    const items = members.map((m) => { const c = customers.get(m.customerId); return { customerId: m.customerId, email: c?.email ?? "", name: c?.name ?? "", activated: !!(c?.passwordHash && c?.activatedAt), validUntil: m.validUntil, addedAt: m.addedAt }; });
    return sendList(req, reply, { items, total: items.length, filename: `profile-${p.name}-members.csv`,
      columns: [["email", (i) => i.email], ["name", (i) => i.name], ["account", (i) => (i.activated ? "active" : "none")], ["valid until", (i) => i.validUntil ?? ""], ["added", (i) => i.addedAt]] });
  });

  // lastDay = "YYYY-MM-DD" in shop time: membership ends at the end of that day (exclusive next midnight).
  admin.post<{ Params: { id: string } }>("/api/discount-profiles/:id/members", { ...perm({ all: ["discounts.manage", "customers.view"] }), schema: { body: membersSchema }, ...strict }, async (req, reply) => {
    const p = await db.profiles.get(req.params.id);
    if (!p) return notFound(reply);
    const b = req.body as { add?: { customerId: string; lastDay?: string | null }[]; remove?: string[] };
    const { timezone } = await getSettings(db);
    const at = new Date().toISOString();
    for (const a of b.add ?? []) {
      if (!(await db.customers.get(a.customerId))) return invalid(reply, "add", `unknown customer ${a.customerId}`);
      if (a.lastDay && !parseLocal(`${a.lastDay}T00:00`)) return invalid(reply, "lastDay", "must be a date like 2026-12-31");
    }
    let added = 0, removed = 0;
    for (const a of b.add ?? []) {
      const validUntil = a.lastDay ? new Date(zonedToInstant(addLocalDays(`${a.lastDay}T00:00`, 1), timezone)).toISOString() : null;
      const id = `${p.id}:${a.customerId}`;
      try { await db.profileMembers.insert({ id, profileId: p.id, customerId: a.customerId, validUntil, addedAt: at, addedBy: userOf(req) }); added++; }
      catch (e) { if (!(e instanceof DuplicateKeyError)) throw e; await db.profileMembers.update(id, { validUntil }); }
    }
    for (const customerId of b.remove ?? []) if (await db.profileMembers.delete(`${p.id}:${customerId}`)) removed++;
    await audit(db, userOf(req), "members", "profile", p.id, undefined, { add: b.add ?? [], remove: b.remove ?? [] });
    pricing.invalidate();
    return { added, removed, ...(await profileView(p)) };
  });
}

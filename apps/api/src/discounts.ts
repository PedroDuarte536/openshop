import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { DuplicateKeyError } from "@openshop/db";
import {
  DiscountValidationError, discountState, generateCode, instantToLocal, isValidTimeZone, normalizeCode, normalizeDiscount,
  offsetLabel, parseLocal, PREFIX_PATTERN, zonedToInstant, type DiscountData, type FieldError,
} from "@openshop/pricing";
import { strictValidator } from "./strict.ts";
import { audit, queryAudit } from "./audit.ts";
import { csvRow, LIST_TYPES, negotiate, sendList } from "./negotiate.ts";
import { forgetSettings, getSettings, serverTimezone, zoneChanges } from "./settings.ts";
import { priceItems, type PricingService } from "./pricing-service.ts";
import { activeProfiles } from "./accounts.ts";
import type { Db, DiscountDoc, VoucherCode } from "./types.ts";
import { CONFIG } from "./config.ts";
import type { Authorizer } from "./authorize.ts";
import { satisfies, type Requirement } from "@openshop/iam";

// ---- request schemas (shape only; the domain rules live in @openshop/pricing normalizeDiscount) ----
const idList = { type: "array", items: { type: "string", maxLength: 64 }, maxItems: 1000 } as const;
const nInt = { type: ["integer", "null"] } as const;
const discountProps = {
  name: { type: "string", maxLength: 200 },
  label: { type: "string", maxLength: 200 },
  trigger: { type: "string", maxLength: 20 },
  scope: { type: "string", maxLength: 20 },
  audience: { type: "object", additionalProperties: false, required: ["type"], properties: { type: { type: "string", maxLength: 20 }, customerIds: idList, profileIds: idList } },
  target: { type: "object", additionalProperties: false, required: ["type"], properties: { type: { type: "string", maxLength: 20 }, productIds: idList, categoryIds: idList } },
  excludeProductIds: idList,
  effect: { type: "object", additionalProperties: false, required: ["type"], properties: { type: { type: "string", maxLength: 20 }, bp: { type: "integer" }, cents: { type: "integer" } } },
  conditions: { type: "object", additionalProperties: false, properties: { minSubtotalCents: nInt, minQty: nInt } },
  access: { type: "object", additionalProperties: false, properties: { requiresSignIn: { type: "boolean" } } },
  perCustomer: { type: "object", additionalProperties: false, properties: { maxOrders: nInt, maxAmountCents: nInt, firstOrders: nInt } },
  declinable: { type: "boolean" },
  limits: { type: "object", additionalProperties: false, properties: { totalUses: nInt, maxDiscountPerOrderCents: nInt } },
  schedule: { type: "object", additionalProperties: false, properties: { start: { type: ["string", "null"], maxLength: 16 }, end: { type: ["string", "null"], maxLength: 16 } } },
  status: { type: "string", maxLength: 20 },
  priority: { type: "integer" },
  combinable: { type: "boolean" },
  campaign: { type: ["string", "null"], maxLength: 100 },
} as const;
const createSchema = { type: "object", additionalProperties: false, required: ["name", "label", "effect"], properties: discountProps } as const;
const patchSchema = { type: "object", additionalProperties: false, required: ["version"], properties: { ...discountProps, version: { type: "integer" } } } as const;
const codesSchema = {
  type: "object", additionalProperties: false,
  properties: { code: { type: "string", maxLength: 64 }, generate: { type: "integer", minimum: 1, maximum: 10000 }, prefix: { type: "string", maxLength: 12 }, assignedCustomerId: { type: ["string", "null"], maxLength: 64 } },
} as const;
const simulateSchema = {
  type: "object", additionalProperties: false, required: ["items"],
  properties: {
    items: { type: "array", minItems: 1, maxItems: CONFIG.orders.maxLines, items: { type: "object", additionalProperties: false, required: ["productId", "qty"], properties: { productId: { type: "string", maxLength: 64 }, qty: { type: "integer", minimum: 1, maximum: CONFIG.orders.maxQty } } } },
    email: { type: ["string", "null"], maxLength: 254 },
    customerId: { type: ["string", "null"], maxLength: 64 },
    codes: { type: "array", maxItems: 1, items: { type: "string", maxLength: 64 } },
    at: { type: ["string", "null"], maxLength: 16 },
    selection: { type: "object", additionalProperties: false, properties: { scenario: { type: ["string", "null"], maxLength: 20 }, declined: { type: "array", maxItems: 50, items: { type: "string", maxLength: 64 } } } },
  },
} as const;
const settingsSchema = {
  type: "object", additionalProperties: false,
  properties: {
    timezone: { type: "string", maxLength: 64 },
    display: { type: "object", additionalProperties: false, properties: { showOriginalPrice: { type: "boolean" }, showBadge: { type: "boolean" }, showAlternatives: { type: "boolean" } } },
  },
} as const;
const strict = { validatorCompiler: strictValidator };

const DATA_KEYS: (keyof DiscountData)[] = ["name", "label", "trigger", "scope", "audience", "target", "excludeProductIds", "effect", "conditions", "access", "perCustomer", "declinable", "limits", "schedule", "startsAt", "endsAt", "status", "priority", "combinable", "campaign"];
const dataOf = (d: DiscountDoc): DiscountData => Object.fromEntries(DATA_KEYS.map((k) => [k, d[k]])) as unknown as DiscountData;

/** Referenced products, categories, customers and profiles must exist when an offer is saved. */
async function checkRefs(db: Db, d: DiscountData): Promise<FieldError[]> {
  const errors: FieldError[] = [];
  const missing = async (field: string, ids: string[], col: { find: Db["products"]["find"] } | null) => {
    if (!ids.length) return;
    const found = col ? new Set((await col.find({ id: { $in: ids } })).map((x) => x.id)) : new Set<string>();
    const gone = ids.filter((i) => !found.has(i));
    if (gone.length) errors.push({ field, message: `unknown ids: ${gone.slice(0, 5).join(", ")}${gone.length > 5 ? "…" : ""}` });
  };
  if (d.target.type === "products") await missing("target.productIds", d.target.productIds, db.products);
  if (d.target.type === "categories") await missing("target.categoryIds", d.target.categoryIds, db.categories as never);
  await missing("excludeProductIds", d.excludeProductIds, db.products);
  if (d.audience.type === "customers") await missing("audience.customerIds", d.audience.customerIds, db.customers as never);
  if (d.audience.type === "profiles") await missing("audience.profileIds", d.audience.profileIds, db.profiles as never);
  return errors;
}

const invalid = (reply: FastifyReply, errors: FieldError[]) => reply.code(400).send({ error: "Please fix the highlighted fields.", fields: errors });

export interface DiscountRoutesOptions { db: Db; pricing: PricingService; authz: Authorizer; now?: () => number }
const perm = (p: Requirement) => ({ config: { perm: p } });

/** History of one record: allowed with that area's view permission; anything else (or everything) is owner-only. */
const AUDIT_ENTITY: Record<string, Requirement> = {
  discount: "discounts.view", profile: "discounts.view", code: "discounts.codes", customer: "customers.view",
  product: "catalog.view", category: "catalog.view", order: "orders.view", settings: "settings.manage",
};

/** Admin routes for offers, codes, the simulator and shop settings. Register inside the authenticated scope. */
export function registerDiscountAdmin(admin: FastifyInstance, { db, pricing, authz, now = Date.now }: DiscountRoutesOptions) {
  const userOf = (req: FastifyRequest) => req.userId ?? "unknown";
  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: "not found" });
  const view = async (d: DiscountDoc) => ({
    ...d, state: discountState({ ...d, usedCount: Number(d.usedCount) || 0 }, now()),
    ...(d.trigger === "code" ? { codeCount: await db.voucherCodes.count({ discountId: d.id }) } : {}),
  });
  const changed = () => pricing.invalidate();

  // ---- offers ----
  admin.get<{ Querystring: { state?: string; trigger?: string; q?: string; campaign?: string } }>("/api/discounts", perm("discounts.view"), async (req) => {
    const { state, trigger, q, campaign } = req.query;
    const list = await Promise.all((await db.discounts.find(trigger === "code" || trigger === "automatic" ? { trigger } : {}, { sort: { createdAt: -1 } })).map(view));
    const needle = (q ?? "").trim().toLowerCase();
    return list.filter((d) => (!state || d.state === state) && (!campaign || d.campaign === campaign) && (!needle || d.name.toLowerCase().includes(needle) || d.label.toLowerCase().includes(needle) || (d.campaign ?? "").toLowerCase().includes(needle)));
  });

  admin.get<{ Params: { id: string } }>("/api/discounts/:id", perm("discounts.view"), async (req, reply) => {
    const d = await db.discounts.get(req.params.id);
    return d ? view(d) : notFound(reply);
  });

  admin.post("/api/discounts", { ...perm("discounts.manage"), schema: { body: createSchema }, ...strict }, async (req, reply) => {
    const { timezone } = await getSettings(db);
    let data: DiscountData;
    try { data = normalizeDiscount(req.body, { timezone, now: now() }); }
    catch (e) { if (e instanceof DiscountValidationError) return invalid(reply, e.errors); throw e; }
    // Offers for named customers (client prices) are chosen from personal data.
    if (data.audience.type === "customers" && !(await authz.allow(req, reply, "customers.view"))) return reply;
    const refs = await checkRefs(db, data);
    if (refs.length) return invalid(reply, refs);
    const at = new Date(now()).toISOString();
    const d = await db.discounts.insert({ ...data, usedCount: 0, createdAt: at, updatedAt: at, createdBy: userOf(req), version: 1 } as Omit<DiscountDoc, "id">);
    await audit(db, userOf(req), "create", "discount", d.id, undefined, d);
    changed();
    return reply.code(201).send(await view(d));
  });

  admin.patch<{ Params: { id: string } }>("/api/discounts/:id", { ...perm("discounts.manage"), schema: { body: patchSchema }, ...strict }, async (req, reply) => {
    const cur = await db.discounts.get(req.params.id);
    if (!cur) return notFound(reply);
    const { version, ...patch } = req.body as Record<string, unknown> & { version: number };
    if (version !== cur.version) return reply.code(409).send({ error: "This offer was changed by someone else. Reload it and try again.", code: "version_conflict" });
    if (patch.trigger === "automatic" && cur.trigger === "code" && (await db.voucherCodes.count({ discountId: cur.id }))) {
      return invalid(reply, [{ field: "trigger", message: "delete this offer's codes before making it automatic" }]);
    }
    const { timezone } = await getSettings(db);
    let data: DiscountData;
    try { data = normalizeDiscount({ ...dataOf(cur), ...patch }, { timezone, now: now() }); }
    catch (e) { if (e instanceof DiscountValidationError) return invalid(reply, e.errors); throw e; }
    // Offers for named customers (client prices) are chosen from personal data.
    if (data.audience.type === "customers" && !(await authz.allow(req, reply, "customers.view"))) return reply;
    const refs = await checkRefs(db, data);
    if (refs.length) return invalid(reply, refs);
    const updated = await db.discounts.updateWhere(cur.id, { version: cur.version ?? 1 }, { set: { ...data, updatedAt: new Date(now()).toISOString() }, inc: { version: 1 } });
    if (!updated) return reply.code(409).send({ error: "This offer was changed by someone else. Reload it and try again.", code: "version_conflict" });
    await audit(db, userOf(req), "update", "discount", cur.id, cur, updated);
    changed();
    return view(updated);
  });

  const setStatus = (action: string, status: DiscountData["status"]) =>
    admin.post<{ Params: { id: string } }>(`/api/discounts/:id/${action}`, perm("discounts.manage"), async (req, reply) => {
      const cur = await db.discounts.get(req.params.id);
      if (!cur) return notFound(reply);
      const updated = (await db.discounts.updateWhere(cur.id, {}, { set: { status, updatedAt: new Date(now()).toISOString() }, inc: { version: 1 } }))!;
      await audit(db, userOf(req), action, "discount", cur.id, { status: cur.status }, { status });
      changed();
      return view(updated);
    });
  setStatus("pause", "paused");
  setStatus("resume", "active");
  setStatus("archive", "archived");

  admin.post<{ Params: { id: string } }>("/api/discounts/:id/duplicate", perm("discounts.manage"), async (req, reply) => {
    const cur = await db.discounts.get(req.params.id);
    if (!cur) return notFound(reply);
    const at = new Date(now()).toISOString();
    // Copies start paused and without codes, so nothing goes live by accident.
    const copy = await db.discounts.insert({ ...dataOf(cur), name: `Copy of ${cur.name}`.slice(0, 120), status: "paused", usedCount: 0, createdAt: at, updatedAt: at, createdBy: userOf(req), version: 1 } as Omit<DiscountDoc, "id">);
    await audit(db, userOf(req), "duplicate", "discount", copy.id, { from: cur.id }, copy);
    changed();
    return reply.code(201).send(await view(copy));
  });

  admin.delete<{ Params: { id: string } }>("/api/discounts/:id", perm("discounts.manage"), async (req, reply) => {
    const cur = await db.discounts.get(req.params.id);
    if (!cur) return notFound(reply);
    if ((Number(cur.usedCount) || 0) > 0 || (await db.redemptions.count({ discountId: cur.id }))) {
      return reply.code(409).send({ error: "This offer has been used in orders, so it can't be deleted. Archive it instead.", code: "in_use" });
    }
    for (const c of await db.voucherCodes.find({ discountId: cur.id })) await db.voucherCodes.delete(c.id);
    await db.discounts.delete(cur.id);
    await audit(db, userOf(req), "delete", "discount", cur.id, cur);
    changed();
    return reply.code(204).send();
  });

  // ---- voucher codes (one URL; JSON or CSV by the Accept header) ----
  admin.get<{ Params: { id: string }; Querystring: { skip?: string; limit?: string } }>("/api/discounts/:id/codes", perm("discounts.codes"), async (req, reply) => {
    const d = await db.discounts.get(req.params.id);
    if (!d) return notFound(reply);
    const total = await db.voucherCodes.count({ discountId: d.id });
    const csv = /text\/csv/i.test(req.headers.accept ?? "");
    const skip = Math.max(0, Math.trunc(Number(req.query.skip) || 0));
    const d_ = CONFIG.discounts;
    const limit = req.query.limit !== undefined ? Math.min(d_.listMaxPageSize, Math.max(1, Math.trunc(Number(req.query.limit) || d_.listPageSize))) : csv ? d_.csvMaxRows : d_.listPageSize;
    const codes = await db.voucherCodes.find({ discountId: d.id }, { sort: { createdAt: 1, id: 1 }, skip, limit });
    // Personal codes name their customer: the email is personal data, shown only with "See customers".
    const seeCustomers = satisfies(req.staff, "customers.view");
    const assignedIds = seeCustomers ? [...new Set(codes.map((c) => c.assignedCustomerId).filter((x): x is string => !!x))] : [];
    const emails = new Map(assignedIds.length ? (await db.customers.find({ id: { $in: assignedIds } })).map((c) => [c.id, c.email]) : []);
    const items = codes.map((c) => ({ ...c, assignedEmail: c.assignedCustomerId ? emails.get(c.assignedCustomerId) ?? null : null }));
    return sendList<VoucherCode & { assignedEmail: string | null }>(req, reply, {
      items, total, filename: `codes-${d.name}.csv`,
      columns: [["code", (c) => c.id], ["kind", (c) => c.kind], ["used", (c) => c.usedCount], ["customer", (c) => c.assignedEmail ?? ""], ["created", (c) => c.createdAt]],
    });
  });

  admin.post<{ Params: { id: string } }>("/api/discounts/:id/codes", { ...perm("discounts.codes"), schema: { body: codesSchema }, ...strict }, async (req, reply) => {
    if ((req.body as { assignedCustomerId?: string | null }).assignedCustomerId && !(await authz.allow(req, reply, "customers.view"))) return reply;
    const d = await db.discounts.get(req.params.id);
    if (!d) return notFound(reply);
    if (d.trigger !== "code") return invalid(reply, [{ field: "trigger", message: "only code offers have codes" }]);
    const b = req.body as { code?: string; generate?: number; prefix?: string; assignedCustomerId?: string | null };
    const at = new Date(now()).toISOString();
    if ((b.code === undefined) === (b.generate === undefined)) return invalid(reply, [{ field: "code", message: "send either a code or a number of codes to generate" }]);
    // Personal codes: only this customer (signed in) can use them, and they appear in their account.
    const assigned = b.assignedCustomerId ?? null;
    if (assigned && !(await db.customers.get(assigned))) return invalid(reply, [{ field: "assignedCustomerId", message: "unknown customer" }]);
    if (b.code !== undefined) {
      const code = normalizeCode(b.code);
      if (!code) return invalid(reply, [{ field: "code", message: "4 to 32 letters, digits or dashes" }]);
      try { await db.voucherCodes.insert({ id: code, discountId: d.id, kind: "shared", usedCount: 0, assignedCustomerId: assigned, createdAt: at }); }
      catch (e) { if (e instanceof DuplicateKeyError) return reply.code(409).send({ error: "That code is already used by an offer.", fields: [{ field: "code", message: "already in use" }] }); throw e; }
      await audit(db, userOf(req), "create", "code", code, undefined, { discountId: d.id, kind: "shared" });
      return reply.code(201).send({ created: 1, items: [code] });
    }
    const prefix = (b.prefix ?? "").trim().toUpperCase();
    if (prefix && !PREFIX_PATTERN.test(prefix)) return invalid(reply, [{ field: "prefix", message: "1 to 12 letters or digits" }]);
    const codes: string[] = [];
    for (let i = 0, attempts = 0; i < b.generate! && attempts < b.generate! * 3; attempts++) {
      const code = generateCode(prefix);
      try { await db.voucherCodes.insert({ id: code, discountId: d.id, kind: "single", usedCount: 0, assignedCustomerId: assigned, createdAt: at }); codes.push(code); i++; }
      catch (e) { if (!(e instanceof DuplicateKeyError)) throw e; }
    }
    await audit(db, userOf(req), "generate", "code", d.id, undefined, { discountId: d.id, count: codes.length, prefix, assignedCustomerId: assigned });
    return reply.code(201).send({ created: codes.length, items: codes });
  });

  admin.delete<{ Params: { id: string; code: string } }>("/api/discounts/:id/codes/:code", perm("discounts.codes"), async (req, reply) => {
    const code = normalizeCode(req.params.code);
    const c = code ? await db.voucherCodes.get(code) : null;
    if (!c || c.discountId !== req.params.id) return notFound(reply);
    if (c.usedCount > 0 || (await db.redemptions.count({ code: c.id }))) return reply.code(409).send({ error: "This code has been used, so it can't be deleted.", code: "in_use" });
    await db.voucherCodes.delete(c.id);
    await audit(db, userOf(req), "delete", "code", c.id, c);
    return reply.code(204).send();
  });

  admin.get<{ Params: { id: string } }>("/api/discounts/:id/redemptions", perm({ all: ["discounts.view", "orders.view"] }), async (req, reply) => {
    const d = await db.discounts.get(req.params.id);
    if (!d) return notFound(reply);
    const reds = await db.redemptions.find({ discountId: d.id }, { sort: { at: -1 }, limit: CONFIG.discounts.csvMaxRows });
    const items = await Promise.all(reds.map(async (r) => {
      const o = await db.orders.get(r.orderId);
      return { orderId: r.orderId, at: r.at, code: r.code, amount: r.amountCents / 100, state: r.state, customerEmail: o?.customer.email ?? null, orderTotal: o?.total ?? null };
    }));
    return sendList(req, reply, {
      items, total: items.length, filename: `redemptions-${d.name}.csv`,
      columns: [["order", (r) => r.orderId], ["date", (r) => r.at], ["code", (r) => r.code], ["discount", (r) => r.amount.toFixed(2)], ["state", (r) => r.state], ["customer", (r) => r.customerEmail], ["order total", (r) => r.orderTotal]],
    });
  });

  // ---- simulator: the full engine result for any cart, email, code and moment ----
  admin.post("/api/discounts/simulate", { ...perm("discounts.view"), schema: { body: simulateSchema }, ...strict }, async (req, reply) => {
    if ((req.body as { customerId?: string | null }).customerId && !(await authz.allow(req, reply, "customers.view"))) return reply;
    const b = req.body as { items: { productId: string; qty: number }[]; email?: string | null; customerId?: string | null; codes?: string[]; at?: string | null; selection?: { scenario?: string | null; declined?: string[] } };
    const { timezone } = await getSettings(db);
    if (b.at && !parseLocal(b.at)) return invalid(reply, [{ field: "at", message: "must be a date and time like 2026-12-01T10:00" }]);
    if (b.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) return invalid(reply, [{ field: "email", message: "must be an email address" }]);
    const at = b.at ? zonedToInstant(b.at, timezone) : now();
    // A customer is simulated as signed in (with their profiles at that moment), to see exactly what they would pay.
    let account = null;
    if (b.customerId) {
      const customer = await db.customers.get(b.customerId);
      if (!customer) return invalid(reply, [{ field: "customerId", message: "unknown customer" }]);
      const p = await activeProfiles(db, customer.id, at);
      account = { customer, profileIds: p.ids, profileLabels: p.labels };
    }
    const q = await priceItems(db, pricing, { items: b.items, codes: b.codes, selection: { scenario: b.selection?.scenario ?? null, declined: b.selection?.declined ?? [] }, email: b.email || null, account, now: at, all: true });
    return { at: new Date(at).toISOString(), atLocal: instantToLocal(at, timezone), timezone, result: q.result };
  });

  // ---- shop settings (time zone, display) ----
  const settingsView = async () => {
    const s = await getSettings(db);
    const t = now();
    return { timezone: s.timezone, timezoneConfirmed: s.timezoneConfirmed, display: s.display, serverTimezone: serverTimezone(), offset: offsetLabel(t, s.timezone), nowLocal: instantToLocal(t, s.timezone) };
  };
  admin.get("/api/settings", perm("authenticated"), settingsView);

  admin.get<{ Querystring: { tz?: string } }>("/api/settings/timezone-impact", perm("settings.manage"), async (req, reply) => {
    const tz = req.query.tz ?? "";
    if (!isValidTimeZone(tz)) return invalid(reply, [{ field: "tz", message: "unknown time zone" }]);
    const changes = zoneChanges(await db.discounts.find({}), tz, now());
    return { timezone: tz, offset: offsetLabel(now(), tz), changes };
  });

  admin.patch("/api/settings", { ...perm("settings.manage"), schema: { body: settingsSchema }, ...strict }, async (req, reply) => {
    const b = req.body as { timezone?: string; display?: Record<string, boolean> };
    const cur = await getSettings(db);
    if (b.timezone !== undefined && !isValidTimeZone(b.timezone)) return invalid(reply, [{ field: "timezone", message: "unknown time zone" }]);
    const patch: Record<string, unknown> = { updatedAt: new Date(now()).toISOString(), updatedBy: userOf(req) };
    if (b.display) patch.display = { ...cur.display, ...b.display };
    if (b.timezone !== undefined) {
      patch.timezone = b.timezone;
      patch.timezoneConfirmed = true;
      if (b.timezone !== cur.timezone) {
        const t = now();
        for (const c of zoneChanges(await db.discounts.find({}), b.timezone, t)) {
          const d = (await db.discounts.get(c.id))!;
          // Keep the stored wall-clock times consistent with the instants in the new zone.
          const schedule = { start: instantToLocal(Date.parse(c.newStartsAt), b.timezone), end: c.newEndsAt ? instantToLocal(Date.parse(c.newEndsAt), b.timezone) : null };
          await db.discounts.updateWhere(c.id, {}, { set: { startsAt: c.newStartsAt, endsAt: c.newEndsAt, schedule }, inc: { version: 1 } });
          await audit(db, userOf(req), "rezone", "discount", c.id, { startsAt: d.startsAt, endsAt: d.endsAt, schedule: d.schedule }, { startsAt: c.newStartsAt, endsAt: c.newEndsAt, schedule });
        }
      }
    }
    await db.settings.update("shop", patch);
    await audit(db, userOf(req), "update", "settings", "shop", { timezone: cur.timezone, display: cur.display }, b);
    forgetSettings(db);
    changed();
    return settingsView();
  });

  // History of records, newest first and paged (JSON { items, next }, or CSV by the Accept header). Filters: record
  // (entity + id), action, person, time range. The history of one kind of record needs that area's view permission;
  // everything else (staff, security settings, the whole log) is owner-only.
  admin.get<{ Querystring: Record<string, string | undefined> }>("/api/audit", perm("authenticated"), async (req, reply) => {
    const q = req.query;
    const need: Requirement = (q.entity && AUDIT_ENTITY[q.entity]) || "sudo";
    if (!(await authz.allow(req, reply, need))) return reply;
    const iso = (v?: string) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : undefined);
    reply.header("vary", "Accept");
    const type = negotiate(req.headers.accept, LIST_TYPES);
    if (!type) return reply.code(406).send({ error: "not acceptable", accepts: LIST_TYPES });
    const csv = type === "text/csv";
    const r = await queryAudit(db, { entity: q.entity, entityId: q.id, action: q.action, userId: q.userId, from: iso(q.from), to: iso(q.to), before: q.before, limit: csv ? 10_000 : Math.min(Number(q.limit) || 50, 200) });
    const ids = [...new Set(r.items.map((e) => e.userId))];
    const names = new Map((ids.length ? await db.users.find({ id: { $in: ids } }) : []).map((u) => [u.id, u.status === "removed" ? `${u.name} (removed)` : u.name]));
    const items = r.items.map((e) => ({ ...e, userName: names.get(e.userId) ?? (e.userId === "system" ? "System" : null) }));
    if (csv) {
      const body = "\uFEFF" + csvRow(["time", "person", "action", "record", "record id", "before", "after"])
        + items.map((e) => csvRow([e.at, e.userName ?? e.userId, e.action, e.entity, e.entityId, e.before === undefined ? "" : JSON.stringify(e.before), e.after === undefined ? "" : JSON.stringify(e.after)])).join("");
      return reply.type("text/csv; charset=utf-8").header("content-disposition", `attachment; filename="history-${(q.entity ?? "all").replace(/[^a-z-]/g, "")}.csv"`).send(body);
    }
    return { items, next: r.next };
  });
}

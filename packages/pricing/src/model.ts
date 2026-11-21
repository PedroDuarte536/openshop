// Discount model + normalisation. This is the second validation layer (after the API's JSON schema): it runs when
// an offer is saved and again when offers are loaded, so a bad document can never reach the engine.

import type { Bp, Cents } from "./money.ts";
import { instantToLocal, isValidTimeZone, parseLocal, zonedToInstant } from "./zoned.ts";

export type Audience =
  | { type: "everyone" }
  | { type: "customers"; customerIds: string[] }
  | { type: "profiles"; profileIds: string[] };
export type Target =
  | { type: "all" }
  | { type: "products"; productIds: string[] }
  | { type: "categories"; categoryIds: string[] };
export type Effect =
  | { type: "percent"; bp: Bp }
  | { type: "amountOff"; cents: Cents }
  | { type: "fixedPrice"; cents: Cents };

export type Trigger = "automatic" | "code";
export type Scope = "line" | "order";
export type Status = "active" | "paused" | "archived";

/** Everything an owner defines about an offer (what the API accepts, after defaults). */
export interface DiscountData {
  name: string;
  label: string;
  trigger: Trigger;
  scope: Scope;
  audience: Audience;
  target: Target;
  excludeProductIds: string[];
  effect: Effect;
  conditions: { minSubtotalCents: Cents | null; minQty: number | null };
  access: { requiresSignIn: boolean };
  perCustomer: { maxOrders: number | null; maxAmountCents: Cents | null; firstOrders: number | null };
  declinable: boolean;
  limits: { totalUses: number | null; maxDiscountPerOrderCents: Cents | null };
  /** Wall-clock times in the shop time zone ("YYYY-MM-DDTHH:mm"). `end` is exclusive; null = never. */
  schedule: { start: string; end: string | null };
  /** UTC instants derived from `schedule` + shop time zone. The engine only looks at these. */
  startsAt: string;
  endsAt: string | null;
  status: Status;
  priority: number;
  combinable: boolean;
  campaign: string | null;
}

/** A stored offer. */
export interface Discount extends DiscountData {
  id: string;
  usedCount: number;
  createdAt?: string;
  updatedAt?: string;
  createdBy?: string;
  version?: number;
}

export type DiscountState = "archived" | "paused" | "scheduled" | "running" | "ended" | "used-up";

export function discountState(d: Pick<Discount, "status" | "startsAt" | "endsAt" | "limits" | "usedCount">, now: number): DiscountState {
  if (d.status === "archived") return "archived";
  if (d.status === "paused") return "paused";
  if (now < Date.parse(d.startsAt)) return "scheduled";
  if (d.endsAt && now >= Date.parse(d.endsAt)) return "ended";
  if (d.limits.totalUses != null && d.usedCount >= d.limits.totalUses) return "used-up";
  return "running";
}

export const LIMITS = {
  ids: { customers: 1000, profiles: 50, products: 1000, categories: 200, exclude: 1000 },
  maxCents: 1_000_000_000,
  maxBp: 10_000,
} as const;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface FieldError { field: string; message: string }
export class DiscountValidationError extends Error {
  errors: FieldError[];
  constructor(errors: FieldError[]) {
    super(errors.map((e) => `${e.field}: ${e.message}`).join("; "));
    this.name = "DiscountValidationError";
    this.errors = errors;
  }
}

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : null);

/**
 * Validates an offer and fills in defaults. `timezone` is the shop time zone; `now` is used for the default start.
 * Throws DiscountValidationError listing every problem.
 */
export function normalizeDiscount(raw: unknown, opts: { timezone: string; now: number }): DiscountData {
  const errors: FieldError[] = [];
  const fail = (field: string, message: string) => { errors.push({ field, message }); };
  const r = obj(raw);
  if (!r) throw new DiscountValidationError([{ field: "", message: "must be an object" }]);
  if (!isValidTimeZone(opts.timezone)) throw new DiscountValidationError([{ field: "timezone", message: "invalid shop time zone" }]);

  const text = (field: string, v: unknown, max: number): string => {
    if (typeof v !== "string" || !v.trim()) { fail(field, "is required"); return ""; }
    if (v.trim().length > max) fail(field, `must be at most ${max} characters`);
    return v.trim().slice(0, max);
  };
  const oneOf = <T extends string>(field: string, v: unknown, list: readonly T[], d?: T): T => {
    if (v === undefined && d !== undefined) return d;
    if (!list.includes(v as T)) { fail(field, `must be one of ${list.join(", ")}`); return (d ?? list[0]); }
    return v as T;
  };
  const int = (field: string, v: unknown, min: number, max: number, nullable = true): number | null => {
    if (v === undefined || v === null) { if (!nullable) fail(field, "is required"); return null; }
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) { fail(field, `must be a whole number from ${min} to ${max}`); return null; }
    return v;
  };
  const bool = (field: string, v: unknown, d: boolean): boolean => {
    if (v === undefined) return d;
    if (typeof v !== "boolean") { fail(field, "must be true or false"); return d; }
    return v;
  };
  const ids = (field: string, v: unknown, max: number, min = 1): string[] => {
    if (!Array.isArray(v)) { fail(field, "must be a list"); return []; }
    if (v.length < min) fail(field, min === 1 ? "pick at least one" : `needs at least ${min}`);
    if (v.length > max) fail(field, `at most ${max} allowed`);
    const out = [...new Set(v.filter((x): x is string => typeof x === "string" && ID.test(x)))];
    if (out.length !== new Set(v).size) fail(field, "contains invalid ids");
    return out.slice(0, max);
  };

  const name = text("name", r.name, 120);
  const label = text("label", r.label, 80);
  const trigger = oneOf("trigger", r.trigger, ["automatic", "code"] as const, "automatic");
  const scope = oneOf("scope", r.scope, ["line", "order"] as const, "line");

  let audience: Audience = { type: "everyone" };
  const a = obj(r.audience);
  if (r.audience !== undefined && !a) fail("audience", "must be an object");
  if (a) {
    const t = oneOf("audience.type", a.type, ["everyone", "customers", "profiles"] as const);
    if (t === "customers") audience = { type: t, customerIds: ids("audience.customerIds", a.customerIds, LIMITS.ids.customers) };
    else if (t === "profiles") audience = { type: t, profileIds: ids("audience.profileIds", a.profileIds, LIMITS.ids.profiles) };
  }

  let target: Target = { type: "all" };
  const tg = obj(r.target);
  if (r.target !== undefined && !tg) fail("target", "must be an object");
  if (tg) {
    const t = oneOf("target.type", tg.type, ["all", "products", "categories"] as const);
    if (t === "products") target = { type: t, productIds: ids("target.productIds", tg.productIds, LIMITS.ids.products) };
    else if (t === "categories") target = { type: t, categoryIds: ids("target.categoryIds", tg.categoryIds, LIMITS.ids.categories) };
  }
  const excludeProductIds = r.excludeProductIds === undefined ? [] : ids("excludeProductIds", r.excludeProductIds, LIMITS.ids.exclude, 0);

  let effect: Effect = { type: "percent", bp: 1000 };
  const e = obj(r.effect);
  if (!e) fail("effect", "is required");
  else if (!["percent", "amountOff", "fixedPrice"].includes(e.type as string)) fail("effect.type", "must be one of percent, amountOff, fixedPrice");
  else {
    const t = e.type as Effect["type"];
    if (t === "percent") effect = { type: t, bp: int("effect.bp", e.bp, 1, LIMITS.maxBp, false) ?? 0 };
    else if (t === "amountOff") effect = { type: t, cents: int("effect.cents", e.cents, 1, LIMITS.maxCents, false) ?? 0 };
    else effect = { type: t, cents: int("effect.cents", e.cents, 0, LIMITS.maxCents, false) ?? 0 };
  }
  if (effect.type === "fixedPrice" && scope === "order") fail("scope", "a fixed price applies to each item: use scope \"line\"");

  const c = obj(r.conditions) ?? {};
  const conditions = { minSubtotalCents: int("conditions.minSubtotalCents", c.minSubtotalCents, 1, LIMITS.maxCents), minQty: int("conditions.minQty", c.minQty, 1, 9999) };

  const targeted = audience.type !== "everyone";
  const ac = obj(r.access) ?? {};
  const requiresSignIn = bool("access.requiresSignIn", ac.requiresSignIn, targeted);
  if (targeted && !requiresSignIn) fail("access.requiresSignIn", "offers for specific customers or profiles always require sign-in");

  const pc = obj(r.perCustomer) ?? {};
  const perCustomer = {
    maxOrders: int("perCustomer.maxOrders", pc.maxOrders, 1, 1_000_000),
    maxAmountCents: int("perCustomer.maxAmountCents", pc.maxAmountCents, 1, LIMITS.maxCents),
    firstOrders: int("perCustomer.firstOrders", pc.firstOrders, 1, 1000),
  };
  const limited = perCustomer.maxOrders != null || perCustomer.maxAmountCents != null || perCustomer.firstOrders != null;
  const declinable = bool("declinable", r.declinable, limited);

  const l = obj(r.limits) ?? {};
  const limits = { totalUses: int("limits.totalUses", l.totalUses, 1, 1_000_000_000), maxDiscountPerOrderCents: int("limits.maxDiscountPerOrderCents", l.maxDiscountPerOrderCents, 1, LIMITS.maxCents) };

  const s = obj(r.schedule) ?? {};
  let start = instantToLocal(opts.now, opts.timezone);
  if (s.start !== undefined && s.start !== null) {
    if (!parseLocal(s.start)) fail("schedule.start", "must be a date and time like 2026-12-01T00:00 (years 2000-2100)");
    else start = s.start as string;
  }
  let end: string | null = null;
  if (s.end !== undefined && s.end !== null) {
    if (!parseLocal(s.end)) fail("schedule.end", "must be a date and time like 2027-01-01T00:00 (years 2000-2100)");
    else end = s.end as string;
  }
  const startMs = parseLocal(start) ? zonedToInstant(start, opts.timezone) : opts.now;
  const endMs = end ? zonedToInstant(end, opts.timezone) : null;
  if (endMs !== null && endMs <= startMs) fail("schedule.end", "must be after the start");

  const status = oneOf("status", r.status, ["active", "paused", "archived"] as const, "active");
  const priority = int("priority", r.priority, 0, 1000) ?? 0;
  const combinable = bool("combinable", r.combinable, false);
  let campaign: string | null = null;
  if (r.campaign !== undefined && r.campaign !== null && r.campaign !== "") {
    if (typeof r.campaign !== "string" || r.campaign.trim().length > 60) fail("campaign", "must be at most 60 characters");
    else campaign = r.campaign.trim() || null;
  }

  if (errors.length) throw new DiscountValidationError(errors);
  return {
    name, label, trigger, scope, audience, target, excludeProductIds, effect, conditions,
    access: { requiresSignIn }, perCustomer, declinable, limits,
    schedule: { start, end }, startsAt: new Date(startMs).toISOString(), endsAt: endMs === null ? null : new Date(endMs).toISOString(),
    status, priority, combinable, campaign,
  };
}

/** Re-derives UTC instants when the shop time zone changes (wall-clock meaning is kept). */
export function rezone(d: Pick<DiscountData, "schedule">, timezone: string): { startsAt: string; endsAt: string | null } {
  return {
    startsAt: new Date(zonedToInstant(d.schedule.start, timezone)).toISOString(),
    endsAt: d.schedule.end ? new Date(zonedToInstant(d.schedule.end, timezone)).toISOString() : null,
  };
}

/** A short human description of an effect, e.g. "−20%", "−€5.00 each", "€19.00 each". */
export function describeEffect(d: Pick<DiscountData, "effect" | "scope">, currency = "€"): string {
  const m = (c: number) => `${currency}${(c / 100).toFixed(2)}`;
  const e = d.effect;
  if (e.type === "percent") return `−${(e.bp / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%${d.scope === "order" ? " off the order" : ""}`;
  if (e.type === "amountOff") return `−${m(e.cents)}${d.scope === "line" ? " each" : " off the order"}`;
  return `${m(e.cents)} each`;
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDiscount, DiscountValidationError, discountState, rezone, describeEffect } from "../src/index.ts";
import { NOW, offer } from "./helpers.ts";

const base = { name: "Winter sale", label: "Winter sale", effect: { type: "percent", bp: 2000 } };
const errorsOf = (raw: unknown, tz = "UTC") => {
  try { normalizeDiscount(raw, { timezone: tz, now: NOW }); return []; }
  catch (e) { assert.ok(e instanceof DiscountValidationError); return e.errors.map((x) => x.field); }
};

test("defaults: starts now (shop time), never ends, active, everyone, guests allowed", () => {
  const d = normalizeDiscount(base, { timezone: "Europe/Lisbon", now: NOW });
  assert.equal(d.schedule.start, "2026-06-15T13:00", "12:00Z is 13:00 in Lisbon summer");
  assert.equal(d.startsAt, "2026-06-15T12:00:00.000Z");
  assert.equal(d.schedule.end, null);
  assert.equal(d.endsAt, null);
  assert.equal(d.status, "active");
  assert.equal(d.trigger, "automatic");
  assert.equal(d.scope, "line");
  assert.deepEqual(d.audience, { type: "everyone" });
  assert.deepEqual(d.target, { type: "all" });
  assert.equal(d.access.requiresSignIn, false);
  assert.equal(d.declinable, false);
  assert.equal(d.combinable, false);
});

test("shop time zone decides the instant: midnight Lisbon is the same instant everywhere", () => {
  const d = normalizeDiscount({ ...base, schedule: { start: "2026-12-01T00:00", end: "2027-01-01T00:00" } }, { timezone: "Europe/Lisbon", now: NOW });
  assert.equal(d.startsAt, "2026-12-01T00:00:00.000Z");
  assert.equal(d.endsAt, "2027-01-01T00:00:00.000Z");
  const ny = rezone(d, "America/New_York");
  assert.equal(ny.endsAt, "2027-01-01T05:00:00.000Z", "re-zoning keeps the wall-clock meaning");
});

test("past starts are allowed", () => {
  const d = normalizeDiscount({ ...base, schedule: { start: "2026-01-01T00:00" } }, { timezone: "UTC", now: NOW });
  assert.equal(discountState({ ...d, usedCount: 0 }, NOW), "running");
});

test("validation rejects bad input with field-level messages", () => {
  assert.deepEqual(errorsOf({ ...base, effect: { type: "fixedPrice", cents: 1900 }, scope: "order" }), ["scope"]);
  assert.deepEqual(errorsOf({ ...base, audience: { type: "customers", customerIds: ["c1"] }, access: { requiresSignIn: false } }), ["access.requiresSignIn"]);
  assert.deepEqual(errorsOf({ ...base, schedule: { start: "2026-07-01T00:00", end: "2026-07-01T00:00" } }), ["schedule.end"]);
  assert.deepEqual(errorsOf({ ...base, schedule: { start: "2026-07-01 00:00" } }), ["schedule.start"]);
  assert.deepEqual(errorsOf({ ...base, effect: { type: "percent", bp: 0 } }), ["effect.bp"]);
  assert.deepEqual(errorsOf({ ...base, effect: { type: "percent", bp: 10001 } }), ["effect.bp"]);
  assert.deepEqual(errorsOf({ ...base, effect: { type: "percent", bp: 12.5 } }), ["effect.bp"]);
  assert.deepEqual(errorsOf({ ...base, effect: { type: "bogus" } }), ["effect.type"]);
  assert.deepEqual(errorsOf({ ...base, effect: { type: "amountOff", cents: -5 } }), ["effect.cents"]);
  assert.deepEqual(errorsOf({ ...base, target: { type: "products", productIds: [] } }), ["target.productIds"]);
  assert.deepEqual(errorsOf({ ...base, target: { type: "products", productIds: ["ok", "bad id!"] } }), ["target.productIds"]);
  assert.deepEqual(errorsOf({ ...base, name: "x".repeat(121) }), ["name"]);
  assert.deepEqual(errorsOf({ ...base, label: "" }), ["label"]);
  assert.deepEqual(errorsOf({ ...base, perCustomer: { maxOrders: 0 } }), ["perCustomer.maxOrders"]);
  assert.deepEqual(errorsOf({ ...base, status: "deleted" }), ["status"]);
  assert.deepEqual(errorsOf({ ...base, priority: "high" }), ["priority"]);
  assert.deepEqual(errorsOf(base, "Nowhere/Land"), ["timezone"]);
  assert.equal(errorsOf({ name: "", label: "", effect: null }).length, 3, "reports every problem at once");
});

test("targeted audiences require sign-in by default; per-customer limits make offers declinable", () => {
  const d = normalizeDiscount({ ...base, audience: { type: "profiles", profileIds: ["p1"] }, perCustomer: { maxAmountCents: 5000 } }, { timezone: "UTC", now: NOW });
  assert.equal(d.access.requiresSignIn, true);
  assert.equal(d.declinable, true);
});

test("state: scheduled, running, ended, paused, used up", () => {
  const d = offer({ schedule: { start: "2026-06-16T00:00", end: "2026-06-20T00:00" }, limits: { totalUses: 2 } });
  assert.equal(discountState(d, NOW), "scheduled");
  assert.equal(discountState(d, Date.parse("2026-06-16T00:00:00Z")), "running", "start is inclusive");
  assert.equal(discountState(d, Date.parse("2026-06-20T00:00:00Z")), "ended", "end is exclusive");
  assert.equal(discountState({ ...d, status: "paused" }, Date.parse("2026-06-17T00:00:00Z")), "paused");
  assert.equal(discountState({ ...d, usedCount: 2 }, Date.parse("2026-06-17T00:00:00Z")), "used-up");
});

test("describeEffect", () => {
  assert.equal(describeEffect({ effect: { type: "percent", bp: 2000 }, scope: "line" }), "−20%");
  assert.equal(describeEffect({ effect: { type: "percent", bp: 1250 }, scope: "order" }), "−12.5% off the order");
  assert.equal(describeEffect({ effect: { type: "amountOff", cents: 500 }, scope: "line" }), "−€5.00 each");
  assert.equal(describeEffect({ effect: { type: "fixedPrice", cents: 1900 }, scope: "line" }), "€19.00 each");
});

test("campaign tags: trimmed, empty means none, length and type checked", () => {
  const n = (campaign: unknown) => normalizeDiscount({ ...base, campaign }, { timezone: "UTC", now: NOW }).campaign;
  assert.equal(n("  Spring  "), "Spring");
  assert.equal(n(""), null);
  assert.equal(n("   "), null);
  assert.equal(n(null), null);
  assert.deepEqual(errorsOf({ ...base, campaign: "x".repeat(61) }), ["campaign"]);
  assert.deepEqual(errorsOf({ ...base, campaign: 42 }), ["campaign"]);
});

test("non-object input and wrong nested types are rejected", () => {
  assert.deepEqual(errorsOf("nope"), [""]);
  assert.deepEqual(errorsOf({ ...base, audience: "everyone" }), ["audience"]);
  assert.deepEqual(errorsOf({ ...base, target: [] }), ["target"]);
  assert.deepEqual(errorsOf({ ...base, combinable: "yes" }), ["combinable"]);
  assert.deepEqual(errorsOf({ ...base, target: { type: "products", productIds: "p1" } }), ["target.productIds"]);
  assert.deepEqual(errorsOf({ ...base, audience: { type: "customers", customerIds: Array.from({ length: 1001 }, (_, i) => `c${i}`) } }), ["audience.customerIds"]);
});

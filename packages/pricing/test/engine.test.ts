import { test } from "node:test";
import assert from "node:assert/strict";
import { price, type Shopper, type VoucherInfo } from "../src/index.ts";
import { NOW, guest, input, line, offer } from "./helpers.ts";

const known = (orders = 0): Partial<Parameters<typeof price>[0]> => ({ shopper: { ...guest, identityId: "id-1" }, ledger: { identityOrders: orders, usage: {} } });
const voucher = (code: string, discountId: string, more: Partial<VoucherInfo> = {}): VoucherInfo => ({ code, discountId, kind: "shared", usedCount: 0, assignedCustomerId: null, ...more });

test("effects per item: percent, amount off (never below 0), fixed price (never raises a price)", () => {
  const pct = offer({ target: { type: "categories", categoryIds: ["mugs"] }, effect: { type: "percent", bp: 2000 } });
  const off = offer({ target: { type: "products", productIds: ["p2"] }, effect: { type: "amountOff", cents: 5000 } });
  const fix = offer({ target: { type: "products", productIds: ["p3", "p4"] }, effect: { type: "fixedPrice", cents: 1900 } });
  const r = price(input([line("p1", 2400, 2, "mugs"), line("p2", 3000), line("p3", 2900), line("p4", 1500), line("p5", 1000)], [pct, off, fix]));
  assert.deepEqual(r.lines.map((l) => l.lineCents), [3840, 0, 1900, 1500, 1000]);
  assert.equal(r.lines[0].appliedFrom?.source, "category");
  assert.equal(r.lines[2].appliedFrom?.source, "product");
  assert.equal(r.lines[3].appliedFrom, null, "a fixed price above the list price changes nothing");
  assert.equal(r.subtotalCents, 4800 + 3000 + 2900 + 1500 + 1000);
  assert.equal(r.totalCents, 3840 + 0 + 1900 + 1500 + 1000);
  assert.equal(r.discountCents, r.subtotalCents - r.totalCents);
});

test("best price per line wins; ties go to priority, then id; every matching offer is listed for transparency", () => {
  const shop = offer({ label: "Shop sale", effect: { type: "percent", bp: 1000 } }, { id: "a-shop" });
  const mug = offer({ label: "Mug deal", target: { type: "products", productIds: ["mug"] }, effect: { type: "fixedPrice", cents: 2000 } }, { id: "b-mug" });
  const r = price(input([line("mug", 2400), line("bowl", 3800)], [mug, shop]));
  assert.equal(r.lines[0].lineCents, 2000);
  assert.equal(r.lines[0].appliedFrom?.label, "Mug deal");
  assert.deepEqual(r.lines[0].offers.map((o) => [o.label, o.unitCents, o.status]), [["Mug deal", 2000, "applied"], ["Shop sale", 2160, "better_offer_applied"]]);
  assert.equal(r.lines[1].lineCents, 3420);
  // ties
  const t1 = offer({ label: "Low priority" }, { id: "t1", priority: 0 });
  const t2 = offer({ label: "High priority" }, { id: "t2", priority: 5 });
  assert.equal(price(input([line("x", 1000)], [t1, t2])).lines[0].appliedFrom?.label, "High priority");
  const t3 = offer({ label: "Z" }, { id: "z9" }), t4 = offer({ label: "A" }, { id: "a1" });
  assert.equal(price(input([line("x", 1000)], [t3, t4])).lines[0].appliedFrom?.label, "A");
});

test("time window uses the shop instant: start inclusive, end exclusive; paused and archived never apply", () => {
  const d = offer({ schedule: { start: "2026-06-15T12:00", end: "2026-06-15T13:00" } });
  const at = (iso: string) => price({ ...input([line("x", 1000)], [d]), now: Date.parse(iso) }).totalCents;
  assert.equal(at("2026-06-15T11:59:59Z"), 1000);
  assert.equal(at("2026-06-15T12:00:00Z"), 900);
  assert.equal(at("2026-06-15T12:59:59Z"), 900);
  assert.equal(at("2026-06-15T13:00:00Z"), 1000);
  assert.equal(price(input([line("x", 1000)], [{ ...d, status: "paused" }])).totalCents, 1000);
  assert.equal(price(input([line("x", 1000)], [offer({}, { status: "archived" })])).totalCents, 1000);
});

test("exclusions and conditions for per-item offers", () => {
  const d = offer({ excludeProductIds: ["gift"], conditions: { minQty: 3 } });
  assert.equal(price(input([line("a", 1000, 2), line("gift", 1000)], [d])).totalCents, 3000, "excluded items don't count towards min quantity");
  const r = price(input([line("a", 1000, 3), line("gift", 1000)], [d]));
  assert.equal(r.totalCents, 2700 + 1000);
  const cond = price(input([line("a", 1000, 1)], [d]));
  assert.equal(cond.lines[0].offers[0].status, "condition");
  assert.deepEqual(cond.lines[0].offers[0].condition, { minQty: 3 });
});

test("per-order offers: min order value is checked after per-item discounts, amounts are allocated exactly", () => {
  const items = offer({ effect: { type: "percent", bp: 5000 }, target: { type: "products", productIds: ["a"] } });
  const order = offer({ scope: "order", effect: { type: "amountOff", cents: 1000 }, conditions: { minSubtotalCents: 5000 } });
  // list 6000 but after 50% on "a" only 4000 -> the order offer doesn't apply
  assert.equal(price(input([line("a", 4000), line("b", 2000)], [items, order])).totalCents, 4000);
  const r = price(input([line("a", 4000), line("b", 3333, 3)], [items, order]));
  assert.equal(r.totalCents, 2000 + 9999 - 1000);
  assert.equal(r.lines.reduce((a, l) => a + l.allocations.filter((x) => x.discountId === order.id).reduce((s, x) => s + x.cents, 0), 0), 1000);
  const pct = offer({ scope: "order", effect: { type: "percent", bp: 1000 }, target: { type: "products", productIds: ["b"] } });
  const r2 = price(input([line("a", 1000), line("b", 999)], [pct]));
  assert.equal(r2.totalCents, 1000 + 899, "percent of the matching lines only");
  const big = offer({ scope: "order", effect: { type: "amountOff", cents: 999999 } });
  assert.equal(price(input([line("a", 1000)], [big])).totalCents, 0, "never below zero");
});

test("only the best automatic per-order offer applies", () => {
  const a = offer({ label: "10% over 50", scope: "order", effect: { type: "percent", bp: 1000 } });
  const b = offer({ label: "€3 off", scope: "order", effect: { type: "amountOff", cents: 300 } });
  const r = price(input([line("x", 5000)], [a, b]));
  assert.deepEqual(r.applied.map((x) => x.label), ["10% over 50"]);
  assert.equal(r.diagnostics.find((d) => d.discountId === b.id)?.reason, "better_offer");
});

test("codes: need the code; combinable codes stack with automatic offers", () => {
  const auto = offer({ label: "Sale", effect: { type: "percent", bp: 1000 } });
  const code = offer({ label: "WELCOME10", trigger: "code", scope: "order", effect: { type: "amountOff", cents: 500 }, combinable: true });
  assert.equal(price(input([line("x", 5000)], [auto, code])).totalCents, 4500, "no code, no code discount");
  const r = price(input([line("x", 5000)], [auto, code], { codes: ["WELCOME10"], vouchers: [voucher("WELCOME10", code.id)] }));
  assert.equal(r.totalCents, 4000);
  assert.deepEqual(r.applied.map((a) => [a.label, a.source, a.code ?? null]), [["Sale", "shop", null], ["WELCOME10", "code", "WELCOME10"]]);
  assert.deepEqual(r.scenarios, []);
});

test("a non-combinable code competes with automatic offers: both totals shown, best preselected, shopper can switch", () => {
  const auto = offer({ label: "Sale", effect: { type: "percent", bp: 2000 } });
  const code = offer({ label: "Code 10%", trigger: "code", scope: "order", effect: { type: "percent", bp: 1000 } });
  const inp = input([line("x", 10000)], [auto, code], { codes: ["TEN"], vouchers: [voucher("TEN", code.id)] });
  const r = price(inp);
  assert.deepEqual(r.scenarios.map((s) => [s.key, s.totalCents, s.best, s.selected]), [["automatic", 8000, true, true], ["code", 9000, false, false]]);
  assert.equal(r.totalCents, 8000);
  assert.deepEqual(r.rejectedCodes, [{ code: "TEN", reason: "other_scenario" }]);
  const pick = price({ ...inp, selection: { scenario: "code" } });
  assert.equal(pick.totalCents, 9000);
  assert.equal(pick.scenarios.find((s) => s.selected)?.key, "code");
  assert.equal(pick.lines[0].offers.find((o) => o.label === "Sale")?.status, "not_in_scenario");
  assert.notEqual(pick.quote, r.quote);
  // no automatic offer applies -> no choice to make
  const only = price(input([line("x", 10000)], [code], { codes: ["TEN"], vouchers: [voucher("TEN", code.id)] }));
  assert.deepEqual(only.scenarios, []);
  assert.equal(only.totalCents, 9000);
});

test("code problems are explained in shopper-safe terms", () => {
  const code = offer({ trigger: "code", scope: "order", effect: { type: "amountOff", cents: 500 }, conditions: { minSubtotalCents: 4000 }, target: { type: "products", productIds: ["x", "y"] } });
  const v = [voucher("MIN40", code.id)];
  assert.deepEqual(price(input([line("x", 2800)], [code], { codes: ["MIN40"], vouchers: v })).rejectedCodes, [{ code: "MIN40", reason: "min_subtotal", missingCents: 1200 }]);
  assert.deepEqual(price(input([line("z", 9000)], [code], { codes: ["MIN40"], vouchers: v })).rejectedCodes, [{ code: "MIN40", reason: "no_matching_items" }]);
  assert.deepEqual(price(input([line("x", 9000)], [code], { codes: ["NOPE"], vouchers: [] })).rejectedCodes, [{ code: "NOPE", reason: "invalid" }]);
  const expired = { ...code, endsAt: "2026-06-01T00:00:00.000Z" };
  assert.deepEqual(price(input([line("x", 9000)], [expired], { codes: ["MIN40"], vouchers: v })).rejectedCodes, [{ code: "MIN40", reason: "invalid" }]);
  // a non-combinable code that misses its minimum reports the minimum, not "other scenario"
  const auto = offer({ effect: { type: "percent", bp: 1000 } });
  assert.deepEqual(price(input([line("x", 2800)], [auto, code], { codes: ["MIN40"], vouchers: v })).rejectedCodes, [{ code: "MIN40", reason: "min_subtotal", missingCents: 1200 - 0 }]);
});

test("single-use and personal codes", () => {
  const code = offer({ trigger: "code", scope: "order", effect: { type: "amountOff", cents: 500 } });
  const used = price(input([line("x", 2000)], [code], { codes: ["ONE"], vouchers: [voucher("ONE", code.id, { kind: "single", usedCount: 1 })] }));
  assert.equal(used.totalCents, 2000);
  assert.equal(used.rejectedCodes[0].reason, "invalid");
  const mine: Shopper = { identityId: "i", customerId: "c1", signedIn: true, profileIds: [] };
  const personal = [voucher("VIP", code.id, { assignedCustomerId: "c1" })];
  assert.equal(price(input([line("x", 2000)], [code], { codes: ["VIP"], vouchers: personal })).totalCents, 2000, "guest can't use a personal code");
  assert.equal(price(input([line("x", 2000)], [code], { codes: ["VIP"], vouchers: personal, shopper: mine })).totalCents, 1500);
  assert.equal(price(input([line("x", 2000)], [code], { codes: ["VIP"], vouchers: personal, shopper: { ...mine, customerId: "c2" } })).totalCents, 2000);
});

test("total uses", () => {
  const d = offer({ limits: { totalUses: 10 } });
  assert.equal(price(input([line("x", 1000)], [{ ...d, usedCount: 9 }])).totalCents, 900);
  assert.equal(price(input([line("x", 1000)], [{ ...d, usedCount: 10 }])).totalCents, 1000);
});

test("sign-in and audiences: guests never get customer or profile offers", () => {
  const vip = offer({ label: "VIP", audience: { type: "customers", customerIds: ["c1"] } });
  const trade = offer({ label: "Trade", audience: { type: "profiles", profileIds: ["p-trade"] }, effect: { type: "percent", bp: 3000 } });
  const members = offer({ label: "Members", access: { requiresSignIn: true }, effect: { type: "percent", bp: 500 } });
  const all = [vip, trade, members];
  assert.equal(price(input([line("x", 1000)], all)).totalCents, 1000);
  const c1: Shopper = { identityId: "i", customerId: "c1", signedIn: true, profileIds: [] };
  assert.equal(price(input([line("x", 1000)], all, { shopper: c1 })).lines[0].appliedFrom?.label, "VIP");
  const t: Shopper = { identityId: "i", customerId: "c2", signedIn: true, profileIds: ["p-trade"] };
  const r = price(input([line("x", 1000)], all, { shopper: t, profileLabels: { "p-trade": "Trade member price" } }));
  assert.deepEqual(r.lines[0].appliedFrom, { discountId: trade.id, label: "Trade", source: "profile", sourceLabel: "Trade member price" });
  assert.equal(r.lines[0].offers.length, 2, "members offer listed as the alternative");
});

test("per customer: max purchases, budget remainder (P-a), first N orders (P-b), pending for unknown guests", () => {
  const maxOrders = offer({ label: "Twice", perCustomer: { maxOrders: 2 } });
  assert.equal(price(input([line("x", 1000)], [maxOrders], { ...known(), ledger: { identityOrders: 5, usage: { [maxOrders.id]: { orders: 1, amountCents: 100 } } } })).totalCents, 900);
  assert.equal(price(input([line("x", 1000)], [maxOrders], { ...known(), ledger: { identityOrders: 5, usage: { [maxOrders.id]: { orders: 2, amountCents: 200 } } } })).totalCents, 1000);

  const budget = offer({ label: "€50 budget", effect: { type: "percent", bp: 5000 }, perCustomer: { maxAmountCents: 5000 } });
  const used = (amountCents: number) => ({ ...known(), ledger: { identityOrders: 3, usage: { [budget.id]: { orders: 2, amountCents } } } });
  const partial = price(input([line("x", 4000), line("y", 2000)], [budget], used(4500)));
  assert.equal(partial.discountCents, 500, "only the remaining €5 of the budget is applied");
  assert.deepEqual(partial.lines.map((l) => l.allocations[0]?.cents ?? 0), [333, 167]);
  assert.deepEqual(partial.applied[0].remaining, { orders: null, amountCents: 0 });
  assert.equal(price(input([line("x", 4000)], [budget], used(5000))).discountCents, 0, "budget exhausted");

  const first = offer({ label: "First order", perCustomer: { firstOrders: 1 } });
  assert.equal(price(input([line("x", 1000)], [first], known(0))).totalCents, 900);
  assert.equal(price(input([line("x", 1000)], [first], known(1))).totalCents, 1000);
  const unknown = price(input([line("x", 1000)], [first]));
  assert.equal(unknown.totalCents, 900, "unknown guest: applied optimistically");
  assert.equal(unknown.pending, true);
  assert.equal(unknown.applied[0].pending, true);
});

test("limited offers can be saved for later, and the alternative total is shown", () => {
  const sale = offer({ label: "Sale", effect: { type: "percent", bp: 1000 } });
  const budget = offer({ label: "Loyalty", effect: { type: "percent", bp: 3000 }, perCustomer: { maxAmountCents: 5000 } });
  const r = price(input([line("x", 10000)], [sale, budget], known()));
  assert.equal(r.totalCents, 7000);
  assert.deepEqual(r.choices.map((c) => [c.label, c.declined, c.totalIfToggled]), [["Loyalty", false, 9000]]);
  const saved = price(input([line("x", 10000)], [sale, budget], { ...known(), selection: { declined: [budget.id] } }));
  assert.equal(saved.totalCents, 9000);
  assert.deepEqual(saved.choices.map((c) => [c.label, c.declined, c.totalIfToggled]), [["Loyalty", true, 7000]]);
  assert.equal(saved.lines[0].offers.find((o) => o.label === "Loyalty")?.status, "declined");
  assert.equal(price(input([line("x", 10000)], [sale], { selection: { declined: [sale.id] } })).totalCents, 9000, "offers without limits can't be declined");
});

test("per-order cap applies to per-item offers too", () => {
  const d = offer({ effect: { type: "percent", bp: 5000 }, limits: { maxDiscountPerOrderCents: 1000 } });
  const r = price(input([line("a", 3000), line("b", 1000)], [d]));
  assert.equal(r.discountCents, 1000);
  assert.deepEqual(r.lines.map((l) => l.allocations[0].cents), [750, 250]);
});

test("diagnostics explain every offer (for the admin simulator)", () => {
  const a = offer({ name: "Scheduled", schedule: { start: "2026-07-01T00:00" } });
  const b = offer({ name: "Bowls only", target: { type: "products", productIds: ["bowl"] } });
  const c = offer({ name: "Members", access: { requiresSignIn: true } });
  const r = price(input([line("mug", 1000)], [a, b, c]));
  assert.deepEqual(Object.fromEntries(r.diagnostics.map((d) => [d.name, d.reason])), { Scheduled: "not_started", "Bowls only": "no_matching_items", Members: "sign_in_required" });
});

test("invalid cart lines are refused", () => {
  assert.throws(() => price(input([line("x", 10.5)], [])));
  assert.throws(() => price(input([line("x", 1000, 0)], [])));
  assert.equal(price(input([], [])).totalCents, 0);
});

test("NOW helper is fixed", () => assert.equal(new Date(NOW).toISOString(), "2026-06-15T12:00:00.000Z"));

test("bundles (offerScope targeted): shop-wide, category and order offers skip them; offers naming them apply", () => {
  const shop = offer({ target: { type: "all" }, effect: { type: "percent", bp: 2000 } }, { id: "shop" });
  const cat = offer({ target: { type: "categories", categoryIds: ["c1"] }, effect: { type: "percent", bp: 3000 } }, { id: "cat" });
  const order = offer({ scope: "order", target: { type: "all" }, effect: { type: "amountOff", cents: 500 } }, { id: "order" });
  const named = offer({ target: { type: "products", productIds: ["set"] }, effect: { type: "percent", bp: 1000 } }, { id: "named" });
  const bundle = { ...line("set", 10000, 1, "c1"), offerScope: "targeted" as const };
  const mug = line("mug", 2000, 1, "c1");
  const r = price(input([bundle, mug], [shop, cat, order]));
  assert.equal(r.lines[0].lineCents, 10000, "nothing applies to the bundle");
  assert.ok(r.lines[1].lineCents < 2000, "the mug still gets its offers");
  assert.equal(r.lines[0].allocations.length, 0, "the order offer isn't spread over the bundle");
  const r2 = price(input([bundle], [shop, cat, named]));
  assert.equal(r2.lines[0].lineCents, 9000, "an offer that names the bundle applies");
  assert.equal(price(input([{ ...bundle, offerScope: "all" }], [shop, cat])).lines[0].lineCents, 7000, "\"all\": the best shop/category offer applies");
});

test("bundles that skip an offer still count towards its minimums (Q-3), but are never discounted by it", () => {
  const big = offer({ scope: "order", target: { type: "all" }, effect: { type: "amountOff", cents: 1000 }, conditions: { minSubtotalCents: 15000, minQty: null } }, { id: "big" });
  const bundle = { ...line("set", 15200, 1, "c1"), offerScope: "targeted" as const };
  const plate = line("plate", 3200, 1, "c2");
  const r = price(input([bundle, plate], [big]));
  assert.equal(r.discountCents, 1000, "€152 bundle + €32 plate is an order over €150");
  assert.deepEqual(r.lines.map((l) => l.lineCents), [15200, 2200], "the discount goes on the plate only");
  const alone = price(input([bundle], [big]));
  assert.equal(alone.discountCents, 0, "nothing in the order can take the discount");
  const small = price(input([line("cup", 1000, 1, "c2"), { ...line("set2", 4000, 1, "c1"), offerScope: "targeted" as const }], [big]));
  assert.equal(small.discountCents, 0, "still under the minimum");
  // Per-item offers with a minimum quantity count the bundle too.
  const three = offer({ target: { type: "all" }, effect: { type: "percent", bp: 1000 }, conditions: { minSubtotalCents: null, minQty: 3 } }, { id: "three" });
  const q = price(input([{ ...bundle, qty: 2 }, plate], [three]));
  assert.deepEqual(q.lines.map((l) => l.lineCents), [30400, 2880], "3 items in the cart: the plate gets 10%, the bundle nothing");
});

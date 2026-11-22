import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteDataStore } from "@openshop/db";
import { instantToLocal } from "@openshop/pricing";
import { buildApp } from "../src/app.ts";
import { ensureAdmin } from "../src/auth.ts";
import { openDb } from "../src/types.ts";

async function make() {
  const store = new SqliteDataStore(":memory:");
  await ensureAdmin(openDb(store), "admin@test.io", "pw-123456");
  const app = buildApp(store, { authSecret: "s", uploadDir: mkdtempSync(join(tmpdir(), "up-")) });
  const h = { authorization: `Bearer ${(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@test.io", password: "pw-123456" } })).json().token}` };
  const api = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url, headers: { ...h, ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { app, api, db: openDb(store) };
}
type Ctx = Awaited<ReturnType<typeof make>>;
const form = (o: Record<string, string>, cookie?: string) => ({ payload: new URLSearchParams(o).toString(), headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) } });

/** A shopper fills a cart, enters the code, maybe picks an option, and maybe orders. */
async function shopper(c: Ctx, productId: string, code: string, pick: "automatic" | "code" | null, order: boolean, email: string) {
  const add = await c.app.inject({ method: "POST", url: "/shop/cart/add", ...form({ productId, qty: "1" }) });
  const cookie = String(add.headers["set-cookie"]).split(";")[0];
  let view = (await c.app.inject({ method: "POST", url: "/api/shop/cart/codes", headers: { cookie }, payload: { code } })).json();
  if (pick) view = (await c.app.inject({ method: "PUT", url: "/api/shop/cart/selection", headers: { cookie }, payload: { scenario: pick } })).json();
  if (!order) return null;
  const co = await c.app.inject({ method: "POST", url: "/shop/checkout", ...form({ name: "S", email, address: "x", quote: view.quote }, cookie) });
  assert.equal(co.statusCode, 303, co.body);
  return String(co.headers.location).split("/").pop()!;
}

test("choices: how many shoppers picked the influencer's code although the automatic offers were cheaper", async () => {
  const c = await make();
  await c.api("PATCH", "/api/settings", { timezone: "Europe/Lisbon" });
  const mug = (await c.api("POST", "/api/products", { name: "Mug", price: 50, stock: 100 })).json();
  await c.api("POST", "/api/discounts", { name: "Sale", label: "Sale", effect: { type: "percent", bp: 2000 } });
  const marta = (await c.api("POST", "/api/discounts", { name: "Marta (creator)", label: "Marta's code", campaign: "Creators", trigger: "code", scope: "order", effect: { type: "percent", bp: 1000 } })).json();
  await c.api("POST", `/api/discounts/${marta.id}/codes`, { code: "MARTA10" });

  // automatic = €40.00 (best), code = €45.00
  const a = await shopper(c, mug.id, "MARTA10", "code", true, "a@x.io");       // supports Marta, pays €5 more
  await shopper(c, mug.id, "marta10", "code", true, "b@x.io");                  // same
  await shopper(c, mug.id, "MARTA10", null, true, "c@x.io");                    // keeps the preselected best price
  await shopper(c, mug.id, "MARTA10", "automatic", false, "d@x.io");            // shown the choice, didn't order
  // an API order (no cart) that picks the code
  const viaApi = await c.app.inject({ method: "POST", url: "/api/shop/orders", payload: { items: [{ productId: mug.id, qty: 1 }], customer: { name: "E", email: "e@x.io", address: "x" }, codes: ["MARTA10"], selection: { scenario: "code" } } });
  assert.equal(viaApi.json().total, 45);
  assert.deepEqual(viaApi.json().choice, { discountId: marta.id, code: "MARTA10", options: { automatic: 40, code: 45 }, best: "automatic", selected: "code", extra: 5 });

  const r = await c.api("GET", "/api/reports/choices");
  assert.equal(r.statusCode, 200);
  const [row] = r.json().items;
  assert.deepEqual({ code: row.code, name: row.name, campaign: row.campaign, shown: row.shown, ordered: row.ordered, notOrdered: row.notOrdered, tookBest: row.tookBest, choseCodePayingMore: row.choseCodePayingMore, lessFavourableRate: row.lessFavourableRate, extraPaid: row.extraPaid, avg: row.avgExtraWhenLessFavourable },
    { code: "MARTA10", name: "Marta (creator)", campaign: "Creators", shown: 5, ordered: 4, notOrdered: 1, tookBest: 1, choseCodePayingMore: 3, lessFavourableRate: 75, extraPaid: 15, avg: 5 });
  const summary = (await c.api("GET", "/api/reports/summary")).json();
  assert.equal(summary.choices.lessFavourable, 3);
  assert.equal(summary.choices.extraPaid, 15);
  // a cancelled order no longer counts as ordered
  await c.api("PATCH", `/api/orders/${a}`, { status: "cancelled" });
  const after = (await c.api("GET", "/api/reports/choices")).json().items[0];
  assert.equal(after.ordered, 3);
  assert.equal(after.choseCodePayingMore, 2);
  // by day (shop time), and CSV from the same URL
  const today = instantToLocal(Date.now(), "Europe/Lisbon").slice(0, 10);
  const byDay = (await c.api("GET", `/api/reports/choices?groupBy=day&from=${today}&to=${today}`)).json().items;
  assert.deepEqual(byDay.map((d: { day: string; shown: number }) => [d.day, d.shown]), [[today, 5]]);
  const csv = await c.api("GET", "/api/reports/choices", undefined, { accept: "text/csv" });
  assert.match(csv.body, /^\uFEFFcode,offer,campaign,shown,ordered,took the best price,"chose the code, paying more",/);
  assert.match(csv.body, /\r\nMARTA10,Marta \(creator\),Creators,5,3,1,2,/);
  assert.equal((await c.api("GET", "/api/reports/choices?groupBy=bogus")).statusCode, 400);
});

test("discount reports: totals, previous period, by day, by offer, by campaign, saved for later", async () => {
  const c = await make();
  const vase = (await c.api("POST", "/api/products", { name: "Vase", price: 100, stock: 100 })).json();
  const sale = (await c.api("POST", "/api/discounts", { name: "Vase sale", label: "Vase sale", campaign: "Spring", effect: { type: "percent", bp: 1000 } })).json();
  const budget = (await c.api("POST", "/api/discounts", { name: "Loyalty", label: "Loyalty", effect: { type: "amountOff", cents: 2000 }, scope: "order", perCustomer: { maxAmountCents: 5000 } })).json();
  const order = (email: string, extra: object = {}) => c.app.inject({ method: "POST", url: "/api/shop/orders", payload: { items: [{ productId: vase.id, qty: 1 }], customer: { name: "X", email, address: "x" }, ...extra } });
  await order("a@x.io");                                                   // 100 - 10 - 20 = 70
  await order("b@x.io", { selection: { declined: [budget.id] } });          // saved for later: 90, paid 20 more
  const s = (await c.api("GET", "/api/reports/summary")).json();
  assert.deepEqual({ orders: s.orders, withDiscount: s.ordersWithDiscount, revenue: s.revenue, gross: s.grossRevenue, cost: s.discountCost, share: s.discountShare, avg: s.avgDiscount },
    { orders: 2, withDiscount: 2, revenue: 160, gross: 200, cost: 40, share: 20, avg: 20 });
  assert.deepEqual(s.previous.orders, 0);
  assert.deepEqual(s.savedForLater, { orders: 1, extraPaid: 20 });
  const days = (await c.api("GET", "/api/reports/discounts?groupBy=day")).json().items;
  assert.equal(days.length, 30, "every day of the default 30-day period, including empty days");
  assert.deepEqual(days.at(-1), { day: days.at(-1).day, orders: 2, ordersWithDiscount: 2, revenue: 160, discountCost: 40 });
  const offers = (await c.api("GET", "/api/reports/discounts?groupBy=discount")).json().items;
  assert.deepEqual(offers.map((o: { name: string; orders: number; discountCost: number; revenue: number }) => [o.name, o.orders, o.discountCost, o.revenue]), [["Loyalty", 1, 20, 70], ["Vase sale", 2, 20, 160]]);
  const camps = (await c.api("GET", "/api/reports/discounts?groupBy=campaign")).json().items;
  assert.deepEqual(camps.map((o: { campaign: string; discountCost: number }) => [o.campaign, o.discountCost]), [["No campaign", 20], ["Spring", 20]]);
  const saved = (await c.api("GET", "/api/reports/saved-for-later")).json().items;
  assert.deepEqual(saved, [{ discountId: budget.id, name: "Loyalty", orders: 1, extraPaid: 20 }]);
  const csv = await c.api("GET", "/api/reports/discounts?groupBy=discount", undefined, { accept: "text/csv" });
  assert.match(String(csv.headers["content-disposition"]), /discounts-by-discount-/);
  assert.match(csv.body, /\r\nLoyalty,1,20\.00,70\.00,70\.00\r\n/);
  for (const q of ["from=2026-13-01", "from=2026-02-01&to=2026-01-01", "from=2020-01-01&to=2026-01-01", "groupBy=week"]) {
    assert.equal((await c.api("GET", `/api/reports/discounts?${q}`)).statusCode, 400, q);
  }
  assert.ok(sale.id);
});

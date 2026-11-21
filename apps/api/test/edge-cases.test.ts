// Paths the feature tests don't reach: rollback when a checkout step fails half-way, invalid stored offers,
// smaller admin/storefront routes, and account edge cases.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteDataStore, type Collection, type DataStore, type Doc } from "@openshop/db";
import { buildApp } from "../src/app.ts";
import { ensureAdmin } from "../src/auth.ts";
import { identityId } from "../src/identity.ts";
import { openDb } from "../src/types.ts";

/** A store whose `collection.method` returns null (a failed guard) on the n-th call: simulates a limit being taken
 *  by another server between the price check and the claim. */
function faulty(store: DataStore, collection: string, method: "updateWhere", failOn: number): DataStore {
  let calls = 0;
  return {
    close: () => store.close(),
    collection<T extends Doc = Doc>(name: string): Collection<T> {
      const col = store.collection<T>(name);
      if (name !== collection) return col;
      return new Proxy(col, {
        get(target, prop, recv) {
          const v = Reflect.get(target, prop, recv);
          if (prop === method) return async (...args: unknown[]) => (++calls === failOn ? null : (v as (...a: unknown[]) => unknown).apply(target, args));
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    },
  };
}

async function make(wrap?: (s: DataStore) => DataStore) {
  const raw = new SqliteDataStore(":memory:");
  const store = wrap ? wrap(raw) : raw;
  await ensureAdmin(openDb(raw), "admin@test.io", "pw-123456");
  const app = buildApp(store, { authSecret: "s", uploadDir: mkdtempSync(join(tmpdir(), "up-")) });
  const h = { authorization: `Bearer ${(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@test.io", password: "pw-123456" } })).json().token}` };
  const api = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) => app.inject({ method, url, headers: h, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { app, api, db: openDb(raw) };
}
const form = (o: Record<string, string>, cookie?: string) => ({ payload: new URLSearchParams(o).toString(), headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) } });

async function setupClaims(c: Awaited<ReturnType<typeof make>>) {
  const p = (await c.api("POST", "/api/products", { name: "Vase", price: 50, stock: 5 })).json();
  const auto = (await c.api("POST", "/api/discounts", { name: "Budget", label: "Budget", effect: { type: "percent", bp: 1000 }, perCustomer: { maxAmountCents: 2000, firstOrders: 1 }, limits: { totalUses: 10 } })).json();
  const code = (await c.api("POST", "/api/discounts", { name: "Code", label: "Code", trigger: "code", scope: "order", combinable: true, effect: { type: "amountOff", cents: 300 } })).json();
  const v = (await c.api("POST", `/api/discounts/${code.id}/codes`, { generate: 1 })).json().items[0];
  return { p, auto, code, v };
}
async function assertNothingClaimed(c: Awaited<ReturnType<typeof make>>, s: Awaited<ReturnType<typeof setupClaims>>, email: string) {
  assert.equal((await c.db.discounts.get(s.auto.id))!.usedCount, 0, "offer use released");
  assert.equal((await c.db.discounts.get(s.code.id))!.usedCount, 0, "code offer use released");
  assert.equal((await c.db.voucherCodes.get(s.v))!.usedCount, 0, "single-use code free again");
  const u = await c.db.discountUsage.get(`${s.auto.id}:${identityId(email)}`);
  assert.deepEqual(u ? [u.orders, u.amountCents] : [0, 0], [0, 0], "per-customer budget untouched (or never created)");
  assert.equal((await c.db.identities.get(identityId(email)))?.orders ?? 0, 0, "order count untouched");
  assert.equal((await c.db.redemptions.find({})).length, 0, "no redemptions");
  assert.equal((await c.db.orders.find({})).length, 0, "no order");
  assert.equal((await c.db.products.get(s.p.id))!.stock, 5, "stock untouched");
}

test("checkout rolls back every claim when a later step fails (stock taken meanwhile)", async () => {
  const c = await make((s) => faulty(s, "products", "updateWhere", 1));
  const s = await setupClaims(c);
  const r = await c.app.inject({ method: "POST", url: "/api/shop/orders", payload: { items: [{ productId: s.p.id, qty: 1 }], customer: { name: "A", email: "a@x.io", address: "x" }, codes: [s.v] } });
  assert.equal(r.statusCode, 409);
  assert.match(r.json().error, /not enough stock/);
  await assertNothingClaimed(c, s, "a@x.io");
  // and the same order goes through once nothing interferes
  const ok = await c.app.inject({ method: "POST", url: "/api/shop/orders", payload: { items: [{ productId: s.p.id, qty: 1 }], customer: { name: "A", email: "a@x.io", address: "x" }, codes: [s.v] } });
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.json().discountTotal, 8);
});

test("checkout rolls back when a single-use code was used by someone else in the meantime", async () => {
  const c = await make((s) => faulty(s, "voucher_codes", "updateWhere", 1));
  const s = await setupClaims(c);
  const r = await c.app.inject({ method: "POST", url: "/api/shop/orders", payload: { items: [{ productId: s.p.id, qty: 1 }], customer: { name: "B", email: "b@x.io", address: "x" }, codes: [s.v] } });
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, "offer_unavailable");
  await assertNothingClaimed(c, s, "b@x.io");
});

test("checkout rolls back when the per-customer budget or first-order slot is taken in the meantime", async () => {
  for (const [collection, email] of [["discount_usage", "c@x.io"], ["identities", "d@x.io"]] as const) {
    const c = await make((s) => faulty(s, collection, "updateWhere", 1));
    const s = await setupClaims(c);
    const r = await c.app.inject({ method: "POST", url: "/api/shop/orders", payload: { items: [{ productId: s.p.id, qty: 1 }], customer: { name: "C", email, address: "x" }, codes: [s.v] } });
    assert.equal(r.statusCode, 409, collection);
    assert.equal(r.json().code, "offer_unavailable");
    await assertNothingClaimed(c, s, email);
  }
});

test("checkout refuses an offer whose total uses were taken in the meantime", async () => {
  const c = await make((s) => faulty(s, "discounts", "updateWhere", 1));
  const s = await setupClaims(c);
  const r = await c.app.inject({ method: "POST", url: "/api/shop/orders", payload: { items: [{ productId: s.p.id, qty: 1 }], customer: { name: "E", email: "e@x.io", address: "x" } } });
  assert.equal(r.statusCode, 409);
  await assertNothingClaimed(c, s, "e@x.io");
});

test("a changed order status at the same moment is refused", async () => {
  const c = await make((s) => faulty(s, "orders", "updateWhere", 1));
  const p = (await c.api("POST", "/api/products", { name: "Cup", price: 5, stock: 5 })).json();
  const o = (await c.app.inject({ method: "POST", url: "/api/shop/orders", payload: { items: [{ productId: p.id, qty: 1 }], customer: { name: "F", email: "f@x.io", address: "x" } } })).json();
  const r = await c.api("PATCH", `/api/orders/${o.id}`, { status: "paid" });
  assert.equal(r.statusCode, 409);
  assert.equal((await c.api("PATCH", "/api/orders/nope", { status: "paid" })).statusCode, 404);
});

test("an invalid offer stored in the database is skipped (never priced), with a warning", async () => {
  const c = await make();
  const p = (await c.api("POST", "/api/products", { name: "Plate", price: 20, stock: 5 })).json();
  const good = (await c.api("POST", "/api/discounts", { name: "Good", label: "Good", effect: { type: "percent", bp: 1000 } })).json();
  // e.g. edited by hand, or written by an older version: 0% is not a valid offer
  await c.db.discounts.insert({ ...(await c.db.discounts.get(good.id))!, id: "corrupt", name: "Corrupt", effect: { type: "percent", bp: 0 } });
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (m: string) => { warnings.push(m); };
  try {
    const r = (await c.app.inject({ method: "GET", url: `/api/shop/prices?ids=${p.id}` })).json().items[0];
    assert.equal(r.priceCents, 1800);
  } finally { console.warn = warn; }
  assert.ok(warnings.some((w) => /Skipping invalid offer corrupt/.test(w)));
});

test("admin edge cases: customer edit, trigger change with codes, category delete", async () => {
  const c = await make();
  const cust = (await c.api("POST", "/api/customers", { email: "g@x.io", name: "G" })).json();
  const edited = await c.api("PATCH", `/api/customers/${cust.id}`, { name: "Gee", address: "2 Road" });
  assert.equal(edited.json().name, "Gee");
  assert.equal(edited.json().address, "2 Road");
  assert.equal((await c.api("PATCH", `/api/customers/${cust.id}`, { email: "other@x.io" })).statusCode, 400, "email can't be changed");
  assert.equal((await c.api("PATCH", "/api/customers/nope", { name: "X" })).statusCode, 404);
  assert.equal((await c.api("GET", "/api/customers/nope")).statusCode, 404);
  assert.equal((await c.api("POST", "/api/customers/nope/links", { purpose: "activate" })).statusCode, 404);
  assert.equal((await c.api("POST", "/api/customers/nope/sign-out")).statusCode, 404);
  assert.equal((await c.api("DELETE", "/api/customers/nope")).statusCode, 404);
  assert.equal((await c.api("GET", "/api/discount-profiles/nope")).statusCode, 404);
  assert.equal((await c.api("GET", "/api/discount-profiles/nope/members")).statusCode, 404);
  assert.equal((await c.api("PATCH", "/api/discount-profiles/nope", { version: 1 })).statusCode, 404);
  assert.equal((await c.api("DELETE", "/api/discount-profiles/nope")).statusCode, 404);
  const prof = (await c.api("POST", "/api/discount-profiles", { name: "P", publicLabel: "P" })).json();
  assert.equal((await c.api("POST", `/api/discount-profiles/${prof.id}/members`, { add: [{ customerId: "ghost" }] })).statusCode, 400);
  assert.equal((await c.api("POST", `/api/discount-profiles/${prof.id}/members`, { add: [{ customerId: cust.id, lastDay: "31/12/2026" }] })).statusCode, 400);
  assert.equal((await c.api("POST", "/api/discount-profiles/nope/members", { add: [] })).statusCode, 404);

  const code = (await c.api("POST", "/api/discounts", { name: "V", label: "V", trigger: "code", effect: { type: "percent", bp: 500 } })).json();
  await c.api("POST", `/api/discounts/${code.id}/codes`, { code: "KEEPME" });
  const r = await c.api("PATCH", `/api/discounts/${code.id}`, { version: 1, trigger: "automatic" });
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().fields[0].field, "trigger");
  assert.equal((await c.api("PATCH", "/api/discounts/nope", { version: 1 })).statusCode, 404);
  assert.equal((await c.api("POST", "/api/discounts/nope/pause")).statusCode, 404);
  assert.equal((await c.api("POST", "/api/discounts/nope/duplicate")).statusCode, 404);
  assert.equal((await c.api("GET", "/api/discounts/nope/codes")).statusCode, 404);
  assert.equal((await c.api("POST", "/api/discounts/nope/codes", { code: "ABCD" })).statusCode, 404);
  assert.equal((await c.api("GET", "/api/discounts/nope/redemptions")).statusCode, 404);
  assert.equal((await c.api("POST", `/api/discounts/${code.id}/codes`, { generate: 2, prefix: "bad prefix!" })).statusCode, 400);
  assert.equal((await c.api("PATCH", `/api/discounts/${code.id}`, { version: 1, effect: { type: "percent", bp: 0 } })).statusCode, 400);
  assert.equal((await c.api("PATCH", `/api/discounts/${code.id}`, { version: 1, target: { type: "products", productIds: ["ghost"] } })).statusCode, 400);
  assert.equal((await c.api("GET", "/api/audit?entity=discount")).json().items.length > 0, true);

  // deleting a category takes it off its products
  const cat = (await c.api("POST", "/api/categories", { name: "Bowls", slug: "bowls" })).json();
  const p = (await c.api("POST", "/api/products", { name: "Bowl", price: 10, stock: 1, categoryId: cat.id })).json();
  assert.equal((await c.api("DELETE", `/api/categories/${cat.id}`)).statusCode, 204);
  assert.equal((await c.api("GET", `/api/products/${p.id}`)).json().categoryId, null);
  assert.equal((await c.api("DELETE", `/api/categories/${cat.id}`)).statusCode, 404);
  assert.equal((await c.api("POST", "/api/categories", { name: "Bowls", slug: "bowls" })).statusCode, 201);
  assert.equal((await c.api("POST", "/api/categories", { name: "Again", slug: "bowls" })).statusCode, 409);
});

test("storefront edge cases: remove from cart, sign out, account offers list long product lists", async () => {
  const c = await make();
  const names = ["A1", "A2", "A3", "A4", "A5"];
  const ps = [];
  for (const n of names) ps.push((await c.api("POST", "/api/products", { name: n, price: 10, stock: 9 })).json());
  const cat = (await c.api("POST", "/api/categories", { name: "Cups", slug: "cups" })).json();
  // cart: add two, remove one
  let r = await c.app.inject({ method: "POST", url: "/shop/cart/add", ...form({ productId: ps[0].id, qty: "1" }) });
  const cookie = String(r.headers["set-cookie"]).split(";")[0];
  await c.app.inject({ method: "POST", url: "/shop/cart/add", ...form({ productId: ps[1].id, qty: "2" }, cookie) });
  r = await c.app.inject({ method: "POST", url: "/shop/cart/remove", ...form({ productId: ps[0].id }, cookie) });
  assert.equal(r.statusCode, 303);
  const cart = await c.app.inject({ method: "GET", url: "/shop/cart", headers: { cookie } });
  assert.doesNotMatch(cart.body, /A1/);
  assert.match(cart.body, /A2/);
  assert.equal((await c.app.inject({ method: "POST", url: "/shop/cart/remove", ...form({ productId: "x" }) })).statusCode, 303, "no cart: nothing to do");

  // a signed-in member sees long product lists shortened, and category names
  const cust = (await c.api("POST", "/api/customers", { email: "h@x.io", name: "H" })).json();
  const link = (await c.api("POST", `/api/customers/${cust.id}/links`, { purpose: "activate" })).json();
  const set = await c.app.inject({ method: "POST", url: link.path, ...form({ password: "long enough 1", confirm: "long enough 1" }) });
  const session = String(([] as string[]).concat(set.headers["set-cookie"] as string)[0]).split(";")[0];
  await c.api("POST", "/api/discounts", { name: "Many", label: "Many", access: { requiresSignIn: true }, target: { type: "products", productIds: ps.map((p) => p.id) }, effect: { type: "percent", bp: 500 } });
  await c.api("POST", "/api/discounts", { name: "Cat", label: "Cat", audience: { type: "customers", customerIds: [cust.id] }, target: { type: "categories", categoryIds: [cat.id] }, effect: { type: "percent", bp: 500 } });
  const offers = (await c.app.inject({ method: "GET", url: "/api/shop/account/offers", headers: { cookie: session } })).json().offers;
  assert.deepEqual(offers.map((o: { appliesTo: string }) => o.appliesTo).sort(), ["A1, A2, A3 and 2 more", "Cups"]);
  // sign out clears the cookie
  const out = await c.app.inject({ method: "POST", url: "/shop/account/logout", headers: { cookie: session } });
  assert.equal(out.statusCode, 303);
  assert.match(String(out.headers["set-cookie"]), /^cs=; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=0/);
  assert.equal((await c.app.inject({ method: "GET", url: "/shop/account/reset/whatever-token-1234567890abc" })).statusCode, 410);
  assert.equal((await c.app.inject({ method: "POST", url: "/shop/account/bogus/whatever-token-1234567890abc", ...form({ password: "x" }) })).statusCode, 404);
  assert.equal((await c.app.inject({ method: "POST", url: "/shop/account/activate/whatever-token-1234567890abc", ...form({ password: "x" }) })).statusCode, 410);
});

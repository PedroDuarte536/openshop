import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteDataStore } from "@openshop/db";
import { buildApp } from "../src/app.ts";
import { ensureAdmin, signToken } from "../src/auth.ts";
import { openDb } from "../src/types.ts";

const SECRET = "test-secret";
async function make() {
  const store = new SqliteDataStore(":memory:");
  await ensureAdmin(openDb(store), "admin@test.io", "pw-123456");
  const app = buildApp(store, { authSecret: SECRET, uploadDir: mkdtempSync(join(tmpdir(), "up-")), shopUrl: "https://shop.example" });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@test.io", password: "pw-123456" } });
  const h = { authorization: `Bearer ${login.json().token}` };
  const db = openDb(store);
  const api = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url, headers: { ...h, ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const product = async (name: string, price: number, extra: object = {}) => (await api("POST", "/api/products", { name, price, stock: 100, ...extra })).json();
  const offer = async (body: object) => {
    const r = await api("POST", "/api/discounts", { name: "Offer", label: "Offer", effect: { type: "percent", bp: 1000 }, ...body });
    assert.equal(r.statusCode, 201, r.body);
    return r.json();
  };
  return { app, db, api, product, offer };
}
type Ctx = Awaited<ReturnType<typeof make>>;
const form = (o: Record<string, string>, cookie?: string) => ({ payload: new URLSearchParams(o).toString(), headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) } });
const cookieOf = (r: { headers: Record<string, unknown> }, name: string) => {
  const all = ([] as string[]).concat(r.headers["set-cookie"] as string | string[] ?? []);
  const c = all.find((x) => x.startsWith(`${name}=`));
  return c ? c.split(";")[0] : "";
};
/** Creates a customer and activates the account through the one-time link, as the customer would. */
async function customerWithAccount(c: Ctx, email: string, name = "Ann", password = "correct horse battery") {
  const cust = (await c.api("POST", "/api/customers", { email, name, address: "1 Road" })).json();
  const link = (await c.api("POST", `/api/customers/${cust.id}/links`, { purpose: "activate" })).json();
  const set = await c.app.inject({ method: "POST", url: link.path, ...form({ password, confirm: password }) });
  assert.equal(set.statusCode, 303, set.body);
  return { customer: cust, session: cookieOf(set, "cs"), link };
}
async function addToCart(c: Ctx, items: [string, number][], cookie = "") {
  let cart = "";
  for (const [productId, qty] of items) {
    const r = await c.app.inject({ method: "POST", url: "/shop/cart/add", ...form({ productId, qty: String(qty) }, [cookie, cart].filter(Boolean).join("; ") || undefined) });
    cart = cookieOf(r, "cart") || cart;
  }
  return [cookie, cart].filter(Boolean).join("; ");
}

test("accounts are created by the owner; one-time links set the password and sign the customer in", async () => {
  const c = await make();
  const cust = await c.api("POST", "/api/customers", { email: "Ann@X.io", name: "Ann" });
  assert.equal(cust.statusCode, 201);
  assert.equal(cust.json().email, "ann@x.io");
  assert.equal(cust.json().activated, false);
  assert.equal(cust.json().passwordHash, undefined, "hashes are never returned");
  assert.equal((await c.api("POST", "/api/customers", { email: "ann@x.io", name: "Dup" })).statusCode, 409);
  assert.equal((await c.api("POST", "/api/customers", { email: "nope", name: "X" })).statusCode, 400);

  const link = (await c.api("POST", `/api/customers/${cust.json().id}/links`, { purpose: "activate" })).json();
  assert.match(link.path, /^\/shop\/account\/activate\/[A-Za-z0-9_-]{43}$/);
  assert.equal(link.url, `https://shop.example${link.path}`);
  assert.ok(Date.parse(link.expiresAt) - Date.now() > 71 * 3600 * 1000);
  const token = link.path.split("/").pop()!;
  assert.equal((await c.db.accountLinks.find({}))[0].tokenHash.length, 64, "only a hash is stored");
  assert.ok(!JSON.stringify(await c.db.accountLinks.find({})).includes(token));

  const pageRes = await c.app.inject({ method: "GET", url: link.path });
  assert.equal(pageRes.statusCode, 200);
  assert.match(pageRes.body, /Set your password/);
  assert.equal(pageRes.headers["referrer-policy"], "no-referrer");
  assert.equal(pageRes.headers["cache-control"], "private, no-store");
  assert.equal((await c.app.inject({ method: "POST", url: link.path, ...form({ password: "short", confirm: "short" }) })).statusCode, 400);
  assert.equal((await c.app.inject({ method: "POST", url: link.path, ...form({ password: "long enough 1", confirm: "different 12" }) })).statusCode, 400);
  assert.equal((await c.app.inject({ method: "GET", url: link.path.replace("activate", "reset") })).statusCode, 410, "a link only works for its purpose");
  const set = await c.app.inject({ method: "POST", url: link.path, ...form({ password: "long enough 1", confirm: "long enough 1" }) });
  assert.equal(set.statusCode, 303);
  const session = String(([] as string[]).concat(set.headers["set-cookie"] as string)[0]);
  assert.match(session, /^cs=[^;]+; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=2592000$/);
  assert.equal((await c.app.inject({ method: "GET", url: link.path })).statusCode, 410, "single use");
  assert.equal((await c.app.inject({ method: "POST", url: link.path, ...form({ password: "another one 12", confirm: "another one 12" }) })).statusCode, 410);
  const account = await c.app.inject({ method: "GET", url: "/shop/account", headers: { cookie: session.split(";")[0] } });
  assert.match(account.body, /Hello, Ann/);
  assert.equal((await c.api("GET", `/api/customers/${cust.json().id}`)).json().activated, true);
});

test("expired links, a new link revokes the old one, and tokens are opaque", async () => {
  const c = await make();
  const cust = (await c.api("POST", "/api/customers", { email: "bo@x.io", name: "Bo" })).json();
  const first = (await c.api("POST", `/api/customers/${cust.id}/links`, { purpose: "activate" })).json();
  const second = (await c.api("POST", `/api/customers/${cust.id}/links`, { purpose: "activate" })).json();
  assert.equal((await c.app.inject({ method: "GET", url: first.path })).statusCode, 410);
  assert.equal((await c.app.inject({ method: "GET", url: second.path })).statusCode, 200);
  const [l] = await c.db.accountLinks.find({ usedAt: null });
  await c.db.accountLinks.update(l.id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await c.app.inject({ method: "GET", url: second.path })).statusCode, 410);
  assert.equal((await c.app.inject({ method: "GET", url: "/shop/account/activate/short" })).statusCode, 410);
  assert.equal((await c.app.inject({ method: "GET", url: "/shop/account/other/whatever-token-value-here" })).statusCode, 404);
});

test("sign in, throttling, sign out everywhere, and reset links", async () => {
  const c = await make();
  const { customer, session } = await customerWithAccount(c, "cy@x.io", "Cy", "first password!");
  const login = (email: string, password: string, next?: string) => c.app.inject({ method: "POST", url: "/shop/account/login", ...form({ email, password, ...(next ? { next } : {}) }) });
  const ok = await login("CY@x.io", "first password!", "/shop/cart");
  assert.equal(ok.statusCode, 303);
  assert.equal(ok.headers.location, "/shop/cart");
  assert.equal((await login("cy@x.io", "first password!", "https://evil.example/")).headers.location, "/shop/account", "next can only be a shop path");
  const wrong = await login("cy@x.io", "nope");
  const unknown = await login("nobody@x.io", "nope");
  assert.equal(wrong.statusCode, 401);
  assert.equal(unknown.statusCode, 401);
  assert.equal((wrong.body.match(/<p class="os-msg os-msg--bad"[^<]*<\/p>/) ?? [])[0], (unknown.body.match(/<p class="os-msg os-msg--bad"[^<]*<\/p>/) ?? [])[0], "same answer for wrong password and unknown email");
  // an invited customer who never set a password can't sign in
  await c.api("POST", "/api/customers", { email: "pending@x.io", name: "P" });
  assert.equal((await login("pending@x.io", "")).statusCode, 401);
  let last = 0;
  for (let i = 0; i < 11; i++) last = (await login("cy@x.io", `bad-${i}`)).statusCode;
  assert.equal(last, 429);

  // sign out everywhere ends every session
  const s2 = cookieOf(ok, "cs");
  assert.match((await c.app.inject({ method: "GET", url: "/shop/account", headers: { cookie: session } })).body, /Hello, Cy/);
  await c.app.inject({ method: "POST", url: "/shop/account/logout-everywhere", headers: { cookie: s2 } });
  assert.match((await c.app.inject({ method: "GET", url: "/shop/account", headers: { cookie: session } })).body, /Sign in/);
  // owner-side "sign out" and reset link
  const reset = (await c.api("POST", `/api/customers/${customer.id}/links`, { purpose: "reset" })).json();
  assert.match(reset.path, /^\/shop\/account\/reset\//);
  const r = await c.app.inject({ method: "POST", url: reset.path, ...form({ password: "second password", confirm: "second password" }) });
  assert.equal(r.statusCode, 303);
  const fresh = cookieOf(r, "cs");
  assert.match((await c.app.inject({ method: "GET", url: "/shop/account", headers: { cookie: fresh } })).body, /Hello, Cy/);
  await c.api("POST", `/api/customers/${customer.id}/sign-out`);
  assert.match((await c.app.inject({ method: "GET", url: "/shop/account", headers: { cookie: fresh } })).body, /Sign in/);
  // a forged or admin token is not a customer session
  const admin = (await c.db.users.find({}))[0];
  assert.match((await c.app.inject({ method: "GET", url: "/shop/account", headers: { cookie: `cs=${signToken(admin.id, SECRET)}` } })).body, /Sign in/);
  assert.match((await c.app.inject({ method: "GET", url: "/shop/account", headers: { cookie: `cs=${signToken(customer.id, "other-secret", 3600, "customer", { sv: 3 })}` } })).body, /Sign in/);
});

test("client prices: only the signed-in customer gets them, never a guest typing their email", async () => {
  const c = await make();
  const bowl = await c.product("Bowl", 40);
  const { customer, session } = await customerWithAccount(c, "vip@x.io", "Vip");
  const vip = await c.offer({ label: "Your VIP price", audience: { type: "customers", customerIds: [customer.id] }, effect: { type: "percent", bp: 2500 } });
  assert.equal(vip.access.requiresSignIn, true);
  const prices = async (cookie?: string) => (await c.app.inject({ method: "GET", url: `/api/shop/prices?ids=${bowl.id}`, headers: cookie ? { cookie } : {} })).json().items[0];
  assert.equal((await prices()).priceCents, 4000);
  const mine = await prices(session);
  assert.equal(mine.priceCents, 3000);
  assert.deepEqual(mine.appliedFrom, { discountId: vip.id, label: "Your VIP price", source: "customer" });
  // guest checkout with the VIP's email: list price
  const guest = await c.app.inject({ method: "POST", url: "/api/shop/orders", payload: { items: [{ productId: bowl.id, qty: 1 }], customer: { name: "Impostor", email: "vip@x.io", address: "x" } } });
  assert.equal(guest.json().total, 40);
  // signed-in checkout: the account's email and customer id, whatever the form says
  const cart = await addToCart(c, [[bowl.id, 1]], session);
  const quote = (await c.app.inject({ method: "GET", url: "/api/shop/cart", headers: { cookie: cart } })).json();
  assert.equal(quote.totalCents, 3000);
  assert.deepEqual(quote.account, { name: "Vip", email: "vip@x.io" });
  assert.equal(quote.pending, false, "signed in: per-customer checks are known up front");
  const cartPage = await c.app.inject({ method: "GET", url: "/shop/cart", headers: { cookie: cart } });
  assert.match(cartPage.body, /Signed in as <b>Vip<\/b>/);
  assert.match(cartPage.body, /value="vip@x.io" readonly/);
  assert.equal(cartPage.headers["cache-control"], "private, no-store");
  const co = await c.app.inject({ method: "POST", url: "/shop/checkout", ...form({ name: "Vip", email: "someone-else@x.io", address: "2 Road", quote: quote.quote }, cart) });
  assert.equal(co.statusCode, 303, co.body);
  const [o] = (await c.api("GET", "/api/orders")).json().filter((x: { total: number }) => x.total === 30);
  assert.equal(o.customer.email, "vip@x.io");
  assert.equal(o.customerId, customer.id);
  assert.equal((await c.db.redemptions.find({ orderId: o.id }))[0].customerId, customer.id);
});

test("profiles: live rules for members, membership end dates, paused profiles, affected member count", async () => {
  const c = await make();
  const mug = await c.product("Mug", 24);
  await c.api("PATCH", "/api/settings", { timezone: "Europe/Lisbon" });
  const a = await customerWithAccount(c, "trade1@x.io", "T1");
  const b = await customerWithAccount(c, "trade2@x.io", "T2");
  const outsider = await customerWithAccount(c, "other@x.io", "O");
  const p = (await c.api("POST", "/api/discount-profiles", { name: "Trade buyers", publicLabel: "Trade price" })).json();
  assert.equal(p.memberCount, 0);
  const add = await c.api("POST", `/api/discount-profiles/${p.id}/members`, { add: [{ customerId: a.customer.id }, { customerId: b.customer.id, lastDay: "2020-01-31" }] });
  assert.equal(add.json().added, 2);
  assert.equal(add.json().activeMembers, 1, "an ended membership doesn't count");
  const member = (await c.db.profileMembers.get(`${p.id}:${b.customer.id}`))!;
  assert.equal(member.validUntil, "2020-02-01T00:00:00.000Z", "ends at midnight after the last day, shop time");
  const rule = await c.offer({ label: "Trade discount", audience: { type: "profiles", profileIds: [p.id] }, effect: { type: "percent", bp: 3000 } });
  const price = async (cookie: string) => (await c.app.inject({ method: "GET", url: `/api/shop/prices?ids=${mug.id}`, headers: { cookie } })).json().items[0];
  const forA = await price(a.session);
  assert.equal(forA.priceCents, 1680);
  assert.deepEqual(forA.appliedFrom, { discountId: rule.id, label: "Trade discount", source: "profile", sourceLabel: "Trade price" });
  assert.equal((await price(b.session)).priceCents, 2400, "membership ended");
  assert.equal((await price(outsider.session)).priceCents, 2400);
  // live: editing the profile applies to every member; pausing it removes the benefit
  const paused = await c.api("PATCH", `/api/discount-profiles/${p.id}`, { version: 1, status: "paused" });
  assert.equal(paused.json().affectedMembers, 1);
  assert.equal((await price(a.session)).priceCents, 2400);
  assert.equal((await c.api("PATCH", `/api/discount-profiles/${p.id}`, { version: 1, status: "active" })).statusCode, 409, "stale version");
  await c.api("PATCH", `/api/discount-profiles/${p.id}`, { version: 2, status: "active", publicLabel: "Trade partner price" });
  assert.equal((await price(a.session)).appliedFrom.sourceLabel, "Trade partner price");
  // members list: JSON or CSV
  const csv = await c.api("GET", `/api/discount-profiles/${p.id}/members`, undefined, { accept: "text/csv" });
  assert.match(csv.body, /^\uFEFFemail,name,account,valid until,added\r\ntrade1@x.io,T1,active,,/);
  assert.equal((await c.api("GET", `/api/discount-profiles/${p.id}`)).json().rules[0].id, rule.id);
  // can't delete with members or live rules
  assert.equal((await c.api("DELETE", `/api/discount-profiles/${p.id}`)).statusCode, 409);
  await c.api("POST", `/api/discount-profiles/${p.id}/members`, { remove: [a.customer.id, b.customer.id] });
  assert.equal((await c.api("DELETE", `/api/discount-profiles/${p.id}`)).statusCode, 409);
  await c.api("POST", `/api/discounts/${rule.id}/archive`);
  assert.equal((await c.api("DELETE", `/api/discount-profiles/${p.id}`)).statusCode, 204);
  assert.equal((await c.api("POST", "/api/discount-profiles", { name: "X", publicLabel: "Y", extra: 1 })).statusCode, 400);
});

test("personal codes: only their owner can use them; they show in the cart and under Your offers", async () => {
  const c = await make();
  const vase = await c.product("Vase", 50);
  const { customer, session } = await customerWithAccount(c, "sofia@x.io", "Sofia");
  const other = await customerWithAccount(c, "max@x.io", "Max");
  const d = await c.offer({ label: "Welcome back", trigger: "code", scope: "order", effect: { type: "amountOff", cents: 800 } });
  const gen = (await c.api("POST", `/api/discounts/${d.id}/codes`, { generate: 1, prefix: "SOFIA", assignedCustomerId: customer.id })).json();
  const code = gen.items[0];
  assert.equal((await c.api("POST", `/api/discounts/${d.id}/codes`, { generate: 1, assignedCustomerId: "ghost" })).statusCode, 400);
  const members = await c.offer({ label: "Members 5%", access: { requiresSignIn: true }, effect: { type: "percent", bp: 500 }, perCustomer: { maxAmountCents: 1000 } });

  const guestCart = await addToCart(c, [[vase.id, 1]]);
  assert.equal((await c.app.inject({ method: "POST", url: "/api/shop/cart/codes", headers: { cookie: guestCart }, payload: { code } })).statusCode, 400, "guests can't use it");
  const otherCart = await addToCart(c, [[vase.id, 1]], other.session);
  assert.equal((await c.app.inject({ method: "POST", url: "/api/shop/cart/codes", headers: { cookie: otherCart }, payload: { code } })).statusCode, 400, "nor other customers");
  const myCart = await addToCart(c, [[vase.id, 1]], session);
  const view = (await c.app.inject({ method: "GET", url: "/api/shop/cart", headers: { cookie: myCart } })).json();
  assert.deepEqual(view.personalCodes, [{ code, label: "Welcome back", description: "−€8.00 off the order" }]);
  const applied = (await c.app.inject({ method: "POST", url: "/api/shop/cart/codes", headers: { cookie: myCart }, payload: { code } })).json();
  // not combinable: the code (€42.00) competes with the members offer (€47.50), and the better one is preselected
  assert.equal(applied.totalCents, 5000 - 800);
  assert.deepEqual(applied.scenarios.map((s: { key: string; totalCents: number; best: boolean }) => [s.key, s.totalCents, s.best]), [["automatic", 4750, false], ["code", 4200, true]]);
  assert.deepEqual(applied.personalCodes, [], "an applied code isn't offered again");

  const offers = await c.app.inject({ method: "GET", url: "/api/shop/account/offers", headers: { cookie: session } });
  assert.equal(offers.headers["cache-control"], "private, no-store");
  const o = offers.json();
  assert.deepEqual(o.customer, { name: "Sofia", email: "sofia@x.io" });
  assert.deepEqual(o.offers.map((x: { label: string; source: string; remaining: { amountCents: number } }) => [x.label, x.source, x.remaining.amountCents]), [["Members 5%", "members", 1000]]);
  assert.deepEqual(o.codes.map((x: { code: string; label: string }) => [x.code, x.label]), [[code, "Welcome back"]]);
  assert.equal((await c.app.inject({ method: "GET", url: "/api/shop/account/offers" })).statusCode, 401);
  assert.ok(members.id);
});

test("deleting a customer removes their personal data and their place in offers", async () => {
  const c = await make();
  const { customer, session } = await customerWithAccount(c, "gone@x.io", "Gone");
  const keep = await customerWithAccount(c, "stay@x.io", "Stay");
  const p = (await c.api("POST", "/api/discount-profiles", { name: "VIP", publicLabel: "VIP" })).json();
  await c.api("POST", `/api/discount-profiles/${p.id}/members`, { add: [{ customerId: customer.id }] });
  const solo = await c.offer({ name: "Only Gone", audience: { type: "customers", customerIds: [customer.id] } });
  const shared = await c.offer({ name: "Both", audience: { type: "customers", customerIds: [customer.id, keep.customer.id] } });
  const codeOffer = await c.offer({ trigger: "code" });
  await c.api("POST", `/api/discounts/${codeOffer.id}/codes`, { code: "GONE-CODE", assignedCustomerId: customer.id });
  assert.equal((await c.api("DELETE", `/api/customers/${customer.id}`)).statusCode, 204);
  assert.equal(await c.db.customers.get(customer.id), null);
  assert.equal((await c.db.profileMembers.find({ customerId: customer.id })).length, 0);
  assert.equal((await c.db.accountLinks.find({ customerId: customer.id })).length, 0);
  assert.equal(await c.db.voucherCodes.get("GONE-CODE"), null);
  assert.equal((await c.api("GET", `/api/discounts/${solo.id}`)).json().state, "archived");
  assert.deepEqual((await c.api("GET", `/api/discounts/${shared.id}`)).json().audience.customerIds, [keep.customer.id]);
  assert.match((await c.app.inject({ method: "GET", url: "/shop/account", headers: { cookie: session } })).body, /Sign in/, "the session is gone too");
});

test("customer detail shows account state, profiles, codes, usage and orders", async () => {
  const c = await make();
  const item = await c.product("Cup", 10);
  const { customer, session } = await customerWithAccount(c, "dee@x.io", "Dee");
  await c.offer({ label: "Budget", effect: { type: "percent", bp: 1000 }, perCustomer: { maxAmountCents: 500 } });
  const cart = await addToCart(c, [[item.id, 2]], session);
  await c.app.inject({ method: "POST", url: "/shop/checkout", ...form({ name: "Dee", address: "1 Road" }, cart) });
  const d = (await c.api("GET", `/api/customers/${customer.id}`)).json();
  assert.equal(d.activated, true);
  assert.equal(d.orders.length, 1);
  assert.equal(d.orders[0].discountTotal, 2);
  assert.deepEqual(d.usage.map((u: { offer: string; orders: number; amount: number }) => [u.offer, u.orders, u.amount]), [["Offer", 1, 2]]);
  assert.equal(d.identityOrders, 1);
  assert.equal(d.pendingLink, null);
  const list = (await c.api("GET", "/api/customers")).json();
  assert.equal(list[0].activated, true);
  assert.equal(list[0].passwordHash, undefined);
  for (const [m, u] of [["GET", "/api/customers"], ["POST", "/api/customers"], ["GET", `/api/customers/${customer.id}`], ["DELETE", `/api/customers/${customer.id}`], ["POST", `/api/customers/${customer.id}/links`], ["POST", `/api/customers/${customer.id}/sign-out`],
    ["GET", "/api/discount-profiles"], ["POST", "/api/discount-profiles"], ["PATCH", "/api/discount-profiles/x"], ["POST", "/api/discount-profiles/x/members"], ["GET", "/api/reports/summary"], ["GET", "/api/reports/choices"]] as const) {
    assert.equal((await c.app.inject({ method: m, url: u, headers: { cookie: session } })).statusCode, 401, `${m} ${u} needs an admin token, not a customer session`);
  }
});

test("the simulator can price a cart for a signed-in customer", async () => {
  const c = await make();
  const mug = await c.product("Mug", 20);
  const { customer } = await customerWithAccount(c, "sim@x.io", "Sim");
  const p = (await c.api("POST", "/api/discount-profiles", { name: "Friends", publicLabel: "Friends price" })).json();
  await c.api("POST", `/api/discount-profiles/${p.id}/members`, { add: [{ customerId: customer.id }] });
  await c.offer({ label: "Friends", audience: { type: "profiles", profileIds: [p.id] }, effect: { type: "percent", bp: 5000 } });
  const guest = (await c.api("POST", "/api/discounts/simulate", { items: [{ productId: mug.id, qty: 1 }] })).json();
  assert.equal(guest.result.totalCents, 2000);
  const member = (await c.api("POST", "/api/discounts/simulate", { items: [{ productId: mug.id, qty: 1 }], customerId: customer.id })).json();
  assert.equal(member.result.totalCents, 1000);
  assert.equal(member.result.lines[0].appliedFrom.sourceLabel, "Friends price");
  assert.equal((await c.api("POST", "/api/discounts/simulate", { items: [{ productId: mug.id, qty: 1 }], customerId: "nope" })).statusCode, 400);
});

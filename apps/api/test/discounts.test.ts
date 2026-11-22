import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteDataStore, type DataStore } from "@openshop/db";
import { instantToLocal } from "@openshop/pricing";
import { buildApp } from "../src/app.ts";
import { ensureAdmin, signToken } from "../src/auth.ts";
import { identityId } from "../src/identity.ts";
import { openDb } from "../src/types.ts";
import { RENDERER_VERSION } from "../src/pages.ts";

const SECRET = "test-secret";
async function make(store: DataStore = new SqliteDataStore(":memory:")) {
  await ensureAdmin(openDb(store), "admin@test.io", "pw-123456");
  const app = buildApp(store, { authSecret: SECRET, uploadDir: mkdtempSync(join(tmpdir(), "up-")) });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@test.io", password: "pw-123456" } });
  const h = { authorization: `Bearer ${login.json().token}` };
  const db = openDb(store);
  const api = async (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url, headers: { ...h, ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const product = async (name: string, price: number, extra: object = {}) => (await api("POST", "/api/products", { name, price, stock: 100, ...extra })).json();
  const offer = async (body: object) => {
    const r = await api("POST", "/api/discounts", { name: "Offer", label: "Offer", effect: { type: "percent", bp: 1000 }, ...body });
    assert.equal(r.statusCode, 201, r.body);
    return r.json();
  };
  return { app, h, db, store, api, product, offer };
}
type Ctx = Awaited<ReturnType<typeof make>>;
const form = (o: Record<string, string>, cookie?: string) => ({ payload: new URLSearchParams(o).toString(), headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) } });
async function cartWith(c: Ctx, items: [string, number][]) {
  let cookie = "";
  for (const [productId, qty] of items) {
    const r = await c.app.inject({ method: "POST", url: "/shop/cart/add", ...form({ productId, qty: String(qty) }, cookie || undefined) });
    cookie = String(r.headers["set-cookie"]).split(";")[0];
  }
  return cookie;
}
const shop = (c: Ctx, cookie: string, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) =>
  c.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
const order = (c: Ctx, items: [string, number][], email: string, extra: object = {}) =>
  c.app.inject({ method: "POST", url: "/api/shop/orders", payload: { items: items.map(([productId, qty]) => ({ productId, qty })), customer: { name: "Buyer", email, address: "1 Road" }, ...extra } });
const localIn = (ms: number, tz = "UTC") => instantToLocal(Date.now() + ms, tz);
const DAY = 86_400_000;

test("every discount admin route needs an admin token; customer-audience tokens and deleted users are refused", async () => {
  const c = await make();
  const routes: [string, string][] = [
    ["GET", "/api/discounts"], ["POST", "/api/discounts"], ["GET", "/api/discounts/x"], ["PATCH", "/api/discounts/x"], ["DELETE", "/api/discounts/x"],
    ["POST", "/api/discounts/x/pause"], ["POST", "/api/discounts/x/resume"], ["POST", "/api/discounts/x/archive"], ["POST", "/api/discounts/x/duplicate"],
    ["GET", "/api/discounts/x/codes"], ["POST", "/api/discounts/x/codes"], ["DELETE", "/api/discounts/x/codes/ABCD"], ["GET", "/api/discounts/x/redemptions"],
    ["POST", "/api/discounts/simulate"], ["GET", "/api/settings"], ["PATCH", "/api/settings"], ["GET", "/api/settings/timezone-impact"], ["GET", "/api/audit"],
  ];
  const admin = (await c.db.users.find({}))[0];
  const customerToken = signToken(admin.id, SECRET, 3600, "customer");
  for (const [method, url] of routes) {
    assert.equal((await c.app.inject({ method: method as "GET", url })).statusCode, 401, `${method} ${url}`);
    assert.equal((await c.app.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${customerToken}` } })).statusCode, 401, `customer token: ${method} ${url}`);
  }
  // a valid admin token for a user that no longer exists
  const ghost = signToken("no-such-user", SECRET);
  assert.equal((await c.app.inject({ method: "GET", url: "/api/discounts", headers: { authorization: `Bearer ${ghost}` } })).statusCode, 401);
  assert.equal((await c.api("GET", "/api/discounts")).statusCode, 200);
});

test("validation is strict: unknown fields, wrong types and domain errors are rejected with field messages", async () => {
  const c = await make();
  const post = (body: object) => c.api("POST", "/api/discounts", { name: "X", label: "X", effect: { type: "percent", bp: 1000 }, ...body });
  const typo = await post({ schedule: { start: null, endAt: "2030-01-01T00:00" } });
  assert.equal(typo.statusCode, 400, "a misspelled field is an error, not silently dropped");
  assert.equal((await post({ extra: true })).statusCode, 400);
  assert.equal((await post({ effect: { type: "percent", bp: "1000" } })).statusCode, 400, "no type coercion");
  const domain = await post({ effect: { type: "fixedPrice", cents: 1900 }, scope: "order" });
  assert.equal(domain.statusCode, 400);
  assert.deepEqual(domain.json().fields.map((f: { field: string }) => f.field), ["scope"]);
  const signIn = await post({ audience: { type: "customers", customerIds: ["c1"] }, access: { requiresSignIn: false } });
  assert.deepEqual(signIn.json().fields.map((f: { field: string }) => f.field), ["access.requiresSignIn"]);
  const refs = await post({ target: { type: "products", productIds: ["missing-product"] } });
  assert.equal(refs.statusCode, 400);
  assert.match(refs.json().fields[0].message, /unknown ids: missing-product/);
  assert.equal((await post({ audience: { type: "profiles", profileIds: ["p1"] } })).json().fields[0].field, "audience.profileIds");
  assert.equal((await post({ schedule: { start: "2030-01-02T00:00", end: "2030-01-01T00:00" } })).json().fields[0].field, "schedule.end");
});

test("create: defaults to starting now (shop time) and never ending; past starts are allowed; list shows state", async () => {
  const c = await make();
  await c.api("PATCH", "/api/settings", { timezone: "Europe/Lisbon" });
  const before = Date.now();
  const d = await c.offer({ effect: { type: "percent", bp: 2000 } });
  assert.equal(d.state, "running");
  assert.equal(d.endsAt, null);
  assert.equal(d.schedule.end, null);
  assert.ok(Math.abs(Date.parse(d.startsAt) - before) < 61_000, "start is now (to the minute)");
  assert.equal(d.schedule.start, instantToLocal(Date.parse(d.startsAt), "Europe/Lisbon"));
  assert.equal(d.version, 1);
  assert.equal(d.usedCount, 0);
  const past = await c.offer({ schedule: { start: "2020-01-01T00:00" } });
  assert.equal(past.state, "running");
  const later = await c.offer({ schedule: { start: localIn(30 * DAY, "Europe/Lisbon") } });
  assert.equal(later.state, "scheduled");
  const list = (await c.api("GET", "/api/discounts")).json();
  assert.equal(list.length, 3);
  assert.deepEqual((await c.api("GET", "/api/discounts?state=scheduled")).json().map((x: { id: string }) => x.id), [later.id]);
});

test("shop time zone: offers end at the shop's midnight; changing the zone keeps wall-clock times and is audited", async () => {
  const c = await make();
  await c.api("PATCH", "/api/settings", { timezone: "UTC" });
  const s = await c.offer({ schedule: { start: "2099-07-01T00:00", end: "2099-08-01T00:00" } });
  assert.equal(s.startsAt, "2099-07-01T00:00:00.000Z");
  const running = await c.offer({ schedule: { start: "2020-07-01T00:00", end: "2099-07-01T00:00" } });
  const winter = await c.offer({ schedule: { start: "2020-01-01T00:00", end: "2099-01-01T00:00" } });
  const impact = (await c.api("GET", "/api/settings/timezone-impact?tz=Europe/Lisbon")).json();
  assert.deepEqual(impact.changes.map((x: { id: string }) => x.id).sort(), [s.id, running.id].sort(), "winter dates don't move: Lisbon is UTC+0 then");
  assert.ok(!impact.changes.some((x: { id: string }) => x.id === winter.id));
  assert.equal((await c.api("GET", "/api/settings/timezone-impact?tz=Mars/Base")).statusCode, 400);
  const set = await c.api("PATCH", "/api/settings", { timezone: "Europe/Lisbon" });
  assert.equal(set.json().timezone, "Europe/Lisbon");
  assert.equal(set.json().timezoneConfirmed, true);
  const s2 = (await c.api("GET", `/api/discounts/${s.id}`)).json();
  assert.equal(s2.startsAt, "2099-06-30T23:00:00.000Z", "midnight Lisbon (summer) = 23:00 UTC the day before");
  assert.equal(s2.endsAt, "2099-07-31T23:00:00.000Z");
  assert.equal(s2.schedule.start, "2099-07-01T00:00");
  const r2 = (await c.api("GET", `/api/discounts/${running.id}`)).json();
  assert.equal(r2.startsAt, "2020-07-01T00:00:00.000Z", "a start that already happened doesn't move");
  assert.equal(r2.endsAt, "2099-06-30T23:00:00.000Z", "the end keeps its wall-clock meaning (midnight Lisbon)");
  assert.equal(r2.schedule.start, "2020-07-01T01:00", "stored wall-clock start matches the unchanged instant in the new zone");
  assert.equal((await c.api("GET", `/api/discounts/${winter.id}`)).json().endsAt, "2099-01-01T00:00:00.000Z");
  assert.equal((await c.api("PATCH", "/api/settings", { timezone: "Nowhere/Land" })).statusCode, 400);
  assert.equal((await c.api("PATCH", "/api/settings", { timezone: "UTC", bogus: 1 })).statusCode, 400);
  const auditLog = (await c.api("GET", `/api/audit?entity=discount&id=${s.id}`)).json().items;
  assert.deepEqual(auditLog.map((a: { action: string }) => a.action).sort(), ["create", "rezone"]);
});

test("edit with optimistic concurrency; pause, resume, duplicate, archive, delete", async () => {
  const c = await make();
  const d = await c.offer({ label: "Sale" });
  const ok = await c.api("PATCH", `/api/discounts/${d.id}`, { version: 1, label: "Big sale", effect: { type: "percent", bp: 3000 } });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().label, "Big sale");
  assert.equal(ok.json().name, "Offer", "untouched fields are kept");
  assert.equal(ok.json().version, 2);
  assert.equal((await c.api("PATCH", `/api/discounts/${d.id}`, { version: 1, label: "Stale" })).statusCode, 409);
  assert.equal((await c.api("PATCH", `/api/discounts/${d.id}`, { label: "No version" })).statusCode, 400);
  assert.equal((await c.api("POST", `/api/discounts/${d.id}/pause`)).json().state, "paused");
  assert.equal((await c.api("POST", `/api/discounts/${d.id}/resume`)).json().state, "running");
  const copy = (await c.api("POST", `/api/discounts/${d.id}/duplicate`)).json();
  assert.equal(copy.name, "Copy of Offer");
  assert.equal(copy.state, "paused", "copies never go live by accident");
  assert.equal((await c.api("POST", `/api/discounts/${copy.id}/archive`)).json().state, "archived");
  assert.equal((await c.api("DELETE", `/api/discounts/${copy.id}`)).statusCode, 204);
  assert.equal((await c.api("GET", `/api/discounts/${copy.id}`)).statusCode, 404);
  assert.equal((await c.api("DELETE", "/api/discounts/nope")).statusCode, 404);
});

test("storefront HTML never contains discount data; prices come from the API with transparency", async () => {
  const c = await make();
  const cat = (await c.api("POST", "/api/categories", { name: "Mugs", slug: "mugs" })).json();
  const mug = await c.product("Linen Mug", 24, { categoryId: cat.id });
  const bowl = await c.product("Bowl", 38);
  await c.offer({ name: "Winter (internal)", label: "Winter sale", target: { type: "categories", categoryIds: [cat.id] }, effect: { type: "percent", bp: 2000 } });
  await c.offer({ name: "Mug deal", label: "Mug fixed price", target: { type: "products", productIds: [mug.id] }, effect: { type: "fixedPrice", cents: 2000 } });
  await c.offer({ name: "Members", label: "Members only", access: { requiresSignIn: true }, effect: { type: "percent", bp: 5000 } });
  const code = await c.offer({ name: "Code", label: "Secret code offer", trigger: "code", effect: { type: "percent", bp: 9000 } });
  await c.api("POST", `/api/discounts/${code.id}/codes`, { code: "SECRET90" });

  for (const url of ["/shop", `/shop/product/${mug.id}`, "/shop/category/mugs", "/search?q=mug"]) {
    const r = await c.app.inject({ method: "GET", url });
    assert.equal(r.statusCode, 200, url);
    assert.doesNotMatch(r.body, /Winter sale|Mug fixed price|Members only|SECRET90|19\.20|20\.00/, `${url} must only show list prices`);
    assert.match(r.body, /€24\.00/);
    assert.match(r.body, new RegExp(`data-os-price="${mug.id}"`));
    assert.match(r.body, /<script src="\/assets\/shop\.js" defer><\/script>/);
    assert.match(String(r.headers["content-security-policy"]), /script-src 'self'; connect-src 'self'; require-trusted-types-for 'script'; trusted-types 'none'/);
  }
  const js = await c.app.inject({ method: "GET", url: "/assets/shop.js" });
  assert.equal(js.statusCode, 200);
  assert.match(String(js.headers["content-type"]), /text\/javascript/);
  assert.equal(js.headers["x-content-type-options"], "nosniff");
  assert.equal((await c.app.inject({ method: "GET", url: "/assets/shop.js", headers: { "if-none-match": String(js.headers.etag) } })).statusCode, 304);

  const prices = await c.app.inject({ method: "GET", url: `/api/shop/prices?ids=${mug.id},${bowl.id},bad id,nope` });
  assert.equal(prices.headers["cache-control"], "private, no-store");
  assert.equal(prices.headers["x-content-type-options"], "nosniff");
  const body = prices.json();
  assert.deepEqual(body.display, { showOriginalPrice: true, showBadge: true, showAlternatives: true });
  const m = body.items.find((i: { productId: string }) => i.productId === mug.id);
  assert.equal(m.listCents, 2400);
  assert.equal(m.priceCents, 1920, "best of 20% (19.20) and fixed 20.00");
  assert.equal(m.badge, 20);
  assert.deepEqual(m.appliedFrom.label, "Winter sale");
  assert.equal(m.appliedFrom.source, "category");
  assert.deepEqual(m.alternatives.map((a: { label: string; unitCents: number; status: string }) => [a.label, a.unitCents, a.status]), [["Mug fixed price", 2000, "better_offer_applied"]]);
  assert.equal(body.items.find((i: { productId: string }) => i.productId === bowl.id).priceCents, 3800);
  assert.doesNotMatch(prices.body, /Members only|Secret code offer|Winter \(internal\)|SECRET90/, "anonymous visitors never see sign-in, code or internal data");
  assert.equal(body.items.length, 2, "unknown and malformed ids are ignored");
});

test("voucher codes: unique, generated, listed as JSON or CSV from the same URL (Accept header)", async () => {
  const c = await make();
  const auto = await c.offer({});
  assert.equal((await c.api("POST", `/api/discounts/${auto.id}/codes`, { code: "NOPE1" })).statusCode, 400, "automatic offers have no codes");
  const d = await c.offer({ name: "Influencers", trigger: "code", scope: "order", effect: { type: "amountOff", cents: 500 } });
  const one = await c.api("POST", `/api/discounts/${d.id}/codes`, { code: " welcome10 " });
  assert.equal(one.statusCode, 201);
  assert.deepEqual(one.json().items, ["WELCOME10"]);
  const other = await c.offer({ trigger: "code" });
  assert.equal((await c.api("POST", `/api/discounts/${other.id}/codes`, { code: "WELCOME10" })).statusCode, 409, "codes are unique across offers");
  assert.equal((await c.api("POST", `/api/discounts/${d.id}/codes`, { code: "<x>" })).statusCode, 400);
  assert.equal((await c.api("POST", `/api/discounts/${d.id}/codes`, { code: "ABCD", generate: 2 })).statusCode, 400);
  const gen = await c.api("POST", `/api/discounts/${d.id}/codes`, { generate: 25, prefix: "dune" });
  assert.equal(gen.json().created, 25);
  for (const code of gen.json().items) assert.match(code, /^DUNE-[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  assert.equal((await c.api("GET", `/api/discounts/${d.id}`)).json().codeCount, 26);

  const json = await c.api("GET", `/api/discounts/${d.id}/codes?limit=10`);
  assert.equal(json.headers["vary"], "Accept");
  assert.match(String(json.headers["content-type"]), /application\/json/);
  assert.equal(json.json().total, 26);
  assert.equal(json.json().items.length, 10);
  const csv = await c.api("GET", `/api/discounts/${d.id}/codes`, undefined, { accept: "text/csv" });
  assert.equal(csv.statusCode, 200);
  assert.match(String(csv.headers["content-type"]), /^text\/csv/);
  assert.match(String(csv.headers["content-disposition"]), /attachment; filename="codes-Influencers\.csv"/);
  const rows = csv.body.replace(/^\uFEFF/, "").trim().split("\r\n");
  assert.equal(rows[0], "code,kind,used,customer,created");
  assert.equal(rows.length, 27, "CSV has every code, not one page");
  assert.equal((await c.api("GET", `/api/discounts/${d.id}/codes`, undefined, { accept: "application/xml" })).statusCode, 406);
  assert.equal((await c.api("DELETE", `/api/discounts/${d.id}/codes/welcome10`)).statusCode, 204);
  assert.equal((await c.api("DELETE", `/api/discounts/${d.id}/codes/WELCOME10`)).statusCode, 404);
});

test("cart codes: generic errors, throttling, apply and remove; checkout records the discount", async () => {
  const c = await make();
  const mug = await c.product("Mug", 50);
  const d = await c.offer({ label: "Welcome", trigger: "code", scope: "order", effect: { type: "amountOff", cents: 500 }, combinable: true });
  await c.api("POST", `/api/discounts/${d.id}/codes`, { code: "WELCOME5" });
  const paused = await c.offer({ trigger: "code", status: "paused" });
  await c.api("POST", `/api/discounts/${paused.id}/codes`, { code: "PAUSED1" });
  const cookie = await cartWith(c, [[mug.id, 2]]);

  const unknown = await shop(c, cookie, "POST", "/api/shop/cart/codes", { code: "NOPE123" });
  const inactive = await shop(c, cookie, "POST", "/api/shop/cart/codes", { code: "PAUSED1" });
  assert.equal(unknown.statusCode, 400);
  assert.deepEqual(unknown.json(), inactive.json(), "unknown and unusable codes give the same answer");
  assert.equal((await c.app.inject({ method: "POST", url: "/api/shop/cart/codes", payload: { code: "WELCOME5" } })).statusCode, 400, "needs a cart");

  const ok = await shop(c, cookie, "POST", "/api/shop/cart/codes", { code: "welcome5" });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.headers["cache-control"], "private, no-store");
  assert.deepEqual(ok.json().codes, ["WELCOME5"]);
  assert.equal(ok.json().totalCents, 9500);
  assert.equal(ok.json().diagnostics, undefined, "internal diagnostics never reach shoppers");
  const removed = await shop(c, cookie, "DELETE", "/api/shop/cart/codes/WELCOME5");
  assert.equal(removed.json().totalCents, 10000);
  await shop(c, cookie, "POST", "/api/shop/cart/codes", { code: "WELCOME5" });

  // HTML checkout with the quote the shopper saw
  const quote = (await shop(c, cookie, "GET", "/api/shop/cart")).json().quote;
  const co = await c.app.inject({ method: "POST", url: "/shop/checkout", ...form({ name: "Ann", email: "ann@x.io", address: "1 Road", quote }, cookie) });
  assert.equal(co.statusCode, 303, co.body);
  const conf = await c.app.inject({ method: "GET", url: String(co.headers.location) });
  assert.match(conf.body, /Welcome \(code WELCOME5\)/);
  assert.match(conf.body, /95\.00/);
  const o = (await c.api("GET", "/api/orders")).json()[0];
  assert.equal(o.subtotal, 100);
  assert.equal(o.discountTotal, 5);
  assert.equal(o.total, 95);
  assert.deepEqual(o.discounts, [{ discountId: d.id, label: "Welcome", source: "code", code: "WELCOME5", amount: 5 }]);
  assert.equal(o.lines[0].lineTotal, 95);
  assert.equal((await c.api("GET", `/api/discounts/${d.id}`)).json().usedCount, 1);
  const reds = await c.api("GET", `/api/discounts/${d.id}/redemptions`);
  assert.equal(reds.json().items[0].customerEmail, "ann@x.io");
  const redCsv = await c.api("GET", `/api/discounts/${d.id}/redemptions`, undefined, { accept: "text/csv" });
  assert.match(redCsv.body, /^\uFEFForder,date,code,discount,state,customer,order total\r\n/);
  assert.equal((await c.api("DELETE", `/api/discounts/${d.id}`)).statusCode, 409, "used offers can only be archived");

  // throttling: 10 failures per IP
  const cookie2 = await cartWith(c, [[mug.id, 1]]);
  let last = 0;
  for (let i = 0; i < 12; i++) last = (await shop(c, cookie2, "POST", "/api/shop/cart/codes", { code: `BAD${i}XX` })).statusCode;
  assert.equal(last, 429);
});

test("the shopper is protected from price changes between cart and checkout", async () => {
  const c = await make();
  const mug = await c.product("Mug", 40);
  const d = await c.offer({ label: "Sale", effect: { type: "percent", bp: 2500 } });
  const cookie = await cartWith(c, [[mug.id, 1]]);
  const quote = (await shop(c, cookie, "GET", "/api/shop/cart")).json().quote;
  await c.api("POST", `/api/discounts/${d.id}/pause`);
  const co = await c.app.inject({ method: "POST", url: "/shop/checkout", ...form({ name: "Ann", email: "ann@x.io", address: "1 Road", quote }, cookie) });
  assert.equal(co.statusCode, 409);
  assert.match(co.body, /Your total has changed/);
  assert.equal((await c.api("GET", "/api/orders")).json().length, 0);
  // without a quote (no JavaScript), the server's price is used
  const noJs = await c.app.inject({ method: "POST", url: "/shop/checkout", ...form({ name: "Ann", email: "ann@x.io", address: "1 Road" }, cookie) });
  assert.equal(noJs.statusCode, 303);
});

test("limits hold under concurrency: single-use codes and total uses", async () => {
  const c = await make();
  const mug = await c.product("Mug", 20);
  const d = await c.offer({ trigger: "code", scope: "order", effect: { type: "amountOff", cents: 500 } });
  const code = (await c.api("POST", `/api/discounts/${d.id}/codes`, { generate: 1 })).json().items[0];
  const quoteFor = async () => {
    const cookie = await cartWith(c, [[mug.id, 1]]);
    return (await shop(c, cookie, "POST", "/api/shop/cart/codes", { code })).json().quote;
  };
  const quote = await quoteFor();
  const res = await Promise.all(Array.from({ length: 20 }, (_, i) => order(c, [[mug.id, 1]], `buyer${i}@x.io`, { codes: [code], quote })));
  assert.equal(res.filter((r) => r.statusCode === 201).length, 1, "exactly one order gets the single-use code");
  assert.ok(res.filter((r) => r.statusCode !== 201).every((r) => r.statusCode === 409));
  assert.equal((await c.db.voucherCodes.get(code))!.usedCount, 1);

  const capped = await c.offer({ label: "First three", effect: { type: "percent", bp: 1000 }, limits: { totalUses: 3 } });
  const many = await Promise.all(Array.from({ length: 10 }, (_, i) => order(c, [[mug.id, 1]], `cap${i}@x.io`)));
  assert.ok(many.every((r) => r.statusCode === 201));
  assert.equal(many.filter((r) => r.json().discountTotal > 0).length, 3);
  assert.equal((await c.api("GET", `/api/discounts/${capped.id}`)).json().state, "used-up");
});

test("per customer: max purchases, € budget across purchases (remainder applies), first orders; same person across emails variants", async () => {
  const c = await make();
  const item = await c.product("Vase", 15);
  const once = await c.offer({ label: "Once", effect: { type: "percent", bp: 1000 }, perCustomer: { maxOrders: 1 }, priority: 1 });
  const r1 = (await order(c, [[item.id, 1]], "ann@x.io")).json();
  assert.equal(r1.discountTotal, 1.5);
  const r2 = (await order(c, [[item.id, 1]], "ANN+shop@x.io")).json();
  assert.equal(r2.discountTotal, 0, "case and +tags are the same customer");
  await c.api("POST", `/api/discounts/${once.id}/archive`);

  await c.offer({ label: "Budget", effect: { type: "percent", bp: 5000 }, perCustomer: { maxAmountCents: 1000 } });
  const b1 = (await order(c, [[item.id, 1]], "bob@x.io")).json();
  assert.equal(b1.discountTotal, 7.5);
  const b2 = (await order(c, [[item.id, 1]], "bob@x.io")).json();
  assert.equal(b2.discountTotal, 2.5, "only the €2.50 left in the budget is applied (P-a)");
  const b3 = (await order(c, [[item.id, 1]], "bob@x.io")).json();
  assert.equal(b3.discountTotal, 0);
  const usage = await c.db.discountUsage.find({ identityId: identityId("bob@x.io") });
  assert.deepEqual(usage.map((u) => [u.orders, u.amountCents]), [[2, 1000]]);
});

test("first N orders: past orders count (backfilled), cancelled orders don't (P-b)", async () => {
  const store = new SqliteDataStore(":memory:");
  // Orders that existed before this feature (no identity counters yet).
  const legacy = openDb(store);
  await legacy.orders.insert({ lines: [], total: 10, status: "paid", customer: { name: "Old", email: "old@x.io", address: "x" }, createdAt: new Date().toISOString() });
  await legacy.orders.insert({ lines: [], total: 10, status: "cancelled", customer: { name: "Gone", email: "gone@x.io", address: "x" }, createdAt: new Date().toISOString() });
  const c = await make(store);
  const item = await c.product("Plate", 30);
  await c.offer({ label: "First order", effect: { type: "percent", bp: 1000 }, perCustomer: { firstOrders: 1 } });
  assert.equal((await order(c, [[item.id, 1]], "old@x.io")).json().discountTotal, 0, "a past guest order counts");
  assert.equal((await order(c, [[item.id, 1]], "gone@x.io")).json().discountTotal, 3, "a past cancelled order doesn't");
  const first = (await order(c, [[item.id, 1]], "new@x.io")).json();
  assert.equal(first.discountTotal, 3);
  assert.equal((await order(c, [[item.id, 1]], "new@x.io")).json().discountTotal, 0);
  // cancelling the first order frees the "first order" slot... but the second order still counts
  await c.api("PATCH", `/api/orders/${first.id}`, { status: "cancelled" });
  assert.equal((await order(c, [[item.id, 1]], "new@x.io")).json().discountTotal, 0);
  const fresh = (await order(c, [[item.id, 1]], "solo@x.io")).json();
  await c.api("PATCH", `/api/orders/${fresh.id}`, { status: "cancelled" });
  assert.equal((await order(c, [[item.id, 1]], "solo@x.io")).json().discountTotal, 3, "after cancelling their only order, it's a first order again");
});

test("cancelling releases limits exactly once; cancelled orders with offers are final", async () => {
  const c = await make();
  const item = await c.product("Cup", 10);
  const d = await c.offer({ label: "Code", trigger: "code", scope: "order", effect: { type: "amountOff", cents: 200 }, perCustomer: { maxAmountCents: 300 } });
  const code = (await c.api("POST", `/api/discounts/${d.id}/codes`, { generate: 1 })).json().items[0];
  const o = (await order(c, [[item.id, 1]], "cat@x.io", { codes: [code] })).json();
  assert.equal(o.discountTotal, 2);
  assert.equal((await c.db.voucherCodes.get(code))!.usedCount, 1);
  const cancel = await c.api("PATCH", `/api/orders/${o.id}`, { status: "cancelled" });
  assert.equal(cancel.statusCode, 200);
  assert.equal((await c.api("PATCH", `/api/orders/${o.id}`, { status: "cancelled" })).statusCode, 200, "repeating is a no-op");
  assert.equal((await c.db.voucherCodes.get(code))!.usedCount, 0);
  assert.equal((await c.db.discounts.get(d.id))!.usedCount, 0);
  const u = (await c.db.discountUsage.get(`${d.id}:${identityId("cat@x.io")}`))!;
  assert.deepEqual([u.orders, u.amountCents], [0, 0]);
  assert.equal((await c.db.redemptions.find({ orderId: o.id }))[0].state, "released");
  const reopen = await c.api("PATCH", `/api/orders/${o.id}`, { status: "paid" });
  assert.equal(reopen.statusCode, 409);
  assert.equal(reopen.json().code, "cancelled_final");
  // the single-use code works again after the cancellation
  assert.equal((await order(c, [[item.id, 1]], "cat@x.io", { codes: [code] })).json().discountTotal, 2);
  // orders without offers can still be reopened
  const plain = (await order(c, [[item.id, 1]], "dan@x.io")).json();
  await c.api("PATCH", `/api/orders/${plain.id}`, { status: "cancelled" });
  assert.equal((await c.api("PATCH", `/api/orders/${plain.id}`, { status: "pending" })).statusCode, 200);
});

test("choices: a non-combinable code vs automatic offers, and saving a limited offer for later", async () => {
  const c = await make();
  const item = await c.product("Teapot", 100);
  await c.offer({ label: "Sale", effect: { type: "percent", bp: 2000 } });
  const codeOffer = await c.offer({ label: "Ten off", trigger: "code", scope: "order", effect: { type: "percent", bp: 1000 } });
  await c.api("POST", `/api/discounts/${codeOffer.id}/codes`, { code: "TENOFF" });
  const cookie = await cartWith(c, [[item.id, 1]]);
  const withCode = (await shop(c, cookie, "POST", "/api/shop/cart/codes", { code: "TENOFF" })).json();
  assert.deepEqual(withCode.scenarios.map((s: { key: string; totalCents: number; best: boolean; selected: boolean }) => [s.key, s.totalCents, s.best, s.selected]), [["automatic", 8000, true, true], ["code", 9000, false, false]]);
  assert.deepEqual(withCode.rejectedCodes, [{ code: "TENOFF", reason: "other_scenario" }]);
  const picked = (await shop(c, cookie, "PUT", "/api/shop/cart/selection", { scenario: "code" })).json();
  assert.equal(picked.totalCents, 9000);
  assert.equal((await shop(c, cookie, "PUT", "/api/shop/cart/selection", { scenario: "bogus" })).statusCode, 400);
  const co = await c.app.inject({ method: "POST", url: "/shop/checkout", ...form({ name: "Eve", email: "eve@x.io", address: "1 Road", quote: picked.quote }, cookie) });
  assert.equal(co.statusCode, 303);
  assert.equal((await c.api("GET", "/api/orders")).json()[0].total, 90, "the shopper's choice is what gets charged");

  const loyalty = await c.offer({ label: "Loyalty", effect: { type: "percent", bp: 5000 }, perCustomer: { maxAmountCents: 5000 } });
  const cookie2 = await cartWith(c, [[item.id, 1]]);
  const view = (await shop(c, cookie2, "GET", "/api/shop/cart")).json();
  assert.equal(view.totalCents, 5000);
  assert.equal(view.pending, true, "per-customer checks run when the email is known");
  assert.deepEqual(view.choices.map((x: { label: string; declined: boolean; totalIfToggled: number }) => [x.label, x.declined, x.totalIfToggled]), [["Loyalty", false, 8000]]);
  const saved = (await shop(c, cookie2, "PUT", "/api/shop/cart/selection", { declined: [loyalty.id] })).json();
  assert.equal(saved.totalCents, 8000);
  await c.app.inject({ method: "POST", url: "/shop/checkout", ...form({ name: "Fay", email: "fay@x.io", address: "1 Road", quote: saved.quote }, cookie2) });
  assert.equal((await c.db.discountUsage.get(`${loyalty.id}:${identityId("fay@x.io")}`)), null, "a saved offer's budget is untouched");
});

test("simulator explains every offer, at any moment in shop time", async () => {
  const c = await make();
  await c.api("PATCH", "/api/settings", { timezone: "Europe/Lisbon" });
  const item = await c.product("Bowl", 20);
  const future = await c.offer({ name: "Next year", schedule: { start: "2099-01-01T00:00" } });
  const members = await c.offer({ name: "Members", access: { requiresSignIn: true } });
  const now = (await c.api("POST", "/api/discounts/simulate", { items: [{ productId: item.id, qty: 2 }] })).json();
  assert.equal(now.timezone, "Europe/Lisbon");
  const reasons = Object.fromEntries(now.result.diagnostics.map((x: { discountId: string; reason: string }) => [x.discountId, x.reason]));
  assert.equal(reasons[future.id], "not_started");
  assert.equal(reasons[members.id], "sign_in_required");
  const later = (await c.api("POST", "/api/discounts/simulate", { items: [{ productId: item.id, qty: 2 }], at: "2099-01-01T00:00" })).json();
  assert.equal(later.result.totalCents, 3600);
  assert.equal(later.atLocal, "2099-01-01T00:00");
  assert.equal((await c.api("POST", "/api/discounts/simulate", { items: [{ productId: item.id, qty: 1 }], at: "soon" })).statusCode, 400);
  assert.equal((await c.api("POST", "/api/discounts/simulate", { items: [{ productId: item.id, qty: "1" }] })).statusCode, 400);
});

test("checkout never overwrites an existing customer's details", async () => {
  const c = await make();
  const item = await c.product("Mug", 10);
  await order(c, [[item.id, 1]], "vip@x.io");
  await c.app.inject({ method: "POST", url: "/api/shop/orders", payload: { items: [{ productId: item.id, qty: 1 }], customer: { name: "Impostor", email: "VIP@x.io", address: "Elsewhere" } } });
  const [cust] = (await c.api("GET", "/api/customers")).json();
  assert.equal(cust.name, "Buyer");
  assert.equal(cust.address, "1 Road");
  const orders = (await c.api("GET", "/api/orders")).json();
  assert.ok(orders.some((o: { customer: { address: string } }) => o.customer.address === "Elsewhere"), "the order keeps its own address");
});

test("pages rendered before this upgrade get the hooks and script once at startup", async () => {
  const store = new SqliteDataStore(":memory:");
  const legacy = openDb(store);
  const nodes = [{ id: "s1", type: "section", props: {}, style: {}, children: [{ id: "c1", type: "column", props: {}, style: {}, children: [{ id: "g1", type: "productGrid", props: { limit: 4 }, style: {} }] }] }];
  await legacy.pages.insert({ slug: "old", title: "Old", theme: {} as never, nodes: nodes as never, html: "<html>old</html>", system: null });
  const c = await make(store);
  await c.product("Mug", 24);
  const page = await c.app.inject({ method: "GET", url: "/s/old" });
  assert.match(page.body, /data-os-price=/);
  assert.match(page.body, /\/assets\/shop\.js/);
  assert.equal((await c.db.pages.find({ slug: "old" }))[0].rendererVersion, RENDERER_VERSION);
  assert.match(page.body, /\.os-sug\{/, "the suggestion styles are there too");
});

test("a returning guest sees the new total when a per-customer limit applies, and can confirm it", async () => {
  const c = await make();
  const vase = await c.product("Vase", 68);
  await c.offer({ label: "Vase lovers", effect: { type: "percent", bp: 1500 }, perCustomer: { maxAmountCents: 2000 } });
  assert.equal((await order(c, [[vase.id, 1]], "fan@x.io")).json().discountTotal, 10.2);
  // The cart can't know the email, so it shows the full (pending) discount...
  const cookie = await cartWith(c, [[vase.id, 1]]);
  const view = (await shop(c, cookie, "GET", "/api/shop/cart")).json();
  assert.equal(view.totalCents, 5780);
  assert.equal(view.pending, true);
  // ...and checkout explains the change instead of charging a different amount.
  const first = await c.app.inject({ method: "POST", url: "/shop/checkout", ...form({ name: "Fan", email: "fan@x.io", address: "1 Road", quote: view.quote }, cookie) });
  assert.equal(first.statusCode, 409);
  assert.match(first.body, /Your total has changed/);
  assert.match(first.body, /Vase lovers<\/td><td>−9\.80/, "only the €9.80 left in the budget");
  assert.match(first.body, /Place order for 58\.20/);
  const newQuote = /name="quote" value="([^"]+)"/.exec(first.body)![1];
  assert.notEqual(newQuote, view.quote);
  const confirm = await c.app.inject({ method: "POST", url: "/shop/checkout", ...form({ name: "Fan", email: "fan@x.io", address: "1 Road", quote: newQuote }, cookie) });
  assert.equal(confirm.statusCode, 303);
  const latest = (await c.api("GET", "/api/orders")).json()[0];
  assert.equal(latest.total, 58.2);
  // JSON API: the 409 carries the new quote
  const api409 = await order(c, [[vase.id, 1]], "fan@x.io", { quote: view.quote });
  assert.equal(api409.statusCode, 409);
  assert.equal(api409.json().code, "prices_changed");
  assert.equal(api409.json().details.total, 68, "budget now fully used");
  assert.equal((await order(c, [[vase.id, 1]], "fan@x.io", { quote: api409.json().details.quote })).statusCode, 201);
});

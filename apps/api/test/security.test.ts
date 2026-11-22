// Adversarial tests of the backoffice access control (docs/iam-security-review.md). Each test is an attack that must
// fail. Findings of the review that were fixed have a regression test here (marked FIXED).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteDataStore } from "@openshop/db";
import { TEMPLATES } from "@openshop/iam";
import { buildApp } from "../src/app.ts";
import { ensureAdmin, signToken } from "../src/auth.ts";
import { openDb } from "../src/types.ts";

const SECRET = "security-secret";
type Method = "GET" | "HEAD" | "POST" | "PATCH" | "PUT" | "DELETE";
const T = (id: string) => TEMPLATES.find((t) => t.id === id)!.permissions;

async function make() {
  const store = new SqliteDataStore(":memory:");
  const db = openDb(store);
  await ensureAdmin(db, "owner@x.io", "owner-password-1");
  const app = buildApp(store, { authSecret: SECRET });
  let n = 0;
  const login = (email: string, password: string, remoteAddress = `10.${Math.floor(n / 62500) % 250}.${Math.floor(n / 250) % 250}.${n++ % 250}`) =>
    app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password }, remoteAddress });
  const owner = (await login("owner@x.io", "owner-password-1")).json().token as string;
  const call = (t: string | null, method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url, headers: { ...(t ? { authorization: `Bearer ${t}` } : {}), ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const member = async (email: string, template: string | null) => {
    const groupIds = template ? [(await call(owner, "POST", "/api/staff-groups", { name: `${template} ${email}`, permissions: T(template) })).json().id] : [];
    const inv = (await call(owner, "POST", "/api/staff", { email, name: email.split("@")[0], groupIds })).json();
    const joined = await app.inject({ method: "POST", url: "/api/auth/links/consume", payload: { token: inv.link.path.split("#")[1], password: "glazed stoneware 9" } });
    return { id: inv.member.id as string, t: joined.json().token as string };
  };
  const ownerId = (await db.users.find({ sudo: true }))[0].id;
  return { app, db, login, owner, call, member, ownerId };
}

test("route inventory: every /api route is either public by design or declares a permission (FIXED: made testable)", async () => {
  const c = await make();
  const admin = new Set(c.app.adminRoutes.map((r) => `${r.method} ${r.url}`));
  const PUBLIC = new Set([
    "POST /api/auth/login", "POST /api/auth/links/inspect", "POST /api/auth/links/consume", // sign-in and one-time links
    "POST /api/shop/orders", "GET /api/shop/products", "GET /api/shop/categories", // the shop (customers)
  ]);
  const api = c.app.allRoutes.filter((r) => r.url.startsWith("/api/"));
  const unexpected = api.filter((r) => !admin.has(`${r.method} ${r.url}`) && !PUBLIC.has(`${r.method} ${r.url}`) && !r.url.startsWith("/api/shop/"));
  assert.deepEqual(unexpected, [], "an /api route that is neither admin (with a permission) nor knowingly public");
  assert.ok(api.length > 90);
  // Shop API routes are cookie/cart-scoped and never return staff or other customers' data: none is an admin route.
  assert.ok(!c.app.adminRoutes.some((r) => r.url.startsWith("/api/shop/")));
});

test("the strongest non-owner (Shop manager: all 17 permissions) can't reach any owner function or become the owner", async () => {
  const c = await make();
  const sam = await c.member("sam@x.io", "shop-manager");
  const attempts: [Method, string, unknown?][] = [
    ["GET", "/api/staff"], ["POST", "/api/staff", { email: "evil@x.io", name: "E" }], ["POST", `/api/staff/${c.ownerId}/links`, { purpose: "reset" }],
    ["DELETE", `/api/staff/${c.ownerId}`], ["POST", `/api/staff/${c.ownerId}/suspend`], ["PATCH", `/api/staff/${sam.id}`, { name: "x", version: 1 }],
    ["PUT", `/api/staff/${sam.id}/groups`, { groupIds: [] }], ["POST", "/api/staff-groups", { name: "x", permissions: [] }], ["GET", "/api/staff-groups"],
    ["GET", "/api/activity"], ["GET", "/api/activity/changes/x"], ["GET", "/api/security-settings"], ["PATCH", "/api/security-settings", { version: 1, activityRetentionDays: 30 }],
    ["GET", "/api/audit"], ["GET", "/api/audit?entity=staff"], ["GET", "/api/audit?entity=security-settings"], ["GET", "/api/permissions"],
  ];
  for (const [m, u, b] of attempts) {
    const r = await c.call(sam.t, m, u, b);
    assert.equal(r.statusCode, 403, `${m} ${u}`);
    assert.deepEqual(r.json().permission, ["sudo"]);
  }
  assert.equal((await c.db.users.find({ sudo: true })).length, 1);
  assert.equal((await c.call(sam.t, "GET", "/api/me")).json().sudo, false);
});

test("no way around the permission check: HEAD, method-override headers, path variants, encoded paths", async () => {
  const c = await make();
  const pat = await c.member("pat@x.io", "fulfilment");
  assert.equal((await c.call(pat.t, "HEAD", "/api/customers")).statusCode, 403);
  assert.equal((await c.call(pat.t, "POST", "/api/orders", {}, { "x-http-method-override": "GET" })).statusCode, 404, "override headers are ignored");
  for (const u of ["/api/staff/", "/api/%73taff", "/api/staff/..%2Fcustomers", "/api/customers/../staff", "/api/customers?x=1"]) {
    assert.ok([403, 404].includes((await c.call(pat.t, "GET", u)).statusCode), u);
  }
  for (const u of ["/API/staff", "/api//staff", "/api/staff;x", "/api/staff%2F"]) assert.equal((await c.call(pat.t, "GET", u)).statusCode, 404, u);
});

test("tokens: tampered claims, stripped signatures, other audiences, pre-upgrade tokens, a customer's cookie are all refused", async () => {
  const c = await make();
  const pat = await c.member("pat@x.io", "fulfilment");
  const [body, sig] = pat.t.split(".");
  const claims = JSON.parse(Buffer.from(body, "base64url").toString());
  const forge = (x: object) => `${Buffer.from(JSON.stringify(x)).toString("base64url")}.${sig}`;
  for (const t of [forge({ ...claims, sub: c.ownerId }), forge({ ...claims, sudo: true }), forge({ ...claims, exp: 9e9 }), forge({ ...claims, sv: claims.sv + 1 }),
    `${body}.`, `${body}`, "", signToken(pat.id, SECRET, 3600, "customer", { sv: claims.sv }), signToken(pat.id, "guessed-secret", 3600, "admin", { sv: claims.sv }),
    signToken(pat.id, SECRET)]) {
    assert.equal((await c.call(t || null, "GET", "/api/orders")).statusCode, 401, t.slice(0, 40));
  }
  assert.equal((await c.call(null, "GET", "/api/orders", undefined, { cookie: `cs=${pat.t}` })).statusCode, 401, "cookies are never admin sessions");
  assert.equal((await c.call(pat.t, "GET", "/api/orders")).statusCode, 200, "the genuine token works");
});

test("mass assignment and prototype pollution: no body can set owner, status, password or unknown permissions", async () => {
  const c = await make();
  const pat = await c.member("pat@x.io", "fulfilment");
  const json = { "content-type": "application/json" };
  for (const b of [{ version: 1, sudo: true }, { version: 1, status: "active" }, { version: 1, passwordHash: "x" }, { version: 1, sessionVersion: 0 }, { version: 1, email: "o@x.io" }])
    assert.equal((await c.call(c.owner, "PATCH", `/api/staff/${pat.id}`, b)).statusCode, 400, JSON.stringify(b));
  assert.equal((await c.call(c.owner, "PATCH", `/api/staff/${pat.id}`, '{"version":1,"__proto__":{"sudo":true}}', json)).statusCode, 400);
  assert.equal((await c.call(c.owner, "PATCH", `/api/staff/${pat.id}`, '{"version":1,"constructor":{"prototype":{"sudo":true}}}', json)).statusCode, 400);
  assert.equal((await c.call(c.owner, "POST", "/api/staff-groups", { name: "x", permissions: ["sudo"] })).statusCode, 400);
  assert.equal((await c.call(c.owner, "POST", "/api/staff-groups", { name: "x", permissions: ["team.manage"] })).statusCode, 400);
  assert.equal((await c.call(c.owner, "PUT", `/api/staff/${pat.id}/groups`, { groupIds: Array.from({ length: 10_000 }, (_, i) => String(i)) })).statusCode, 400);
  assert.equal((await c.call(c.owner, "PATCH", "/api/security-settings", { version: 1, passwordPolicy: { staff: { minLength: 1, requireClasses: 0, disallowEmail: false, blockCommon: false } } })).statusCode, 400);
  assert.equal(({} as Record<string, unknown>).sudo, undefined, "Object.prototype untouched");
  const u = (await c.db.users.get(pat.id))!;
  assert.equal(u.sudo, false);
  // The stock-only rule looks at the validated body: unknown fields are dropped, known ones need the real permission.
  const prod = (await c.call(c.owner, "POST", "/api/products", { name: "Bowl", price: 10 })).json();
  assert.equal((await c.call(pat.t, "PATCH", `/api/products/${prod.id}`, { stock: 3, price: 0 })).statusCode, 403);
  // The catalogue schema is strict: unknown fields are refused (400) rather than dropped, so nothing is written.
  assert.equal((await c.call(pat.t, "PATCH", `/api/products/${prod.id}`, { stock: 3, pricE: 0 })).statusCode, 400);
  assert.equal((await c.db.products.get(prod.id))!.price, 10);
});

test("FIXED: voucher code lists name the customer of a personal code only for members who may see customers", async () => {
  const c = await make();
  const max = await c.member("max@x.io", "promotions");
  const cust = (await c.call(c.owner, "POST", "/api/customers", { email: "priya@buyer.test", name: "Priya" })).json();
  const v = (await c.call(c.owner, "POST", "/api/discounts", { name: "V", label: "V", trigger: "code", effect: { type: "percent", bp: 500 } })).json();
  await c.call(c.owner, "POST", `/api/discounts/${v.id}/codes`, { generate: 1, assignedCustomerId: cust.id });
  const asMax = await c.call(max.t, "GET", `/api/discounts/${v.id}/codes`);
  assert.equal(asMax.statusCode, 200);
  assert.ok(!asMax.body.includes("priya@buyer.test"));
  assert.equal(asMax.json().items[0].assignedEmail, null);
  assert.ok(!(await c.call(max.t, "GET", `/api/discounts/${v.id}/codes`, undefined, { accept: "text/csv" })).body.includes("priya@buyer.test"));
  assert.equal((await c.call(c.owner, "GET", `/api/discounts/${v.id}/codes`)).json().items[0].assignedEmail, "priya@buyer.test", "the owner still sees it");
});

test("FIXED: refused requests can't flood the activity log (counted per minute and member, route, permission)", async () => {
  const c = await make();
  const pat = await c.member("pat@x.io", "fulfilment");
  const before = await c.db.activity.count({ kind: "api_denied" });
  for (let i = 0; i < 300; i++) await c.call(pat.t, "GET", "/api/customers");
  const rows = await c.db.activity.find({ kind: "api_denied", userId: pat.id });
  assert.ok(rows.length - before <= 2, `rows added: ${rows.length - before}`);
  assert.equal(rows.reduce((n, e) => n + (e.count ?? 1), 0), 300, "every refusal is still counted");
  assert.equal(rows[0].permission, "customers.view");
});

test("FIXED: repeated query parameters never reach a handler as an array (no 500, also on the public shop API)", async () => {
  const c = await make();
  for (const u of ["/api/activity?userId=a&userId=b", "/api/audit?entity=discount&entity=staff", "/api/discounts?q=a&q=b", "/api/staff?status=removed&status=all"])
    assert.ok((await c.call(c.owner, "GET", u)).statusCode < 500, u);
  assert.equal((await c.call(null, "GET", "/api/shop/products?categoryId=a&categoryId=b")).statusCode, 200);
  const pat = await c.member("pat@x.io", "fulfilment");
  // The last value wins: a member can't smuggle an allowed entity next to a forbidden one.
  assert.equal((await c.call(pat.t, "GET", "/api/audit?entity=product&entity=staff")).statusCode, 403);
});

test("FIXED: sign-in and one-time links take JSON only (not a cross-site form)", async () => {
  const c = await make();
  const form = { "content-type": "application/x-www-form-urlencoded" };
  assert.equal((await c.app.inject({ method: "POST", url: "/api/auth/login", payload: "email=owner%40x.io&password=owner-password-1", headers: form })).statusCode, 415);
  assert.equal((await c.app.inject({ method: "POST", url: "/api/auth/links/inspect", payload: "token=x", headers: form })).statusCode, 415);
  assert.equal((await c.app.inject({ method: "POST", url: "/api/auth/links/consume", payload: "token=x&password=y", headers: { "content-type": "text/plain" } })).statusCode, 415);
  assert.equal((await c.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "owner@x.io", password: "owner-password-1" }, headers: { "content-type": "application/json; charset=utf-8" } })).statusCode, 200);
  // Admin routes need the Authorization header, which a cross-site form or image can't send.
  assert.equal((await c.app.inject({ method: "DELETE", url: "/api/staff/x", headers: { cookie: "anything=1" } })).statusCode, 401);
});

test("one-time links: 256-bit tokens, guessing is throttled per address, format checked before any lookup", async () => {
  const c = await make();
  const inv = (await c.call(c.owner, "POST", "/api/staff", { email: "new@x.io", name: "New" })).json();
  const token = inv.link.path.split("#")[1];
  assert.match(token, /^[A-Za-z0-9_-]{43}$/, "32 random bytes, base64url");
  const statuses: number[] = [];
  for (let i = 0; i < 32; i++) statuses.push((await c.app.inject({ method: "POST", url: "/api/auth/links/inspect", payload: { token: `guess${i}`.padEnd(43, "x") }, remoteAddress: "10.66.0.1" })).statusCode);
  assert.equal(statuses.indexOf(429), 30, "the 31st wrong guess from one address is refused");
  assert.equal((await c.app.inject({ method: "POST", url: "/api/auth/links/inspect", payload: { token }, remoteAddress: "10.66.0.1" })).statusCode, 429, "even the right token, from a guessing address");
  assert.equal((await c.app.inject({ method: "POST", url: "/api/auth/links/inspect", payload: { token }, remoteAddress: "10.66.0.2" })).statusCode, 200);
  for (const bad of ["' OR 1=1 --", "{\"$ne\":null}", "a".repeat(201)]) assert.ok([400, 410].includes((await c.app.inject({ method: "POST", url: "/api/auth/links/inspect", payload: { token: bad }, remoteAddress: "10.66.0.3" })).statusCode));
});

test("sign-in responses don't reveal which accounts exist: same status and similar time for unknown, active, invited, suspended and removed", async () => {
  const c = await make();
  const kinds: Record<string, string[]> = { unknown: [], active: [], invited: [], suspended: [], removed: [] };
  for (let i = 0; i < 3; i++) {
    kinds.unknown.push(`nobody${i}@x.io`);
    kinds.active.push((await c.member(`a${i}@x.io`, null)) && `a${i}@x.io`);
    await c.call(c.owner, "POST", "/api/staff", { email: `i${i}@x.io`, name: "I" }); kinds.invited.push(`i${i}@x.io`);
    const s = await c.member(`s${i}@x.io`, null); await c.call(c.owner, "POST", `/api/staff/${s.id}/suspend`); kinds.suspended.push(`s${i}@x.io`);
    const r = await c.member(`r${i}@x.io`, null); await c.call(c.owner, "DELETE", `/api/staff/${r.id}`); kinds.removed.push(`r${i}@x.io`);
  }
  const times: Record<string, number[]> = {};
  for (let round = 0; round < 6; round++) for (const [k, emails] of Object.entries(kinds)) for (const e of emails) {
    const t0 = performance.now();
    const r = await c.login(e, "wrong-password-1");
    (times[k] ??= []).push(performance.now() - t0);
    assert.equal(r.statusCode, 401);
    assert.deepEqual(r.json(), { error: "invalid credentials" });
  }
  const med = Object.fromEntries(Object.entries(times).map(([k, v]) => [k, v.sort((a, b) => a - b)[v.length >> 1]]));
  const lo = Math.min(...Object.values(med)), hi = Math.max(...Object.values(med));
  assert.ok(hi / lo < 2, `medians differ too much: ${JSON.stringify(med)}`); // each one verifies a real scrypt hash
});

test("hostile text is stored as data: JSON responses, nosniff, no-store on staff data; never HTML", async () => {
  const c = await make();
  const evil = `<img src=x onerror="alert(1)"><script>alert(2)</script>`;
  const r = await c.call(c.owner, "POST", "/api/staff", { email: "evil@x.io", name: evil });
  assert.equal(r.statusCode, 201);
  assert.equal(r.json().member.name, evil.trim(), "stored verbatim: escaping is the backoffice's job (Angular interpolation)");
  for (const u of ["/api/staff", "/api/me", `/api/staff/${r.json().member.id}`, "/api/activity", "/api/staff-groups", "/api/security-settings", "/api/orders", "/api/customers"]) {
    const h = (await c.call(c.owner, "GET", u)).headers;
    assert.match(String(h["content-type"]), /^application\/json/, u);
    assert.equal(h["x-content-type-options"], "nosniff", u);
    assert.equal(h["cache-control"], "no-store", u);
  }
  assert.equal((await c.call(null, "GET", "/api/orders")).headers["cache-control"], "no-store", "refusals too");
  const link = await c.app.inject({ method: "POST", url: "/api/auth/links/inspect", payload: { token: r.json().link.path.split("#")[1] } });
  assert.equal(link.headers["referrer-policy"], "no-referrer");
});

test("client addresses: X-Forwarded-For is ignored unless TRUST_PROXY names the proxy (no spoofing past the sign-in limits)", async () => {
  const { parseTrustProxy } = await import("../src/app.ts");
  assert.equal(parseTrustProxy(undefined), undefined);
  assert.equal(parseTrustProxy("  "), undefined);
  assert.equal(parseTrustProxy("true"), true);
  assert.equal(parseTrustProxy(" 10.0.0.5,10.1.0.0/16 "), "10.0.0.5,10.1.0.0/16");
  const tryLogin = async (trustProxy: string | undefined, from: string, forwarded: string) => {
    const store = new SqliteDataStore(":memory:");
    await ensureAdmin(openDb(store), "owner@x.io", "owner-password-1");
    const app = buildApp(store, { authSecret: SECRET, trustProxy: parseTrustProxy(trustProxy) });
    await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "owner@x.io", password: "wrong" }, remoteAddress: from, headers: { "x-forwarded-for": forwarded } });
    const [e] = await openDb(store).activity.find({ kind: "sign_in_failed" });
    await app.close();
    return e.ip;
  };
  assert.equal(await tryLogin(undefined, "198.51.100.9", "203.0.113.7"), "198.51.100.9", "no proxy configured: the header is ignored");
  assert.equal(await tryLogin("10.0.0.5", "10.0.0.5", "203.0.113.7"), "203.0.113.7", "the trusted proxy tells the client's address");
  assert.equal(await tryLogin("10.1.0.0/16", "10.1.2.3", "203.0.113.7"), "203.0.113.7", "CIDR ranges");
  assert.equal(await tryLogin("10.0.0.5", "198.51.100.9", "203.0.113.7"), "198.51.100.9", "anyone else can't");
  assert.equal(await tryLogin("10.0.0.5", "10.0.0.5", "6.6.6.6, 203.0.113.7"), "203.0.113.7", "a forged left-most value is ignored");
  assert.equal(await tryLogin("true", "10.0.0.5", "6.6.6.6, 203.0.113.7"), "6.6.6.6", "why \"true\" is not recommended: the forged value wins");
});

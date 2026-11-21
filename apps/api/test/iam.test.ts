// Staff accounts (IAM v2): invitations and links, soft delete and restore, the owner account, migration, password
// policies, sessions and the activity log. The route × persona matrix is in access-matrix.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, scryptSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { SqliteDataStore } from "@openshop/db";
import { buildApp } from "../src/app.ts";
import { createSudo, ensureAdmin, hashPassword, signToken, verifyPassword } from "../src/auth.ts";
import { migrateIam } from "../src/migrations.ts";
import { createAggregator, pruneActivity, queryActivity, recordActivity } from "../src/activity.ts";
import { createAuthorizer } from "../src/authorize.ts";
import { openDb, type User } from "../src/types.ts";

const SECRET = "iam-secret";
const OWNER = "owner@shop.test", PW = "owner-password-1";
type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

async function make() {
  const store = new SqliteDataStore(":memory:");
  const db = openDb(store);
  await ensureAdmin(db, OWNER, PW);
  const app = buildApp(store, { authSecret: SECRET, uploadDir: mkdtempSync(join(tmpdir(), "up-")) });
  let ip = 1;
  const login = (email: string, password: string, remoteAddress = `10.1.0.${ip++ % 250}`) => app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password }, remoteAddress });
  const ownerToken = (await login(OWNER, PW)).json().token as string;
  const call = (token: string | null, method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const owner = (method: Method, url: string, payload?: unknown, headers?: Record<string, string>) => call(ownerToken, method, url, payload, headers);
  const tokenOf = (path: string) => path.split("#")[1];
  const consume = (path: string, password = "staff-password-1") => app.inject({ method: "POST", url: "/api/auth/links/consume", payload: { token: tokenOf(path), password } });
  /** Invites and accepts; returns the member and their session token. */
  const member = async (email: string, permissions: string[] = []) => {
    const groupIds = permissions.length ? [(await owner("POST", "/api/staff-groups", { name: `G ${email}`, permissions })).json().id] : [];
    const inv = await owner("POST", "/api/staff", { email, name: email.split("@")[0], groupIds });
    assert.equal(inv.statusCode, 201, inv.body);
    const joined = await consume(inv.json().link.path);
    assert.equal(joined.statusCode, 200, joined.body);
    return { id: inv.json().member.id as string, token: joined.json().token as string, groupIds };
  };
  return { app, db, store, login, owner, call, consume, tokenOf, member, ownerToken };
}

test("invite → inspect → join: link in the fragment, shown once, only its hash stored, single use; the invitee is signed in", async () => {
  const c = await make();
  const g = (await c.owner("POST", "/api/staff-groups", { name: "Fulfilment", permissions: ["orders.fulfil"] })).json();
  assert.deepEqual(g.permissions, ["orders.view", "orders.fulfil"], "stored closed under requires");
  const inv = await c.owner("POST", "/api/staff", { email: " Lena@Shop.TEST ", name: "Lena", groupIds: [g.id] });
  assert.equal(inv.statusCode, 201, inv.body);
  const { member, link } = inv.json();
  assert.equal(member.status, "invited");
  assert.equal(member.email, "lena@shop.test");
  assert.match(link.path, /^\/join#[A-Za-z0-9_-]{43}$/);
  assert.ok(Date.parse(link.expiresAt) - Date.now() > 71 * 3600_000);
  const token = c.tokenOf(link.path);
  const stored = JSON.stringify(await c.db.staffLinks.find({}));
  assert.ok(!stored.includes(token), "the token itself is never stored");
  assert.ok(!JSON.stringify(await c.db.audit.find({})).includes(token) && !JSON.stringify(await c.db.activity.find({})).includes(token), "nor logged");
  assert.equal((await c.owner("GET", `/api/staff/${member.id}`)).json().pendingLink.purpose, "invite");
  assert.equal((await c.login("lena@shop.test", "anything-at-all")).statusCode, 401, "an invited member can't sign in");

  const info = await c.app.inject({ method: "POST", url: "/api/auth/links/inspect", payload: { token } });
  assert.equal(info.statusCode, 200);
  assert.equal(info.headers["cache-control"], "no-store");
  assert.equal(info.json().email, "lena@shop.test");
  assert.deepEqual(info.json().rules, ["At least 12 characters", "Must not contain your email address"]);
  const weak = await c.app.inject({ method: "POST", url: "/api/auth/links/consume", payload: { token, password: "short" } });
  assert.equal(weak.statusCode, 400);
  assert.equal(weak.json().code, "password_policy");
  assert.equal((await c.app.inject({ method: "POST", url: "/api/auth/links/consume", payload: { token, password: "lena-is-my-password" } })).json().issues[0].code, "contains_email");
  const ok = await c.consume(link.path);
  assert.equal(ok.statusCode, 200);
  const me = await c.call(ok.json().token, "GET", "/api/me");
  assert.deepEqual(me.json().permissions, ["orders.view", "orders.fulfil"]);
  assert.equal(me.json().owner.name, "owner");
  assert.equal((await c.consume(link.path)).statusCode, 410, "single use");
  assert.equal((await c.app.inject({ method: "POST", url: "/api/auth/links/inspect", payload: { token } })).statusCode, 410);
  assert.equal((await c.login("lena@shop.test", "staff-password-1")).statusCode, 200);
  const kinds = (await c.db.activity.find({})).map((e) => e.kind);
  for (const k of ["link_created", "link_opened", "link_used", "sign_in", "link_invalid"]) assert.ok(kinds.includes(k as never), k);
});

test("links: 20 parallel uses succeed once; a revoke racing a use can't both win; revoke within the window; a new link revokes the old", async () => {
  const c = await make();
  const inv = (await c.owner("POST", "/api/staff", { email: "a@shop.test", name: "A" })).json();
  const results = await Promise.all(Array.from({ length: 20 }, () => c.consume(inv.link.path)));
  assert.equal(results.filter((r) => r.statusCode === 200).length, 1);

  const b = (await c.owner("POST", "/api/staff", { email: "b@shop.test", name: "B" })).json();
  const [use, revoke] = await Promise.all([c.consume(b.link.path), c.owner("POST", `/api/staff/${b.member.id}/links/revoke`)]);
  assert.ok((use.statusCode === 200) !== (revoke.json().revoked === 1), "exactly one of them wins");

  const d = (await c.owner("POST", "/api/staff", { email: "d@shop.test", name: "D" })).json();
  assert.equal((await c.owner("POST", `/api/staff/${d.member.id}/links/revoke`)).json().revoked, 1);
  assert.equal((await c.owner("POST", `/api/staff/${d.member.id}/links/revoke`)).json().revoked, 0, "idempotent");
  assert.equal((await c.consume(d.link.path)).statusCode, 410, "revoked inside the 72 h window");
  const again = (await c.owner("POST", `/api/staff/${d.member.id}/links`, { purpose: "invite" })).json();
  const newer = (await c.owner("POST", `/api/staff/${d.member.id}/links`, { purpose: "invite" })).json();
  assert.equal((await c.consume(again.path)).statusCode, 410, "a new link revokes the previous one");
  assert.equal((await c.consume(newer.path)).statusCode, 200);
  const detail = (await c.owner("GET", `/api/staff/${d.member.id}`)).json();
  assert.deepEqual(detail.links.map((l: { state: string }) => l.state), ["used", "revoked", "revoked"]);
  assert.equal(detail.links[2].revokedBy, "owner");
  assert.equal((await c.owner("POST", `/api/staff/${d.member.id}/links`, { purpose: "invite" })).statusCode, 409, "invites are for members who haven't joined");
  // expired links are refused
  const e = (await c.owner("POST", "/api/staff", { email: "e@shop.test", name: "E" })).json();
  const [l] = await c.db.staffLinks.find({ userId: e.member.id, usedAt: null, revokedAt: null });
  await c.db.staffLinks.update(l.id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await c.consume(e.link.path)).statusCode, 410);
  assert.equal((await c.owner("GET", "/api/staff")).json().items.find((x: { id: string }) => x.id === e.member.id).inviteExpired, true);
});

test("the same email invited in parallel: exactly one invitation; the owner's own email is taken too", async () => {
  const c = await make();
  const rs = await Promise.all(Array.from({ length: 10 }, () => c.owner("POST", "/api/staff", { email: "same@shop.test", name: "Same" })));
  assert.equal(rs.filter((r) => r.statusCode === 201).length, 1);
  assert.ok(rs.filter((r) => r.statusCode !== 201).every((r) => r.statusCode === 409 && r.json().code === "exists"));
  assert.equal((await c.owner("POST", "/api/staff", { email: OWNER, name: "Me" })).json().code, "exists");
  assert.equal((await c.owner("POST", "/api/staff", { email: "not-an-email", name: "X" })).statusCode, 400);
  assert.equal((await c.owner("POST", "/api/staff", { email: "x@shop.test", name: "X", groupIds: ["nope"] })).statusCode, 400);
  assert.equal((await c.owner("POST", "/api/staff", { email: "x@shop.test", name: "X", sudo: true })).statusCode, 400, "no field can make an owner");
});

test("remove is a soft delete: sign-in blocked, sessions end at once, history and record kept; restore brings back the same account without groups", async () => {
  const c = await make();
  const m = await c.member("pat@shop.test", ["orders.fulfil"]);
  assert.equal((await c.call(m.token, "GET", "/api/orders")).statusCode, 200);
  const pending = (await c.owner("POST", `/api/staff/${m.id}/links`, { purpose: "reset" })).json();
  assert.equal((await c.owner("DELETE", `/api/staff/${m.id}`)).statusCode, 204);
  assert.equal((await c.call(m.token, "GET", "/api/orders")).statusCode, 401, "the open session ends at the next request");
  assert.equal((await c.login("pat@shop.test", "staff-password-1")).statusCode, 401);
  assert.equal((await c.consume(pending.path)).statusCode, 410, "pending links are revoked");
  const u = (await c.db.users.get(m.id))!;
  assert.equal(u.status, "removed");
  assert.equal(u.passwordHash, null);
  assert.equal(u.email, "pat@shop.test", "the record is kept");
  assert.equal((await c.db.staffMemberships.find({ userId: m.id })).length, 0);
  const removal = (await c.db.audit.find({ entity: "staff", action: "remove" }))[0];
  assert.deepEqual((removal.before as { groupIds: string[] }).groupIds, m.groupIds, "what they had stays visible");
  assert.ok((await c.db.activity.find({ userId: m.id })).length > 0, "their activity is kept");
  assert.ok((await c.db.activity.find({ kind: "session_ended", userId: m.id })).length > 0);
  assert.equal((await c.owner("GET", "/api/staff")).json().items.some((x: { id: string }) => x.id === m.id), false, "hidden by default");
  assert.equal((await c.owner("GET", "/api/staff?status=removed")).json().items[0].id, m.id);
  assert.equal((await c.owner("DELETE", `/api/staff/${m.id}`)).statusCode, 204, "idempotent");
  assert.equal((await c.owner("PUT", `/api/staff/${m.id}/groups`, { groupIds: [] })).statusCode, 409);
  assert.equal((await c.owner("POST", `/api/staff-groups/${m.groupIds[0]}/members`, { add: [m.id] })).statusCode, 400);

  const again = await c.owner("POST", "/api/staff", { email: "pat@shop.test", name: "Pat" });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().code, "removed_member");
  assert.equal(again.json().userId, m.id);
  const restored = await c.owner("POST", `/api/staff/${m.id}/restore`);
  assert.equal(restored.statusCode, 200);
  assert.equal(restored.json().member.status, "invited");
  assert.deepEqual(restored.json().member.groups, [], "no groups come back by themselves");
  assert.equal((await c.consume(restored.json().link.path)).statusCode, 200);
  assert.equal((await c.db.users.get(m.id))!.status, "active", "the same account");
  assert.equal((await c.owner("POST", `/api/staff/${m.id}/restore`)).statusCode, 409);
});

test("suspend keeps groups and password; reactivate restores; the owner account can't be suspended, removed, signed out or put in groups", async () => {
  const c = await make();
  const m = await c.member("sid@shop.test", ["catalog.view"]);
  assert.equal((await c.owner("POST", `/api/staff/${m.id}/suspend`)).json().status, "suspended");
  assert.equal((await c.call(m.token, "GET", "/api/products")).statusCode, 401);
  assert.equal((await c.login("sid@shop.test", "staff-password-1")).statusCode, 401);
  assert.equal((await c.owner("POST", `/api/staff/${m.id}/suspend`)).statusCode, 409);
  assert.equal((await c.owner("POST", `/api/staff/${m.id}/reactivate`)).json().status, "active");
  const t = (await c.login("sid@shop.test", "staff-password-1")).json().token;
  assert.equal((await c.call(t, "GET", "/api/products")).statusCode, 200, "same password, same groups");
  assert.equal((await c.owner("POST", `/api/staff/${m.id}/sign-out`)).statusCode, 200);
  assert.equal((await c.call(t, "GET", "/api/products")).statusCode, 401);

  const sudo = (await c.db.users.find({ sudo: true }))[0];
  for (const [method, url] of [["POST", `/api/staff/${sudo.id}/suspend`], ["POST", `/api/staff/${sudo.id}/sign-out`], ["DELETE", `/api/staff/${sudo.id}`]] as const) {
    const r = await c.owner(method, url);
    assert.equal(r.statusCode, 409, url);
    assert.equal(r.json().code, "sudo");
  }
  assert.equal((await c.owner("PUT", `/api/staff/${sudo.id}/groups`, { groupIds: [] })).statusCode, 409);
  assert.equal((await c.owner("POST", `/api/staff/${sudo.id}/links`, { purpose: "reset" })).statusCode, 409);
  assert.equal((await c.owner("PATCH", `/api/staff/${sudo.id}`, { version: 1, sudo: false })).statusCode, 400, "no API field changes who the owner is");
  assert.equal((await c.owner("PATCH", `/api/staff/${sudo.id}`, { version: 1, name: "Olivia" })).json().name, "Olivia");
  assert.equal((await c.owner("PATCH", `/api/staff/${sudo.id}`, { version: 1, name: "Stale" })).statusCode, 409, "version conflict");
  assert.equal((await c.db.users.find({ sudo: true })).length, 1);
});

test("permissions follow group changes on the next request; group version conflicts; deleting a group removes its access", async () => {
  const c = await make();
  const m = await c.member("max@shop.test", ["discounts.view"]);
  const gid = m.groupIds[0];
  assert.equal((await c.call(m.token, "GET", "/api/discounts")).statusCode, 200);
  assert.equal((await c.call(m.token, "GET", "/api/orders")).statusCode, 403);
  const patched = await c.owner("PATCH", `/api/staff-groups/${gid}`, { permissions: ["orders.view"], version: 1 });
  assert.equal(patched.json().affectedMembers, 1);
  assert.equal((await c.call(m.token, "GET", "/api/orders")).statusCode, 200, "granted at once");
  assert.equal((await c.call(m.token, "GET", "/api/discounts")).statusCode, 403, "removed at once");
  assert.equal((await c.owner("PATCH", `/api/staff-groups/${gid}`, { name: "Stale", version: 1 })).statusCode, 409);
  assert.equal((await c.owner("POST", "/api/staff-groups", { name: "Bad", permissions: ["team.manage"] })).statusCode, 400, "unknown permissions are refused");
  const sudo = (await c.db.users.find({ sudo: true }))[0];
  assert.equal((await c.owner("POST", `/api/staff-groups/${gid}/members`, { add: [sudo.id] })).statusCode, 400);
  assert.equal((await c.owner("POST", `/api/staff-groups/${gid}/members`, { add: ["nobody"] })).statusCode, 400);
  const other = (await c.owner("POST", "/api/staff-groups", { name: "Other", permissions: ["insights.view"] })).json();
  const set = await c.owner("PUT", `/api/staff/${m.id}/groups`, { groupIds: [gid, other.id] });
  assert.deepEqual(set.json().groups.map((g: { name: string }) => g.name).sort(), ["G max@shop.test", "Other"]);
  const src = set.json().permissionSources.find((p: { id: string }) => p.id === "insights.view");
  assert.deepEqual(src.groups.map((g: { name: string }) => g.name), ["Other"]);
  assert.equal((await c.owner("DELETE", `/api/staff-groups/${other.id}`)).statusCode, 204);
  assert.equal((await c.call(m.token, "GET", "/api/reports/summary")).statusCode, 403);
  assert.equal((await c.db.staffMemberships.find({ groupId: other.id })).length, 0);
  const dup = await c.owner("POST", "/api/staff-groups", { name: "G max@shop.test", permissions: [] });
  assert.match(dup.json().warning, /same name/);
});

test("body rules: stock-only edits, order status targets, customer audiences, assigned codes, simulating a customer, history by entity", async () => {
  const c = await make();
  const pat = await c.member("pat@shop.test", ["catalog.stock", "orders.fulfil"]);
  const prod = (await c.owner("POST", "/api/products", { name: "Bowl", price: 10, stock: 5 })).json();
  assert.equal((await c.call(pat.token, "PATCH", `/api/products/${prod.id}`, { stock: 9 })).statusCode, 200);
  const priced = await c.call(pat.token, "PATCH", `/api/products/${prod.id}`, { stock: 9, price: 1 });
  assert.equal(priced.statusCode, 403);
  assert.deepEqual(priced.json().permission, ["catalog.manage"]);
  const order = (await c.app.inject({ method: "POST", url: "/api/shop/orders", payload: { items: [{ productId: prod.id, qty: 1 }], customer: { name: "B", email: "b@b.test", address: "x" } } })).json();
  assert.equal((await c.call(pat.token, "PATCH", `/api/orders/${order.id}`, { status: "paid" })).statusCode, 403);
  assert.equal((await c.call(pat.token, "PATCH", `/api/orders/${order.id}`, { status: "shipped" })).statusCode, 200);
  assert.equal((await c.call(pat.token, "PATCH", `/api/orders/nope`, { status: "shipped" })).statusCode, 404);

  const max = await c.member("max@shop.test", ["discounts.manage", "discounts.codes"]);
  const cust = (await c.owner("POST", "/api/customers", { email: "vip@b.test", name: "Vip" })).json();
  assert.equal((await c.call(max.token, "POST", "/api/discounts", { name: "Client", label: "x", effect: { type: "percent", bp: 100 }, audience: { type: "customers", customerIds: [cust.id] }, access: { requiresSignIn: true } })).statusCode, 403);
  const everyone = (await c.call(max.token, "POST", "/api/discounts", { name: "All", label: "x", effect: { type: "percent", bp: 100 } })).json();
  assert.equal((await c.call(max.token, "PATCH", `/api/discounts/${everyone.id}`, { version: 1, audience: { type: "customers", customerIds: [cust.id] }, access: { requiresSignIn: true } })).statusCode, 403, "nor by editing");
  const code = (await c.call(max.token, "POST", "/api/discounts", { name: "Codes", label: "x", trigger: "code", effect: { type: "percent", bp: 100 } })).json();
  assert.equal((await c.call(max.token, "POST", `/api/discounts/${code.id}/codes`, { generate: 1, assignedCustomerId: cust.id })).statusCode, 403);
  assert.equal((await c.call(max.token, "POST", `/api/discounts/${code.id}/codes`, { generate: 1 })).statusCode, 201);
  assert.equal((await c.call(max.token, "POST", "/api/discounts/simulate", { items: [{ productId: prod.id, qty: 1 }], customerId: cust.id })).statusCode, 403);
  assert.equal((await c.call(max.token, "GET", `/api/audit?entity=discount&id=${everyone.id}`)).statusCode, 200);
  assert.equal((await c.call(max.token, "GET", `/api/audit?entity=customer&id=${cust.id}`)).statusCode, 403);
  assert.equal((await c.call(max.token, "GET", "/api/audit")).statusCode, 403, "the whole log is owner-only");
  assert.equal((await c.call(max.token, "GET", "/api/audit?entity=staff")).statusCode, 403);
  const denied = await c.db.activity.find({ kind: "api_denied", userId: max.id });
  assert.ok(denied.some((e) => e.permission === "customers.view" && e.path === "/api/discounts/simulate"));
  assert.ok(denied.some((e) => e.permission === "sudo"));
});

test("tokens: pre-upgrade tokens (no session version), other audiences, forged and expired tokens are refused and logged", async () => {
  const c = await make();
  const sudo = (await c.db.users.find({ sudo: true }))[0];
  assert.equal((await c.call(signToken(sudo.id, SECRET), "GET", "/api/products")).statusCode, 401, "no sv claim");
  assert.equal((await c.call(signToken(sudo.id, SECRET, 3600, "customer", { sv: 0 }), "GET", "/api/products")).statusCode, 401);
  assert.equal((await c.call(signToken(sudo.id, "other", 3600, "admin", { sv: 0 }), "GET", "/api/products")).statusCode, 401);
  assert.equal((await c.call(signToken(sudo.id, SECRET, -10, "admin", { sv: 0 }), "GET", "/api/products")).statusCode, 401);
  assert.equal((await c.call(signToken("ghost", SECRET, 3600, "admin", { sv: 0 }), "GET", "/api/products")).statusCode, 401);
  assert.equal((await c.call(null, "GET", "/api/products")).statusCode, 401);
  assert.equal((await c.call("not-a-token", "GET", "/api/products")).statusCode, 401);
  const reasons = (await c.db.activity.find({ kind: "api_unauthenticated" })).map((e) => e.reason).sort();
  assert.deepEqual([...new Set(reasons)], ["bad_token", "expired", "no_token"]);
  assert.ok((await c.db.activity.find({ kind: "session_ended" })).some((e) => e.userId === sudo.id), "a token without the current session version");
});

test("sign-in throttling: per address and per address+account; failures elsewhere can't lock the owner out; distributed guessing is slowed; inputs bounded", async () => {
  const c = await make();
  for (let i = 0; i < 10; i++) await c.login(OWNER, "wrong", "10.9.0.1");
  assert.equal((await c.login(OWNER, PW, "10.9.0.1")).statusCode, 429, "this address is blocked for this account");
  assert.equal((await c.login(OWNER, PW, "192.168.7.7")).statusCode, 200, "the owner, from their own address, is not locked out");
  for (let i = 0; i < 100; i++) await c.login(OWNER, "wrong", `10.20.${Math.floor(i / 9)}.${i % 9}`);
  assert.equal((await c.login(OWNER, "another-guess", "10.99.0.1")).statusCode, 429, "100 failures from many addresses slow further guessing for this account");
  for (let i = 0; i < 10; i++) await c.login(`nobody${i}@shop.test`, "x", "10.8.0.1");
  assert.equal((await c.login("someone@shop.test", "x", "10.8.0.1")).statusCode, 429, "one address spraying many accounts");
  assert.equal((await c.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "a@b.c", password: "x".repeat(201) } })).statusCode, 400);
  const failed = await c.db.activity.find({ kind: "sign_in_failed" });
  assert.ok(failed.some((e) => e.reason === "bad_password" && e.userId));
  assert.ok(failed.some((e) => e.reason === "unknown_account" && e.userId === null));
  assert.ok(failed.some((e) => e.reason === "throttled"));
  assert.ok(!JSON.stringify(failed).includes("nobody"), "the typed unknown email is never stored");
});

test("password policies: owner-only settings with bounds; applied to staff joins, password changes and the customer set-password page", async () => {
  const c = await make();
  const s = (await c.owner("GET", "/api/security-settings")).json();
  assert.deepEqual(s.passwordPolicy.staff, { minLength: 12, requireClasses: 0, disallowEmail: true, blockCommon: false });
  assert.deepEqual(s.passwordPolicy.customers, { minLength: 10, requireClasses: 0, disallowEmail: false, blockCommon: false });
  const bad = await c.owner("PATCH", "/api/security-settings", { version: s.version, passwordPolicy: { staff: { minLength: 7, requireClasses: 0, disallowEmail: true, blockCommon: false } } });
  assert.equal(bad.statusCode, 400, "the minimum can't go below 8");
  assert.equal((await c.owner("PATCH", "/api/security-settings", { version: s.version, activityRetentionDays: 7 })).statusCode, 400);
  const upd = await c.owner("PATCH", "/api/security-settings", { version: s.version, passwordPolicy: { staff: { minLength: 14, requireClasses: 2, disallowEmail: true, blockCommon: true }, customers: { minLength: 12, requireClasses: 0, disallowEmail: true, blockCommon: true } } });
  assert.equal(upd.statusCode, 200, upd.body);
  assert.equal((await c.owner("PATCH", "/api/security-settings", { version: s.version, activityRetentionDays: 90 })).statusCode, 409);
  const change = (await c.db.audit.find({ entity: "security-settings" }))[0];
  assert.equal((change.before as { passwordPolicy: { staff: { minLength: number } } }).passwordPolicy.staff.minLength, 12);

  const inv = (await c.owner("POST", "/api/staff", { email: "new@shop.test", name: "New" })).json();
  const tooSimple = await c.consume(inv.link.path, "alllowercaseletters");
  assert.deepEqual(tooSimple.json().issues.map((i: { code: string }) => i.code), ["classes"]);
  assert.deepEqual((await c.consume(inv.link.path, "Password2026!!")).json().issues.map((i: { code: string }) => i.code), ["common"]);
  const joined = await c.consume(inv.link.path, "Ceramic Bowls 42");
  assert.equal(joined.statusCode, 200);
  const t = joined.json().token;
  assert.equal((await c.call(t, "POST", "/api/me/password", { current: "wrong", password: "Another Good One 7" })).json().code, "wrong_password");
  assert.equal((await c.call(t, "POST", "/api/me/password", { current: "Ceramic Bowls 42", password: "short" })).json().code, "password_policy");
  assert.equal((await c.call(t, "POST", "/api/me/password", { current: "Ceramic Bowls 42", password: "Ceramic Bowls 42" })).json().code, "same_password");
  const changed = await c.call(t, "POST", "/api/me/password", { current: "Ceramic Bowls 42", password: "Another Good One 7" });
  assert.equal(changed.statusCode, 200);
  assert.equal((await c.call(t, "GET", "/api/me")).statusCode, 401, "other sessions end");
  assert.equal((await c.call(changed.json().token, "GET", "/api/me")).statusCode, 200, "the returned session works");

  // customer page: rules come from the customer policy
  const cust = (await c.owner("POST", "/api/customers", { email: "jonas@b.test", name: "Jonas" })).json();
  const link = (await c.owner("POST", `/api/customers/${cust.id}/links`, { purpose: "activate" })).json();
  const page = await c.app.inject({ method: "GET", url: link.path });
  assert.match(page.body, /At least 12 characters/);
  assert.match(page.body, /minlength="12"/);
  const form = (o: Record<string, string>) => ({ payload: new URLSearchParams(o).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.equal((await c.app.inject({ method: "POST", url: link.path, ...form({ password: "jonas-secret-pw", confirm: "jonas-secret-pw" }) })).statusCode, 400, "contains the email");
  assert.match((await c.app.inject({ method: "POST", url: link.path, ...form({ password: "letmein2024!!", confirm: "letmein2024!!" }) })).body, /too common/);
  assert.equal((await c.app.inject({ method: "POST", url: link.path, ...form({ password: "dune-ceramics-22", confirm: "dune-ceramics-22" }) })).statusCode, 303);
});

test("enforce at next sign-in: a password that no longer meets the policy must be changed before anything else", async () => {
  const c = await make();
  const m = await c.member("old@shop.test", ["catalog.view"]);
  const s = (await c.owner("GET", "/api/security-settings")).json();
  await c.owner("PATCH", "/api/security-settings", { version: s.version, enforceStaffPolicyAtSignIn: true, passwordPolicy: { staff: { minLength: 20, requireClasses: 0, disallowEmail: true, blockCommon: false } } });
  assert.equal((await c.call(m.token, "GET", "/api/products")).statusCode, 200, "open sessions are not affected until the next sign-in");
  const r = await c.login("old@shop.test", "staff-password-1");
  assert.equal(r.json().mustChangePassword, true);
  const t = r.json().token;
  const blocked = await c.call(t, "GET", "/api/products");
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.json().code, "password_change_required");
  assert.equal((await c.call(t, "GET", "/api/me")).json().mustChangePassword, true);
  assert.equal((await c.call(t, "POST", "/api/activity/beacon", { kind: "page_view", path: "/account" })).statusCode, 204);
  const fixed = await c.call(t, "POST", "/api/me/password", { current: "staff-password-1", password: "a much longer passphrase" });
  assert.equal(fixed.statusCode, 200);
  assert.equal((await c.call(fixed.json().token, "GET", "/api/products")).statusCode, 200);
  assert.equal((await c.login("old@shop.test", "a much longer passphrase")).json().mustChangePassword, false);
});

test("sign out everywhere and logout; the beacon takes the user from the token and keeps only the pathname", async () => {
  const c = await make();
  const m = await c.member("vera@shop.test", ["catalog.view"]);
  const b = await c.call(m.token, "POST", "/api/activity/beacon", { kind: "page_view", path: "/customers/123?tab=x#secret-token", feature: "customers", userId: "someone-else" });
  assert.equal(b.statusCode, 400, "no userId field");
  assert.equal((await c.call(m.token, "POST", "/api/activity/beacon", { kind: "page_denied", path: "//customers/123?tab=x#secret-token", feature: "customers", permission: "customers.view" })).statusCode, 204);
  const [e] = await c.db.activity.find({ kind: "page_denied" });
  assert.equal(e.userId, m.id);
  assert.equal(e.path, "/customers/123");
  assert.equal(e.permission, "customers.view");
  assert.equal((await c.call(m.token, "POST", "/api/activity/beacon", { kind: "sign_in", path: "/x" })).statusCode, 400, "only page kinds");
  assert.equal((await c.call(m.token, "POST", "/api/auth/logout")).statusCode, 204);
  assert.equal((await c.db.activity.find({ kind: "sign_out", userId: m.id })).length, 1);
  assert.equal((await c.call(m.token, "POST", "/api/me/sign-out-everywhere")).statusCode, 204);
  assert.equal((await c.call(m.token, "GET", "/api/me")).statusCode, 401);
  let limited = 0;
  const t = (await c.login("vera@shop.test", "staff-password-1")).json().token;
  for (let i = 0; i < 125; i++) if ((await c.call(t, "POST", "/api/activity/beacon", { kind: "page_view", path: "/products" })).statusCode === 429) limited++;
  assert.ok(limited >= 4, "beacons are rate-limited per user");
});

test("activity: query by kind, person, IP, text and time, newest first with a cursor; CSV neutralises formulas; changes link to before/after", async () => {
  const c = await make();
  const m = await c.member("lena@shop.test", ["catalog.view"]);
  await c.call(m.token, "POST", "/api/activity/beacon", { kind: "page_view", path: "/first" }, { "user-agent": "=HYPERLINK(\"http://x\")" });
  for (let i = 0; i < 7; i++) await c.call(m.token, "POST", "/api/activity/beacon", { kind: "page_view", path: `/products/${i}` });
  const page1 = (await c.owner("GET", `/api/activity?kinds=page_view&userId=${m.id}&limit=5`)).json();
  assert.equal(page1.items.length, 5);
  assert.equal(page1.items[0].path, "/products/6", "newest first");
  assert.equal(page1.items[0].userName, "lena");
  const page2 = (await c.owner("GET", `/api/activity?kinds=page_view&userId=${m.id}&limit=5&before=${encodeURIComponent(page1.next)}`)).json();
  assert.equal(page2.items.length, 3);
  assert.equal(page2.next, null);
  assert.equal((await c.owner("GET", "/api/activity?q=products%2F3")).json().items.length, 1);
  assert.equal((await c.owner("GET", "/api/activity?ip=203.0.113.9")).json().items.length, 0);
  assert.equal((await c.owner("GET", `/api/activity?to=${encodeURIComponent(new Date(Date.now() - 3600_000).toISOString())}`)).json().items.length, 0);
  const csv = await c.owner("GET", "/api/activity?kinds=page_view", undefined, { accept: "text/csv" });
  assert.match(csv.headers["content-type"] as string, /text\/csv/);
  assert.match(csv.body, /"'=HYPERLINK/, "a leading = (here in the browser column) can't become a formula");
  const change = (await c.owner("GET", "/api/activity?kinds=change")).json().items.find((e: { entity: string }) => e.entity === "staff-group");
  const full = (await c.owner("GET", `/api/activity/changes/${change.auditId}`)).json();
  assert.equal(full.entity, "staff-group");
  assert.ok(full.after.permissions.includes("catalog.view"));
  // never any secret in the logs
  const logs = JSON.stringify([await c.db.activity.find({}), await c.db.audit.find({})]);
  for (const bad of ["passwordHash", "tokenHash", "staff-password-1", "scrypt$"]) assert.ok(!logs.includes(bad), bad);
  // queries scan in batches when the text filter is selective
  const r = await queryActivity(c.db, { q: "products/0", limit: 1 }, 2);
  assert.ok(r.items.length <= 1);
});

test("activity: 401 floods are aggregated per minute and capped; old events are pruned; a failed log write never fails the request", async () => {
  const store = new SqliteDataStore(":memory:");
  const db = openDb(store);
  const agg = createAggregator(db, 5);
  const at = new Date("2026-03-01T10:00:30Z");
  const fake = (ip: string) => ({ ip, headers: { "user-agent": "scanner" } }) as never;
  for (let i = 0; i < 300; i++) await agg("api_unauthenticated", { path: "/api/orders", reason: "no_token" }, fake("198.51.100.7"), at);
  let rows = await db.activity.find({});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 300);
  for (let i = 0; i < 20; i++) await agg("api_unauthenticated", { path: `/api/x${i}`, reason: "no_token" }, fake("198.51.100.7"), at);
  rows = await db.activity.find({});
  assert.equal(rows.filter((r) => r.kind === "api_unauthenticated").length, 5, "at most `ceiling` new rows per minute");
  assert.equal(rows.find((r) => r.kind === "dropped")?.count, 16);
  await agg("api_unauthenticated", { path: "/api/orders", reason: "no_token" }, fake("198.51.100.7"), new Date("2026-03-01T10:01:10Z"));
  assert.equal((await db.activity.find({ kind: "api_unauthenticated" })).length, 6, "a new minute starts a new row");
  await Promise.all(Array.from({ length: 30 }, () => agg("api_unauthenticated", { path: "/p", reason: "r" }, fake("1.1.1.1"), new Date("2026-03-01T11:00:00Z"))));
  assert.equal((await db.activity.find({ path: "/p" }))[0].count, 30, "parallel increments are atomic");

  await recordActivity(db, "sign_in", { userId: "u" }, undefined, new Date("2020-01-01T00:00:00Z"));
  assert.ok((await pruneActivity(db, 180, Date.parse("2026-03-02T00:00:00Z"))) >= 1);
  assert.equal((await db.activity.find({ userId: "u" })).length, 0);
  assert.ok((await db.activity.count({})) > 0, "recent events stay");

  const broken = { ...db, activity: { ...db.activity, insert: async () => { throw new Error("disk full"); } } } as typeof db;
  const err = console.error; console.error = () => {};
  try { await recordActivity(broken, "sign_in", { userId: "u" }); } finally { console.error = err; }
});

test("lowering retention prunes at once", async () => {
  const c = await make();
  await recordActivity(c.db, "sign_in", { userId: "old" }, undefined, new Date(Date.now() - 100 * 86_400_000));
  const s = (await c.owner("GET", "/api/security-settings")).json();
  assert.equal((await c.owner("PATCH", "/api/security-settings", { version: s.version, activityRetentionDays: 90 })).statusCode, 200);
  assert.equal((await c.db.activity.find({ userId: "old" })).length, 0);
});

test("boot check: an admin route without a declared permission stops the server from starting", async () => {
  const db = openDb(new SqliteDataStore(":memory:"));
  const authz = createAuthorizer(db, "s", createAggregator(db));
  const app = Fastify();
  app.register(async (admin) => {
    authz.guardScope(admin, []);
    admin.get("/api/forgotten", async () => "oops");
  });
  await assert.rejects(async () => { await app.ready(); }, /declares no permission/);
});

test("migration: one legacy user becomes the owner; several keep full access through a migrated group; idempotent", async () => {
  const legacy = async (emails: string[]) => {
    const db = openDb(new SqliteDataStore(":memory:"));
    for (const e of emails) await db.users.insert({ email: e, passwordHash: await hashPassword("pw-123456") } as unknown as User);
    return db;
  };
  const one = await legacy(["solo@shop.test"]);
  await migrateIam(one);
  const [solo] = await one.users.find({});
  assert.equal(solo.sudo, true);
  assert.equal(solo.status, "active");
  assert.equal(solo.name, "solo");
  assert.equal((await one.staffGroups.count()), 0);
  assert.equal((await one.staffEmails.get("solo@shop.test"))?.userId, solo.id);

  const three = await legacy(["a@shop.test", "boss@shop.test", "c@shop.test"]);
  await migrateIam(three, { adminEmail: "Boss@Shop.test" });
  await migrateIam(three, { adminEmail: "Boss@Shop.test" });
  const users = await three.users.find({}, { sort: { email: 1 } });
  assert.deepEqual(users.map((u) => u.sudo), [false, true, false]);
  const groups = await three.staffGroups.find({});
  assert.equal(groups.length, 1, "idempotent");
  assert.equal(groups[0].permissions.length, 17);
  assert.equal((await three.staffMemberships.count()), 2);
  assert.ok((await three.audit.find({ action: "migrate" })).length === 1);

  const warn = console.warn; let warned = ""; console.warn = (m: string) => { warned = m; };
  try {
    const noMatch = await legacy(["x@shop.test", "y@shop.test"]);
    await migrateIam(noMatch, { adminEmail: "nobody@shop.test" });
    assert.match(warned, /x@shop\.test became the owner/);
    // through the app: an old pre-upgrade token is refused and the old password still works
    const store = new SqliteDataStore(":memory:");
    const db = openDb(store);
    await db.users.insert({ email: "old@shop.test", passwordHash: await hashPassword("pw-123456") } as unknown as User);
    const app = buildApp(store, { authSecret: SECRET });
    const id = (await db.users.find({}))[0].id;
    assert.equal((await app.inject({ method: "GET", url: "/api/products", headers: { authorization: `Bearer ${signToken(id, SECRET)}` } })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "old@shop.test", password: "pw-123456" } })).statusCode, 200);
  } finally { console.warn = warn; }
});

test("ADMIN_PASSWORD is fenced to the owner: creates on first run, resets only the owner's password, never a second owner", async () => {
  const db = openDb(new SqliteDataStore(":memory:"));
  assert.equal(await ensureAdmin(db, "Owner@Shop.test", "first-password-1"), "created");
  assert.equal(await ensureAdmin(db, "owner@shop.test", "first-password-1"), "unchanged");
  const before = (await db.users.find({ sudo: true }))[0].sessionVersion;
  assert.equal(await ensureAdmin(db, "owner@shop.test", "second-password"), "reset");
  assert.equal((await db.users.find({ sudo: true }))[0].sessionVersion, before + 1, "a reset ends the owner's sessions");
  const warn = console.warn; console.warn = () => {};
  try { assert.equal(await ensureAdmin(db, "intruder@shop.test", "x-password-123"), "ignored"); } finally { console.warn = warn; }
  assert.equal(await db.users.count(), 1);
  const legacyDb = openDb(new SqliteDataStore(":memory:"));
  await legacyDb.users.insert({ email: "a@b.c", passwordHash: "x" } as unknown as User);
  await assert.rejects(() => ensureAdmin(legacyDb, "a@b.c", "pw"), /migrateIam first/);
  await createSudo(db, "second@shop.test", "pw-123456789"); // direct call (first-run path in main.ts) reserves its email
  assert.ok(await db.staffEmails.get("second@shop.test"));
});

test("password hashes: versioned scrypt format; older salt:hash hashes still verify; corrupt or hostile values are refused", async () => {
  const h = await hashPassword("hello world 1");
  assert.match(h, /^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.ok(await verifyPassword("hello world 1", h));
  assert.ok(!(await verifyPassword("hello world 2", h)));
  const salt = randomBytes(16);
  const legacy = `${salt.toString("hex")}:${scryptSync("old-pw", salt, 64).toString("hex")}`;
  assert.ok(await verifyPassword("old-pw", legacy));
  for (const bad of ["", "00:00", "nohash", "scrypt$99999999$8$1$aa$bb", "scrypt$16384$8$1$aa$", "scrypt$1000$8$1$aa$bb"]) assert.equal(await verifyPassword("x", bad), false, bad);
});

test("team CSV: one row per member with status, groups and effective permissions (owner: all); 406 for other types", async () => {
  const c = await make();
  await c.member("pat@shop.test", ["orders.fulfil"]);
  const csv = await c.owner("GET", "/api/staff", undefined, { accept: "text/csv" });
  assert.match(csv.headers["content-type"] as string, /text\/csv/);
  const lines = csv.body.replace(/^\uFEFF/, "").trim().split("\r\n");
  assert.equal(lines[0], "name,email,status,owner,groups,permissions,last sign-in,invited");
  assert.match(lines.find((l) => l.startsWith("owner,"))!, /,active,yes,,All permissions,/);
  assert.match(lines.find((l) => l.startsWith("pat,"))!, /,active,,G pat@shop\.test,See orders; Mark orders as shipped,/);
  assert.equal((await c.owner("GET", "/api/staff", undefined, { accept: "image/png" })).statusCode, 406);
  assert.equal((await c.owner("GET", "/api/activity", undefined, { accept: "image/png" })).statusCode, 406);
});

test("activity search pages through batches: matches beyond the first 500 rows are found, and a scan cap returns a cursor", async () => {
  const db = openDb(new SqliteDataStore(":memory:"));
  const t0 = Date.parse("2026-05-01T00:00:00Z");
  for (let i = 0; i < 1300; i++) await recordActivity(db, "page_view", { userId: "u", path: i % 400 === 0 ? `/needle/${i}` : `/products/${i}` }, undefined, new Date(t0 + i * 1000));
  const all = await queryActivity(db, { q: "needle", limit: 10 });
  assert.deepEqual(all.items.map((e) => e.path), ["/needle/1200", "/needle/800", "/needle/400", "/needle/0"]);
  assert.equal(all.next, null);
  const capped = await queryActivity(db, { q: "needle", limit: 10 }, 500);
  assert.deepEqual(capped.items.map((e) => e.path), ["/needle/1200", "/needle/800"]);
  assert.ok(capped.next, "a cursor to continue from");
  const rest = await queryActivity(db, { q: "needle", limit: 10, before: capped.next! });
  assert.deepEqual(rest.items.map((e) => e.path), ["/needle/400", "/needle/0"]);
  const kinds = await queryActivity(db, { kinds: ["sign_in"], limit: 5 });
  assert.equal(kinds.items.length, 0);
});

test("record history (/api/audit) is paged and filterable: every entry reachable exactly once, even with equal timestamps and new entries while paging", async () => {
  const c = await make();
  const g = (await c.owner("POST", "/api/staff-groups", { name: "G", permissions: [] })).json();
  for (let v = 1; v <= 220; v++) await c.owner("PATCH", `/api/staff-groups/${g.id}`, { description: `v${v}`, version: v });
  // 30 entries with the very same timestamp (the hard case for a time-based cursor)
  const at = "2026-01-01T00:00:00.000Z";
  for (let i = 0; i < 30; i++) await c.db.audit.insert({ at, userId: "system", action: "import", entity: "staff-group", entityId: g.id });
  const seen: string[] = [];
  let next: string | null = null, pages = 0, first: { items: { id: string; at: string; userName: string | null }[] } | null = null;
  do {
    const r = await c.owner("GET", `/api/audit?entity=staff-group&id=${g.id}&limit=40${next ? `&before=${next}` : ""}`);
    assert.equal(r.statusCode, 200);
    const body = r.json();
    first ??= body;
    seen.push(...body.items.map((e: { id: string }) => e.id));
    next = body.next; pages++;
    if (pages === 2) await c.owner("PATCH", `/api/staff-groups/${g.id}`, { description: "meanwhile", version: 221 }); // newer entries don't shift pages
  } while (next);
  assert.equal(seen.length, 251, "220 updates + 1 create + 30 equal-time imports, no more, no less");
  assert.equal(new Set(seen).size, seen.length, "no duplicates");
  assert.equal(pages, 7);
  assert.equal(first!.items[0].userName, "owner", "who did it");
  const all = await c.db.audit.find({ entity: "staff-group", entityId: g.id });
  assert.equal(all.length, 252);
  // filters: action, person, time range; limit capped at 200
  assert.equal((await c.owner("GET", `/api/audit?entity=staff-group&id=${g.id}&action=import&limit=200`)).json().items.length, 30);
  assert.equal((await c.owner("GET", `/api/audit?entity=staff-group&id=${g.id}&userId=system&limit=200`)).json().items.length, 30);
  assert.equal((await c.owner("GET", `/api/audit?entity=staff-group&id=${g.id}&to=2026-06-01T00:00:00Z&limit=200`)).json().items.length, 30);
  assert.equal((await c.owner("GET", `/api/audit?entity=staff-group&id=${g.id}&from=2026-06-01T00:00:00Z&limit=500`)).json().items.length, 200);
  const ranged = (await c.owner("GET", `/api/audit?entity=staff-group&id=${g.id}&to=2026-06-01T00:00:00Z&limit=20`)).json();
  assert.equal((await c.owner("GET", `/api/audit?entity=staff-group&id=${g.id}&to=2026-06-01T00:00:00Z&limit=20&before=${ranged.next}`)).json().items.length, 10, "paging inside a time range");
  assert.equal((await c.owner("GET", `/api/audit?entity=staff-group&id=${g.id}&before=garbage&limit=5`)).json().items.length, 5, "a broken cursor starts from the newest");
  // CSV from the same URL, formulas neutralised; permission scoping unchanged
  const csv = await c.owner("GET", `/api/audit?entity=staff-group&id=${g.id}`, undefined, { accept: "text/csv" });
  assert.match(String(csv.headers["content-type"]), /text\/csv/);
  assert.equal(csv.body.trim().split("\r\n").length, 253, "header + every entry");
  assert.equal((await c.owner("GET", "/api/audit", undefined, { accept: "image/png" })).statusCode, 406);
  const m = await c.member("m@shop.test", ["discounts.view"]);
  assert.equal((await c.call(m.token, "GET", `/api/audit?entity=staff-group&id=${g.id}`)).statusCode, 403);
  assert.equal((await c.call(m.token, "GET", "/api/audit?entity=discount")).statusCode, 200);
});

test("owner routes: unknown ids are 404 only after the permission check; blank names; reset links only for joined members", async () => {
  const c = await make();
  const m = await c.member("pat@shop.test", ["orders.view"]);
  const g = (await c.owner("POST", "/api/staff-groups", { name: "G", permissions: [] })).json();
  const missing: [Method, string, unknown?][] = [
    ["GET", "/api/staff/nope"], ["PATCH", "/api/staff/nope", { version: 1, name: "x" }], ["PUT", "/api/staff/nope/groups", { groupIds: [] }],
    ["POST", "/api/staff/nope/links", { purpose: "reset" }], ["POST", "/api/staff/nope/links/revoke"], ["POST", "/api/staff/nope/suspend"],
    ["DELETE", "/api/staff/nope"], ["POST", "/api/staff/nope/restore"], ["GET", "/api/staff-groups/nope"], ["PATCH", "/api/staff-groups/nope", { version: 1 }],
    ["DELETE", "/api/staff-groups/nope"], ["POST", "/api/staff-groups/nope/members", { add: [] }], ["GET", "/api/activity/changes/nope"],
  ];
  for (const [method, url, body] of missing) {
    assert.equal((await c.owner(method, url, body)).statusCode, 404, `${method} ${url}`);
    assert.equal((await c.call(m.token, method, url, body)).statusCode, 403, `a member learns nothing: ${method} ${url}`);
  }
  assert.equal((await c.owner("POST", "/api/staff", { email: "x@shop.test", name: "   " })).statusCode, 400);
  assert.equal((await c.owner("PATCH", `/api/staff/${m.id}`, { version: 1, name: "  " })).statusCode, 400);
  assert.equal((await c.owner("POST", "/api/staff-groups", { name: "  ", permissions: [] })).statusCode, 400);
  assert.equal((await c.owner("PATCH", `/api/staff-groups/${g.id}`, { version: 1, name: " " })).statusCode, 400);
  const patched = await c.owner("PATCH", `/api/staff-groups/${g.id}`, { version: 1, template: "finance" });
  assert.equal(patched.json().template, "finance");
  const invited = (await c.owner("POST", "/api/staff", { email: "ivy@shop.test", name: "Ivy" })).json();
  assert.equal((await c.owner("POST", `/api/staff/${invited.member.id}/links`, { purpose: "reset" })).json().code, "not_active", "invited members get invitations, not resets");
  await c.owner("DELETE", `/api/staff/${m.id}`);
  assert.equal((await c.owner("POST", `/api/staff/${m.id}/links`, { purpose: "reset" })).statusCode, 409, "no reset link for a removed member");
});

test("size caps bound what an owner session can create: 200 staff, 50 groups", async () => {
  const c = await make();
  const at = new Date().toISOString();
  for (let i = 0; i < 199; i++) await c.db.users.insert({ email: `s${i}@shop.test`, name: "S", passwordHash: null, status: "invited", sudo: false, sessionVersion: 0, version: 1, createdAt: at, createdBy: null, activatedAt: null, lastLoginAt: null });
  const r = await c.owner("POST", "/api/staff", { email: "one-more@shop.test", name: "One more" });
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, "limit");
  const removed = (await c.db.users.find({ email: "s0@shop.test" }))[0];
  await c.db.users.update(removed.id, { status: "removed" });
  assert.equal((await c.owner("POST", "/api/staff", { email: "one-more@shop.test", name: "One more" })).statusCode, 201, "removed members don't count");
  const other = (await c.db.users.find({ email: "s1@shop.test" }))[0];
  await c.db.users.update(other.id, { status: "removed" });
  await c.db.users.update(removed.id, { status: "removed" });
  assert.equal((await c.owner("POST", `/api/staff/${removed.id}/restore`)).statusCode, 200);
  assert.equal((await c.owner("POST", `/api/staff/${other.id}/restore`)).json().code, "limit", "restoring is capped too");
  for (let i = 0; i < 50; i++) await c.db.staffGroups.insert({ name: `g${i}`, description: "", permissions: [], template: null, createdAt: at, updatedAt: at, createdBy: "x", version: 1 });
  assert.equal((await c.owner("POST", "/api/staff-groups", { name: "51st", permissions: [] })).json().code, "limit");
});

test("a failed invitation rolls back (the email is free again); absolute links with BACKOFFICE_URL", async () => {
  const store = new SqliteDataStore(":memory:");
  await ensureAdmin(openDb(store), OWNER, PW);
  const app = buildApp(store, { authSecret: SECRET, backofficeUrl: "https://admin.shop.test" });
  const token = (await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: OWNER, password: PW } })).json().token;
  const invite = () => app.inject({ method: "POST", url: "/api/staff", headers: { authorization: `Bearer ${token}` }, payload: { email: "lena@shop.test", name: "Lena" } });
  // make the next insert into "users" fail once
  const probe = openDb(store).users as unknown as { table: string; insert: (d: object) => Promise<unknown> };
  const proto = Object.getPrototypeOf(probe) as { insert: (this: { table: string }, d: object) => Promise<unknown> };
  const original = proto.insert;
  let fail = true;
  proto.insert = function (d) { if (this.table === "users" && fail) { fail = false; throw new Error("disk full"); } return original.call(this, d); };
  try { assert.equal((await invite()).statusCode, 500); } finally { proto.insert = original; }
  assert.equal(await openDb(store).staffEmails.get("lena@shop.test"), null, "the email reservation was released");
  const ok = await invite();
  assert.equal(ok.statusCode, 201, "so the invitation can be retried");
  assert.match(ok.json().link.url, /^https:\/\/admin\.shop\.test\/join#[A-Za-z0-9_-]{43}$/);
});

test("throttles: using links and guessing one's current password", async () => {
  const c = await make();
  const codes: number[] = [];
  for (let i = 0; i < 31; i++) codes.push((await c.app.inject({ method: "POST", url: "/api/auth/links/consume", payload: { token: `nope${i}`.padEnd(40, "x"), password: "whatever-long-1" }, remoteAddress: "10.77.0.1" })).statusCode);
  assert.equal(codes[29], 410);
  assert.equal(codes[30], 429);
  const m = await c.member("pat@shop.test", ["orders.view"]);
  const tries: number[] = [];
  for (let i = 0; i < 6; i++) tries.push((await c.call(m.token, "POST", "/api/me/password", { current: "wrong", password: "a new long passphrase" })).statusCode);
  assert.deepEqual(tries, [400, 400, 400, 400, 400, 429]);
  assert.equal((await queryActivity(c.db, { from: new Date(Date.now() + 60_000).toISOString() })).items.length, 0, "time range filter");
});

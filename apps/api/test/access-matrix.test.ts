// The access matrix of docs/iam-plan-v2.md §2.12, run against the real API: every functionality (row) × every persona.
// Personas are created through the real flows (owner invites → link → password). The same JSON drives the browser
// test (scripts/e2e-access.py) and the demo seed. A report is written to test/out/access-report.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteDataStore } from "@openshop/db";
import { FEATURES, PERMISSION_IDS, requirementIds, satisfies, TEMPLATES, effective, type Requirement } from "@openshop/iam";
import { buildApp } from "../src/app.ts";
import { ensureAdmin } from "../src/auth.ts";
import { openDb } from "../src/types.ts";

interface Req { method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; url: string; status: number; body?: unknown; png?: boolean; accept?: string; adoptToken?: boolean; relogin?: boolean }
interface Row { id: string; label: string; needs: Requirement; allowed: string[]; api: Req[] }
interface Persona { id: string; name: string; email: string; sudo?: boolean; groups: string[]; state?: "invited" | "suspended" | "removed" }
const M = JSON.parse(readFileSync(new URL("./access-matrix.json", import.meta.url), "utf8")) as { password: string; personas: Persona[]; rows: Row[]; menus: Record<string, string[]>; screens: { path: string; allowed: string[] }[] };
const ACTIVE = M.personas.filter((p) => !p.state);
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000000020001e221bc330000000049454e44ae426082", "hex");

const permsOf = (p: Persona) => effective({ sudo: !!p.sudo }, p.groups.map((g) => TEMPLATES.find((t) => t.id === g)!));
const principal = (p: Persona) => ({ sudo: !!p.sudo, perms: permsOf(p) });

test("the matrix agrees with the permission model, the feature registry and the route list", async () => {
  // 'allowed' (the reviewed expectation) must equal what the rule ('needs') gives for each persona's groups.
  for (const row of M.rows) {
    const computed = ACTIVE.filter((p) => satisfies(principal(p), row.needs)).map((p) => p.id);
    assert.deepEqual([...row.allowed].sort(), computed.sort(), `${row.id} ${row.label}`);
  }
  // Every permission makes the difference somewhere.
  const named = new Set(M.rows.flatMap((r) => requirementIds(r.needs)));
  for (const p of PERMISSION_IDS) assert.ok(named.has(p), `no matrix row exercises ${p}`);
  // The expected menus are what the feature registry shows each persona.
  for (const p of ACTIVE) {
    const menu = [...FEATURES.filter((f) => f.menu === "main"), ...FEATURES.filter((f) => f.menu === "foot")].filter((f) => satisfies(principal(p), f.perm)).map((f) => f.label);
    assert.deepEqual(menu, M.menus[p.id], `menu of ${p.id}`);
  }
  // The screens the browser test opens for each persona: allowed = what the registry's route permission gives.
  for (const sc of M.screens) {
    const route = FEATURES.flatMap((f) => f.routes).find((r) => `/${r.path}` === sc.path);
    assert.ok(route, `no registry route for ${sc.path}`);
    assert.deepEqual(sc.allowed, ACTIVE.filter((p) => satisfies(principal(p), route!.perm)).map((p) => p.id), sc.path);
  }
  // Every admin route is exercised by at least one row.
  const app = buildApp(new SqliteDataStore(":memory:"), { authSecret: "x" });
  await app.ready();
  const pattern = (u: string) => u.split("?")[0].replace(/\{[^}]+\}|:[A-Za-z]+/g, ":p");
  const covered = new Set(M.rows.flatMap((r) => r.api.map((a) => `${a.method} ${pattern(a.url)}`)));
  const missing = app.adminRoutes.filter((r) => !covered.has(`${r.method} ${pattern(r.url)}`)).map((r) => `${r.method} ${r.url}`);
  assert.deepEqual(missing, [], "admin routes not covered by the matrix");
  assert.equal(app.adminRoutes.length, new Set(app.adminRoutes.map((r) => `${r.method} ${r.url}`)).size);
  await app.close();
});

test("access matrix: every row × every persona against the API", async (t) => {
  const store = new SqliteDataStore(":memory:");
  const db = openDb(store);
  const owner = M.personas.find((p) => p.sudo)!;
  await ensureAdmin(db, owner.email, M.password);
  const app = buildApp(store, { authSecret: "matrix-secret", uploadDir: mkdtempSync(join(tmpdir(), "up-")), activityCeiling: 100_000 }); // every refusal of the matrix must be logged
  const login = async (email: string, password = M.password) => app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password }, remoteAddress: `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
  const sudoToken = (await login(owner.email)).json().token as string;
  const as = (token: string) => ({ authorization: `Bearer ${token}` });
  const sudo = async (method: Req["method"], url: string, payload?: unknown) => {
    const r = await app.inject({ method, url, headers: as(sudoToken), ...(payload !== undefined ? { payload: payload as object } : {}) });
    assert.ok(r.statusCode < 300, `${method} ${url}: ${r.statusCode} ${r.body}`);
    return r.statusCode === 204 ? null : r.json();
  };

  // Groups from the templates, then each persona through the real invite flow.
  const groupIds: Record<string, string> = {};
  for (const tpl of TEMPLATES) groupIds[tpl.id] = (await sudo("POST", "/api/staff-groups", { name: tpl.name, permissions: tpl.permissions, template: tpl.id })).id;
  const tokens: Record<string, string> = { [owner.id]: sudoToken };
  const join_ = async (path: string) => (await app.inject({ method: "POST", url: "/api/auth/links/consume", payload: { token: path.split("#")[1], password: M.password } })).json().token as string;
  for (const p of M.personas.filter((x) => !x.sudo)) {
    const inv = await sudo("POST", "/api/staff", { email: p.email, name: p.name, groupIds: p.groups.map((g) => groupIds[g]) });
    if (p.state === "invited") continue;
    tokens[p.id] = await join_(inv.link.path);
    if (p.state === "suspended") await sudo("POST", `/api/staff/${inv.member.id}/suspend`);
    if (p.state === "removed") await sudo("DELETE", `/api/staff/${inv.member.id}`);
  }

  // Shared fixtures, and fresh ones created per case for destructive actions.
  const product = (await sudo("POST", "/api/products", { name: "Matrix bowl", price: 20, stock: 100000 })).id as string;
  const customer = (await sudo("POST", "/api/customers", { email: "priya@buyer.test", name: "Priya" })).id as string;
  const discount = (await sudo("POST", "/api/discounts", { name: "Shop-wide 10%", label: "10% off", effect: { type: "percent", bp: 1000 }, status: "paused" })).id as string;
  const voucher = (await sudo("POST", "/api/discounts", { name: "Codes", label: "Code offer", trigger: "code", effect: { type: "percent", bp: 500 } })).id as string;
  const profile = (await sudo("POST", "/api/discount-profiles", { name: "Trade", publicLabel: "Trade price" })).id as string;
  await sudo("POST", `/api/discounts/${voucher}/codes`, { generate: 1, assignedCustomerId: customer }); // a personal code: its list names a customer
  const placeOrder = async () => (await app.inject({ method: "POST", url: "/api/shop/orders", payload: { items: [{ productId: product, qty: 1 }], customer: { name: "Buyer", email: "buyer@buyer.test", address: "1 Road" } } })).json().id as string;
  let n = 0;
  const uniq = () => `${Date.now().toString(36)}${(n++).toString(36)}`;
  const fresh: Record<string, () => Promise<string>> = {
    product: async () => (await sudo("POST", "/api/products", { name: `Fresh ${uniq()}`, price: 5 })).id,
    // Products are never removed: only a hidden product can be deleted (soft delete), and a deleted one restored.
    hiddenProduct: async () => (await sudo("POST", "/api/products", { name: `Hidden ${uniq()}`, price: 5, active: false })).id,
    deletedProduct: async () => { const id = (await sudo("POST", "/api/products", { name: `Gone ${uniq()}`, price: 5, active: false })).id; await sudo("DELETE", `/api/products/${id}`); return id; },
    category: async () => (await sudo("POST", "/api/categories", { name: "Fresh", slug: `fresh-${uniq()}` })).id,
    order: placeOrder,
    cancelledOrder: async () => { const id = await placeOrder(); await sudo("PATCH", `/api/orders/${id}`, { status: "cancelled" }); return id; },
    customer: async () => (await sudo("POST", "/api/customers", { email: `fresh-${uniq()}@buyer.test`, name: "Fresh" })).id,
    discount: async () => (await sudo("POST", "/api/discounts", { name: `Fresh ${uniq()}`, label: "Fresh", effect: { type: "percent", bp: 100 }, status: "paused" })).id,
    profile: async () => (await sudo("POST", "/api/discount-profiles", { name: `Fresh ${uniq()}`, publicLabel: "Fresh" })).id,
    page: async () => (await sudo("POST", "/api/pages", { slug: `fresh-${uniq()}`, title: "Fresh", nodes: [] })).id,
    code: async () => (await sudo("POST", `/api/discounts/${voucher}/codes`, { code: `FRESH${uniq().toUpperCase()}`.slice(0, 20) })).items[0],
    group: async () => (await sudo("POST", "/api/staff-groups", { name: `Fresh ${uniq()}`, permissions: [] })).id,
    member: async () => { const inv = await sudo("POST", "/api/staff", { email: `fresh-${uniq()}@staff.test`, name: "Fresh member" }); await join_(inv.link.path); return inv.member.id; },
  };

  /** Fills placeholders; values are URL-encoded in URLs (encode = true) and raw in bodies. */
  async function resolve(v: unknown, cache: Map<string, string>, persona: Persona, encode = true): Promise<unknown> {
    if (Array.isArray(v)) return Promise.all(v.map((x) => resolve(x, cache, persona, encode)));
    if (v && typeof v === "object") return Object.fromEntries(await Promise.all(Object.entries(v).map(async ([k, x]) => [k, await resolve(x, cache, persona, encode)])));
    if (typeof v !== "string") return v;
    if (v === "{securityVersion}") return (await db.security.get("security"))?.version ?? 1;
    let out = v;
    for (const m of v.match(/\{[^}]+\}/g) ?? []) {
      const key = m.slice(1, -1);
      let val: string;
      if (key === "uniq") val = uniq();
      else if (key === "password") val = M.password;
      else if (key === "auditEntry") val = (await db.audit.find({}, { sort: { at: -1 }, limit: 1 }))[0].id;
      else if (key.startsWith("fresh.")) { if (!cache.has(key)) cache.set(key, await fresh[key.slice(6)]()); val = cache.get(key)!; }
      else val = ({ product, customer, discount, voucher, profile } as Record<string, string>)[key];
      assert.ok(val !== undefined, `unknown placeholder ${m}`);
      out = out.replace(m, encode ? encodeURIComponent(val) : val);
    }
    return out;
  }
  const resolveBody = (v: unknown, cache: Map<string, string>, p: Persona) => resolve(v, cache, p, false);

  const results: Record<string, Record<string, "ok" | string>> = {};
  // 403s are counted per minute (member × route × permission), so add up the counts.
  const deniedCount = async (userId: string) => (await db.activity.find({ kind: "api_denied", userId })).reduce((n, e) => n + (e.count ?? 1), 0);
  // Response scans: never a secret; never a customer's email for someone who may see neither customers nor orders.
  const SECRETS = ["passwordHash", "tokenHash", "scrypt$", "sessionVersion"];
  const seesCustomerData = (p: Persona) => !!p.sudo || permsOf(p).has("customers.view") || permsOf(p).has("orders.view");
  const idOf = async (p: Persona) => (await db.users.find({ email: p.email }))[0]?.id;

  for (const row of M.rows) {
    results[row.id] = {};
    await t.test(`${row.id} ${row.label}`, async (rt) => {
      for (const p of M.personas) {
        await rt.test(p.id, async () => {
          const allowed = row.allowed.includes(p.id);
          const cache = new Map<string, string>();
          const problems: string[] = [];
          const uid = await idOf(p);
          const deniedBefore = uid ? await deniedCount(uid) : 0;
          for (const a of row.api) {
            const url = (await resolve(a.url, cache, p)) as string;
            const payload = a.png ? PNG : a.body !== undefined ? await resolveBody(a.body, cache, p) : undefined;
            const headers: Record<string, string> = { ...(tokens[p.id] ? as(tokens[p.id]) : {}), ...(a.png ? { "content-type": "image/png" } : {}), ...(a.accept ? { accept: a.accept } : {}) };
            const r = await app.inject({ method: a.method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
            const want = p.state ? 401 : allowed ? a.status : 403;
            if (r.statusCode !== want) problems.push(`${a.method} ${url}: ${r.statusCode} (expected ${want}) ${r.body.slice(0, 160)}`);
            for (const s of SECRETS) if (r.body.includes(s)) problems.push(`${a.method} ${url}: response contains ${s}`);
            if (!seesCustomerData(p) && r.body.includes("@buyer.test")) problems.push(`${a.method} ${url}: customer email shown without customers.view / orders.view`);
            if (allowed && !p.state && a.adoptToken && r.statusCode === 200) tokens[p.id] = r.json().token;
            if (allowed && !p.state && a.relogin) tokens[p.id] = (await login(p.email)).json().token;
          }
          if (p.state) {
            const s = await login(p.email);
            if (s.statusCode !== 401 && s.statusCode !== 429) problems.push(`sign-in of a ${p.state} member: ${s.statusCode}`);
          } else if (!allowed && uid && (await deniedCount(uid)) <= deniedBefore) problems.push("no api_denied event recorded");
          results[row.id][p.id] = problems.length ? problems.join("; ") : "ok";
          assert.deepEqual(problems, []);
        });
      }
    });
  }

  // Refused sign-ins of invited, suspended and removed members are in the activity log with their reason.
  const reasons = (await db.activity.find({ kind: "sign_in_failed" })).map((e) => e.reason);
  for (const r of ["invited", "suspended", "removed"]) assert.ok(reasons.includes(r), `sign_in_failed ${r}`);
  assert.ok((await db.activity.count({ kind: "session_ended" })) > 0, "old tokens of suspended/removed members are logged as session_ended");

  // Report: expected vs actual, per row and persona.
  const head = `| # | Functionality | ${M.personas.map((p) => p.id).join(" | ")} |\n|---|---|${M.personas.map(() => "---").join("|")}|\n`;
  const body = M.rows.map((r) => `| ${r.id} | ${r.label} | ${M.personas.map((p) => {
    const exp = p.state ? "—" : r.allowed.includes(p.id) ? "✓" : "—";
    return results[r.id][p.id] === "ok" ? exp : `**${exp} ✗**`;
  }).join(" | ")} |`).join("\n");
  const failures = Object.entries(results).flatMap(([r, m]) => Object.entries(m).filter(([, v]) => v !== "ok").map(([p, v]) => `- ${r} × ${p}: ${v}`));
  const out = new URL("./out/", import.meta.url);
  mkdirSync(out, { recursive: true });
  writeFileSync(new URL("access-report.md", out), `# Access matrix report\n\n${new Date().toISOString()} — ${M.rows.length} rows × ${M.personas.length} personas, ${M.rows.reduce((s, r) => s + r.api.length, 0)} requests per persona.\n✓ allowed, — refused (403; 401 for invited/suspended/removed). **✗** = actual differs from expected.\n\n${head}${body}\n\n${failures.length ? `## Mismatches\n${failures.join("\n")}\n` : "All cells match.\n"}`);
  await app.close();
});

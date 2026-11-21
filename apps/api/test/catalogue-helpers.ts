import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteDataStore } from "@openshop/db";
import { buildApp, type AppOptions } from "../src/app.ts";
import { ensureAdmin } from "../src/auth.ts";
import { openDb } from "../src/types.ts";

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** An app on an in-memory database, signed in as an admin. */
export async function make(opts: AppOptions = {}) {
  const store = new SqliteDataStore(":memory:");
  const db = openDb(store);
  await ensureAdmin(db, "admin@test.io", "pw-123456");
  const uploadDir = opts.uploadDir ?? mkdtempSync(join(tmpdir(), "up-"));
  const app = buildApp(store, { authSecret: "catalogue-secret", uploadDir, ...opts });
  const token = (await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@test.io", password: "pw-123456" } })).json().token;
  const h = { authorization: `Bearer ${token}` };
  const api = (method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url, headers: { ...h, ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const product = async (body: Record<string, unknown>) => {
    const r = await api("POST", "/api/products", { price: 10, stock: 10, ...body });
    if (r.statusCode !== 201) throw new Error(`product not created: ${r.statusCode} ${r.body}`);
    return r.json();
  };
  const attribute = async (body: Record<string, unknown>) => {
    const r = await api("POST", "/api/attributes", { visibility: "public", ...body });
    if (r.statusCode !== 201) throw new Error(`property not created: ${r.statusCode} ${r.body}`);
    return r.json();
  };
  return { app, db, api, h, product, attribute, uploadDir };
}

export const form = (o: Record<string, string>, cookie?: string) => ({
  payload: new URLSearchParams(o).toString(),
  headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
});

export const cookieOf = (r: { headers: Record<string, unknown> }, name: string) => {
  const all = ([] as string[]).concat((r.headers["set-cookie"] as string | string[]) ?? []);
  const c = all.find((x) => x.startsWith(`${name}=`));
  return c ? c.split(";")[0] : "";
};

/** A customer with an activated account, signed in: returns the session cookie. */
export async function signedInCustomer(c: Awaited<ReturnType<typeof make>>, email: string, name = "Ann") {
  const cust = (await c.api("POST", "/api/customers", { email, name, address: "1 Road" })).json();
  const link = (await c.api("POST", `/api/customers/${cust.id}/links`, { purpose: "activate" })).json();
  const set = await c.app.inject({ method: "POST", url: link.path, ...form({ password: "correct horse battery", confirm: "correct horse battery" }) });
  if (set.statusCode !== 303) throw new Error(`activation failed: ${set.statusCode} ${set.body}`);
  return { customer: cust, cookie: cookieOf(set, "cs") };
}

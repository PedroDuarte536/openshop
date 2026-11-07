import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteDataStore } from "@openshop/db";
import { buildApp } from "../src/app.ts";

const make = () => buildApp(new SqliteDataStore(":memory:"));

test("products CRUD with validation", async () => {
  const app = make();
  const bad = await app.inject({ method: "POST", url: "/api/products", payload: { name: "" } });
  assert.equal(bad.statusCode, 400);
  const created = await app.inject({ method: "POST", url: "/api/products", payload: { name: "Mug", price: 9.5 } });
  assert.equal(created.statusCode, 201);
  const { id } = created.json();
  const patched = await app.inject({ method: "PATCH", url: `/api/products/${id}`, payload: { price: 12 } });
  assert.equal(patched.json().price, 12);
  assert.equal((await app.inject({ method: "GET", url: "/api/products" })).json().length, 1);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/products/${id}` })).statusCode, 204);
  assert.equal((await app.inject({ method: "GET", url: `/api/products/${id}` })).statusCode, 404);
});

test("pages render html on save and are served statically", async () => {
  const app = make();
  const res = await app.inject({ method: "POST", url: "/api/pages", payload: { slug: "home", title: "Home", blocks: [{ type: "heading", text: "Welcome" }] } });
  assert.equal(res.statusCode, 201);
  assert.match(res.json().html, /<h2>Welcome<\/h2>/);
  const dup = await app.inject({ method: "POST", url: "/api/pages", payload: { slug: "home", title: "x", blocks: [] } });
  assert.equal(dup.statusCode, 409);
  const served = await app.inject({ method: "GET", url: "/s/home" });
  assert.equal(served.statusCode, 200);
  assert.match(served.headers["content-type"] as string, /text\/html/);
  assert.match(served.body, /Welcome/);
  assert.equal((await app.inject({ method: "GET", url: "/s/nope" })).statusCode, 404);
  const invalid = await app.inject({ method: "POST", url: "/api/pages", payload: { slug: "bad", title: "x", blocks: [{ type: "nope" }] } });
  assert.equal(invalid.statusCode, 400);
});

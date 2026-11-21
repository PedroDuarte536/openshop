// Catalogue foundations (plan P0): validation, the public projection, versioned and audited writes, SKUs, and the
// product lifecycle (products are never removed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { make, form } from "./catalogue-helpers.ts";

test("product fields are validated: cents, bounds, unknown fields, control characters", async () => {
  const { api, product } = await make();
  for (const [body, field] of [
    [{ name: "A", price: 10.129 }, "price"], [{ name: "A", price: 1e300 }, "price"], [{ name: "A", price: -1 }, "price"],
    [{ name: "A", price: 1, stock: 1.5 }, "stock"], [{ name: "A", price: 1, stock: 2_000_000 }, "stock"], [{ name: "   ", price: 1 }, "name"],
    [{ name: "A", price: 1, images: ["javascript:alert(1)"] }, "images"], [{ name: "A", price: 1, sku: "has space" }, "sku"],
  ] as const) {
    const r = await api("POST", "/api/products", body);
    assert.equal(r.statusCode, 400, JSON.stringify(body));
    assert.ok(r.json().fields.some((f: { field: string }) => f.field === field), `${JSON.stringify(body)} -> ${r.body}`);
  }
  assert.equal((await api("POST", "/api/products", { name: "A", price: 1, costPrice: 3 })).statusCode, 400, "unknown fields are rejected, not silently dropped");
  assert.equal((await api("POST", "/api/products", { name: "A", price: "12" })).statusCode, 400, "no type coercion");
  const p = await product({ name: "  Mug\u0007  ", price: 0.1 + 0.2, description: "line one\nline\u0000two" });
  assert.equal(p.name, "Mug");
  assert.equal(p.price, 0.3, "float noise is accepted and stored as whole cents");
  assert.equal(p.description, "line one\nlinetwo");
  assert.equal((await api("POST", "/api/products", { name: "A", price: 1, categoryId: "nope" })).statusCode, 400, "unknown category");
});

test("public product data is an allowlist: internal fields never reach shoppers (C1)", async () => {
  const { api, db, product, attribute } = await make();
  await attribute({ key: "colour", label: "Colour", type: "text" });
  await attribute({ key: "supplier", label: "Supplier", type: "text", visibility: "internal" });
  const p = await product({ name: "Mug", sku: "MUG-1", attributes: { colour: "Blue", supplier: "ACME" } });
  await db.products.update(p.id, { costPrice: 3, internalNote: "margin 70%" } as never);
  const pub = (await api("GET", "/api/shop/products")).json()[0];
  assert.deepEqual(Object.keys(pub).sort(), ["active", "attributes", "categoryId", "description", "id", "images", "name", "price", "stock", "type"]);
  assert.deepEqual(pub.attributes, { colour: "Blue" }, "internal properties are left out");
  assert.doesNotMatch(JSON.stringify(pub), /ACME|MUG-1|margin|costPrice|version|updatedBy/);
});

test("edits are versioned, only changed fields are written, and every write is audited", async () => {
  const { api, db, product } = await make();
  const p = await product({ name: "Mug", stock: 3 });
  assert.equal(p.version, 1);
  const u = await api("PATCH", `/api/products/${p.id}`, { price: 12, version: 1 });
  assert.equal(u.statusCode, 200);
  assert.equal(u.json().version, 2);
  assert.equal(u.json().stock, 3);
  const stale = await api("PATCH", `/api/products/${p.id}`, { price: 13, version: 1 });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().code, "version_conflict");
  assert.equal((await api("PATCH", `/api/products/${p.id}`, { price: 13 })).json().price, 13, "without a version the last write wins");
  assert.equal((await api("PATCH", `/api/products/missing`, { price: 1 })).statusCode, 404);
  const log = await db.audit.find({ entity: "product", entityId: p.id }, { sort: { at: 1 } });
  assert.deepEqual(log.map((e) => e.action), ["create", "update", "update"]);
  assert.deepEqual(log[1].before, { price: 10 });
  assert.deepEqual(log[1].after, { price: 12 });
});

test("a product edit never overwrites a concurrent checkout's stock decrement", async () => {
  const { api, app, product } = await make();
  const p = await product({ name: "Mug", stock: 20 });
  await Promise.all(Array.from({ length: 10 }, (_, i) => [
    api("PATCH", `/api/products/${p.id}`, { name: `Mug ${i}` }),
    app.inject({ method: "POST", url: "/api/shop/orders", payload: { items: [{ productId: p.id, qty: 1 }], customer: { name: "A", email: `a${i}@x.io`, address: "x" } } }),
  ]).flat());
  assert.equal((await api("GET", `/api/products/${p.id}`)).json().stock, 10);
});

test("SKUs are unique (case-insensitive), released when changed, and kept by deleted products", async () => {
  const { api, product } = await make();
  const a = await product({ name: "A", sku: "mug-1" });
  const dup = await api("POST", "/api/products", { name: "B", price: 1, sku: "MUG-1" });
  assert.equal(dup.statusCode, 409);
  assert.match(dup.json().error, /already used by A/);
  const b = await product({ name: "B", sku: "B-1" });
  assert.equal((await api("PATCH", `/api/products/${b.id}`, { sku: "Mug-1" })).statusCode, 409);
  assert.equal((await api("PATCH", `/api/products/${a.id}`, { sku: "MUG-2" })).statusCode, 200);
  assert.equal((await api("PATCH", `/api/products/${b.id}`, { sku: "mug-1" })).statusCode, 200, "the old SKU was released");
  await api("PATCH", `/api/products/${a.id}`, { active: false });
  await api("DELETE", `/api/products/${a.id}`);
  const taken = await api("POST", "/api/products", { name: "C", price: 1, sku: "MUG-2" });
  assert.equal(taken.statusCode, 409, "a deleted product keeps its SKU, so restoring it never clashes");
  assert.match(taken.json().error, /\(deleted\)/);
});

test("lifecycle: visible products can only be hidden; hidden ones can be deleted; deleted ones stay referenced and can be restored", async () => {
  const { api, app, db, product } = await make();
  const p = await product({ name: "Vase", stock: 5 });
  const offer = (await api("POST", "/api/discounts", { name: "Vase deal", label: "Deal", effect: { type: "percent", bp: 1000 }, target: { type: "products", productIds: [p.id] } })).json();

  const visible = await api("DELETE", `/api/products/${p.id}`);
  assert.equal(visible.statusCode, 409);
  assert.equal(visible.json().code, "hide_first");
  await api("PATCH", `/api/products/${p.id}`, { active: false });
  const impact = (await api("GET", `/api/products/${p.id}/delete-impact`)).json();
  assert.deepEqual(impact.offers.map((o: { name: string }) => o.name), ["Vase deal"]);
  assert.equal((await api("DELETE", `/api/products/${p.id}`)).statusCode, 204);
  assert.equal((await api("DELETE", `/api/products/${p.id}`)).statusCode, 204, "idempotent");

  const stored = await db.products.get(p.id);
  assert.ok(stored?.deletedAt, "the record is kept");
  assert.equal(stored?.active, false);
  assert.ok(!(await api("GET", "/api/products")).json().items.some((x: { id: string }) => x.id === p.id), "not in the product list");
  assert.equal((await app.inject({ url: `/shop/product/${p.id}` })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: "/shop/cart/add", ...form({ productId: p.id, qty: "1" }) })).statusCode, 400);
  const edit = await api("PATCH", `/api/products/${p.id}`, { active: true });
  assert.equal(edit.statusCode, 409);
  assert.equal(edit.json().code, "restore_first");
  // F5: the offer that names the deleted product can still be edited.
  assert.equal((await api("PATCH", `/api/discounts/${offer.id}`, { version: offer.version, label: "New deal" })).statusCode, 200);

  const restored = await api("POST", `/api/products/${p.id}/restore`);
  assert.equal(restored.statusCode, 200);
  assert.equal(restored.json().product.deletedAt, null);
  assert.equal(restored.json().product.active, false, "restored as hidden, so it doesn't go live by accident");
  const actions = (await db.audit.find({ entity: "product", entityId: p.id }, { sort: { at: 1 } })).map((e) => e.action);
  assert.deepEqual(actions, ["create", "update", "delete", "restore"]);
});

test("deleting a product contained in bundles requires a decision per bundle (keep selling or hide)", async () => {
  const { api, product } = await make();
  const mug = await product({ name: "Mug", price: 20 });
  const plate = await product({ name: "Plate", price: 30 });
  const set1 = await product({ name: "Breakfast set", type: "bundle", bundle: { components: [{ productId: mug.id, qty: 2 }, { productId: plate.id, qty: 1 }] } });
  const set2 = await product({ name: "Gift set", type: "bundle", bundle: { components: [{ productId: mug.id, qty: 1 }, { productId: plate.id, qty: 1 }] } });
  await api("PATCH", `/api/products/${mug.id}`, { active: false });
  const need = await api("DELETE", `/api/products/${mug.id}`);
  assert.equal(need.statusCode, 409);
  assert.equal(need.json().code, "decision_required");
  assert.deepEqual(need.json().bundles.map((b: { name: string }) => b.name).sort(), ["Breakfast set", "Gift set"]);
  assert.equal((await api("DELETE", `/api/products/${mug.id}`, { bundles: { [set1.id]: "keep" } })).statusCode, 409, "every bundle needs a decision");
  assert.equal((await api("DELETE", `/api/products/${mug.id}`, { bundles: { [set1.id]: "keep", [set2.id]: "hide", other: "keep" } })).statusCode, 400);
  assert.equal((await api("DELETE", `/api/products/${mug.id}`, { bundles: { [set1.id]: "keep", [set2.id]: "hide" } })).statusCode, 204);
  assert.equal((await api("GET", `/api/products/${set1.id}`)).json().active, true, "kept on sale");
  assert.equal((await api("GET", `/api/products/${set2.id}`)).json().active, false, "hidden as chosen");
  assert.equal((await api("GET", `/api/products/${set1.id}`)).json().bundle.components[0].productId, mug.id, "the deleted product stays in the bundle");
});

test("no route can remove a product record (C24)", () => {
  const dir = join(import.meta.dirname, "..", "src");
  const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : e.name.endsWith(".ts") ? [join(d, e.name)] : []));
  const offenders = files(dir).filter((f) => /products\.delete\(/.test(readFileSync(f, "utf8")));
  assert.deepEqual(offenders, []);
});

test("bulk show/hide/category changes products once and reports failures", async () => {
  const { api, product } = await make();
  const cat = (await api("POST", "/api/categories", { name: "Mugs", slug: "mugs" })).json();
  const a = await product({ name: "A" }), b = await product({ name: "B" });
  const r = await api("POST", "/api/products/bulk", { ids: [a.id, b.id, "missing"], action: "category", categoryId: cat.id });
  assert.equal(r.json().changed, 2);
  assert.equal(r.json().failed.length, 1);
  assert.equal((await api("GET", `/api/products/${a.id}`)).json().categoryId, cat.id);
  assert.equal((await api("POST", "/api/products/bulk", { ids: [a.id], action: "delete" })).statusCode, 400, "delete is never a bulk action");
  assert.equal((await api("POST", "/api/products/bulk", { ids: [a.id, b.id], action: "hide" })).json().changed, 2);
  assert.equal((await api("GET", `/api/products/${b.id}`)).json().active, false);
});

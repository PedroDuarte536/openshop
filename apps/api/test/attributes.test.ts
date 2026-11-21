// Product properties: definitions, values on products, and the rules that keep them consistent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { keyFromLabel } from "../src/catalogue/attributes.ts";
import { make } from "./catalogue-helpers.ts";

test("keys come from labels and can't be reserved names", () => {
  assert.equal(keyFromLabel("Temperature (ºC)"), "temperature_oc");
  assert.equal(keyFromLabel("Côr / Color"), "cor_color");
  assert.equal(keyFromLabel("350 ml"), "p_350_ml");
  assert.equal(keyFromLabel("__proto__"), "proto");
  assert.equal(keyFromLabel("constructor"), "p_constructor");
});

test("properties: create, options, duplicates, internal ones are never shop-facing", async () => {
  const { api, attribute } = await make();
  const colour = await attribute({ label: "Colour", type: "choice", options: [{ label: "Deep Blue", swatch: "#1f4fff" }, { label: "Sand" }] });
  assert.equal(colour.key, "colour");
  assert.deepEqual(colour.options.map((o: { value: string }) => o.value), ["deep-blue", "sand"]);
  assert.equal(colour.filterable, true);
  assert.equal((await api("POST", "/api/attributes", { label: "Colour", type: "text" })).statusCode, 409, "same key");
  const bad = await api("POST", "/api/attributes", { label: "X", type: "choice", options: [{ label: "A" }, { label: "a" }, { label: "B", swatch: "red;background:url(x)" }] });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().fields.length, 2, "duplicate value and unsafe colour");
  const internal = await attribute({ label: "Supplier", type: "text", visibility: "internal", filterable: true, searchable: true });
  assert.deepEqual([internal.filterable, internal.searchable, internal.showOnProduct], [false, false, false]);
  assert.equal((await api("POST", "/api/attributes", { label: "Weight", type: "text", unit: "kg" })).statusCode, 400, "only numbers have units");
  assert.equal((await api("POST", "/api/attributes", { key: "__proto__", label: "Evil", type: "text" })).statusCode, 400);
});

test("product values are checked against the definitions", async () => {
  const { api, product, attribute } = await make();
  await attribute({ label: "Colour", type: "choice", options: [{ label: "Blue" }, { label: "Sand" }] });
  await attribute({ label: "Capacity", type: "number", unit: "ml" });
  await attribute({ label: "Dishwasher safe", type: "boolean" });
  await attribute({ label: "Tags", type: "multi", options: [{ label: "Gift" }, { label: "New" }] });
  const p = await product({ name: "Mug", attributes: { colour: "SAND", capacity: "350", dishwasher_safe: "yes", tags: "Gift|new" } });
  assert.deepEqual(p.attributes, { colour: "sand", capacity: 350, dishwasher_safe: true, tags: ["gift", "new"] });
  const bad = await api("POST", "/api/products", { name: "X", price: 1, attributes: { colour: "Red", capacity: "lots", unknown_one: "x" } });
  assert.equal(bad.statusCode, 400);
  assert.deepEqual(bad.json().fields.map((f: { field: string }) => f.field).sort(), ["attributes.capacity", "attributes.colour", "attributes.unknown_one"]);
  const raw = '{"name":"X","price":1,"attributes":{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}}}}';
  assert.equal((await api("POST", "/api/products", raw, { "content-type": "application/json" })).statusCode, 400, "prototype keys are rejected");
  assert.equal(({} as Record<string, unknown>).polluted, undefined, "no prototype pollution");
});

test("changes that would break products are refused; delete needs purge when values exist", async () => {
  const { api, product, attribute } = await make();
  const colour = await attribute({ label: "Colour", type: "choice", options: [{ label: "Blue" }, { label: "Sand" }] });
  const p = await product({ name: "Mug", attributes: { colour: "blue" } });
  const typeChange = await api("PATCH", `/api/attributes/${colour.id}`, { version: 1, type: "text" });
  assert.equal(typeChange.statusCode, 400);
  assert.match(typeChange.json().fields[0].message, /1 products have a value/);
  const removeUsed = await api("PATCH", `/api/attributes/${colour.id}`, { version: 1, options: [{ label: "Sand" }] });
  assert.equal(removeUsed.statusCode, 400);
  const rename = await api("PATCH", `/api/attributes/${colour.id}`, { version: 1, options: [{ value: "blue", label: "Ocean Blue" }, { label: "Sand" }] });
  assert.equal(rename.statusCode, 200, "renaming keeps the stored value");
  assert.equal(rename.json().usedBy, 1);
  assert.equal((await api("PATCH", `/api/attributes/${colour.id}`, { version: 1, label: "Stale" })).statusCode, 409);
  const del = await api("DELETE", `/api/attributes/${colour.id}`);
  assert.equal(del.statusCode, 409);
  assert.equal((await api("DELETE", `/api/attributes/${colour.id}?purge=true`)).statusCode, 204);
  assert.deepEqual((await api("GET", `/api/products/${p.id}`)).json().attributes, {});
});

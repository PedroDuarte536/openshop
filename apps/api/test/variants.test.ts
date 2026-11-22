// Variants (plan §2.8): the owner's example as the acceptance fixture, duplicates refused on every path (V-3), missing
// values shown as "-" (V-7), hidden members never shown (C22), and the group's integrity under concurrency (C21).
import { test } from "node:test";
import assert from "node:assert/strict";
import { make } from "./catalogue-helpers.ts";

type C = Awaited<ReturnType<typeof make>>;
const EXAMPLE: [string, string, number, string, string][] = [
  ["Product 1", "White", 10, "Female", "10º"], ["Product 2", "Black", 10, "Female", "10º"], ["Product 3", "White", 20, "Female", "10º"],
  ["Product 4", "White", 30, "Female", "10º"], ["Product 5", "White", 10, "Female", "30º"], ["Product 6", "Black", 10, "Female", "30º"],
  ["Product 7", "White", 20, "Male", "10º"],
];
const DIFFS = [{ key: "color" }, { key: "size" }, { key: "gender" }, { key: "temperature" }];

async function example(c: C) {
  await c.attribute({ key: "color", label: "Colors", type: "text" });
  await c.attribute({ key: "size", label: "Size", type: "number" });
  await c.attribute({ key: "gender", label: "Gender", type: "choice", options: [{ label: "Female" }, { label: "Male" }] });
  await c.attribute({ key: "temperature", label: "Temperature", type: "text" });
  const ids: Record<string, string> = {};
  for (const [name, color, size, gender, temperature] of EXAMPLE) ids[name] = (await c.product({ name, price: 50, attributes: { color, size, gender, temperature } })).id;
  return ids;
}

/** The selector on a product page, as "White (sel) · Black → P2" per line (→ = link, (dis) = disabled). */
async function selector(c: C, id: string, names: Record<string, string>) {
  const html = (await c.app.inject({ url: `/shop/product/${id}` })).body;
  const byId = Object.fromEntries(Object.entries(names).map(([n, i]) => [i, n.replace("Product ", "P")]));
  const lines = [...html.matchAll(/<div class="os-var" role="group"[^>]*><span class="os-var-l"[^>]*>([^<]*)<\/span><span class="os-var-vs">([\s\S]*?)<\/span><\/div>/g)];
  return Object.fromEntries(lines.map(([, label, body]) => [label, [...body.matchAll(/<(a|span) class="os-vb([^"]*)"(?: href="\/shop\/product\/([^"]+)")?[^>]*>(?:<i[^>]*><\/i>)?([^<]*)/g)]
    .map(([, tag, cls, target, value]) => (tag === "a" ? `${value} → ${byId[target]}` : cls.includes("is-selected") ? `${value} (sel)` : `${value} (dis)`)).join(" · ")]));
}

test("the owner's example: every product page shows exactly the §2.8.7 table", async () => {
  const c = await make();
  const ids = await example(c);
  const g = await c.api("POST", "/api/variant-groups", { name: "Jacket", productIds: Object.values(ids), differentiators: DIFFS });
  assert.equal(g.statusCode, 201, g.body);
  assert.equal(g.json().id, "jacket");
  const expected: Record<string, Record<string, string>> = {
    P1: { Colors: "White (sel) · Black → P2", Size: "10 (sel) · 20 → P3 · 30 → P4", Gender: "Female (sel) · Male (dis)", Temperature: "10º (sel) · 30º → P5" },
    P2: { Colors: "White → P1 · Black (sel)", Size: "10 (sel) · 20 (dis) · 30 (dis)", Gender: "Female (sel) · Male (dis)", Temperature: "10º (sel) · 30º → P6" },
    P3: { Colors: "White (sel) · Black (dis)", Size: "10 → P1 · 20 (sel) · 30 → P4", Gender: "Female (sel) · Male → P7", Temperature: "10º (sel) · 30º (dis)" },
    P4: { Colors: "White (sel) · Black (dis)", Size: "10 → P1 · 20 → P3 · 30 (sel)", Gender: "Female (sel) · Male (dis)", Temperature: "10º (sel) · 30º (dis)" },
    P5: { Colors: "White (sel) · Black → P6", Size: "10 (sel) · 20 (dis) · 30 (dis)", Gender: "Female (sel) · Male (dis)", Temperature: "10º → P1 · 30º (sel)" },
    P6: { Colors: "White → P5 · Black (sel)", Size: "10 (sel) · 20 (dis) · 30 (dis)", Gender: "Female (sel) · Male (dis)", Temperature: "10º → P2 · 30º (sel)" },
    P7: { Colors: "White (sel) · Black (dis)", Size: "10 (dis) · 20 (sel) · 30 (dis)", Gender: "Female → P3 · Male (sel)", Temperature: "10º (sel) · 30º (dis)" },
  };
  for (const [name, id] of Object.entries(ids)) assert.deepEqual(await selector(c, id, ids), expected[name.replace("Product ", "P")], name);
  // Hiding P7: "Male" disappears entirely (values of hidden products are never shown, C22).
  await c.api("PATCH", `/api/products/${ids["Product 7"]}`, { active: false });
  assert.equal((await selector(c, ids["Product 1"], ids)).Gender, "Female (sel)");
  assert.equal((await selector(c, ids["Product 3"], ids)).Gender, "Female (sel)");
  const view = (await c.api("GET", "/api/variant-groups/jacket")).json();
  assert.deepEqual(view.warnings.useless, ["Gender"], "with P7 hidden, every visible product is Female");
  assert.deepEqual(view.warnings.unreachable, []);
  assert.deepEqual(view.members[0].values, { color: "White", size: "10", gender: "Female", temperature: "10º" });
  // Hiding P3 as well: 20 is still shown (P7 is visible again) and keeps its place between 10 and 30.
  await c.api("PATCH", `/api/products/${ids["Product 7"]}`, { active: true });
  await c.api("PATCH", `/api/products/${ids["Product 3"]}`, { active: false });
  assert.equal((await selector(c, ids["Product 1"], ids)).Size, "10 (sel) · 20 (dis) · 30 → P4", "values don't move when a product is hidden");
});

test("a product with the same values as another is never added: create, add, add a variant, edit, untick, restore", async () => {
  const c = await make();
  const ids = await example(c);
  const dupe = (await c.product({ name: "Product 8", price: 50, attributes: { color: "white", size: 10, gender: "female", temperature: "10º" } })).id;
  const bad = await c.api("POST", "/api/variant-groups", { productIds: [...Object.values(ids), dupe], differentiators: DIFFS });
  assert.equal(bad.statusCode, 409);
  assert.equal(bad.json().code, "variant_duplicate");
  assert.equal(bad.json().error, "Product 8 has the same Colors, Size, Gender and Temperature as Product 1 (White · 10 · Female · 10º).");
  assert.equal((await c.db.variantGroups.find({})).length, 0, "nothing saved");
  const g = (await c.api("POST", "/api/variant-groups", { name: "Jacket", productIds: Object.values(ids), differentiators: DIFFS })).json();
  const add = await c.api("PATCH", "/api/variant-groups/jacket", { version: g.version, add: [dupe] });
  assert.equal(add.json().code, "variant_duplicate");
  assert.equal((await c.api("GET", `/api/products/${dupe}`)).json().variantGroupId ?? null, null);
  const count = (await c.api("GET", "/api/products")).json().total;
  const copy = await c.api("POST", "/api/variant-groups/jacket/variants", { fromProductId: ids["Product 1"], values: { color: "White" } });
  assert.equal(copy.statusCode, 409, "a copy with the same values is never created");
  assert.equal((await c.api("GET", "/api/products")).json().total, count);
  const edit = await c.api("PATCH", `/api/products/${ids["Product 3"]}`, { attributes: { color: "White", size: 10, gender: "female", temperature: "10º" } });
  assert.equal(edit.statusCode, 409);
  assert.match(edit.json().error, /Product 3 has the same Colors, Size, Gender and Temperature as Product 1/);
  assert.equal((await c.api("GET", `/api/products/${ids["Product 3"]}`)).json().attributes.size, 20, "not saved");
  const untick = await c.api("PATCH", "/api/variant-groups/jacket", { version: g.version, differentiators: [{ key: "color" }, { key: "size" }, { key: "gender" }] });
  assert.equal(untick.statusCode, 409);
  assert.deepEqual(untick.json().conflicts.map((x: { name: string; withName: string }) => [x.name, x.withName]), [["Product 5", "Product 1"], ["Product 6", "Product 2"]]);
  // Restore a deleted member whose values were taken meanwhile: it comes back outside the group.
  await c.api("PATCH", `/api/products/${ids["Product 4"]}`, { active: false });
  await c.api("DELETE", `/api/products/${ids["Product 4"]}`);
  const v = (await c.api("GET", "/api/variant-groups/jacket")).json().version;
  const added = await c.api("PATCH", "/api/variant-groups/jacket", { version: v, add: [(await c.product({ name: "Product 9", price: 50, attributes: { color: "White", size: 30, gender: "female", temperature: "10º" } })).id] });
  assert.equal(added.statusCode, 200, "the deleted product's values are free");
  const restored = await c.api("POST", `/api/products/${ids["Product 4"]}/restore`);
  assert.match(restored.json().notice, /restored outside the variant group "Jacket": it has the same values as Product 9/);
  assert.equal(restored.json().product.variantGroupId, null);
});

test("a good new variant is added hidden; values are inferred, missing ones shown as \"-\" (V-7)", async () => {
  const c = await make();
  const ids = await example(c);
  const g = (await c.api("POST", "/api/variant-groups", { name: "Jacket", productIds: Object.values(ids), differentiators: DIFFS })).json();
  const v = await c.api("POST", "/api/variant-groups/jacket/variants", { fromProductId: ids["Product 1"], values: { size: 40 }, name: "Product 1 XL" });
  assert.equal(v.statusCode, 201, v.body);
  assert.deepEqual([v.json().active, v.json().variantGroupId, v.json().attributes.size, v.json().variantPosition], [false, "jacket", 40, 7]);
  // No value for a differentiator: shown as "-" (and two such products with equal other values are duplicates).
  const bare = (await c.product({ name: "No temp", price: 50, attributes: { color: "Black", size: 20, gender: "Female" } })).id;
  assert.equal((await c.api("PATCH", "/api/variant-groups/jacket", { version: g.version, add: [bare] })).json().code, "version_conflict", "adding a variant changed the group");
  const r = await c.api("PATCH", "/api/variant-groups/jacket", { version: (await c.api("GET", "/api/variant-groups/jacket")).json().version, add: [bare] });
  assert.equal(r.statusCode, 200, r.body);
  const p1 = await selector(c, ids["Product 1"], { ...ids, "No temp": bare });
  assert.equal(p1.Temperature, "10º (sel) · 30º → P5 · - (dis)");
  const bare2 = (await c.product({ name: "No temp 2", price: 50, attributes: { color: "Black", size: 20, gender: "Female" } })).id;
  assert.equal((await c.api("PATCH", "/api/variant-groups/jacket", { version: r.json().version, add: [bare2] })).json().code, "variant_duplicate");
});

test("\"-\" is always the last value, even when the first product of the group has no value", async () => {
  const c = await make();
  const ids = await example(c);
  await c.api("POST", "/api/variant-groups", { name: "Jacket", productIds: Object.values(ids), differentiators: DIFFS });
  const p1 = (await c.api("GET", `/api/products/${ids["Product 1"]}`)).json();
  const { gender: _g, ...rest } = p1.attributes;
  assert.equal((await c.api("PATCH", `/api/products/${p1.id}`, { attributes: rest })).statusCode, 200);
  assert.equal((await selector(c, ids["Product 1"], ids)).Gender, "Female (dis) · Male (dis) · - (sel)");
  assert.equal((await selector(c, ids["Product 3"], ids)).Gender, "Female (sel) · Male → P7 · - (dis)");
});

test("rules: public single-value properties only (or made public on request), no bundles, one group per product", async () => {
  const c = await make();
  await c.attribute({ key: "tags", label: "Tags", type: "multi", options: [{ label: "A" }] });
  await c.attribute({ key: "code", label: "Code", type: "text", visibility: "internal" });
  const a = await c.product({ name: "A", price: 1, attributes: { code: "x" } });
  const b = await c.product({ name: "B", price: 1, attributes: { code: "y" } });
  const multi = await c.api("POST", "/api/variant-groups", { productIds: [a.id, b.id], differentiators: [{ key: "tags" }] });
  assert.match(multi.json().error, /several values per product/);
  const internal = await c.api("POST", "/api/variant-groups", { productIds: [a.id, b.id], differentiators: [{ key: "code" }] });
  assert.match(internal.json().error, /Code is internal: shoppers must see it/);
  const ok = await c.api("POST", "/api/variant-groups", { productIds: [a.id, b.id], differentiators: [{ key: "code" }], makePublic: true });
  assert.equal(ok.statusCode, 201, ok.body);
  assert.equal((await c.db.attributes.get("code"))?.visibility, "public");
  const set = await c.product({ name: "Set", type: "bundle", bundle: { components: [{ productId: a.id, qty: 1 }, { productId: b.id, qty: 1 }] } });
  const other = await c.product({ name: "C", price: 1, attributes: { code: "z" } });
  const refused = await c.api("POST", "/api/variant-groups", { productIds: [set.id, a.id, other.id], differentiators: [{ key: "code" }] });
  assert.match(refused.json().error, /Set is a bundle; bundles can't be variants/);
  assert.match(refused.json().error, /A is already in another variant group/);
  assert.match((await c.api("PATCH", `/api/products/${a.id}`, { type: "bundle", bundle: { components: [{ productId: other.id, qty: 1 }, { productId: b.id, qty: 1 }] } })).body, /variants can't be bundles/);
  // The property now tells variants apart: it can't be deleted or made internal.
  assert.equal((await c.api("DELETE", "/api/attributes/code?purge=true")).statusCode, 409);
  assert.equal((await c.api("PATCH", "/api/attributes/code", { version: 2, visibility: "internal" })).statusCode, 400);
  // Dissolving frees the products (they are never removed).
  assert.equal((await c.api("DELETE", `/api/variant-groups/${ok.json().id}`)).statusCode, 204);
  assert.equal((await c.api("GET", `/api/products/${a.id}`)).json().variantGroupId, null);
});

test("two concurrent edits can't both create the same combination (C21)", async () => {
  const c = await make();
  const ids = await example(c);
  await c.api("POST", "/api/variant-groups", { name: "Jacket", productIds: Object.values(ids), differentiators: DIFFS });
  // P4 (White 30) and P6 (Black 10 30º) both try to become White · 20 · Male · 30º at the same time.
  const target = { color: "White", size: 20, gender: "Male", temperature: "30º" };
  const [r1, r2] = await Promise.all([c.api("PATCH", `/api/products/${ids["Product 4"]}`, { attributes: target }), c.api("PATCH", `/api/products/${ids["Product 6"]}`, { attributes: target })]);
  assert.deepEqual([r1.statusCode, r2.statusCode].sort(), [200, 409]);
  const view = (await c.api("GET", "/api/variant-groups/jacket")).json();
  assert.deepEqual(view.warnings.duplicates, []);
});

test("suggest: properties whose values differ are proposed; a preview shows duplicates and what the shop would show", async () => {
  const c = await make();
  const ids = await example(c);
  await c.attribute({ key: "brand", label: "Brand", type: "text" });
  await c.api("PATCH", `/api/products/${ids["Product 1"]}`, { attributes: { color: "White", size: 10, gender: "female", temperature: "10º", brand: "Dune" } });
  const s = (await c.api("POST", "/api/variant-groups/suggest", { productIds: [ids["Product 1"], ids["Product 2"], ids["Product 5"]] })).json();
  assert.deepEqual(s.properties.map((p: { key: string; varies: boolean }) => [p.key, p.varies]), [["color", true], ["size", false], ["gender", false], ["temperature", true], ["brand", true]]);
  const p = (await c.api("POST", "/api/variant-groups/suggest", { productIds: [ids["Product 1"], ids["Product 5"]], differentiators: [{ key: "color" }, { key: "size" }] })).json();
  assert.match(p.preview.duplicates[0].message, /Product 5 has the same Colors and Size as Product 1/);
  assert.deepEqual(p.preview.useless, ["Colors", "Size"]);
  assert.equal(p.preview.selector[0].badges[0].state, "selected");
  // The admin list can show a group's members.
  await c.api("POST", "/api/variant-groups", { name: "Jacket", productIds: Object.values(ids), differentiators: DIFFS });
  assert.equal((await c.api("GET", "/api/products?variantGroup=jacket")).json().total, 7);
  assert.equal((await c.api("GET", "/api/products?inVariantGroup=false")).json().total, 0);
  await c.product({ name: "Loose", price: 1 });
  assert.equal((await c.api("GET", "/api/products")).json().facets.variants, 7, "the filter shows how many products are in a group");
});

test("deleting a member says which values disappear; unreachable variants are flagged", async () => {
  const c = await make();
  const ids = await example(c);
  await c.api("POST", "/api/variant-groups", { name: "Jacket", productIds: Object.values(ids), differentiators: DIFFS });
  await c.api("PATCH", `/api/products/${ids["Product 7"]}`, { active: false });
  const impact = (await c.api("GET", `/api/products/${ids["Product 7"]}/delete-impact`)).json();
  assert.deepEqual(impact.variantGroup, { id: "jacket", name: "Jacket", valuesLost: [{ property: "Gender", value: "Male" }] });
  await c.api("PATCH", `/api/products/${ids["Product 7"]}`, { active: true });
  // An island: Black · 30 · Male · 30º differs from every other product in more than one property.
  const island = (await c.product({ name: "Island", price: 50, attributes: { color: "Black", size: 30, gender: "Male", temperature: "30º" } })).id;
  const v = (await c.api("GET", "/api/variant-groups/jacket")).json().version;
  const r = await c.api("PATCH", "/api/variant-groups/jacket", { version: v, add: [island] });
  assert.deepEqual(r.json().warnings.unreachable, [{ id: island, name: "Island" }]);
  assert.equal((await c.api("GET", "/api/variant-groups")).json()[0].members, 8);
});

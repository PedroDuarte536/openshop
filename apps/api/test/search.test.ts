// Search (plan §2.5): matching, typo tolerance (§2.5.4 table), disjunctive filter counts, sorting, paging, privacy of
// the public view (C2), and the exports on the same URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Dictionary, eligible, withinOne } from "../src/catalogue/search/fuzzy.ts";
import { indexTokens, queryWords } from "../src/catalogue/search/text.ts";
import { SearchIndex } from "../src/catalogue/search/memory-index.ts";
import type { AttributeDef, Product } from "../src/types.ts";
import { make } from "./catalogue-helpers.ts";

const cps = (s: string) => [...s];

test("typo check: one substitution, insertion, deletion or adjacent swap, and nothing else", () => {
  for (const w of ["stonewre", "stonewaare", "stoenware", "stonewxre", "stoneward", "tsoneware", "stnoeware", "sstoneware"]) assert.ok(withinOne(cps(w), cps("stoneware")), w);
  for (const w of ["stoneware", "stonewear", "stonw", "stnewaer", "ceramic"]) assert.equal(withinOne(cps(w), cps("stoneware")), false, w);
  assert.ok(withinOne(cps("ceramiqe"), cps("ceramique")));
  assert.ok(eligible("stonewre"));
  assert.equal(eligible("mugg"), false, "under 5 letters");
  assert.equal(eligible("350mk"), false, "digits");
  assert.equal(eligible("陶器陶器陶器"), false, "unspaced script");
  const d = new Dictionary(new Map([["stoneware", 5], ["stonewire", 1], ["tonewares", 9]]));
  assert.deepEqual(d.candidates("stonewere"), ["stoneware", "stonewire"], "same first letter first, then more common");
});

test("text: accents and case are ignored; 350ml is also 350 and ml", () => {
  assert.deepEqual(queryWords("Céramique  BLEUE!"), ["ceramique", "bleue"]);
  assert.deepEqual(indexTokens("Mug 350ml"), ["mug", "350ml", "350", "ml"]);
});

const def = (o: Partial<AttributeDef> & { key: string }): AttributeDef => ({
  id: o.key, label: o.key, type: "text", visibility: "public", filterable: true, searchable: true, showOnProduct: true, position: 0, version: 1, createdAt: "", updatedAt: "", options: [], ...o,
});
const prod = (o: Partial<Product> & { id: string; name: string }): Product => ({ price: 10, active: true, stock: 5, ...o }) as Product;

function fixture() {
  const defs = [
    def({ key: "colour", type: "choice", options: [{ value: "blue", label: "Blue", position: 0 }, { value: "sand", label: "Sand", position: 1 }] }),
    def({ key: "supplier", visibility: "internal", filterable: false, searchable: false }),
    def({ key: "capacity", type: "number", unit: "ml" }),
  ];
  const products = [
    prod({ id: "p1", name: "Stoneware Mug", price: 24, categoryId: "mugs", attributes: { colour: "blue", supplier: "Acme Kilns", capacity: 350 }, description: "Hand-thrown céramique" }),
    prod({ id: "p2", name: "Stoneware Bowl", price: 38, categoryId: "bowls", attributes: { colour: "sand", capacity: 600 } }),
    prod({ id: "p3", name: "Linen Mug", price: 18, categoryId: "mugs", stock: 0, attributes: { colour: "sand", capacity: 300 } }),
    prod({ id: "p4", name: "Secret Prototype Vase", price: 99, active: false, attributes: { colour: "blue" } }),
    prod({ id: "p5", name: "Old Stoneware Plate", price: 30, active: false, deletedAt: "2026-01-01T00:00:00Z" }),
    prod({ id: "p6", name: "Mug Rack", price: 41, categoryId: "mugs", sku: "RACK-01" }),
  ];
  const snap = { products, defs, categories: [{ id: "mugs", name: "Mugs", slug: "mugs" }, { id: "bowls", name: "Bowls", slug: "bowls" }], available: new Map(products.map((p) => [p.id, p.stock])) };
  return { pub: new SearchIndex("public", snap), admin: new SearchIndex("admin", snap) };
}

test("matching: every word must match; the last word is a prefix; name matches rank first", () => {
  const { pub } = fixture();
  assert.deepEqual(pub.query({ q: "stoneware mug" }).ids, ["p1"]);
  assert.deepEqual(pub.query({ q: "mug" }).ids, ["p6", "p1", "p3"], "names starting with the query first; out of stock after in stock on equal scores");
  assert.deepEqual(pub.query({ q: "stonew" }).ids.sort(), ["p1", "p2"], "prefix while typing");
  assert.deepEqual(pub.query({ q: "ceramique" }).ids, ["p1"], "accents folded (description)");
  assert.deepEqual(pub.query({ q: "blue" }).ids, ["p1"], "public, searchable property labels");
  assert.deepEqual(pub.query({ q: "350" }).ids, ["p1"], "numbers with units");
  assert.deepEqual(pub.query({ q: "350ml" }).ids, ["p1"], "350ml finds 350 ml when no product says 350ml");
  assert.deepEqual(fixture().admin.query({ q: "rack-01" }).ids, ["p6"], "SKUs (backoffice) still match as written");
  assert.deepEqual(pub.query({ q: "zzz mug" }).ids, [], "AND: an unknown word means no results");
});

test("typo tolerance finds the intended word and reports the correction", () => {
  const { pub } = fixture();
  for (const q of ["stonewre", "stoenware", "stonewaare"]) {
    const r = pub.query({ q });
    assert.deepEqual(r.ids.sort(), ["p1", "p2"], q);
    assert.equal(r.corrected, "stoneware", q);
  }
  const two = pub.query({ q: "stonewre mug" });
  assert.deepEqual(two.ids, ["p1"]);
  assert.equal(two.corrected, "stoneware mug");
  assert.equal(pub.query({ q: "stoneware" }).corrected, null, "exact words are never corrected");
  assert.deepEqual(pub.query({ q: "stonewear" }).ids, [], "two edits: not corrected (deliberate)");
  assert.deepEqual(pub.query({ q: "mugg" }).ids, [], "short words are not corrected");
});

test("privacy (C2): the public view never matches, counts or suggests hidden products or internal properties", () => {
  const { pub, admin } = fixture();
  const nothing = pub.query({ q: "qwertyzzz" });
  for (const q of ["acme", "kilns", "secret", "prototype", "protoype", "old plate", "rack-01"]) {
    const r = pub.query({ q });
    assert.deepEqual(r.ids, [], q);
    assert.equal(r.corrected, null, `${q}: no "showing results for" with a hidden word`);
    assert.deepEqual(r.facets, nothing.facets, `${q}: same counts as gibberish`);
  }
  assert.deepEqual(admin.query({ q: "acme" }).ids, ["p1"], "the backoffice searches everything");
  assert.deepEqual(admin.query({ q: "rack-01" }).ids, ["p6"], "exact SKU first");
  const blue = pub.query({}).facets!.attributes.find((a) => a.key === "colour")!.values.find((v) => v.value === "c:blue")!;
  assert.equal(blue.count, 1, "the hidden blue vase isn't counted");
  assert.ok(!pub.query({}).facets!.attributes.some((a) => a.key === "supplier"));
});

test("filters: disjunctive counts, ranges, stock, categories; admin-only filters", () => {
  const { pub, admin } = fixture();
  const r = pub.query({ attrs: { colour: { values: ["c:blue"] } } });
  assert.deepEqual(r.ids, ["p1"]);
  const colour = r.facets!.attributes.find((a) => a.key === "colour")!;
  assert.deepEqual(colour.values.map((v) => [v.value, v.count]), [["c:sand", 2], ["c:blue", 1]], "a filter's own counts ignore its selection");
  assert.deepEqual(r.facets!.categories.sort((a, b) => String(a.id).localeCompare(String(b.id))), [{ id: "mugs", count: 1 }], "other counts respect it");
  assert.deepEqual(pub.query({ attrs: { capacity: { min: 320, max: 700 } } }).ids.sort(), ["p1", "p2"]);
  assert.deepEqual(pub.query({ minCents: 2000, maxCents: 3000 }).ids, ["p1"]);
  assert.deepEqual(pub.query({ stock: ["in", "low"] }).ids.includes("p3"), false);
  assert.deepEqual(pub.query({ categories: ["bowls"] }).ids, ["p2"]);
  assert.deepEqual(admin.query({ status: ["deleted"] }).ids, ["p5"]);
  assert.deepEqual(admin.query({ status: ["hidden"] }).ids, ["p4"]);
  assert.deepEqual(admin.query({ status: ["visible", "hidden"], missing: ["category"] }).ids, ["p4"]);
  assert.deepEqual(admin.query({ stock: ["out"], status: ["visible"] }).ids, ["p3"]);
  assert.equal(admin.query({ status: ["visible", "hidden"] }).facets!.status.deleted, 1, "status counts include the other states");
});

test("sorting is deterministic; paging", () => {
  const { pub } = fixture();
  assert.deepEqual(pub.query({ sort: "price" }).ids, ["p3", "p1", "p2", "p6"]);
  assert.deepEqual(pub.query({ sort: "-price" }).ids, ["p6", "p2", "p1", "p3"]);
  assert.deepEqual(pub.query({ sort: "name", skip: 1, limit: 2 }).ids, ["p6", "p2"]);
  assert.equal(pub.query({ sort: "name", skip: 1, limit: 2 }).total, 4);
  assert.deepEqual(pub.query({ sort: "price", priceOf: (id) => (id === "p6" ? 100 : 5000) }).ids[0], "p6", "a price function (the shopper's prices) drives the sort");
});

test("admin search API: filters, facets with labels, lookups by id, summary view, bounds", async () => {
  const { api, product, attribute } = await make();
  await attribute({ key: "colour", label: "Colour", type: "choice", options: [{ label: "Blue" }, { label: "Sand" }] });
  const cat = (await api("POST", "/api/categories", { name: "Mugs", slug: "mugs" })).json();
  const a = await product({ name: "Stoneware Mug", sku: "MUG-1", categoryId: cat.id, attributes: { colour: "Blue" } });
  const b = await product({ name: "Linen Mug", stock: 2, attributes: { colour: "sand" } });
  await product({ name: "Vase", stock: 0, active: false });
  const r = (await api("GET", "/api/products?q=mug&f.colour=blue")).json();
  assert.deepEqual(r.items.map((p: { id: string }) => p.id), [a.id]);
  assert.equal(r.items[0].extras.available, 10);
  const colour = r.facets.attributes.find((x: { key: string }) => x.key === "colour");
  assert.deepEqual(colour.values.map((v: { value: string; label: string; count: number }) => [v.value, v.label, v.count]), [["blue", "Blue", 1], ["sand", "Sand", 1]]);
  assert.deepEqual(r.facets.categories.map((c: { name: string }) => c.name), ["Mugs"]);
  assert.equal((await api("GET", "/api/products?stock=low")).json().items[0].id, b.id);
  assert.equal((await api("GET", "/api/products?status=hidden")).json().total, 1);
  assert.equal((await api("GET", "/api/products?q=mug-1")).json().items[0].id, a.id);
  const s = (await api("GET", `/api/products?ids=${a.id},${b.id}&view=summary&sort=name`)).json();
  assert.deepEqual(Object.keys(s.items[0]).sort(), ["active", "available", "categoryId", "deleted", "id", "image", "name", "price", "sku", "type", "variantGroupId"]);
  assert.equal((await api("GET", "/api/products?limit=100000")).json().items.length, 3, "limit is capped (200) but all 3 fit");
  assert.equal((await api("GET", "/api/products", undefined, { accept: "image/png" })).statusCode, 406);
  assert.equal((await api("GET", "/api/products?f.__proto__=x&f.nope=1&sort=drop")).statusCode, 200, "unknown filters and sorts are ignored");
  // Freshness: a write is visible to the next search in this process.
  await api("PATCH", `/api/products/${b.id}`, { name: "Linen Cup" });
  assert.equal((await api("GET", "/api/products?q=cup")).json().total, 1);
});

test("export: CSV and full JSON of the current search; formulas neutralised; audited", async () => {
  const { api, db, product, attribute } = await make();
  await attribute({ key: "colour", label: "Colour", type: "choice", options: [{ label: "Blue" }] });
  await product({ name: "=HYPERLINK(\"http://evil\")", price: 12.5, sku: "A-1", description: "-20% off, \"quoted\"\nsecond line", attributes: { colour: "blue" } });
  await product({ name: "Other", price: 3, active: false });
  const csv = await api("GET", "/api/products?status=visible", undefined, { accept: "text/csv" });
  assert.equal(csv.statusCode, 200);
  assert.match(csv.headers["content-type"] as string, /text\/csv/);
  assert.match(csv.headers["content-disposition"] as string, /attachment; filename="products-\d{4}-\d{2}-\d{2}\.csv"/);
  assert.equal(csv.headers["cache-control"], "no-store");
  const lines = csv.body.replace(/^\uFEFF/, "").split("\r\n");
  assert.equal(lines[0], "id,sku,type,name,visible,price,stock,category,description,images,attr:colour,bundle_components,bundle_pricing,bundle_offers,bundle_show_on_components,variant_group,variant_by,variant_position");
  assert.match(csv.body, /"'=HYPERLINK\(""http:\/\/evil""\)"/, "formula neutralised and quoted");
  assert.match(csv.body, /"'-20% off, ""quoted""\nsecond line"/);
  assert.match(csv.body, /,12\.50,10,/);
  assert.match(csv.body, /,Blue,/);
  assert.doesNotMatch(csv.body, /Other/, "the current filters apply");
  const semi = await api("GET", "/api/products?status=visible&delimiter=;", undefined, { accept: "text/csv" });
  assert.match(semi.body, /;12,50;10;/, "semicolon files use a decimal comma");
  const json = await api("GET", "/api/products", undefined, { accept: "application/vnd.openshop.catalogue+json" });
  const doc = JSON.parse(json.body);
  assert.equal(doc.format, "openshop.catalogue");
  assert.equal(doc.products.length, 2);
  assert.deepEqual(doc.attributes[0].options, [{ value: "blue", label: "Blue" }]);
  assert.equal((await db.audit.find({ action: "export" })).length, 3);
});

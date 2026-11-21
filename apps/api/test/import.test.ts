// Import (plan §2.7): reading files safely, mapping, preview (nothing written), decisions, commit, conflicts, the
// export -> import round trip, property inference, variants, and images from the server (C20).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode, detectDelimiter, FileError, parseCsv } from "../src/catalogue/import/csv.ts";
import { autoMap, htmlToText, parsePrice, PRESTASHOP, unneutralise } from "../src/catalogue/import/mapping.ts";
import { whenDone } from "../src/catalogue/import/jobs.ts";
import { make } from "./catalogue-helpers.ts";

type C = Awaited<ReturnType<typeof make>>;
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f0005fe02fea7d6a4b20000000049454e44ae426082", "hex");

async function upload(c: C, text: string | Buffer, type = "text/csv", filename = "products.csv") {
  const r = await c.api("POST", `/api/catalogue/imports?filename=${encodeURIComponent(filename)}`, text, { "content-type": type });
  assert.equal(r.statusCode, 201, r.body);
  return r.json();
}
async function preview(c: C, id: string) {
  const r = await c.api("POST", `/api/catalogue/imports/${id}/preview`);
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
async function rows(c: C, id: string, q = "") { return (await c.api("GET", `/api/catalogue/imports/${id}/rows?limit=500${q}`)).json().items; }
async function commit(c: C, id: string, previewAt: string, extra: object = {}) {
  const r = await c.api("POST", `/api/catalogue/imports/${id}/commit`, { previewAt, ...extra });
  assert.equal(r.statusCode, 202, r.body);
  await whenDone(id);
  return (await c.api("GET", `/api/catalogue/imports/${id}`)).json();
}
const csv = (lines: string[][]) => lines.map((l) => l.map((x) => (/[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x)).join(",")).join("\r\n");

test("CSV parser: quotes, line breaks, delimiters, limits, linear time", () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, ""y""","line1\nline2"\r\n\r\nlast,', ","), [["a", "b"], ['x, "y"', "line1\nline2"], ["last", ""]]);
  assert.equal(detectDelimiter("name;price;stock\nA;1,50;2"), ";");
  assert.equal(detectDelimiter('"a,b";c\tc2'), ";");
  assert.equal(detectDelimiter("a\tb\tc"), "\t");
  assert.throws(() => parseCsv('a,b\n"open,x\ny,z', ","), /Line 2: a quoted cell is never closed/);
  assert.throws(() => parseCsv("a\n" + "x\n".repeat(20_002), ","), FileError);
  assert.throws(() => parseCsv("h\n" + "x".repeat(10_001), ","), /longer than/);
  assert.throws(() => decode(Buffer.from([0x61, 0x00, 0x62])), /NUL/);
  assert.deepEqual(decode(Buffer.from([0xef, 0xbb, 0xbf, 0x41])), { text: "A", encoding: "utf-8" });
  assert.deepEqual(decode(Buffer.from([0x43, 0x61, 0x66, 0xe9])), { text: "Café", encoding: "windows-1252" });
  const t0 = Date.now();
  assert.throws(() => parseCsv('"' + '""'.repeat(45_000) + '"', ","), /longer than/);
  assert.throws(() => parseCsv("x,".repeat(49_990), ","), /more than 200 columns/);
  parseCsv(("a,".repeat(150) + "\n").repeat(600), ",");
  assert.ok(Date.now() - t0 < 1000, "pathological input stays linear");
});

test("mapping helpers: own headers, aliases, PrestaShop, prices, HTML, formula prefix", () => {
  const defs = [{ key: "colour", label: "Colour" }] as never;
  assert.deepEqual(autoMap(["id", "SKU", "Title", "Quantity", "attr:colour", "Colour", "attr:Temperature", "Whatever"], defs, { createProperties: true }),
    { id: "id", SKU: "sku", Title: "name", Quantity: "stock", "attr:colour": "attr:colour", Colour: "ignore", "attr:Temperature": "new:Temperature", Whatever: "ignore" });
  assert.ok(PRESTASHOP.detect(["Product ID", "Active (0/1)", "Name *", "Categories (x,y,z...)"]));
  assert.equal(parsePrice("12,50", ","), 12.5);
  assert.equal(parsePrice("12.5", "."), 12.5);
  assert.equal(parsePrice("1.234,50", ","), null, "no thousands separators");
  assert.equal(parsePrice("12,5O", ","), null);
  assert.equal(parsePrice("12.505", "."), null);
  assert.deepEqual(htmlToText("<p>Hand&nbsp;made</p><p>Lead &amp; free<script>x</script></p>"), { text: "Hand made\nLead & free", changed: true });
  assert.equal(htmlToText("<p>Cork stopper</p><STYLE type=x>p{}</STYLE><script src=a>alert('x')</script >").text, "Cork stopper");
  assert.equal(unneutralise("'=SUM(1)"), "=SUM(1)");
  assert.equal(unneutralise("'quoted"), "'quoted");
});

test("export -> import changes nothing (CSV with ; and JSON)", async () => {
  const c = await make();
  await c.attribute({ key: "colour", label: "Colour", type: "choice", options: [{ label: "Blue" }, { label: "Sand" }] });
  await c.attribute({ key: "capacity", label: "Capacity", type: "number", unit: "ml" });
  const cat = (await c.api("POST", "/api/categories", { name: "Mugs", slug: "mugs" })).json();
  const mug = await c.product({ name: "=Mug, \"the\" one", sku: "MUG-1", price: 12.5, categoryId: cat.id, description: "-20% off\nline 2", attributes: { colour: "blue", capacity: 350.5 } });
  const plate = await c.product({ name: "Plate", sku: "PLATE-1", price: 20 });
  await c.product({ name: "Set", type: "bundle", sku: "SET-1", bundle: { components: [{ productId: mug.id, qty: 2 }, { productId: plate.id, qty: 1 }], priceMode: "manual" }, price: 40 });
  await c.product({ name: "Hidden one", active: false, stock: 0 });
  for (const [accept, delimiter, type] of [["text/csv", ";", "text/csv"], ["text/csv", ",", "text/csv"], ["application/vnd.openshop.catalogue+json", ",", "application/json"]] as const) {
    const file = (await c.api("GET", `/api/products?delimiter=${encodeURIComponent(delimiter)}`, undefined, { accept })).body;
    const job = await upload(c, file, type);
    const p = await preview(c, job.id);
    assert.deepEqual([p.preview.create, p.preview.update, p.preview.errors, p.preview.unchanged], [0, 0, 0, 4], `${accept} ${delimiter}: ${JSON.stringify(await rows(c, job.id, "&action=update,create,error"))}`);
  }
});

test("a full import: preview writes nothing, commit creates and updates, errors are reported per row", async () => {
  const c = await make();
  const cat = (await c.api("POST", "/api/categories", { name: "Mugs", slug: "mugs" })).json();
  const mug = await c.product({ name: "Mug", sku: "MUG-1", price: 10, stock: 5 });
  const file = csv([
    ["sku", "name", "price", "stock", "category", "visible", "description"],
    ["MUG-1", "Mug", "12.00", "7", "mugs", "", "<p>Lovely <b>mug</b></p>"],
    ["BOWL-1", "Bowl", "8.5", "3", "Mugs", "yes", ""],
    ["VASE-1", "Vase", "9,99", "1", "", "", ""],
    ["CUP-1", "<img src=x onerror=alert(1)>", "4", "2", "unknown-cat", "", ""],
    ["", "", "", "", "", "", ""],
  ]);
  const job = await upload(c, file);
  assert.equal(job.rowCount, 4);
  assert.equal(job.mapping.sku, "sku");
  const p = await preview(c, job.id);
  assert.deepEqual([p.preview.create, p.preview.update, p.preview.errors], [1, 1, 2]);
  assert.equal((await c.api("GET", "/api/products")).json().total, 1, "nothing written by the preview");
  const report = await rows(c, job.id);
  assert.deepEqual(report[0].diff, { price: [10, 12], stock: [5, 7], description: [null, "Lovely mug"], category: [null, "Mugs"] }, "category names, not ids");
  assert.match(report[0].warnings.join(), /HTML in the description/);
  assert.match(report[2].errors[0].message, /must be a price like 12.50/);
  assert.equal(report[2].errors.length, 1, "one message for an unreadable price, not a second 'must be a number'");
  assert.match(report[3].errors[0].message, /unknown category "unknown-cat"/);
  const csvReport = await c.api("GET", `/api/catalogue/imports/${job.id}/rows`, undefined, { accept: "text/csv" });
  assert.match(csvReport.body, /"'<img|<img/, "the report is formula-safe CSV");
  const done = await commit(c, job.id, p.preview.at);
  assert.equal(done.status, "done");
  assert.deepEqual({ ...done.result }, { created: 1, updated: 1, unchanged: 0, restored: 0, hidden: 0, conflicts: 0, failed: 2, skipped: 0 });
  const updated = (await c.api("GET", `/api/products/${mug.id}`)).json();
  assert.deepEqual([updated.price, updated.stock, updated.description], [12, 7, "Lovely mug"]);
  const bowl = (await c.api("GET", "/api/products?q=bowl")).json().items[0];
  assert.deepEqual([bowl.price, bowl.active, bowl.categoryId], [8.5, true, cat.id]);
  assert.ok((await c.db.audit.find({ action: "import" })).length === 1);
  assert.equal((await c.api("POST", `/api/catalogue/imports/${job.id}/commit`, { previewAt: p.preview.at })).statusCode, 409, "applied once");
});

test("options: update only, create only, hide missing (with confirmation), new products hidden, empty cells, stock", async () => {
  const c = await make();
  const a = await c.product({ name: "A", sku: "A", price: 1, stock: 5, description: "keep" });
  await c.product({ name: "B", sku: "B", price: 1 });
  await c.product({ name: "C", sku: "C", price: 1 });
  const file = csv([["sku", "name", "price", "stock", "description"], ["A", "A", "2", "9", ""], ["NEW", "New", "3", "1", ""]]);
  const job = await upload(c, file);
  const put = (options: object) => c.api("PUT", `/api/catalogue/imports/${job.id}`, { options });
  await put({ mode: "update" });
  let p = await preview(c, job.id);
  assert.deepEqual([p.preview.update, p.preview.errors], [1, 1]);
  const upd = await rows(c, job.id);
  assert.deepEqual(upd[1].errors.map((e: { message: string }) => e.message), ["no product with this id or SKU (the import only updates existing products)"]);
  await put({ mode: "create" });
  p = await preview(c, job.id);
  assert.deepEqual([p.preview.create, p.preview.unchanged], [1, 1]);
  await put({ mode: "upsert", missing: "hide", empty: "clear", stock: "skip", newVisible: false });
  p = await preview(c, job.id);
  assert.equal(p.preview.toHide, 2);
  const needConfirm = await c.api("POST", `/api/catalogue/imports/${job.id}/commit`, { previewAt: p.preview.at });
  assert.equal(needConfirm.statusCode, 409);
  assert.equal(needConfirm.json().code, "confirm_hide");
  const done = await commit(c, job.id, p.preview.at, { confirmHide: true });
  assert.equal(done.result.hidden, 2);
  const after = (await c.api("GET", `/api/products/${a.id}`)).json();
  assert.deepEqual([after.price, after.stock, after.description], [2, 5, ""], "stock skipped, empty description cleared");
  const created = (await c.api("GET", "/api/products?q=new")).json().items[0];
  assert.equal(created.active, false, "the option turned off: new products added hidden");
});

test("conflicts: a product edited or sold after the preview is not overwritten", async () => {
  const c = await make();
  const a = await c.product({ name: "A", sku: "A", price: 1, stock: 5 });
  const b = await c.product({ name: "B", sku: "B", price: 1, stock: 5 });
  const job = await upload(c, csv([["sku", "price", "stock"], ["A", "2", "50"], ["B", "3", "50"]]));
  const p = await preview(c, job.id);
  await c.api("PATCH", `/api/products/${a.id}`, { name: "A edited" });
  await c.app.inject({ method: "POST", url: "/api/shop/orders", payload: { items: [{ productId: b.id, qty: 1 }], customer: { name: "X", email: "x@x.io", address: "x" } } });
  const done = await commit(c, job.id, p.preview.at);
  assert.equal(done.result.conflicts, 2);
  assert.equal((await c.api("GET", `/api/products/${b.id}`)).json().stock, 4, "the sale is kept");
  const r = await rows(c, job.id, "&state=conflict");
  assert.match(r[0].message, /since your preview/);
  // Settings changed after the preview: the commit must use the new preview.
  const job2 = await upload(c, csv([["sku", "price"], ["A", "9"]]));
  const p2 = await preview(c, job2.id);
  await c.api("PUT", `/api/catalogue/imports/${job2.id}`, { options: { stock: "skip" } });
  assert.equal((await c.api("POST", `/api/catalogue/imports/${job2.id}/commit`, { previewAt: p2.preview.at })).json().code, "preview_required");
});

test("rows matching deleted products need a decision: restore, create as new (the SKU moves), or skip", async () => {
  const c = await make();
  const del = async (body: object) => { const p = await c.product({ ...body, active: false }); await c.api("DELETE", `/api/products/${p.id}`); return p; };
  const r1 = await del({ name: "Old 1", sku: "R-1" });
  const n1 = await del({ name: "Old 2", sku: "N-1" });
  const s1 = await del({ name: "Old 3", sku: "S-1" });
  const job = await upload(c, csv([["sku", "name", "price"], ["R-1", "Back", "5"], ["N-1", "Fresh", "6"], ["S-1", "Nope", "7"]]));
  let p = await preview(c, job.id);
  assert.equal(p.preview.undecided, 3);
  assert.deepEqual([p.preview.create, p.preview.errors], [0, 0], "undecided rows are counted as undecided only");
  const waiting = await rows(c, job.id);
  assert.deepEqual(waiting.map((r: { errors: unknown[] }) => r.errors.length), [0, 0, 0], "no 'SKU already used' error while the owner decides");
  assert.equal((await c.api("GET", `/api/catalogue/imports/${job.id}/rows?action=create`)).json().total, 0);
  assert.equal((await c.api("GET", `/api/catalogue/imports/${job.id}/rows?action=deleted`)).json().total, 3);
  assert.equal((await c.api("POST", `/api/catalogue/imports/${job.id}/commit`, { previewAt: p.preview.at })).json().code, "decisions_required");
  p = (await c.api("POST", `/api/catalogue/imports/${job.id}/decisions`, { decisions: { "1": "restore", "2": "new", "3": "skip" } })).json();
  assert.equal(p.preview.undecided, 0);
  const done = await commit(c, job.id, p.preview.at);
  assert.deepEqual([done.result.restored, done.result.created, done.result.skipped], [1, 1, 1]);
  const restored = (await c.api("GET", `/api/products/${r1.id}`)).json();
  assert.deepEqual([restored.deletedAt, restored.name, restored.active], [null, "Back", false]);
  const old = (await c.api("GET", `/api/products/${n1.id}`)).json();
  assert.deepEqual([old.sku, old.formerSku, !!old.deletedAt], [null, "N-1", true], "the deleted product gave its SKU to the new one");
  const fresh = (await c.api("GET", "/api/products?q=N-1")).json().items[0];
  assert.deepEqual([fresh.name, fresh.sku], ["Fresh", "N-1"]);
  assert.ok((await c.api("GET", `/api/products/${s1.id}`)).json().deletedAt, "skipped");
  const back = await c.api("POST", `/api/products/${n1.id}/restore`);
  assert.equal(back.json().product.sku, null, "restored later without its old SKU");
});

test("new properties are inferred from columns, created internal (C25) unless they tell variants apart", async () => {
  const c = await make();
  const job = await upload(c, csv([
    ["sku", "name", "price", "attr:Supplier", "attr:Colour", "attr:Temperature", "variant_group", "variant_by"],
    ["P1", "Product 1", "10", "ACME", "White", "10º", "jacket", "colour|temperature"],
    ["P2", "Product 2", "10", "ACME", "Black", "10º", "jacket", ""],
    ["P8", "Product 8", "10", "ACME", "White", "10º", "jacket", ""],
  ]));
  assert.deepEqual(job.newProperties, { Supplier: { label: "Supplier", type: "text" }, Colour: { label: "Colour", type: "text" }, Temperature: { label: "Temperature", type: "text" } });
  const p = await preview(c, job.id);
  assert.deepEqual(p.preview.newProperties.map((x: { key: string; public: boolean }) => [x.key, x.public]).sort(), [["colour", true], ["supplier", false], ["temperature", true]]);
  const report = await rows(c, job.id);
  assert.match(report[2].errors[0].message, /same Colour, Temperature as Product 1 \(White · 10º\): not added/);
  assert.match(report[0].errors[0]?.message ?? "", /same Colour, Temperature as Product 8|^$/);
  const done = await commit(c, job.id, p.preview.at);
  assert.ok(done.result.failed >= 1);
  assert.equal((await c.api("GET", "/api/products?q=P8")).json().total, 0, "the duplicate is never added");
  const supplier = (await c.api("GET", "/api/attributes")).json().find((a: { key: string }) => a.key === "supplier");
  assert.deepEqual([supplier.visibility, supplier.filterable, supplier.showOnProduct], ["internal", false, false]);
  const pub = (await c.app.inject({ url: "/api/shop/products" })).body;
  assert.doesNotMatch(pub, /ACME/, "internal values never reach the shop");
  const group = await c.db.variantGroups.get("jacket");
  assert.deepEqual(group?.differentiators.map((x) => x.key), ["colour", "temperature"]);
});

test("a price-only file: rows show the product's name; a price of 0 is a warning on its row", async () => {
  const c = await make();
  await c.product({ name: "Salt Cellar", sku: "SALT", price: 19 });
  const job = await upload(c, csv([["sku", "price"], ["SALT", "0.00"]]));
  await preview(c, job.id);
  const [r] = await rows(c, job.id);
  assert.equal(r.name, "Salt Cellar");
  assert.deepEqual(r.warnings, ["price set to 0 (was 19.00)"]);
});

test("a new variant group is named after its first variant (lowest variant_position)", async () => {
  const c = await make();
  await c.attribute({ key: "colour", label: "Colour", type: "text" });
  const job = await upload(c, csv([
    ["sku", "name", "price", "attr:colour", "variant_group", "variant_by", "variant_position"],
    ["C2", "Cup Sage", "10", "Sage", "cup", "colour", "1"],
    ["C1", "Cup Sand", "10", "Sand", "cup", "colour", "0"],
  ]));
  const p = await preview(c, job.id);
  await commit(c, job.id, p.preview.at);
  assert.equal((await c.db.variantGroups.get("cup"))?.name, "Cup Sand");
});

test("choice values are added when allowed; bundles can contain products from the same file", async () => {
  const c = await make();
  await c.attribute({ key: "colour", label: "Colour", type: "choice", options: [{ label: "Blue" }] });
  const job = await upload(c, csv([
    ["sku", "name", "price", "stock", "type", "attr:colour", "bundle_components", "bundle_pricing"],
    ["SET", "Set", "", "", "bundle", "", "M1*2|M2", "sum"],
    ["M1", "Mug", "10", "10", "simple", "Sand", "", ""],
    ["M2", "Plate", "15", "5", "simple", "blue", "", ""],
  ]));
  const p = await preview(c, job.id);
  assert.deepEqual(p.preview.newOptions, { colour: ["Sand"] });
  const done = await commit(c, job.id, p.preview.at);
  assert.equal(done.result.created, 3, JSON.stringify(await rows(c, job.id)));
  const set = (await c.api("GET", "/api/products?q=set&type=bundle")).json().items[0];
  assert.equal(set.price, 35, "sum of 2 × 10 + 15");
  assert.equal(set.extras.available, 5);
  const opts = (await c.api("GET", "/api/attributes")).json()[0].options.map((o: { label: string }) => o.label);
  assert.deepEqual(opts, ["Blue", "Sand"]);
});

test("security: prototype keys, HTML, JSON shape, file limits, one import at a time", async () => {
  const c = await make();
  const evil = await upload(c, csv([["name", "price", "attr:__proto__", "attr:constructor"], ["X", "1", "p", "q"]]));
  assert.deepEqual(Object.values(evil.mapping).sort(), ["ignore", "ignore", "name", "price"].sort().map((x) => x), "reserved names never become properties");
  const json = await upload(c, '{"format":"openshop.catalogue","products":[{"name":"J","price":1,"attributes":{"__proto__":{"polluted":1}}}]}', "application/json", "c.json");
  const pj = await preview(c, json.id);
  assert.equal(pj.preview.errors, 1);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal((await c.api("POST", "/api/catalogue/imports", "{\"products\": 1}", { "content-type": "application/json" })).statusCode, 400);
  assert.equal((await c.api("POST", "/api/catalogue/imports", "not json", { "content-type": "application/json" })).statusCode, 400);
  const big = await c.api("POST", "/api/catalogue/imports", Buffer.alloc(11 * 1024 * 1024, 0x61), { "content-type": "text/csv" });
  assert.equal(big.statusCode, 413);
  assert.equal((await c.api("POST", "/api/products", "x".repeat(2 * 1024 * 1024), { "content-type": "application/json" })).statusCode, 413, "the 10 MB limit is only for the upload");
  assert.equal((await c.app.inject({ method: "POST", url: "/api/catalogue/imports", payload: "a,b", headers: { "content-type": "text/csv" } })).statusCode, 401);
  // The lock: a second commit while one is running.
  const j1 = await upload(c, csv([["name", "price"], ["A", "1"]])), j2 = await upload(c, csv([["name", "price"], ["B", "1"]]));
  const p1 = await preview(c, j1.id), p2 = await preview(c, j2.id);
  await c.db.locks.insert({ id: "catalogue-import", holder: "someone", expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const busy = await c.api("POST", `/api/catalogue/imports/${j1.id}/commit`, { previewAt: p1.preview.at });
  assert.equal(busy.json().code, "import_running");
  await c.db.locks.update("catalogue-import", { expiresAt: new Date(0).toISOString() });
  assert.equal((await commit(c, j1.id, p1.preview.at)).status, "done", "an expired lock is taken over");
  assert.equal((await commit(c, j2.id, p2.preview.at)).status, "done");
});

test("images: existing uploads, server paths only inside IMPORT_MEDIA_DIR (C20), external links kept as links when asked, with a warning", async () => {
  const media = mkdtempSync(join(tmpdir(), "media-"));
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  mkdirSync(join(media, "mugs"));
  writeFileSync(join(media, "mugs", "blue.png"), PNG);
  writeFileSync(join(media, "fake.png"), "<svg onload=alert(1)>");
  writeFileSync(join(outside, "secret.png"), PNG);
  symlinkSync(join(outside, "secret.png"), join(media, "link.png"));
  symlinkSync(outside, join(media, "dir"));
  const c = await make({ importMediaDir: media });
  const up = (await c.api("POST", "/api/uploads", PNG, { "content-type": "image/png" })).json().url;
  const bad = ["../outside/secret.png", join(outside, "secret.png"), "link.png", "dir/secret.png", "fake.png", "mugs\\blue.png", "C:/x.png", "mugs/missing.png", "/uploads/00000000000000000000000000000000.png", "javascript:alert(1)"];
  const file = csv([["sku", "name", "price", "images"], ["OK", "Ok", "1", `${up}|mugs/blue.png|mugs/blue.png|https://cdn.example/x.jpg`], ...bad.map((b, i) => [`B${i}`, `Bad ${i}`, "1", b])]);
  const job = await upload(c, file);
  // Links to other sites are kept as links here (downloads are tested in remote-images.test.ts).
  await c.api("PUT", `/api/catalogue/imports/${job.id}`, { options: { remoteImages: "link" } });
  const p = await preview(c, job.id);
  assert.equal(p.preview.errors, bad.length, "image problems show in the preview");
  assert.ok(p.preview.warnings.some((w: string) => /linked from another site/.test(w)));
  const done = await commit(c, job.id, p.preview.at);
  assert.equal(done.result.created, 1, JSON.stringify(await rows(c, job.id, "&state=failed")));
  const failed = await rows(c, job.id, "&state=failed");
  assert.equal(failed.length, bad.length);
  for (const f of failed) assert.match(f.message, /^images: Image not found or not allowed: /, "one generic message: no way to probe files");
  assert.doesNotMatch(failed.map((f: { message: string }) => f.message).join(), new RegExp(media.replace(/[/\\]/g, ".")), "the folder's absolute path is never shown");
  const ok = (await c.api("GET", "/api/products?q=ok")).json().items[0];
  assert.equal(ok.images.length, 4);
  assert.equal(ok.images[0], up);
  assert.match(ok.images[1], /^\/uploads\/[a-f0-9]{32}\.png$/, "server files are copied into the uploads");
  assert.equal(ok.images[1], ok.images[2], "the same file is stored once");
  assert.equal(ok.images[3], "https://cdn.example/x.jpg");
  assert.ok((await c.db.audit.find({ action: "copy", entity: "image" })).length >= 1);
  // Without IMPORT_MEDIA_DIR, server paths are refused.
  const c2 = await make();
  const j2 = await upload(c2, csv([["name", "price", "images"], ["X", "1", "mugs/blue.png"]]));
  const p2 = await preview(c2, j2.id);
  const d2 = await commit(c2, j2.id, p2.preview.at);
  assert.match((await rows(c2, j2.id))[0].message, /Server image folder not configured/);
  assert.equal(d2.result.failed, 1);
});

test("an interrupted commit resumes without applying rows twice", async () => {
  const c = await make();
  const job = await upload(c, csv([["sku", "name", "price"], ["A", "A", "1"], ["B", "B", "2"]]));
  const p = await preview(c, job.id);
  const [first] = await c.db.importRows.find({ jobId: job.id, rowNo: 1 });
  // Simulate a crash after row 1 was applied.
  await c.api("POST", "/api/products", { name: "A", sku: "A", price: 1 });
  await c.db.importRows.update(first.id, { state: "applied" });
  await c.db.importJobs.update(job.id, { status: "committing" });
  const { importHousekeeping } = await import("../src/catalogue/import/jobs.ts");
  await importHousekeeping(c.db);
  assert.equal((await c.db.importJobs.get(job.id))?.status, "interrupted");
  const done = await commit(c, job.id, p.preview.at);
  assert.equal(done.status, "done");
  assert.equal(done.result.created, 1);
  assert.equal((await c.api("GET", "/api/products")).json().total, 2);
});

test("a full JSON backup restores the catalogue in an empty shop: categories, properties, bundles, variant groups (A-2)", async () => {
  const src = await make();
  await src.attribute({ key: "colour", label: "Colour", type: "choice", options: [{ label: "Blue", swatch: "#1f3b73" }, { label: "Sand" }] });
  await src.attribute({ key: "capacity", label: "Capacity", type: "number", unit: "ml", filterable: true, searchable: true, showOnProduct: true });
  await src.attribute({ key: "cost", label: "Cost", type: "number", visibility: "internal" });
  const cat = (await src.api("POST", "/api/categories", { name: "Mugs", slug: "mugs" })).json();
  const a = await src.product({ name: "Mug blue", sku: "MUG-B", price: 20, categoryId: cat.id, attributes: { colour: "blue", capacity: 350, cost: 4 } });
  const b = await src.product({ name: "Mug sand", sku: "MUG-S", price: 21, categoryId: cat.id, attributes: { colour: "sand" } });
  await src.api("POST", "/api/variant-groups", { name: "Mug", productIds: [a.id, b.id], differentiators: [{ key: "colour" }] });
  await src.product({ name: "Pair", sku: "PAIR", type: "bundle", bundle: { components: [{ productId: a.id, qty: 1 }, { productId: b.id, qty: 1 }] } });
  // A component without a SKU (referred to by id), deleted later while its bundle is kept (L-1).
  const lid = await src.product({ name: "Lid", price: 5 });
  const kit = await src.product({ name: "Kit", sku: "KIT", type: "bundle", active: false, bundle: { components: [{ productId: a.id, qty: 1 }, { productId: lid.id, qty: 1 }] } });
  await src.api("PATCH", `/api/products/${lid.id}`, { active: false });
  assert.equal((await src.api("DELETE", `/api/products/${lid.id}`, { bundles: { [kit.id]: "keep" } })).statusCode, 204);
  const backup = (await src.api("GET", "/api/products?status=visible,hidden,deleted", undefined, { accept: "application/vnd.openshop.catalogue+json" })).body;

  const dst = await make();
  const job = await upload(dst, backup, "application/json", "catalogue.json");
  const p = await preview(dst, job.id);
  assert.deepEqual([p.preview.create, p.preview.errors], [5, 0], JSON.stringify(await rows(dst, job.id, "&action=error")));
  assert.deepEqual(p.preview.newCategories, ["Mugs"]);
  type NP = { key: string; public: boolean; locked: boolean; publicInFile: boolean };
  assert.deepEqual(p.preview.newProperties.map((x: NP) => [x.key, x.public, x.locked, x.publicInFile]),
    [["colour", true, true, true], ["capacity", false, false, true], ["cost", false, false, false]], "only what tells variants apart is public until the owner ticks more (Q-2, option C)");
  // The owner ticks "public in the shop" for Capacity: the file's settings come back with it.
  assert.equal((await dst.api("PUT", `/api/catalogue/imports/${job.id}`, { publish: ["capacity"] })).statusCode, 200);
  const p2 = await preview(dst, job.id);
  assert.deepEqual(p2.preview.newProperties.map((x: NP) => [x.key, x.public]), [["colour", true], ["capacity", true], ["cost", false]]);
  assert.equal((await dst.api("POST", `/api/catalogue/imports/${job.id}/commit`, { previewAt: p.preview.at })).json().code, "preview_changed", "the commit uses the latest preview");
  const done = await commit(dst, job.id, p2.preview.at);
  const defs = Object.fromEntries((await dst.api("GET", "/api/attributes")).json().map((x: { key: string }) => [x.key, x]));
  assert.deepEqual([defs.capacity.visibility, defs.capacity.filterable, defs.capacity.searchable, defs.capacity.unit], ["public", true, true, "ml"]);
  assert.deepEqual([defs.cost.visibility, defs.cost.filterable], ["internal", false]);
  assert.equal(defs.colour.options[0].swatch, "#1f3b73", "swatches come back");
  assert.equal(done.result.created, 5);
  const list = (await dst.api("GET", "/api/products?sort=name&status=visible,hidden")).json().items;
  assert.deepEqual(list.map((x: { name: string }) => x.name), ["Kit", "Mug blue", "Mug sand", "Pair"]);
  assert.equal(list[3].extras.componentsTotal, 41);
  assert.deepEqual(list.map((x: { id: string }) => x.id).sort(), [kit.id, a.id, b.id, list[3].id].sort(), "products keep their ids (links survive)");
  const lidThere = (await dst.api("GET", `/api/products/${lid.id}`)).json();
  assert.deepEqual([lidThere.name, !!lidThere.deletedAt, lidThere.active], ["Lid", true, false], "deleted in the backup: in Deleted products");
  assert.deepEqual((await dst.api("GET", `/api/products/${kit.id}`)).json().bundle.components.map((x: { productId: string }) => x.productId), [a.id, lid.id]);
  // The same backup again: nothing changes, the deleted product stays deleted.
  const again = await preview(dst, (await upload(dst, backup, "application/json", "catalogue.json")).id);
  assert.deepEqual([again.preview.create, again.preview.update, again.preview.errors, again.preview.undecided], [0, 0, 0, 0]);
  assert.equal(list[1].variantGroupId, "mug");
  const page = (await dst.app.inject({ url: `/shop/product/${list[1].id}` })).body;
  assert.match(page, /<a class="os-vb" href="\/shop\/product\/[^"]+" aria-label="Colour: Sand">Sand<\/a>/, "the variant selector works in the new shop");
  assert.equal((await dst.app.inject({ url: "/shop/category/mugs" })).statusCode, 200);
});

test("a CSV export of deleted products, imported: a product the shop doesn't have goes to Deleted products; a live one is left as it is", async () => {
  const src = await make();
  const old = await src.product({ name: "Old vase", sku: "VASE-OLD", price: 30, active: false });
  await src.api("DELETE", `/api/products/${old.id}`);
  const file = (await src.api("GET", "/api/products?status=deleted", undefined, { accept: "text/csv" })).body;
  assert.match(file.split("\r\n")[0], /,deleted$/);
  const dst = await make();
  const live = await dst.product({ name: "Live vase", sku: "VASE-LIVE", price: 9 });
  const head = file.replace(/^\uFEFF/, "").split("\r\n")[0].split(",");
  const liveRow = head.map((h) => ({ sku: "VASE-LIVE", name: "Live vase", price: "9", deleted: "yes" } as Record<string, string>)[h] ?? "");
  const job = await upload(dst, file + csv([liveRow]) + "\r\n");
  const p = await preview(dst, job.id);
  const r = await rows(dst, job.id);
  assert.deepEqual(r.map((x: { action: string }) => x.action), ["create", "unchanged"], JSON.stringify(r));
  assert.deepEqual(r[1].warnings, ["deleted in the file: left as it is (an import never deletes)"]);
  await commit(dst, job.id, p.preview.at);
  assert.ok((await dst.api("GET", `/api/products/${old.id}`)).json().deletedAt, "in Deleted products, with its id");
  assert.equal((await dst.api("GET", `/api/products/${live.id}`)).json().deletedAt ?? null, null);
});

test("configuring an import: presets, checked mappings, new property types, cancel and the job list", async () => {
  const c = await make();
  const file = ["Product ID;Active (0/1);Name *;Categories (x,y,z...);Price tax excluded;Reference #;Quantity;Description;Image URLs (x,y,z...);Colour",
    '1;1;PrestaShop Mug;Home,Mugs;12,5;PS-1;3;"<p>Nice <b>mug</b></p>";;Blue'].join("\n");
  const job = await upload(c, file, "text/csv", "presta.csv");
  assert.equal(job.preset, "prestashop");
  assert.deepEqual([job.mapping["Name *"], job.mapping["Reference #"], job.mapping["Price tax excluded"], job.mapping["Product ID"]], ["name", "sku", "price", "ignore"]);
  const bad = await c.api("PUT", `/api/catalogue/imports/${job.id}`, { mapping: { "Name *": "name", Quantity: "name", Nope: "sku", Colour: "attr:unknown" } });
  assert.equal(bad.statusCode, 400);
  assert.deepEqual(bad.json().fields.map((f: { field: string }) => f.field).sort(), ["Colour", "Nope", "Quantity"]);
  const ok = await c.api("PUT", `/api/catalogue/imports/${job.id}`, { mapping: { ...job.mapping, Colour: "new:Colour" }, newProperties: { Colour: { type: "choice" } }, options: { createCategories: true } });
  assert.deepEqual(ok.json().newProperties, { Colour: { label: "Colour", type: "choice" } });
  const p = await preview(c, job.id);
  assert.deepEqual([p.preview.create, p.preview.errors], [1, 0], JSON.stringify(await rows(c, job.id)));
  assert.deepEqual(p.preview.newCategories, ["Mugs"], "PrestaShop: the last category of the list");
  const r = (await rows(c, job.id))[0];
  assert.match(r.warnings.join(), /HTML in the description was converted/);
  const done = await commit(c, job.id, p.preview.at);
  assert.equal(done.result.created, 1);
  const made = (await c.api("GET", "/api/products?q=prestashop")).json().items[0];
  assert.deepEqual([made.price, made.sku, made.active, made.description, made.attributes.colour], [12.5, "PS-1", true, "Nice mug", "blue"]);
  assert.equal((await c.db.attributes.get("colour"))?.type, "choice");
  // preset back to "any spreadsheet", cancel, list
  const j2 = await upload(c, file, "text/csv", "again.csv");
  assert.equal((await c.api("PUT", `/api/catalogue/imports/${j2.id}`, { preset: null })).json().mapping["Name *"], "ignore");
  assert.equal((await c.api("POST", `/api/catalogue/imports/${j2.id}/cancel`)).statusCode, 200);
  assert.equal((await c.api("POST", `/api/catalogue/imports/${job.id}/cancel`)).statusCode, 409, "an applied import can't be cancelled");
  const list = (await c.api("GET", "/api/catalogue/imports")).json();
  assert.deepEqual(list.map((x: { status: string }) => x.status).sort(), ["cancelled", "done"]);
  assert.equal(list[0].mapping, undefined, "the list is short");
  assert.equal((await c.api("GET", "/api/catalogue/imports/missing")).statusCode, 404);
});

test("new products are visible by default (as in the product editor); a visible column decides per product", async () => {
  const c = await make();
  const job = await upload(c, csv([["sku", "name", "price", "visible"], ["V1", "Shown", "1", ""], ["V2", "Kept back", "1", "no"]]));
  assert.equal(job.options.newVisible, true);
  const p = await preview(c, job.id);
  await commit(c, job.id, p.preview.at);
  const items = (await c.api("GET", "/api/products?sort=name")).json().items;
  assert.deepEqual(items.map((x: { name: string; active: boolean }) => [x.name, x.active]), [["Kept back", false], ["Shown", true]]);
});

test("the screens show the limits configured on this server", async () => {
  const c = await make();
  assert.deepEqual((await c.api("GET", "/api/catalogue/limits")).json(), { importMaxMb: 10, importMaxRows: 20000, uploadMaxMb: 5 });
  assert.equal((await c.app.inject({ url: "/api/catalogue/limits" })).statusCode, 401, "admin only");
});

test("the preview shows joining a variant group as a change", async () => {
  const c = await make();
  await c.attribute({ key: "colour", label: "Colour", type: "text" });
  await c.product({ name: "Cup Sand", sku: "C1", price: 10, attributes: { colour: "Sand" } });
  const job = await upload(c, csv([["sku", "name", "price", "attr:colour", "variant_group", "variant_by", "variant_position"], ["C2", "Cup Sage", "10", "Sage", "cup", "colour", "1"], ["C1", "", "", "", "cup", "colour", "0"]]));
  await preview(c, job.id);
  const r = await rows(c, job.id);
  assert.equal(r[1].action, "update");
  assert.deepEqual(r[1].diff, { variantGroupId: [null, "cup"], variantPosition: [null, 0] });
  const done = await commit(c, job.id, (await c.api("GET", `/api/catalogue/imports/${job.id}`)).json().preview.at);
  assert.deepEqual([done.result.created, done.result.updated, done.result.unchanged], [1, 1, 0], "joining a group counts as an update");
});

test("a new property from a CSV column can be made public in the preview; it is then shown on product pages", async () => {
  const c = await make();
  const job = await upload(c, csv([["sku", "name", "price", "attr:Finish", "attr:Supplier"], ["F1", "Cup", "10", "Matte", "ACME"]]));
  await c.api("PUT", `/api/catalogue/imports/${job.id}`, { publish: ["finish", "__proto__", "Bad Key"] });
  const p = await preview(c, job.id);
  assert.deepEqual(p.preview.newProperties.map((x: { key: string; public: boolean; publicInFile: boolean }) => [x.key, x.public, x.publicInFile]), [["finish", true, false], ["supplier", false, false]]);
  await commit(c, job.id, p.preview.at);
  const defs = Object.fromEntries((await c.api("GET", "/api/attributes")).json().map((x: { key: string }) => [x.key, x]));
  assert.deepEqual([defs.finish.visibility, defs.finish.showOnProduct, defs.finish.filterable, defs.supplier.visibility], ["public", true, false, "internal"]);
  const audit = (await c.db.audit.find({ entity: "attribute" })).map((a) => a.entityId);
  assert.deepEqual(audit.sort(), ["finish", "supplier"], "both creations are audited");
});

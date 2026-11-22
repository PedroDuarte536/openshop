// Shop search, category and "all products" pages (plan §2.5.6): filters with counts, chips, sorting, paging, no-JS
// forms, SEO tags, caching; the visitor's own prices only through the JSON search (S-2a); privacy (C2, C22, C23).
import { test } from "node:test";
import assert from "node:assert/strict";
import { make, signedInCustomer } from "./catalogue-helpers.ts";

type C = Awaited<ReturnType<typeof make>>;
async function shop(c: C) {
  await c.attribute({ key: "colour", label: "Colour", type: "choice", options: [{ label: "Sand", swatch: "#d8c3a5" }, { label: "Ink blue" }] });
  await c.attribute({ key: "supplier", label: "Supplier", type: "text", visibility: "internal" });
  await c.attribute({ key: "material", label: "Material", type: "text", filterable: false, showOnProduct: true });
  const mugs = (await c.api("POST", "/api/categories", { name: "Mugs", slug: "mugs" })).json();
  const bowls = (await c.api("POST", "/api/categories", { name: "Bowls", slug: "bowls" })).json();
  const p = {
    mug: await c.product({ name: "Stoneware Mug", price: 24, categoryId: mugs.id, attributes: { colour: "sand", supplier: "Acme Kilns", material: "Stoneware" }, description: "Glazed by hand" }),
    blue: await c.product({ name: "Ink Mug", price: 18, categoryId: mugs.id, stock: 0, attributes: { colour: "ink-blue" } }),
    bowl: await c.product({ name: "Stoneware Bowl", price: 38, categoryId: bowls.id, attributes: { colour: "ink-blue" } }),
    secret: await c.product({ name: "Secret Prototype Mug", price: 99, categoryId: mugs.id, active: false, attributes: { colour: "sand" } }),
  };
  return { mugs, bowls, p };
}

test("category and search pages: filters with counts, chips, sort and paging, all as plain links and GET forms", async () => {
  const c = await make();
  const { p } = await shop(c);
  const page = await c.app.inject({ url: "/shop/category/mugs?f.colour=sand" });
  assert.equal(page.statusCode, 200);
  assert.equal(page.headers["cache-control"], "public, max-age=60", "nothing personal: cacheable");
  const html = page.body;
  assert.match(html, /<form method="get" action="\/shop\/category\/mugs" data-os-filters>/);
  assert.match(html, /<input type="checkbox" name="f.colour" value="sand" checked><i class="os-vsw" style="background:#d8c3a5"><\/i><span>Sand<\/span><small>1<\/small>/);
  assert.match(html, /name="f.colour" value="ink-blue"><span>Ink blue<\/span><small>1<\/small>/, "counts ignore the filter's own selection (the ink mug)");
  assert.match(html, /Stoneware Mug/);
  assert.doesNotMatch(html, /Ink Mug<\/div>/, "filtered out");
  assert.match(html, /<a class="os-chip" href="\/shop\/category\/mugs">Sand/, "the chip removes the filter");
  assert.match(html, /<meta name="robots" content="noindex,follow"><link rel="canonical" href="\/shop\/category\/mugs">/);
  assert.doesNotMatch((await c.app.inject({ url: "/shop/category/mugs" })).body, /noindex/, "the plain page can be indexed");
  // No category filter on a category page; the search page has one.
  assert.doesNotMatch(html, /name="category"/);
  const search = (await c.app.inject({ url: "/search?q=stonewre" })).body;
  assert.match(search, /Showing results for <b>stoneware<\/b>/);
  assert.match(search, /name="category" value="bowls"><span>Bowls<\/span><small>1<\/small>/);
  assert.match(search, /<input type="hidden" name="q" value="stonewre">/, "the filter form keeps the words");
  // Sorting (list prices in the HTML) and availability.
  const sorted = (await c.app.inject({ url: "/shop?sort=-price" })).body;
  assert.ok(sorted.indexOf("Stoneware Bowl") < sorted.indexOf("Stoneware Mug") && sorted.indexOf("Stoneware Mug") < sorted.indexOf("Ink Mug"));
  assert.match(sorted, /<option value="-price" selected>/);
  assert.match(sorted, /data-os-search="sort=-price" data-os-cols="3"/, "price order: the storefront script asks for the visitor's own order");
  assert.match(sorted, /<noscript><p class="os-msg">Sorted by list price/);
  const inStock = (await c.app.inject({ url: "/shop?stock=in" })).body;
  assert.doesNotMatch(inStock, /Ink Mug<\/div>/);
  assert.match((await c.app.inject({ url: "/shop" })).body, /Ink Mug<\/div><div class="os-pc-p" data-os-price="[^"]+">€18\.00<\/div><div class="os-pc-s">Out of stock<\/div>/);
  void p;
});

test("paging: 24 per page with numbered links; price range filter and its chip", async () => {
  const c = await make();
  for (let i = 0; i < 30; i++) await c.product({ name: `Cup ${String(i).padStart(2, "0")}`, price: 10 + i });
  const one = (await c.app.inject({ url: "/shop" })).body;
  assert.equal((one.match(/class="os-pc"/g) ?? []).length, 24);
  assert.match(one, /<nav class="os-pager" aria-label="Pages" data-os-pager><span aria-disabled="true">← Previous<\/span><span aria-current="page">1<\/span><a href="\/shop\?page=2">2<\/a><a href="\/shop\?page=2" rel="next">Next →<\/a><\/nav>/);
  const two = (await c.app.inject({ url: "/shop?page=2" })).body;
  assert.equal((two.match(/class="os-pc"/g) ?? []).length, 6);
  assert.match(two, /<meta name="robots" content="noindex,follow">/);
  const range = (await c.app.inject({ url: "/shop?min=15&max=20,50" })).body;
  assert.equal((range.match(/class="os-pc"/g) ?? []).length, 6);
  assert.match(range, /<a class="os-chip" href="\/shop">€15 – €20\.50/);
  assert.match((await c.app.inject({ url: "/shop?page=99" })).body, /No products to show yet|class="os-pg/);
});

test("privacy: hidden products and internal properties never show, count or match (C2); HTML is the same for everyone", async () => {
  const c = await make();
  const { p } = await shop(c);
  const all = (await c.app.inject({ url: "/shop" })).body;
  assert.doesNotMatch(all, /Secret|Prototype|Acme|Supplier/);
  assert.match(all, /value="sand"><i class="os-vsw" style="background:#d8c3a5"><\/i><span>Sand<\/span><small>1<\/small>/, "the hidden sand mug isn't counted");
  assert.doesNotMatch(all, /name="f.material"/, "not filterable");
  for (const q of ["acme", "secret", "protoype"]) assert.match((await c.app.inject({ url: `/search?q=${q}` })).body, /Nothing matches/);
  // A VIP price makes no difference to the page itself (S-2a).
  const vip = await signedInCustomer(c, "vip@x.io");
  await c.api("POST", "/api/discounts", { name: "VIP", label: "VIP", audience: { type: "customers", customerIds: [vip.customer.id] }, access: { requiresSignIn: true }, target: { type: "products", productIds: [p.bowl.id] }, effect: { type: "fixedPrice", cents: 500 } });
  const anon = (await c.app.inject({ url: "/shop?sort=price" })).body;
  const signed = (await c.app.inject({ url: "/shop?sort=price", headers: { cookie: vip.cookie } })).body;
  assert.equal(signed, anon, "signed-in and anonymous visitors get the same HTML");
  assert.doesNotMatch(signed, /VIP|€5\.00/, "no discount data in HTML");
});

test("the visitor's own prices: JSON search for price sorting and filtering, private, same prices as the cards (S-2a, C23)", async () => {
  const c = await make();
  const { p } = await shop(c);
  const vip = await signedInCustomer(c, "vip@x.io");
  await c.api("POST", "/api/discounts", { name: "VIP", label: "VIP", audience: { type: "customers", customerIds: [vip.customer.id] }, access: { requiresSignIn: true }, target: { type: "products", productIds: [p.bowl.id] }, effect: { type: "fixedPrice", cents: 500 } });
  const anon = await c.app.inject({ url: "/api/shop/search?sort=price" });
  assert.equal(anon.headers["cache-control"], "private, no-store");
  assert.equal(anon.headers["vary"], "Cookie");
  assert.deepEqual(anon.json().items.map((x: { name: string }) => x.name), ["Ink Mug", "Stoneware Mug", "Stoneware Bowl"]);
  const mine = await c.app.inject({ url: "/api/shop/search?sort=price", headers: { cookie: vip.cookie } });
  assert.deepEqual(mine.json().items.map((x: { name: string; priceCents: number }) => [x.name, x.priceCents]), [["Stoneware Bowl", 500], ["Ink Mug", 1800], ["Stoneware Mug", 2400]]);
  const filtered = await c.app.inject({ url: "/api/shop/search?max=10", headers: { cookie: vip.cookie } });
  assert.deepEqual(filtered.json().items.map((x: { name: string }) => x.name), ["Stoneware Bowl"], "the price filter uses the visitor's price");
  assert.equal((await c.app.inject({ url: "/api/shop/search?max=10" })).json().total, 0, "anonymous visitors never see the VIP price");
  // Exactly the prices the cards show.
  const cards = await c.app.inject({ url: `/api/shop/prices?ids=${p.bowl.id}`, headers: { cookie: vip.cookie } });
  assert.equal(cards.json().items[0].priceCents, 500);
  const plain = await c.app.inject({ url: "/api/shop/search?q=mug" });
  assert.equal(plain.headers["cache-control"], "public, max-age=60", "without price sorting nothing is personal");
  assert.doesNotMatch(plain.body, /Secret|priceCents":5/);
});

test("searches are rate limited per visitor", async () => {
  const c = await make();
  let last = 0;
  for (let i = 0; i < 70; i++) last = (await c.app.inject({ url: "/search?q=x", remoteAddress: "10.0.0.9" })).statusCode;
  assert.equal(last, 429);
  assert.equal((await c.app.inject({ url: "/search?q=x", remoteAddress: "10.0.0.10" })).statusCode, 200, "other visitors are not affected");
});

test("product pages: public details, bundle contents and savings, and the bundles a product is in", async () => {
  const c = await make();
  const { p } = await shop(c);
  const page = (await c.app.inject({ url: `/shop/product/${p.mug.id}` })).body;
  assert.match(page, /<dt>Colour<\/dt><dd>Sand<\/dd>/);
  assert.match(page, /<dt>Material<\/dt><dd>Stoneware<\/dd>/);
  assert.doesNotMatch(page, /Supplier|Acme/, "internal properties never reach the shop");
  const set = await c.product({ name: "Breakfast set", type: "bundle", bundle: { components: [{ productId: p.mug.id, qty: 2 }, { productId: p.secret.id, qty: 1 }], priceMode: "manual" }, price: 120 });
  const hiddenSet = await c.product({ name: "Hidden set", type: "bundle", active: false, bundle: { components: [{ productId: p.mug.id, qty: 1 }, { productId: p.bowl.id, qty: 1 }] } });
  const optOut = await c.product({ name: "Quiet set", type: "bundle", bundle: { components: [{ productId: p.mug.id, qty: 1 }, { productId: p.bowl.id, qty: 1 }], showOnComponents: false } });
  const setPage = (await c.app.inject({ url: `/shop/product/${set.id}` })).body;
  assert.match(setPage, /<span class="os-bc-q">2 ×<\/span> <span class="os-bc-n"><a href="\/shop\/product\/[^"]+">Stoneware Mug<\/a><\/span>/);
  assert.match(setPage, /<span class="os-bc-q">1 ×<\/span> <span class="os-bc-n">Secret Prototype Mug<\/span>/, "hidden components are listed without a link");
  assert.match(setPage, /Save €27\.00 compared with buying separately/, "2 × 24 + 99 = 147, sold at 120");
  assert.match(setPage, /max="5"/, "limited by the components' stock: 10 mugs, 2 per set");
  const mugPage = (await c.app.inject({ url: `/shop/product/${p.mug.id}` })).body;
  const inBundles = /<section class="os-inb[^>]*>([\s\S]*?)<\/section>/.exec(mugPage)?.[1] ?? "";
  assert.match(inBundles, /As seen in these bundles[\s\S]*Breakfast set/);
  assert.doesNotMatch(inBundles, /Hidden set|Quiet set/, "hidden bundles and bundles that opted out are not listed");
  void hiddenSet; void optOut;
});

test("number filters: values in numeric order with their unit once, in the shop and in the backoffice", async () => {
  const c = await make();
  await c.attribute({ key: "capacity", label: "Capacity", type: "number", unit: "ml", filterable: true });
  for (const [name, ml] of [["Big", 900], ["Small", 90], ["Mid", 350]] as const) await c.product({ name, price: 10, attributes: { capacity: ml } });
  const html = (await c.app.inject({ url: "/shop" })).body;
  const labels = [...html.matchAll(/name="f\.capacity" value="\d+"><span>([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(labels, ["90 ml", "350 ml", "900 ml"]);
  const admin = (await c.api("GET", "/api/products")).json().facets.attributes.find((a: { key: string }) => a.key === "capacity");
  assert.deepEqual(admin.values.map((v: { label: string }) => v.label), ["90 ml", "350 ml", "900 ml"]);
});

test("suggestions while typing: products and categories from public data only, cacheable, rate limited (C-10, C2)", async () => {
  const c = await make();
  await shop(c);
  const get = (q: string) => c.app.inject({ url: `/api/shop/suggest?q=${encodeURIComponent(q)}` });
  const r = await get("stonew");
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers["cache-control"], "public, max-age=60");
  const body = r.json();
  assert.deepEqual(body.products.map((p: { name: string }) => p.name).sort(), ["Stoneware Bowl", "Stoneware Mug"]);
  assert.ok(body.products.every((p: { href: string }) => /^\/shop\/product\/[\w-]+$/.test(p.href)));
  assert.deepEqual(body.categories.map((x: { slug: string; count: number }) => [x.slug, x.count]).sort(), [["bowls", 1], ["mugs", 1]]);
  assert.equal(JSON.stringify(body).includes("price"), false, "no prices: the same answer for everyone");
  assert.equal((await get("stonewre")).json().corrected, "stoneware");
  assert.deepEqual((await get("secret")).json().products, [], "hidden products are never suggested");
  assert.deepEqual((await get("acme")).json().products, [], "internal properties never match");
  assert.deepEqual((await get("m")).json(), { q: "m", products: [], categories: [], corrected: null }, "at least 2 characters");
  let limited = 0;
  for (let i = 0; i < 140; i++) if ((await get("mug")).statusCode === 429) limited++;
  assert.ok(limited > 0, "rate limited per visitor");
});

test("searches with no results are counted per day without personal data, and reported with what they find now", async () => {
  const c = await make();
  await shop(c);
  const search = (q: string, extra = "", ip = "10.0.0.1") => c.app.inject({ url: `/search?q=${encodeURIComponent(q)}${extra}`, remoteAddress: ip });
  await search("teapot"); await search("Teapot "); await search("teapot", "", "10.0.0.2");
  await search("teapot", "&f.colour=sand"); // filters: not a "no results" search
  await search("mug"); // found something
  await search("jane@example.com"); await search("call 0612 345 678"); // personal data is never kept
  await search("=HYPERLINK(\"http://x\")");
  await search("secret"); // only a hidden product has this word: for shoppers, nothing
  await new Promise((r) => setTimeout(r, 50));
  const stored = (await c.db.searchMisses.find({})).map((m) => [m.q, m.count]).sort();
  assert.deepEqual(stored, [["=hyperlink(\"http://x\")", 1], ["secret", 1], ["teapot", 3]]);
  assert.equal(JSON.stringify(await c.db.searchMisses.find({})).includes("10.0.0"), false, "no IP addresses");
  // A visitor can add only a few a minute.
  for (let i = 0; i < 30; i++) await search(`flood ${i}`, "", "10.9.9.9");
  await new Promise((r) => setTimeout(r, 50));
  assert.ok((await c.db.searchMisses.count({})) <= 3 + 10, "per-visitor limit");

  await c.product({ name: "Teapot", price: 30 });
  const report = (await c.api("GET", "/api/reports/search-misses")).json();
  const teapot = report.items.find((i: { q: string }) => i.q === "teapot");
  assert.deepEqual([teapot.count, teapot.days, teapot.findsNow], [3, 1, 1], "what the words find today");
  assert.equal(report.items.find((i: { q: string }) => i.q === "secret").findsNow, 0, "hidden products don't count");
  const csv = await c.api("GET", "/api/reports/search-misses", undefined, { accept: "text/csv" });
  assert.match(csv.body, /"'=hyperlink/, "formula-safe CSV");
  assert.equal((await c.app.inject({ url: "/api/reports/search-misses" })).statusCode, 401);
});

// Catalogue widgets: filters, results bar, paging, product details, bundle contents, "in bundles" and variants.
// Everything from the shop's data is escaped, and every link must be one the server could have built (C5, C16).
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPage, newWidget, SYSTEM_PAGES, normalizeDoc, type PageDoc, type RenderContext, type SearchState } from "../src/index.ts";

const page = (...widgets: unknown[]): PageDoc => ({ title: "T", nodes: [{ id: "s1", type: "section", children: [{ id: "c1", type: "column", children: widgets }] }] } as PageDoc);
const XSS = `</style><script>alert(1)</script>"'<img src=x onerror=alert(1)>`;
const state = (over: Partial<SearchState> = {}): SearchState => ({
  path: "/search", keep: [["q", XSS]], total: 2, page: 2, pages: 3, sort: "price",
  sorts: [{ value: "relevance", label: "Best match" }, { value: "price", label: XSS }],
  facets: [{ key: "colour", label: XSS, param: "f.colour", options: [{ value: `x"><script>`, label: XSS, count: 3, selected: true, swatch: "red;background:url(javascript:x)" }, { value: "b", label: "B", count: 1, selected: false, swatch: "#123456" }] }],
  price: { min: 10, max: null, bounds: { min: 5, max: 50 } }, inStock: { selected: true, count: 7 },
  chips: [{ label: XSS, href: "javascript:alert(1)" }, { label: "ok", href: "/search?q=mug&f.colour=b" }], clearHref: "//evil.example/x",
  pageLinks: [{ n: 1, href: "/search?q=x", current: false }, { n: 2, href: "/search?q=x&page=2", current: true }, { n: 3, href: "data:text/html,x", current: false }],
  prevHref: "/search?q=x", nextHref: "/search?q=x&page=3", corrected: XSS, personal: `sort=price&q=${encodeURIComponent(XSS)}`, ...over,
});
const results = [{ id: "p1", name: XSS, price: 12, href: "/shop/product/p1", soldOut: true }];
/** No markup from the data: no script or img elements, and no dangerous link targets or inline handlers in attributes. */
const noScript = (html: string) => {
  const h = html.replace(/<script src="\/assets\/shop\.js" defer><\/script>/, "");
  assert.doesNotMatch(h, /<script|<img src=x/i);
  assert.doesNotMatch(h, /(href|src|action|style)="[^"]*(javascript:|data:text|\/\/evil)/i);
  // Attribute values are escaped (no raw quotes inside), so removing them leaves only real attribute names.
  assert.doesNotMatch(h.replace(/="[^"]*"/g, '=""'), /<[^>]+\son[a-z]+=/i, "no event handler attributes");
};

test("filters, results bar and paging: GET forms and server-built links only; everything escaped", () => {
  const ctx: RenderContext = { query: "mug", results, search: state() };
  const html = renderPage(page(newWidget("searchFilters"), newWidget("resultsBar"), { ...newWidget("productGrid"), props: { source: "results", limit: 24, cols: 3, paginate: true } }), { context: ctx, shopScript: true });
  noScript(html);
  assert.match(html, /<form method="get" action="\/search" data-os-filters>/);
  assert.match(html, /<input type="hidden" name="q" value="&lt;\/style&gt;&lt;script&gt;/);
  assert.match(html, /<input type="checkbox" name="f.colour" value="x&quot;&gt;&lt;script&gt;" checked>/);
  assert.doesNotMatch(html, /background:red/, "unsafe swatch dropped");
  assert.match(html, /<i class="os-vsw" style="background:#123456">/);
  assert.match(html, /name="min" min="0" step="0.01" inputmode="decimal" placeholder="€5.00" value="10"/);
  assert.match(html, /name="stock" value="in" checked><span>In stock<\/span><small>7<\/small>/);
  assert.match(html, /<a class="os-chip" href="#">/, "unsafe chip link neutralised");
  assert.match(html, /<a class="os-chip" href="\/search\?q=mug&amp;f.colour=b">ok/);
  assert.match(html, /<a class="os-chip os-chip--clear" href="#">Clear all/, "protocol-relative link refused");
  assert.match(html, /<p class="os-rcount" data-os-count>2 products<\/p>/);
  assert.match(html, /<select name="sort" aria-label="Sort by"><option value="relevance">Best match<\/option><option value="price" selected>&lt;\/style&gt;/);
  assert.match(html, /<input type="hidden" name="f.colour" value="x&quot;&gt;&lt;script&gt;"><input type="hidden" name="min" value="10"><input type="hidden" name="stock" value="in">/, "sorting keeps the filters");
  assert.match(html, /<a href="\/search\?q=x" rel="prev">← Previous<\/a><a href="\/search\?q=x">1<\/a><span aria-current="page">2<\/span><a href="#">3<\/a>/);
  assert.match(html, /data-os-search="sort=price&amp;q=%3C%2Fstyle%3E/, "the personal-results hook is an escaped query string");
  assert.match(html, /Showing results for <b>&lt;\/style&gt;/);
  assert.match(html, /<div class="os-pc-s">Out of stock<\/div>/);
});

test("no results: helpful messages; with filters, a link to remove them", () => {
  const grid = { ...newWidget("productGrid"), props: { source: "results", limit: 24, cols: 3, paginate: true } };
  const none = renderPage(page(grid), { context: { query: "zz", results: [], search: state({ personal: null, chips: [{ label: "x", href: "/search?q=zz" }], clearHref: "/search?q=zz" }) } });
  assert.match(none, /Nothing matches “zz” with these filters\. Try a different search or <a href="\/search\?q=zz">remove the filters<\/a>/);
  const plain = renderPage(page(grid), { context: { query: "", results: [], search: state({ personal: null, chips: [] }) } });
  assert.match(plain, /No products to show yet/);
  assert.equal(renderPage(page(newWidget("searchFilters")), {}).includes('class="os-filters'), false, "outside search pages the widget renders nothing");
});

test("product details, bundle contents, bundles containing the product, variants", () => {
  const ctx: RenderContext = {
    product: {
      id: "p1", name: "Mug", price: 24, specs: [{ label: XSS, value: XSS }],
      bundle: { components: [{ name: XSS, qty: 2, href: "/shop/product/a1" }, { name: "Hidden", qty: 1, href: "javascript:alert(1)" }, { name: "Plain", qty: 1 }], savings: 11 },
      inBundles: [{ id: "b1", name: "Set", price: 59, href: "/shop/product/b1" }],
      variants: [
        { label: "Colour", badges: [{ label: "White", state: "selected", swatch: "#ffffff" }, { label: "Black", state: "link", href: "/shop/product/p2", soldOut: true }] },
        { label: XSS, badges: [{ label: "Male", state: "disabled" }, { label: "X", state: "link", href: "https://evil.example" }] },
      ],
    },
  };
  const html = renderPage(page(newWidget("productSpecs"), newWidget("bundleContents"), newWidget("productBundles"), newWidget("productVariants")), { context: ctx, shopScript: true });
  noScript(html);
  assert.match(html, /<dt>&lt;\/style&gt;&lt;script&gt;/);
  assert.match(html, /<span class="os-bc-q">2 ×<\/span> <span class="os-bc-n"><a href="\/shop\/product\/a1">&lt;\/style&gt;/);
  assert.match(html, /<a href="#">Hidden<\/a>/, "only product links");
  assert.match(html, /Save €11\.00 compared with buying separately/);
  assert.match(html, /As seen in these bundles[\s\S]*<a class="os-pc" href="\/shop\/product\/b1">/);
  assert.match(html, /<span class="os-vb is-selected" aria-current="true"><i class="os-vsw" style="background:#ffffff"><\/i>White<\/span>/);
  assert.match(html, /<a class="os-vb" href="\/shop\/product\/p2" aria-label="Colour: Black, sold out">Black<small class="os-vso"> · sold out<\/small><\/a>/);
  assert.match(html, /<span class="os-vb is-disabled is-faded" aria-disabled="true">Male<span class="os-sr"> \(not available with the current choices\)<\/span><\/span>/, "disabled: not a link");
  assert.match(html, /<a class="os-vb" href="#"/, "links to other sites are refused");
  assert.match(html, /role="group" aria-labelledby="vn[^"]*-1"><span class="os-var-l" id="vn[^"]*-1">&lt;\/style&gt;/);
});

test("the editor shows sample data for every new widget; templates include them", () => {
  const html = renderPage(page(newWidget("searchFilters"), newWidget("resultsBar"), newWidget("productSpecs"), newWidget("bundleContents"), newWidget("productBundles"), newWidget("productVariants")), { editor: true });
  for (const s of ["Ink blue", "38 products", "Stoneware", "What&#39;s in the set", "Breakfast set", "Temperature"]) assert.ok(html.includes(s), s);
  assert.match(html, /is-disabled is-faded" aria-disabled="true">Male/, "the owner's example, Product 1");
  const types = (key: string) => JSON.stringify(SYSTEM_PAGES.find((p) => p.key === key)!.build());
  for (const t of ["searchFilters", "resultsBar", '"paginate":true']) assert.ok(types("category").includes(t) && types("search").includes(t), t);
  for (const t of ["productSpecs", "productVariants", "bundleContents", "productBundles"]) assert.ok(types("product").includes(t), t);
  const clean = normalizeDoc(page({ id: "w1", type: "searchFilters", props: { layout: "evil", maxValues: 500, heading: XSS.repeat(5) } }));
  const props = clean.nodes[0].children![0].children![0].props;
  assert.deepEqual([props.layout, props.maxValues, String(props.heading).length], ["sidebar", 20, 60]);
});

test("result pages can be kept out of search engines, with a canonical link", () => {
  const html = renderPage(page(newWidget("heading")), { meta: { noindex: true, canonical: "/shop/category/mugs" } });
  assert.match(html, /<meta name="robots" content="noindex,follow"><link rel="canonical" href="\/shop\/category\/mugs">/);
  assert.doesNotMatch(renderPage(page(newWidget("heading")), { meta: { canonical: "javascript:x" } }), /canonical/);
});

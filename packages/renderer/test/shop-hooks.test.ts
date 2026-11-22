import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPage, renderDocument, renderParts, newWidget, WIDGETS, SYSTEM_PAGES, type Node } from "../src/index.ts";

const sec = (children: Node[]): Node => ({ id: "s1", type: "section", props: {}, style: {}, children: [{ id: "c1", type: "column", props: {}, style: {}, children }] });
const grid: Node = { id: "g1", type: "productGrid", props: { limit: 4 }, style: {} };
const price: Node = { id: "p1", type: "productPrice", props: {}, style: {} };
const offers: Node = { id: "o1", type: "productOffers", props: { heading: 'Deals "now"' }, style: {} };

test("the shop script is opt-in: never in editor canvases or thumbnails", () => {
  const doc = { title: "T", nodes: [sec([grid])] };
  assert.doesNotMatch(renderPage(doc), /<script/, "default (thumbnails) has no script");
  assert.doesNotMatch(renderPage(doc, { editor: true, shopScript: true }), /<script/, "never in the editor");
  const pub = renderPage(doc, { shopScript: true, products: () => [{ id: "p-1", name: "Mug", price: 24 }] });
  assert.match(pub, /<meta name="os-currency" content="€"><script src="\/assets\/shop\.js" defer><\/script>/);
  assert.match(renderDocument("Cart", "<p>x</p>", {}, { shopScript: true }), /\/assets\/shop\.js/);
  assert.doesNotMatch(renderDocument("Cart", "<p>x</p>"), /<script/);
});

test("real products get price hooks; no discount data is rendered", () => {
  const html = renderPage({ title: "T", nodes: [sec([grid])] }, { shopScript: true, products: () => [{ id: 'p"1', name: "Mug", price: 24 }] });
  assert.match(html, /<div class="os-pc-p" data-os-price="p&quot;1">€24\.00<\/div>/);
  const body = renderParts({ title: "T", nodes: [sec([grid])] }, { products: () => [{ id: "p1", name: "Mug", price: 24 }] }).body;
  assert.doesNotMatch(body, /os-was|os-badge|os-now/, "real products never get sale markup from the renderer");
  const product = renderPage({ title: "T", nodes: [sec([price, offers])] }, { shopScript: true, context: { product: { id: "abc", name: "Mug", price: 24 } } });
  assert.match(product, /data-os-price="abc">€24\.00</);
  assert.match(product, /data-os-offers="abc" data-heading="Deals &quot;now&quot;" aria-live="polite" hidden><\/div>/);
});

test("the editor shows a sample sale so designers can style it, without hooks", () => {
  const parts = renderParts({ title: "T", nodes: [sec([grid, price, offers])] }, { editor: true });
  assert.match(parts.body, /<span class="os-now">€24\.00<\/span> <s class="os-was"><span class="os-sr">Original price <\/span>€30\.00<\/s> <span class="os-badge">−20%<\/span>/);
  assert.match(parts.body, /Spring sale/);
  assert.doesNotMatch(parts.body, /data-os-price|data-os-offers/);
});

test("the Offers widget is in the palette and on the default product page", () => {
  assert.ok(WIDGETS.some((w) => w.type === "productOffers" && w.group === "shop"));
  assert.deepEqual(newWidget("productOffers").props, { heading: "Offers" });
  const product = SYSTEM_PAGES.find((p) => p.key === "product")!.build();
  assert.match(JSON.stringify(product), /"type":"productOffers"/);
});

test("templates can be cloned with fresh ids, deeply", async () => {
  const { cloneWithNewIds, SECTION_TEMPLATES } = await import("../src/index.ts");
  const original = SECTION_TEMPLATES[0].build();
  const copy = cloneWithNewIds(original);
  const ids = (n: Node): string[] => [n.id, ...(n.children ?? []).flatMap(ids)];
  assert.equal(ids(copy).length, ids(original).length);
  assert.ok(ids(copy).every((id) => !ids(original).includes(id)), "no id is reused");
  assert.deepEqual(JSON.stringify(copy).replace(/"id":"[^"]+"/g, ""), JSON.stringify(original).replace(/"id":"[^"]+"/g, ""));
});

test("a section on a dark gradient gets light text", () => {
  const dark = renderPage({ title: "T", nodes: [{ id: "s1", type: "section", props: {}, style: { bg: { kind: "gradient", from: "#000000", to: "#111111" } }, children: [] }] });
  const light = renderPage({ title: "T", nodes: [{ id: "s1", type: "section", props: {}, style: { bg: { kind: "gradient", from: "#000000", to: "#FFFFFF" } }, children: [] }] });
  assert.match(dark, /class="os-section os-dark n-s1"/);
  assert.match(light, /class="os-section n-s1"/);
});

test("a section with no background keeps the theme's text colour", () => {
  const html = renderPage({ title: "T", nodes: [{ id: "s1", type: "section", props: {}, style: { bg: { kind: "none" } }, children: [] }] });
  assert.match(html, /class="os-section n-s1"/);
});

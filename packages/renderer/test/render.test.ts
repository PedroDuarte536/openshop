import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPage, renderParts, normalizeDoc, SECTION_TEMPLATES, PAGE_TEMPLATES, buildDoc, newWidget, WIDGET_TYPES, newSection, uid } from "../src/index.ts";
import type { PageDoc } from "../src/index.ts";

const doc = (nodes: any[], extra: object = {}): PageDoc => ({ title: "T", nodes, ...extra }) as PageDoc;
const page = (widget: any, colStyle: any = {}) => doc([{ id: "s1", type: "section", children: [{ id: "c1", type: "column", style: colStyle, children: [widget] }] }]);

test("every section template and page template renders to script-free html", () => {
  for (const t of SECTION_TEMPLATES) { const html = renderPage(doc([t.build()])); assert.doesNotMatch(html, /<script/i, t.key); assert.match(html, /<section/, t.key); }
  for (const t of PAGE_TEMPLATES) { const html = renderPage(buildDoc(t, "x")); assert.doesNotMatch(html, /<script/i, t.key); }
});

test("every widget default renders", () => {
  for (const type of WIDGET_TYPES) assert.doesNotThrow(() => renderPage(page(newWidget(type))), type);
});

test("editor attributes exist only in editor mode", () => {
  const d = page({ id: "w1", type: "heading", props: { text: "Hi" } });
  assert.doesNotMatch(renderPage(d), /data-node|data-edit/);
  const ed = renderPage(d, { editor: true });
  assert.match(ed, /data-node="w1"/);
  assert.match(ed, /data-edit="text"/);
  assert.match(ed, /data-type="heading"/);
});

test("empty column shows a drop target only in the editor", () => {
  const d = doc([newSection([6, 6])]);
  assert.match(renderPage(d, { editor: true }), /Drop a widget here/);
  assert.doesNotMatch(renderPage(d), /Drop a widget here/);
});

test("text content is escaped", () => {
  const html = renderPage(page({ id: "w1", type: "text", props: { text: "<script>alert(1)</script><img src=x onerror=1>" } }));
  assert.doesNotMatch(html, /<script>alert|<img src=x/);
});

test("CSS injection through style values is rejected", () => {
  const evil = [
    { color: "red;}</style><script>alert(1)</script>" }, { color: "url(javascript:alert(1))" }, { color: "expression(alert(1))" },
    { bg: { kind: "color", color: "red;background:url(//evil)" } },
    { bg: { kind: "image", image: 'https://x.test/a.png");}body{display:none}/*' } },
    { bg: { kind: "image", image: "javascript:alert(1)" } },
    { bg: { kind: "gradient", from: "red);}</style>", to: "blue" } },
  ];
  for (const style of evil) {
    const html = renderPage(page({ id: "w1", type: "text", props: {}, style }));
    assert.doesNotMatch(html, /<script|evil|display:none\}\/\*|javascript:|expression\(/i, JSON.stringify(style));
    assert.equal((html.match(/<\/style>/g) ?? []).length, 1, JSON.stringify(style));
  }
});

test("urls are restricted", () => {
  const html = renderPage(page({ id: "w1", type: "button", props: { label: "x", href: "javascript:alert(1)", href2: "//evil.test" , label2: "y" } }));
  assert.doesNotMatch(html, /javascript:|evil/);
  const img = renderPage(page({ id: "w2", type: "image", props: { src: "data:image/svg+xml,<svg onload=alert(1)>" } }));
  assert.doesNotMatch(img, /data:|svg/);
});

test("structure rules and ids are enforced", () => {
  assert.throws(() => normalizeDoc(doc([{ id: "a", type: "heading" }])), /cannot be placed/);
  assert.throws(() => normalizeDoc(doc([{ id: "a", type: "section", children: [{ id: "b", type: "heading" }] }])), /cannot be placed/);
  assert.throws(() => normalizeDoc(doc([{ id: "a", type: "section", children: [{ id: "b", type: "column", children: [{ id: "c", type: "section" }] }] }])), /cannot be placed/);
  assert.throws(() => normalizeDoc(doc([{ id: "a", type: "nope" }])), /Unknown node type/);
  assert.throws(() => normalizeDoc(doc([{ id: "a b", type: "section" }])), /invalid or duplicate/);
  assert.throws(() => normalizeDoc(doc([{ id: "a", type: "section" }, { id: "a", type: "section" }])), /invalid or duplicate/);
  assert.throws(() => normalizeDoc(doc(Array.from({ length: 700 }, () => ({ id: uid(), type: "section" })))), /too large/);
});

test("responsive CSS: columns stack on mobile, and device overrides come after the stack rule", () => {
  const d = doc([{ id: "s1", type: "section", children: [
    { id: "c1", type: "column", style: { span: 4 }, responsive: { mobile: { span: 6 }, tablet: { span: 12 } } },
    { id: "c2", type: "column", style: { span: 8 } },
  ] }]);
  const { css } = renderParts(d);
  const desktop = css.indexOf(".n-c1{grid-column:span 4}");
  const tablet = css.indexOf("@media(max-width:1024px)");
  const stack = css.indexOf(".os-col{grid-column:span 12}");
  const mobileOverride = css.indexOf(".n-c1{grid-column:span 6}");
  assert.ok(desktop > 0 && tablet > desktop && stack > tablet && mobileOverride > stack, "order is desktop < tablet < mobile stack < mobile override");
  assert.ok(css.indexOf(".n-c1{grid-column:span 12}") > tablet);
});

test("hide per device uses independent ranges", () => {
  const d = page({ id: "w1", type: "text", props: {}, hide: ["mobile"] });
  assert.match(renderPage(d), /@media \(max-width:640px\)\{\.n-w1\{display:none!important\}\}/);
  assert.match(renderPage(d, { editor: true }), /opacity:\.26/);
});

test("theme: fonts, variables and currency", () => {
  const html = renderPage(page({ id: "w1", type: "productGrid", props: { limit: 2 } }, {}), { products: () => [{ name: "Cup", price: 5, href: "/shop/product/1" }] });
  assert.match(html, /fonts\.googleapis\.com/);
  assert.match(html, /--primary:#2B4BFF/);
  assert.match(html, /€5\.00/);
  const bad = renderPage({ ...page({ id: "w1", type: "text" }), theme: { primary: "red;}</style>", font: "comic" as any } } as any);
  assert.match(bad, /--primary:#2B4BFF/);
});

test("dark backgrounds switch text to light automatically", () => {
  const d = doc([{ id: "s1", type: "section", style: { bg: { kind: "preset", preset: "noir" } }, children: [] }]);
  assert.match(renderPage(d), /class="os-section os-dark n-s1"/);
  const light = doc([{ id: "s1", type: "section", style: { bg: { kind: "color", color: "#ffffff" } }, children: [] }]);
  assert.doesNotMatch(renderPage(light), /class="[^"]*os-dark/);
});

test("heading size is fluid on desktop but exact in device overrides", () => {
  const d = page({ id: "w1", type: "heading", props: {}, style: { size: 80 }, responsive: { mobile: { size: 44 } } });
  const { css } = renderParts(d);
  assert.match(css, /\.n-w1\{font-size:clamp\(40px,6\.25vw,80px\)\}/);
  assert.match(css, /\.n-w1\{font-size:44px\}/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPage } from "../src/index.ts";

test("renders blocks to static html with no script", () => {
  const html = renderPage({ title: "Home", blocks: [
    { type: "heading", text: "Hi", level: 1 },
    { type: "columns", columns: [[{ type: "text", text: "a" }], [{ type: "button", label: "Go", href: "/shop" }]] },
  ] });
  assert.match(html, /<h1>Hi<\/h1>/);
  assert.match(html, /<a class="btn" href="\/shop">Go<\/a>/);
  assert.doesNotMatch(html, /<script/);
});

test("escapes content and blocks javascript: urls", () => {
  const html = renderPage({ title: "<x>", blocks: [
    { type: "text", text: "<script>alert(1)</script>" },
    { type: "button", label: "x", href: "javascript:alert(1)" },
  ] });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /href="#"/);
  assert.match(html, /<title>&lt;x&gt;<\/title>/);
});

test("throws on unknown block", () => {
  assert.throws(() => renderPage({ title: "t", blocks: [{ type: "nope" } as never] }));
});

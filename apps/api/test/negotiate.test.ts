import { test } from "node:test";
import assert from "node:assert/strict";
import { csvCell, negotiate } from "../src/negotiate.ts";
import { normalizeEmail, identityId } from "../src/identity.ts";

test("Accept negotiation: default, exact, wildcards, q-values, refusal", () => {
  const offered = ["application/json", "text/csv"];
  assert.equal(negotiate(undefined, offered), "application/json");
  assert.equal(negotiate("", offered), "application/json");
  assert.equal(negotiate("*/*", offered), "application/json");
  assert.equal(negotiate("text/csv", offered), "text/csv");
  assert.equal(negotiate("text/*", offered), "text/csv");
  assert.equal(negotiate("application/json;q=0.5, text/csv", offered), "text/csv");
  assert.equal(negotiate("text/csv;q=0.2, application/json;q=0.9", offered), "application/json");
  assert.equal(negotiate("application/xml", offered), null);
  assert.equal(negotiate("text/csv;q=0, */*", offered), "application/json");
  assert.equal(negotiate("text/csv;q=0", offered), null);
});

test("CSV cells are quoted and formulas neutralised", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
  assert.equal(csvCell("=HYPERLINK(\"x\")"), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell("+1"), "'+1");
  assert.equal(csvCell("-2"), "'-2");
  assert.equal(csvCell("@cmd"), "'@cmd");
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(12.5), "12.5");
});

test("identity: case, spaces and +tags map to the same person", () => {
  assert.equal(normalizeEmail("  Ann+promo@Example.COM "), "ann@example.com");
  assert.equal(identityId("ann@example.com"), identityId("ANN+x@example.com"));
  assert.notEqual(identityId("ann@example.com"), identityId("anne@example.com"));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allocate, percentOf, toCents, formatMoney, normalizeCode, generateCode, CODE_ALPHABET,
  zonedToInstant, instantToLocal, offsetLabel, isValidTimeZone, parseLocal, addLocalDays,
} from "../src/index.ts";

test("money: cents, percent rounding, formatting", () => {
  assert.equal(toCents(24.5), 2450);
  assert.equal(toCents(0.1 + 0.2), 30);
  assert.equal(percentOf(2400, 2000), 480);
  assert.equal(percentOf(1, 3333), 0);
  assert.equal(percentOf(5, 1000), 1, "half up: 0.5 cent -> 1");
  assert.equal(percentOf(999, 3333), 333);
  assert.equal(formatMoney(1920, "€"), "€19.20");
});

test("allocate: parts add up exactly, are proportional and never exceed their weight", () => {
  assert.deepEqual(allocate(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(allocate(0, [5, 5]), [0, 0]);
  assert.deepEqual(allocate(10, [0, 10]), [0, 10]);
  for (let k = 0; k < 500; k++) {
    const weights = Array.from({ length: 1 + (k % 7) }, (_, i) => ((k * 7919 + i * 104729) % 10000) + (i % 3 === 0 ? 0 : 1));
    const sum = weights.reduce((a, b) => a + b, 0);
    const total = sum ? (k * 31337) % (sum + 1) : 0;
    const parts = allocate(total, weights);
    assert.equal(parts.reduce((a, b) => a + b, 0), sum ? total : 0);
    parts.forEach((p, i) => assert.ok(p >= 0 && p <= weights[i]));
  }
});

test("codes: normalisation and generation", () => {
  assert.equal(normalizeCode("  welcome10 "), "WELCOME10");
  assert.equal(normalizeCode("sum mer-10"), "SUMMER-10");
  assert.equal(normalizeCode("abc"), null, "too short");
  assert.equal(normalizeCode("<script>"), null);
  assert.equal(normalizeCode("x".repeat(33)), null);
  assert.equal(normalizeCode(42), null);
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const c = generateCode("DUNE");
    assert.match(c, /^DUNE-[A-Z0-9]{5}-[A-Z0-9]{5}$/);
    for (const ch of c.slice(5).replace("-", "")) assert.ok(CODE_ALPHABET.includes(ch), `ambiguous char ${ch}`);
    assert.equal(normalizeCode(c), c);
    seen.add(c);
  }
  assert.equal(seen.size, 2000, "no collisions in 2000 codes");
});

test("time zones: validation and round trips", () => {
  assert.ok(isValidTimeZone("Europe/Lisbon"));
  assert.ok(isValidTimeZone("UTC"));
  assert.ok(!isValidTimeZone("Mars/Olympus"));
  assert.ok(!isValidTimeZone(""));
  assert.equal(parseLocal("2026-02-30T10:00"), null, "not a real date");
  assert.equal(parseLocal("1999-12-31T10:00"), null, "year out of range");
  assert.equal(parseLocal("2026-1-01T10:00"), null);
  assert.equal(addLocalDays("2026-12-31T00:00", 1), "2027-01-01T00:00");
  // Lisbon winter = UTC, summer = UTC+1
  assert.equal(new Date(zonedToInstant("2026-01-01T00:00", "Europe/Lisbon")).toISOString(), "2026-01-01T00:00:00.000Z");
  assert.equal(new Date(zonedToInstant("2026-07-01T00:00", "Europe/Lisbon")).toISOString(), "2026-06-30T23:00:00.000Z");
  assert.equal(new Date(zonedToInstant("2026-07-01T00:00", "America/New_York")).toISOString(), "2026-07-01T04:00:00.000Z");
  assert.equal(new Date(zonedToInstant("2026-07-01T00:00", "Asia/Kolkata")).toISOString(), "2026-06-30T18:30:00.000Z", "half-hour zone");
  assert.equal(instantToLocal(Date.parse("2026-06-30T23:00:00Z"), "Europe/Lisbon"), "2026-07-01T00:00");
  assert.equal(offsetLabel(Date.parse("2026-07-01T00:00:00Z"), "Europe/Lisbon"), "UTC+01:00");
  assert.equal(offsetLabel(Date.parse("2026-07-01T00:00:00Z"), "America/New_York"), "UTC-04:00");
});

test("time zones: DST gap moves to the change, DST overlap uses the first occurrence", () => {
  // Lisbon 2026-03-29: 01:00 WET -> 02:00 WEST (01:00-02:00 local does not exist)
  assert.equal(new Date(zonedToInstant("2026-03-29T01:30", "Europe/Lisbon")).toISOString(), "2026-03-29T01:00:00.000Z");
  assert.equal(new Date(zonedToInstant("2026-03-29T00:59", "Europe/Lisbon")).toISOString(), "2026-03-29T00:59:00.000Z");
  assert.equal(new Date(zonedToInstant("2026-03-29T02:00", "Europe/Lisbon")).toISOString(), "2026-03-29T01:00:00.000Z");
  // Lisbon 2026-10-25: 02:00 WEST -> 01:00 WET (01:00-02:00 local happens twice)
  assert.equal(new Date(zonedToInstant("2026-10-25T01:30", "Europe/Lisbon")).toISOString(), "2026-10-25T00:30:00.000Z");
  assert.equal(new Date(zonedToInstant("2026-10-25T02:00", "Europe/Lisbon")).toISOString(), "2026-10-25T02:00:00.000Z");
  // New York gap 02:00-03:00 on 2026-03-08
  assert.equal(new Date(zonedToInstant("2026-03-08T02:30", "America/New_York")).toISOString(), "2026-03-08T07:00:00.000Z");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PERMISSIONS, PERMISSION_IDS, AREAS, permission, isPermissionId, closure, normalizePermissions, effective, satisfies, requirementIds,
  TEMPLATES, FEATURES, feature, checkPassword, policyErrors, policyRules, DEFAULT_STAFF_POLICY, DEFAULT_CUSTOMER_POLICY, PASSWORD_MAX,
} from "../src/index.ts";
import { isCommonPassword } from "../src/common-passwords.ts";

test("catalogue: 17 unique permissions, known areas, requirements exist and have no cycles", () => {
  assert.equal(PERMISSIONS.length, 17);
  assert.equal(new Set(PERMISSION_IDS).size, 17);
  for (const p of PERMISSIONS) {
    assert.ok((AREAS as readonly string[]).includes(p.area), p.id);
    assert.ok(p.id.startsWith(`${p.area}.`), p.id);
    for (const r of p.requires) assert.ok(isPermissionId(r), `${p.id} requires unknown ${r}`);
    assert.ok(!closure(p.requires).has(p.id as never), `cycle through ${p.id}`);
  }
  assert.equal(permission("nope"), undefined);
});

test("closure adds requirements transitively and rejects unknown ids", () => {
  assert.deepEqual([...closure(["catalog.manage"])].sort(), ["catalog.manage", "catalog.stock", "catalog.view"]);
  assert.deepEqual([...closure(["discounts.codes"])].sort(), ["catalog.view", "discounts.codes", "discounts.view"]);
  assert.throws(() => closure(["team.manage"]), /Unknown permission/);
  assert.deepEqual(normalizePermissions(["orders.fulfil", "orders.fulfil"]), ["orders.view", "orders.fulfil"]);
});

test("effective permissions: union of groups, closed; the owner has everything; unknown stored ids are ignored", () => {
  const e = effective({ sudo: false }, [{ permissions: ["orders.fulfil"] }, { permissions: ["pages.manage", "removed.permission"] }]);
  assert.deepEqual([...e].sort(), ["catalog.view", "orders.fulfil", "orders.view", "pages.manage"]);
  assert.equal(effective({ sudo: true }, []).size, 17);
  assert.equal(effective({ sudo: false }, []).size, 0);
});

test("requirements: single, all, any, authenticated, sudo", () => {
  const u = { sudo: false, perms: new Set(["orders.view", "orders.fulfil"]) };
  assert.ok(satisfies(u, "orders.view"));
  assert.ok(!satisfies(u, "orders.cancel"));
  assert.ok(satisfies(u, { any: ["orders.cancel", "orders.fulfil"] }));
  assert.ok(!satisfies(u, { all: ["orders.cancel", "orders.fulfil"] }));
  assert.ok(satisfies(u, "authenticated"));
  assert.ok(!satisfies(u, "sudo"));
  assert.ok(satisfies({ sudo: true, perms: new Set() }, "sudo"));
  assert.ok(!satisfies(null, "authenticated"));
  assert.deepEqual(requirementIds({ all: ["orders.view", "customers.view"] }), ["orders.view", "customers.view"]);
  assert.deepEqual(requirementIds("sudo"), ["sudo"]);
});

test("templates match the reviewed plan (v2 §2.4) and are stored closed", () => {
  const expected: Record<string, string[]> = {
    "shop-manager": [...PERMISSION_IDS],
    fulfilment: ["catalog.view", "catalog.stock", "orders.view", "orders.fulfil"],
    "catalogue-editor": ["catalog.view", "catalog.stock", "catalog.manage"],
    "content-editor": ["catalog.view", "pages.manage"],
    promotions: ["catalog.view", "discounts.view", "discounts.manage", "discounts.codes", "insights.view"],
    "customer-support": ["orders.view", "orders.cancel", "customers.view", "customers.manage", "customers.accounts"],
    finance: ["catalog.view", "orders.view", "orders.payments", "discounts.view", "insights.view"],
    "read-only": ["catalog.view", "orders.view", "customers.view", "discounts.view", "insights.view"],
  };
  assert.deepEqual(TEMPLATES.map((t) => t.id), Object.keys(expected));
  for (const t of TEMPLATES) {
    assert.deepEqual([...t.permissions].sort(), [...expected[t.id]].sort(), t.id);
    assert.deepEqual(t.permissions, normalizePermissions(t.permissions), `${t.id} is closed and ordered`);
  }
});

test("feature registry: unique ids and paths, valid requirements, menu entries point at a route of the feature", () => {
  const paths = FEATURES.flatMap((f) => f.routes.map((r) => r.path));
  assert.equal(new Set(paths).size, paths.length);
  assert.equal(new Set(FEATURES.map((f) => f.id)).size, FEATURES.length);
  for (const f of FEATURES) {
    assert.ok(f.routes.some((r) => r.path === f.path), f.id);
    for (const r of [f.perm, ...f.routes.map((x) => x.perm)]) for (const id of requirementIds(r)) assert.ok(id === "sudo" || id === "authenticated" || isPermissionId(id), id);
  }
  assert.equal(feature("orders")?.label, "Orders");
  assert.equal(feature("nope"), undefined);
});

test("password policy: each rule, bounds, Unicode length", () => {
  assert.deepEqual(checkPassword("a".repeat(12), DEFAULT_STAFF_POLICY), []);
  assert.deepEqual(checkPassword("short", DEFAULT_STAFF_POLICY).map((i) => i.code), ["too_short"]);
  assert.deepEqual(checkPassword("x".repeat(PASSWORD_MAX + 1), DEFAULT_STAFF_POLICY).map((i) => i.code), ["too_long"]);
  // 10 emoji are 10 characters even though they are 20 UTF-16 units
  assert.deepEqual(checkPassword("😀".repeat(10), DEFAULT_CUSTOMER_POLICY), []);
  assert.deepEqual(checkPassword("😀".repeat(9), DEFAULT_CUSTOMER_POLICY).map((i) => i.code), ["too_short"]);
  const classes = { ...DEFAULT_STAFF_POLICY, requireClasses: 3 as const };
  assert.deepEqual(checkPassword("alllowercaseletters", classes).map((i) => i.code), ["classes"]);
  assert.deepEqual(checkPassword("Lower and Upper 1", classes), []);
  assert.deepEqual(checkPassword("my-lena.dune-password", DEFAULT_STAFF_POLICY, { email: "Lena.Dune@shop.io" }).map((i) => i.code), ["contains_email"]);
  assert.deepEqual(checkPassword("completely different", DEFAULT_STAFF_POLICY, { email: "lena.dune@shop.io" }), []);
  assert.deepEqual(checkPassword("ab-is-short-local-part", DEFAULT_STAFF_POLICY, { email: "ab@shop.io" }), [], "a 2-letter local part is not matched");
  const common = { ...DEFAULT_STAFF_POLICY, minLength: 8, blockCommon: true };
  assert.deepEqual(checkPassword("Password2024!", common, { isCommon: isCommonPassword }).map((i) => i.code), ["common"]);
  assert.deepEqual(checkPassword("Password2024!", common).map((i) => i.code), [], "without the list (browser) the server decides");
  assert.deepEqual(checkPassword("Password2024!", DEFAULT_STAFF_POLICY, { isCommon: isCommonPassword }).map((i) => i.code), [], "rule off");
});

test("policy bounds and plain-language rules", () => {
  assert.deepEqual(policyErrors(DEFAULT_STAFF_POLICY), []);
  assert.equal(policyErrors({ ...DEFAULT_STAFF_POLICY, minLength: 7 }).length, 1);
  assert.equal(policyErrors({ ...DEFAULT_STAFF_POLICY, minLength: 65 }).length, 1);
  assert.equal(policyErrors({ ...DEFAULT_STAFF_POLICY, minLength: 9.5 }).length, 1);
  assert.equal(policyErrors({ ...DEFAULT_STAFF_POLICY, requireClasses: 5 as never }).length, 1);
  assert.equal(policyErrors({ ...DEFAULT_STAFF_POLICY, blockCommon: "yes" as never }).length, 1);
  assert.deepEqual(policyRules(DEFAULT_CUSTOMER_POLICY), ["At least 10 characters"]);
  assert.equal(policyRules({ minLength: 14, requireClasses: 2, disallowEmail: true, blockCommon: true }).length, 4);
});

test("common passwords ignore case and trailing digits and symbols", () => {
  assert.ok(isCommonPassword("QWERTY123"));
  assert.ok(isCommonPassword("letmein!!"));
  assert.ok(isCommonPassword("12345678"));
  assert.ok(!isCommonPassword("ceramic-bowls-at-dawn"));
  assert.ok(!isCommonPassword("ab12"), "stems shorter than 3 don't match");
});

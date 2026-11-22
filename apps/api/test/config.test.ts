// The central configuration: defaults, environment overrides, and a clear stop on a wrong value.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { ConfigError, loadConfig } from "../src/config.ts";

test("defaults, and validated overrides from the environment", () => {
  const d = loadConfig({});
  assert.equal(d.uploads.maxImageBytes, 5 * 1024 * 1024);
  assert.equal(d.import.maxBytes, 10 * 1024 * 1024);
  assert.equal(d.import.maxRows, 20_000);
  assert.equal(d.auth.adminSessionSeconds, 8 * 3600);
  assert.equal(d.search.rateBurst, 60);
  const c = loadConfig({ UPLOAD_MAX_MB: "8", IMPORT_MAX_MB: " 20 ", IMPORT_MAX_ROWS: "50000", ADMIN_SESSION_HOURS: "12", SEARCH_RATE_BURST: "200", IMPORT_RETENTION_DAYS: "7", HTTP_BODY_LIMIT_KB: "" });
  assert.deepEqual([c.uploads.maxImageBytes, c.import.maxBytes, c.import.maxRows, c.auth.adminSessionSeconds, c.search.rateBurst, c.import.retentionMs, c.http.bodyLimitBytes],
    [8 * 1024 * 1024, 20 * 1024 * 1024, 50_000, 12 * 3600, 200, 7 * 86_400_000, 1024 * 1024]);
  assert.throws(() => loadConfig({ UPLOAD_MAX_MB: "5MB" }), (e: Error) => e instanceof ConfigError && /UPLOAD_MAX_MB must be a whole number/.test(e.message));
  assert.throws(() => loadConfig({ IMPORT_MAX_MB: "1000" }), /IMPORT_MAX_MB must be between 1 and 100/);
  assert.throws(() => loadConfig({ CUSTOMER_SESSION_DAYS: "-1" }), /whole number/);
});

test("a wrong value stops the server at start-up with a clear message", () => {
  const r = spawnSync(process.execPath, ["src/main.ts"], { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, UPLOAD_MAX_MB: "lots", DB_PATH: ":memory:", PORT: "0" }, encoding: "utf8", timeout: 20_000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ConfigError: UPLOAD_MAX_MB must be a whole number \(got "lots"\)/);
});

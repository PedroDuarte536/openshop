// Integration: the real entry point as a process (env configuration, first-run admin, graceful shutdown).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Starts `node src/main.ts` with the given environment; resolves once /health answers. */
async function start(env: Record<string, string>) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["src/main.ts"], { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, PORT: String(port), ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  let ok = false;
  for (let i = 0; i < 50 && !ok; i++) {
    await new Promise((r) => setTimeout(r, 100));
    ok = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false);
  }
  assert.ok(ok, `server did not start: ${out}`);
  const url = `http://127.0.0.1:${port}`;
  const login = (email: string, password: string) => fetch(`${url}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  const stop = async () => { child.kill("SIGTERM"); return new Promise<number | null>((r) => child.on("exit", r)); };
  return { url, login, stop, output: () => out };
}

test("main.ts: first run without a password creates an admin once; SIGTERM shuts down cleanly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "os-main-"));
  const s = await start({ DB_PATH: join(dir, "db.sqlite"), UPLOAD_DIR: join(dir, "up"), ADMIN_EMAIL: "owner@x.io", ADMIN_PASSWORD: "", AUTH_SECRET: "" });
  try {
    assert.match(s.output(), /AUTH_SECRET not set/);
    const pw = /created admin owner@x\.io with password (\S+)/.exec(s.output())?.[1];
    assert.ok(pw, "a first-run admin password is printed once");
    assert.equal((await s.login("owner@x.io", pw!)).status, 200);
    assert.equal((await fetch(`${s.url}/shop`)).status, 200);
  } finally { assert.equal(await s.stop(), 0, "graceful shutdown exits with 0"); }
});

test("main.ts: ADMIN_PASSWORD sets the owner password; restarts keep sessions; a changed password ends them; never a second owner", async () => {
  const dir = mkdtempSync(join(tmpdir(), "os-main-"));
  const env = { DB_PATH: join(dir, "db.sqlite"), UPLOAD_DIR: join(dir, "up"), ADMIN_EMAIL: "Owner@X.io", ADMIN_PASSWORD: "first-password", AUTH_SECRET: "a-long-secret" };
  const a = await start(env);
  let token = "";
  try {
    assert.doesNotMatch(a.output(), /First run|AUTH_SECRET not set/);
    const r = await a.login("owner@x.io", "first-password");
    assert.equal(r.status, 200);
    token = (await r.json()).token;
  } finally { await a.stop(); }
  const authed = (url: string, t: string) => fetch(`${url}/api/products`, { headers: { authorization: `Bearer ${t}` } });
  const b = await start(env);
  try {
    assert.equal((await authed(b.url, token)).status, 200, "same AUTH_SECRET and same password: the earlier session is still valid");
  } finally { await b.stop(); }
  const c = await start({ ...env, ADMIN_PASSWORD: "second-password" });
  try {
    assert.equal((await c.login("owner@x.io", "first-password")).status, 401);
    assert.equal((await c.login("owner@x.io", "second-password")).status, 200);
    assert.equal((await authed(c.url, token)).status, 401, "a changed password ends the owner's earlier sessions");
  } finally { await c.stop(); }
  const d = await start({ ...env, ADMIN_EMAIL: "someone-else@x.io", ADMIN_PASSWORD: "third-password" });
  try {
    assert.match(d.output(), /is not the owner account/);
    assert.equal((await d.login("someone-else@x.io", "third-password")).status, 401, "ADMIN_EMAIL never creates a second owner");
    assert.equal((await d.login("owner@x.io", "second-password")).status, 200);
  } finally { await d.stop(); }
});

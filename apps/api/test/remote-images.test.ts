// https:// images in imports (plan §2.7.5, C7): address rules, public-address checks on every hop, pinned
// connections, limits, real image bytes; then the import downloading copies (or keeping links when asked).
// A local HTTPS server with a test certificate stands in for other websites.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:https";
import { join } from "node:path";
import { checkUrl, fetchImage, isPublicAddress, imageType, type RemoteOptions } from "../src/catalogue/import/remote.ts";
import { whenDone } from "../src/catalogue/import/jobs.ts";
import { make } from "./catalogue-helpers.ts";

// A throw-away self-signed certificate for the test names, made here (needs the `openssl` command) so that no key is
// kept in the repository. It is only used by this local HTTPS server and by the client under test.
const TLS = mkdtempSync(join(tmpdir(), "tls-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(TLS, "key.pem"), "-out", join(TLS, "cert.pem"), "-days", "2", "-subj", "/CN=images.example.test",
  "-addext", "subjectAltName=DNS:images.example.test,DNS:cdn.example.test,DNS:internal.example.test,DNS:mixed.example.test"], { stdio: "ignore" });
const cert = readFileSync(join(TLS, "cert.pem")), key = readFileSync(join(TLS, "key.pem"));
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f0005fe02fea7d6a4b20000000049454e44ae426082", "hex");
const PNG2 = Buffer.concat([PNG, Buffer.from("extra")]);

let hits: string[] = [];
const server: Server = createServer({ cert, key }, (req, res) => {
  hits.push(req.url ?? "");
  const u = req.url ?? "";
  if (u === "/a.png" || u === "/same.png") { res.writeHead(200, { "content-type": "image/png", "content-length": PNG.length }); res.end(PNG); return; }
  if (u === "/b.png") { res.writeHead(200, { "content-type": "image/png" }); res.end(PNG2); return; }
  if (u === "/svg.png") { res.writeHead(200, { "content-type": "image/png" }); res.end("<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>"); return; }
  if (u === "/big-declared.png") { res.writeHead(200, { "content-type": "image/png", "content-length": 50_000 }); res.end(Buffer.concat([PNG, Buffer.alloc(50_000 - PNG.length)])); return; }
  if (u === "/big-chunked.png") { res.writeHead(200, { "content-type": "image/png" }); res.write(PNG); for (let i = 0; i < 20; i++) res.write(Buffer.alloc(4096)); res.end(); return; }
  if (u === "/r1") { res.writeHead(302, { location: "/a.png" }); res.end(); return; }
  if (u === "/to-http") { res.writeHead(302, { location: "http://images.example.test/a.png" }); res.end(); return; }
  if (u === "/to-internal") { res.writeHead(301, { location: "https://internal.example.test/a.png" }); res.end(); return; }
  if (u.startsWith("/loop")) { const n = Number(u.slice(5) || 0); res.writeHead(302, { location: `/loop${n + 1}` }); res.end(); return; }
  if (u === "/slow.png") return; // never answers
  res.writeHead(404); res.end();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
after(() => { server.closeAllConnections(); server.close(); });

// The test "internet": names -> addresses. Only the local server's address may be contacted in these tests; the
// real rule (public addresses only) is checked separately below.
const DNS: Record<string, string[]> = { "images.example.test": ["127.0.0.1"], "cdn.example.test": ["127.0.0.1"], "internal.example.test": ["10.0.0.5"], "mixed.example.test": ["127.0.0.1", "192.168.1.10"] };
const resolve: RemoteOptions["resolve"] = async (host) => { const a = DNS[host]; if (!a) throw new Error("ENOTFOUND"); return a.map((address) => ({ address, family: 4 })); };
const opts: RemoteOptions = { resolve, allowAddress: (ip) => ip === "127.0.0.1", ca: cert, port };

test("public addresses only: private, loopback, link-local, metadata, CGNAT, multicast and mapped forms are refused", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) assert.equal(isPublicAddress(ip), true, ip);
  for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "100.64.1.1", "172.16.5.4", "172.31.255.255", "192.168.1.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "198.18.0.1", "192.0.2.10", "::1", "::", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "fd00:ec2::254", "fe80::1", "fc00::1", "ff02::1", "64:ff9b::a00:1", "2002:c0a8:101::1", "2001:db8::1", "not-an-ip"])
    assert.equal(isPublicAddress(ip), false, ip);
});

test("addresses are checked before any connection: https, port 443, a host name, no credentials", () => {
  assert.equal(checkUrl("https://images.example.test/a.png").ok, true);
  const error = (u: string) => { const r = checkUrl(u); return r.ok ? "" : r.error; };
  assert.match(error("http://images.example.test/a.png"), /only https/);
  assert.match(error("https://127.0.0.1/a.png"), /not an IP address/);
  assert.match(error("https://[::1]/a.png"), /not an IP address/);
  assert.match(error("https://user:pw@images.example.test/a.png"), /user name or password/);
  assert.match(error("https://images.example.test:8443/a.png"), /443/);
  for (const u of ["https://localhost/a.png", "https://printer.local/a.png", "https://metadata.google.internal/a", "https://intranet/a.png"]) assert.match(error(u), /isn't a public site/, u);
  assert.match(error("file:///etc/passwd"), /only https/);
});

test("the real rule: a name that resolves to the server's own network is never contacted", async () => {
  hits = [];
  const local: RemoteOptions = { resolve, ca: cert, port }; // default address rule
  assert.deepEqual(await fetchImage("https://images.example.test/a.png", local), { ok: false, error: "isn't a public site" });
  assert.deepEqual(await fetchImage("https://internal.example.test/a.png", opts), { ok: false, error: "isn't a public site" });
  assert.deepEqual(await fetchImage("https://mixed.example.test/a.png", opts), { ok: false, error: "isn't a public site" }, "one private answer is enough to refuse");
  assert.deepEqual(hits, [], "no request was made");
  assert.deepEqual(await fetchImage("https://nowhere.example.test/a.png", opts), { ok: false, error: "the site's name can't be found" });
});

test("downloads: real image bytes, redirects checked again, limits, time limit, certificate", async () => {
  const ok = await fetchImage("https://images.example.test/a.png", opts);
  assert.ok(ok.ok && ok.ext === "png" && ok.buf.equals(PNG));
  const probe = await fetchImage("https://images.example.test/b.png", opts, true);
  assert.ok(probe.ok && probe.buf.length <= 64, "a probe reads only the first bytes");
  const redirected = await fetchImage("https://cdn.example.test/r1", opts);
  assert.ok(redirected.ok && redirected.finalUrl === "https://cdn.example.test/a.png");
  assert.deepEqual(await fetchImage("https://images.example.test/to-http", opts), { ok: false, error: "redirected to an address that only https:// addresses can be downloaded" });
  hits = [];
  assert.deepEqual(await fetchImage("https://images.example.test/to-internal", opts), { ok: false, error: "isn't a public site" }, "every hop is checked");
  assert.deepEqual(hits, ["/to-internal"]);
  assert.deepEqual(await fetchImage("https://images.example.test/loop0", opts), { ok: false, error: "more than 3 redirects" });
  assert.deepEqual(await fetchImage("https://images.example.test/svg.png", opts), { ok: false, error: "isn't a PNG, JPEG, WebP or GIF image" });
  assert.deepEqual(await fetchImage("https://images.example.test/missing.png", opts), { ok: false, error: "the site answered 404" });
  const small = { ...opts, maxBytes: 10_000 };
  assert.deepEqual(await fetchImage("https://images.example.test/big-declared.png", small), { ok: false, error: "the image is larger than 10 KB" });
  assert.equal((await fetchImage("https://images.example.test/big-chunked.png", small) as { error: string }).error, "the image is larger than 10 KB", "counted while reading, without a declared size");
  assert.deepEqual(await fetchImage("https://images.example.test/slow.png", { ...opts, timeoutMs: 300 }), { ok: false, error: "the site didn't answer in time" });
  assert.deepEqual(await fetchImage("https://images.example.test/a.png", { ...opts, ca: undefined }), { ok: false, error: "the site couldn't be reached securely" }, "an untrusted certificate is refused");
  assert.equal(imageType(Buffer.from("RIFF0000WAVEfmt ")), null, "RIFF alone isn't WebP");
});

test("imports download https images into the shop (checked in the preview), or keep links when asked", async () => {
  const c = await make({ remoteImages: opts });
  const file = ["sku,name,price,images", "R1,Cup,10,https://images.example.test/a.png|https://cdn.example.test/same.png", "R2,Jug,10,https://images.example.test/missing.png", "R3,Bowl,10,https://internal.example.test/x.png", "R4,Vase,10,http://images.example.test/a.png", "R5,Tray,10,https://user:secret@images.example.test/a.png"].join("\n");
  const job = (await c.api("POST", "/api/catalogue/imports?filename=r.csv", file, { "content-type": "text/csv" })).json();
  hits = [];
  const p = (await c.api("POST", `/api/catalogue/imports/${job.id}/preview`)).json();
  assert.deepEqual([p.preview.create, p.preview.errors], [1, 4]);
  assert.match(p.preview.warnings.join(), /2 photos will be downloaded from other websites/);
  const rows = (await c.api("GET", `/api/catalogue/imports/${job.id}/rows`)).json().items;
  assert.deepEqual(rows.slice(1).map((r: { errors: { message: string }[] }) => r.errors[0].message), [
    "Image not downloaded (the site answered 404): https://images.example.test/missing.png",
    "Image not downloaded (isn't a public site): https://internal.example.test/x.png",
    "Image not downloaded (only https:// addresses can be downloaded): http://images.example.test/a.png",
    "Image not downloaded (addresses with a user name or password aren't allowed): https://images.example.test/a.png",
  ]);
  const previewHits = hits.length;
  await c.api("POST", `/api/catalogue/imports/${job.id}/preview`);
  assert.equal(hits.length, previewHits, "a second preview doesn't ask the other site again");
  await c.api("POST", `/api/catalogue/imports/${job.id}/commit`, { previewAt: (await c.api("GET", `/api/catalogue/imports/${job.id}`)).json().preview.at });
  await whenDone(job.id);
  const cup = (await c.api("GET", "/api/products?q=cup")).json().items[0];
  assert.equal(cup.images.length, 2);
  assert.ok(cup.images.every((u: string) => /^\/uploads\/[a-f0-9]{32}\.png$/.test(u)));
  assert.equal(cup.images[0], cup.images[1], "the same bytes are stored once");
  assert.equal((await c.app.inject({ url: cup.images[0] })).rawPayload.equals(PNG), true);
  assert.equal((await c.db.audit.find({ action: "download" })).length, 2, "each download is audited with its source");

  // The owner can keep links instead (nothing is downloaded; the preview warns).
  const job2 = (await c.api("POST", "/api/catalogue/imports?filename=r.csv", "sku,name,price,images\nL1,Plate,10,https://images.example.test/a.png", { "content-type": "text/csv" })).json();
  await c.api("PUT", `/api/catalogue/imports/${job2.id}`, { options: { remoteImages: "link" } });
  hits = [];
  const p2 = (await c.api("POST", `/api/catalogue/imports/${job2.id}/preview`)).json();
  assert.match(p2.preview.warnings.join(), /is linked from another site/);
  await c.api("POST", `/api/catalogue/imports/${job2.id}/commit`, { previewAt: p2.preview.at });
  await whenDone(job2.id);
  assert.deepEqual((await c.api("GET", "/api/products?q=plate")).json().items[0].images, ["https://images.example.test/a.png"]);
  assert.deepEqual(hits, [], "nothing fetched");
});

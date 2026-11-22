// Downloading https:// images named in import files (plan §2.7.5, security item C7). The shop server fetches an
// address given by a file, so this must not become a way to reach the server's own network (SSRF):
// - https on port 443 only, a host name (no IP literals, no user:password@), at most 3 redirects, each checked again;
// - every address the name resolves to must be a public unicast address (no loopback, private, link-local, cloud
//   metadata, CGNAT, multicast, documentation ranges; IPv4-mapped IPv6 is checked as IPv4);
// - the connection goes to the address that was checked (the lookup is pinned), so a second DNS answer can't
//   redirect it; TLS still verifies the certificate for the host name;
// - a time limit for the whole download, a size limit while reading, no cookies, no credentials;
// - the bytes must be a PNG, JPEG, WebP or GIF (magic bytes; SVG and HTML are refused), whatever the server says.
// The preview only "probes" (reads the first bytes); the commit downloads, checks again and stores a copy.
import { lookup as dnsLookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { CONFIG } from "../../config.ts";
import { MAX_IMAGE_BYTES } from "../../uploads.ts";

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;
export interface RemoteOptions {
  /** Name resolution (tests replace it). */
  resolve?: Resolver;
  /** Which addresses may be contacted (tests allow their local server; the default allows public unicast only). */
  allowAddress?: (ip: string, family: number) => boolean;
  /** Extra trusted certificate authority (tests only). */
  ca?: string | Buffer;
  /** Port to connect to (tests only; real addresses are always 443). */
  port?: number;
  timeoutMs?: number;
  maxBytes?: number;
}
export type RemoteResult = { ok: true; buf: Buffer; ext: "png" | "jpg" | "webp" | "gif"; finalUrl: string } | { ok: false; error: string };

const R = CONFIG.import.remote;

// Addresses that are not on the public internet.
const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 32], ["2001:db8::", 32], ["2002::", 16],
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) blocked.addSubnet(net, bits, "ipv6");

/** Whether an address is a public unicast address. */
export function isPublicAddress(ip: string, family = isIP(ip)): boolean {
  if (family === 4) return isIP(ip) === 4 && !blocked.check(ip, "ipv4");
  if (family !== 6 || isIP(ip) !== 6) return false;
  const lower = ip.toLowerCase();
  // IPv4-mapped (::ffff:a.b.c.d or ::ffff:xxxx:xxxx) and IPv4-compatible forms: check the IPv4 address.
  const mapped = /^(?:0{0,4}:){0,5}(?:0{0,4}:)?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower) ?? /^::(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPublicAddress(mapped[1], 4);
  const hexMapped = /^(?:0{0,4}:){0,5}(?:0{0,4}:)?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower) ?? /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16), lo = parseInt(hexMapped[2], 16);
    return isPublicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, 4);
  }
  if (blocked.check(ip, "ipv6")) return false;
  // Only global unicast (2000::/3) is public.
  const first = parseInt(lower.split(":")[0] || "0", 16);
  return first >= 0x2000 && first <= 0x3fff;
}

/** The image type of a buffer, from its first bytes (never from the name or the server's content type). */
export function imageType(b: Buffer): "png" | "jpg" | "webp" | "gif" | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length >= 6 && b.toString("latin1", 0, 4) === "GIF8" && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "gif";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "webp";
  return null;
}

/** Checks an address before any connection: https, port 443, a host name, no credentials. */
export function checkUrl(raw: string): { ok: true; url: URL } | { ok: false; error: string } {
  let url: URL;
  try { url = new URL(raw); } catch { return { ok: false, error: "isn't a valid address" }; }
  if (url.protocol !== "https:") return { ok: false, error: "only https:// addresses can be downloaded" };
  if (url.username || url.password) return { ok: false, error: "addresses with a user name or password aren't allowed" };
  if (url.port && url.port !== "443") return { ok: false, error: "only the standard https port (443) is allowed" };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return { ok: false, error: "use the site's name, not an IP address" };
  if (!/^[a-z0-9.-]{1,253}$/i.test(host) || !host.includes(".") || host.endsWith(".local") || host.endsWith(".internal") || host === "localhost" || host.endsWith(".localhost"))
    return { ok: false, error: "isn't a public site" };
  return { ok: true, url };
}

const defaultResolve: Resolver = (host) => dnsLookup(host, { all: true, verbatim: true });

interface Fetched { status: number; location?: string; buf: Buffer; tooBig: boolean; declared: number | null }

/** One request to a checked address, connected to the pinned IP. Reads at most `limit` bytes. */
function fetchOnce(url: URL, ip: string, family: number, o: RemoteOptions, probe: boolean, deadline: number): Promise<Fetched> {
  const maxBytes = o.maxBytes ?? MAX_IMAGE_BYTES;
  const limit = probe ? 64 : maxBytes;
  return new Promise((resolve, reject) => {
    const pinned: LookupFunction = (_host, opts, cb) => {
      // Node may ask for every address at once; answer with the checked one only.
      if ((opts as { all?: boolean }).all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address: ip, family }]);
      else cb(null, ip, family);
    };
    const left = Math.max(1, deadline - Date.now());
    const req = request({
      host: url.hostname, servername: url.hostname, port: o.port ?? 443, path: `${url.pathname}${url.search}`, method: "GET", lookup: pinned,
      agent: false, timeout: left, headers: { "user-agent": "OpenShop-import/1.0", accept: "image/png,image/jpeg,image/webp,image/gif;q=0.9,*/*;q=0.1" },
      ...(o.ca ? { ca: o.ca } : {}),
    }, (res) => {
      const status = res.statusCode ?? 0;
      const location = typeof res.headers.location === "string" ? res.headers.location : undefined;
      const declared = res.headers["content-length"] ? Number(res.headers["content-length"]) : null;
      if (status !== 200 || (declared !== null && declared > maxBytes)) { res.destroy(); req.destroy(); resolve({ status, location, buf: Buffer.alloc(0), tooBig: declared !== null && declared > maxBytes, declared }); return; }
      const chunks: Buffer[] = [];
      let size = 0, done = false;
      const finish = (tooBig: boolean) => { if (done) return; done = true; resolve({ status, buf: Buffer.concat(chunks), tooBig, declared }); };
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > limit) {
          // The limit is reached: a probe has what it needs, a download is too big.
          chunks.push(c.subarray(0, c.length - (size - limit)));
          finish(!probe);
          res.destroy(); req.destroy();
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => finish(false));
      res.on("error", (e) => { if (!done) reject(e); });
    });
    const timer = setTimeout(() => req.destroy(new Error("timeout")), left);
    req.on("close", () => clearTimeout(timer));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => reject(e));
    req.end();
  });
}

/**
 * Downloads (or, with `probe`, only checks the first bytes of) an https image. Never throws: failures come back as a
 * plain-language message for the import report.
 */
export async function fetchImage(raw: string, o: RemoteOptions = {}, probe = false): Promise<RemoteResult> {
  const maxBytes = o.maxBytes ?? MAX_IMAGE_BYTES;
  const deadline = Date.now() + (o.timeoutMs ?? R.timeoutMs);
  const allow = o.allowAddress ?? ((ip: string, family: number) => isPublicAddress(ip, family));
  let current = raw;
  for (let hop = 0; hop <= R.maxRedirects; hop++) {
    const c = checkUrl(current);
    if (!c.ok) return { ok: false, error: hop ? `redirected to an address that ${c.error}` : c.error };
    let addrs: { address: string; family: number }[];
    try { addrs = await withDeadline((o.resolve ?? defaultResolve)(c.url.hostname), deadline); } catch { return { ok: false, error: "the site's name can't be found" }; }
    // Every address must be public: a name that also points inside the network is refused as a whole.
    if (!addrs.length || addrs.some((a) => !allow(a.address, a.family))) return { ok: false, error: "isn't a public site" };
    let r: Fetched;
    try { r = await fetchOnce(c.url, addrs[0].address, addrs[0].family, o, probe, deadline); }
    catch (e) { return { ok: false, error: (e as Error).message === "timeout" || Date.now() >= deadline ? "the site didn't answer in time" : "the site couldn't be reached securely" }; }
    if (r.status >= 300 && r.status < 400 && r.location) {
      try { current = new URL(r.location, c.url).toString(); } catch { return { ok: false, error: "the site redirected to an invalid address" }; }
      continue;
    }
    if (r.status !== 200) return { ok: false, error: `the site answered ${r.status}` };
    if (r.tooBig) return { ok: false, error: `the image is larger than ${maxBytes >= 1024 * 1024 ? `${Math.round(maxBytes / 1024 / 1024)} MB` : `${Math.round(maxBytes / 1024)} KB`}` };
    const ext = imageType(r.buf);
    if (!ext) return { ok: false, error: "isn't a PNG, JPEG, WebP or GIF image" };
    return { ok: true, buf: r.buf, ext, finalUrl: c.url.toString() };
  }
  return { ok: false, error: `more than ${R.maxRedirects} redirects` };
}

function withDeadline<T>(p: Promise<T>, deadline: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), Math.max(1, deadline - Date.now()));
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Runs `fn` over `items` with at most `n` at a time. */
export async function pool<T, U>(items: T[], n: number, fn: (x: T) => Promise<U>): Promise<U[]> {
  const out = new Array<U>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } }));
  return out;
}

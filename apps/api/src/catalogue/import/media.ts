// Images named in import files (plan §2.7.5, owner decision I-2, security item C20):
// - "/uploads/<hex>.<ext>": an image already uploaded to this shop (must exist);
// - a path on the server, only inside the folder the server operator configured (IMPORT_MEDIA_DIR, never settable
//   from the backoffice). The file is checked and COPIED into the shop's uploads; nothing is served from that folder;
// - "https://…": downloaded and stored as a copy (the default; see remote.ts for the SSRF rules, C7), or kept as a
//   link when the owner chooses so for an import (a warning: visitors' browsers would load it from another site).
// Every failure for a server path gives the same message, so an import can't probe which files exist.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DuplicateKeyError } from "@openshop/db";
import type { Db } from "../../types.ts";
import { IMAGE_RE } from "../model.ts";
import { MAX_IMAGE_BYTES, MIME, saveUpload, sniff } from "../../uploads.ts";
import { CONFIG } from "../../config.ts";
import { checkUrl, fetchImage, type RemoteOptions } from "./remote.ts";

export interface MediaConfig { uploadDir: string; mediaDir?: string | null; remote?: RemoteOptions }
export type MediaResult =
  | { ok: true; kind: "uploads" | "url"; url: string; warning?: string }
  | { ok: true; kind: "remote"; url: string }
  | { ok: true; kind: "server"; resolved: string; ext: string; size: number }
  | { ok: false; error: string };

const EXT: Record<string, string> = { png: "png", jpg: "jpg", jpeg: "jpg", webp: "webp", gif: "gif" };
export const MAX_MEDIA_FILES = CONFIG.import.maxMediaFiles;
export const MAX_MEDIA_BYTES = CONFIG.import.maxMediaBytes;
export const notAllowed = (src: string) => `Image not found or not allowed: ${src.slice(0, 200)}`;

async function exists(p: string) { try { return (await stat(p)).isFile(); } catch { return false; } }

/** Opens `p` without following a symlink at the last step and checks it is a regular file of at most 5 MB. */
async function openRegular(p: string) {
  const fh = await open(p, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > MAX_IMAGE_BYTES || st.size === 0) throw new Error("not a regular image file");
    return { fh, size: st.size };
  } catch (e) { await fh.close(); throw e; }
}

/** Checks one image reference (preview). Nothing is copied here. */
export async function resolveImage(src: string, cfg: MediaConfig): Promise<MediaResult> {
  const s = src.trim();
  if (/^\/uploads\//.test(s)) {
    if (!IMAGE_RE.test(s)) return { ok: false, error: notAllowed(s) };
    return (await exists(join(cfg.uploadDir, s.slice("/uploads/".length)))) ? { ok: true, kind: "uploads", url: s } : { ok: false, error: notAllowed(s) };
  }
  if (/^https?:\/\//i.test(s)) {
    if (!IMAGE_RE.test(s)) return { ok: false, error: `Only https:// image addresses can be used: ${s.slice(0, 200)}` };
    return { ok: true, kind: "url", url: s, warning: "is linked from another site: visitors' browsers will load it from there" };
  }
  if (!cfg.mediaDir) return { ok: false, error: `Server image folder not configured (ask whoever runs the shop to set IMPORT_MEDIA_DIR): ${s.slice(0, 200)}` };
  // Syntactic rejects first (C20): no NUL, backslashes, drive letters, "//", ".." segments, overly long paths.
  if (!s || s.length > CONFIG.import.maxMediaPathLength || /[\u0000\\]/.test(s) || /^[a-z]:/i.test(s) || s.includes("//") || s.split("/").includes("..")) return { ok: false, error: notAllowed(s) };
  const ext = EXT[(s.split(".").pop() ?? "").toLowerCase()];
  if (!ext) return { ok: false, error: notAllowed(s) };
  try {
    const root = await realpath(cfg.mediaDir);
    const candidate = isAbsolute(s) ? s : resolve(root, s);
    const real = await realpath(candidate); // follows symlinks: the final target must still be inside the folder
    const rel = relative(root, real);
    if (!rel || rel.startsWith("..") || isAbsolute(rel) || !(real === root || real.startsWith(root + sep))) return { ok: false, error: notAllowed(s) };
    const { fh, size } = await openRegular(real);
    try {
      const head = Buffer.alloc(12);
      await fh.read(head, 0, 12, 0);
      if (!sniff(head, ext)) return { ok: false, error: notAllowed(s) };
    } finally { await fh.close(); }
    return { ok: true, kind: "server", resolved: real, ext, size };
  } catch { return { ok: false, error: notAllowed(s) }; }
}

// What the preview found for each https image, per import: re-previews (after a decision or an option) don't ask
// the other site again. Bounded; entries expire.
const probes = new Map<string, { at: number; r: MediaResult }>();
const PROBE_MAX = 5000;

/** An address as shown in messages: without a user name or password, and not too long. */
const shown = (s: string) => s.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, "$1").slice(0, 200);
const notDownloaded = (error: string, src: string) => `Image not downloaded (${error}): ${shown(src)}`;

/** Checks an https image for the preview (address rules, then the first bytes), remembered per import for a while. */
export async function probeRemote(jobId: string, src: string, cfg: MediaConfig): Promise<MediaResult> {
  const s = src.trim();
  const c = checkUrl(s);
  if (!c.ok) return { ok: false, error: notDownloaded(c.error, s) };
  const key = `${jobId}\n${s}`;
  const hit = probes.get(key);
  if (hit && Date.now() - hit.at < CONFIG.import.remote.probeCacheMs) return hit.r;
  const f = await fetchImage(s, cfg.remote, true);
  const r: MediaResult = f.ok ? { ok: true, kind: "remote", url: s } : { ok: false, error: notDownloaded(f.error, s) };
  if (probes.size >= PROBE_MAX) probes.delete(probes.keys().next().value!);
  probes.set(key, { at: Date.now(), r });
  return r;
}

/** Downloads an https image and stores a copy in the uploads (same bytes, same upload). */
export async function downloadRemote(db: Db, cfg: MediaConfig, src: string): Promise<{ ok: true; url: string; size: number } | { ok: false; error: string }> {
  const f = await fetchImage(src.trim(), cfg.remote);
  if (!f.ok) return { ok: false, error: notDownloaded(f.error, src) };
  return { ok: true, url: await storeImage(db, cfg, f.buf, f.ext), size: f.buf.length };
}

/** Saves image bytes into the uploads once per content (SHA-256), and returns the /uploads url. */
export async function storeImage(db: Db, cfg: MediaConfig, buf: Buffer, ext: string): Promise<string> {
  if (!sniff(buf, ext)) throw new Error("not an image");
  const hash = createHash("sha256").update(buf).digest("hex");
  const known = await db.mediaHashes.get(hash);
  if (known && (await exists(join(cfg.uploadDir, known.url.slice("/uploads/".length))))) return known.url;
  const url = await saveUpload(cfg.uploadDir, MIME[ext], buf);
  try { await db.mediaHashes.insert({ id: hash, url, createdAt: new Date().toISOString() }); }
  catch (e) {
    if (!(e instanceof DuplicateKeyError)) throw e;
    // Stored at the same moment by another download (or the old copy is gone): keep one file.
    const other = await db.mediaHashes.get(hash);
    if (other && other.url !== url && (await exists(join(cfg.uploadDir, other.url.slice("/uploads/".length))))) { await unlink(join(cfg.uploadDir, url.slice("/uploads/".length))).catch(() => undefined); return other.url; }
    await db.mediaHashes.update(hash, { url });
  }
  return url;
}

/**
 * Copies a checked server file into the uploads folder (once per content: same bytes, same upload) and returns its
 * /uploads url. The file is opened again without following symlinks and re-checked, in case it changed since the preview.
 */
export async function copyServerImage(db: Db, cfg: MediaConfig, resolved: string, ext: string): Promise<string> {
  if (!cfg.mediaDir) throw new Error("media folder not configured");
  const root = await realpath(cfg.mediaDir);
  const real = await realpath(resolved);
  if (!real.startsWith(root + sep)) throw new Error("outside the media folder");
  const { fh, size } = await openRegular(real);
  let buf: Buffer;
  try { buf = Buffer.alloc(size); await fh.read(buf, 0, size, 0); } finally { await fh.close(); }
  return storeImage(db, cfg, buf, ext);
}

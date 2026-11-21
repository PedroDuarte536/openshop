import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { CONFIG } from "./config.ts";

export const TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
export const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
export const MAX_IMAGE_BYTES = CONFIG.uploads.maxImageBytes;
const MAX = MAX_IMAGE_BYTES;

/** Registers the raw image body parsers and the public read route. Upload route itself is added by the caller (needs auth). */
export function registerUploadParsers(app: FastifyInstance) {
  for (const t of Object.keys(TYPES)) {
    app.addContentTypeParser(t, { parseAs: "buffer", bodyLimit: MAX }, (_req, body, done) => done(null, body));
  }
}
const SIGS: [string, number[]][] = [["png", [0x89, 0x50, 0x4e, 0x47]], ["jpg", [0xff, 0xd8, 0xff]], ["gif", [0x47, 0x49, 0x46, 0x38]], ["webp", [0x52, 0x49, 0x46, 0x46]]];
export const sniff = (buf: Buffer, ext: string) => SIGS.some(([e, sig]) => e === ext && sig.every((b, i) => buf[i] === b))
  // "RIFF" alone is any RIFF file (e.g. WAV): WebP says so at bytes 8–11.
  && (ext !== "webp" || buf.toString("latin1", 8, 12) === "WEBP");

export async function saveUpload(dir: string, contentType: string, body: Buffer): Promise<string> {
  const ext = TYPES[contentType.split(";")[0]];
  if (!ext || !Buffer.isBuffer(body) || !sniff(body, ext)) throw new Error("unsupported or corrupt image");
  await mkdir(dir, { recursive: true });
  const name = `${randomBytes(CONFIG.uploads.nameBytes).toString("hex")}.${ext}`;
  await writeFile(join(dir, name), body);
  return `/uploads/${name}`;
}

export function registerUploadRead(app: FastifyInstance, dir: string) {
  app.get<{ Params: { name: string } }>("/uploads/:name", async (req, reply) => {
    const m = /^[a-f0-9]{32}\.(png|jpg|webp|gif)$/.exec(req.params.name);
    if (!m) return reply.code(404).send({ error: "not found" });
    try {
      const data = await readFile(join(dir, req.params.name));
      return reply.header("cache-control", `public, max-age=${CONFIG.uploads.cacheMaxAgeSeconds}, immutable`).header("x-content-type-options", "nosniff").type(MIME[m[1]]).send(data);
    } catch { return reply.code(404).send({ error: "not found" }); }
  });
}

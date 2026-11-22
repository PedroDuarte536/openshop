// Import routes (admin only). The upload route has its own body parsers and a 10 MB limit; every other route keeps
// the app's 1 MB JSON limit (C13).
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { strictValidator } from "../../strict.ts";
import { audit } from "../../audit.ts";
import { negotiate } from "../../negotiate.ts";
import type { Db } from "../../types.ts";
import { cell } from "../export.ts";
import { CatalogueError } from "../model.ts";
import { sendCatalogueError } from "../products.ts";
import { FIELD_LABELS, FIELDS, PRESETS } from "./mapping.ts";
import { FileError, LIMITS } from "./csv.ts";
import { commitJob, configureJob, createJob, decide, getJob, previewJob, type ImportDeps } from "./jobs.ts";
import type { MediaConfig } from "./media.ts";
import type { ImportRow } from "./types.ts";
import { CONFIG } from "../../config.ts";

const strict = { validatorCompiler: strictValidator };
const FILE_TYPES = ["text/csv", "application/csv", "text/plain", "application/json", "application/vnd.openshop.catalogue+json", "application/vnd.ms-excel", "application/octet-stream"];

const configureSchema = {
  type: "object", additionalProperties: false,
  properties: {
    mapping: { type: "object", maxProperties: LIMITS.columns, additionalProperties: { type: "string", maxLength: 120 } },
    preset: { type: ["string", "null"], maxLength: 40 },
    publish: { type: "array", maxItems: LIMITS.columns, items: { type: "string", maxLength: 40 } },
    newProperties: { type: "object", maxProperties: LIMITS.columns, additionalProperties: { type: "object", additionalProperties: false, required: ["type"], properties: { label: { type: "string", maxLength: 80 }, type: { type: "string", enum: ["text", "choice", "number", "boolean"] } } } },
    options: {
      type: "object", additionalProperties: false,
      properties: {
        mode: { type: "string", enum: ["upsert", "update", "create"] }, missing: { type: "string", enum: ["leave", "hide"] }, empty: { type: "string", enum: ["leave", "clear"] },
        stock: { type: "string", enum: ["set", "skip"] }, newVisible: { type: "boolean" }, createCategories: { type: "boolean" }, createProperties: { type: "boolean" },
        addChoiceValues: { type: "boolean" }, stopOnError: { type: "boolean" }, remoteImages: { type: "string", enum: ["download", "link"] },
      },
    },
  },
} as const;
const decisionsSchema = { type: "object", additionalProperties: false, required: ["decisions"], properties: { decisions: { type: "object", maxProperties: LIMITS.rows + 1, additionalProperties: { type: "string", enum: ["restore", "new", "skip"] } } } } as const;
const commitSchema = { type: "object", additionalProperties: false, required: ["previewAt"], properties: { previewAt: { type: "string", maxLength: 40 }, confirmHide: { type: "boolean" } } } as const;

/** A row as the preview and the report show it. */
export function rowView(r: ImportRow) {
  const raw = r.raw as Record<string, unknown>;
  const name = r.plan?.set?.name ?? raw.name ?? raw["Name *"] ?? r.plan?.name ?? null;
  const sku = r.plan?.set?.sku ?? raw.sku ?? null;
  return {
    row: r.rowNo, action: r.plan?.action ?? null, state: r.state, message: r.message ?? null, productId: r.plan?.productId ?? null,
    name: typeof name === "string" ? name.slice(0, 200) : null, sku: typeof sku === "string" ? sku.slice(0, 64) : null,
    errors: r.plan?.errors ?? [], warnings: r.plan?.warnings ?? [], diff: r.plan?.diff ?? null, deletedMatch: r.plan?.deletedMatch ?? null,
  };
}

export function registerImportAdmin(admin: FastifyInstance, { db, media }: { db: Db; media: MediaConfig }) {
  const deps = (req: FastifyRequest): ImportDeps => ({ db, user: req.userId ?? "unknown", media });
  const run = async <T>(reply: FastifyReply, fn: () => Promise<T>) => {
    try { return await fn(); }
    catch (e) { if (e instanceof FileError) return reply.code(400).send({ error: e.message, code: "bad_file" }); return sendCatalogueError(reply, e); }
  };

  // Upload: raw bytes in, a job out. Own scope: raw parsers and a 10 MB limit for this route only.
  admin.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(FILE_TYPES, { parseAs: "buffer", bodyLimit: LIMITS.bytes }, (_req, body, done) => done(null, body));
    scope.post<{ Querystring: { filename?: string } }>("/api/catalogue/imports", async (req, reply) =>
      run(reply, async () => {
        const body = req.body as Buffer;
        if (!Buffer.isBuffer(body) || !body.length) throw new FileError("The file is empty.");
        const filename = String(req.query.filename ?? req.headers["x-filename"] ?? "import").slice(0, 200);
        return reply.code(201).send(await createJob(deps(req), { body, filename, contentType: String(req.headers["content-type"] ?? "") }));
      }));
  });

  // The limits the screens mention ("up to 10 MB"), as configured on this server.
  admin.get("/api/catalogue/limits", async () => ({
    importMaxMb: Math.floor(LIMITS.bytes / 1024 / 1024), importMaxRows: LIMITS.rows, uploadMaxMb: Math.floor(CONFIG.uploads.maxImageBytes / 1024 / 1024),
  }));

  admin.get("/api/catalogue/imports", async () =>
    (await db.importJobs.find({}, { sort: { createdAt: -1 }, limit: 50 })).map(({ mapping: _m, newProperties: _n, catalogue: _c, ...j }) => j));

  // The job, plus what the mapping screen needs: fields, properties and presets.
  admin.get<{ Params: { id: string } }>("/api/catalogue/imports/:id", async (req, reply) =>
    run(reply, async () => {
      const j = await getJob(db, req.params.id);
      const defs = await db.attributes.find({}, { sort: { position: 1 } });
      const sample = (await db.importRows.find({ jobId: j.id }, { sort: { rowNo: 1 }, limit: 3 })).map((r) => r.raw);
      const { catalogue: _c, ...job } = j;
      return { ...job, sample, targets: { fields: FIELDS.map((f) => ({ value: f, label: FIELD_LABELS[f] })), properties: defs.map((d) => ({ value: `attr:${d.key}`, label: d.label, type: d.type })) }, presets: PRESETS.map((p) => ({ key: p.key, name: p.name })) };
    }));

  admin.put<{ Params: { id: string } }>("/api/catalogue/imports/:id", { schema: { body: configureSchema }, ...strict }, async (req, reply) =>
    run(reply, () => configureJob(deps(req), req.params.id, req.body as never)));

  admin.post<{ Params: { id: string } }>("/api/catalogue/imports/:id/preview", async (req, reply) => run(reply, () => previewJob(deps(req), req.params.id)));

  admin.post<{ Params: { id: string } }>("/api/catalogue/imports/:id/decisions", { schema: { body: decisionsSchema }, ...strict }, async (req, reply) =>
    run(reply, () => decide(deps(req), req.params.id, (req.body as { decisions: Record<string, "restore" | "new" | "skip"> }).decisions)));

  admin.post<{ Params: { id: string } }>("/api/catalogue/imports/:id/commit", { schema: { body: commitSchema }, ...strict }, async (req, reply) =>
    run(reply, async () => reply.code(202).send(await commitJob(deps(req), req.params.id, req.body as { previewAt: string; confirmHide?: boolean }))));

  admin.post<{ Params: { id: string } }>("/api/catalogue/imports/:id/cancel", async (req, reply) =>
    run(reply, async () => {
      const j = await getJob(db, req.params.id);
      if (j.status === "committing" || j.status === "done") throw new CatalogueError("This import has already been applied.", 409, "already_committed");
      await db.importJobs.update(j.id, { status: "cancelled", updatedAt: new Date().toISOString() });
      await audit(db, req.userId ?? "unknown", "cancel", "import", j.id);
      return { ok: true };
    }));

  // Rows: the preview and the report. JSON (paged) or CSV by the Accept header; cells are formula-safe (C6).
  admin.get<{ Params: { id: string }; Querystring: { action?: string; state?: string; skip?: string; limit?: string } }>("/api/catalogue/imports/:id/rows", async (req, reply) =>
    run(reply, async () => {
      reply.header("vary", "Accept");
      const type = negotiate(req.headers.accept, ["application/json", "text/csv"]);
      if (!type) return reply.code(406).send({ error: "not acceptable" });
      const j = await getJob(db, req.params.id);
      const actions = (req.query.action ?? "").split(",").filter(Boolean);
      const states = (req.query.state ?? "").split(",").filter(Boolean);
      const all = (await db.importRows.find({ jobId: j.id }, { sort: { rowNo: 1 } }))
        .filter((r) => {
          const undecided = !!r.plan?.deletedMatch && !r.plan.deletedMatch.decision && r.plan.action !== "error";
          const byAction = !actions.length || (actions.includes(r.plan?.action ?? "") && !undecided) || (actions.includes("deleted") && !!r.plan?.deletedMatch);
          return byAction && (!states.length || states.includes(r.state));
        });
      if (type === "text/csv") {
        const head = ["row", "action", "state", "name", "sku", "problems", "warnings"];
        const body = "\uFEFF" + [head, ...all.map(rowView).map((v) => [v.row, v.action, v.state, v.name, v.sku, [...v.errors.map((e) => `${e.column}: ${e.message}`), ...(v.message ? [v.message] : [])].join("; "), v.warnings.join("; ")])]
          .map((r) => r.map((x) => cell(x)).join(",")).join("\r\n") + "\r\n";
        return reply.type("text/csv; charset=utf-8").header("cache-control", "no-store").header("content-disposition", `attachment; filename="import-report-${j.id.slice(0, 8)}.csv"`).send(body);
      }
      const skip = Math.max(0, Math.trunc(Number(req.query.skip) || 0)), limit = Math.min(500, Math.max(1, Math.trunc(Number(req.query.limit) || 100)));
      return { items: all.slice(skip, skip + limit).map(rowView), total: all.length };
    }));
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { strictValidator } from "../strict.ts";
import type { Db } from "../types.ts";
import { CatalogueError } from "./model.ts";
import { catalogueChanged } from "./meta.ts";
import { registerProductList } from "./list.ts";
import { createProduct, deleteImpact, deleteProduct, restoreProduct, updateProduct, type WriteCtx } from "./service.ts";

const strict = { validatorCompiler: strictValidator };

// Shape only; the domain rules (cents, bounds, references, bundles, variants) live in model.ts and service.ts.
const attrValue = { type: ["string", "number", "boolean", "array", "null"], maxLength: 1000, maxItems: 20, items: { type: "string", maxLength: 200 } } as const;
export const productShape = {
  name: { type: "string", maxLength: 1000 },
  price: { type: "number" },
  active: { type: "boolean" },
  stock: { type: "number" },
  categoryId: { type: ["string", "null"], maxLength: 64 },
  description: { type: "string", maxLength: 20000 },
  images: { type: "array", maxItems: 10, items: { type: "string", maxLength: 2100 } },
  sku: { type: ["string", "null"], maxLength: 64 },
  type: { type: "string", enum: ["simple", "bundle"] },
  attributes: { type: "object", maxProperties: 100, additionalProperties: attrValue },
  bundle: {
    type: ["object", "null"], additionalProperties: false,
    properties: {
      components: { type: "array", maxItems: 50, items: { type: "object", additionalProperties: false, required: ["productId", "qty"], properties: { productId: { type: "string", maxLength: 64 }, qty: { type: "number" } } } },
      priceMode: { type: "string", maxLength: 10 }, offerScope: { type: "string", maxLength: 10 }, showOnComponents: { type: "boolean" },
    },
  },
} as const;
const createSchema = { type: "object", additionalProperties: false, required: ["name"], properties: productShape } as const;
const patchSchema = { type: "object", additionalProperties: false, properties: { ...productShape, version: { type: "integer" } } } as const;
const deleteSchema = { type: ["object", "null"], additionalProperties: false, properties: { bundles: { type: "object", maxProperties: 2000, additionalProperties: { type: "string", enum: ["keep", "hide"] } } } } as const;
const bulkSchema = {
  type: "object", additionalProperties: false, required: ["ids", "action"],
  properties: { ids: { type: "array", minItems: 1, maxItems: 1000, items: { type: "string", maxLength: 64 } }, action: { type: "string", enum: ["show", "hide", "category"] }, categoryId: { type: ["string", "null"], maxLength: 64 } },
} as const;

export function sendCatalogueError(reply: FastifyReply, e: unknown) {
  if (e instanceof CatalogueError) return reply.code(e.status).send({ error: e.message, ...(e.code ? { code: e.code } : {}), ...(e.fields ? { fields: e.fields } : {}), ...(e.details ?? {}) });
  throw e;
}

export interface ProductRoutesOptions {
  db: Db;
  /** The list/search/export route (GET /api/products) is registered by the search module. */
  list?: (admin: FastifyInstance) => void;
}

/** Admin product routes. Register inside the authenticated scope. */
export function registerProductAdmin(admin: FastifyInstance, { db, list }: ProductRoutesOptions) {
  const ctx = (req: FastifyRequest): WriteCtx => ({ db, user: req.userId ?? "unknown" });
  const run = async <T>(reply: FastifyReply, fn: () => Promise<T>) => { try { return await fn(); } catch (e) { return sendCatalogueError(reply, e); } };

  (list ?? ((a: FastifyInstance) => registerProductList(a, { db })))(admin);

  admin.get<{ Params: { id: string } }>("/api/products/:id", async (req, reply) => (await db.products.get(req.params.id)) ?? reply.code(404).send({ error: "not found" }));

  admin.post("/api/products", { schema: { body: createSchema }, ...strict }, async (req, reply) =>
    run(reply, async () => reply.code(201).send(await createProduct(ctx(req), req.body as Record<string, unknown>))));

  admin.patch<{ Params: { id: string } }>("/api/products/:id", { schema: { body: patchSchema }, ...strict }, async (req, reply) =>
    run(reply, async () => {
      const { version, ...input } = req.body as Record<string, unknown> & { version?: number };
      return updateProduct(ctx(req), req.params.id, input, { version });
    }));

  // Products are never removed (S-4): DELETE is a soft delete of a hidden product, with a decision per bundle.
  admin.delete<{ Params: { id: string } }>("/api/products/:id", { schema: { body: deleteSchema }, ...strict }, async (req, reply) =>
    run(reply, async () => {
      await deleteProduct(ctx(req), req.params.id, (req.body as { bundles?: Record<string, "keep" | "hide"> } | null)?.bundles ?? {});
      return reply.code(204).send();
    }));

  admin.get<{ Params: { id: string } }>("/api/products/:id/delete-impact", async (req, reply) => run(reply, () => deleteImpact(ctx(req), req.params.id)));

  admin.post<{ Params: { id: string } }>("/api/products/:id/restore", async (req, reply) => run(reply, () => restoreProduct(ctx(req), req.params.id)));

  // Show, hide or move several products. Deleting is never a bulk action (it needs the per-product confirmation).
  admin.post("/api/products/bulk", { schema: { body: bulkSchema }, ...strict }, async (req, reply) =>
    run(reply, async () => {
      const b = req.body as { ids: string[]; action: "show" | "hide" | "category"; categoryId?: string | null };
      if (b.action === "category" && b.categoryId === undefined) throw new CatalogueError("Choose a category.", 400, "invalid", [{ field: "categoryId", message: "is required" }]);
      const input = b.action === "category" ? { categoryId: b.categoryId ?? null } : { active: b.action === "show" };
      let changed = 0;
      const failed: { id: string; error: string }[] = [];
      for (const id of [...new Set(b.ids)]) {
        try { await updateProduct(ctx(req), id, input, { batch: true }); changed++; }
        catch (e) { if (e instanceof CatalogueError) failed.push({ id, error: e.message }); else throw e; }
      }
      await catalogueChanged(db);
      return { changed, failed };
    }));
}

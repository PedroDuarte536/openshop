import Fastify from "fastify";
import type { DataStore, Doc } from "@openshop/db";
import { renderPage, type PageDoc } from "@openshop/renderer";

interface Product extends Doc { name: string; price: number; active: boolean }
interface Page extends Doc { slug: string; title: string; blocks: PageDoc["blocks"]; html: string }

const productSchema = {
  type: "object",
  required: ["name", "price"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1 },
    price: { type: "number", minimum: 0 },
    active: { type: "boolean", default: true },
  },
} as const;

const pageSchema = {
  type: "object",
  required: ["slug", "title", "blocks"],
  additionalProperties: false,
  properties: {
    slug: { type: "string", pattern: "^[a-z0-9-]+$" },
    title: { type: "string", minLength: 1 },
    blocks: { type: "array" },
  },
} as const;

export function buildApp(store: DataStore) {
  const app = Fastify({ logger: false });
  const products = store.collection<Product>("products");
  const pages = store.collection<Page>("pages");

  app.get("/health", async () => ({ ok: true }));

  // ---- products ----
  app.get("/api/products", async () => products.find({}, { sort: { name: 1 } }));
  app.get<{ Params: { id: string } }>("/api/products/:id", async (req, reply) =>
    (await products.get(req.params.id)) ?? reply.code(404).send({ error: "not found" }));
  app.post("/api/products", { schema: { body: productSchema } }, async (req, reply) =>
    reply.code(201).send(await products.insert(req.body as Omit<Product, "id">)));
  app.patch<{ Params: { id: string } }>("/api/products/:id", { schema: { body: { ...productSchema, required: [] } } }, async (req, reply) =>
    (await products.update(req.params.id, req.body as Partial<Product>)) ?? reply.code(404).send({ error: "not found" }));
  app.delete<{ Params: { id: string } }>("/api/products/:id", async (req, reply) =>
    (await products.delete(req.params.id)) ? reply.code(204).send() : reply.code(404).send({ error: "not found" }));

  // ---- pages: JSON is saved, HTML is rendered on save ----
  const save = (body: { slug: string; title: string; blocks: PageDoc["blocks"] }) => {
    const html = renderPage({ title: body.title, blocks: body.blocks }); // throws on invalid blocks
    return { ...body, html };
  };
  app.get("/api/pages", async () => (await pages.find({}, { sort: { slug: 1 } })).map(({ html: _h, ...p }) => p));
  app.get<{ Params: { id: string } }>("/api/pages/:id", async (req, reply) =>
    (await pages.get(req.params.id)) ?? reply.code(404).send({ error: "not found" }));
  app.post("/api/pages", { schema: { body: pageSchema } }, async (req, reply) => {
    const body = req.body as { slug: string; title: string; blocks: PageDoc["blocks"] };
    if (await pages.count({ slug: body.slug })) return reply.code(409).send({ error: "slug exists" });
    try { return reply.code(201).send(await pages.insert(save(body))); }
    catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });
  app.put<{ Params: { id: string } }>("/api/pages/:id", { schema: { body: pageSchema } }, async (req, reply) => {
    const body = req.body as { slug: string; title: string; blocks: PageDoc["blocks"] };
    try { return (await pages.update(req.params.id, save(body))) ?? reply.code(404).send({ error: "not found" }); }
    catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });

  // ---- storefront delivery: serve pre-rendered html ----
  app.get<{ Params: { slug: string } }>("/s/:slug", async (req, reply) => {
    const [page] = await pages.find({ slug: req.params.slug }, { limit: 1 });
    if (!page) return reply.code(404).type("text/html").send("<h1>Not found</h1>");
    return reply.header("cache-control", "public, max-age=60").type("text/html").send(page.html);
  });

  return app;
}

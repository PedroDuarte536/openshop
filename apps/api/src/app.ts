import { randomBytes } from "node:crypto";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type { DataStore } from "@openshop/db";
import type { Block } from "@openshop/renderer";
import { openDb, type Category, type Order, type Product } from "./types.ts";
import { signToken, verifyPassword, verifyToken } from "./auth.ts";
import { OrderError, placeOrder } from "./orders.ts";
import { renderStored, rerenderDynamicPages } from "./pages.ts";
import { registerUploadParsers, registerUploadRead, saveUpload } from "./uploads.ts";
import { registerStorefront } from "./storefront.ts";

export interface AppOptions { authSecret?: string; uploadDir?: string }

const productProps = {
  name: { type: "string", minLength: 1, maxLength: 200 },
  price: { type: "number", minimum: 0 },
  active: { type: "boolean" },
  stock: { type: "integer", minimum: 0 },
  categoryId: { type: ["string", "null"] },
  description: { type: "string", maxLength: 5000 },
  images: { type: "array", items: { type: "string", pattern: "^/uploads/[a-f0-9]{32}\\.(png|jpg|webp|gif)$|^https://" }, maxItems: 10 },
} as const;
// Defaults live in the handler, not the schema: schema defaults would also overwrite fields on PATCH.
const productCreate = { type: "object", required: ["name", "price"], additionalProperties: false, properties: productProps } as const;
const productPatch = { type: "object", additionalProperties: false, properties: productProps } as const;
const categorySchema = {
  type: "object", required: ["name", "slug"], additionalProperties: false,
  properties: { name: { type: "string", minLength: 1 }, slug: { type: "string", pattern: "^[a-z0-9-]+$" } },
} as const;
const pageSchema = {
  type: "object", required: ["slug", "title", "blocks"], additionalProperties: false,
  properties: { slug: { type: "string", pattern: "^[a-z0-9-]+$" }, title: { type: "string", minLength: 1 }, blocks: { type: "array" } },
} as const;
const orderSchema = {
  type: "object", required: ["items", "customer"], additionalProperties: false,
  properties: {
    items: { type: "array", minItems: 1, maxItems: 50, items: { type: "object", required: ["productId", "qty"], additionalProperties: false, properties: { productId: { type: "string" }, qty: { type: "integer" } } } },
    customer: { type: "object", required: ["name", "email", "address"], additionalProperties: false, properties: { name: { type: "string", minLength: 1, maxLength: 200 }, email: { type: "string", format: "email" }, address: { type: "string", minLength: 1, maxLength: 1000 } } },
  },
} as const;

export function buildApp(store: DataStore, opts: AppOptions = {}) {
  const secret = opts.authSecret ?? randomBytes(32).toString("hex");
  const uploadDir = opts.uploadDir ?? "uploads";
  const db = openDb(store);
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  registerUploadParsers(app);

  app.get("/health", async () => ({ ok: true }));

  // ---- auth ----
  const attempts = new Map<string, { n: number; reset: number }>();
  app.post("/api/auth/login", { schema: { body: { type: "object", required: ["email", "password"], additionalProperties: false, properties: { email: { type: "string" }, password: { type: "string" } } } } }, async (req, reply) => {
    const now = Date.now(), a = attempts.get(req.ip);
    if (a && a.reset > now && a.n >= 10) return reply.code(429).send({ error: "too many attempts" });
    const { email, password } = req.body as { email: string; password: string };
    const [u] = await db.users.find({ email: email.toLowerCase() }, { limit: 1 });
    // Always verify something, so timing doesn't reveal which emails exist.
    const ok = await verifyPassword(password, u?.passwordHash ?? "00:00");
    if (!u || !ok) {
      attempts.set(req.ip, a && a.reset > now ? { n: a.n + 1, reset: a.reset } : { n: 1, reset: now + 60_000 });
      return reply.code(401).send({ error: "invalid credentials" });
    }
    attempts.delete(req.ip);
    return { token: signToken(u.id, secret) };
  });

  const requireAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    const h = req.headers.authorization ?? "";
    const sub = h.startsWith("Bearer ") ? verifyToken(h.slice(7), secret) : null;
    if (!sub) return reply.code(401).send({ error: "unauthorized" });
  };

  // ---- public shop API ----
  app.get<{ Querystring: { categoryId?: string } }>("/api/shop/products", async (req) =>
    db.products.find(req.query.categoryId ? { active: true, categoryId: req.query.categoryId } : { active: true }, { sort: { name: 1 } }));
  app.get("/api/shop/categories", async () => db.categories.find({}, { sort: { name: 1 } }));
  app.post("/api/shop/orders", { schema: { body: orderSchema } }, async (req, reply) => {
    const b = req.body as { items: { productId: string; qty: number }[]; customer: { name: string; email: string; address: string } };
    try { return reply.code(201).send(await placeOrder(db, b.items, b.customer)); }
    catch (e) { if (e instanceof OrderError) return reply.code(e.status).send({ error: e.message }); throw e; }
  });

  // ---- admin API (everything below requires a valid token) ----
  app.register(async (admin) => {
    admin.addHook("onRequest", requireAuth);
    const notFound = (reply: FastifyReply) => reply.code(404).send({ error: "not found" });

    // products
    admin.get("/api/products", async () => db.products.find({}, { sort: { name: 1 } }));
    admin.get<{ Params: { id: string } }>("/api/products/:id", async (req, reply) => (await db.products.get(req.params.id)) ?? notFound(reply));
    admin.post("/api/products", { schema: { body: productCreate } }, async (req, reply) => {
      const b = req.body as Omit<Product, "id">;
      const p = await db.products.insert({ active: true, stock: 0, ...b });
      await rerenderDynamicPages(db);
      return reply.code(201).send(p);
    });
    admin.patch<{ Params: { id: string } }>("/api/products/:id", { schema: { body: productPatch } }, async (req, reply) => {
      const p = await db.products.update(req.params.id, req.body as Partial<Product>);
      if (!p) return notFound(reply);
      await rerenderDynamicPages(db);
      return p;
    });
    admin.delete<{ Params: { id: string } }>("/api/products/:id", async (req, reply) => {
      if (!(await db.products.delete(req.params.id))) return notFound(reply);
      await rerenderDynamicPages(db);
      return reply.code(204).send();
    });

    // categories
    admin.get("/api/categories", async () => db.categories.find({}, { sort: { name: 1 } }));
    admin.post("/api/categories", { schema: { body: categorySchema } }, async (req, reply) => {
      const b = req.body as Omit<Category, "id">;
      if (await db.categories.count({ slug: b.slug })) return reply.code(409).send({ error: "slug exists" });
      return reply.code(201).send(await db.categories.insert(b));
    });
    admin.delete<{ Params: { id: string } }>("/api/categories/:id", async (req, reply) => {
      if (!(await db.categories.delete(req.params.id))) return notFound(reply);
      for (const p of await db.products.find({ categoryId: req.params.id })) await db.products.update(p.id, { categoryId: null });
      await rerenderDynamicPages(db);
      return reply.code(204).send();
    });

    // uploads
    admin.post("/api/uploads", async (req, reply) => {
      try { return reply.code(201).send({ url: await saveUpload(uploadDir, req.headers["content-type"] ?? "", req.body as Buffer) }); }
      catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    });

    // orders and customers
    admin.get("/api/orders", async () => db.orders.find({}, { sort: { createdAt: -1 } }));
    admin.patch<{ Params: { id: string } }>("/api/orders/:id", { schema: { body: { type: "object", required: ["status"], additionalProperties: false, properties: { status: { enum: ["pending", "paid", "shipped", "cancelled"] } } } } }, async (req, reply) =>
      (await db.orders.update(req.params.id, { status: (req.body as { status: Order["status"] }).status })) ?? notFound(reply));
    admin.get("/api/customers", async () => db.customers.find({}, { sort: { email: 1 } }));

    // pages: JSON is saved, HTML is rendered on save
    const save = async (b: { slug: string; title: string; blocks: Block[] }) => ({ ...b, html: await renderStored(db, b.title, b.blocks) });
    admin.get("/api/pages", async () => (await db.pages.find({}, { sort: { slug: 1 } })).map(({ html: _h, ...p }) => p));
    admin.get<{ Params: { id: string } }>("/api/pages/:id", async (req, reply) => (await db.pages.get(req.params.id)) ?? notFound(reply));
    admin.post("/api/pages", { schema: { body: pageSchema } }, async (req, reply) => {
      const b = req.body as { slug: string; title: string; blocks: Block[] };
      if (await db.pages.count({ slug: b.slug })) return reply.code(409).send({ error: "slug exists" });
      try { return reply.code(201).send(await db.pages.insert(await save(b))); }
      catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    });
    admin.put<{ Params: { id: string } }>("/api/pages/:id", { schema: { body: pageSchema } }, async (req, reply) => {
      const b = req.body as { slug: string; title: string; blocks: Block[] };
      const [clash] = await db.pages.find({ slug: b.slug }, { limit: 1 });
      if (clash && clash.id !== req.params.id) return reply.code(409).send({ error: "slug exists" });
      try { return (await db.pages.update(req.params.id, await save(b))) ?? notFound(reply); }
      catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    });
  });

  // ---- public delivery ----
  registerUploadRead(app, uploadDir);
  registerStorefront(app, db);
  const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https: data:; form-action 'self'; base-uri 'none'";
  const servePage = async (slug: string, reply: FastifyReply) => {
    const [page] = await db.pages.find({ slug }, { limit: 1 });
    if (!page) return reply.code(404).header("content-security-policy", CSP).type("text/html").send("<h1>Not found</h1>");
    return reply.header("cache-control", "public, max-age=60").header("content-security-policy", CSP).type("text/html").send(page.html);
  };
  app.get<{ Params: { slug: string } }>("/s/:slug", (req, reply) => servePage(req.params.slug, reply));
  app.get("/", async (_req, reply) => ((await db.pages.count({ slug: "home" })) ? servePage("home", reply) : reply.redirect("/shop")));

  return app;
}

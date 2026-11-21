import { randomBytes } from "node:crypto";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type { DataStore } from "@openshop/db";
import { openDb, type Order, type Product } from "./types.ts";
import type { PermissionId, Requirement } from "@openshop/iam";
import { registerProductAdmin } from "./catalogue/products.ts";
import { registerAttributeAdmin } from "./catalogue/attributes.ts";
import { registerVariantAdmin } from "./catalogue/variant-routes.ts";
import { registerImportAdmin } from "./catalogue/import/routes.ts";
import { importHousekeeping } from "./catalogue/import/jobs.ts";
import type { RemoteOptions } from "./catalogue/import/remote.ts";
import { permissioned } from "./catalogue/access.ts";
import { publicProduct } from "./catalogue/model.ts";
import { catalogueChanged } from "./catalogue/meta.ts";
import { OrderError, placeOrder, setOrderStatus } from "./orders.ts";
import { ensureSystemPages, migratePages, renderStored, RENDERER_VERSION } from "./pages.ts";
import { registerUploadParsers, registerUploadRead, saveUpload } from "./uploads.ts";
import { PAGE_CSP, registerStorefront } from "./storefront.ts";
import { createPricingService } from "./pricing-service.ts";
import { registerDiscountAdmin } from "./discounts.ts";
import { registerShopApi } from "./shop-api.ts";
import { migrateIdentities } from "./migrations.ts";
import { createAccounts } from "./accounts.ts";
import { registerAccountPages } from "./account-pages.ts";
import { registerCustomersAdmin } from "./customers-admin.ts";
import { registerInsights } from "./insights.ts";
import { CONFIG } from "./config.ts";
import { migrateIam } from "./migrations.ts";
import { createAggregator, pruneActivity } from "./activity.ts";
import { createAuthorizer, type AdminRoute } from "./authorize.ts";
import { createStaff } from "./staff.ts";
import { registerStaffAuth, registerStaffSelf } from "./staff-auth.ts";
import { registerStaffAdmin } from "./staff-admin.ts";
import { getSecurity } from "./security.ts";

declare module "fastify" {
  interface FastifyRequest { userId?: string }
  interface FastifyInstance { adminRoutes: AdminRoute[]; allRoutes: { method: string; url: string }[] }
}

export interface AppOptions {
  authSecret?: string; uploadDir?: string;
  /** Public address of the shop (e.g. https://shop.example), used to show full account links in the backoffice. */
  shopUrl?: string;
  /**
   * Folder on the server whose images may be named in product imports (they are copied into the uploads). Set by
   * whoever runs the server (IMPORT_MEDIA_DIR); never configurable from the backoffice (C20). Unset: no server paths.
   */
  importMediaDir?: string | null;
  /** Only for tests: how https:// images of imports are fetched (name resolution, allowed addresses, CA). */
  remoteImages?: RemoteOptions;
  /** Only for tests: new activity-log rows per minute before the rest is only counted (default 1000). */
  activityCeiling?: number;
  /** ADMIN_EMAIL: picks the owner account when upgrading a database that has several backoffice users. */
  adminEmail?: string;
  /** Public address of the backoffice (e.g. https://admin.shop.example), used for absolute invite links. */
  backofficeUrl?: string;
  /**
   * TRUST_PROXY: the reverse proxy (addresses or CIDR ranges) allowed to tell the client's address in
   * X-Forwarded-For. Without it, behind a proxy every visitor has the proxy's address (sign-in limits, activity log).
   */
  trustProxy?: boolean | string;
}

/**
 * TRUST_PROXY: "10.0.0.5" or "10.0.0.5,10.1.0.0/16" (the proxy's addresses: recommended), or "true" (trust any
 * sender: not recommended, a client could then fake its address). Hop counts are not supported by Fastify here.
 */
export function parseTrustProxy(v: string | undefined): boolean | string | undefined {
  if (!v || !v.trim()) return undefined;
  const t = v.trim();
  return t === "true" || t === "false" ? t === "true" : t;
}

const categorySchema = {
  type: "object", required: ["name", "slug"], additionalProperties: false,
  properties: { name: { type: "string", minLength: 1 }, slug: { type: "string", pattern: "^[a-z0-9-]+$" } },
} as const;
const pageSchema = {
  type: "object", required: ["slug", "title", "nodes"], additionalProperties: false,
  properties: { slug: { type: "string", pattern: "^[a-z0-9-]+$" }, title: { type: "string", minLength: 1 }, theme: { type: "object" }, nodes: { type: "array" } },
} as const;
const orderSchema = {
  type: "object", required: ["items", "customer"], additionalProperties: false,
  properties: {
    items: { type: "array", minItems: 1, maxItems: CONFIG.orders.maxLines, items: { type: "object", required: ["productId", "qty"], additionalProperties: false, properties: { productId: { type: "string" }, qty: { type: "integer" } } } },
    customer: { type: "object", required: ["name", "email", "address"], additionalProperties: false, properties: { name: { type: "string", minLength: 1, maxLength: 200 }, email: { type: "string", format: "email" }, address: { type: "string", minLength: 1, maxLength: 1000 } } },
    codes: { type: "array", maxItems: 1, items: { type: "string", maxLength: 64 } },
    quote: { type: "string", maxLength: 40 },
    selection: { type: "object", additionalProperties: false, properties: { scenario: { type: ["string", "null"], enum: ["automatic", "code", null] }, declined: { type: "array", maxItems: 20, items: { type: "string", maxLength: 64 } } } },
  },
} as const;

export function buildApp(store: DataStore, opts: AppOptions = {}) {
  const secret = opts.authSecret ?? randomBytes(32).toString("hex");
  const uploadDir = opts.uploadDir ?? "uploads";
  const db = openDb(store);
  // Repeated query parameters keep their last value (never an array), so a crafted URL can't reach a handler or a
  // database filter with an unexpected type.
  const app = Fastify({ logger: false, bodyLimit: CONFIG.http.bodyLimitBytes, ...(opts.trustProxy !== undefined ? { trustProxy: opts.trustProxy } : {}), routerOptions: { querystringParser: (s: string) => Object.fromEntries(new URLSearchParams(s)) } });
  // Every route, for the route-inventory test (admin routes must declare a permission; anything else is public on purpose).
  const allRoutes: { method: string; url: string }[] = [];
  app.addHook("onRoute", (r) => { for (const m of [r.method].flat()) if (m !== "HEAD") allRoutes.push({ method: m, url: r.url! }); });
  app.decorate("allRoutes", allRoutes);
  const pricing = createPricingService(db);
  const accounts = createAccounts(db, secret);
  app.decorateRequest("userId", undefined);
  app.decorateRequest("staff", undefined);
  const aggregate = createAggregator(db, opts.activityCeiling);
  const authz = createAuthorizer(db, secret, aggregate);
  const staff = createStaff(db, { backofficeUrl: opts.backofficeUrl });
  const adminRoutes: AdminRoute[] = [];
  app.decorate("adminRoutes", adminRoutes);
  registerUploadParsers(app);
  // Nothing this server sends may be sniffed into another type (e.g. JSON or an upload run as a script).
  app.addHook("onSend", async (_req, reply) => { if (!reply.hasHeader("x-content-type-options")) reply.header("x-content-type-options", "nosniff"); });
  // One-time upgrades: re-render pages made by an older renderer; count past orders for "first N orders".
  // Staff accounts: upgrade older databases (one owner, everyone else keeps full access); prune old activity hourly.
  let pruner: NodeJS.Timeout | undefined;
  const prune = async () => { try { await pruneActivity(db, (await getSecurity(db)).activityRetentionDays); } catch (e) { console.error("activity pruning failed", e); } };
  app.addHook("onReady", async () => {
    await migratePages(db); await migrateIdentities(db); await migrateIam(db, { adminEmail: opts.adminEmail }); await importHousekeeping(db);
    await prune();
    pruner = setInterval(prune, 3600_000); pruner.unref();
  });
  app.addHook("onClose", async () => { if (pruner) clearInterval(pruner); });

  app.get("/health", async () => ({ ok: true }));

  // ---- staff sign-in and one-time links (public) ----
  registerStaffAuth(app, { db, staff, secret, aggregate });

  // ---- public shop API ----
  // Public: only the allowlisted projection ever leaves (C1), never the stored document.
  app.get<{ Querystring: { categoryId?: string } }>("/api/shop/products", async (req) => {
    const defs = await db.attributes.find({});
    const list = await db.products.find(req.query.categoryId ? { active: true, categoryId: req.query.categoryId } : { active: true }, { sort: { name: 1 } });
    return list.map((p) => publicProduct(p, defs));
  });
  app.get("/api/shop/categories", async () => db.categories.find({}, { sort: { name: 1 } }));
  app.post("/api/shop/orders", { schema: { body: orderSchema } }, async (req, reply) => {
    const b = req.body as { items: { productId: string; qty: number }[]; customer: { name: string; email: string; address: string }; codes?: string[]; quote?: string; selection?: { scenario?: string | null; declined?: string[] } };
    try {
      const selection = b.selection ? { scenario: b.selection.scenario ?? null, declined: b.selection.declined ?? [] } : null;
      return reply.code(201).send(await placeOrder(db, pricing, b.items, b.customer, { codes: b.codes, selection, expectedQuote: b.quote ?? null, account: await accounts.account(req) }));
    }
    catch (e) { if (e instanceof OrderError) return reply.code(e.status).send({ error: e.message, ...(e.code ? { code: e.code } : {}), ...(e.details ? { details: e.details } : {}) }); throw e; }
  });
  registerShopApi(app, { db, pricing, accounts });
  registerAccountPages(app, { db, accounts });

  // ---- admin API (everything below requires a valid token) ----
  app.register(async (admin) => {
    // Every route below declares the permission it needs (config.perm); the server refuses to start otherwise.
    authz.guardScope(admin, adminRoutes);
    // The staff member's id, for audit entries and "created by" fields.
    admin.addHook("preHandler", async (req) => { req.userId = req.staff?.id; });
    const notFound = (reply: FastifyReply) => reply.code(404).send({ error: "not found" });

    // products (catalogue module: validation, SKUs, bundles, variants, lifecycle; products are never removed).
    // Its routes get their staff permissions from the wrapper (reads: catalog.view, changes: catalog.manage,
    // stock-only edit of one product: catalog.stock).
    const perm = (p: Requirement) => ({ config: { perm: p } });
    const catalogue = permissioned(admin, authz.allow);
    registerProductAdmin(catalogue, { db });
    registerAttributeAdmin(catalogue, { db });
    registerVariantAdmin(catalogue, { db });
    registerImportAdmin(catalogue, { db, media: { uploadDir, mediaDir: opts.importMediaDir ?? null, remote: opts.remoteImages } });

    // categories
    admin.get("/api/categories", perm("catalog.view"), async () => db.categories.find({}, { sort: { name: 1 } }));
    admin.post("/api/categories", { ...perm("catalog.manage"), schema: { body: categorySchema } }, async (req, reply) => {
      const b = req.body as { name: string; slug: string };
      if (await db.categories.count({ slug: b.slug })) return reply.code(409).send({ error: "slug exists" });
      const c = await db.categories.insert(b);
      await catalogueChanged(db, { rerender: false });
      return reply.code(201).send(c);
    });
    admin.delete<{ Params: { id: string } }>("/api/categories/:id", perm("catalog.manage"), async (req, reply) => {
      if (!(await db.categories.delete(req.params.id))) return notFound(reply);
      for (const p of await db.products.find({ categoryId: req.params.id })) await db.products.update(p.id, { categoryId: null });
      await catalogueChanged(db);
      return reply.code(204).send();
    });

    // uploads
    admin.post("/api/uploads", perm({ any: ["catalog.manage", "pages.manage"] }), async (req, reply) => {
      try { return reply.code(201).send({ url: await saveUpload(uploadDir, req.headers["content-type"] ?? "", req.body as Buffer) }); }
      catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    });

    // orders and customers
    admin.get("/api/orders", perm("orders.view"), async () => db.orders.find({}, { sort: { createdAt: -1 } }));
    // The permission depends on the target status (and reopening a cancelled order needs "Cancel and reopen" as well).
    admin.patch<{ Params: { id: string } }>("/api/orders/:id", { ...perm({ any: ["orders.fulfil", "orders.payments", "orders.cancel"] }), schema: { body: { type: "object", required: ["status"], additionalProperties: false, properties: { status: { enum: ["pending", "paid", "shipped", "cancelled"] } } } } }, async (req, reply) => {
      const target = (req.body as { status: Order["status"] }).status;
      const cur = await db.orders.get(req.params.id);
      if (!cur) return notFound(reply);
      const forTarget = target === "shipped" ? "orders.fulfil" : target === "cancelled" ? "orders.cancel" : "orders.payments";
      const needs: PermissionId[] = cur.status === "cancelled" && target !== "cancelled" ? ["orders.cancel", forTarget] : [forTarget];
      if (!(await authz.allow(req, reply, { all: needs }))) return reply;
      try { return (await setOrderStatus(db, req.params.id, (req.body as { status: Order["status"] }).status)) ?? notFound(reply); }
      catch (e) { if (e instanceof OrderError) return reply.code(e.status).send({ error: e.message, ...(e.code ? { code: e.code } : {}) }); throw e; }
    });

    // discounts, codes, simulator, settings, audit
    registerDiscountAdmin(admin, { db, pricing, authz });
    // customers, accounts and profiles; insights
    registerCustomersAdmin(admin, { db, accounts, pricing, shopUrl: opts.shopUrl, authz });
    registerInsights(admin, { db });
    // staff: me, password, sign-out, beacons (any staff); team, groups, activity, security settings (owner only)
    registerStaffSelf(admin, { db, staff, secret, aggregate });
    registerStaffAdmin(admin, { db, staff });

    // pages: the document is saved cleaned, and HTML is rendered on save
    type PageBody = { slug: string; title: string; theme?: object; nodes: unknown[] };
    const save = async (b: PageBody) => {
      const { doc, html } = await renderStored(db, { title: b.title, theme: b.theme, nodes: b.nodes });
      return { slug: b.slug, title: doc.title, theme: doc.theme!, nodes: doc.nodes, html, rendererVersion: RENDERER_VERSION };
    };
    admin.get("/api/pages", perm("pages.manage"), async () => {
      await ensureSystemPages(db);
      return (await db.pages.find({}, { sort: { slug: 1 } })).map(({ html: _h, nodes: _n, ...p }) => p);
    });
    admin.get<{ Params: { id: string } }>("/api/pages/:id", perm("pages.manage"), async (req, reply) => (await db.pages.get(req.params.id)) ?? notFound(reply));
    admin.post("/api/pages", { ...perm("pages.manage"), schema: { body: pageSchema } }, async (req, reply) => {
      const b = req.body as PageBody;
      if (await db.pages.count({ slug: b.slug })) return reply.code(409).send({ error: "That address is already used by another page" });
      try { return reply.code(201).send(await db.pages.insert(await save(b))); }
      catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    });
    admin.put<{ Params: { id: string } }>("/api/pages/:id", { ...perm("pages.manage"), schema: { body: pageSchema } }, async (req, reply) => {
      const b = req.body as PageBody;
      const cur = await db.pages.get(req.params.id);
      if (!cur) return notFound(reply);
      const slug = cur.system ? cur.slug : b.slug; // essential pages keep their fixed address
      const [clash] = await db.pages.find({ slug }, { limit: 1 });
      if (clash && clash.id !== cur.id) return reply.code(409).send({ error: "That address is already used by another page" });
      try { return (await db.pages.update(cur.id, { ...(await save(b)), slug })) ?? notFound(reply); }
      catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    });
    // Quick edits from the pages list: change the address or title without opening the builder.
    admin.patch<{ Params: { id: string } }>("/api/pages/:id", { ...perm("pages.manage"), schema: { body: { type: "object", additionalProperties: false, properties: { slug: { type: "string", pattern: "^[a-z0-9-]+$", maxLength: 80 }, title: { type: "string", minLength: 1, maxLength: 200 } } } } }, async (req, reply) => {
      const cur = await db.pages.get(req.params.id);
      if (!cur) return notFound(reply);
      if (cur.system) return reply.code(400).send({ error: "Essential pages have a fixed address" });
      const b = req.body as { slug?: string; title?: string };
      if (b.slug && b.slug !== cur.slug && (await db.pages.count({ slug: b.slug }))) return reply.code(409).send({ error: "That address is already used by another page" });
      const { html: _h, nodes: _n, ...rest } = (await db.pages.update(cur.id, b))!;
      return rest;
    });
    admin.delete<{ Params: { id: string } }>("/api/pages/:id", perm("pages.manage"), async (req, reply) => {
      const cur = await db.pages.get(req.params.id);
      if (!cur) return notFound(reply);
      if (cur.system) return reply.code(400).send({ error: "Essential pages can't be deleted" });
      await db.pages.delete(cur.id);
      return reply.code(204).send();
    });
  });

  // ---- public delivery ----
  registerUploadRead(app, uploadDir);
  registerStorefront(app, db, pricing, accounts);
  const CSP = PAGE_CSP;
  const servePage = async (slug: string, reply: FastifyReply) => {
    const [page] = await db.pages.find({ slug, system: null }, { limit: 1 });
    if (!page) return reply.code(404).header("content-security-policy", CSP).type("text/html").send("<h1>Not found</h1>");
    return reply.header("cache-control", "public, max-age=60").header("content-security-policy", CSP).type("text/html").send(page.html);
  };
  app.get<{ Params: { slug: string } }>("/s/:slug", (req, reply) => servePage(req.params.slug, reply));
  app.get("/", async (_req, reply) => ((await db.pages.count({ slug: "home", system: null })) ? servePage("home", reply) : reply.redirect("/shop")));

  return app;
}

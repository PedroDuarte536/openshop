import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { FastifyInstance, FastifyReply } from "fastify";
import { esc, renderDocument, type Theme } from "@openshop/renderer";
import type { Db } from "./types.ts";
import { OrderError, placeOrder } from "./orders.ts";
import { renderSystem } from "./pages.ts";
import { RateLimiter } from "./limiter.ts";
import { shopSearchPage } from "./catalogue/shop-search.ts";
import { productPageContext } from "./catalogue/product-page.ts";
import type { Params } from "./catalogue/search/params.ts";
import { cartId } from "./cart.ts";
import type { PricingService } from "./pricing-service.ts";
import type { Accounts } from "./accounts.ts";
import { CONFIG } from "./config.ts";
import { recordSearchMiss } from "./catalogue/search-misses.ts";

// Scripts only from this origin (the storefront script), fetch only to this origin, and Trusted Types so the
// script can't use HTML-injection sinks (it builds the DOM with textContent/createElement only).
export const PAGE_CSP = "default-src 'none'; script-src 'self'; connect-src 'self'; require-trusted-types-for 'script'; trusted-types 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' https: data:; form-action 'self'; base-uri 'none'";
const CSP = PAGE_CSP;
const money = (n: number) => n.toFixed(2);
const SHOP_JS = readFileSync(new URL("../assets/shop.js", import.meta.url));
const SHOP_JS_ETAG = `"${createHash("sha256").update(SHOP_JS).digest("base64url").slice(0, 22)}"`;

export function html(reply: FastifyReply, body: string, code = 200) {
  return reply.code(code).header("content-security-policy", CSP).type("text/html").send(body);
}
// The shop adopts the theme of the "home" page so it matches the rest of the site.
let shopTheme: Partial<Theme> | undefined;
export const page = (title: string, body: string) => renderDocument(title, body, shopTheme, { shopScript: true });

export function registerStorefront(app: FastifyInstance, db: Db, pricing: PricingService, accounts: Accounts) {
  // The storefront script. Revalidated on every load (ETag), so a deploy takes effect immediately.
  app.get("/assets/shop.js", async (req, reply) => {
    reply.header("cache-control", "no-cache").header("etag", SHOP_JS_ETAG);
    if (req.headers["if-none-match"] === SHOP_JS_ETAG) return reply.code(304).send();
    return reply.type("text/javascript; charset=utf-8").send(SHOP_JS);
  });

  app.addHook("onRequest", async (req) => {
    if (req.url.startsWith("/shop")) shopTheme = (await db.pages.find({ slug: "home" }, { limit: 1 }))[0]?.theme;
  });
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: CONFIG.http.formBodyLimitBytes }, (_r, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(body as string))));

  // Search, category and "all products" pages: text search, filters with counts, sorting and paging (plan §2.5.6).
  // They hold no personal data (prices and offers are added by the storefront script), so they may be cached briefly.
  // Searching costs CPU, so each visitor (IP) gets a budget of requests (C13).
  const searches = new RateLimiter(CONFIG.search.rateBurst, CONFIG.search.ratePerSecond);
  const tooMany = (reply: FastifyReply) => html(reply, page("Too many searches", "<h1>Too many searches</h1><p>Please wait a moment and try again.</p>"), 429);
  const listing = async (reply: FastifyReply, key: "category" | "search", r: Awaited<ReturnType<typeof shopSearchPage>>, extra: Record<string, unknown>, title?: string) => {
    reply.header("cache-control", "public, max-age=60");
    return html(reply, await renderSystem(db, key, { ...extra, query: r.query, results: r.results, search: r.search }, title, r.meta));
  };

  app.get<{ Querystring: Params }>("/shop", async (req, reply) => {
    if (typeof req.query.category === "string" && /^[a-z0-9-]{1,80}$/.test(req.query.category) && Object.keys(req.query).length === 1) return reply.redirect(`/shop/category/${encodeURIComponent(req.query.category)}`, 302);
    if (!searches.take(req.ip)) return tooMany(reply);
    const r = await shopSearchPage(db, req.query, { path: "/shop", categoryId: null });
    return listing(reply, "category", r, { category: { name: "All products", slug: "" } });
  });

  app.get<{ Params: { slug: string }; Querystring: Params }>("/shop/category/:slug", async (req, reply) => {
    const [cat] = await db.categories.find({ slug: req.params.slug }, { limit: 1 });
    if (!cat) return html(reply, page("Not found", "<h1>Category not found</h1><p><a href=\"/shop\">Back to the shop</a></p>"), 404);
    if (!searches.take(req.ip)) return tooMany(reply);
    const r = await shopSearchPage(db, req.query, { path: `/shop/category/${cat.slug}`, categoryId: cat.id });
    return listing(reply, "category", r, { category: { name: cat.name, slug: cat.slug } }, cat.name);
  });

  app.get<{ Querystring: Params }>("/search", async (req, reply) => {
    if (!searches.take(req.ip)) return tooMany(reply);
    const r = await shopSearchPage(db, req.query, { path: "/search", emptyWithoutQuery: true });
    if (r.miss) void recordSearchMiss(db, r.query, req.ip);
    return listing(reply, "search", r, {}, r.query ? `Results for ${r.query}` : "Search");
  });

  app.get<{ Params: { id: string } }>("/shop/product/:id", async (req, reply) => {
    const p = await db.products.get(req.params.id);
    if (!p || !p.active || p.deletedAt) return html(reply, page("Not found", "<h1>Product not found</h1><p><a href=\"/shop\">Back to the shop</a></p>"), 404);
    const product = await productPageContext(db, p);
    return html(reply, await renderSystem(db, "product", { product }, p.name));
  });

  app.post<{ Body: { productId?: string; qty?: string } }>("/shop/cart/add", async (req, reply) => {
    const productId = String(req.body?.productId ?? ""), qty = Number(req.body?.qty ?? 1);
    const p = await db.products.get(productId);
    if (!p || !p.active || !Number.isInteger(qty) || qty < 1 || qty > CONFIG.orders.maxQty) return html(reply, page("Error", "<h1>Invalid item</h1>"), 400);
    let id = cartId(req);
    let cart = id ? await db.carts.get(id) : null;
    if (!cart) { id = randomUUID(); cart = await db.carts.insert({ id, items: [] }); }
    const items = [...cart.items];
    const line = items.find((i) => i.productId === productId);
    if (line) line.qty = Math.min(line.qty + qty, CONFIG.orders.maxQty); else items.push({ productId, qty });
    await db.carts.update(cart.id, { items });
    return reply.header("set-cookie", `cart=${cart.id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`).redirect("/shop/cart", 303);
  });

  app.post<{ Body: { productId?: string } }>("/shop/cart/remove", async (req, reply) => {
    const id = cartId(req), cart = id ? await db.carts.get(id) : null;
    if (cart) await db.carts.update(cart.id, { items: cart.items.filter((i) => i.productId !== req.body?.productId) });
    return reply.redirect("/shop/cart", 303);
  });

  /** "Includes: 2 × Linen Mug, 1 × Dune Plate" for a bundle in the cart (names as they are now). */
  const bundleIncludes = async (components: { productId: string; qty: number }[]) => {
    const byId = new Map((await db.products.find({ id: { $in: components.map((c) => c.productId) } })).map((x) => [x.id, x.name]));
    return `<div class="os-line-offers">Includes: ${components.map((c) => `${c.qty} × ${esc(byId.get(c.productId) ?? "product")}`).join(", ")}</div>`;
  };

  // List prices only: the storefront script adds the shopper's discounts from /api/shop/cart.
  app.get("/shop/cart", async (req, reply) => {
    reply.header("cache-control", "private, no-store");
    const id = cartId(req), cart = id ? await db.carts.get(id) : null;
    const account = await accounts.account(req);
    const rows: string[] = []; let total = 0;
    for (const i of cart?.items ?? []) {
      const p = await db.products.get(i.productId);
      if (!p) continue;
      total += Math.round(p.price * 100) * i.qty;
      const pid = esc(p.id);
      const includes = p.type === "bundle" && p.bundle ? await bundleIncludes(p.bundle.components) : "";
      rows.push(`<tr data-os-line="${pid}"><td>${esc(p.name)}${includes}<div class="os-line-offers" data-os-line-offers="${pid}"></div></td><td>${i.qty}</td><td data-os-line-total="${pid}">${money(p.price * i.qty)}</td><td><form method="post" action="/shop/cart/remove"><input type="hidden" name="productId" value="${pid}"><button>Remove</button></form></td></tr>`);
    }
    if (!rows.length) return html(reply, page("Cart", "<h1>Your cart</h1><p>Your cart is empty.</p>"));
    const notice = `<noscript><p class="os-msg">Turn on JavaScript to see your discounts and use discount codes. Automatic offers are still applied when you place your order.</p></noscript>`;
    const who = account
      ? `<p class="os-msg">Signed in as <b>${esc(account.customer.name)}</b> (${esc(account.customer.email)}). Your customer prices are included. <a href="/shop/account">Your account</a></p>`
      : `<p class="os-msg">Have a customer account? <a href="/shop/account?next=%2Fshop%2Fcart">Sign in</a> to get your prices.</p>`;
    const c = account?.customer;
    const email = c ? `<input name="email" type="email" value="${esc(c.email)}" readonly aria-label="Email (your account)">` : `<input name="email" type="email" placeholder="Email" required>`;
    const form = `<h2>Checkout</h2><form method="post" action="/shop/checkout" class="os-stack"><input type="hidden" name="quote" value="" data-os-quote><input name="name" placeholder="Full name" value="${esc(c?.name ?? "")}" required>${email}<textarea name="address" placeholder="Delivery address" required>${esc(c?.address ?? "")}</textarea><button>Place order</button></form>`;
    return html(reply, page("Cart", `<h1>Your cart</h1>${who}<table class="os-cart"><tr><th>Item</th><th>Qty</th><th>Price</th><th></th></tr>${rows.join("")}<tr><th>Total</th><th></th><th data-os-cart-total>${money(total / 100)}</th><th></th></tr></table><div id="os-cart-pricing" class="os-cart-pricing" aria-live="polite"></div>${notice}${form}`));
  });

  app.post<{ Body: { name?: string; email?: string; address?: string; quote?: string } }>("/shop/checkout", async (req, reply) => {
    reply.header("cache-control", "private, no-store");
    const id = cartId(req), cart = id ? await db.carts.get(id) : null;
    const account = await accounts.account(req);
    // Signed in: the order is for the account's email, whatever the form says.
    const name = String(req.body?.name ?? "").trim(), email = account ? account.customer.email : String(req.body?.email ?? "").trim(), address = String(req.body?.address ?? "").trim();
    const quote = String(req.body?.quote ?? "").slice(0, 40);
    if (!name || !address || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || name.length > 200 || address.length > 1000) return html(reply, page("Error", "<h1>Please fill in all fields correctly</h1>"), 400);
    try {
      const order = await placeOrder(db, pricing, cart?.items ?? [], { name, email, address }, { codes: cart?.codes, selection: cart?.selection, expectedQuote: quote || null, account, cartId: cart?.id ?? null });
      if (cart) await db.carts.delete(cart.id);
      return reply.redirect(`/shop/order/${order.id}`, 303);
    } catch (e) {
      if (e instanceof OrderError) {
        if (e.code === "prices_changed" && e.details) {
          const d = e.details;
          const hidden = (n: string, v: string) => `<input type="hidden" name="${n}" value="${esc(v)}">`;
          const rows = d.discounts.map((x) => `<tr><td>${esc(x.label)}${x.code ? ` (code ${esc(x.code)})` : ""}</td><td>−${money(x.amount)}</td></tr>`).join("");
          const body = `<h1>Your total has changed</h1><p>Some offers depend on your previous orders, so they could only be checked now that we know your email.</p>`
            + `<table><tr><td>Subtotal</td><td>${money(d.subtotal)}</td></tr>${rows}<tr><th>New total</th><th>${money(d.total)}</th></tr></table>`
            + `<form method="post" action="/shop/checkout" class="os-stack">${hidden("name", name)}${hidden("email", email)}${hidden("address", address)}${hidden("quote", d.quote)}<button>Place order for ${money(d.total)}</button></form>`
            + `<p><a href="/shop/cart">Back to cart</a></p>`;
          return html(reply, page("Your total has changed", body), 409);
        }
        const title = e.code === "prices_changed" || e.code === "offer_unavailable" ? "Your total has changed" : esc(e.message);
        const more = e.code ? `<p>${esc(e.message)}</p>` : "";
        return html(reply, page("Please check your cart", `<h1>${title}</h1>${more}<p><a href="/shop/cart">Back to cart</a></p>`), e.status);
      }
      throw e;
    }
  });

  // The order's own record of what was charged (not offer data).
  app.get<{ Params: { id: string } }>("/shop/order/:id", async (req, reply) => {
    const o = await db.orders.get(req.params.id);
    if (!o) return html(reply, page("Not found", "<h1>Not found</h1>"), 404);
    const rows = o.lines.map((l) => {
      const offers = (l.discounts ?? []).map((d) => `<div class="os-line-offers">${esc(d.label)}: −${money(d.amount)}</div>`).join("");
      const includes = l.bundle ? `<div class="os-line-offers">Includes: ${l.bundle.components.map((c) => `${c.qty} × ${esc(c.name)}`).join(", ")}</div>` : "";
      return `<tr><td>${esc(l.name)}${includes}${offers}</td><td>${l.qty}</td><td>${money(l.lineTotal ?? l.price * l.qty)}</td></tr>`;
    }).join("");
    const discounts = o.discounts?.length
      ? `<tr><td>Subtotal</td><td></td><td>${money(o.subtotal ?? o.total)}</td></tr>` + o.discounts.map((d) => `<tr><td>${esc(d.label)}${d.code ? ` (code ${esc(d.code)})` : ""}</td><td></td><td>−${money(d.amount)}</td></tr>`).join("")
      : "";
    return html(reply, page("Order confirmed", `<h1>Thank you, ${esc(o.customer.name)}!</h1><p>Order ${esc(o.id)} (${esc(o.status)}). Payment is arranged separately.</p><table>${rows}${discounts}<tr><th>Total</th><th></th><th>${money(o.total)}</th></tr></table>`));
  });
}

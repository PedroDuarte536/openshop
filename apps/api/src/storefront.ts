import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ART, esc, renderDocument, type Theme } from "@openshop/renderer";
import type { Db, Product } from "./types.ts";
import { OrderError, placeOrder } from "./orders.ts";

export const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' https: data:; form-action 'self'; base-uri 'none'";
const CSP = PAGE_CSP;
const money = (n: number) => n.toFixed(2);

function html(reply: FastifyReply, body: string, code = 200) {
  return reply.code(code).header("content-security-policy", CSP).type("text/html").send(body);
}
// The shop adopts the theme of the "home" page so it matches the rest of the site.
let shopTheme: Partial<Theme> | undefined;
const page = (title: string, body: string) => renderDocument(title, body, shopTheme);
const ART_LIST = Object.values(ART);

function cartId(req: FastifyRequest): string | null {
  const m = /(?:^|;\s*)cart=([a-f0-9-]{36})/.exec(req.headers.cookie ?? "");
  return m ? m[1] : null;
}

export function registerStorefront(app: FastifyInstance, db: Db) {
  app.addHook("onRequest", async (req) => {
    if (req.url.startsWith("/shop")) shopTheme = (await db.pages.find({ slug: "home" }, { limit: 1 }))[0]?.theme;
  });
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 64 * 1024 }, (_r, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(body as string))));

  const card = (p: Product) =>
    `<a class="os-pc" href="/shop/product/${esc(p.id)}"><div class="os-pc-img">${p.images?.[0] ? `<img src="${esc(p.images[0])}" alt="${esc(p.name)}" loading="lazy">` : `<div class="os-art" style="background:${ART_LIST[p.name.length % ART_LIST.length].css}"></div>`}</div><div><div class="os-pc-n">${esc(p.name)}</div><div class="os-pc-p">${money(p.price)}</div></div></a>`;

  app.get<{ Querystring: { category?: string } }>("/shop", async (req, reply) => {
    const cats = await db.categories.find({}, { sort: { name: 1 } });
    const cat = cats.find((c) => c.slug === req.query.category);
    const products = await db.products.find(cat ? { active: true, categoryId: cat.id } : { active: true }, { sort: { name: 1 } });
    const nav = `<p><a href="/shop">All</a> ${cats.map((c) => `<a href="/shop?category=${encodeURIComponent(c.slug)}">${esc(c.name)}</a>`).join(" ")}</p>`;
    return html(reply, page("Shop", `<h1>Shop</h1>${nav}<div class="os-shop-grid">${products.map(card).join("") || "<p>No products.</p>"}</div>`));
  });

  app.get<{ Params: { id: string } }>("/shop/product/:id", async (req, reply) => {
    const p = await db.products.get(req.params.id);
    if (!p || !p.active) return html(reply, page("Not found", "<h1>Not found</h1>"), 404);
    const imgs = (p.images ?? []).map((i) => `<img src="${esc(i)}" alt="${esc(p.name)}">`).join("");
    const buy = p.stock > 0
      ? `<form method="post" action="/shop/cart/add" class="os-stack"><input type="hidden" name="productId" value="${esc(p.id)}"><label>Quantity <input type="number" name="qty" value="1" min="1" max="${Math.min(p.stock, 99)}"></label><button>Add to cart</button></form>`
      : "<p><strong>Out of stock</strong></p>";
    return html(reply, page(p.name, `<h1>${esc(p.name)}</h1>${imgs}<p>${money(p.price)}</p><p>${esc(p.description ?? "")}</p>${buy}`));
  });

  app.post<{ Body: { productId?: string; qty?: string } }>("/shop/cart/add", async (req, reply) => {
    const productId = String(req.body?.productId ?? ""), qty = Number(req.body?.qty ?? 1);
    const p = await db.products.get(productId);
    if (!p || !p.active || !Number.isInteger(qty) || qty < 1 || qty > 99) return html(reply, page("Error", "<h1>Invalid item</h1>"), 400);
    let id = cartId(req);
    let cart = id ? await db.carts.get(id) : null;
    if (!cart) { id = randomUUID(); cart = await db.carts.insert({ id, items: [] }); }
    const items = [...cart.items];
    const line = items.find((i) => i.productId === productId);
    if (line) line.qty = Math.min(line.qty + qty, 99); else items.push({ productId, qty });
    await db.carts.update(cart.id, { items });
    return reply.header("set-cookie", `cart=${cart.id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`).redirect("/shop/cart", 303);
  });

  app.post<{ Body: { productId?: string } }>("/shop/cart/remove", async (req, reply) => {
    const id = cartId(req), cart = id ? await db.carts.get(id) : null;
    if (cart) await db.carts.update(cart.id, { items: cart.items.filter((i) => i.productId !== req.body?.productId) });
    return reply.redirect("/shop/cart", 303);
  });

  app.get("/shop/cart", async (req, reply) => {
    const id = cartId(req), cart = id ? await db.carts.get(id) : null;
    const rows: string[] = []; let total = 0;
    for (const i of cart?.items ?? []) {
      const p = await db.products.get(i.productId);
      if (!p) continue;
      total += Math.round(p.price * 100) * i.qty;
      rows.push(`<tr><td>${esc(p.name)}</td><td>${i.qty}</td><td>${money(p.price * i.qty)}</td><td><form method="post" action="/shop/cart/remove"><input type="hidden" name="productId" value="${esc(p.id)}"><button>Remove</button></form></td></tr>`);
    }
    if (!rows.length) return html(reply, page("Cart", "<h1>Your cart</h1><p>Your cart is empty.</p>"));
    const form = `<h2>Checkout</h2><form method="post" action="/shop/checkout" class="os-stack"><input name="name" placeholder="Full name" required><input name="email" type="email" placeholder="Email" required><textarea name="address" placeholder="Delivery address" required></textarea><button>Place order</button></form>`;
    return html(reply, page("Cart", `<h1>Your cart</h1><table>${rows.join("")}<tr><th>Total</th><th></th><th>${money(total / 100)}</th><th></th></tr></table>${form}`));
  });

  app.post<{ Body: { name?: string; email?: string; address?: string } }>("/shop/checkout", async (req, reply) => {
    const id = cartId(req), cart = id ? await db.carts.get(id) : null;
    const name = String(req.body?.name ?? "").trim(), email = String(req.body?.email ?? "").trim(), address = String(req.body?.address ?? "").trim();
    if (!name || !address || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || name.length > 200 || address.length > 1000) return html(reply, page("Error", "<h1>Please fill in all fields correctly</h1>"), 400);
    try {
      const order = await placeOrder(db, cart?.items ?? [], { name, email, address });
      if (cart) await db.carts.delete(cart.id);
      return reply.redirect(`/shop/order/${order.id}`, 303);
    } catch (e) {
      if (e instanceof OrderError) return html(reply, page("Error", `<h1>${esc(e.message)}</h1><p><a href="/shop/cart">Back to cart</a></p>`), e.status);
      throw e;
    }
  });

  app.get<{ Params: { id: string } }>("/shop/order/:id", async (req, reply) => {
    const o = await db.orders.get(req.params.id);
    if (!o) return html(reply, page("Not found", "<h1>Not found</h1>"), 404);
    const rows = o.lines.map((l) => `<tr><td>${esc(l.name)}</td><td>${l.qty}</td><td>${money(l.price * l.qty)}</td></tr>`).join("");
    return html(reply, page("Order confirmed", `<h1>Thank you, ${esc(o.customer.name)}!</h1><p>Order ${esc(o.id)} (${esc(o.status)}). Payment is arranged separately.</p><table>${rows}<tr><th>Total</th><th></th><th>${money(o.total)}</th></tr></table>`));
  });
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { describeEffect, discountState, normalizeCode, price, toCents, type Discount, type VoucherInfo } from "@openshop/pricing";
import { cartId } from "./cart.ts";
import { FailureLimiter, RateLimiter } from "./limiter.ts";
import { shopSearchJson, shopSuggest } from "./catalogue/shop-search.ts";
import type { Params } from "./catalogue/search/params.ts";
import { getSettings } from "./settings.ts";
import { priceItems, publicResult, shopperContext, shopperPricing, unitPrice, type PricingService } from "./pricing-service.ts";
import { recordChoiceShown } from "./insights.ts";
import type { Account, Accounts } from "./accounts.ts";
import type { Cart, Db, DiscountDoc, VoucherCode } from "./types.ts";
import { CONFIG } from "./config.ts";

// Public JSON API used by the storefront script (assets/shop.js). Discount information reaches shoppers only
// through these endpoints: never through static or server-rendered HTML. Responses depend on the cart cookie and the
// customer session, so they are never cached.
//
// KNOWN LIMITATION (deferred to the security review): the form-urlencoded body parser is registered for the whole
// app, and these endpoints don't enforce `Content-Type: application/json` or check `Origin`. SameSite=Lax on the
// cookies is the only cross-site protection today.

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const PRIVATE = "private, no-store";

/** Can this shopper use the offer behind a code right now (ignoring cart conditions)? */
export function codeUsable(v: VoucherCode | null, d: DiscountDoc | null, account: Account | null, now = Date.now()): boolean {
  if (!v || !d || d.trigger !== "code") return false;
  if (discountState({ ...d, usedCount: Number(d.usedCount) || 0 }, now) !== "running") return false;
  if (v.kind === "single" && v.usedCount > 0) return false;
  if (v.assignedCustomerId && v.assignedCustomerId !== account?.customer.id) return false;
  if (d.access?.requiresSignIn && !account) return false;
  if (d.audience?.type === "customers" && !(account && d.audience.customerIds.includes(account.customer.id))) return false;
  if (d.audience?.type === "profiles" && !(account && d.audience.profileIds.some((p) => account.profileIds.includes(p)))) return false;
  return true;
}

export function registerShopApi(app: FastifyInstance, { db, pricing, accounts }: { db: Db; pricing: PricingService; accounts: Accounts }) {
  const limiter = new FailureLimiter(CONFIG.discounts.codeMaxFailures, CONFIG.discounts.codeWindowMs);
  const loadCart = async (req: FastifyRequest): Promise<Cart | null> => { const id = cartId(req); return id ? db.carts.get(id) : null; };

  /** Unused personal codes for running offers, for one-click use in the cart. */
  const personalCodes = async (account: Account | null) => {
    if (!account) return [];
    const out: { code: string; label: string; description: string }[] = [];
    for (const v of await db.voucherCodes.find({ assignedCustomerId: account.customer.id })) {
      const d = await db.discounts.get(v.discountId);
      if (d && codeUsable(v, d, account)) out.push({ code: v.id, label: d.label, description: describeEffect(d) });
    }
    return out;
  };

  const cartView = async (cart: Cart | null, account: Account | null) => {
    const { timezone, display } = await getSettings(db);
    const q = await priceItems(db, pricing, { items: cart?.items ?? [], codes: cart?.codes, selection: cart?.selection ?? null, account });
    if (cart && q.result.scenarios.length) await recordChoiceShown(db, cart.id, q.result, normalizeCode(cart.codes?.[0]) ?? undefined).catch(() => undefined);
    return {
      timezone, display, codes: cart?.codes ?? [], selection: cart?.selection ?? { scenario: null, declined: [] },
      account: account ? { name: account.customer.name, email: account.customer.email } : null,
      personalCodes: (await personalCodes(account)).filter((c) => !(cart?.codes ?? []).includes(c.code)),
      ...publicResult(q.result),
    };
  };

  // Prices for products on a page: list price, this shopper's price, where it comes from and the alternatives.
  app.get<{ Querystring: { ids?: string } }>("/api/shop/prices", async (req, reply) => {
    const ids = [...new Set(String(req.query.ids ?? "").split(",").map((s) => s.trim()).filter((s) => ID.test(s)))].slice(0, 100);
    const { timezone, display } = await getSettings(db);
    const [cart, account] = await Promise.all([loadCart(req), accounts.account(req)]);
    const sp = await shopperPricing(db, pricing, cart, account);
    const products = ids.length ? await db.products.find({ id: { $in: ids }, active: true }) : [];
    const now = Date.now();
    const items = products.map((p) => unitPrice(sp, p, now));
    return reply.header("cache-control", PRIVATE).send({ timezone, display, signedIn: !!account, items });
  });

  // Shop search by the visitor's own prices (owner decision S-2a): only for price sorting and filtering, called by the
  // storefront script. Personal, so never cached; anything else is the same for everyone and may be cached briefly.
  const searches = new RateLimiter(CONFIG.search.rateBurst, CONFIG.search.ratePerSecond);
  app.get<{ Querystring: Params }>("/api/shop/search", async (req, reply) => {
    if (!searches.take(req.ip)) return reply.code(429).send({ error: "Too many searches. Please wait a moment." });
    const [cart, account] = await Promise.all([loadCart(req), accounts.account(req)]);
    const r = await shopSearchJson(db, pricing, req.query, { cart, account });
    if (r.personal) reply.header("cache-control", PRIVATE).header("vary", "Cookie");
    else reply.header("cache-control", "public, max-age=60");
    return r.body;
  });

  // Suggestions while typing in a search box: public data only, the same for everyone (cacheable), rate limited on
  // their own (typing sends a few requests per second).
  const suggestions = new RateLimiter(CONFIG.search.suggest.rateBurst, CONFIG.search.suggest.ratePerSecond);
  app.get<{ Querystring: { q?: string } }>("/api/shop/suggest", async (req, reply) => {
    if (!suggestions.take(req.ip)) return reply.code(429).send({ error: "Too many searches. Please wait a moment." });
    return reply.header("cache-control", "public, max-age=60").send(await shopSuggest(db, req.query.q));
  });

  app.get("/api/shop/cart", async (req, reply) => {
    const [cart, account] = await Promise.all([loadCart(req), accounts.account(req)]);
    return reply.header("cache-control", PRIVATE).send(await cartView(cart, account));
  });

  app.post("/api/shop/cart/codes", {
    schema: { body: { type: "object", required: ["code"], properties: { code: { type: "string", maxLength: 64 } } } },
  }, async (req, reply) => {
    reply.header("cache-control", PRIVATE);
    const [cart, account] = await Promise.all([loadCart(req), accounts.account(req)]);
    const keys = [`ip:${req.ip}`, ...(cart ? [`cart:${cart.id}`] : [])];
    if (limiter.blocked(keys)) return reply.code(429).send({ error: "Too many attempts. Please wait a few minutes and try again." });
    if (!cart || !cart.items.length) return reply.code(400).send({ error: "Add something to your cart first." });
    const code = normalizeCode((req.body as { code: string }).code);
    const v = code ? await db.voucherCodes.get(code) : null;
    const d = v ? await db.discounts.get(v.discountId) : null;
    // Every reason a code can't be used gives the same answer, so codes can't be probed.
    if (!codeUsable(v, d, account)) {
      limiter.fail(keys);
      return reply.code(400).send({ error: "This code isn't valid." });
    }
    await db.carts.update(cart.id, { codes: [code!], selection: { scenario: null, declined: cart.selection?.declined ?? [] } });
    return cartView(await db.carts.get(cart.id), account);
  });

  app.delete<{ Params: { code: string } }>("/api/shop/cart/codes/:code", async (req, reply) => {
    reply.header("cache-control", PRIVATE);
    const [cart, account] = await Promise.all([loadCart(req), accounts.account(req)]);
    if (cart) await db.carts.update(cart.id, { codes: (cart.codes ?? []).filter((c) => c !== normalizeCode(req.params.code)), selection: { scenario: null, declined: cart.selection?.declined ?? [] } });
    return cartView(cart ? await db.carts.get(cart.id) : null, account);
  });

  app.put("/api/shop/cart/selection", {
    schema: { body: { type: "object", additionalProperties: false, properties: { scenario: { type: ["string", "null"], enum: ["automatic", "code", null] }, declined: { type: "array", maxItems: 20, items: { type: "string", pattern: ID.source } } } } },
  }, async (req, reply: FastifyReply) => {
    reply.header("cache-control", PRIVATE);
    const [cart, account] = await Promise.all([loadCart(req), accounts.account(req)]);
    if (!cart) return reply.code(400).send({ error: "Your cart is empty." });
    const b = req.body as { scenario?: string | null; declined?: string[] };
    const selection = { scenario: b.scenario !== undefined ? b.scenario : cart.selection?.scenario ?? null, declined: b.declined ?? cart.selection?.declined ?? [] };
    await db.carts.update(cart.id, { selection });
    return cartView(await db.carts.get(cart.id), account);
  });

  // "Your offers": everything this signed-in customer can use, and what is left of their limited offers.
  app.get("/api/shop/account/offers", async (req, reply) => {
    reply.header("cache-control", PRIVATE);
    const account = await accounts.account(req);
    if (!account) return reply.code(401).send({ error: "Please sign in." });
    const { timezone } = await getSettings(db);
    const now = Date.now();
    const discounts = await pricing.candidates();
    const { ledger } = await shopperContext(db, discounts, account);
    const [products, categories] = await Promise.all([db.products.find({}), db.categories.find({})]);
    const appliesTo = (d: Discount) => {
      const names = (ids: string[], list: { id: string; name: string }[]) => {
        const n = ids.map((id) => list.find((x) => x.id === id)?.name).filter(Boolean) as string[];
        return n.length > 3 ? `${n.slice(0, 3).join(", ")} and ${n.length - 3} more` : n.join(", ");
      };
      const t = d.target;
      return t.type === "all" ? "Everything in the shop" : t.type === "products" ? names(t.productIds, products) : names(t.categoryIds, categories);
    };
    const remaining = (d: Discount) => {
      const pc = d.perCustomer, u = ledger?.usage[d.id] ?? { orders: 0, amountCents: 0 };
      return {
        orders: pc.maxOrders != null ? Math.max(0, pc.maxOrders - u.orders) : null,
        amountCents: pc.maxAmountCents != null ? Math.max(0, pc.maxAmountCents - u.amountCents) : null,
        firstOrdersLeft: pc.firstOrders != null ? Math.max(0, pc.firstOrders - (ledger?.identityOrders ?? 0)) : null,
      };
    };
    const forMe = (d: Discount) =>
      (d.audience.type === "customers" && d.audience.customerIds.includes(account.customer.id)) ||
      (d.audience.type === "profiles" && d.audience.profileIds.some((p) => account.profileIds.includes(p))) ||
      (d.audience.type === "everyone" && d.access.requiresSignIn);
    const offers = discounts.filter((d) => d.trigger === "automatic" && forMe(d) && discountState(d, now) === "running").map((d) => {
      const profileId = d.audience.type === "profiles" ? d.audience.profileIds.find((p) => account.profileIds.includes(p)) : undefined;
      return {
        label: d.label, source: d.audience.type === "customers" ? "customer" : d.audience.type === "profiles" ? "profile" : "members",
        sourceLabel: profileId ? account.profileLabels[profileId] : undefined, description: describeEffect(d), appliesTo: appliesTo(d), endsAt: d.endsAt, remaining: remaining(d),
      };
    });
    const codes = [];
    for (const v of await db.voucherCodes.find({ assignedCustomerId: account.customer.id })) {
      const d = discounts.find((x) => x.id === v.discountId);
      if (d && codeUsable(v, d as unknown as DiscountDoc, account, now)) codes.push({ code: v.id, label: d.label, description: describeEffect(d), appliesTo: appliesTo(d), endsAt: d.endsAt, remaining: remaining(d) });
    }
    const members = await db.profileMembers.find({ customerId: account.customer.id });
    const profiles = (await db.profiles.find({ id: { $in: account.profileIds } })).map((p) => ({ label: p.publicLabel, validUntil: members.find((m) => m.profileId === p.id)?.validUntil ?? null }));
    return { timezone, customer: { name: account.customer.name, email: account.customer.email }, profiles, offers, codes };
  });
}

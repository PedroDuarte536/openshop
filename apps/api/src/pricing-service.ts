import { createHash } from "node:crypto";
import { DiscountValidationError, normalizeDiscount, normalizeCode, price, toCents, type Discount, type LineInput, type PricingResult, type Shopper, type Usage, type VoucherInfo } from "@openshop/pricing";
import { getSettings } from "./settings.ts";
import { identityId } from "./identity.ts";
import type { Cart, CartSelection, Db, DiscountDoc, Product } from "./types.ts";
import type { Account } from "./accounts.ts";
import { CONFIG } from "./config.ts";

/** Re-validates a stored offer (second layer). Invalid documents are skipped with a warning, never priced. */
export function loadDiscount(d: DiscountDoc, timezone: string): Discount | null {
  try {
    const data = normalizeDiscount(d, { timezone, now: Date.now() });
    // Instants come from the stored document (a time-zone change may have kept a start that already happened).
    return { ...data, startsAt: d.startsAt ?? data.startsAt, endsAt: d.endsAt === undefined ? data.endsAt : d.endsAt, id: d.id, usedCount: Number(d.usedCount) || 0, version: d.version };
  } catch (e) {
    if (e instanceof DiscountValidationError) { console.warn(`Skipping invalid offer ${d.id}: ${e.message}`); return null; }
    throw e;
  }
}

export interface PricingService {
  /** Active, not-ended offers. `fresh` bypasses the cache (checkout always does). */
  candidates(opts?: { fresh?: boolean; all?: boolean }): Promise<Discount[]>;
  invalidate(): void;
}

export function createPricingService(db: Db): PricingService {
  let cache: { at: number; list: Discount[] } | null = null;
  const TTL = CONFIG.caches.offersMs;
  async function load(all: boolean): Promise<Discount[]> {
    const { timezone } = await getSettings(db);
    const docs = await db.discounts.find(all ? {} : { status: "active" }, { sort: { createdAt: 1 } });
    const now = Date.now();
    return docs.map((d) => loadDiscount(d, timezone)).filter((d): d is Discount => !!d && (all || !d.endsAt || Date.parse(d.endsAt) > now));
  }
  return {
    async candidates(opts = {}) {
      if (opts.all) return load(true);
      if (!opts.fresh && cache && Date.now() - cache.at < TTL) return cache.list;
      const list = await load(false);
      cache = { at: Date.now(), list };
      return list;
    },
    invalidate() { cache = null; },
  };
}

/** Who is shopping (for the engine), and their per-customer usage of the limited offers among `discounts`. */
export async function shopperContext(db: Db, discounts: Discount[], account: Account | null, email?: string | null) {
  const identity = account ? identityId(account.customer.email) : email ? identityId(email) : null;
  const shopper: Shopper = account
    ? { identityId: identity, customerId: account.customer.id, signedIn: true, profileIds: account.profileIds }
    : { identityId: identity, customerId: null, signedIn: false, profileIds: [] };
  let ledger: { identityOrders: number | null; usage: Record<string, Usage> } | undefined;
  if (identity) {
    const usage: Record<string, Usage> = {};
    for (const d of discounts) {
      const pc = d.perCustomer;
      if (pc.maxOrders == null && pc.maxAmountCents == null && pc.firstOrders == null) continue;
      const u = await db.discountUsage.get(`${d.id}:${identity}`);
      if (u) usage[d.id] = { orders: u.orders, amountCents: u.amountCents };
    }
    ledger = { identityOrders: (await db.identities.get(identity))?.orders ?? 0, usage };
  }
  return { shopper, ledger, identity };
}

export interface CartQuote {
  result: PricingResult;
  products: Map<string, Product>;
  lines: LineInput[];
  discounts: Discount[];
  identity: string | null;
}

/**
 * Prices items for a shopper.
 * - Signed in (`account`): the identity is the account's email, and offers for this customer, their profiles and
 *   sign-in-only offers apply.
 * - Guest: anonymous until they type an email at checkout; then `email` gives the identity for per-customer limits.
 *   A typed email never unlocks customer or profile offers.
 */
export async function priceItems(db: Db, svc: PricingService, opts: {
  items: { productId: string; qty: number }[]; codes?: string[]; selection?: CartSelection | null; email?: string | null;
  account?: Account | null; now?: number; fresh?: boolean; all?: boolean; skipUnavailable?: boolean;
}): Promise<CartQuote> {
  const merged = new Map<string, number>();
  for (const i of opts.items) merged.set(i.productId, Math.min((merged.get(i.productId) ?? 0) + i.qty, CONFIG.orders.maxQty));
  const products = new Map<string, Product>();
  const lines: LineInput[] = [];
  for (const [id, qty] of merged) {
    const p = await db.products.get(id);
    if (!p || !p.active) continue;
    products.set(id, p);
    lines.push({ ...lineOf(p, qty), name: p.name });
  }
  const discounts = await svc.candidates({ fresh: opts.fresh, all: opts.all });
  const codes = (opts.codes ?? []).map(normalizeCode).filter((c): c is string => !!c).slice(0, 1);
  const vouchers: VoucherInfo[] = [];
  for (const code of codes) {
    const v = await db.voucherCodes.get(code);
    if (v) vouchers.push({ code, discountId: v.discountId, kind: v.kind, usedCount: v.usedCount, assignedCustomerId: v.assignedCustomerId });
  }
  const acc = opts.account ?? null;
  const { shopper, ledger, identity } = await shopperContext(db, discounts, acc, opts.email);
  const result = price({
    now: opts.now ?? Date.now(), lines, shopper, discounts, codes, vouchers, ledger, profileLabels: acc?.profileLabels,
    selection: { scenario: opts.selection?.scenario ?? null, declined: opts.selection?.declined ?? [] },
  });
  return { result, products, lines, discounts, identity };
}

/** What shoppers may see: no internal diagnostics. */
export function publicResult(r: PricingResult) {
  const { diagnostics: _d, ...rest } = r;
  return rest;
}

/** A pricing line for a product. Bundles only get the offers that name them unless the owner allowed more (B-2). */
export function lineOf(p: Product, qty: number): LineInput {
  const bundle = p.type === "bundle";
  return { productId: p.id, categoryId: p.categoryId ?? null, listCents: toCents(p.price), qty, ...(bundle ? { offerScope: p.bundle?.offerScope ?? "targeted" } : {}) };
}

/** Everything that decides a visitor's prices: their offers, cart code and selection, and who they are. */
export interface ShopperPricing {
  discounts: Discount[]; codes: string[]; vouchers: VoucherInfo[]; shopper: Shopper; ledger: Awaited<ReturnType<typeof shopperContext>>["ledger"];
  selection?: CartSelection; profileLabels?: Record<string, string>;
  /** Identifies these inputs, so results can be cached per visitor context (C23). */
  key: string;
}

export async function shopperPricing(db: Db, svc: PricingService, cart: Cart | null, account: Account | null): Promise<ShopperPricing> {
  const discounts = await svc.candidates();
  const codes = (cart?.codes ?? []).map(normalizeCode).filter((c): c is string => !!c).slice(0, 1);
  const vouchers: VoucherInfo[] = [];
  for (const code of codes) { const v = await db.voucherCodes.get(code); if (v) vouchers.push({ code, discountId: v.discountId, kind: v.kind, usedCount: v.usedCount, assignedCustomerId: v.assignedCustomerId }); }
  const { shopper, ledger } = await shopperContext(db, discounts, account);
  const key = createHash("sha256").update(JSON.stringify([
    account?.customer.id ?? null, [...(account?.profileIds ?? [])].sort(), codes, vouchers.map((v) => [v.code, v.usedCount]), cart?.selection ?? null,
    discounts.map((d) => [d.id, d.version ?? 0, d.usedCount]), ledger ?? null,
  ])).digest("base64url");
  return { discounts, codes, vouchers, shopper, ledger, selection: cart?.selection ?? undefined, profileLabels: account?.profileLabels, key };
}

/**
 * One unit of a product for this visitor: exactly what the price cards show (`/api/shop/prices`), and what the shop
 * search sorts and filters by (S-2). One function, so the two can never disagree.
 */
export function unitPrice(sp: ShopperPricing, p: Product, now = Date.now()) {
  const r = price({ now, lines: [lineOf(p, 1)], shopper: sp.shopper, ledger: sp.ledger, discounts: sp.discounts, codes: sp.codes, vouchers: sp.vouchers, selection: sp.selection, profileLabels: sp.profileLabels });
  const l = r.lines[0];
  const applied = l.appliedFrom ? l.offers.find((o) => o.discountId === l.appliedFrom!.discountId) : undefined;
  return {
    productId: p.id, listCents: l.listCents, priceCents: l.lineCents,
    badge: l.lineCents < l.listCents && l.listCents > 0 ? Math.round(((l.listCents - l.lineCents) / l.listCents) * 100) : null,
    appliedFrom: l.appliedFrom, endsAt: applied?.endsAt ?? null, pending: applied?.pending ?? false,
    alternatives: l.offers.filter((o) => o.discountId !== l.appliedFrom?.discountId).map(({ discountId: _id, ...o }) => o),
  };
}

// Per-visitor-context price maps for the shop search (S-2): cached briefly, never shared between contexts (C23).
const priceCache = new Map<string, { at: number; prices: Map<string, number> }>();
const PRICE_TTL = CONFIG.caches.visitorPricesMs, PRICE_CONTEXTS = CONFIG.caches.visitorPriceContexts;

/** The visitor's one-unit price for each product (list price when no offer applies), computed once per context. */
export function visitorPrices(sp: ShopperPricing, products: Product[], catalogueVersion: number, now = Date.now()): Map<string, number> {
  const key = `${sp.key}:${catalogueVersion}`;
  let hit = priceCache.get(key);
  if (!hit || now - hit.at > PRICE_TTL) {
    hit = { at: now, prices: new Map() };
    priceCache.delete(key);
    priceCache.set(key, hit);
    while (priceCache.size > PRICE_CONTEXTS) priceCache.delete(priceCache.keys().next().value!);
  }
  // Offers only ever lower prices: with no running offer, every price is the list price and nothing is priced.
  const anyOffer = sp.discounts.length > 0;
  for (const p of products) {
    if (hit.prices.has(p.id)) continue;
    hit.prices.set(p.id, anyOffer ? unitPrice(sp, p, now).priceCents : toCents(p.price));
  }
  return hit.prices;
}

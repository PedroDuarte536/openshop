import { randomUUID } from "node:crypto";
import { DuplicateKeyError, type Filter } from "@openshop/db";
import { fromCents, normalizeCode } from "@openshop/pricing";
import type { CartSelection, Db, Order, OrderLine, Product } from "./types.ts";
import { allocateBundle, productsById, stockDemand } from "./catalogue/bundles.ts";
import { identityId, normalizeEmail } from "./identity.ts";
import { priceItems, type PricingService } from "./pricing-service.ts";
import { choiceOf, recordChoiceOutcome } from "./insights.ts";
import type { Account } from "./accounts.ts";
import { CONFIG } from "./config.ts";

export class OrderError extends Error {
  status: number;
  code?: string;
  /** For "prices_changed": the new quote and what it contains, so the shopper can confirm the new total. */
  details?: { quote: string; total: number; subtotal: number; discounts: { label: string; amount: number; code?: string }[] };
  constructor(msg: string, status = 400, code?: string) { super(msg); this.status = status; this.code = code; }
}

// Serialises stock- and limit-changing work within this process. Every limit is also enforced with an atomic
// conditional update (updateWhere), so a second instance can't push a counter past its limit either.
let chain: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const r = chain.then(fn, fn);
  chain = r.catch(() => undefined);
  return r;
}

export interface Customer { name: string; email: string; address: string }
export interface PlaceOrderOptions {
  codes?: string[];
  selection?: CartSelection | null;
  /** The quote the shopper saw; if prices changed since, the order is refused (409) instead of charging a surprise. */
  expectedQuote?: string | null;
  now?: number;
  /** The signed-in customer: their account email is the identity, and their customer/profile offers apply. */
  account?: Account | null;
  /** For insights: links the order to the choice the cart showed. */
  cartId?: string | null;
}

async function ensure<T>(fn: () => Promise<T>) { try { await fn(); } catch (e) { if (!(e instanceof DuplicateKeyError)) throw e; } }

/** Prices always come from the catalogue and the pricing engine, never from the caller. */
export function placeOrder(db: Db, pricing: PricingService, items: { productId: string; qty: number }[], customer: Customer, opts: PlaceOrderOptions = {}): Promise<Order> {
  return locked(async () => {
    const merged = new Map<string, number>();
    for (const i of items) {
      if (!Number.isInteger(i.qty) || i.qty < 1 || i.qty > CONFIG.orders.maxQty) throw new OrderError("invalid quantity");
      merged.set(i.productId, (merged.get(i.productId) ?? 0) + i.qty);
    }
    if (merged.size === 0) throw new OrderError("cart is empty");
    // Stock needed per product: bundles need their components (B-1); the same product can be needed by several
    // bundles and on its own, so demand is added up before checking.
    const wanted: { product: Product; qty: number }[] = [];
    for (const [id, qty] of merged) {
      const p = await db.products.get(id);
      if (!p || !p.active || p.deletedAt) throw new OrderError(`product unavailable: ${id}`, 409);
      wanted.push({ product: p, qty });
    }
    const demand = stockDemand(wanted);
    const stockOf = await productsById(db, [...demand.keys()]);
    for (const [id, n] of demand) {
      const p = stockOf.get(id);
      if (!p) throw new OrderError(`product unavailable: ${id}`, 409);
      if (p.stock < n) {
        const via = wanted.filter((w) => w.product.type === "bundle" && w.product.bundle?.components.some((c) => c.productId === id)).map((w) => w.product.name);
        throw new OrderError(via.length ? `not enough ${p.name} for ${via.join(", ")}` : `not enough stock for ${p.name}`, 409);
      }
    }
    const account = opts.account ?? null;
    const email = (account ? account.customer.email : customer.email).toLowerCase();
    const customerId = account?.customer.id ?? null;
    const q = await priceItems(db, pricing, { items: [...merged].map(([productId, qty]) => ({ productId, qty })), codes: opts.codes, selection: opts.selection, email, account, now: opts.now, fresh: true });
    const r = q.result;
    if (opts.expectedQuote && opts.expectedQuote !== r.quote) {
      // Typical cause: a per-customer limit that could only be checked once the email was known. The shopper gets
      // the new total and can confirm it (by sending the new quote); nothing is charged without seeing it.
      const err = new OrderError("Your total has changed since you viewed your cart. Please check the new total.", 409, "prices_changed");
      err.details = { quote: r.quote, total: fromCents(r.totalCents), subtotal: fromCents(r.subtotalCents), discounts: r.applied.map((a) => ({ label: a.label, amount: fromCents(a.cents), ...(a.code ? { code: a.code } : {}) })) };
      throw err;
    }
    const identity = q.identity!;
    const orderId = randomUUID();
    const now = new Date(opts.now ?? Date.now()).toISOString();

    // Claim every limit atomically, in a fixed order; undo what was claimed if anything fails.
    const undo: (() => Promise<unknown>)[] = [];
    const unavailable = () => new OrderError("One of your offers is no longer available. Please check your cart and try again.", 409, "offer_unavailable");
    try {
      let firstOrdersLimit: number | null = null;
      for (const a of r.applied) {
        const d = q.discounts.find((x) => x.id === a.discountId)!;
        const guard: Filter = d.limits.totalUses != null ? { usedCount: { $lt: d.limits.totalUses } } : {};
        if (!(await db.discounts.updateWhere(d.id, guard, { inc: { usedCount: 1 } }))) throw unavailable();
        undo.push(() => db.discounts.updateWhere(d.id, {}, { inc: { usedCount: -1 } }));
        if (a.code) {
          const v = await db.voucherCodes.get(a.code);
          if (!v || v.discountId !== d.id) throw unavailable();
          if (!(await db.voucherCodes.updateWhere(a.code, v.kind === "single" ? { usedCount: 0 } : {}, { inc: { usedCount: 1 } }))) throw unavailable();
          undo.push(() => db.voucherCodes.updateWhere(a.code!, {}, { inc: { usedCount: -1 } }));
        }
        const pc = d.perCustomer;
        if (pc.maxOrders != null || pc.maxAmountCents != null) {
          const uid = `${d.id}:${identity}`;
          await ensure(() => db.discountUsage.insert({ id: uid, discountId: d.id, identityId: identity, orders: 0, amountCents: 0 }));
          const where: Record<string, { $lt?: number; $lte?: number }> = {};
          if (pc.maxOrders != null) where.orders = { $lt: pc.maxOrders };
          if (pc.maxAmountCents != null) where.amountCents = { $lte: pc.maxAmountCents - a.cents };
          if (!(await db.discountUsage.updateWhere(uid, where, { inc: { orders: 1, amountCents: a.cents } }))) throw unavailable();
          undo.push(() => db.discountUsage.updateWhere(uid, {}, { inc: { orders: -1, amountCents: -a.cents } }));
        }
        if (pc.firstOrders != null) firstOrdersLimit = Math.min(firstOrdersLimit ?? Infinity, pc.firstOrders);
      }
      // Every order counts towards "first N orders"; if such an offer is applied, the count must still be below N.
      await ensure(() => db.identities.insert({ id: identity, orders: 0 }));
      if (!(await db.identities.updateWhere(identity, firstOrdersLimit != null ? { orders: { $lt: firstOrdersLimit } } : {}, { inc: { orders: 1 } }))) throw unavailable();
      undo.push(() => db.identities.updateWhere(identity, {}, { inc: { orders: -1 } }));

      for (const a of r.applied) {
        await db.redemptions.insert({ id: `${a.discountId}:${orderId}`, discountId: a.discountId, code: a.code ?? null, orderId, identityId: identity, customerId, amountCents: a.cents, state: "used", at: now });
        undo.push(() => db.redemptions.delete(`${a.discountId}:${orderId}`));
      }
      // Stock: one atomic conditional decrement per product, in a fixed (sorted) order, undone if any fails.
      for (const id of [...demand.keys()].sort()) {
        const n = demand.get(id)!;
        if (!(await db.products.updateWhere(id, { stock: { $gte: n } }, { inc: { stock: -n } }))) {
          throw new OrderError(`not enough stock for ${stockOf.get(id)?.name ?? id}`, 409);
        }
        undo.push(() => db.products.updateWhere(id, {}, { inc: { stock: n } }));
      }

      // A checkout never overwrites an existing customer's details (anyone can type any email); the address
      // for this order is stored on the order itself.
      await ensure(async () => { if (!(await db.customers.count({ email }))) await db.customers.insert({ email, name: customer.name, address: customer.address }); });

      const labels = new Map(r.applied.map((a) => [a.discountId, a.label]));
      const lines: OrderLine[] = r.lines.map((l) => {
        const p = q.products.get(l.productId)!;
        // Bundles: what was inside when sold, and each component's share of one bundle's price (for packing and reports).
        const bundle = p.type === "bundle" && p.bundle ? (() => {
          const shares = allocateBundle(Math.round(l.lineCents / l.qty), p.bundle!, stockOf);
          return { components: p.bundle!.components.map((c, i) => { const x = stockOf.get(c.productId); return { productId: c.productId, ...(x?.sku ? { sku: x.sku } : {}), name: x?.name ?? c.productId, qty: c.qty, allocatedCents: shares[i] }; }) };
        })() : undefined;
        return {
          productId: l.productId, name: p.name, ...(p.sku ? { sku: p.sku } : {}), price: fromCents(l.listCents), qty: l.qty,
          listPrice: fromCents(l.listCents), lineTotal: fromCents(l.lineCents),
          discounts: l.allocations.map((x) => ({ discountId: x.discountId, label: labels.get(x.discountId) ?? "", amount: fromCents(x.cents) })),
          ...(bundle ? { bundle } : {}),
        };
      });
      const choice = choiceOf(r, normalizeCode((opts.codes ?? [])[0]) ?? undefined);
      const saved = r.choices.filter((c) => c.declined).map((c) => ({ discountId: c.discountId, label: c.label, extra: fromCents(Math.max(0, r.totalCents - c.totalIfToggled)) }));
      const order = await db.orders.insert({
        id: orderId, lines, subtotal: fromCents(r.subtotalCents), discountTotal: fromCents(r.discountCents), total: fromCents(r.totalCents),
        discounts: r.applied.map((a) => ({ discountId: a.discountId, label: a.label, source: a.source, ...(a.code ? { code: a.code } : {}), amount: fromCents(a.cents) })),
        status: "pending", customer: { ...customer, email }, identityId: identity, customerId, pricingVersion: 1, createdAt: now,
        ...(choice ? { choice } : {}), ...(saved.length ? { savedForLater: saved } : {}),
      });
      // Insights only: never fail an order because of them.
      if (choice) await recordChoiceOutcome(db, { cartId: opts.cartId ?? null, orderId, choice, at: now }).catch((e) => console.error("choice insight not recorded", e));
      return order;
    } catch (e) {
      for (const u of undo.reverse()) await u().catch((err) => console.error("order rollback step failed", err));
      throw e;
    }
  });
}

/**
 * Status changes. Cancelling releases everything the order claimed (offer uses, codes, per-customer usage and the
 * order count) exactly once. A cancelled order that used offers is final: reopening it would have to claim limits
 * again, which may no longer be possible.
 */
export function setOrderStatus(db: Db, id: string, status: Order["status"]): Promise<Order | null> {
  return locked(async () => {
    const o = await db.orders.get(id);
    if (!o) return null;
    if (o.status === status) return o;
    if (o.status === "cancelled" && o.discounts?.length) throw new OrderError("This order used offers and was cancelled, so it can't be reopened.", 409, "cancelled_final");
    const updated = await db.orders.updateWhere(id, { status: o.status }, { set: { status } });
    if (!updated) throw new OrderError("The order changed at the same time. Please try again.", 409);
    const identity = o.identityId ?? identityId(normalizeEmail(o.customer.email));
    if (status === "cancelled") {
      await db.identities.updateWhere(identity, {}, { inc: { orders: -1 } });
      for (const red of await db.redemptions.find({ orderId: id })) {
        if (!(await db.redemptions.updateWhere(red.id, { state: "used" }, { set: { state: "released", releasedAt: new Date().toISOString() } }))) continue;
        await db.discounts.updateWhere(red.discountId, {}, { inc: { usedCount: -1 } });
        if (red.code) await db.voucherCodes.updateWhere(red.code, { usedCount: { $gt: 0 } }, { inc: { usedCount: -1 } });
        await db.discountUsage.updateWhere(`${red.discountId}:${red.identityId}`, {}, { inc: { orders: -1, amountCents: -red.amountCents } });
      }
    } else if (o.status === "cancelled") {
      await ensure(() => db.identities.insert({ id: identity, orders: 0 }));
      await db.identities.updateWhere(identity, {}, { inc: { orders: 1 } });
    }
    return updated;
  });
}

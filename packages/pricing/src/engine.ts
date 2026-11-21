// The pricing engine: a pure, deterministic function from (cart, shopper, offers, time) to prices.
// The server uses it to charge; the backoffice uses the same code for previews. Browsers never compute prices.
//
// Rules (owner decision D3):
//  1. Line phase: for each cart line, the best (lowest) unit price among the matching per-item offers wins.
//  2. Order phase: the best automatic per-order offer, then the code's per-order offer (if any).
//  3. At most one code per order. A code that isn't "combinable" competes with the automatic offers as a
//     separate scenario; the shopper sees both totals and can pick (the best is preselected).
//  4. Offers with per-customer limits can be "saved for later" by the shopper (declined).
//  5. Budgets (max € per customer) and per-order caps apply the remainder (owner decision P-a).

import { allocate, percentOf, type Cents } from "./money.ts";
import type { Discount, DiscountData } from "./model.ts";

export type Source = "shop" | "product" | "category" | "customer" | "profile" | "code";
export interface OfferRef { discountId: string; label: string; source: Source; sourceLabel?: string }

export interface LineInput {
  productId: string; categoryId: string | null; listCents: Cents; qty: number; name?: string;
  /**
   * "targeted": only offers that name this product apply (bundles by default: a bundle is already a deal, so
   * shop-wide and category offers don't stack on it). "all" (default): every matching offer applies.
   */
  offerScope?: "all" | "targeted";
}
export interface Shopper {
  /** Hash of the normalised email; null while unknown (a guest who hasn't typed an email yet). */
  identityId: string | null;
  customerId: string | null;
  signedIn: boolean;
  profileIds: string[];
}
export interface VoucherInfo { code: string; discountId: string; kind: "shared" | "single"; usedCount: number; assignedCustomerId: string | null }
export interface Usage { orders: number; amountCents: Cents }
export interface Ledger {
  /** Non-cancelled orders placed by this identity; null = unknown (checked at checkout). */
  identityOrders: number | null;
  /** Per-discount usage by this identity. */
  usage: Record<string, Usage>;
}
export interface Selection { scenario?: string | null; declined?: string[] }

export interface PriceInput {
  now: number;
  lines: LineInput[];
  shopper: Shopper;
  discounts: Discount[];
  /** Codes in the cart (normalised). Only the first one is used: one code per order. */
  codes?: string[];
  /** Voucher records for those codes; unknown codes are simply absent. */
  vouchers?: VoucherInfo[];
  ledger?: Ledger;
  selection?: Selection;
  /** Shopper-facing profile labels, for transparency ("Trade member price"). */
  profileLabels?: Record<string, string>;
}

export type LineOfferStatus = "applied" | "better_offer_applied" | "declined" | "not_in_scenario" | "condition";
export interface LineOffer extends OfferRef {
  unitCents: Cents;
  status: LineOfferStatus;
  pending: boolean;
  condition?: { minSubtotalCents?: Cents; minQty?: number };
  endsAt: string | null;
}
export interface LineResult {
  productId: string;
  name?: string;
  qty: number;
  listCents: Cents;
  lineListCents: Cents;
  lineCents: Cents;
  /** Rounded display value; `lineCents` is authoritative. */
  unitCents: Cents;
  appliedFrom: OfferRef | null;
  offers: LineOffer[];
  allocations: { discountId: string; cents: Cents }[];
}
export interface AppliedOffer extends OfferRef {
  scope: "line" | "order";
  code?: string;
  cents: Cents;
  pending: boolean;
  endsAt: string | null;
  /** What is left for this shopper after this order (only for offers with per-customer limits). */
  remaining?: { orders: number | null; amountCents: Cents | null };
}
export interface Scenario { key: "automatic" | "code"; title: string; totalCents: Cents; savingsCents: Cents; best: boolean; selected: boolean; appliedIds: string[] }
export interface DeclineChoice extends OfferRef { declined: boolean; totalIfToggled: Cents; currentTotal: Cents }
export type PublicReason = "invalid" | "min_subtotal" | "min_qty" | "no_matching_items" | "other_scenario" | "better_offer";
export interface RejectedCode { code: string; reason: PublicReason; missingCents?: Cents; minQty?: number }
export type Reason =
  | "applied" | "paused" | "archived" | "not_started" | "expired" | "audience" | "sign_in_required" | "code_missing" | "code_used"
  | "code_not_yours" | "used_up" | "limit_orders" | "limit_budget" | "first_orders_only" | "no_matching_items" | "min_subtotal"
  | "min_qty" | "declined" | "other_scenario" | "better_offer" | "no_effect";
export interface Diagnostic { discountId: string; name: string; reason: Reason }

export interface PricingResult {
  lines: LineResult[];
  subtotalCents: Cents;
  discountCents: Cents;
  totalCents: Cents;
  applied: AppliedOffer[];
  /** Two entries when a non-combinable code competes with automatic offers; otherwise empty. */
  scenarios: Scenario[];
  /** Offers the shopper may save for later (or use again). */
  choices: DeclineChoice[];
  rejectedCodes: RejectedCode[];
  /** True when some applied offer depends on per-customer checks that run at checkout. */
  pending: boolean;
  /** Fingerprint of the selected result, used to detect price changes between cart and checkout. */
  quote: string;
  /** Internal explanation per offer (admin simulator only, never sent to shoppers). */
  diagnostics: Diagnostic[];
}

// ---------------------------------------------------------------------------------------------------------------

interface Candidate {
  d: Discount;
  code?: string;
  pending: boolean;
  /** Remaining cap in cents from the per-customer budget (null = no budget). */
  budget: Cents | null;
}

/** Whether an offer's target covers a line, ignoring `offerScope`. */
const inTarget = (d: DiscountData, l: LineInput): boolean => {
  if (d.excludeProductIds.includes(l.productId)) return false;
  const t = d.target;
  if (t.type === "all") return true;
  if (t.type === "products") return t.productIds.includes(l.productId);
  return l.categoryId != null && t.categoryIds.includes(l.categoryId);
};
/** Whether an offer discounts a line. Used by both the line and the order phase, so `offerScope` applies to both. */
const matches = (d: DiscountData, l: LineInput): boolean =>
  l.offerScope === "targeted" ? d.target.type === "products" && d.target.productIds.includes(l.productId) && !d.excludeProductIds.includes(l.productId) : inTarget(d, l);
/**
 * Whether a line counts towards an offer's minimums (order value, quantity). A bundle that only takes its own offers
 * isn't discounted by a shop-wide or category offer, but it still counts towards "orders over €X" (owner answer Q-3).
 */
const counts = (d: DiscountData, l: LineInput): boolean => inTarget(d, l) || matches(d, l);

const unitPrice = (d: DiscountData, list: Cents): Cents => {
  const e = d.effect;
  if (e.type === "percent") return Math.max(0, list - percentOf(list, e.bp));
  if (e.type === "amountOff") return Math.max(0, list - e.cents);
  return Math.min(list, e.cents);
};

function sourceOf(d: DiscountData, shopper: Shopper, labels: Record<string, string>): Pick<OfferRef, "source" | "sourceLabel"> {
  if (d.trigger === "code") return { source: "code" };
  if (d.audience.type === "customers") return { source: "customer" };
  if (d.audience.type === "profiles") {
    const id = d.audience.profileIds.find((p) => shopper.profileIds.includes(p)) ?? d.audience.profileIds[0];
    return { source: "profile", ...(labels[id] ? { sourceLabel: labels[id] } : {}) };
  }
  if (d.target.type === "products") return { source: "product" };
  if (d.target.type === "categories") return { source: "category" };
  return { source: "shop" };
}

/** Is `d` usable by this shopper right now, ignoring cart-dependent conditions? */
function baseEligibility(d: Discount, input: PriceInput, code: string | undefined, voucher: VoucherInfo | undefined): { ok: true; pending: boolean; budget: Cents | null } | { ok: false; reason: Reason } {
  const { now, shopper } = input;
  if (d.status === "archived") return { ok: false, reason: "archived" };
  if (d.status === "paused") return { ok: false, reason: "paused" };
  if (now < Date.parse(d.startsAt)) return { ok: false, reason: "not_started" };
  if (d.endsAt && now >= Date.parse(d.endsAt)) return { ok: false, reason: "expired" };
  if (d.audience.type === "customers" && !(shopper.signedIn && shopper.customerId && d.audience.customerIds.includes(shopper.customerId))) return { ok: false, reason: "audience" };
  if (d.audience.type === "profiles" && !(shopper.signedIn && d.audience.profileIds.some((p) => shopper.profileIds.includes(p)))) return { ok: false, reason: "audience" };
  if (d.access.requiresSignIn && !shopper.signedIn) return { ok: false, reason: "sign_in_required" };
  if (d.trigger === "code") {
    if (!code || !voucher) return { ok: false, reason: "code_missing" };
    if (voucher.kind === "single" && voucher.usedCount >= 1) return { ok: false, reason: "code_used" };
    if (voucher.assignedCustomerId && !(shopper.signedIn && shopper.customerId === voucher.assignedCustomerId)) return { ok: false, reason: "code_not_yours" };
  }
  if (d.limits.totalUses != null && d.usedCount >= d.limits.totalUses) return { ok: false, reason: "used_up" };
  const pc = d.perCustomer;
  const limited = pc.maxOrders != null || pc.maxAmountCents != null || pc.firstOrders != null;
  let pending = false, budget: Cents | null = null;
  if (limited) {
    const known = shopper.identityId != null && input.ledger != null;
    const usage = input.ledger?.usage[d.id] ?? { orders: 0, amountCents: 0 };
    if (!known) pending = true;
    if (pc.maxOrders != null && known && usage.orders >= pc.maxOrders) return { ok: false, reason: "limit_orders" };
    if (pc.maxAmountCents != null) {
      budget = Math.max(0, pc.maxAmountCents - (known ? usage.amountCents : 0));
      if (budget <= 0) return { ok: false, reason: "limit_budget" };
    }
    if (pc.firstOrders != null) {
      const orders = input.ledger?.identityOrders;
      if (known && orders != null && orders >= pc.firstOrders) return { ok: false, reason: "first_orders_only" };
      if (orders == null) pending = true;
    }
  }
  return { ok: true, pending, budget };
}

interface Run {
  lines: LineResult[];
  applied: AppliedOffer[];
  totalCents: Cents;
  subtotalCents: Cents;
  /** Why each candidate was not applied in this run. */
  notApplied: Map<string, Reason>;
  conditionMisses: Map<string, { reason: "min_subtotal" | "min_qty" | "no_matching_items"; missingCents?: Cents; minQty?: number }>;
}

/** Prices the cart with the given candidates (already filtered for scenario and declines). */
function run(input: PriceInput, cands: Candidate[], all: Candidate[], status: (c: Candidate) => LineOfferStatus | null): Run {
  const labels = input.profileLabels ?? {};
  const lines = input.lines;
  const notApplied = new Map<string, Reason>();
  const conditionMisses: Run["conditionMisses"] = new Map();
  const ref = (c: Candidate): OfferRef => ({ discountId: c.d.id, label: c.d.label, ...sourceOf(c.d, input.shopper, labels) });

  // Cart-dependent conditions for per-item offers are measured on list prices of the matching lines.
  const lineCondOk = (c: Candidate): boolean => {
    if (!lines.some((l) => matches(c.d, l))) { conditionMisses.set(c.d.id, { reason: "no_matching_items" }); return false; }
    const m = lines.filter((l) => counts(c.d, l));
    const qty = m.reduce((a, l) => a + l.qty, 0), sub = m.reduce((a, l) => a + l.listCents * l.qty, 0);
    const { minQty, minSubtotalCents } = c.d.conditions;
    if (minQty != null && qty < minQty) { conditionMisses.set(c.d.id, { reason: "min_qty", minQty }); return false; }
    if (minSubtotalCents != null && sub < minSubtotalCents) { conditionMisses.set(c.d.id, { reason: "min_subtotal", missingCents: minSubtotalCents - sub }); return false; }
    return true;
  };

  // ---- line phase ----
  const lineCands = cands.filter((c) => c.d.scope === "line" && lineCondOk(c));
  const lineCondFailed = new Set(cands.filter((c) => c.d.scope === "line" && !lineCands.includes(c)).map((c) => c.d.id));
  const winners: (Candidate | null)[] = lines.map((l) => {
    let best: Candidate | null = null, bestUnit = l.listCents;
    for (const c of lineCands) {
      if (!matches(c.d, l)) continue;
      const u = unitPrice(c.d, l.listCents);
      if (u < bestUnit || (u === bestUnit && best && u < l.listCents && (c.d.priority > best.d.priority || (c.d.priority === best.d.priority && c.d.id < best.d.id)))) { best = c; bestUnit = u; }
    }
    return best;
  });
  // Per-line discount amounts, then caps (budget remainder, per-order max) per winning offer.
  const lineDisc = lines.map((l, i) => (winners[i] ? (l.listCents - unitPrice(winners[i]!.d, l.listCents)) * l.qty : 0));
  for (const c of lineCands) {
    const idx = lines.map((_, i) => i).filter((i) => winners[i] === c);
    if (!idx.length) continue;
    const total = idx.reduce((a, i) => a + lineDisc[i], 0);
    const cap = Math.min(c.budget ?? Infinity, c.d.limits.maxDiscountPerOrderCents ?? Infinity);
    if (total > cap) {
      const parts = allocate(cap, idx.map((i) => lineDisc[i]));
      idx.forEach((i, k) => { lineDisc[i] = parts[k]; });
    }
  }
  const out: LineResult[] = lines.map((l, i) => {
    const lineList = l.listCents * l.qty;
    const w = winners[i];
    const offers: LineOffer[] = all.filter((c) => c.d.scope === "line" && matches(c.d, l)).map((c) => {
      const won = c === w && lineDisc[i] > 0;
      const st: LineOfferStatus = won ? "applied" : status(c) ?? (lineCondFailed.has(c.d.id) ? "condition" : "better_offer_applied");
      const miss = conditionMisses.get(c.d.id);
      return {
        ...ref(c), unitCents: unitPrice(c.d, l.listCents), status: st, pending: c.pending, endsAt: c.d.endsAt,
        ...(st === "condition" && miss ? { condition: { ...(c.d.conditions.minSubtotalCents != null ? { minSubtotalCents: c.d.conditions.minSubtotalCents } : {}), ...(c.d.conditions.minQty != null ? { minQty: c.d.conditions.minQty } : {}) } } : {}),
      };
    }).sort((a, b) => a.unitCents - b.unitCents || a.discountId.localeCompare(b.discountId));
    return {
      productId: l.productId, ...(l.name !== undefined ? { name: l.name } : {}), qty: l.qty, listCents: l.listCents, lineListCents: lineList,
      lineCents: lineList - lineDisc[i], unitCents: Math.round((lineList - lineDisc[i]) / l.qty),
      appliedFrom: w && lineDisc[i] > 0 ? ref(w) : null, offers,
      allocations: w && lineDisc[i] > 0 ? [{ discountId: w.d.id, cents: lineDisc[i] }] : [],
    };
  });

  const applied: AppliedOffer[] = [];
  for (const c of lineCands) {
    const cents = out.reduce((a, l) => a + l.allocations.filter((x) => x.discountId === c.d.id).reduce((s, x) => s + x.cents, 0), 0);
    if (cents > 0) applied.push({ ...ref(c), scope: "line", ...(c.code ? { code: c.code } : {}), cents, pending: c.pending, endsAt: c.d.endsAt });
    else if (!lineCondFailed.has(c.d.id)) notApplied.set(c.d.id, lines.some((l) => matches(c.d, l)) ? (lines.some((l, i) => matches(c.d, l) && unitPrice(c.d, l.listCents) < l.listCents && winners[i] !== c) ? "better_offer" : "no_effect") : "no_matching_items");
  }
  for (const id of lineCondFailed) notApplied.set(id, conditionMisses.get(id)?.reason ?? "no_matching_items");

  // ---- order phase ----
  const orderAmount = (c: Candidate): { cents: Cents; idx: number[] } | null => {
    // Lines the offer discounts, and lines that count towards its minimums (those plus bundles that skip it, Q-3).
    const idx = out.map((_, i) => i).filter((i) => matches(c.d, lines[i]) && out[i].lineCents > 0);
    if (!idx.length) { conditionMisses.set(c.d.id, { reason: "no_matching_items" }); return null; }
    const counted = out.map((_, i) => i).filter((i) => counts(c.d, lines[i]));
    const base = idx.reduce((a, i) => a + out[i].lineCents, 0);
    const countedValue = counted.reduce((a, i) => a + out[i].lineCents, 0);
    const qty = counted.reduce((a, i) => a + lines[i].qty, 0);
    const { minQty, minSubtotalCents } = c.d.conditions;
    if (minQty != null && qty < minQty) { conditionMisses.set(c.d.id, { reason: "min_qty", minQty }); return null; }
    if (minSubtotalCents != null && countedValue < minSubtotalCents) { conditionMisses.set(c.d.id, { reason: "min_subtotal", missingCents: minSubtotalCents - countedValue }); return null; }
    const e = c.d.effect;
    let cents = e.type === "percent" ? percentOf(base, e.bp) : e.type === "amountOff" ? Math.min(e.cents, base) : 0;
    cents = Math.min(cents, c.budget ?? Infinity, c.d.limits.maxDiscountPerOrderCents ?? Infinity, base);
    return { cents, idx };
  };
  const applyOrder = (c: Candidate, r: { cents: Cents; idx: number[] }) => {
    const parts = allocate(r.cents, r.idx.map((i) => out[i].lineCents));
    r.idx.forEach((i, k) => {
      if (!parts[k]) return;
      out[i].lineCents -= parts[k];
      out[i].unitCents = Math.round(out[i].lineCents / out[i].qty);
      out[i].allocations.push({ discountId: c.d.id, cents: parts[k] });
    });
    applied.push({ ...ref(c), scope: "order", ...(c.code ? { code: c.code } : {}), cents: r.cents, pending: c.pending, endsAt: c.d.endsAt });
  };
  const orderCands = cands.filter((c) => c.d.scope === "order");
  // best automatic per-order offer
  let bestAuto: { c: Candidate; r: { cents: Cents; idx: number[] } } | null = null;
  for (const c of orderCands.filter((x) => x.d.trigger === "automatic")) {
    const r = orderAmount(c);
    if (!r) { notApplied.set(c.d.id, conditionMisses.get(c.d.id)!.reason); continue; }
    if (r.cents <= 0) { notApplied.set(c.d.id, "no_effect"); continue; }
    if (!bestAuto || r.cents > bestAuto.r.cents || (r.cents === bestAuto.r.cents && (c.d.priority > bestAuto.c.d.priority || (c.d.priority === bestAuto.c.d.priority && c.d.id < bestAuto.c.d.id)))) {
      if (bestAuto) notApplied.set(bestAuto.c.d.id, "better_offer");
      bestAuto = { c, r };
    } else notApplied.set(c.d.id, "better_offer");
  }
  if (bestAuto) applyOrder(bestAuto.c, bestAuto.r);
  for (const c of orderCands.filter((x) => x.d.trigger === "code")) {
    const r = orderAmount(c);
    if (!r) { notApplied.set(c.d.id, conditionMisses.get(c.d.id)!.reason); continue; }
    if (r.cents <= 0) { notApplied.set(c.d.id, "no_effect"); continue; }
    applyOrder(c, r);
  }

  const subtotalCents = out.reduce((a, l) => a + l.lineListCents, 0);
  const totalCents = out.reduce((a, l) => a + l.lineCents, 0);
  return { lines: out, applied, subtotalCents, totalCents, notApplied, conditionMisses };
}

/** Small non-cryptographic hash (cyrb53): the quote only detects changes, it is never trusted for prices. */
function fingerprint(s: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) { const ch = s.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function price(input: PriceInput): PricingResult {
  return priceWith(input, true);
}

function priceWith(input: PriceInput, withChoices: boolean): PricingResult {
  for (const l of input.lines) {
    if (!Number.isInteger(l.listCents) || l.listCents < 0 || !Number.isInteger(l.qty) || l.qty < 1) throw new Error("invalid cart line");
  }
  const discounts = [...input.discounts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const code = input.codes?.[0];
  const voucher = code ? input.vouchers?.find((v) => v.code === code) : undefined;
  const declined = new Set(input.selection?.declined ?? []);
  const diag = new Map<string, Reason>();

  const eligible: Candidate[] = [];
  for (const d of discounts) {
    const isCode = d.trigger === "code";
    const e = baseEligibility(d, input, isCode && voucher?.discountId === d.id ? code : undefined, isCode && voucher?.discountId === d.id ? voucher : undefined);
    if (!e.ok) { diag.set(d.id, e.reason); continue; }
    eligible.push({ d, ...(isCode ? { code } : {}), pending: e.pending, budget: e.budget });
  }
  const isDeclined = (c: Candidate) => c.d.declinable && declined.has(c.d.id);
  const codeCand = eligible.find((c) => c.d.trigger === "code");
  const autos = eligible.filter((c) => c.d.trigger === "automatic");

  type Pick = { key: "automatic" | "code" | "all"; include: Candidate[] };
  const scenarioPicks: Pick[] = codeCand && !codeCand.d.combinable
    ? [{ key: "automatic", include: autos }, { key: "code", include: [codeCand] }]
    : [{ key: "all", include: eligible }];

  const runPick = (p: Pick) => {
    const inc = p.include.filter((c) => !isDeclined(c));
    const status = (c: Candidate): LineOfferStatus | null => {
      if (!p.include.includes(c)) return "not_in_scenario";
      if (!inc.includes(c)) return "declined";
      return null;
    };
    return run(input, inc, eligible, status);
  };
  const runs = scenarioPicks.map((p) => ({ p, r: runPick(p) }));

  // A scenario choice only exists if both sides actually save something.
  const viable = runs.filter((x) => x.r.applied.length > 0);
  let chosen = runs[0];
  let scenarios: Scenario[] = [];
  if (runs.length === 2) {
    const best = [...runs].sort((a, b) => a.r.totalCents - b.r.totalCents || (a.p.key === "automatic" ? -1 : 1))[0];
    const wanted = runs.find((x) => x.p.key === input.selection?.scenario);
    if (viable.length === 2) {
      chosen = wanted ?? best;
      scenarios = runs.map((x) => ({
        key: x.p.key as "automatic" | "code",
        title: x.p.key === "code" ? `Code ${codeCand!.code}` : "Automatic offers",
        totalCents: x.r.totalCents, savingsCents: x.r.subtotalCents - x.r.totalCents,
        best: x === best, selected: x === chosen, appliedIds: x.r.applied.map((a) => a.discountId),
      }));
    } else chosen = viable[0] ?? best;
  }
  const r = chosen.r;

  // Diagnostics for everything that was eligible. For an offer outside the chosen scenario, report why it didn't
  // save anything in its own scenario, or "other_scenario" if it would have.
  const misses = new Map(r.conditionMisses);
  for (const c of eligible) {
    if (r.applied.some((a) => a.discountId === c.d.id)) diag.set(c.d.id, "applied");
    else if (isDeclined(c)) diag.set(c.d.id, "declined");
    else if (!chosen.p.include.includes(c)) {
      const own = runs.find((x) => x !== chosen && x.p.include.includes(c));
      if (own && !own.r.applied.some((a) => a.discountId === c.d.id)) {
        diag.set(c.d.id, own.r.notApplied.get(c.d.id) ?? "better_offer");
        const m = own.r.conditionMisses.get(c.d.id);
        if (m) misses.set(c.d.id, m);
      } else diag.set(c.d.id, "other_scenario");
    } else diag.set(c.d.id, r.notApplied.get(c.d.id) ?? "better_offer");
  }

  // Remaining per-customer allowance after this order, for transparency.
  for (const a of r.applied) {
    const d = discounts.find((x) => x.id === a.discountId)!;
    const pc = d.perCustomer;
    if (pc.maxOrders == null && pc.maxAmountCents == null) continue;
    const u = input.shopper.identityId && input.ledger ? input.ledger.usage[d.id] ?? { orders: 0, amountCents: 0 } : { orders: 0, amountCents: 0 };
    a.remaining = {
      orders: pc.maxOrders != null ? Math.max(0, pc.maxOrders - u.orders - 1) : null,
      amountCents: pc.maxAmountCents != null ? Math.max(0, pc.maxAmountCents - u.amountCents - a.cents) : null,
    };
  }

  // Save-for-later choices: applied declinable offers and currently declined ones.
  // The advertised alternative is a full re-price with the toggle, so it is exactly what the shopper would pay
  // (toggling can change which scenario is best).
  const choices: DeclineChoice[] = [];
  for (const c of withChoices ? eligible.filter((x) => x.d.declinable) : []) {
    const isApplied = r.applied.some((a) => a.discountId === c.d.id);
    const wasDeclined = isDeclined(c);
    if (!isApplied && !wasDeclined) continue;
    const nextDeclined = new Set(declined);
    if (wasDeclined) nextDeclined.delete(c.d.id); else nextDeclined.add(c.d.id);
    const alt = priceWith({ ...input, selection: { ...input.selection, declined: [...nextDeclined] } }, false);
    if (wasDeclined && !alt.applied.some((a) => a.discountId === c.d.id)) continue;
    choices.push({ discountId: c.d.id, label: c.d.label, ...sourceOf(c.d, input.shopper, input.profileLabels ?? {}), declined: wasDeclined, totalIfToggled: alt.totalCents, currentTotal: r.totalCents });
  }

  // Why the code in the cart (if any) isn't saving anything, in shopper-safe terms.
  const rejectedCodes: RejectedCode[] = [];
  if (code) {
    const codeDiscountId = voucher?.discountId;
    const isApplied = codeDiscountId && r.applied.some((a) => a.discountId === codeDiscountId);
    if (!isApplied) {
      const reason = codeDiscountId ? diag.get(codeDiscountId) : undefined;
      const miss = codeDiscountId ? misses.get(codeDiscountId) : undefined;
      if (reason === "min_subtotal" && miss?.missingCents) rejectedCodes.push({ code, reason: "min_subtotal", missingCents: miss.missingCents });
      else if (reason === "min_qty" && miss?.minQty) rejectedCodes.push({ code, reason: "min_qty", minQty: miss.minQty });
      else if (reason === "no_matching_items") rejectedCodes.push({ code, reason: "no_matching_items" });
      else if (reason === "other_scenario") rejectedCodes.push({ code, reason: "other_scenario" });
      else if (reason === "better_offer" || reason === "no_effect") rejectedCodes.push({ code, reason: "better_offer" });
      else if (reason !== "declined") rejectedCodes.push({ code, reason: "invalid" });
    }
  }

  const result: PricingResult = {
    lines: r.lines, subtotalCents: r.subtotalCents, discountCents: r.subtotalCents - r.totalCents, totalCents: r.totalCents,
    applied: r.applied, scenarios, choices, rejectedCodes, pending: r.applied.some((a) => a.pending),
    quote: "", diagnostics: discounts.map((d) => ({ discountId: d.id, name: d.name, reason: diag.get(d.id) ?? "no_effect" })),
  };
  result.quote = fingerprint(JSON.stringify([result.totalCents, result.lines.map((l) => [l.productId, l.qty, l.lineCents]), result.applied.map((a) => [a.discountId, a.cents])]));
  checkInvariants(result);
  return result;
}

/** The engine refuses to return a wrong price. */
export function checkInvariants(r: Pick<PricingResult, "lines" | "subtotalCents" | "totalCents" | "applied">): void {
  const fail = (m: string) => { throw new Error(`pricing invariant violated: ${m}`); };
  let sub = 0, tot = 0, alloc = 0;
  for (const l of r.lines) {
    if (!Number.isInteger(l.lineCents) || l.lineCents < 0) fail("negative or fractional line");
    if (l.lineCents > l.lineListCents) fail("price above list price");
    const a = l.allocations.reduce((s, x) => s + x.cents, 0);
    if (a !== l.lineListCents - l.lineCents) fail("allocations don't add up on a line");
    sub += l.lineListCents; tot += l.lineCents; alloc += a;
  }
  if (sub !== r.subtotalCents || tot !== r.totalCents) fail("totals don't add up");
  if (r.totalCents < 0 || r.totalCents > r.subtotalCents) fail("total out of range");
  if (r.applied.reduce((s, a) => s + a.cents, 0) !== alloc) fail("applied amounts don't match allocations");
}

import type { FastifyInstance, FastifyReply } from "fastify";
import { DuplicateKeyError } from "@openshop/db";
import { addLocalDays, instantToLocal, zonedToInstant, type PricingResult } from "@openshop/pricing";
import { getSettings } from "./settings.ts";
import { sendList } from "./negotiate.ts";
import type { ChoiceEvent, Db, DiscountDoc, Order, OrderChoice } from "./types.ts";
import { CONFIG } from "./config.ts";
import { searchFor } from "./catalogue/search/service.ts";

// ---------------------------------------------------------------------------------------------------------------
// Choice tracking: when a shopper can pick between a non-combinable code (e.g. an influencer's code) and the
// automatic offers, we record that the choice was shown, and at checkout what they picked and how much more they
// paid than the best option. This shows how many shoppers prefer the code even when it costs them more.

/** The choice in a pricing result, if the shopper had one. */
export function choiceOf(r: PricingResult, code: string | undefined): OrderChoice | null {
  const auto = r.scenarios.find((s) => s.key === "automatic"), viaCode = r.scenarios.find((s) => s.key === "code");
  if (!auto || !viaCode || !code) return null;
  const best = auto.best ? "automatic" : "code";
  const selected = viaCode.selected ? "code" : "automatic";
  const selTotal = selected === "code" ? viaCode.totalCents : auto.totalCents, bestTotal = best === "code" ? viaCode.totalCents : auto.totalCents;
  return { discountId: viaCode.appliedIds[0], code, options: { automatic: auto.totalCents / 100, code: viaCode.totalCents / 100 }, best, selected, extra: Math.max(0, selTotal - bestTotal) / 100 };
}

/** A cart showed the choice (recorded once per cart and code offer). */
export async function recordChoiceShown(db: Db, cartId: string, r: PricingResult, code: string | undefined, now = Date.now()) {
  const c = choiceOf(r, code);
  if (!c) return;
  try {
    await db.choiceEvents.insert({ id: `${cartId}:${c.discountId}`, cartId, discountId: c.discountId, code: c.code, shownAt: new Date(now).toISOString(), best: c.best, automaticCents: Math.round(c.options.automatic * 100), codeCents: Math.round(c.options.code * 100) });
  } catch (e) { if (!(e instanceof DuplicateKeyError)) throw e; }
}

/** An order was placed after the choice: what was picked, and the extra paid. */
export async function recordChoiceOutcome(db: Db, opts: { cartId: string | null; orderId: string; choice: OrderChoice; at: string }) {
  const { choice: c } = opts;
  const id = opts.cartId ? `${opts.cartId}:${c.discountId}` : `order:${opts.orderId}:${c.discountId}`;
  const outcome = { orderId: opts.orderId, orderedAt: opts.at, selected: c.selected, extraCents: Math.round(c.extra * 100), best: c.best, automaticCents: Math.round(c.options.automatic * 100), codeCents: Math.round(c.options.code * 100) };
  try { await db.choiceEvents.insert({ id, cartId: opts.cartId, discountId: c.discountId, code: c.code, shownAt: opts.at, ...outcome }); }
  catch (e) { if (!(e instanceof DuplicateKeyError)) throw e; await db.choiceEvents.update(id, outcome); }
}

// ---------------------------------------------------------------------------------------------------------------
// Reports. Periods are whole days in the shop's time zone; money is in the shop currency (2 decimals).

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const eur = (cents: number) => Math.round(cents) / 100;
const cents = (amount: number | undefined) => Math.round((amount ?? 0) * 100);

interface Period { from: string; to: string; fromIso: string; toIso: string; days: string[]; timezone: string; prev: { fromIso: string; toIso: string } }

async function period(db: Db, q: { from?: string; to?: string }): Promise<Period | { error: string }> {
  const { timezone } = await getSettings(db);
  const today = instantToLocal(Date.now(), timezone).slice(0, 10);
  const to = q.to ?? today;
  const from = q.from ?? addLocalDays(`${to}T00:00`, -29).slice(0, 10);
  if (!DAY.test(from) || !DAY.test(to)) return { error: "from and to must be dates like 2026-12-31" };
  const days: string[] = [];
  for (let d = from; d <= to && days.length <= CONFIG.insights.maxDays; d = addLocalDays(`${d}T00:00`, 1).slice(0, 10)) days.push(d);
  if (from > to || days.length > CONFIG.insights.maxDays) return { error: `the period must be 1 to ${CONFIG.insights.maxDays} days` };
  const fromMs = zonedToInstant(`${from}T00:00`, timezone), toMs = zonedToInstant(addLocalDays(`${to}T00:00`, 1), timezone);
  const span = toMs - fromMs;
  return {
    from, to, days, timezone, fromIso: new Date(fromMs).toISOString(), toIso: new Date(toMs).toISOString(),
    prev: { fromIso: new Date(fromMs - span).toISOString(), toIso: new Date(fromMs).toISOString() },
  };
}

const ordersIn = async (db: Db, fromIso: string, toIso: string) =>
  (await db.orders.find({ createdAt: { $gte: fromIso, $lt: toIso } })).filter((o) => o.status !== "cancelled");

function totals(orders: Order[]) {
  const discounted = orders.filter((o) => (o.discountTotal ?? 0) > 0);
  const revenue = orders.reduce((a, o) => a + cents(o.total), 0);
  const gross = orders.reduce((a, o) => a + cents(o.subtotal ?? o.total), 0);
  const discountCost = orders.reduce((a, o) => a + cents(o.discountTotal), 0);
  return {
    orders: orders.length, ordersWithDiscount: discounted.length, revenue: eur(revenue), grossRevenue: eur(gross), discountCost: eur(discountCost),
    avgDiscount: discounted.length ? eur(discountCost / discounted.length) : 0,
    avgOrderValue: orders.length ? eur(revenue / orders.length) : 0,
    discountShare: gross ? Math.round((discountCost / gross) * 1000) / 10 : 0,
  };
}

/** Choice events shown in the period, with the order status taken into account (cancelled = not ordered). */
async function choicesIn(db: Db, p: Period) {
  const events = await db.choiceEvents.find({ shownAt: { $gte: p.fromIso, $lt: p.toIso } });
  const ids = [...new Set(events.map((e) => e.orderId).filter((x): x is string => !!x))];
  const orders = ids.length ? new Map((await db.orders.find({ id: { $in: ids } })).map((o) => [o.id, o])) : new Map<string, Order>();
  return events.map((e) => {
    const o = e.orderId ? orders.get(e.orderId) : undefined;
    return { ...e, ordered: !!o && o.status !== "cancelled" };
  });
}

function choiceStats(events: (ChoiceEvent & { ordered: boolean })[]) {
  const ordered = events.filter((e) => e.ordered);
  const codePayingMore = ordered.filter((e) => e.selected === "code" && e.best === "automatic" && (e.extraCents ?? 0) > 0).length;
  const autoPayingMore = ordered.filter((e) => e.selected === "automatic" && e.best === "code" && (e.extraCents ?? 0) > 0).length;
  const lessFavourable = codePayingMore + autoPayingMore;
  const extra = ordered.reduce((a, e) => a + (e.extraCents ?? 0), 0);
  return {
    shown: events.length, ordered: ordered.length, notOrdered: events.length - ordered.length,
    tookBest: ordered.length - lessFavourable, choseCodePayingMore: codePayingMore, choseAutomaticPayingMore: autoPayingMore,
    lessFavourable, lessFavourableRate: ordered.length ? Math.round((lessFavourable / ordered.length) * 1000) / 10 : 0,
    codeChosen: ordered.filter((e) => e.selected === "code").length,
    extraPaid: eur(extra), avgExtraWhenLessFavourable: lessFavourable ? eur(extra / lessFavourable) : 0,
  };
}

export function registerInsights(admin: FastifyInstance, { db }: { db: Db }) {
  const bad = (reply: FastifyReply, error: string) => reply.code(400).send({ error, fields: [{ field: "period", message: error }] });
  const nameOf = (ds: Map<string, DiscountDoc>, id: string, fallback: string) => ds.get(id)?.name ?? fallback;
  const discountMap = async () => new Map((await db.discounts.find({})).map((d) => [d.id, d]));

  // Headline numbers for the period, and the same numbers for the previous period of equal length.
  admin.get<{ Querystring: { from?: string; to?: string } }>("/api/reports/summary", { config: { perm: "insights.view" } }, async (req, reply) => {
    const p = await period(db, req.query);
    if ("error" in p) return bad(reply, p.error);
    const [cur, prev] = await Promise.all([ordersIn(db, p.fromIso, p.toIso), ordersIn(db, p.prev.fromIso, p.prev.toIso)]);
    const choices = choiceStats(await choicesIn(db, p));
    const saved = cur.flatMap((o) => o.savedForLater ?? []);
    return {
      from: p.from, to: p.to, timezone: p.timezone, ...totals(cur), previous: totals(prev), choices,
      savedForLater: { orders: cur.filter((o) => o.savedForLater?.length).length, extraPaid: eur(saved.reduce((a, s) => a + cents(s.extra), 0)) },
    };
  });

  // Revenue and discount cost by day, by offer or by campaign (JSON or CSV by Accept).
  admin.get<{ Querystring: { from?: string; to?: string; groupBy?: string } }>("/api/reports/discounts", { config: { perm: "insights.view" } }, async (req, reply) => {
    const p = await period(db, req.query);
    if ("error" in p) return bad(reply, p.error);
    const groupBy = req.query.groupBy ?? "day";
    const orders = await ordersIn(db, p.fromIso, p.toIso);
    if (groupBy === "day") {
      const byDay = new Map(p.days.map((d) => [d, [] as Order[]]));
      for (const o of orders) byDay.get(instantToLocal(Date.parse(o.createdAt), p.timezone).slice(0, 10))?.push(o);
      const items = p.days.map((day) => { const t = totals(byDay.get(day)!); return { day, orders: t.orders, ordersWithDiscount: t.ordersWithDiscount, revenue: t.revenue, discountCost: t.discountCost }; });
      return sendList(req, reply, { items, total: items.length, filename: `discounts-by-day-${p.from}-${p.to}.csv`,
        columns: [["day", (i) => i.day], ["orders", (i) => i.orders], ["orders with discount", (i) => i.ordersWithDiscount], ["revenue", (i) => i.revenue.toFixed(2)], ["discount cost", (i) => i.discountCost.toFixed(2)]] });
    }
    const ds = await discountMap();
    if (groupBy === "discount" || groupBy === "campaign") {
      const rows = new Map<string, { key: string; name: string; label: string; campaign: string | null; trigger: string; orders: number; discountCost: number; revenue: number }>();
      for (const o of orders) {
        const seen = new Set<string>();
        for (const d of o.discounts ?? []) {
          const doc = ds.get(d.discountId);
          const campaign = doc?.campaign ?? null;
          const key = groupBy === "discount" ? d.discountId : campaign ?? "";
          const r = rows.get(key) ?? { key, name: groupBy === "discount" ? nameOf(ds, d.discountId, d.label) : campaign ?? "No campaign", label: groupBy === "discount" ? d.label : "", campaign, trigger: doc?.trigger ?? (d.code ? "code" : "automatic"), orders: 0, discountCost: 0, revenue: 0 };
          r.discountCost += cents(d.amount);
          if (!seen.has(key)) { r.orders++; r.revenue += cents(o.total); seen.add(key); }
          rows.set(key, r);
        }
      }
      const items = [...rows.values()].map((r) => ({ ...(groupBy === "discount" ? { discountId: r.key, name: r.name, label: r.label, campaign: r.campaign, trigger: r.trigger } : { campaign: r.name }), orders: r.orders, discountCost: eur(r.discountCost), revenue: eur(r.revenue), avgOrderValue: r.orders ? eur(r.revenue / r.orders) : 0 }))
        .sort((a, b) => b.discountCost - a.discountCost || ("name" in a ? a.name : a.campaign).localeCompare("name" in b ? b.name : b.campaign));
      return sendList(req, reply, { items, total: items.length, filename: `discounts-by-${groupBy}-${p.from}-${p.to}.csv`,
        columns: [[groupBy === "discount" ? "offer" : "campaign", (i) => ("name" in i ? i.name : i.campaign)], ["orders", (i) => i.orders], ["discount cost", (i) => i.discountCost.toFixed(2)], ["revenue", (i) => i.revenue.toFixed(2)], ["average order", (i) => i.avgOrderValue.toFixed(2)]] });
    }
    return bad(reply, "groupBy must be day, discount or campaign");
  });

  // Choices between a code and the automatic offers: shown, ordered, and how many picked the less favourable one.
  admin.get<{ Querystring: { from?: string; to?: string; groupBy?: string } }>("/api/reports/choices", { config: { perm: "insights.view" } }, async (req, reply) => {
    const p = await period(db, req.query);
    if ("error" in p) return bad(reply, p.error);
    const events = await choicesIn(db, p);
    const groupBy = req.query.groupBy ?? "code";
    if (groupBy === "day") {
      const byDay = new Map(p.days.map((d) => [d, [] as typeof events]));
      for (const e of events) byDay.get(instantToLocal(Date.parse(e.shownAt), p.timezone).slice(0, 10))?.push(e);
      const items = p.days.map((day) => ({ day, ...choiceStats(byDay.get(day)!) }));
      return sendList(req, reply, { items, total: items.length, filename: `choices-by-day-${p.from}-${p.to}.csv`,
        columns: [["day", (i) => i.day], ["shown", (i) => i.shown], ["ordered", (i) => i.ordered], ["took the best price", (i) => i.tookBest], ["chose less favourable", (i) => i.lessFavourable], ["extra paid", (i) => i.extraPaid.toFixed(2)]] });
    }
    if (groupBy !== "code") return bad(reply, "groupBy must be code or day");
    const ds = await discountMap();
    const groups = new Map<string, typeof events>();
    for (const e of events) { const k = `${e.discountId}\u0000${e.code}`; groups.set(k, [...(groups.get(k) ?? []), e]); }
    const items = [...groups.values()].map((es) => {
      const d = ds.get(es[0].discountId);
      return { discountId: es[0].discountId, name: d?.name ?? "Deleted offer", label: d?.label ?? "", campaign: d?.campaign ?? null, code: es[0].code, ...choiceStats(es) };
    }).sort((a, b) => b.shown - a.shown);
    return sendList(req, reply, { items, total: items.length, filename: `choices-by-code-${p.from}-${p.to}.csv`,
      columns: [["code", (i) => i.code], ["offer", (i) => i.name], ["campaign", (i) => i.campaign], ["shown", (i) => i.shown], ["ordered", (i) => i.ordered], ["took the best price", (i) => i.tookBest],
        ["chose the code, paying more", (i) => i.choseCodePayingMore], ["chose automatic, paying more", (i) => i.choseAutomaticPayingMore], ["less favourable %", (i) => i.lessFavourableRate], ["extra paid", (i) => i.extraPaid.toFixed(2)], ["didn't order", (i) => i.notOrdered]] });
  });

  // Shop searches that found nothing, most frequent first, with what the same words find today (the catalogue may
  // have changed since). JSON or CSV by Accept; CSV cells are formula-safe (C6).
  admin.get<{ Querystring: { from?: string; to?: string } }>("/api/reports/search-misses", { config: { perm: "insights.view" } }, async (req, reply) => {
    const p = await period(db, req.query);
    if ("error" in p) return bad(reply, p.error);
    const rows = new Map<string, { q: string; count: number; days: number; lastAt: string }>();
    for (const m of await db.searchMisses.find({ day: { $gte: p.from, $lte: p.to } })) {
      const r = rows.get(m.q) ?? { q: m.q, count: 0, days: 0, lastAt: m.lastAt };
      r.count += m.count; r.days++; if (m.lastAt > r.lastAt) r.lastAt = m.lastAt;
      rows.set(m.q, r);
    }
    const top = [...rows.values()].sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt)).slice(0, CONFIG.search.misses.reportRows);
    const index = await searchFor(db).index("public");
    const items = top.map((r) => ({ ...r, findsNow: index.query({ q: r.q, limit: 0, facets: false }).total }));
    return sendList(req, reply, { items, total: rows.size, filename: `searches-without-results-${p.from}-${p.to}.csv`,
      columns: [["search", (i) => i.q], ["times", (i) => i.count], ["days", (i) => i.days], ["last searched", (i) => i.lastAt], ["finds now", (i) => i.findsNow]] });
  });

  // Limited offers that shoppers kept for later, and how much more they paid on that order.
  admin.get<{ Querystring: { from?: string; to?: string } }>("/api/reports/saved-for-later", { config: { perm: "insights.view" } }, async (req, reply) => {
    const p = await period(db, req.query);
    if ("error" in p) return bad(reply, p.error);
    const ds = await discountMap();
    const rows = new Map<string, { discountId: string; name: string; orders: number; extra: number }>();
    for (const o of await ordersIn(db, p.fromIso, p.toIso)) for (const s of o.savedForLater ?? []) {
      const r = rows.get(s.discountId) ?? { discountId: s.discountId, name: nameOf(ds, s.discountId, s.label), orders: 0, extra: 0 };
      r.orders++; r.extra += cents(s.extra); rows.set(s.discountId, r);
    }
    const items = [...rows.values()].map((r) => ({ discountId: r.discountId, name: r.name, orders: r.orders, extraPaid: eur(r.extra) })).sort((a, b) => b.orders - a.orders);
    return sendList(req, reply, { items, total: items.length, filename: `saved-for-later-${p.from}-${p.to}.csv`,
      columns: [["offer", (i) => i.name], ["orders", (i) => i.orders], ["extra paid", (i) => i.extraPaid.toFixed(2)]] });
  });
}

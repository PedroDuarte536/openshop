import { test } from "node:test";
import assert from "node:assert/strict";
import { price, type Discount, type PriceInput, type VoucherInfo } from "../src/index.ts";
import { NOW, guest, offer } from "./helpers.ts";

// Seeded PRNG (mulberry32) so failures are reproducible.
function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function randomCase(seed: number): PriceInput {
  const r = rng(seed);
  const int = (a: number, b: number) => a + Math.floor(r() * (b - a + 1));
  const pick = <T,>(xs: T[]) => xs[int(0, xs.length - 1)];
  const products = ["p1", "p2", "p3", "p4", "p5", "p6"], cats = ["c1", "c2", "c3"];
  // Some lines are bundles: only offers that name them apply (offerScope "targeted").
  const lines = Array.from({ length: int(0, 6) }, (_, i) => ({ productId: products[i], categoryId: r() < 0.8 ? pick(cats) : null, listCents: int(0, 20000), qty: int(1, 5), ...(r() < 0.2 ? { offerScope: "targeted" as const } : {}) }));
  const discounts: Discount[] = [];
  let codeId: string | null = null;
  for (let i = 0; i < int(0, 7); i++) {
    const scope = r() < 0.65 ? "line" : "order";
    const et = scope === "order" ? pick(["percent", "amountOff"]) : pick(["percent", "amountOff", "fixedPrice"]);
    const effect = et === "percent" ? { type: et, bp: int(1, 10000) } : { type: et, cents: et === "fixedPrice" ? int(0, 20000) : int(1, 20000) };
    const target = pick([{ type: "all" }, { type: "products", productIds: [pick(products), pick(products)].filter((v, k, a) => a.indexOf(v) === k) }, { type: "categories", categoryIds: [pick(cats)] }]);
    const trigger = !codeId && r() < 0.25 ? "code" : "automatic";
    const d = offer({
      scope, effect, target, trigger, priority: int(0, 3), combinable: r() < 0.5,
      excludeProductIds: r() < 0.2 ? [pick(products)] : [],
      conditions: { minSubtotalCents: r() < 0.3 ? int(1, 40000) : null, minQty: r() < 0.2 ? int(1, 6) : null },
      perCustomer: { maxAmountCents: r() < 0.25 ? int(1, 5000) : null, firstOrders: r() < 0.1 ? 1 : null, maxOrders: r() < 0.1 ? 2 : null },
      limits: { maxDiscountPerOrderCents: r() < 0.2 ? int(1, 10000) : null, totalUses: null },
    }, { id: `r${seed}-${i}` });
    if (trigger === "code") codeId = d.id;
    discounts.push(d);
  }
  const vouchers: VoucherInfo[] = codeId ? [{ code: "RANDOM", discountId: codeId, kind: "shared", usedCount: 0, assignedCustomerId: null }] : [];
  const knownShopper = r() < 0.5;
  return {
    now: NOW, lines, discounts, codes: codeId ? ["RANDOM"] : [], vouchers,
    shopper: knownShopper ? { ...guest, identityId: "x" } : guest,
    ledger: knownShopper ? { identityOrders: int(0, 2), usage: Object.fromEntries(discounts.map((d) => [d.id, { orders: int(0, 2), amountCents: int(0, 3000) }])) } : undefined,
    selection: { scenario: r() < 0.3 ? pick(["automatic", "code"]) : null, declined: discounts.filter(() => r() < 0.15).map((d) => d.id) },
  };
}

test("randomised: invariants, order independence and honest scenario totals (5000 carts)", () => {
  for (let seed = 1; seed <= 5000; seed++) {
    const inp = randomCase(seed);
    const res = price(inp); // price() itself checks sum/range invariants and throws on violation
    const ctx = `seed ${seed}`;
    assert.ok(res.totalCents >= 0 && res.totalCents <= res.subtotalCents, ctx);
    res.lines.forEach((l, i) => {
      assert.ok(l.lineCents <= inp.lines[i].listCents * inp.lines[i].qty, ctx);
      for (const o of l.offers) assert.ok(o.unitCents <= l.listCents, `${ctx}: an offer never raises a price`);
      if (inp.lines[i].offerScope === "targeted") {
        // A targeted line (a bundle) only gets offers that name it, in the line phase and the order phase.
        const named = (id: string) => { const d = inp.discounts.find((x) => x.id === id)!; return d.target.type === "products" && d.target.productIds.includes(l.productId); };
        for (const o of l.offers) assert.ok(named(o.discountId), `${ctx}: only offers naming the bundle are listed`);
        for (const a of l.allocations) assert.ok(named(a.discountId), `${ctx}: only offers naming the bundle take money off it`);
      }
    });
    // same result whatever order the offers come in
    const shuffled = price({ ...inp, discounts: [...inp.discounts].reverse() });
    assert.equal(shuffled.quote, res.quote, ctx);
    assert.equal(shuffled.totalCents, res.totalCents, ctx);
    // each scenario's advertised total is what you get when you pick it
    for (const s of res.scenarios) {
      const picked = price({ ...inp, selection: { ...inp.selection, scenario: s.key } });
      assert.equal(picked.totalCents, s.totalCents, `${ctx}: scenario ${s.key}`);
    }
    if (res.scenarios.length) assert.equal(res.scenarios.filter((s) => s.selected).length, 1, ctx);
    // each save-for-later choice's advertised total is what you get when you toggle it
    for (const c of res.choices) {
      const declined = new Set(inp.selection?.declined ?? []);
      if (c.declined) declined.delete(c.discountId); else declined.add(c.discountId);
      const toggled = price({ ...inp, selection: { ...inp.selection, declined: [...declined] } });
      assert.equal(toggled.totalCents, c.totalIfToggled, `${ctx}: choice ${c.label}`);
    }
  }
});

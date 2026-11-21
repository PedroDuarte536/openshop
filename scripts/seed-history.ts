// Demo only: fills the last 60 days with realistic orders so Insights has something to show.
//
//   (stop the API)  DB_PATH=./demo-data/db.sqlite node scripts/seed-history.ts  (start the API again)
//
// Run after scripts/seed-demo.py. Orders go through the real checkout code (pricing, limits, choices) with past
// timestamps, so every number in Insights is computed exactly as for real orders. Safe to re-run: it only runs once.

import { randomUUID } from "node:crypto";
import { SqliteDataStore, MongoDataStore } from "@openshop/db";
import { normalizeCode } from "@openshop/pricing";
import { openDb, type Product } from "../apps/api/src/types.ts";
import { createPricingService, priceItems } from "../apps/api/src/pricing-service.ts";
import { placeOrder, setOrderStatus, OrderError } from "../apps/api/src/orders.ts";
import { recordChoiceShown } from "../apps/api/src/insights.ts";
import { activeProfiles } from "../apps/api/src/accounts.ts";
import { getSettings, forgetSettings } from "../apps/api/src/settings.ts";

const store = process.env.MONGO_URL ? new MongoDataStore(process.env.MONGO_URL) : new SqliteDataStore(process.env.DB_PATH ?? "openshop.db");
const db = openDb(store);
const pricing = createPricingService(db);

// Seeded random numbers, so the demo looks the same every time.
let seed = 20260601;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
const FIRST = ["Ana", "Rui", "Lena", "Tom", "Inês", "Paul", "Mia", "Hugo", "Zoe", "Luca", "Nora", "Sam", "Eva", "Leo", "Ida", "Max", "Clara", "Omar", "Julia", "Theo"];
const LAST = ["Silva", "Becker", "Martin", "Rossi", "Nowak", "Santos", "Müller", "Dubois", "Costa", "Novak"];

async function main() {
  const settings = await getSettings(db);
  if (settings.migrations?.demoHistory) { console.log("Demo history already added."); return; }
  const products = (await db.products.find({ active: true })).filter((p) => p.stock > 0);
  if (!products.length) throw new Error("Run scripts/seed-demo.py first.");
  const originalStock = new Map(products.map((p) => [p.id, p.stock]));
  for (const p of products) await db.products.update(p.id, { stock: 10_000 });

  const dune = (await db.voucherCodes.find({})).filter((v) => v.id.startsWith("DUNE-") && v.usedCount === 0).map((v) => v.id);
  const vaseLovers = (await db.discounts.find({})).find((d) => d.name.startsWith("Vase lovers"));
  const vaseCategory = vaseLovers?.target.type === "categories" ? vaseLovers.target.categoryIds[0] : null;
  const vases = products.filter((p) => !!vaseCategory && p.categoryId === vaseCategory);
  const traders = (await db.customers.find({})).filter((c) => ["jonas.weber@example.com", "erik.lindqvist@example.com"].includes(c.email));
  const shoppers = Array.from({ length: 60 }, (_, i) => ({ name: `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`, email: `shopper${i + 1}@example.com`, address: `${10 + i} Demo Street, Lisboa` }));
  const mugs = products.filter((p) => ["Linen Mug", "Tall Latte Mug", "Night Market Mug", "Dune Espresso Cup", "Terracotta Tumbler"].includes(p.name));
  const DAY = 86_400_000, now = Date.now();
  let placed = 0, shownOnly = 0, failed = 0;
  const made: { id: string; at: number }[] = [];

  for (let daysAgo = 59; daysAgo >= 1; daysAgo--) {
    const weekend = new Date(now - daysAgo * DAY).getUTCDay() % 6 === 0;
    const count = 2 + Math.floor(rnd() * (weekend ? 7 : 5));
    for (let k = 0; k < count; k++) {
      const at = now - daysAgo * DAY + Math.floor((8 + rnd() * 14) * 3600_000) - 12 * 3600_000;
      // A cart: often a mug (on sale), plus one or two other pieces.
      const items = new Map<Product, number>();
      if (rnd() < 0.6) items.set(pick(mugs), 1 + Math.floor(rnd() * 2));
      if (vases.length && rnd() < 0.25) items.set(pick(vases), 1);
      for (let n = Math.floor(rnd() * 2) + (items.size ? 0 : 1); n > 0; n--) items.set(pick(products), 1);
      const lines = [...items].map(([p, qty]) => ({ productId: p.id, qty }));
      const trader = traders.length && rnd() < 0.08 ? pick(traders) : null;
      const who = trader ? { name: trader.name, email: trader.email, address: trader.address } : pick(shoppers);
      let account = null;
      if (trader) { const p = await activeProfiles(db, trader.id, at); account = { customer: trader, profileIds: p.ids, profileLabels: p.labels }; }
      const cartId = randomUUID();
      let codes: string[] = [], scenario: string | null = null;
      const r = rnd();
      if (!trader && r < 0.4) {
        codes = ["MARTA10"];
        // Marta's followers: many pick her code even when the automatic offers are cheaper.
        const q = await priceItems(db, pricing, { items: lines, codes, now: at });
        if (q.result.scenarios.length) {
          await recordChoiceShown(db, cartId, q.result, "MARTA10", at);
          if (rnd() < 0.22) { shownOnly++; continue; } // saw the choice, didn't order
          const codeIsWorse = q.result.scenarios.find((s) => s.key === "code")!.best === false;
          scenario = codeIsWorse ? (rnd() < 0.5 ? "code" : "automatic") : (rnd() < 0.1 ? "automatic" : "code");
        }
      } else if (!trader && r < 0.5 && dune.length) {
        codes = [dune.pop()!];
      } else if (!trader && r < 0.55) {
        codes = ["WELCOME10"];
        const q = await priceItems(db, pricing, { items: lines, codes, email: who.email, now: at });
        if (q.result.scenarios.length) {
          await recordChoiceShown(db, cartId, q.result, "WELCOME10", at);
          scenario = rnd() < 0.12 ? (q.result.scenarios.find((s) => !s.best)!.key) : null;
        }
      }
      // Some shoppers keep their "Vase lovers" budget for a later order.
      const hasVase = [...items.keys()].some((p) => !!vaseCategory && p.categoryId === vaseCategory);
      const declined = vaseLovers && (hasVase ? rnd() < 0.5 : rnd() < 0.1) ? [vaseLovers.id] : [];
      try {
        const o = await placeOrder(db, pricing, lines, who, { codes: codes.map((c) => normalizeCode(c)!), selection: { scenario, declined }, now: at, cartId, account });
        placed++;
        made.push({ id: o.id, at });
      } catch (e) { if (e instanceof OrderError) failed++; else throw e; }
    }
  }
  // Older orders are paid and shipped; a few were cancelled (which releases what they claimed).
  for (const o of made) {
    const age = (now - o.at) / DAY;
    if (rnd() < 0.04) await setOrderStatus(db, o.id, "cancelled");
    else if (age > 4) await setOrderStatus(db, o.id, "shipped");
    else if (age > 1) await setOrderStatus(db, o.id, "paid");
  }
  for (const [id, stock] of originalStock) await db.products.update(id, { stock });
  await db.settings.update("shop", { migrations: { ...(settings.migrations ?? {}), demoHistory: new Date().toISOString() } });
  forgetSettings(db);
  console.log(`Demo history: ${placed} orders over 59 days, ${shownOnly} shoppers who saw a code choice and left, ${failed} refused.`);
}

await main();
await store.close();

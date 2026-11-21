import { normalizeDiscount, type Discount, type DiscountData, type LineInput, type PriceInput, type Shopper } from "../src/index.ts";

export const NOW = Date.parse("2026-06-15T12:00:00Z");
let seq = 0;
/** Builds a stored offer through the real validator (UTC shop, started a day ago, never ends). */
export function offer(raw: Record<string, unknown>, extra: Partial<Discount> = {}): Discount {
  const data: DiscountData = normalizeDiscount({ name: "Offer", label: "Offer", schedule: { start: "2026-06-14T00:00" }, effect: { type: "percent", bp: 1000 }, ...raw }, { timezone: "UTC", now: NOW });
  return { id: extra.id ?? `d${String(++seq).padStart(3, "0")}`, usedCount: 0, ...data, ...extra };
}
export const guest: Shopper = { identityId: null, customerId: null, signedIn: false, profileIds: [] };
export const line = (productId: string, listCents: number, qty = 1, categoryId: string | null = null): LineInput => ({ productId, categoryId, listCents, qty });
export const input = (lines: LineInput[], discounts: Discount[], more: Partial<PriceInput> = {}): PriceInput => ({ now: NOW, lines, shopper: guest, discounts, ...more });

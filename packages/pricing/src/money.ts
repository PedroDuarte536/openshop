// Money is always integer cents; percentages are basis points (1% = 100 bp). No floats in price maths.

export type Cents = number;
export type Bp = number;

/** Catalogue prices are stored as decimal amounts (e.g. 24.5); this is the same rounding the order code uses. */
export const toCents = (amount: number): Cents => Math.round(amount * 100);
export const fromCents = (cents: Cents): number => cents / 100;
/** `bp` basis points of `cents`, rounded half up to a whole cent. */
export const percentOf = (cents: Cents, bp: Bp): Cents => Math.round((cents * bp) / 10000);
export const formatMoney = (cents: Cents, symbol = "€"): string => `${cents < 0 ? "-" : ""}${symbol}${(Math.abs(cents) / 100).toFixed(2)}`;

/**
 * Splits `total` across `weights` in proportion, in whole cents, so the parts always add up to `total` exactly
 * (largest remainder method; ties go to the earlier index). A part never exceeds its weight when total <= sum.
 */
export function allocate(total: Cents, weights: number[]): Cents[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (total <= 0 || sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const parts = raw.map((r) => Math.floor(r));
  let rest = total - parts.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, f: r - parts[i] })).filter((o) => weights[o.i] > 0).sort((a, b) => b.f - a.f || a.i - b.i);
  for (let k = 0; rest > 0 && order.length; k++, rest--) parts[order[k % order.length].i]++;
  return parts;
}

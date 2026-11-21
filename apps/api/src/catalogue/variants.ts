// Variants: separate products linked in a group. The owner ticks the properties that tell them apart
// ("differentiators"); the values are read from the products. On a product page every value found in the group is
// shown; a value links to the product that differs from the current one in that single property, otherwise it is
// disabled. A missing value counts as the value "-" (owner decision V-7). Pure functions, no I/O.
import type { AttributeDef, Product, VariantGroup } from "../types.ts";
import { canonValue, displayValue, isDeleted } from "./model.ts";
import { CONFIG } from "../config.ts";

export type Differentiator = VariantGroup["differentiators"][number];
export type Defs = Map<string, AttributeDef>;

export const MAX_DIFFERENTIATORS = CONFIG.catalogue.variants.maxDifferentiators;
export const MAX_MEMBERS = CONFIG.catalogue.variants.maxMembers;
export const GROUP_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

const SEP = "\u0001";
export const comboKey = (p: Product, diffs: Differentiator[], defs: Defs) => diffs.map((d) => canonValue(p.attributes?.[d.key], defs.get(d.key))).join(SEP);

/** Members in the owner's order (drag to reorder), then by name and id so the order is always the same. */
export const byPosition = (a: Product, b: Product) =>
  (a.variantPosition ?? Number.MAX_SAFE_INTEGER) - (b.variantPosition ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

export const valuesText = (p: Product, diffs: Differentiator[], defs: Defs) => diffs.map((d) => displayValue(p.attributes?.[d.key], defs.get(d.key))).join(" · ");

export function listNames(names: string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export interface Conflict { productId: string; name: string; withProductId: string; withName: string; values: string }

/** Pairs of non-deleted members with the same values for every differentiator (V-3). */
export function findDuplicates(members: Product[], diffs: Differentiator[], defs: Defs): Conflict[] {
  const seen = new Map<string, Product>(), out: Conflict[] = [];
  for (const p of [...members].filter((m) => !isDeleted(m)).sort(byPosition)) {
    const k = comboKey(p, diffs, defs), other = seen.get(k);
    // The values as the existing product spells them ("White", even if the newcomer says "white").
    if (other) out.push({ productId: p.id, name: p.name, withProductId: other.id, withName: other.name, values: valuesText(other, diffs, defs) });
    else seen.set(k, p);
  }
  return out;
}

export function duplicateMessage(c: Conflict, diffs: Differentiator[], defs: Defs): string {
  const labels = diffs.map((d) => defs.get(d.key)?.label ?? d.key);
  return `${c.name} has the same ${listNames(labels)} as ${c.withName} (${c.values}).`;
}

/** Differentiators with a single value across the visible members: they don't help shoppers choose. */
export function uselessDifferentiators(visible: Product[], diffs: Differentiator[], defs: Defs): string[] {
  if (visible.length < 2) return [];
  return diffs.filter((d) => new Set(visible.map((p) => canonValue(p.attributes?.[d.key], defs.get(d.key)))).size < 2).map((d) => d.key);
}

/**
 * Visible members that shoppers can't reach from the others by changing one property at a time: everything outside
 * the largest group of members connected by single-property changes.
 */
export function unreachable(visible: Product[], diffs: Differentiator[], defs: Defs): Product[] {
  const keys = visible.map((p) => diffs.map((d) => canonValue(p.attributes?.[d.key], defs.get(d.key))));
  const oneApart = (a: number, b: number) => keys[a].filter((v, i) => v !== keys[b][i]).length === 1;
  const comp = new Array<number>(visible.length).fill(-1);
  let n = 0;
  for (let s = 0; s < visible.length; s++) {
    if (comp[s] !== -1) continue;
    const queue = [s]; comp[s] = n;
    while (queue.length) { const a = queue.shift()!; for (let b = 0; b < visible.length; b++) if (comp[b] === -1 && oneApart(a, b)) { comp[b] = n; queue.push(b); } }
    n++;
  }
  if (n <= 1) return [];
  const sizes = new Array<number>(n).fill(0);
  comp.forEach((c) => sizes[c]++);
  const main = sizes.indexOf(Math.max(...sizes));
  return visible.filter((_, i) => comp[i] !== main);
}

export interface Badge { label: string; state: "selected" | "link" | "disabled"; productId?: string; soldOut?: boolean; swatch?: string | null }
export interface SelectorLine { key: string; label: string; badges: Badge[] }

/** Natural order for "sorted": numbers numerically, yes before no, text with numbers in text compared as numbers. */
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
function naturalCompare(a: string, b: string): number {
  if (a === "-" || b === "-") return a === b ? 0 : a === "-" ? 1 : -1;
  if (a.startsWith("n:") && b.startsWith("n:")) return Number(a.slice(2)) - Number(b.slice(2));
  if (a.startsWith("b:") && b.startsWith("b:")) return b.localeCompare(a);
  return collator.compare(a.slice(2), b.slice(2));
}

/**
 * The variant selector for `current` (plan §2.8.4): one line per differentiator, one badge per value found among the
 * visible members. A badge links to the member with that value and all the other values of `current`; when there is
 * none it is disabled. Hidden and deleted members are not passed in, so their values never appear (C22).
 */
export function variantSelector(current: Product, visible: Product[], diffs: Differentiator[], defs: Defs, available: (p: Product) => number, orderFrom: Product[] = visible): SelectorLine[] {
  const members = [...visible].sort(byPosition);
  // "As in the products": the order of first appearance over every member, hidden ones included, so values don't
  // move when a product is hidden. Only values of visible products are shown. "-" is always last.
  const ordered = [...orderFrom].sort(byPosition);
  const canon = (p: Product, key: string) => canonValue(p.attributes?.[key], defs.get(key));
  const byCombo = new Map<string, Product>();
  for (const m of members) { const k = comboKey(m, diffs, defs); if (!byCombo.has(k)) byCombo.set(k, m); }
  const mine = diffs.map((d) => canon(current, d.key));
  return diffs.map((d, i) => {
    const def = defs.get(d.key);
    const labelOf = new Map<string, string>();
    for (const m of members) {
      const v = canon(m, d.key);
      if (!labelOf.has(v)) labelOf.set(v, displayValue(m.attributes?.[d.key], def));
    }
    const rank = new Map<string, number>();
    for (const m of ordered) { const v = canon(m, d.key); if (!rank.has(v)) rank.set(v, rank.size); }
    // "-" (no value) always comes last, whatever the order.
    const pos = (v: string) => (v === "-" ? Infinity : rank.get(v) ?? Number.MAX_SAFE_INTEGER);
    const values = [...labelOf.keys()].sort((a, b) => pos(a) - pos(b));
    if (d.order === "sorted") values.sort(naturalCompare);
    const badges: Badge[] = values.map((v) => {
      const label = labelOf.get(v)!;
      const swatch = def?.type === "choice" ? def.options?.find((o) => `c:${o.value}` === v)?.swatch ?? null : null;
      if (v === mine[i]) return { label, state: "selected", swatch };
      const target = byCombo.get(mine.map((x, j) => (j === i ? v : x)).join(SEP));
      if (!target) return { label, state: "disabled", swatch };
      return { label, state: "link", productId: target.id, soldOut: available(target) <= 0, swatch };
    });
    return { key: d.key, label: def?.label ?? d.key, badges };
  });
}

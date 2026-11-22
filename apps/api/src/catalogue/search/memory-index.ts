// The in-process search index (plan §2.5.2–2.5.4): built from a snapshot of the catalogue, one per view. The public
// view is built only from data shoppers may see, so hidden products and internal properties can't be matched, counted
// or suggested (C2). Pure: no I/O.
import type { AttrValue, AttributeDef, Category, Product } from "../../types.ts";
import { canonText, canonValue, displayValue, isDeleted, productType, toCents } from "../model.ts";
import { Dictionary, eligible, MAX_CORRECTED_WORDS } from "./fuzzy.ts";
import { fold, indexTokens, mixedRuns, queryWords } from "./text.ts";
import { CONFIG } from "../../config.ts";

export type View = "admin" | "public";

export const WEIGHTS = { sku: 10, name: 5, category: 2, attribute: 2, description: 1 } as const;
export const FACTOR = { exact: 1, prefix: 0.7, fuzzy: 0.4 } as const;
const MAX_PREFIX_EXPANSION = CONFIG.search.maxPrefixExpansion;
export const MAX_QUERY_WORDS = CONFIG.search.maxQueryWords;
/** Stock at or below this (and above 0) counts as "low" in the backoffice. */
export const LOW_STOCK = CONFIG.search.lowStock;

export interface Entry {
  id: string; ord: number; name: string; nameFold: string; skuFold: string | null;
  categoryId: string | null; priceCents: number; stock: number; available: number;
  active: boolean; deleted: boolean; type: "simple" | "bundle"; variantGroupId: string | null;
  hasImage: boolean; hasDescription: boolean; hasSku: boolean; createdAt: string; updatedAt: string;
  /** Property key -> canonical values (several for multiple choice). Only properties this view may filter by. */
  facets: Map<string, string[]>;
  /** Property key -> number, for range filters. */
  numbers: Map<string, number>;
  /** Position in name order (computed once, so sorting by name compares integers, not strings). */
  nameRank: number;
}

export type StockBand = "in" | "low" | "out";
export type Status = "visible" | "hidden" | "deleted";
export type SortKey = "relevance" | "name" | "-name" | "price" | "-price" | "newest" | "stock" | "-stock" | "updated" | "-updated";

export interface Query {
  q?: string;
  categories?: string[];            // ids; "none" = no category
  minCents?: number; maxCents?: number;
  stock?: StockBand[];
  status?: Status[];
  types?: ("simple" | "bundle")[];
  missing?: ("image" | "sku" | "category" | "description")[];
  attrs?: Record<string, { values?: string[]; min?: number; max?: number }>;
  variantGroup?: string;
  inVariantGroup?: boolean;
  ids?: string[];
  sort?: SortKey;
  skip?: number; limit?: number;
  facets?: boolean;
  /** The price to filter and sort by (the shopper's own price in the shop's JSON search). Defaults to the list price. */
  priceOf?: (id: string) => number;
}

export interface FacetCounts {
  categories: { id: string | null; count: number }[];
  price: { min: number; max: number } | null;
  stock: Record<StockBand, number>;
  status: Record<Status, number>;
  types: { simple: number; bundle: number };
  /** Products in a variant group. */
  variants: number;
  missing: { image: number; sku: number; category: number; description: number };
  attributes: { key: string; values: { value: string; count: number }[]; range?: { min: number; max: number } }[];
}

export interface Result {
  ids: string[]; total: number; facets?: FacetCounts;
  /** The query with corrected words, when the results exist only thanks to typo corrections (C-12). */
  corrected: string | null;
  scores: Map<string, number>;
}

export interface Snapshot {
  products: Product[]; categories: Category[]; defs: AttributeDef[];
  /** Sellable quantity per product (bundles: derived from their components). */
  available: Map<string, number>;
}

/** Property values shoppers (or the owner) can search for, as text. */
function attrText(v: AttrValue, d: AttributeDef): string { return displayValue(v, d); }

/** Work shared by the two views of one snapshot. */
export interface BuildShared { tokens: Map<string, string[]>; common: Map<string, Map<string, number>>; rank: Map<string, number> | null }
export const newShared = (): BuildShared => ({ tokens: new Map(), common: new Map(), rank: null });
// Most products have no filterable properties: they share these empty maps (never written to).
const NO_FACETS: Map<string, string[]> = new Map();
const NO_NUMBERS: Map<string, number> = new Map();

const bandOf = (n: number): StockBand => (n <= 0 ? "out" : n <= LOW_STOCK ? "low" : "in");

export class SearchIndex {
  readonly view: View;
  readonly entries: Entry[] = [];
  private byId = new Map<string, Entry>();
  /** Token -> the entries that contain it (ordinals) and the weight of the fields it appears in. */
  private postings = new Map<string, { ords: number[]; ws: number[] }>();
  private sortedTokens: string[] = [];
  private dict: Dictionary;
  readonly defs: Map<string, AttributeDef>;
  readonly builtAt = Date.now();
  /** Property key -> canonical value -> how it reads (the first spelling found, for free text). */
  private labels = new Map<string, Map<string, string>>();

  /** `shared`: work both views of a snapshot have in common (tokens of the text fields, name order), done once. */
  constructor(view: View, snap: Snapshot, shared: BuildShared = newShared()) {
    this.view = view;
    const pub = view === "public";
    const defs = snap.defs.filter((d) => !pub || d.visibility === "public");
    this.defs = new Map(defs.map((d) => [d.key, d]));
    const facetKeys = defs.filter((d) => !pub || d.filterable).map((d) => d.key);
    const searchKeys = new Set(defs.filter((d) => !pub || d.searchable).map((d) => d.key));
    const cats = new Map(snap.categories.map((c) => [c.id, c.name]));
    const df = new Map<string, number>();

    for (const p of snap.products) {
      const deleted = isDeleted(p);
      const available = snap.available.get(p.id) ?? p.stock ?? 0;
      // The public view holds only what a shopper could open: visible, not deleted.
      if (pub && (!p.active || deleted)) continue;
      const e: Entry = {
        id: p.id, ord: this.entries.length, name: p.name, nameFold: fold(p.name), skuFold: !pub && p.sku ? fold(p.sku) : null,
        categoryId: p.categoryId ?? null, priceCents: toCents(p.price), stock: p.stock ?? 0, available,
        active: !!p.active, deleted, type: productType(p), variantGroupId: p.variantGroupId ?? null,
        hasImage: !!p.images?.length, hasDescription: !!p.description?.trim(), hasSku: !!p.sku,
        createdAt: p.createdAt ?? "", updatedAt: p.updatedAt ?? p.createdAt ?? "", facets: NO_FACETS, numbers: NO_NUMBERS, nameRank: 0,
      };
      if (p.attributes) for (const k of facetKeys) {
        const v = p.attributes[k];
        if (v === undefined) continue;
        const d = this.defs.get(k)!;
        let labels = this.labels.get(k);
        if (!labels) { labels = new Map(); this.labels.set(k, labels); }
        if (e.facets === NO_FACETS) e.facets = new Map();
        if (Array.isArray(v)) {
          e.facets.set(k, v.map((x) => `c:${x}`));
          for (const x of v) if (!labels.has(`c:${x}`)) labels.set(`c:${x}`, d.options?.find((o) => o.value === x)?.label ?? x);
        } else {
          const c = canonValue(v, d);
          e.facets.set(k, [c]);
          if (!labels.has(c)) labels.set(c, displayValue(v, d));
        }
        if (typeof v === "number") { if (e.numbers === NO_NUMBERS) e.numbers = new Map(); e.numbers.set(k, v); }
      }
      this.entries.push(e);
      this.byId.set(e.id, e);

      const tokens = (text: string) => {
        let toks = shared.tokens.get(text);
        if (!toks) { toks = [...new Set(indexTokens(text))]; shared.tokens.set(text, toks); }
        return toks;
      };
      // Name, category and description: the same in both views, so their weights are computed once per product.
      let common = shared.common.get(p.id);
      if (!common) {
        common = new Map();
        const add = (text: string | null | undefined, w: number) => { if (text) for (const t of tokens(text)) common!.set(t, (common!.get(t) ?? 0) + w); };
        add(p.name, WEIGHTS.name);
        add(p.categoryId ? cats.get(p.categoryId) : null, WEIGHTS.category);
        add(p.description, WEIGHTS.description);
        shared.common.set(p.id, common);
      }
      // What only this view searches: the SKU (backoffice) and the properties it may search.
      let extra: Map<string, number> | null = null;
      const addExtra = (text: string, w: number) => { extra ??= new Map(); for (const t of tokens(text)) extra.set(t, (extra.get(t) ?? 0) + w); };
      if (!pub && p.sku) { addExtra(p.sku, WEIGHTS.sku); const f = fold(p.sku); extra = extra ?? new Map(); extra.set(f, (extra.get(f) ?? 0) + WEIGHTS.sku); }
      if (p.attributes) for (const [k, v] of Object.entries(p.attributes)) {
        const d = this.defs.get(k);
        if (d && searchKeys.has(k)) addExtra(attrText(v, d), WEIGHTS.attribute);
      }
      const post = (t: string, w: number) => {
        let m = this.postings.get(t);
        if (!m) { m = { ords: [], ws: [] }; this.postings.set(t, m); }
        m.ords.push(e.ord); m.ws.push(w);
      };
      const x: Map<string, number> | null = extra;
      for (const [t, w] of common) post(t, w + (x?.get(t) ?? 0));
      if (x) for (const [t, w] of x) if (!common.has(t)) post(t, w);
    }
    for (const [t, m] of this.postings) df.set(t, m.ords.length);
    this.sortedTokens = [...this.postings.keys()].sort();
    // Name order: computed once for the whole snapshot, used by both views.
    if (!shared.rank) {
      const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });
      const names = snap.products.map((q) => ({ id: q.id, key: fold(q.name) }));
      names.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : collator.compare(a.key, b.key)) || (a.id < b.id ? -1 : 1));
      shared.rank = new Map(names.map((n, i) => [n.id, i]));
    }
    for (const e of this.entries) e.nameRank = shared.rank.get(e.id) ?? 0;
    this.dict = new Dictionary(df);
  }

  get(id: string): Entry | undefined { return this.byId.get(id); }
  valueLabel(key: string, canon: string): string { return this.labels.get(key)?.get(canon) ?? (canon === "-" ? "-" : canon.slice(2)); }
  get size() { return this.entries.length; }

  /** Tokens starting with `prefix` (binary search over the sorted token list), capped. */
  private prefixTokens(prefix: string): string[] {
    const t = this.sortedTokens;
    let lo = 0, hi = t.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (t[mid] < prefix) lo = mid + 1; else hi = mid; }
    const out: string[] = [];
    for (let i = lo; i < t.length && t[i].startsWith(prefix) && out.length < MAX_PREFIX_EXPANSION; i++) if (t[i] !== prefix) out.push(t[i]);
    return out;
  }

  /** Text match: every word must match (exact, prefix, or one typo away). Returns scores by entry, or null for "no query". */
  private match(q: string | undefined): { scores: Map<number, number> | null; corrected: string | null } {
    // "350ml" with no product saying "350ml" (or a word starting so): look for "350" and "ml" instead, so it finds "350 ml".
    const words = queryWords(q ?? "").flatMap((w) => { const runs = mixedRuns(w); return runs && !this.postings.has(w) && !this.prefixTokens(w).length ? runs : [w]; }).slice(0, MAX_QUERY_WORDS);
    if (!words.length) return { scores: null, corrected: null };
    let scores: Map<number, number> | null = null;
    let correctedWords = 0;
    const shown: string[] = [];
    words.forEach((w, i) => {
      const perDoc = new Map<number, number>();
      const take = (token: string, factor: number) => {
        const m = this.postings.get(token);
        if (!m) return;
        for (let k = 0; k < m.ords.length; k++) { const ord = m.ords[k], w = m.ws[k] * factor; const cur = perDoc.get(ord); if (cur === undefined || w > cur) perDoc.set(ord, w); }
      };
      const exact = this.postings.has(w);
      if (exact) take(w, FACTOR.exact);
      const isLast = i === words.length - 1;
      const prefixes = isLast || [...w].length >= 3 ? this.prefixTokens(w) : [];
      for (const t of prefixes) take(t, FACTOR.prefix);
      let shownWord = w;
      if (!exact && !prefixes.length && correctedWords < MAX_CORRECTED_WORDS && eligible(w)) {
        const cands = this.dict.candidates(w);
        if (cands.length) { correctedWords++; shownWord = cands[0]; for (const c of cands) take(c, FACTOR.fuzzy); }
      }
      shown.push(shownWord);
      if (scores === null) scores = perDoc;
      else { const next = new Map<number, number>(); for (const [ord, s] of scores) { const add = perDoc.get(ord); if (add !== undefined) next.set(ord, s + add); } scores = next; }
    });
    const result: Map<number, number> = scores ?? new Map();
    const phrase = fold((q ?? "").trim());
    for (const [ord, s] of result) {
      const e = this.entries[ord];
      if (phrase && e.nameFold.startsWith(phrase)) result.set(ord, s + 2);
      if (e.skuFold && e.skuFold === phrase) result.set(ord, s + 100);
    }
    return { scores: result, corrected: correctedWords && result.size ? shown.join(" ") : null };
  }

  /** Which filters an entry fails (by dimension name); stops after two, which is all the facet counts need. */
  private failures(e: Entry, q: Query, price: (e: Entry) => number, idSet: Set<string> | null): string[] {
    const out: string[] = [];
    const fail = (dim: string) => { out.push(dim); return out.length > 1; };
    if (idSet && !idSet.has(e.id) && fail("ids")) return out;
    if (q.status?.length && !q.status.includes(e.deleted ? "deleted" : e.active ? "visible" : "hidden") && fail("status")) return out;
    if (q.categories?.length && !q.categories.includes(e.categoryId ?? "none") && fail("category")) return out;
    if (q.minCents !== undefined || q.maxCents !== undefined) {
      const p = price(e);
      if (((q.minCents !== undefined && p < q.minCents) || (q.maxCents !== undefined && p > q.maxCents)) && fail("price")) return out;
    }
    if (q.stock?.length && !q.stock.includes(bandOf(e.available)) && fail("stock")) return out;
    if (q.types?.length && !q.types.includes(e.type) && fail("type")) return out;
    if (q.missing?.length) {
      const miss = q.missing.some((m) => (m === "image" ? !e.hasImage : m === "sku" ? !e.hasSku : m === "category" ? !e.categoryId : !e.hasDescription));
      if (!miss && fail("missing")) return out;
    }
    if (q.variantGroup !== undefined && e.variantGroupId !== q.variantGroup && fail("variant")) return out;
    if (q.inVariantGroup !== undefined && !!e.variantGroupId !== q.inVariantGroup && fail("variant")) return out;
    for (const [k, f] of Object.entries(q.attrs ?? {})) {
      let ok = true;
      if (f.values?.length) { const vs = e.facets.get(k) ?? ["-"]; ok = f.values.some((v) => vs.includes(v)); }
      if (ok && (f.min !== undefined || f.max !== undefined)) { const n = e.numbers.get(k); ok = n !== undefined && (f.min === undefined || n >= f.min) && (f.max === undefined || n <= f.max); }
      if (!ok && fail(`attr:${k}`)) return out;
    }
    return out;
  }

  query(q: Query): Result {
    const { scores, corrected } = this.match(q.q);
    const price = (e: Entry) => (q.priceOf ? q.priceOf(e.id) : e.priceCents);
    const idSet = q.ids ? new Set(q.ids) : null;
    const candidates = scores ? [...scores.keys()].map((o) => this.entries[o]) : this.entries;
    const hits: Entry[] = [];
    const near: { e: Entry; dim: string }[] = [];
    for (const e of candidates) {
      const f = this.failures(e, q, price, idSet);
      if (!f.length) hits.push(e); else if (f.length === 1) near.push({ e, dim: f[0] });
    }
    const sort = q.sort ?? (scores ? "relevance" : "name");
    // Scores by ordinal in a typed array: sorting compares numbers instead of looking up a Map.
    const sc = new Float64Array(scores ? this.entries.length : 0);
    if (scores) for (const [ord, v] of scores) sc[ord] = v;
    const byName = (a: Entry, b: Entry) => a.nameRank - b.nameRank;
    const score = (e: Entry) => (scores ? sc[e.ord] : 0);
    const cmp: Record<SortKey, (a: Entry, b: Entry) => number> = {
      relevance: (a, b) => score(b) - score(a) || Number(b.available > 0) - Number(a.available > 0) || byName(a, b),
      name: byName, "-name": (a, b) => byName(b, a),
      price: (a, b) => price(a) - price(b) || a.priceCents - b.priceCents || byName(a, b),
      "-price": (a, b) => price(b) - price(a) || b.priceCents - a.priceCents || byName(a, b),
      newest: (a, b) => b.createdAt.localeCompare(a.createdAt) || byName(a, b),
      stock: (a, b) => a.available - b.available || byName(a, b), "-stock": (a, b) => b.available - a.available || byName(a, b),
      updated: (a, b) => a.updatedAt.localeCompare(b.updatedAt) || byName(a, b), "-updated": (a, b) => b.updatedAt.localeCompare(a.updatedAt) || byName(a, b),
    };
    hits.sort(cmp[sort] ?? byName);
    const skip = Math.max(0, q.skip ?? 0), limit = Math.max(0, q.limit ?? 50);
    const scoreMap = new Map<string, number>();
    if (scores) for (const e of hits) scoreMap.set(e.id, score(e));
    const out: Result = { ids: hits.slice(skip, skip + limit).map((e) => e.id), total: hits.length, corrected, scores: scoreMap };
    if (q.facets !== false) out.facets = this.facets(hits, near, price);
    return out;
  }

  /**
   * Disjunctive counts: each dimension counts the entries that pass every other filter. One pass: an entry that
   * passes everything counts in every dimension; one that fails a single filter counts only in that filter's dimension.
   */
  private facets(hits: Entry[], near: { e: Entry; dim: string }[], price: (e: Entry) => number): FacetCounts {
    const cats = new Map<string, number>();
    const stock: Record<StockBand, number> = { in: 0, low: 0, out: 0 };
    const status: Record<Status, number> = { visible: 0, hidden: 0, deleted: 0 };
    const types = { simple: 0, bundle: 0 };
    let variants = 0;
    const missing = { image: 0, sku: 0, category: 0, description: 0 };
    let pmin = Infinity, pmax = -Infinity;
    const attrCounts = new Map<string, Map<string, number>>();
    const attrRange = new Map<string, { min: number; max: number }>();
    const keys = [...this.defs.values()].filter((d) => this.view !== "public" || d.filterable).map((d) => d.key);
    for (const k of keys) attrCounts.set(k, new Map());
    const attr = (e: Entry, k: string) => {
      const vs = e.facets.get(k);
      if (vs) { const m = attrCounts.get(k)!; for (const v of vs) m.set(v, (m.get(v) ?? 0) + 1); }
      const n = e.numbers.get(k);
      if (n !== undefined) { const r = attrRange.get(k); if (!r) attrRange.set(k, { min: n, max: n }); else { if (n < r.min) r.min = n; if (n > r.max) r.max = n; } }
    };
    const dims: Record<string, (e: Entry) => void> = {
      category: (e) => { const c = e.categoryId ?? "none"; cats.set(c, (cats.get(c) ?? 0) + 1); },
      price: (e) => { const p = price(e); if (p < pmin) pmin = p; if (p > pmax) pmax = p; },
      stock: (e) => { stock[bandOf(e.available)]++; },
      status: (e) => { status[e.deleted ? "deleted" : e.active ? "visible" : "hidden"]++; },
      type: (e) => { types[e.type]++; },
      variant: (e) => { if (e.variantGroupId) variants++; },
      missing: (e) => { if (!e.hasImage) missing.image++; if (!e.hasSku) missing.sku++; if (!e.categoryId) missing.category++; if (!e.hasDescription) missing.description++; },
    };
    const every = Object.values(dims);
    const keySet = new Set(keys);
    for (const e of hits) {
      for (const f of every) f(e);
      // Only the properties this entry has (usually a few), not every property of the shop.
      for (const k of e.facets.keys()) if (keySet.has(k)) attr(e, k);
      for (const k of e.numbers.keys()) if (keySet.has(k) && !e.facets.has(k)) attr(e, k);
    }
    for (const { e, dim } of near) {
      if (dim.startsWith("attr:")) { const k = dim.slice(5); if (keySet.has(k)) attr(e, k); }
      else dims[dim]?.(e);
    }
    const attributes: FacetCounts["attributes"] = [];
    for (const k of keys) {
      const m = attrCounts.get(k)!;
      if (!m.size) continue;
      const range = attrRange.get(k);
      attributes.push({ key: k, values: [...m].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1)), ...(range ? { range } : {}) });
    }
    return {
      categories: [...cats].map(([id, c]) => ({ id: id === "none" ? null : id, count: c })),
      price: pmin === Infinity ? null : { min: pmin, max: pmax },
      stock, status, types, variants, missing, attributes,
    };
  }
}

/** URL value for a canonical facet value ("c:blue" -> "blue", "b:1" -> "yes", "t:linen" -> "linen", "n:10" -> "10"). */
export function urlValue(canon: string): string {
  if (canon === "-") return "-";
  if (canon.startsWith("b:")) return canon === "b:1" ? "yes" : "no";
  return canon.slice(2);
}
/** Canonical value for a URL value of property `d`. */
export function canonFromUrl(v: string, d: AttributeDef): string {
  if (v === "-") return "-";
  switch (d.type) {
    case "choice": case "multi": return `c:${v}`;
    case "boolean": return v === "yes" || v === "true" || v === "1" ? "b:1" : "b:0";
    case "number": return `n:${Number(v)}`;
    default: return `t:${canonText(v)}`;
  }
}

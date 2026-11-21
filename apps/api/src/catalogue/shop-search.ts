// Shop search, category and "all products" pages (plan §2.5.6): text search, filters with counts, sorting and paging,
// rendered by the page builder's widgets and working without JavaScript.
//
// Owner decision S-2a: pages are rendered with LIST prices (they contain nothing personal and may be cached). When a
// visitor sorts or filters by price, the storefront script asks /api/shop/search (private, never cached) for the
// order by their own prices and replaces the results. The HTML never carries discount data.
import type { ProductCard, SearchFacet, SearchState } from "@openshop/renderer";
import type { AttributeDef, Db, Product } from "../types.ts";
import { catalogueVersion } from "./meta.ts";
import { searchFor } from "./search/service.ts";
import { parsePublicQuery, type Params, type PublicQuery } from "./search/params.ts";
import { canonFromUrl, urlValue, type Result } from "./search/memory-index.ts";
import { shopperPricing, visitorPrices, type PricingService } from "../pricing-service.ts";
import type { Cart } from "../types.ts";
import type { Account } from "../accounts.ts";
import { CONFIG } from "../config.ts";

export const SHOP_SORTS = [
  { value: "relevance", label: "Best match" }, { value: "name", label: "Name" },
  { value: "price", label: "Price, low to high" }, { value: "-price", label: "Price, high to low" }, { value: "newest", label: "Newest" },
];

const fmtMoney = (cents: number) => (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2));
export const toCardOf = (p: Product, available: number): ProductCard => ({ id: p.id, name: p.name, price: p.price, image: p.images?.[0], href: `/shop/product/${p.id}`, ...(available <= 0 ? { soldOut: true } : {}) });

/** The current search as ordered [name, value] pairs (one canonical order, so links and caches line up). */
interface Current { q: string; categories: string[]; min: string; max: string; stock: boolean; attrs: [string, string[]][]; sort: string; page: number }

function currentOf(pq: PublicQuery, params: Params, defs: Map<string, AttributeDef>): Current {
  const attrs: [string, string[]][] = [];
  for (const [key, f] of Object.entries(pq.attrs ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (f.values?.length) attrs.push([key, f.values.map(urlValue)]);
    else if (defs.get(key)?.type === "number") attrs.push([key, [`${f.min ?? ""}..${f.max ?? ""}`]]);
  }
  return {
    q: pq.q ?? "", categories: pq.categorySlugs, min: pq.minCents !== undefined ? fmtMoney(pq.minCents) : "", max: pq.maxCents !== undefined ? fmtMoney(pq.maxCents) : "",
    stock: !!pq.stock?.length, attrs, sort: typeof params.sort === "string" && pq.sort ? pq.sort : "", page: pq.page,
  };
}

function pairs(c: Current, withCategories: boolean): [string, string][] {
  const out: [string, string][] = [];
  if (c.q) out.push(["q", c.q]);
  if (withCategories && c.categories.length) out.push(["category", c.categories.join(",")]);
  if (c.min) out.push(["min", c.min]);
  if (c.max) out.push(["max", c.max]);
  if (c.stock) out.push(["stock", "in"]);
  for (const [k, vs] of c.attrs) if (vs.length) out.push([`f.${k}`, vs.join(",")]);
  if (c.sort) out.push(["sort", c.sort]);
  if (c.page > 1) out.push(["page", String(c.page)]);
  return out;
}
const href = (path: string, p: [string, string][]) => (p.length ? `${path}?${new URLSearchParams(p).toString()}` : path);

export interface ShopPageOptions {
  path: string;
  /** Category pages: the category is fixed (not a filter). */
  categoryId?: string | null;
  /** The search page without words or filters shows no results (only the filters). */
  emptyWithoutQuery?: boolean;
}

export async function shopSearchPage(db: Db, params: Params, o: ShopPageOptions) {
  const search = searchFor(db);
  const index = await search.index("public");
  const snap = await search.snapshot();
  const pq = parsePublicQuery(params, index.defs);
  const onSearch = o.categoryId === undefined;
  const catBySlug = new Map(snap.categories.map((c) => [c.slug, c]));
  const categoryIds = o.categoryId ? [o.categoryId] : pq.categorySlugs.map((s) => catBySlug.get(s)?.id).filter((x): x is string => !!x);
  const hasFilters = !!(pq.categorySlugs.length || pq.minCents !== undefined || pq.maxCents !== undefined || pq.stock?.length || Object.keys(pq.attrs ?? {}).length);
  const query = { ...pq, categories: o.categoryId || pq.categorySlugs.length ? (categoryIds.length ? categoryIds : ["__none__"]) : [] };
  const r: Result = index.query(query);
  const none = o.emptyWithoutQuery && !pq.q && !hasFilters;
  const docs = none ? [] : await search.hydrate(r.ids, "public");
  const results = docs.map((p) => toCardOf(p, snap.available.get(p.id) ?? p.stock));
  const total = none ? 0 : r.total;
  const pages = Math.max(1, Math.ceil(total / pq.per));
  const cur = currentOf(pq, params, index.defs);
  const link = (mut: (c: Current) => void) => { const c: Current = structuredClone(cur); c.page = 1; mut(c); return href(o.path, pairs(c, onSearch)); };
  const f = r.facets!;

  const facets: SearchFacet[] = [];
  if (onSearch) {
    facets.push({
      key: "category", label: "Category", param: "category",
      options: f.categories.filter((c) => c.id).map((c) => { const cat = snap.categories.find((x) => x.id === c.id)!; return { value: cat.slug, label: cat.name, count: c.count, selected: cur.categories.includes(cat.slug) }; })
        .sort((a, b) => a.label.localeCompare(b.label)),
    });
  }
  for (const a of f.attributes) {
    const d = index.defs.get(a.key)!;
    const selected = new Set(cur.attrs.find(([k]) => k === a.key)?.[1] ?? []);
    const pos = (v: string) => d.options?.find((o) => `c:${o.value}` === v)?.position ?? Number.MAX_SAFE_INTEGER;
    const opts = a.values.map((v) => ({ value: urlValue(v.value), label: index.valueLabel(a.key, v.value), count: v.count, selected: selected.has(urlValue(v.value)), ...(d.type === "choice" || d.type === "multi" ? { swatch: d.options?.find((o) => `c:${o.value}` === v.value)?.swatch ?? null } : {}), _k: v.value }));
    if (d.type === "choice" || d.type === "multi") opts.sort((x, y) => pos(x._k) - pos(y._k));
    else if (d.type === "number") opts.sort((x, y) => Number(x.value) - Number(y.value));
    facets.push({ key: a.key, label: d.label, param: `f.${a.key}`, options: opts.map(({ _k, ...o }) => o) });
  }

  const chips: SearchState["chips"] = [];
  for (const s of cur.categories) chips.push({ label: catBySlug.get(s)?.name ?? s, href: link((c) => { c.categories = c.categories.filter((x) => x !== s); }) });
  for (const [key, vs] of cur.attrs) {
    const d = index.defs.get(key)!;
    for (const v of vs) {
      const label = v.includes("..") ? `${d.label}: ${v.replace("..", " – ")}` : `${d.type === "boolean" ? `${d.label}: ` : ""}${index.valueLabel(key, canonFromUrl(v, d))}`;
      chips.push({ label, href: link((c) => { c.attrs = c.attrs.map(([k, xs]) => [k, k === key ? xs.filter((x) => x !== v) : xs] as [string, string[]]); }) });
    }
  }
  if (cur.min || cur.max) chips.push({ label: cur.min && cur.max ? `€${cur.min} – €${cur.max}` : cur.min ? `From €${cur.min}` : `Up to €${cur.max}`, href: link((c) => { c.min = ""; c.max = ""; }) });
  if (cur.stock) chips.push({ label: "In stock", href: link((c) => { c.stock = false; }) });

  const pageHref = (n: number) => { const c: Current = structuredClone(cur); c.page = n; return href(o.path, pairs(c, onSearch)); };
  const window: number[] = [];
  for (let n = Math.max(1, pq.page - 2); n <= Math.min(pages, pq.page + 2); n++) window.push(n);
  if (!window.includes(1)) window.unshift(1);
  if (!window.includes(pages)) window.push(pages);
  const priceDependent = cur.sort === "price" || cur.sort === "-price" || !!cur.min || !!cur.max;
  const state: SearchState = {
    path: o.path, keep: pairs({ ...cur, categories: [], min: "", max: "", stock: false, attrs: [], page: 1 }, false),
    total, page: pq.page, pages, sort: cur.sort || (cur.q ? "relevance" : "name"), sorts: SHOP_SORTS.filter((s) => s.value !== "relevance" || cur.q),
    facets, price: { min: pq.minCents !== undefined ? pq.minCents / 100 : null, max: pq.maxCents !== undefined ? pq.maxCents / 100 : null, bounds: f.price ? { min: f.price.min / 100, max: f.price.max / 100 } : null },
    inStock: { selected: cur.stock, count: f.stock.in + f.stock.low }, chips,
    clearHref: href(o.path, cur.q ? [["q", cur.q]] : []),
    pageLinks: none ? [] : window.map((n) => ({ n, href: pageHref(n), current: n === pq.page })),
    prevHref: pq.page > 1 ? pageHref(pq.page - 1) : null, nextHref: pq.page < pages ? pageHref(pq.page + 1) : null,
    corrected: none ? null : r.corrected,
    personal: priceDependent && !none ? new URLSearchParams(pairs(cur, onSearch).concat(o.categoryId ? [["categoryId", o.categoryId]] : [])).toString() : null,
  };
  const indexable = !hasFilters && !cur.sort && pq.page === 1;
  return {
    results, search: state, query: pq.q ?? "",
    meta: { noindex: !indexable, canonical: href(o.path, onSearch && cur.q ? [["q", cur.q]] : []) },
    /** Words that matched nothing at all (no filters involved): counted in the "no results" report. */
    miss: !!pq.q && !hasFilters && pq.page === 1 && !none && total === 0,
  };
}

/**
 * The JSON search used by the storefront script (S-2a): the same parameters, but "price" means the visitor's own
 * price (their offers, customer prices and cart code). Only called for price sorting and filtering.
 */
export async function shopSearchJson(db: Db, pricing: PricingService, params: Params, visitor: { cart: Cart | null; account: Account | null }) {
  const search = searchFor(db);
  const index = await search.index("public");
  const snap = await search.snapshot();
  const pq = parsePublicQuery(params, index.defs);
  const catBySlug = new Map(snap.categories.map((c) => [c.slug, c]));
  const fixed = typeof params.categoryId === "string" && snap.categories.some((c) => c.id === params.categoryId) ? params.categoryId : null;
  const categories = fixed ? [fixed] : pq.categorySlugs.length ? pq.categorySlugs.map((s) => catBySlug.get(s)?.id ?? "__none__") : [];
  const personal = pq.sort === "price" || pq.sort === "-price" || pq.minCents !== undefined || pq.maxCents !== undefined;
  let priceOf: ((id: string) => number) | undefined;
  if (personal) {
    // Price only the products that pass the other filters (the price filter can't be applied before knowing prices).
    const base = index.query({ ...pq, categories, minCents: undefined, maxCents: undefined, sort: "name", skip: 0, limit: 1_000_000, facets: false });
    const byId = new Map(snap.products.map((p) => [p.id, p]));
    const sp = await shopperPricing(db, pricing, visitor.cart, visitor.account);
    const prices = visitorPrices(sp, base.ids.map((id) => byId.get(id)!).filter(Boolean), await catalogueVersion(db));
    priceOf = (id) => prices.get(id) ?? index.get(id)?.priceCents ?? 0;
  }
  const r = index.query({ ...pq, categories, priceOf, facets: false });
  const docs = await search.hydrate(r.ids, "public");
  return {
    personal,
    body: {
      items: docs.map((p) => ({ ...toCardOf(p, snap.available.get(p.id) ?? p.stock), listCents: Math.round(p.price * 100), priceCents: priceOf ? priceOf(p.id) : Math.round(p.price * 100) })),
      total: r.total, page: pq.page, pages: Math.max(1, Math.ceil(r.total / pq.per)), corrected: r.corrected,
    },
  };
}


/**
 * Suggestions while typing (story C-10): up to 6 products and the 3 categories with the most matches, from the public
 * index only (C2: hidden products and internal properties never match). No prices: the same answer for everyone.
 */
export async function shopSuggest(db: Db, raw: unknown) {
  const q = (typeof raw === "string" ? raw : "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, CONFIG.search.suggest.maxQueryLength);
  if ([...q].length < CONFIG.search.suggest.minQueryLength) return { q, products: [], categories: [], corrected: null };
  const search = searchFor(db);
  const index = await search.index("public");
  const snap = await search.snapshot();
  const r = index.query({ q, sort: "relevance", limit: CONFIG.search.suggest.products });
  const docs = await search.hydrate(r.ids, "public");
  const cats = new Map(snap.categories.map((c) => [c.id, c]));
  return {
    q, corrected: r.corrected,
    products: docs.map((p) => ({ name: p.name, href: `/shop/product/${p.id}`, ...(p.images?.[0] ? { image: p.images[0] } : {}) })),
    categories: (r.facets?.categories ?? []).filter((c) => c.id && cats.has(c.id)).sort((a, b) => b.count - a.count).slice(0, CONFIG.search.suggest.categories)
      .map((c) => ({ name: cats.get(c.id!)!.name, slug: cats.get(c.id!)!.slug, count: c.count })),
  };
}

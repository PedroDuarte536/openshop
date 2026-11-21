// Query-string parsing for search. Everything is bounded and allowlisted (C13, C17): unknown parameters and unknown
// property keys are ignored, never turned into database paths.
import type { AttributeDef } from "../../types.ts";
import { canonFromUrl, MAX_QUERY_WORDS, type Query, type SortKey, type Status, type StockBand } from "./memory-index.ts";
import { CONFIG } from "../../config.ts";

export type Params = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const list = (v: string | string[] | undefined, max: number) =>
  [...new Set((Array.isArray(v) ? v.join(",") : v ?? "").split(",").map((s) => s.trim()).filter(Boolean))].slice(0, max);
const pickAll = <T extends string>(v: string | string[] | undefined, allowed: readonly T[], max = 10) => list(v, max).filter((x): x is T => (allowed as readonly string[]).includes(x));

/** Euros as typed ("12", "12.5", "12,50") to cents; undefined when empty or invalid. */
export function euroCents(v: string): number | undefined {
  const t = v.trim().replace(",", ".");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return undefined;
  return Math.round(Number(t) * 100);
}

const ADMIN_SORTS: SortKey[] = ["relevance", "name", "-name", "price", "-price", "newest", "stock", "-stock", "updated", "-updated"];
export const PUBLIC_SORTS: SortKey[] = ["relevance", "name", "price", "-price", "newest"];
const S = CONFIG.search;
export const MAX_FILTER_KEYS = S.maxFilterKeys, MAX_FILTER_VALUES = S.maxFilterValues;

/** `f.<key>=a,b` (values) or `f.<key>=10..20` (number range), for the given property definitions only. */
export function parseAttrFilters(p: Params, defs: Map<string, AttributeDef>): NonNullable<Query["attrs"]> {
  const out: NonNullable<Query["attrs"]> = {};
  for (const [name, raw] of Object.entries(p)) {
    if (!name.startsWith("f.")) continue;
    const d = defs.get(name.slice(2));
    if (!d || Object.keys(out).length >= MAX_FILTER_KEYS) continue;
    const v = one(raw).slice(0, 2000);
    const range = d.type === "number" ? /^(-?\d+(?:\.\d+)?)?\.\.(-?\d+(?:\.\d+)?)?$/.exec(v) : null;
    if (range) { out[d.key] = { ...(range[1] ? { min: Number(range[1]) } : {}), ...(range[2] ? { max: Number(range[2]) } : {}) }; continue; }
    const values = list(v, MAX_FILTER_VALUES).map((x) => canonFromUrl(x.slice(0, 200), d));
    if (values.length) out[d.key] = { values };
  }
  return out;
}

export interface AdminQuery extends Query { view: "full" | "summary" }

export function parseAdminQuery(p: Params, defs: Map<string, AttributeDef>): AdminQuery {
  const ids = list(p.ids, S.maxLookupIds);
  const status = pickAll<Status>(p.status, ["visible", "hidden", "deleted"]);
  const limitRaw = one(p.limit);
  return {
    q: one(p.q).slice(0, S.adminMaxQueryLength) || undefined,
    categories: list(p.category, S.maxCategoryFilters),
    minCents: euroCents(one(p.min)), maxCents: euroCents(one(p.max)),
    stock: pickAll<StockBand>(p.stock, ["in", "low", "out"]),
    // Lookups by id (pickers showing what an offer or bundle references) include hidden and deleted products.
    status: status.length ? status : ids.length ? ["visible", "hidden", "deleted"] : ["visible", "hidden"],
    types: pickAll(p.type, ["simple", "bundle"] as const),
    missing: pickAll(p.missing, ["image", "sku", "category", "description"] as const),
    attrs: parseAttrFilters(p, defs),
    ...(one(p.variantGroup) ? { variantGroup: one(p.variantGroup).slice(0, 64) } : {}),
    ...(one(p.inVariantGroup) === "true" ? { inVariantGroup: true } : one(p.inVariantGroup) === "false" ? { inVariantGroup: false } : {}),
    ...(ids.length ? { ids } : {}),
    sort: (ADMIN_SORTS as string[]).includes(one(p.sort)) ? (one(p.sort) as SortKey) : undefined,
    skip: Math.min(1_000_000, Math.max(0, Math.trunc(Number(one(p.skip)) || 0))),
    limit: limitRaw === "" ? S.adminPageSize : Math.min(S.adminMaxPageSize, Math.max(0, Math.trunc(Number(limitRaw) || 0))),
    facets: one(p.facets) !== "false",
    view: one(p.view) === "summary" ? "summary" : "full",
  };
}

export interface PublicQuery extends Query { page: number; per: number; categorySlugs: string[] }

/** Shop search: only what shoppers may filter by, bounded (C13). Categories are given by slug. */
export function parsePublicQuery(p: Params, defs: Map<string, AttributeDef>, opts: { per?: number } = {}): PublicQuery {
  const page = Math.min(S.shopMaxPage, Math.max(1, Math.trunc(Number(one(p.page)) || 1)));
  const per = Math.min(S.shopMaxPageSize, Math.max(1, Math.trunc(Number(one(p.per)) || opts.per || S.shopPageSize)));
  const words = one(p.q).slice(0, S.shopMaxQueryLength).split(/\s+/).filter(Boolean).slice(0, MAX_QUERY_WORDS).join(" ");
  const sort = one(p.sort);
  return {
    q: words || undefined,
    categorySlugs: list(p.category, S.shopMaxCategoryFilters),
    minCents: euroCents(one(p.min)), maxCents: euroCents(one(p.max)),
    stock: one(p.stock) === "in" ? ["in", "low"] : [],
    attrs: parseAttrFilters(p, defs),
    sort: (PUBLIC_SORTS as string[]).includes(sort) ? (sort as SortKey) : undefined,
    page, per, skip: (page - 1) * per, limit: per, facets: true,
  };
}

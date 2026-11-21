// Product export: CSV (spreadsheets) or the full JSON catalogue (backups, moving to another OpenShop). Both are
// representations of the product search URL, so "export what I see" uses the same filters (plan §2.7.4). The CSV
// columns are exactly what import reads, so export -> import changes nothing.
import { Readable } from "node:stream";
import type { AttrValue, AttributeDef, Category, Db, Product, VariantGroup } from "../types.ts";
import { displayValue, productType } from "./model.ts";
import { CONFIG } from "../config.ts";

export const CATALOGUE_TYPE = "application/vnd.openshop.catalogue+json";
export const MAX_EXPORT_ROWS = CONFIG.export.maxRows;
const CHUNK = CONFIG.export.chunkSize;

export type Delimiter = "," | ";" | "\t";

/** One CSV cell: spreadsheet formulas neutralised (C6) and quoted when needed (RFC 4180). */
export function cell(v: unknown, delim: Delimiter = ","): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return s.includes(delim) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function money(price: number, decimal: "." | ","): string {
  const s = price.toFixed(2);
  return decimal === "," ? s.replace(".", ",") : s;
}

/** A property value as a spreadsheet shows it: option labels (several joined with |), yes/no, plain numbers. */
export function attrCell(v: AttrValue | undefined, d: AttributeDef, decimal: "." | ","): string {
  if (v === undefined) return "";
  if (Array.isArray(v)) return v.map((x) => d.options?.find((o) => o.value === x)?.label ?? x).join("|");
  if (typeof v === "number") return decimal === "," ? String(v).replace(".", ",") : String(v);
  if (typeof v === "boolean") return v ? "yes" : "no";
  return d.type === "choice" ? displayValue(v, d) : v;
}

export interface ExportContext { categories: Map<string, Category>; defs: AttributeDef[]; groups: Map<string, VariantGroup>; skuOf: (id: string) => string | null; withDeleted: boolean }

export function csvHeader(x: ExportContext): string[] {
  return ["id", "sku", "type", "name", "visible", "price", "stock", "category", "description", "images",
    ...x.defs.map((d) => `attr:${d.key}`),
    "bundle_components", "bundle_pricing", "bundle_offers", "bundle_show_on_components", "variant_group", "variant_by", "variant_position",
    ...(x.withDeleted ? ["deleted"] : [])];
}

export function csvRowOf(p: Product, x: ExportContext, decimal: "." | ","): unknown[] {
  const bundle = productType(p) === "bundle" ? p.bundle : null;
  const g = p.variantGroupId ? x.groups.get(p.variantGroupId) : undefined;
  return [
    p.id, p.sku ?? "", productType(p), p.name, p.active ? "yes" : "no", money(p.price, decimal), bundle ? "" : p.stock,
    p.categoryId ? x.categories.get(p.categoryId)?.slug ?? "" : "", p.description ?? "", (p.images ?? []).join("|"),
    ...x.defs.map((d) => attrCell(p.attributes?.[d.key], d, decimal)),
    bundle ? bundle.components.map((c) => `${x.skuOf(c.productId) ?? c.productId}*${c.qty}`).join("|") : "",
    bundle ? bundle.priceMode : "", bundle ? bundle.offerScope : "", bundle ? (bundle.showOnComponents ? "yes" : "no") : "",
    g ? g.id : "", g ? g.differentiators.map((d) => d.key).join("|") : "", g && p.variantPosition !== undefined ? p.variantPosition : "",
    ...(x.withDeleted ? [p.deletedAt ? "yes" : "no"] : []),
  ];
}

export async function exportContext(db: Db, withDeleted: boolean): Promise<ExportContext> {
  const [categories, defs, groups, products] = await Promise.all([db.categories.find({}), db.attributes.find({}), db.variantGroups.find({}), db.products.find({})]);
  // Bundle components are written by SKU when they have one (readable, and stable across shops), otherwise by id.
  const skuById = new Map(products.filter((p) => p.sku).map((p) => [p.id, p.sku as string]));
  return {
    categories: new Map(categories.map((c) => [c.id, c])), defs: defs.sort((a, b) => a.position - b.position || a.key.localeCompare(b.key)),
    groups: new Map(groups.map((g) => [g.id, g])), skuOf: (id) => skuById.get(id) ?? null, withDeleted,
  };
}

/** Streams the CSV for `ids` (already filtered and sorted by the search), loading products in chunks. */
export function csvStream(db: Db, ids: string[], x: ExportContext, delim: Delimiter, decimal: "." | ","): Readable {
  let i = 0, started = false;
  return new Readable({
    async read() {
      try {
        if (!started) { started = true; this.push("\uFEFF" + csvHeader(x).map((h) => cell(h, delim)).join(delim) + "\r\n"); return; }
        if (i >= ids.length) { this.push(null); return; }
        const part = ids.slice(i, i + CHUNK); i += CHUNK;
        const docs = new Map((await db.products.find({ id: { $in: part } })).map((p) => [p.id, p]));
        this.push(part.map((id) => docs.get(id)).filter((p): p is Product => !!p).map((p) => csvRowOf(p, x, decimal).map((v) => cell(v, delim)).join(delim) + "\r\n").join(""));
      } catch (e) { this.destroy(e as Error); }
    },
  });
}

/** The full JSON catalogue: categories, properties, variant groups and products (components by SKU when they have one). */
export async function catalogueJson(db: Db, ids: string[], x: ExportContext) {
  const products: Product[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const docs = new Map((await db.products.find({ id: { $in: part } })).map((p) => [p.id, p]));
    for (const id of part) { const p = docs.get(id); if (p) products.push(p); }
  }
  return {
    format: "openshop.catalogue", version: 1, exportedAt: new Date().toISOString(),
    categories: [...x.categories.values()].map((c) => ({ slug: c.slug, name: c.name })),
    attributes: x.defs.map(({ key, label, type, unit, options, visibility, filterable, searchable, showOnProduct, position }) => ({ key, label, type, unit: unit ?? null, options: (options ?? []).map(({ value, label: l, swatch }) => ({ value, label: l, ...(swatch ? { swatch } : {}) })), visibility, filterable, searchable, showOnProduct, position })),
    variantGroups: [...x.groups.values()].map((g) => ({ id: g.id, name: g.name, differentiators: g.differentiators })),
    products: products.map((p) => ({
      id: p.id, sku: p.sku ?? null, type: productType(p), name: p.name, active: p.active, price: p.price, stock: p.stock,
      category: p.categoryId ? x.categories.get(p.categoryId)?.slug ?? null : null, description: p.description ?? "", images: p.images ?? [],
      attributes: p.attributes ?? {},
      ...(productType(p) === "bundle" && p.bundle ? { bundle: { ...p.bundle, components: p.bundle.components.map((c) => ({ ref: x.skuOf(c.productId) ?? c.productId, qty: c.qty })) } } : {}),
      variantGroup: p.variantGroupId ?? null, variantPosition: p.variantPosition ?? null,
      ...(p.deletedAt ? { deleted: true } : {}),
    })),
  };
}

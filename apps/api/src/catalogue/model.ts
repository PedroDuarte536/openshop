// Product model: validation (the second layer after the JSON schema, used by the API, bulk actions and import), the
// public projection (the only product data that may leave the admin API), and canonical property values.
import type { AttrValue, AttributeDef, BundleSpec, Product } from "../types.ts";
import { CONFIG } from "../config.ts";

export interface FieldError { field: string; message: string }

/** A write that can't be done. `status` and `code` go to the HTTP response; `fields` highlight form fields. */
export class CatalogueError extends Error {
  status: number; code?: string; fields?: FieldError[]; details?: Record<string, unknown>;
  constructor(message: string, status = 400, code?: string, fields?: FieldError[], details?: Record<string, unknown>) {
    super(message); this.name = "CatalogueError"; this.status = status; this.code = code; this.fields = fields; this.details = details;
  }
}

export const MAX_PRICE_CENTS = CONFIG.catalogue.maxPriceCents;
export const MAX_STOCK = CONFIG.catalogue.maxStock;
export const SKU_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const ATTR_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
export const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype", "hasownproperty", "tostring", "valueof"]);
export const IMAGE_RE = /^\/uploads\/[a-f0-9]{32}\.(png|jpg|webp|gif)$|^https:\/\/[^\s"'<>\\]{1,2000}$/;
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_COMPONENTS = CONFIG.catalogue.bundle.maxComponents;
const CAT = CONFIG.catalogue;

/** Control characters out (newlines and tabs kept in long text). */
const clean = (s: string, multiline: boolean) => s.replace(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, "");

export const normalizeSku = (s: string) => s.trim().toUpperCase();
export const isAttrKey = (k: string) => ATTR_KEY_RE.test(k) && !RESERVED_KEYS.has(k);

/** True when `n` is a whole number of cents (tolerates binary float noise such as 0.1 + 0.2). */
export const isCents = (n: number) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
export const toCents = (n: number) => Math.round(n * 100);

export interface ProductInput {
  name?: unknown; price?: unknown; active?: unknown; stock?: unknown; categoryId?: unknown; description?: unknown; images?: unknown;
  sku?: unknown; type?: unknown; attributes?: unknown; bundle?: unknown;
}

/**
 * Validates the product fields present in `raw` (all of them are optional on update; name and price are required on
 * create) and returns them cleaned. References (category, components, property definitions) are checked by the
 * service, which knows the database. Throws CatalogueError listing every problem.
 */
export function normalizeProductFields(raw: ProductInput, opts: { create: boolean }): Partial<Product> {
  const errors: FieldError[] = [];
  const fail = (field: string, message: string) => errors.push({ field, message });
  const out: Partial<Product> = {};
  const has = (k: keyof ProductInput) => raw[k] !== undefined;

  if (has("name") || opts.create) {
    const v = typeof raw.name === "string" ? clean(raw.name, false).trim() : "";
    if (!v) fail("name", "is required"); else if (v.length > CAT.maxNameLength) fail("name", `must be at most ${CAT.maxNameLength} characters`); else out.name = v;
  }
  if (has("price") || opts.create) {
    const v = raw.price;
    if (v === undefined || v === null || v === "") fail("price", "is required");
    else if (typeof v !== "number" || !Number.isFinite(v)) fail("price", "must be a number");
    else if (v < 0 || toCents(v) > MAX_PRICE_CENTS) fail("price", `must be between 0 and ${(MAX_PRICE_CENTS / 100).toLocaleString("en")}`);
    else if (!isCents(v)) fail("price", "can have at most 2 decimals");
    else out.price = toCents(v) / 100;
  }
  if (has("active")) { if (typeof raw.active !== "boolean") fail("active", "must be true or false"); else out.active = raw.active; }
  if (has("stock")) {
    const v = raw.stock;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > MAX_STOCK) fail("stock", `must be a whole number from 0 to ${MAX_STOCK.toLocaleString("en")}`); else out.stock = v;
  }
  if (has("categoryId")) {
    const v = raw.categoryId;
    if (v === null || v === "") out.categoryId = null;
    else if (typeof v !== "string" || !ID_RE.test(v)) fail("categoryId", "unknown category"); else out.categoryId = v;
  }
  if (has("description")) {
    if (typeof raw.description !== "string") fail("description", "must be text");
    else { const v = clean(raw.description, true); if (v.length > CAT.maxDescriptionLength) fail("description", `must be at most ${CAT.maxDescriptionLength.toLocaleString("en")} characters`); else out.description = v; }
  }
  if (has("images")) {
    const v = raw.images;
    if (!Array.isArray(v) || v.length > CAT.maxImages) fail("images", `at most ${CAT.maxImages} images`);
    else if (v.some((u) => typeof u !== "string" || !IMAGE_RE.test(u))) fail("images", "each image must be an uploaded image or an https:// address");
    else out.images = [...(v as string[])];
  }
  if (has("sku")) {
    const v = raw.sku;
    if (v === null || v === "") out.sku = null;
    else if (typeof v !== "string" || !SKU_RE.test(v.trim())) fail("sku", "1 to 64 letters, digits, dots, dashes or underscores");
    else out.sku = v.trim();
  }
  if (has("type")) { if (raw.type !== "simple" && raw.type !== "bundle") fail("type", "must be simple or bundle"); else out.type = raw.type; }
  if (has("attributes")) {
    const v = raw.attributes;
    if (!v || typeof v !== "object" || Array.isArray(v)) fail("attributes", "must be an object");
    else {
      const attrs: Record<string, AttrValue> = Object.create(null);
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (!isAttrKey(k)) { fail(`attributes.${k}`, "unknown property"); continue; }
        if (val === null || val === "") continue; // empty = no value
        if (typeof val === "string" || typeof val === "number" || typeof val === "boolean" || (Array.isArray(val) && val.every((x) => typeof x === "string"))) attrs[k] = val as AttrValue;
        else fail(`attributes.${k}`, "invalid value");
      }
      if (Object.keys(attrs).length > CAT.maxAttributesPerProduct) fail("attributes", `at most ${CAT.maxAttributesPerProduct} properties per product`);
      out.attributes = { ...attrs };
    }
  }
  if (has("bundle")) {
    const v = raw.bundle as Record<string, unknown> | null;
    if (v === null) out.bundle = null;
    else if (!v || typeof v !== "object" || Array.isArray(v)) fail("bundle", "must be an object");
    else {
      const comps = v.components;
      const spec: BundleSpec = { components: [], priceMode: "sum", offerScope: "targeted", showOnComponents: true };
      if (!Array.isArray(comps)) fail("bundle.components", "add the products in this bundle");
      else {
        const seen = new Set<string>();
        for (const c of comps as Record<string, unknown>[]) {
          const id = c && typeof c === "object" ? c.productId : undefined, qty = c && typeof c === "object" ? c.qty : undefined;
          if (typeof id !== "string" || !ID_RE.test(id)) { fail("bundle.components", "unknown product"); continue; }
          if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1 || qty > CAT.bundle.maxQty) { fail("bundle.components", `each quantity must be 1 to ${CAT.bundle.maxQty}`); continue; }
          if (seen.has(id)) { fail("bundle.components", "each product can be added once (use the quantity)"); continue; }
          seen.add(id); spec.components.push({ productId: id, qty });
        }
        if (spec.components.length < CAT.bundle.minComponents && !errors.some((e) => e.field === "bundle.components")) fail("bundle.components", `a bundle needs at least ${CAT.bundle.minComponents} different products`);
        if (spec.components.length > MAX_COMPONENTS) fail("bundle.components", `at most ${MAX_COMPONENTS} products`);
      }
      if (v.priceMode !== undefined) { if (v.priceMode !== "sum" && v.priceMode !== "manual") fail("bundle.priceMode", "must be sum or manual"); else spec.priceMode = v.priceMode; }
      if (v.offerScope !== undefined) { if (v.offerScope !== "targeted" && v.offerScope !== "all") fail("bundle.offerScope", "must be targeted or all"); else spec.offerScope = v.offerScope; }
      if (v.showOnComponents !== undefined) { if (typeof v.showOnComponents !== "boolean") fail("bundle.showOnComponents", "must be true or false"); else spec.showOnComponents = v.showOnComponents; }
      out.bundle = spec;
    }
  }
  if (errors.length) throw new CatalogueError("Please fix the highlighted fields.", 400, "invalid", errors);
  return out;
}

/** Checks property values against their definitions; returns cleaned values (numbers as numbers, options as values). */
export function normalizeAttributes(values: Record<string, AttrValue>, defs: Map<string, AttributeDef>): { attrs: Record<string, AttrValue>; errors: FieldError[] } {
  const attrs: Record<string, AttrValue> = {};
  const errors: FieldError[] = [];
  for (const [k, v] of Object.entries(values)) {
    const d = defs.get(k);
    const f = `attributes.${k}`;
    if (!d) { errors.push({ field: f, message: "unknown property" }); continue; }
    switch (d.type) {
      case "text": {
        const s = typeof v === "number" || typeof v === "boolean" ? String(v) : v;
        if (typeof s !== "string") { errors.push({ field: f, message: "must be text" }); break; }
        const t = clean(s, false).trim();
        if (t.length > CAT.maxTextValueLength) errors.push({ field: f, message: `at most ${CAT.maxTextValueLength} characters` }); else if (t) attrs[k] = t;
        break;
      }
      case "number": {
        const n = typeof v === "string" && /^-?\d{1,10}([.,]\d{1,3})?$/.test(v.trim()) ? Number(v.trim().replace(",", ".")) : v;
        if (typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 1e9) errors.push({ field: f, message: "must be a number" });
        else attrs[k] = Math.round(n * 1000) / 1000;
        break;
      }
      case "boolean": {
        const b = typeof v === "string" ? parseBool(v) : v;
        if (typeof b !== "boolean") errors.push({ field: f, message: "must be yes or no" }); else attrs[k] = b;
        break;
      }
      case "choice": {
        const o = typeof v === "string" ? findOption(d, v) : undefined;
        if (!o) errors.push({ field: f, message: `must be one of: ${(d.options ?? []).slice(0, 10).map((x) => x.label).join(", ")}` }); else attrs[k] = o.value;
        break;
      }
      case "multi": {
        const list = Array.isArray(v) ? v : typeof v === "string" ? v.split("|").map((x) => x.trim()).filter(Boolean) : null;
        if (!list || list.length > CAT.maxMultiValues) { errors.push({ field: f, message: `choose up to ${CAT.maxMultiValues} values` }); break; }
        const vals: string[] = [];
        for (const x of list) { const o = findOption(d, x); if (!o) { errors.push({ field: f, message: `unknown value "${x.slice(0, 40)}"` }); break; } if (!vals.includes(o.value)) vals.push(o.value); }
        if (vals.length) attrs[k] = vals;
        break;
      }
    }
  }
  return { attrs, errors };
}

export function parseBool(s: string): boolean | undefined {
  const v = s.trim().toLowerCase();
  if (["yes", "true", "1", "y", "sim", "oui", "ja", "si", "sí"].includes(v)) return true;
  if (["no", "false", "0", "n", "não", "nao", "non", "nein"].includes(v)) return false;
  return undefined;
}

/** An option by value or by label (case-insensitive). */
export function findOption(d: AttributeDef, v: string) {
  const t = canonText(v);
  return (d.options ?? []).find((o) => o.value === v || canonText(o.label) === t || canonText(o.value) === t);
}

/** Text compared the way shoppers read it: Unicode-normalised, trimmed, single spaces, case-insensitive. */
export const canonText = (s: string) => s.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en");

/** The canonical form of a value for comparisons (variants, facets). Missing values are "-" (owner decision V-7). */
export function canonValue(v: AttrValue | undefined, d?: AttributeDef): string {
  if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) return "-";
  if (typeof v === "number") return `n:${v}`;
  if (typeof v === "boolean") return v ? "b:1" : "b:0";
  if (Array.isArray(v)) return `m:${[...v].sort().join("|")}`;
  if (d?.type === "choice") return `c:${v}`;
  return `t:${canonText(v)}`;
}

/** How a value reads in the shop and the backoffice. */
export function displayValue(v: AttrValue | undefined, d?: AttributeDef): string {
  if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) return "-";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return `${Number.isInteger(v) ? v : v.toFixed(3).replace(/0+$/, "")}${d?.unit ? ` ${d.unit}` : ""}`;
  if (Array.isArray(v)) return v.map((x) => d?.options?.find((o) => o.value === x)?.label ?? x).join(", ");
  if (d?.type === "choice") return d.options?.find((o) => o.value === v)?.label ?? v;
  return v;
}

export const isDeleted = (p: Pick<Product, "deletedAt">) => !!p.deletedAt;
export const productType = (p: Pick<Product, "type">) => p.type ?? "simple";

/** Public property values: only properties marked public, as displayable labels. */
export function publicSpecs(p: Product, defs: AttributeDef[], which: "product" | "all" = "all") {
  return defs
    .filter((d) => d.visibility === "public" && (which === "all" || d.showOnProduct) && p.attributes?.[d.key] !== undefined)
    .sort((a, b) => a.position - b.position || a.label.localeCompare(b.label))
    .map((d) => ({ key: d.key, label: d.label, value: displayValue(p.attributes![d.key], d) }));
}

/**
 * The only product data that may leave the admin API (C1). An allowlist: internal properties, SKU, versions, audit
 * fields, deletion, variant positions and import metadata never appear.
 */
export function publicProduct(p: Product, defs: AttributeDef[], extra: { available?: number } = {}) {
  const attrs: Record<string, AttrValue> = {};
  for (const d of defs) if (d.visibility === "public" && p.attributes?.[d.key] !== undefined) attrs[d.key] = p.attributes[d.key];
  return {
    id: p.id, name: p.name, price: p.price, active: p.active, stock: extra.available ?? p.stock, categoryId: p.categoryId ?? null,
    description: p.description ?? "", images: p.images ?? [], type: productType(p), attributes: attrs,
  };
}
export type PublicProduct = ReturnType<typeof publicProduct>;

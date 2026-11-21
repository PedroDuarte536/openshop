// Column mapping and cell conversion. A file column maps to a product field, a property ("attr:<key>"), a new property
// ("new:<label>"), or nothing ("ignore"). Cells are converted here into typed values with plain-language errors.
import type { AttributeDef } from "../../types.ts";
import { keyFromLabel } from "../attributes.ts";
import { parseBool, RESERVED_KEYS, SKU_RE } from "../model.ts";
import type { FieldProblem } from "./types.ts";

export const FIELDS = ["id", "sku", "type", "name", "visible", "price", "stock", "category", "description", "images",
  "bundle_components", "bundle_pricing", "bundle_offers", "bundle_show_on_components", "variant_group", "variant_by", "variant_position", "deleted"] as const;
export type Field = (typeof FIELDS)[number];
export const FIELD_LABELS: Record<Field, string> = {
  id: "OpenShop id", sku: "SKU", type: "Type (simple or bundle)", name: "Name", visible: "Visible in the shop", price: "Price", stock: "Stock",
  category: "Category", description: "Description", images: "Photos", bundle_components: "Bundle: products", bundle_pricing: "Bundle: price (sum or manual)",
  bundle_offers: "Bundle: offers (targeted or all)", bundle_show_on_components: "Bundle: show on its products' pages",
  variant_group: "Variant group", variant_by: "Variant group: properties", variant_position: "Variant group: position",
  deleted: "Deleted (from an export of deleted products)",
};

const ALIASES: Record<string, Field> = {
  "title": "name", "product": "name", "product name": "name", "nome": "name", "nom": "name",
  "reference": "sku", "ref": "sku", "reference #": "sku", "code": "sku", "article number": "sku",
  "quantity": "stock", "qty": "stock", "inventory": "stock", "stock quantity": "stock",
  "active": "visible", "enabled": "visible", "published": "visible", "status": "visible",
  "image": "images", "image url": "images", "image urls": "images", "photos": "images", "pictures": "images",
  "categories": "category", "collection": "category", "desc": "description", "long description": "description",
};

export interface Preset { key: string; name: string; detect: (headers: string[]) => boolean; map: Record<string, string>; imageSeparator?: string; categorySeparator?: string; htmlDescriptions?: boolean }

/** PrestaShop 1.7 / 8 "Products" CSV export (semicolon separated). */
export const PRESTASHOP: Preset = {
  key: "prestashop", name: "PrestaShop 1.7 / 8 products CSV",
  detect: (h) => h.some((x) => /^name \*$/i.test(x)) || h.some((x) => /^categories \(x,y,z/i.test(x)) || h.some((x) => /^reference #$/i.test(x)),
  map: {
    "product id": "ignore", "active (0/1)": "visible", "name *": "name", "categories (x,y,z...)": "category", "price tax excluded": "price",
    "price tax excluded or price tax included": "price", "reference #": "sku", "quantity": "stock", "description": "description",
    "short description": "ignore", "summary": "ignore", "image urls (x,y,z...)": "images",
  },
  imageSeparator: ",", categorySeparator: ",", htmlDescriptions: true,
};
export const PRESETS = [PRESTASHOP];

/** Suggested target for each column: our own export headers, known aliases, properties by key or label, a preset. */
export function autoMap(headers: string[], defs: AttributeDef[], opts: { preset?: Preset | null; createProperties: boolean }): Record<string, string> {
  const out: Record<string, string> = {};
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const byLabel = new Map(defs.map((d) => [d.label.trim().toLowerCase(), d]));
  const used = new Set<string>();
  for (const h of headers) {
    const t = h.trim(), low = t.toLowerCase();
    let target = "ignore";
    const presetTarget = opts.preset?.map[low];
    if (presetTarget) target = presetTarget;
    else if ((FIELDS as readonly string[]).includes(low)) target = low;
    else if (low.startsWith("attr:")) {
      const k = t.slice(5).trim();
      const d = byKey.get(k) ?? byLabel.get(k.toLowerCase());
      target = d ? `attr:${d.key}` : opts.createProperties && k && !RESERVED_KEYS.has(k.toLowerCase()) ? `new:${k}` : "ignore";
    } else if (ALIASES[low]) target = ALIASES[low];
    else if (byLabel.has(low)) target = `attr:${byLabel.get(low)!.key}`;
    else if (byKey.has(low)) target = `attr:${low}`;
    // A field is filled from one column only (the first that maps to it).
    if (target !== "ignore" && !target.startsWith("new:") && used.has(target)) target = "ignore";
    used.add(target);
    out[h] = target;
  }
  return out;
}

/** Validates a mapping against the file's columns and the shop's properties. */
export function checkMapping(mapping: Record<string, string>, headers: string[], defs: AttributeDef[]): FieldProblem[] {
  const keys = new Set(defs.map((d) => d.key));
  const problems: FieldProblem[] = [];
  const seen = new Map<string, string>();
  for (const [col, target] of Object.entries(mapping)) {
    if (!headers.includes(col)) { problems.push({ column: col, message: "is not a column of this file" }); continue; }
    if (target === "ignore") continue;
    if (target.startsWith("new:")) { if (!target.slice(4).trim()) problems.push({ column: col, message: "the new property needs a name" }); continue; }
    if (target.startsWith("attr:") ? !keys.has(target.slice(5)) : !(FIELDS as readonly string[]).includes(target)) { problems.push({ column: col, message: `unknown target "${target}"` }); continue; }
    if (seen.has(target)) problems.push({ column: col, message: `"${seen.get(target)}" already fills this field` });
    seen.set(target, col);
  }
  return problems;
}

/** What a row says, converted from text (CSV) or taken from JSON. Absent = the file doesn't set it. */
export interface RowInput {
  id?: string; sku?: string | null; type?: "simple" | "bundle"; name?: string; active?: boolean; price?: number; stock?: number;
  category?: string | null; description?: string; images?: string[];
  /** Existing properties: key -> raw value (text from CSV, typed from JSON); null = clear. */
  attributes?: Record<string, unknown>;
  /** New properties (by label) -> raw text. */
  newAttributes?: Record<string, string>;
  bundle?: { refs: { ref: string; qty: number }[]; priceMode?: "sum" | "manual"; offerScope?: "targeted" | "all"; showOnComponents?: boolean } | null;
  variant?: { group: string | null; by: string[] | null; position: number | null };
  /** The description had HTML that was converted to text. */
  htmlStripped?: boolean;
  /** The product is deleted in the file (a backup or an export of deleted products). */
  deleted?: boolean;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
/** HTML (e.g. PrestaShop descriptions) to plain text: tags removed, common entities decoded, paragraphs kept. No HTML is ever stored. */
export function htmlToText(s: string): { text: string; changed: boolean } {
  if (!/<[a-z/!]|&[a-z#0-9]+;/i.test(s)) return { text: s, changed: false };
  const text = s
    // Script and style contents aren't text (a bounded, lazy match: linear in the cell length limit).
    .replace(/<(script|style)\b[^>]{0,200}>[\s\S]{0,20000}?<\/\1\s*>/gi, "")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6])\b[^>]{0,200}>/gi, "\n")
    .replace(/<[^>]{0,2000}>/g, "")
    .replace(/&(#\d{1,6}|#x[0-9a-f]{1,6}|[a-z]{2,8});/gi, (m, e: string) => {
      if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ""; }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text, changed: true };
}

/** Removes the ' that our exports add in front of formula-like cells (and nothing else), so round trips don't grow. */
export const unneutralise = (s: string) => (/^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s);

/** Strict price: digits with at most 2 decimals and the file's decimal mark; no thousands separators. */
export function parsePrice(s: string, decimal: "." | ","): number | null {
  const t = s.trim().replace(/^€\s*|\s*€$/g, "");
  const re = decimal === "," ? /^\d{1,7}(,\d{1,2})?$/ : /^\d{1,7}(\.\d{1,2})?$/;
  if (!re.test(t)) return null;
  return Math.round(Number(t.replace(",", ".")) * 100) / 100;
}

export interface ConvertOptions { decimal: "." | ","; empty: "leave" | "clear"; preset: Preset | null }

/** Converts one CSV record (column -> text) with a mapping into a RowInput, collecting problems per column. */
export function convertCsvRow(raw: Record<string, string>, mapping: Record<string, string>, opts: ConvertOptions): { input: RowInput; problems: FieldProblem[] } {
  const input: RowInput = {};
  const problems: FieldProblem[] = [];
  const bad = (column: string, message: string) => problems.push({ column, message });
  const clear = opts.empty === "clear";
  for (const [col, target] of Object.entries(mapping)) {
    if (target === "ignore" || !(col in raw)) continue;
    const text = unneutralise(raw[col] ?? "");
    const v = text.trim();
    const empty = v === "";
    if (target.startsWith("attr:")) { if (!empty || clear) (input.attributes ??= {})[target.slice(5)] = empty ? null : v; continue; }
    if (target.startsWith("new:")) { if (!empty) (input.newAttributes ??= {})[target.slice(4).trim()] = v; continue; }
    switch (target as Field) {
      case "id": if (!empty) input.id = v; break;
      case "sku": if (!empty) { if (!SKU_RE.test(v)) bad(col, `"${v.slice(0, 40)}" isn't a valid SKU (letters, digits, . _ - only)`); else input.sku = v; } else if (clear) input.sku = null; break;
      case "type": if (!empty) { const t = v.toLowerCase(); if (t === "simple" || t === "bundle") input.type = t; else bad(col, `must be simple or bundle, got "${v.slice(0, 20)}"`); } break;
      case "name": if (!empty) input.name = v; break;
      case "visible": if (!empty) { const b = parseBool(v); if (b === undefined) bad(col, `must be yes or no, got "${v.slice(0, 20)}"`); else input.active = b; } break;
      case "price": if (!empty) { const p = parsePrice(v, opts.decimal); if (p === null) bad(col, `must be a price like ${opts.decimal === "," ? "12,50" : "12.50"} (at most 2 decimals, no thousands separator), got "${v.slice(0, 20)}"`); else input.price = p; } break;
      case "stock": if (!empty) { if (!/^\d{1,7}$/.test(v)) bad(col, `must be a whole number, got "${v.slice(0, 20)}"`); else input.stock = Number(v); } break;
      case "category": if (!empty) { const first = opts.preset?.categorySeparator ? v.split(opts.preset.categorySeparator).map((x) => x.trim()).filter(Boolean).pop() ?? v : v; input.category = first; } else if (clear) input.category = null; break;
      case "description": if (!empty || clear) { const h = htmlToText(text); input.description = h.text; if (h.changed) input.htmlStripped = true; } break;
      case "images": if (!empty) input.images = v.split(opts.preset?.imageSeparator ?? "|").map((x) => x.trim()).filter(Boolean); else if (clear) input.images = []; break;
      case "bundle_components": {
        if (empty) break;
        const refs: { ref: string; qty: number }[] = [];
        for (const part of v.split("|").map((x) => x.trim()).filter(Boolean)) {
          const m = /^(.+?)(?:\*(\d{1,2}))?$/.exec(part);
          if (!m || !SKU_RE.test(m[1].trim())) { bad(col, `"${part.slice(0, 40)}": write SKU*quantity, e.g. MUG-1*2`); continue; }
          refs.push({ ref: m[1].trim(), qty: m[2] ? Number(m[2]) : 1 });
        }
        input.bundle = { ...(input.bundle ?? {}), refs };
        break;
      }
      case "bundle_pricing": if (!empty) { const t = v.toLowerCase(); if (t === "sum" || t === "manual") input.bundle = { refs: input.bundle?.refs ?? [], ...input.bundle, priceMode: t }; else bad(col, "must be sum or manual"); } break;
      case "bundle_offers": if (!empty) { const t = v.toLowerCase(); if (t === "targeted" || t === "all") input.bundle = { refs: input.bundle?.refs ?? [], ...input.bundle, offerScope: t }; else bad(col, "must be targeted or all"); } break;
      case "bundle_show_on_components": if (!empty) { const b = parseBool(v); if (b === undefined) bad(col, "must be yes or no"); else input.bundle = { refs: input.bundle?.refs ?? [], ...input.bundle, showOnComponents: b }; } break;
      // An empty group cell leaves the product where it is, unless empty cells clear values (then it leaves its group).
      case "variant_group": if (!empty || clear) input.variant = { group: empty ? null : v.toLowerCase(), by: input.variant?.by ?? null, position: input.variant?.position ?? null }; break;
      case "variant_by": if (!empty) input.variant = { group: input.variant?.group ?? null, by: v.split("|").map((x) => x.trim()).filter(Boolean), position: input.variant?.position ?? null }; break;
      case "deleted": if (!empty) { const b = parseBool(v); if (b === undefined) bad(col, `must be yes or no, got "${v.slice(0, 20)}"`); else if (b) input.deleted = true; } break;
      case "variant_position": if (!empty) { if (!/^\d{1,5}$/.test(v)) bad(col, "must be a whole number"); else input.variant = { group: input.variant?.group ?? null, by: input.variant?.by ?? null, position: Number(v) }; } break;
    }
  }
  return { input, problems };
}

/** Converts a product of our JSON catalogue (or a plain JSON array of products) into a RowInput. */
export function convertJsonRow(p: Record<string, unknown>): { input: RowInput; problems: FieldProblem[] } {
  const input: RowInput = {};
  const problems: FieldProblem[] = [];
  const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : undefined);
  const bad = (column: string, message: string) => problems.push({ column, message });
  if (str("id")) input.id = str("id");
  if (p.sku !== undefined) { if (p.sku === null || p.sku === "") input.sku = null; else if (typeof p.sku === "string" && SKU_RE.test(p.sku.trim())) input.sku = p.sku.trim(); else bad("sku", "isn't a valid SKU"); }
  if (p.type === "simple" || p.type === "bundle") input.type = p.type; else if (p.type !== undefined) bad("type", "must be simple or bundle");
  if (str("name") !== undefined) input.name = str("name")!.trim();
  if (p.deleted === true) input.deleted = true;
  if (typeof p.active === "boolean") input.active = p.active; else if (typeof p.visible === "boolean") input.active = p.visible;
  if (typeof p.price === "number") input.price = p.price; else if (p.price !== undefined) bad("price", "must be a number");
  if (typeof p.stock === "number") input.stock = p.stock; else if (p.stock !== undefined && p.stock !== null) bad("stock", "must be a number");
  if (p.category !== undefined) input.category = typeof p.category === "string" && p.category ? p.category : null;
  if (typeof p.description === "string") { const h = htmlToText(p.description); input.description = h.text; if (h.changed) input.htmlStripped = true; }
  if (Array.isArray(p.images)) input.images = p.images.filter((x): x is string => typeof x === "string");
  if (p.attributes && typeof p.attributes === "object" && !Array.isArray(p.attributes)) input.attributes = { ...(p.attributes as Record<string, unknown>) };
  const b = p.bundle as Record<string, unknown> | undefined | null;
  if (b && typeof b === "object") {
    const comps = Array.isArray(b.components) ? b.components as Record<string, unknown>[] : [];
    input.bundle = {
      refs: comps.map((c) => ({ ref: String(c.ref ?? c.productId ?? ""), qty: Number(c.qty) || 1 })),
      ...(b.priceMode === "sum" || b.priceMode === "manual" ? { priceMode: b.priceMode } : {}),
      ...(b.offerScope === "targeted" || b.offerScope === "all" ? { offerScope: b.offerScope } : {}),
      ...(typeof b.showOnComponents === "boolean" ? { showOnComponents: b.showOnComponents } : {}),
    };
  }
  if (p.variantGroup !== undefined) input.variant = { group: typeof p.variantGroup === "string" && p.variantGroup ? p.variantGroup : null, by: null, position: typeof p.variantPosition === "number" ? p.variantPosition : null };
  return { input, problems };
}

/** Type of a new property from its values: numbers, yes/no, or text (choice types are never guessed). */
export function inferType(values: string[]): "number" | "boolean" | "text" {
  const vs = values.map((v) => v.trim()).filter(Boolean);
  if (!vs.length) return "text";
  if (vs.every((v) => /^-?\d{1,10}([.,]\d{1,3})?$/.test(v))) return "number";
  if (vs.every((v) => ["yes", "no", "true", "false", "1", "0"].includes(v.toLowerCase()))) return "boolean";
  return "text";
}
export const newPropertyKey = (label: string) => keyFromLabel(label);

// Document model + normalisation. This file is the trust boundary: everything that reaches CSS or HTML
// goes through the validators here, so a malicious document can't inject markup or CSS.

export type Device = "desktop" | "tablet" | "mobile";
export const DEVICES: Device[] = ["desktop", "tablet", "mobile"];
export const WIDGET_TYPES = [
  "heading", "text", "image", "button", "spacer", "divider", "iconBox", "stat", "testimonial", "faq", "gallery", "productGrid",
  // bound to the shop: they show real data on product / category / search pages and sample data in the editor
  "productTitle", "productPrice", "productDescription", "productGallery", "addToCart", "searchBox", "dynamicTitle", "categoryNav",
] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];
export type NodeType = "section" | "column" | WidgetType;
export const FONT_KEYS = ["editorial", "grotesk", "poster", "classic"] as const;
export type FontKey = (typeof FONT_KEYS)[number];
export const ART_KEYS = ["aurora", "sunset", "ocean", "dusk", "meadow", "citrus", "rose", "noir"] as const;
export type ArtKey = (typeof ART_KEYS)[number];
export const ICON_KEYS = ["bolt", "shield", "truck", "heart", "star", "leaf", "gift", "clock", "cart", "globe", "sparkle", "lock", "package", "check", "smile"] as const;
export type IconKey = (typeof ICON_KEYS)[number];
export const ANIMS = ["none", "rise", "fade", "zoom", "slide"] as const;
export type Anim = (typeof ANIMS)[number];

export interface Background {
  kind: "none" | "color" | "gradient" | "preset" | "image";
  color?: string; from?: string; to?: string; angle?: number; preset?: ArtKey; image?: string; overlay?: number;
}

export interface Style {
  padT?: number; padR?: number; padB?: number; padL?: number; marT?: number; marB?: number;
  align?: "left" | "center" | "right"; valign?: "top" | "center" | "bottom"; dir?: "col" | "row";
  color?: string; bg?: Background; radius?: number; shadow?: 0 | 1 | 2 | 3;
  maxW?: number; minH?: number; gap?: number; size?: number; weight?: number; span?: number; anim?: Anim;
}

export interface Node {
  id: string;
  type: NodeType;
  props: Record<string, unknown>;
  style: Style;
  responsive?: { tablet?: Style; mobile?: Style };
  hide?: Device[];
  children?: Node[];
}

export interface Theme {
  primary: string; text: string; bg: string; surface: string; accent: string;
  font: FontKey; radius: number; currency: string;
}

export interface PageDoc { title: string; theme?: Partial<Theme>; nodes: Node[] }
export interface ProductCard { id?: string; name: string; price: number; image?: string; href?: string }
export interface ProductCtx { id: string; name: string; price: number; description?: string; images?: string[]; stock?: number }
export interface CategoryRef { name: string; slug: string }
/** Data for the shop-bound widgets. In the editor (or with `sample`) anything missing is filled with sample data. */
export interface RenderContext { product?: ProductCtx; category?: CategoryRef; query?: string; categories?: CategoryRef[]; results?: ProductCard[] }
export interface RenderOptions {
  /** Adds data-node / data-edit attributes and drop placeholders for the visual editor. */
  editor?: boolean;
  /** Fill missing context with sample data without the editor hooks (used for thumbnails). */
  sample?: boolean;
  context?: RenderContext;
  /** Supplies products for a productGrid node. Without it, sample products are shown. */
  products?: (node: Node) => ProductCard[];
}

export const DEFAULT_THEME: Theme = {
  primary: "#2B4BFF", text: "#121826", bg: "#FFFFFF", surface: "#F1F3FF", accent: "#FFD23F",
  font: "grotesk", radius: 12, currency: "€",
};

export const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** http(s), mailto, tel, site-relative and anchors only. Blocks javascript:, data: and //host. */
export function safeUrl(u: unknown): string {
  const v = typeof u === "string" ? u.trim() : "";
  return /^(https?:|mailto:|tel:|\/(?!\/)|#)/i.test(v) && !/[\u0000-\u001f\s"'<>\\]/.test(v) ? v : "#";
}
/** Images: https or our own /uploads only, and nothing that could break out of a CSS url(). */
export function safeImage(u: unknown): string {
  const v = typeof u === "string" ? u.trim() : "";
  return /^(\/uploads\/[A-Za-z0-9._-]+|https:\/\/[^\s"'()<>\\]+)$/.test(v) ? v : "";
}

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FN = /^(?:rgb|rgba|hsl|hsla)\(\s*[0-9.%\s,/-]+\)$/i;
const VAR = /^var\(--(?:primary|accent|text|bg|surface|muted|line)\)$/;
const KEYWORD = /^(?:transparent|currentcolor|white|black)$/i;
export function safeColor(c: unknown): string | undefined {
  if (typeof c !== "string") return undefined;
  const v = c.trim();
  return v.length <= 64 && (HEX.test(v) || FN.test(v) || VAR.test(v) || KEYWORD.test(v)) ? v : undefined;
}

const str = (v: unknown, max = 4000, d = "") => (typeof v === "string" ? v.slice(0, max) : d);
const num = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : undefined;
const pick = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);
const bool = (v: unknown, d = false) => (typeof v === "boolean" ? v : d);

export function normBackground(raw: unknown): Background | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const kind = pick(r.kind, ["none", "color", "gradient", "preset", "image"] as const, "none");
  const b: Background = { kind };
  if (kind === "color") b.color = safeColor(r.color) ?? "#ffffff";
  if (kind === "gradient") { b.from = safeColor(r.from) ?? "#2B4BFF"; b.to = safeColor(r.to) ?? "#FF7AC6"; b.angle = num(r.angle, 0, 360) ?? 135; }
  if (kind === "preset") b.preset = pick(r.preset, ART_KEYS, "aurora");
  if (kind === "image") { b.image = safeImage(r.image); b.overlay = num(r.overlay, 0, 0.9) ?? 0.35; }
  return b;
}

const NUM_KEYS: [keyof Style, number, number][] = [
  ["padT", 0, 400], ["padR", 0, 400], ["padB", 0, 400], ["padL", 0, 400], ["marT", 0, 400], ["marB", 0, 400],
  ["radius", 0, 200], ["maxW", 120, 2400], ["minH", 0, 1600], ["gap", 0, 200], ["size", 8, 220], ["weight", 100, 900], ["span", 1, 12],
];
export function normStyle(raw: unknown): Style {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== "object") return out as Style;
  const r = raw as Record<string, unknown>;
  for (const [k, min, max] of NUM_KEYS) { const v = num(r[k], min, max); if (v !== undefined) out[k] = k === "span" || k === "weight" ? Math.round(v) : v; }
  if (r.align !== undefined) out.align = pick(r.align, ["left", "center", "right"] as const, "left");
  if (r.valign !== undefined) out.valign = pick(r.valign, ["top", "center", "bottom"] as const, "top");
  if (r.dir !== undefined) out.dir = pick(r.dir, ["col", "row"] as const, "col");
  if (r.anim !== undefined) out.anim = pick(r.anim, ANIMS, "none");
  if (typeof r.shadow === "number") out.shadow = Math.min(3, Math.max(0, Math.round(r.shadow)));
  const c = safeColor(r.color); if (c) out.color = c;
  const bg = normBackground(r.bg); if (bg) out.bg = bg;
  return out as Style;
}

export function normTheme(raw: unknown): Theme {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_THEME;
  const hex = (v: unknown, def: string) => { const c = safeColor(v); return c && HEX.test(c) ? c : def; };
  return {
    primary: hex(r.primary, d.primary), text: hex(r.text, d.text), bg: hex(r.bg, d.bg), surface: hex(r.surface, d.surface), accent: hex(r.accent, d.accent),
    font: pick(r.font, FONT_KEYS, d.font), radius: num(r.radius, 0, 40) ?? d.radius, currency: str(r.currency, 3, d.currency),
  };
}

type Raw = Record<string, unknown>;
const items = (v: unknown, max: number): Raw[] => (Array.isArray(v) ? v.slice(0, max).filter((x) => x && typeof x === "object") as Raw[] : []);
const RATIOS = ["auto", "1/1", "4/3", "3/2", "16/9", "4/5", "3/4"] as const;

function normProps(type: NodeType, raw: unknown): Record<string, unknown> {
  const p = (raw && typeof raw === "object" ? raw : {}) as Raw;
  switch (type) {
    case "section": return { width: pick(p.width, ["boxed", "full"] as const, "boxed") };
    case "column": return {};
    case "heading": return { text: str(p.text, 600, "Heading"), level: Math.round(num(p.level, 1, 4) ?? 2), grad: bool(p.grad) };
    case "text": return { text: str(p.text, 4000, "Write something here.") };
    case "image": return { src: safeImage(p.src), alt: str(p.alt, 300), art: p.art ? pick(p.art, ART_KEYS, "aurora") : "", ratio: pick(p.ratio, RATIOS, "auto"), fit: pick(p.fit, ["cover", "contain"] as const, "cover") };
    case "button": return { label: str(p.label, 80, "Button"), href: safeUrl(p.href), variant: pick(p.variant, ["solid", "outline", "soft", "ghost"] as const, "solid"), size: pick(p.size, ["sm", "md", "lg"] as const, "md"), label2: str(p.label2, 80), href2: safeUrl(p.href2), variant2: pick(p.variant2, ["solid", "outline", "soft", "ghost"] as const, "ghost") };
    case "spacer": return {};
    case "divider": return { line: pick(p.line, ["solid", "dashed", "dotted"] as const, "solid"), weight: Math.round(num(p.weight, 1, 8) ?? 1) };
    case "iconBox": return { icon: pick(p.icon, ICON_KEYS, "sparkle"), title: str(p.title, 200, "Feature"), text: str(p.text, 1000), layout: pick(p.layout, ["top", "left"] as const, "top") };
    case "stat": return { value: str(p.value, 40, "100"), label: str(p.label, 120) };
    case "testimonial": return { quote: str(p.quote, 1200, "Quote"), author: str(p.author, 120), role: str(p.role, 160) };
    case "faq": return { items: items(p.items, 20).map((i) => ({ q: str(i.q, 300), a: str(i.a, 2000) })) };
    case "gallery": return {
      items: items(p.items, 24).map((i) => ({ src: safeImage(i.src), alt: str(i.alt, 300), art: i.art ? pick(i.art, ART_KEYS, "aurora") : "" })),
      cols: Math.round(num(p.cols, 2, 6) ?? 4), ratio: pick(p.ratio, RATIOS, "1/1"),
    };
    case "productGrid": return { categoryId: str(p.categoryId, 64), limit: Math.round(num(p.limit, 1, 48) ?? 4), cols: Math.round(num(p.cols, 2, 5) ?? 4), source: pick(p.source, ["catalogue", "results"] as const, "catalogue") };
    case "productTitle": return { level: Math.round(num(p.level, 1, 3) ?? 1) };
    case "productPrice": case "productDescription": return {};
    case "productGallery": return { ratio: pick(p.ratio, RATIOS, "4/5") };
    case "addToCart": return { label: str(p.label, 60, "Add to cart"), qty: bool(p.qty, true) };
    case "searchBox": return { placeholder: str(p.placeholder, 80, "Search the shop"), button: str(p.button, 40, "Search") };
    case "dynamicTitle": return { source: pick(p.source, ["category", "search"] as const, "category"), level: Math.round(num(p.level, 1, 3) ?? 1) };
    case "categoryNav": return { layout: pick(p.layout, ["pills", "list"] as const, "pills") };
  }
}

const NODE_TYPES: string[] = ["section", "column", ...WIDGET_TYPES];
const ID = /^[A-Za-z0-9_-]{1,24}$/;
const MAX_NODES = 600;
interface Ctx { count: number; ids: Set<string> }

function normNode(raw: unknown, parent: "root" | "section" | "column", ctx: Ctx): Node {
  if (++ctx.count > MAX_NODES) throw new Error("page too large");
  if (!raw || typeof raw !== "object") throw new Error("invalid node");
  const r = raw as Raw;
  const type = r.type as NodeType;
  if (!NODE_TYPES.includes(type as string)) throw new Error(`Unknown node type: ${String(r.type)}`);
  const allowed = parent === "root" ? type === "section" : parent === "section" ? type === "column" : type !== "section" && type !== "column";
  if (!allowed) throw new Error(`${type} cannot be placed inside ${parent}`);
  if (typeof r.id !== "string" || !ID.test(r.id) || ctx.ids.has(r.id)) throw new Error("invalid or duplicate node id");
  ctx.ids.add(r.id);
  const node: Node = { id: r.id, type, props: normProps(type, r.props), style: normStyle(r.style) };
  const resp = (r.responsive && typeof r.responsive === "object" ? r.responsive : {}) as Raw;
  const tablet = normStyle(resp.tablet), mobile = normStyle(resp.mobile);
  if (Object.keys(tablet).length || Object.keys(mobile).length) node.responsive = { ...(Object.keys(tablet).length ? { tablet } : {}), ...(Object.keys(mobile).length ? { mobile } : {}) };
  if (Array.isArray(r.hide)) { const h = DEVICES.filter((d) => (r.hide as unknown[]).includes(d)); if (h.length) node.hide = h; }
  if (type === "section" || type === "column") {
    const kids = Array.isArray(r.children) ? r.children : [];
    node.children = kids.map((k) => normNode(k, type, ctx));
  }
  return node;
}

/** Validates and cleans a document. Throws on structural problems; silently drops invalid style values. */
export function normalizeDoc(raw: unknown): PageDoc {
  if (!raw || typeof raw !== "object") throw new Error("invalid document");
  const r = raw as Raw;
  const ctx: Ctx = { count: 0, ids: new Set() };
  const nodes = Array.isArray(r.nodes) ? r.nodes.map((n) => normNode(n, "root", ctx)) : [];
  return { title: str(r.title, 200, "Untitled"), theme: normTheme(r.theme), nodes };
}

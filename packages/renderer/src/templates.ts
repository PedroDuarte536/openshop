import type { ArtKey, IconKey, Node, NodeType, PageDoc, Style, Theme, WidgetType } from "./model.ts";
import { THEMES } from "./presets.ts";

export const uid = () => "n" + Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 4);

const node = (type: NodeType, props: Record<string, unknown> = {}, style: Style = {}, children?: Node[]): Node =>
  ({ id: uid(), type, props, style, ...(children ? { children } : {}) });
const w = (type: WidgetType, props: Record<string, unknown> = {}, style: Style = {}) => node(type, props, style);
const col = (span: number, children: Node[], style: Style = {}) => node("column", {}, { span, ...style }, children);
const sec = (cols: Node[], style: Style = {}, props: Record<string, unknown> = {}) => node("section", props, style, cols);

/** Deep-copies a subtree with brand new ids (used for duplicate and for inserting templates). */
export function cloneWithNewIds(n: Node): Node {
  return { ...structuredClone(n), id: uid(), ...(n.children ? { children: n.children.map(cloneWithNewIds) } : {}) };
}

export const WIDGETS: { type: WidgetType; label: string; icon: IconKey; hint: string }[] = [
  { type: "heading", label: "Heading", icon: "star", hint: "Big, bold titles" },
  { type: "text", label: "Text", icon: "check", hint: "Paragraphs" },
  { type: "image", label: "Image", icon: "gift", hint: "Photo or artwork" },
  { type: "button", label: "Button", icon: "bolt", hint: "Link with style" },
  { type: "iconBox", label: "Icon box", icon: "sparkle", hint: "Feature with icon" },
  { type: "stat", label: "Stat", icon: "clock", hint: "Number + label" },
  { type: "testimonial", label: "Testimonial", icon: "heart", hint: "Customer quote" },
  { type: "faq", label: "FAQ", icon: "smile", hint: "Expandable answers" },
  { type: "gallery", label: "Gallery", icon: "leaf", hint: "Image grid" },
  { type: "productGrid", label: "Products", icon: "cart", hint: "Live from your catalogue" },
  { type: "divider", label: "Divider", icon: "globe", hint: "A quiet line" },
  { type: "spacer", label: "Spacer", icon: "package", hint: "Breathing room" },
];

export function newWidget(type: WidgetType): Node {
  switch (type) {
    case "heading": return w("heading", { text: "A headline worth reading", level: 2 });
    case "text": return w("text", { text: "Tell people what makes this special. Keep it short, specific and true." });
    case "image": return w("image", { art: "aurora", ratio: "4/3" });
    case "button": return w("button", { label: "Shop now", href: "/shop" });
    case "iconBox": return w("iconBox", { icon: "sparkle", title: "Something good", text: "One clear sentence about it." });
    case "stat": return w("stat", { value: "24h", label: "Average dispatch time" });
    case "testimonial": return w("testimonial", { quote: "I didn't expect to love it this much.", author: "Alex Rivera", role: "Verified buyer" });
    case "faq": return w("faq", { items: [{ q: "How long does shipping take?", a: "Most orders arrive in 2 to 4 working days." }, { q: "Can I return an item?", a: "Yes, within 30 days, no questions asked." }] });
    case "gallery": return w("gallery", { cols: 3, ratio: "1/1", items: (["aurora", "sunset", "ocean"] as ArtKey[]).map((art) => ({ art })) });
    case "productGrid": return w("productGrid", { limit: 4, cols: 4 });
    case "divider": return w("divider");
    case "spacer": return w("spacer", {}, { minH: 48 });
  }
}

export const LAYOUTS: { label: string; spans: number[] }[] = [
  { label: "1", spans: [12] }, { label: "1/2 + 1/2", spans: [6, 6] }, { label: "1/3 ×3", spans: [4, 4, 4] },
  { label: "1/4 ×4", spans: [3, 3, 3, 3] }, { label: "1/3 + 2/3", spans: [4, 8] }, { label: "2/3 + 1/3", spans: [8, 4] }, { label: "1/4 + 1/2 + 1/4", spans: [3, 6, 3] },
];
export const newSection = (spans: number[]): Node => sec(spans.map((s) => col(s, [])), { padT: 72, padB: 72 });

const BRAND = "Maison Dune";
const btn = (label: string, href: string, variant = "solid", size = "md") => w("button", { label, href, variant, size });

export interface SectionTemplate { key: string; name: string; build: () => Node }

export const SECTION_TEMPLATES: SectionTemplate[] = [
  { key: "header", name: "Header", build: () => sec([
      col(4, [w("heading", { text: BRAND, level: 4 }, { weight: 800, size: 22 })], { valign: "center" }),
      col(8, [btn("Shop", "/shop", "ghost", "sm"), btn("Cart", "/shop/cart", "ghost", "sm"), btn("Visit the studio", "#", "solid", "sm")], { dir: "row", align: "right", gap: 6 }),
    ], { padT: 18, padB: 18 }) },
  { key: "hero-split", name: "Hero, split", build: () => sec([
      col(7, [
        w("heading", { text: "Hand-glazed ceramics for slow mornings.", level: 1 }, { size: 80, anim: "rise" }),
        w("text", { text: "Mugs, bowls and vases thrown and fired in small batches in our Lisbon studio. Every piece comes out a little different." }, { size: 20, maxW: 520 }),
        w("button", { label: "Shop the collection", href: "/shop", variant: "solid", size: "lg", label2: "See how it's made", href2: "#", variant2: "ghost" }),
      ], { valign: "center", gap: 24 }),
      col(5, [w("image", { art: "aurora", ratio: "4/5" }, { radius: 36 })]),
    ], { padT: 72, padB: 96 }) },
  { key: "hero-cover", name: "Hero, cover", build: () => sec([
      col(8, [
        w("heading", { text: "Drop 04: Night Market", level: 1 }, { size: 104, anim: "rise" }),
        w("text", { text: "Eleven pieces, glazed in the colours of a city after dark. Once they're gone, they're gone." }, { size: 21, maxW: 520 }),
        w("button", { label: "Shop the drop", href: "/shop", variant: "solid", size: "lg", label2: "Browse everything", href2: "/shop", variant2: "outline" }),
      ], { gap: 26 }),
    ], { minH: 680, bg: { kind: "preset", preset: "dusk" }, padT: 96, padB: 96 }) },
  { key: "features", name: "Features", build: () => sec([
      col(12, [w("heading", { text: "Why people come back", level: 2 }, { maxW: 620 })]),
      col(4, [w("iconBox", { icon: "leaf", title: "Made in small batches", text: "Never more than 40 pieces per glaze, so nothing is ever mass-produced." }, { size: 17 })]),
      col(4, [w("iconBox", { icon: "truck", title: "Ships in two days", text: "Packed by hand in recycled paper and sent from Lisbon within 48 hours." }, { size: 17 })]),
      col(4, [w("iconBox", { icon: "shield", title: "30-day returns", text: "Changed your mind? Send it back for a full refund, no questions." }, { size: 17 })]),
    ], { bg: { kind: "color", color: "var(--surface)" }, padT: 88, padB: 88 }) },
  { key: "products", name: "Product showcase", build: () => sec([
      col(8, [w("heading", { text: "New this week", level: 2 }), w("text", { text: "Fresh from the kiln." })], { gap: 8 }),
      col(4, [w("button", { label: "View all", href: "/shop", variant: "outline" })], { valign: "bottom", align: "right" }),
      col(12, [w("productGrid", { limit: 4, cols: 4 })]),
    ]) },
  { key: "split", name: "Image + text", build: () => sec([
      col(6, [w("image", { art: "meadow", ratio: "1/1" }, { radius: 28 })], { anim: "fade" } as Style),
      col(6, [
        w("heading", { text: "Glazes we mix ourselves", level: 2 }),
        w("text", { text: "Our recipes are lead-free, food-safe and tested in the same kiln you'd expect from a family workshop. Each batch is numbered, so you always know where yours began." }),
        w("button", { label: "Read the story", href: "#", variant: "soft" }),
      ], { valign: "center", gap: 20 }),
    ]) },
  { key: "testimonials", name: "Testimonials", build: () => sec([
      col(4, [w("testimonial", { quote: "The mug is heavier than I expected, in the best way. It's the first thing I reach for every morning.", author: "Marta Costa", role: "Lisbon" })]),
      col(4, [w("testimonial", { quote: "Arrived wrapped like a gift. The glaze catches the light differently every hour.", author: "Jonas Weber", role: "Berlin" }, { marT: 40 })]),
      col(4, [w("testimonial", { quote: "I've bought six pieces now. Not one has chipped, and I am not gentle.", author: "Priya Nair", role: "London" })]),
    ], { bg: { kind: "color", color: "var(--surface)" } }) },
  { key: "stats", name: "Stats band", build: () => sec([
      col(3, [w("stat", { value: "12k+", label: "Pieces shipped" })]), col(3, [w("stat", { value: "4.9", label: "Average review" })]),
      col(3, [w("stat", { value: "48h", label: "To your door" })]), col(3, [w("stat", { value: "100%", label: "Lead-free glazes" })]),
    ], { bg: { kind: "preset", preset: "noir" }, padT: 72, padB: 72 }) },
  { key: "faq", name: "FAQ", build: () => sec([
      col(5, [w("heading", { text: "Questions, answered", level: 2 }), w("text", { text: "Can't find what you need? Write to hello@maisondune.example and a real person replies." })], { gap: 14 }),
      col(7, [w("faq", { items: [
        { q: "Are the pieces dishwasher safe?", a: "Yes. They're fired at 1,240°C and tested for 500 cycles. Hand washing keeps the glaze glossy for longer." },
        { q: "How long does shipping take?", a: "Most orders leave the studio in 48 hours and arrive in 2 to 4 working days across Europe." },
        { q: "Can I return something?", a: "Within 30 days, in its original packaging, for a full refund." },
      ] })]),
    ]) },
  { key: "gallery", name: "Gallery", build: () => sec([col(12, [w("gallery", { cols: 4, ratio: "1/1", items: (["aurora", "sunset", "ocean", "meadow"] as ArtKey[]).map((art) => ({ art })) })])]) },
  { key: "cta", name: "Call to action", build: () => sec([
      col(8, [w("heading", { text: "Start your collection", level: 2 }, { size: 56 }), w("text", { text: "Free shipping on orders over €60." }, { size: 19 })], { gap: 10 }),
      col(4, [w("button", { label: "Browse the shop", href: "/shop", variant: "solid", size: "lg" })], { valign: "center", align: "right" }),
    ], { bg: { kind: "color", color: "var(--primary)" }, padT: 76, padB: 76 }) },
  { key: "footer", name: "Footer", build: () => sec([
      col(6, [w("heading", { text: BRAND, level: 4 }, { weight: 800, size: 22 }), w("text", { text: "Ceramics made by hand in Lisbon." })], { gap: 8 }),
      col(6, [btn("Shop", "/shop", "ghost", "sm"), btn("Cart", "/shop/cart", "ghost", "sm"), btn("Contact", "#", "ghost", "sm")], { dir: "row", align: "right" }),
      col(12, [w("divider"), w("text", { text: "© 2026 Maison Dune. All rights reserved." }, { size: 14 })], { gap: 18 }),
    ], { bg: { kind: "color", color: "#12141C" }, padT: 56, padB: 40 }) },
];

export interface PageTemplate { key: string; name: string; blurb: string; theme: Partial<Theme>; build: () => Node[] }
const pick = (...keys: string[]) => keys.map((k) => SECTION_TEMPLATES.find((t) => t.key === k)!.build());

export const PAGE_TEMPLATES: PageTemplate[] = [
  { key: "ceramics", name: "Ceramics shop", blurb: "Warm, editorial home page", theme: THEMES.moss.theme, build: () => pick("header", "hero-split", "features", "products", "split", "testimonials", "cta", "footer") },
  { key: "drop", name: "Product drop", blurb: "Dark, bold launch page", theme: THEMES.plum.theme, build: () => pick("header", "hero-cover", "stats", "products", "faq", "cta", "footer") },
  { key: "blank", name: "Blank", blurb: "Start from nothing", theme: THEMES.cobalt.theme, build: () => [newSection([12])] },
];

export const buildDoc = (t: PageTemplate, title: string): PageDoc => ({ title, theme: t.theme, nodes: t.build() });

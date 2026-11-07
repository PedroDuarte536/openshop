import { BASE_CSS, bgIsDark, hideRules, responsiveBlocks, themeVars } from "./css.ts";
import { iconSvg } from "./icons.ts";
import { FONTS, ART } from "./presets.ts";
import { DEFAULT_THEME, esc, normalizeDoc, normTheme, safeImage, safeUrl } from "./model.ts";
import type { ArtKey, IconKey, Node, PageDoc, ProductCard, RenderOptions, Theme } from "./model.ts";

const SAMPLE: ProductCard[] = [
  { name: "Linen mug", price: 24 }, { name: "Stoneware bowl", price: 38 }, { name: "Bud vase", price: 29 }, { name: "Dune plate", price: 32 },
  { name: "Tall carafe", price: 54 }, { name: "Salt cellar", price: 18 }, { name: "Tea set", price: 96 }, { name: "Dish rack", price: 41 },
];

interface Ctx { editor: boolean; theme: Theme; opts: RenderOptions }
const P = (n: Node) => n.props as Record<string, any>;

/** Attributes common to every node. Editor-only hooks never reach published pages. */
function root(n: Node, ctx: Ctx, classes: string, extra = ""): string {
  const dark = n.style.bg && !n.style.color && bgIsDark(n.style.bg, ctx.theme) ? " os-dark" : "";
  const anim = !ctx.editor && n.style.anim && n.style.anim !== "none" ? ` os-a-${n.style.anim}` : "";
  const ed = ctx.editor ? ` data-node="${n.id}" data-type="${n.type}"` : "";
  return `class="${classes}${dark}${anim} n-${n.id}"${ed}${extra}`;
}
const ed = (ctx: Ctx, key: string) => (ctx.editor ? ` data-edit="${key}"` : "");

function art(key: ArtKey, extra = ""): string {
  return `<div class="os-art" style="background:${ART[key].css}"${extra}></div>`;
}
const hash = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
// Product fallbacks stay light and lively; the dark presets are for hero backgrounds.
const CARD_ART: ArtKey[] = ["sunset", "meadow", "rose", "citrus", "ocean", "aurora"];
const money = (t: Theme, p: number) => `${esc(t.currency)}${p.toFixed(2)}`;

function figure(n: Node, ctx: Ctx, src: string, key: string, alt: string, ratio: string, fit: string, cls = "os-fig"): string {
  const style = `--ratio:${ratio === "auto" ? "auto" : ratio};--fit:${fit}`;
  const inner = src ? `<img src="${esc(src)}" alt="${esc(alt)}" loading="lazy" decoding="async">` : key ? art(key as ArtKey) : "";
  return `<figure ${root(n, ctx, cls)} style="${style}">${inner}</figure>`;
}

function widget(n: Node, ctx: Ctx): string {
  const p = P(n);
  switch (n.type) {
    case "heading": {
      const l = p.level as number;
      return `<h${l} ${root(n, ctx, `os-h os-h${l}${p.grad ? " os-grad" : ""}`)}${ed(ctx, "text")}>${esc(p.text)}</h${l}>`;
    }
    case "text":
      return `<p ${root(n, ctx, "os-p")}${ed(ctx, "text")}>${esc(p.text)}</p>`;
    case "image": {
      if (!p.src && !p.art) return ctx.editor ? `<div ${root(n, ctx, "os-note")}>Image: pick one in the panel</div>` : "";
      return figure(n, ctx, p.src, p.art, p.alt, p.ratio, p.fit);
    }
    case "button":
      return `<div ${root(n, ctx, "os-btnw")}><a class="os-btn os-btn--${p.variant} os-btn--${p.size}" href="${esc(safeUrl(p.href))}"${ed(ctx, "label")}>${esc(p.label)}</a>${p.label2 ? `<a class="os-btn os-btn--${p.variant2} os-btn--${p.size}" href="${esc(safeUrl(p.href2))}"${ed(ctx, "label2")}>${esc(p.label2)}</a>` : ""}</div>`;
    case "spacer":
      return `<div ${root(n, ctx, "os-spacer")} aria-hidden="true"></div>`;
    case "divider":
      return `<hr ${root(n, ctx, "os-hr")} style="border-top-style:${p.line};border-top-width:${p.weight}px">`;
    case "iconBox":
      return `<div ${root(n, ctx, `os-ib os-ib--${p.layout}`)}><span class="os-ib-ic">${iconSvg(p.icon as IconKey)}</span><div><h3 class="os-ib-t"${ed(ctx, "title")}>${esc(p.title)}</h3><p class="os-ib-p"${ed(ctx, "text")}>${esc(p.text)}</p></div></div>`;
    case "stat":
      return `<div ${root(n, ctx, "os-stat")}><div class="os-stat-v"${ed(ctx, "value")}>${esc(p.value)}</div><div class="os-stat-l"${ed(ctx, "label")}>${esc(p.label)}</div></div>`;
    case "testimonial": {
      const initial = esc(String(p.author).trim().charAt(0).toUpperCase() || "•");
      return `<figure ${root(n, ctx, "os-tm")}><blockquote${ed(ctx, "quote")}>${esc(p.quote)}</blockquote><figcaption><span class="os-av">${initial}</span><span><b${ed(ctx, "author")}>${esc(p.author)}</b><small${ed(ctx, "role")}>${esc(p.role)}</small></span></figcaption></figure>`;
    }
    case "faq": {
      const items = p.items as { q: string; a: string }[];
      if (!items.length) return ctx.editor ? `<div ${root(n, ctx, "os-note")}>Add questions in the panel</div>` : "";
      return `<div ${root(n, ctx, "os-faq")}>${items.map((it, i) => `<details><summary${ed(ctx, `items.${i}.q`)}>${esc(it.q)}</summary><p${ed(ctx, `items.${i}.a`)}>${esc(it.a)}</p></details>`).join("")}</div>`;
    }
    case "gallery": {
      const items = p.items as { src: string; alt: string; art: string }[];
      if (!items.length) return ctx.editor ? `<div ${root(n, ctx, "os-note")}>Add images in the panel</div>` : "";
      return `<div ${root(n, ctx, "os-gal")} style="--c:${p.cols}">${items.map((i) => `<figure class="os-fig" style="--ratio:${p.ratio === "auto" ? "auto" : p.ratio};--fit:cover">${i.src ? `<img src="${esc(i.src)}" alt="${esc(i.alt)}" loading="lazy" decoding="async">` : i.art ? art(i.art as ArtKey) : ""}</figure>`).join("")}</div>`;
    }
    case "productGrid": {
      const limit = p.limit as number;
      const items = (ctx.opts.products ? ctx.opts.products(n) : SAMPLE).slice(0, limit);
      if (!items.length) return `<div ${root(n, ctx, "os-note")}>No products to show yet.</div>`;
      const offset = hash(items[0].name) % CARD_ART.length;
      const cards = items.map((it, i) => {
        const img = safeImage(it.image);
        const visual = img ? `<img src="${esc(img)}" alt="${esc(it.name)}" loading="lazy" decoding="async">` : art(CARD_ART[(offset + i) % CARD_ART.length]);
        const tag = ctx.editor || !it.href ? "div" : "a";
        return `<${tag} class="os-pc"${tag === "a" ? ` href="${esc(safeUrl(it.href))}"` : ""}><div class="os-pc-img">${visual}</div><div><div class="os-pc-n">${esc(it.name)}</div><div class="os-pc-p">${money(ctx.theme, it.price)}</div></div></${tag}>`;
      }).join("");
      return `<div ${root(n, ctx, `os-pg os-pg-${p.cols}`)}>${cards}</div>`;
    }
    default:
      throw new Error(`Unknown widget: ${n.type}`);
  }
}

function column(n: Node, ctx: Ctx): string {
  const kids = n.children ?? [];
  const narrow = (n.style.span ?? 12) <= 3 ? " os-narrow" : "";
  const body = kids.map((k) => widget(k, ctx)).join("") || (ctx.editor ? `<div class="os-empty" data-empty="${n.id}">Drop a widget here</div>` : "");
  return `<div ${root(n, ctx, `os-col${narrow}`)}>${body}</div>`;
}

function section(n: Node, ctx: Ctx): string {
  const full = P(n).width === "full" ? " os-full" : "";
  return `<section ${root(n, ctx, `os-section${full}`)}><div class="os-inner"><div class="os-grid">${(n.children ?? []).map((c) => column(c, ctx)).join("")}</div></div></section>`;
}

/** Fills in each column's default width (equal share) so CSS and editor agree. */
function withDefaults(doc: PageDoc): PageDoc {
  return {
    ...doc,
    nodes: doc.nodes.map((s) => {
      const kids = s.children ?? [];
      const share = Math.max(1, Math.min(12, Math.floor(12 / Math.max(kids.length, 1))));
      return { ...s, children: kids.map((c) => ({ ...c, style: { span: share, ...c.style } })) };
    }),
  };
}

export interface RenderedParts { head: string; css: string; body: string }

/** Head tags + CSS + body markup separately, so the editor can swap them in place without reloading its iframe. */
export function renderParts(input: PageDoc, opts: RenderOptions = {}): RenderedParts {
  const doc = withDefaults(normalizeDoc(input));
  const theme = normTheme(doc.theme);
  const ctx: Ctx = { editor: !!opts.editor, theme, opts };
  const flat: Node[] = [];
  const walk = (ns: Node[]) => ns.forEach((n) => { flat.push(n); if (n.children) walk(n.children); });
  walk(doc.nodes);
  const css = themeVars(theme) + BASE_CSS + responsiveBlocks(doc.nodes) + flat.map((n) => hideRules(n, ctx.editor)).join("");
  const head = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="${FONTS[theme.font].href}">`;
  return { head, css, body: doc.nodes.map((s) => section(s, ctx)).join("") };
}

/** Pure function: page document in, a complete static HTML document (no JS) out. */
export function renderPage(doc: PageDoc, opts: RenderOptions = {}): string {
  const { head, css, body } = renderParts(doc, opts);
  const title = normalizeDoc(doc).title;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${head}<style>${css}</style></head><body class="os${opts.editor ? " os-editor" : ""}"><main>${body}</main></body></html>`;
}

/** Shell for storefront pages (shop, cart, checkout) so they share the theme and fonts. */
export function renderDocument(title: string, bodyHtml: string, theme: Partial<Theme> = DEFAULT_THEME): string {
  const t = normTheme(theme);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="${FONTS[t.font].href}"><style>${themeVars(t)}${BASE_CSS}</style></head><body class="os"><nav class="os-shell-nav"><a href="/">Home</a><a href="/shop">Shop</a><a href="/shop/cart">Cart</a></nav><main class="os-shell">${bodyHtml}</main></body></html>`;
}

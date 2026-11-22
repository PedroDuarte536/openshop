import { BASE_CSS, bgIsDark, hideRules, responsiveBlocks, themeVars } from "./css.ts";
import { iconSvg } from "./icons.ts";
import { FONTS, ART } from "./presets.ts";
import { DEFAULT_THEME, SHOP_SCRIPT, esc, normalizeDoc, normTheme, safeColor, safeImage, safeProductLink, safeShopLink, safeUrl } from "./model.ts";
import type { ArtKey, IconKey, Node, PageDoc, ProductCard, RenderContext, RenderOptions, SearchState, Theme } from "./model.ts";

const SAMPLE: ProductCard[] = [
  { name: "Linen mug", price: 24 }, { name: "Stoneware bowl", price: 38 }, { name: "Bud vase", price: 29 }, { name: "Dune plate", price: 32 },
  { name: "Tall carafe", price: 54 }, { name: "Salt cellar", price: 18 }, { name: "Tea set", price: 96 }, { name: "Dish rack", price: 41 },
];

const SAMPLE_SEARCH: SearchState = {
  path: "/search", keep: [["q", "mug"]], total: 38, page: 1, pages: 2, sort: "relevance",
  sorts: [{ value: "relevance", label: "Best match" }, { value: "price", label: "Price, low to high" }, { value: "-price", label: "Price, high to low" }, { value: "name", label: "Name" }, { value: "newest", label: "Newest" }],
  facets: [
    { key: "category", label: "Category", param: "category", options: [{ value: "mugs", label: "Mugs", count: 14, selected: true }, { value: "bowls", label: "Bowls", count: 9, selected: false }, { value: "vases", label: "Vases", count: 6, selected: false }] },
    { key: "colour", label: "Colour", param: "f.colour", options: [{ value: "sand", label: "Sand", count: 11, selected: false, swatch: "#d8c3a5" }, { value: "ink", label: "Ink blue", count: 7, selected: true, swatch: "#1f3b73" }, { value: "moss", label: "Moss", count: 5, selected: false, swatch: "#6b7f4e" }] },
  ],
  price: { min: null, max: 40, bounds: { min: 12, max: 96 } }, inStock: { selected: false, count: 31 },
  chips: [{ label: "Mugs", href: "#" }, { label: "Ink blue", href: "#" }, { label: "Up to €40", href: "#" }], clearHref: "#",
  pageLinks: [{ n: 1, href: "#", current: true }, { n: 2, href: "#", current: false }], prevHref: null, nextHref: "#", corrected: null, personal: null,
};
const SAMPLE_CTX: Required<Omit<RenderContext, "results">> & { results: ProductCard[] } = {
  product: { id: "sample", name: "Linen mug", price: 24, stock: 12, images: [],
    description: "Thrown by hand and glazed in small batches. Holds a generous 350ml, sits warm in the palm, and goes in the dishwasher.\n\nEvery piece is slightly different.",
    specs: [{ label: "Material", value: "Stoneware" }, { label: "Capacity", value: "350 ml" }, { label: "Dishwasher safe", value: "Yes" }],
    bundle: { components: [{ name: "Linen mug", qty: 2 }, { name: "Dune plate", qty: 1 }, { name: "Stoneware bowl", qty: 1 }], savings: 11 },
    // The owner's example (Product 1): a value is a link when changing only that property leads to a product.
    variants: [
      { label: "Colour", badges: [{ label: "White", state: "selected", swatch: "#f4f1ea" }, { label: "Black", state: "link", href: "#", swatch: "#1d1d1f" }] },
      { label: "Size", badges: [{ label: "10", state: "selected" }, { label: "20", state: "link", href: "#" }, { label: "30", state: "link", href: "#" }] },
      { label: "Gender", badges: [{ label: "Female", state: "selected" }, { label: "Male", state: "disabled" }] },
      { label: "Temperature", badges: [{ label: "10º", state: "selected" }, { label: "30º", state: "link", href: "#", soldOut: true }] },
    ],
    inBundles: [{ name: "Breakfast set", price: 59 }, { name: "Tea for two", price: 72 }],
  },
  category: { name: "Mugs", slug: "mugs" }, query: "mug",
  categories: [{ name: "Mugs", slug: "mugs" }, { name: "Bowls", slug: "bowls" }, { name: "Vases", slug: "vases" }, { name: "Plates", slug: "plates" }],
  results: SAMPLE, search: SAMPLE_SEARCH,
};

interface Ctx { editor: boolean; theme: Theme; opts: RenderOptions; data: RenderContext }
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
/** Sample data only (editor and thumbnails), so designers can see and style the sale state. Real prices and offers
 *  are filled in by the storefront script from the API; they never appear in rendered HTML. */
const sampleSale = (t: Theme, now: number, was: number) =>
  `<span class="os-now">${money(t, now)}</span> <s class="os-was"><span class="os-sr">Original price </span>${money(t, was)}</s> <span class="os-badge">−${Math.round((1 - now / was) * 100)}%</span>`;
/** Hook for the storefront script: the price element of a real product. */
const priceHook = (ctx: Ctx, id: string | undefined) => (!ctx.editor && id && id !== "sample" ? ` data-os-price="${esc(id)}"` : "");

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
      const fromResults = p.source === "results";
      const items = (fromResults ? ctx.data.results ?? [] : ctx.opts.products ? ctx.opts.products(n) : SAMPLE).slice(0, limit);
      const search = fromResults ? ctx.data.search : undefined;
      const corrected = search?.corrected ? `<p class="os-corrected">Showing results for <b>${esc(search.corrected)}</b></p>` : "";
      if (!items.length) {
        const filtered = !!search?.chips.length;
        const msg = ctx.data.query ? `Nothing matches “${esc(ctx.data.query)}”${filtered ? " with these filters" : ""}. Try a different search${filtered ? ` or <a href="${esc(safeShopLink(search!.clearHref))}">remove the filters</a>` : ""}.` : filtered ? `No products match these filters. <a href="${esc(safeShopLink(search!.clearHref))}">Remove the filters</a>` : "No products to show yet.";
        return `<div ${root(n, ctx, "os-note", personalHook(ctx, search, p.cols))}>${msg}</div>`;
      }
      const pager = fromResults && p.paginate && search && search.pages > 1 ? pagerHtml(search) : "";
      const grid = `<div class="os-pg os-pg-${p.cols}" data-os-results>${cards(ctx, items)}</div>`;
      const note = search?.personal ? `<noscript><p class="os-msg">Sorted by list price. Turn on JavaScript to sort and filter by your own prices.</p></noscript>` : "";
      return `<div ${root(n, ctx, "os-pgw", personalHook(ctx, search, p.cols))}>${corrected}${note}${grid}${pager}</div>`;
    }
    case "searchFilters": return searchFilters(n, ctx);
    case "resultsBar": {
      const s = ctx.data.search;
      if (!s) return "";
      const count = p.showCount ? `<p class="os-rcount" data-os-count>${s.total} ${s.total === 1 ? "product" : "products"}</p>` : "";
      const sort = p.sort ? `<form class="os-sortf" method="get" action="${esc(safeShopLink(s.path))}" data-os-sort>${hidden(s.keep.filter(([k]) => k !== "sort"))}${filterHidden(s)}<label><span>Sort by</span> <select name="sort" aria-label="Sort by">${s.sorts.map((o) => `<option value="${esc(o.value)}"${o.value === s.sort ? " selected" : ""}>${esc(o.label)}</option>`).join("")}</select></label> <button class="os-btn os-btn--ghost os-btn--sm os-apply"${ctx.editor ? ' type="button"' : ""}>Sort</button></form>` : "";
      return count || sort ? `<div ${root(n, ctx, "os-rbar")}>${count}${sort}</div>` : "";
    }
    case "productSpecs": {
      const specs = ctx.data.product?.specs ?? [];
      if (!specs.length) return ctx.editor ? `<div ${root(n, ctx, "os-note")}>Product details: properties marked "shown on the product page"</div>` : "";
      return `<section ${root(n, ctx, "os-specs")}><h3 class="os-specs-h">${esc(p.heading)}</h3><dl>${specs.map((x) => `<div><dt>${esc(x.label)}</dt><dd>${esc(x.value)}</dd></div>`).join("")}</dl></section>`;
    }
    case "bundleContents": {
      const b = ctx.data.product?.bundle;
      if (!b?.components.length) return "";
      const items = b.components.map((c, i) => {
        const img = safeImage(c.image);
        const visual = p.images ? `<span class="os-bc-img">${img ? `<img src="${esc(img)}" alt="" loading="lazy" decoding="async">` : art(CARD_ART[(hash(c.name) + i) % CARD_ART.length])}</span>` : "";
        const name = c.href && !ctx.editor ? `<a href="${esc(safeProductLink(c.href))}">${esc(c.name)}</a>` : esc(c.name);
        return `<li>${visual}<span class="os-bc-q">${c.qty} ×</span> <span class="os-bc-n">${name}</span></li>`;
      }).join("");
      const save = b.savings && b.savings > 0 ? `<p class="os-bc-save">Save ${money(ctx.theme, b.savings)} compared with buying separately</p>` : "";
      return `<section ${root(n, ctx, "os-bc")}><h3 class="os-specs-h">${esc(p.heading)}</h3><ul>${items}</ul>${save}</section>`;
    }
    case "productBundles": {
      const list = (ctx.data.product?.inBundles ?? []).slice(0, p.limit as number);
      if (!list.length) return ctx.editor ? `<div ${root(n, ctx, "os-note")}>Bundles that contain this product appear here</div>` : "";
      return `<section ${root(n, ctx, "os-inb")}><h3 class="os-specs-h">${esc(p.heading)}</h3><div class="os-pg os-pg-${p.cols}">${cards(ctx, list)}</div></section>`;
    }
    case "productVariants": {
      const lines = ctx.data.product?.variants ?? [];
      if (!lines.length) return "";
      const body = lines.map((l, i) => {
        const id = `v${n.id}-${i}`;
        const badges = l.badges.map((b) => {
          const sw = p.swatches ? safeColor(b.swatch) : undefined;
          const dot = sw ? `<i class="os-vsw" style="background:${sw}"></i>` : "";
          const sold = b.soldOut && p.showSoldOut ? `<small class="os-vso"> · sold out</small>` : "";
          if (b.state === "selected") return `<span class="os-vb is-selected" aria-current="true">${dot}${esc(b.label)}${sold}</span>`;
          if (b.state === "link" && !ctx.editor) return `<a class="os-vb" href="${esc(safeProductLink(b.href))}" aria-label="${esc(`${l.label}: ${b.label}`)}${b.soldOut ? ", sold out" : ""}">${dot}${esc(b.label)}${sold}</a>`;
          if (b.state === "link") return `<span class="os-vb">${dot}${esc(b.label)}${sold}</span>`;
          return `<span class="os-vb is-disabled is-${p.disabledStyle}" aria-disabled="true">${dot}${esc(b.label)}<span class="os-sr"> (not available with the current choices)</span></span>`;
        }).join("");
        return `<div class="os-var" role="group" aria-labelledby="${id}"><span class="os-var-l" id="${id}">${esc(l.label)}</span><span class="os-var-vs">${badges}</span></div>`;
      }).join("");
      return `<div ${root(n, ctx, "os-vars")}>${body}</div>`;
    }
    case "productTitle": {
      const pr = ctx.data.product; if (!pr) return "";
      return `<h${p.level} ${root(n, ctx, `os-h os-h${p.level}`)}>${esc(pr.name)}</h${p.level}>`;
    }
    case "productPrice": {
      const pr = ctx.data.product; if (!pr) return "";
      const sample = pr === SAMPLE_CTX.product;
      return `<div ${root(n, ctx, "os-price", priceHook(ctx, pr.id))}>${sample ? sampleSale(ctx.theme, pr.price, 30) : money(ctx.theme, pr.price)}</div>`;
    }
    case "productOffers": {
      const pr = ctx.data.product; if (!pr) return "";
      if (pr === SAMPLE_CTX.product) {
        return `<div ${root(n, ctx, "os-offers")}><p class="os-offers-h">${esc(p.heading)}</p><p class="os-offer os-offer--on"><b>Spring sale</b> <span>−20% · ${money(ctx.theme, pr.price)}</span><small>Applied. Ends 31 May, 23:59 (shop time)</small></p><p class="os-offer"><b>Members price</b> <span>−10% · ${money(ctx.theme, 27)}</span><small>Also available</small></p></div>`;
      }
      // Empty container: the storefront script lists the offers that apply to this visitor.
      return `<div ${root(n, ctx, "os-offers", ` data-os-offers="${esc(pr.id)}" data-heading="${esc(p.heading)}" aria-live="polite"`)} hidden></div>`;
    }
    case "productDescription": { const pr = ctx.data.product; return pr?.description ? `<p ${root(n, ctx, "os-p")}>${esc(pr.description)}</p>` : ""; }
    case "productGallery": {
      const pr = ctx.data.product; if (!pr) return "";
      const imgs = (pr.images ?? []).map(safeImage).filter(Boolean);
      const vis = (i: number) => imgs[i] ? `<img src="${esc(imgs[i])}" alt="${esc(pr.name)}" loading="lazy" decoding="async">` : art(CARD_ART[(hash(pr.name) + i) % CARD_ART.length]);
      const count = Math.max(imgs.length, 1);
      const thumbs = count > 1 ? `<div class="os-pgal-t">${Array.from({ length: Math.min(count, 5) - 1 }, (_, i) => `<figure class="os-fig" style="--ratio:1/1;--fit:cover">${vis(i + 1)}</figure>`).join("")}</div>` : "";
      return `<div ${root(n, ctx, "os-pgal")}><figure class="os-fig" style="--ratio:${p.ratio === "auto" ? "auto" : p.ratio};--fit:cover">${vis(0)}</figure>${thumbs}</div>`;
    }
    case "addToCart": {
      const pr = ctx.data.product; if (!pr) return "";
      const out = pr.stock !== undefined && pr.stock <= 0;
      const qty = p.qty && !out ? `<input class="os-qty" type="number" name="qty" value="1" min="1" max="${Math.min(pr.stock ?? 99, 99)}" aria-label="Quantity">` : `<input type="hidden" name="qty" value="1">`;
      return `<form ${root(n, ctx, "os-atc")} method="post" action="/shop/cart/add"><input type="hidden" name="productId" value="${esc(pr.id)}">${qty}<button class="os-btn os-btn--solid os-btn--lg"${out ? " disabled" : ""}${ctx.editor ? ' type="button"' : ""}${ed(ctx, "label")}>${out ? "Out of stock" : esc(p.label)}</button></form>`;
    }
    case "searchBox":
      return `<form ${root(n, ctx, "os-search")} method="get" action="/search" role="search"><input type="search" name="q" value="${esc(ctx.data.query ?? "")}" placeholder="${esc(p.placeholder)}" aria-label="Search"><button class="os-btn os-btn--solid"${ctx.editor ? ' type="button"' : ""}${ed(ctx, "button")}>${esc(p.button)}</button></form>`;
    case "dynamicTitle": {
      const text = p.source === "search" ? (ctx.data.query ? `Results for “${ctx.data.query}”` : "Search") : ctx.data.category?.name ?? "All products";
      return `<h${p.level} ${root(n, ctx, `os-h os-h${p.level}`)}>${esc(text)}</h${p.level}>`;
    }
    case "categoryNav": {
      const cats = ctx.data.categories ?? [];
      const cur = ctx.data.category?.slug ?? "";
      const link = (href: string, label: string, on: boolean) => `<a href="${href}"${on ? ' class="on" aria-current="page"' : ""}>${esc(label)}</a>`;
      return `<nav ${root(n, ctx, `os-cnav os-cnav--${p.layout}`)} aria-label="Categories">${link("/shop", "All", !cur)}${cats.map((c) => link(`/shop/category/${encodeURIComponent(c.slug)}`, c.name, c.slug === cur)).join("")}</nav>`;
    }
    default:
      throw new Error(`Unknown widget: ${n.type}`);
  }
}

/** Product cards (grids, results, "As seen in these bundles"). Prices are list prices; the storefront script adds offers. */
function cards(ctx: Ctx, items: ProductCard[]): string {
  const offset = hash(items[0].name) % CARD_ART.length;
  return items.map((it, i) => {
    const img = safeImage(it.image);
    const visual = img ? `<img src="${esc(img)}" alt="${esc(it.name)}" loading="lazy" decoding="async">` : art(CARD_ART[(offset + i) % CARD_ART.length]);
    const tag = ctx.editor || !it.href ? "div" : "a";
    const sold = it.soldOut ? `<div class="os-pc-s">Out of stock</div>` : "";
    return `<${tag} class="os-pc"${tag === "a" ? ` href="${esc(safeUrl(it.href))}"` : ""}><div class="os-pc-img">${visual}</div><div><div class="os-pc-n">${esc(it.name)}</div><div class="os-pc-p"${priceHook(ctx, it.id)}>${it === SAMPLE[0] ? sampleSale(ctx.theme, it.price, 30) : money(ctx.theme, it.price)}</div>${sold}</div></${tag}>`;
  }).join("");
}

/** S-2a: when results are sorted or filtered by price, the storefront script reloads them with the visitor's prices. */
const personalHook = (ctx: Ctx, s: SearchState | undefined, cols = 3) => (!ctx.editor && s?.personal ? ` data-os-search="${esc(s.personal)}" data-os-cols="${cols}"` : "");
const hidden = (pairs: [string, string][]) => pairs.map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
/** The current filters as hidden fields (so changing the sort keeps them). */
function filterHidden(s: SearchState): string {
  const out: [string, string][] = [];
  for (const f of s.facets) for (const o of f.options) if (o.selected) out.push([f.param, o.value]);
  if (s.price.min !== null) out.push(["min", String(s.price.min)]);
  if (s.price.max !== null) out.push(["max", String(s.price.max)]);
  if (s.inStock?.selected) out.push(["stock", "in"]);
  return hidden(out);
}
function pagerHtml(s: SearchState): string {
  const link = (href: string | null, label: string, rel: string) => (href ? `<a href="${esc(safeShopLink(href))}" rel="${rel}">${label}</a>` : `<span aria-disabled="true">${label}</span>`);
  const nums = s.pageLinks.map((l) => (l.current ? `<span aria-current="page">${l.n}</span>` : `<a href="${esc(safeShopLink(l.href))}">${l.n}</a>`)).join("");
  return `<nav class="os-pager" aria-label="Pages" data-os-pager>${link(s.prevHref, "← Previous", "prev")}${nums}${link(s.nextHref, "Next →", "next")}</nav>`;
}

/**
 * Filters on category and search pages: a GET form, so it works without JavaScript (an Apply button the storefront
 * script hides when it applies filters as soon as they change). Values come with counts; active filters are chips.
 */
function searchFilters(n: Node, ctx: Ctx): string {
  const s = ctx.data.search;
  if (!s) return "";
  const p = P(n);
  const max = p.maxValues as number;
  const groups: string[] = [];
  for (const f of s.facets) {
    if (f.key === "category" && !p.category) continue;
    if (!f.options.length) continue;
    const opts = f.options.map((o, i) => {
      const sw = safeColor(o.swatch);
      const more = i >= max && !o.selected ? " os-more" : "";
      return `<label class="os-fo${more}"><input type="checkbox" name="${esc(f.param)}" value="${esc(o.value)}"${o.selected ? " checked" : ""}>${sw ? `<i class="os-vsw" style="background:${sw}"></i>` : ""}<span>${esc(o.label)}</span><small>${o.count}</small></label>`;
    }).join("");
    const moreBtn = f.options.filter((o, i) => i >= max && !o.selected).length ? `<details class="os-fmore"><summary>Show all ${f.options.length}</summary></details>` : "";
    groups.push(`<fieldset class="os-facet"><legend>${esc(f.label)}</legend>${opts}${moreBtn}</fieldset>`);
  }
  if (p.price && s.price.bounds) {
    const b = s.price.bounds;
    groups.push(`<fieldset class="os-facet os-fprice"><legend>Price</legend><label><span class="os-sr">Minimum price</span><input type="number" name="min" min="0" step="0.01" inputmode="decimal" placeholder="${esc(money(ctx.theme, b.min))}" value="${s.price.min ?? ""}"></label><span>–</span><label><span class="os-sr">Maximum price</span><input type="number" name="max" min="0" step="0.01" inputmode="decimal" placeholder="${esc(money(ctx.theme, b.max))}" value="${s.price.max ?? ""}"></label></fieldset>`);
  }
  if (p.availability && s.inStock) groups.push(`<fieldset class="os-facet"><legend>Availability</legend><label class="os-fo"><input type="checkbox" name="stock" value="in"${s.inStock.selected ? " checked" : ""}><span>In stock</span><small>${s.inStock.count}</small></label></fieldset>`);
  if (!groups.length) return ctx.editor ? `<div ${root(n, ctx, "os-note")}>Filters appear here when products have filterable properties</div>` : "";
  const chips = s.chips.length ? `<div class="os-chips">${s.chips.map((c) => `<a class="os-chip" href="${esc(safeShopLink(c.href))}">${esc(c.label)}<span aria-hidden="true"> ✕</span><span class="os-sr"> (remove)</span></a>`).join("")}<a class="os-chip os-chip--clear" href="${esc(safeShopLink(s.clearHref))}">Clear all</a></div>` : "";
  const editorType = ctx.editor ? ' type="button"' : "";
  return `<div ${root(n, ctx, `os-filters os-filters--${p.layout}`)}><form method="get" action="${esc(safeShopLink(s.path))}" data-os-filters><h3 class="os-specs-h">${esc(p.heading)}</h3>${chips}${hidden(s.keep)}${groups.join("")}<button class="os-btn os-btn--solid os-btn--sm os-apply"${editorType}>Apply</button></form></div>`;
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

/** The currency for the storefront script, and the script itself (published pages only). */
function shopHead(t: Theme, script: boolean | undefined): string {
  return script ? `<meta name="os-currency" content="${esc(t.currency)}"><script src="${SHOP_SCRIPT}" defer></script>` : "";
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

const stripUndefined = (o: RenderContext): RenderContext => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as RenderContext;

export interface RenderedParts { head: string; css: string; body: string }

/** Head tags + CSS + body markup separately, so the editor can swap them in place without reloading its iframe. */
export function renderParts(input: PageDoc, opts: RenderOptions = {}): RenderedParts {
  const doc = withDefaults(normalizeDoc(input));
  const theme = normTheme(doc.theme);
  const sample = !!opts.editor || !!opts.sample;
  const data: RenderContext = { ...(sample ? SAMPLE_CTX : {}), ...stripUndefined(opts.context ?? {}) };
  const ctx: Ctx = { editor: !!opts.editor, theme, opts, data };
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
  const canonical = opts.meta?.canonical ? safeShopLink(opts.meta.canonical) : "#";
  const meta = (opts.meta?.noindex ? `<meta name="robots" content="noindex,follow">` : "") + (canonical !== "#" ? `<link rel="canonical" href="${esc(canonical)}">` : "");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${meta}${head}${shopHead(normTheme(normalizeDoc(doc).theme), opts.shopScript && !opts.editor)}<style>${css}</style></head><body class="os${opts.editor ? " os-editor" : ""}"><main>${body}</main></body></html>`;
}

/** Shell for storefront pages (shop, cart, checkout) so they share the theme and fonts. */
export function renderDocument(title: string, bodyHtml: string, theme: Partial<Theme> = DEFAULT_THEME, opts: { shopScript?: boolean } = {}): string {
  const t = normTheme(theme);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="${FONTS[t.font].href}">${shopHead(t, !!opts.shopScript)}<style>${themeVars(t)}${BASE_CSS}</style></head><body class="os"><nav class="os-shell-nav"><a href="/">Home</a><a href="/shop">Shop</a><a href="/shop/cart">Cart</a><a href="/shop/account">Account</a></nav><main class="os-shell">${bodyHtml}</main></body></html>`;
}

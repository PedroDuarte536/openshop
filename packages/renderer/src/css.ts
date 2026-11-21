import { ART, FONTS } from "./presets.ts";
import type { Background, Device, Node, Style, Theme } from "./model.ts";
import { safeColor, safeImage } from "./model.ts";

export const BP = { tablet: 1024, mobile: 640 } as const;

function lum(hex: string): number {
  let h = hex.replace("#", "");
  if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const isHex = (c: string) => /^#[0-9a-f]{3,8}$/i.test(c);

/** Replaces var(--x) with the theme's actual colour so we can reason about contrast. */
function resolve(c: string, t: Theme): string {
  const m = /^var\(--(primary|accent|text|bg|surface)\)$/.exec(c);
  return m ? t[m[1] as "primary"] : c;
}

export function themeVars(t: Theme): string {
  const f = FONTS[t.font];
  const onPrimary = lum(t.primary) > 0.45 ? "#111318" : "#ffffff";
  return `:root{--primary:${t.primary};--on-primary:${onPrimary};--text:${t.text};--bg:${t.bg};--surface:${t.surface};--accent:${t.accent};--radius:${t.radius}px;--font-head:${f.head};--font-body:${f.body};--muted:color-mix(in srgb,var(--text) 64%,var(--bg));--line:color-mix(in srgb,var(--text) 14%,transparent)}`;
}

export function bgIsDark(bg: Background | undefined, t: Theme): boolean {
  if (!bg) return false;
  if (bg.kind === "preset") return ART[bg.preset ?? "aurora"].dark;
  if (bg.kind === "image") return (bg.overlay ?? 0) >= 0.35;
  const dark = (c?: string) => { const r = c ? resolve(c, t) : ""; return isHex(r) && lum(r) < 0.18; };
  if (bg.kind === "color") return dark(bg.color);
  if (bg.kind === "gradient") return dark(bg.from) && dark(bg.to);
  return false;
}

function bgCss(bg: Background): string {
  switch (bg.kind) {
    case "none": return "background:none";
    case "color": return `background:${safeColor(bg.color) ?? "transparent"}`;
    case "gradient": return `background:linear-gradient(${bg.angle ?? 135}deg,${safeColor(bg.from) ?? "#2B4BFF"},${safeColor(bg.to) ?? "#FF7AC6"})`;
    case "preset": return `background:${ART[bg.preset ?? "aurora"].css}`;
    case "image": {
      const u = safeImage(bg.image);
      if (!u) return "";
      const o = bg.overlay ?? 0;
      return `background:${o ? `linear-gradient(rgba(10,12,20,${o}),rgba(10,12,20,${o})),` : ""}url("${u}") center/cover no-repeat`;
    }
  }
}

const SHADOW = ["none", "0 1px 2px rgba(16,24,40,.06),0 1px 3px rgba(16,24,40,.1)", "0 12px 28px -10px rgba(16,24,40,.22)", "0 32px 64px -20px rgba(16,24,40,.38)"];
const JUSTIFY = { top: "flex-start", center: "center", bottom: "flex-end" } as const;
const ALIGN_ITEMS = { top: "start", center: "center", bottom: "end" } as const;
const ALIGN_FLEX = { left: "flex-start", center: "center", right: "flex-end" } as const;

/** CSS rules for one node at one device. `.n-ID` is the node's own class. */
/** `fluid` scales headings with the viewport (desktop base only). Explicit tablet/mobile sizes are exact px. */
export function nodeRules(node: Node, st: Style, fluid = false): string {
  const c = `.n-${node.id}`;
  const main: string[] = [], inner: string[] = [], grid: string[] = [];
  const isSection = node.type === "section", isCol = node.type === "column";
  const px = (k: keyof Style, prop: string, into = main) => { const v = st[k]; if (typeof v === "number") into.push(`${prop}:${v}px`); };
  px("padT", "padding-top"); px("padR", "padding-right"); px("padB", "padding-bottom"); px("padL", "padding-left");
  px("marT", "margin-top"); px("marB", "margin-bottom");
  if (st.color) main.push(`color:${st.color}`);
  if (st.bg) { const b = bgCss(st.bg); if (b) main.push(b); }
  if (st.radius !== undefined) { main.push(`border-radius:${st.radius}px`); if (isSection || isCol || node.type === "image" || node.type === "gallery") main.push("overflow:hidden"); }
  if (st.shadow !== undefined) main.push(`box-shadow:${SHADOW[st.shadow]}`);
  if (st.align) main.push(`text-align:${st.align}`);
  if (st.align && node.type === "button") main.push(`justify-content:${ALIGN_FLEX[st.align]}`);
  if (st.weight) main.push(`font-weight:${st.weight}`);
  if (st.size) {
    if (node.type === "heading" && fluid) main.push(`font-size:clamp(${Math.max(18, Math.round(st.size * 0.5))}px,${(st.size / 12.8).toFixed(2)}vw,${st.size}px)`);
    else main.push(`font-size:${st.size}px`);
  }
  if (typeof st.minH === "number") {
    if (node.type === "spacer") main.push(`height:${st.minH}px`);
    else main.push(`min-height:${st.minH}px`);
  }
  if (isSection) {
    if (typeof st.maxW === "number") inner.push(`max-width:${st.maxW}px`);
    px("gap", "gap", grid);
    if (st.valign) grid.push(`align-items:${ALIGN_ITEMS[st.valign]}`);
  } else if (isCol) {
    if (st.span) main.push(`grid-column:span ${st.span}`);
    px("gap", "gap");
    if (st.dir === "row") main.push("flex-direction:row", "flex-wrap:wrap", "align-items:center");
    else if (st.dir === "col") main.push("flex-direction:column", "flex-wrap:nowrap", "align-items:stretch");
    const row = st.dir === "row";
    if (st.valign) main.push(row ? `align-items:${ALIGN_FLEX[st.valign === "top" ? "left" : st.valign === "center" ? "center" : "right"]}` : `justify-content:${JUSTIFY[st.valign]}`);
    if (st.align && row) main.push(`justify-content:${ALIGN_FLEX[st.align]}`);
  } else if (typeof st.maxW === "number") {
    const left = st.align === "center" || st.align === "right" ? "auto" : "0";
    const right = st.align === "right" ? "0" : "auto";
    main.push(`max-width:${st.maxW}px`, `margin-left:${left}`, `margin-right:${right}`);
  }
  let out = main.length ? `${c}{${main.join(";")}}` : "";
  if (inner.length) out += `${c} .os-inner{${inner.join(";")}}`;
  if (grid.length) out += `${c} .os-grid{${grid.join(";")}}`;
  if (isCol && st.align && st.dir !== "row") out += `${c} .os-btnw{justify-content:${ALIGN_FLEX[st.align]}}`;
  if (node.type === "image" && typeof st.minH === "number") out += `${c} img,${c} .os-art{min-height:${st.minH}px}`;
  return out;
}

/** Visibility rules use independent device ranges (not the desktop-first cascade), so "hide on tablet only" works. */
export function hideRules(node: Node, editor: boolean): string {
  if (!node.hide?.length) return "";
  const q: Record<Device, string> = {
    desktop: `(min-width:${BP.tablet + 1}px)`,
    tablet: `(min-width:${BP.mobile + 1}px) and (max-width:${BP.tablet}px)`,
    mobile: `(max-width:${BP.mobile}px)`,
  };
  const body = editor ? "opacity:.26;outline:1.5px dashed rgba(120,130,160,.8);outline-offset:-2px" : "display:none!important";
  return node.hide.map((d) => `@media ${q[d]}{.n-${node.id}{${body}}}`).join("");
}

export const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body.os{margin:0;background:var(--bg);color:var(--text);font:400 17px/1.6 var(--font-body);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
.os img{max-width:100%;display:block}
.os [hidden]{display:none!important}
.os :focus-visible{outline:3px solid color-mix(in srgb,var(--primary) 50%,transparent);outline-offset:3px;border-radius:4px}
.os-dark{--text:#fff;--muted:rgba(255,255,255,.74);--line:rgba(255,255,255,.2);color:var(--text)}
.os-section{position:relative;display:flex;flex-direction:column;justify-content:center;padding:84px 28px;color:var(--text)}
.os-inner{width:100%;max-width:1160px;margin:0 auto}
.os-full .os-inner{max-width:none}
.os-grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:32px 40px}
.os-col{grid-column:span 12;display:flex;flex-direction:column;gap:18px;min-width:0}
.os-h{margin:0;font-family:var(--font-head);font-weight:700;line-height:1.06;letter-spacing:-.025em;text-wrap:balance}
.os-h1{font-size:clamp(40px,6.2vw,76px)}.os-h2{font-size:clamp(30px,4vw,50px)}.os-h3{font-size:clamp(23px,2.6vw,32px);line-height:1.15}.os-h4{font-size:20px;line-height:1.2;letter-spacing:-.01em}
.os-grad{background:linear-gradient(100deg,var(--primary),var(--accent));-webkit-background-clip:text;background-clip:text;color:transparent}
.os-p{margin:0;white-space:pre-line;color:var(--muted);text-wrap:pretty}
.os-btnw{display:flex;flex-wrap:wrap;align-items:center;gap:12px}
.os-btn{display:inline-flex;align-items:center;justify-content:center;gap:.55em;font:600 1em/1 var(--font-body);padding:.95em 1.55em;border-radius:calc(var(--radius)*1.5);text-decoration:none;border:1.5px solid transparent;cursor:pointer;transition:transform .2s cubic-bezier(.2,.8,.2,1),box-shadow .2s,background-color .2s,color .2s}
.os-btn:hover{transform:translateY(-2px)}
.os-btn--sm{font-size:.88rem}.os-btn--md{font-size:1rem}.os-btn--lg{font-size:1.12rem;padding:1.05em 1.8em}
.os-btn--solid{background:var(--primary);color:var(--on-primary)}
.os-btn--solid:hover{box-shadow:0 10px 24px -8px color-mix(in srgb,var(--primary) 70%,transparent)}
.os-btn--outline{border-color:currentColor;color:inherit;background:transparent}
.os-btn--outline:hover{background:color-mix(in srgb,currentColor 10%,transparent)}
.os-btn--soft{background:color-mix(in srgb,var(--primary) 13%,transparent);color:var(--primary)}
.os-btn--soft:hover{background:color-mix(in srgb,var(--primary) 22%,transparent)}
.os-btn--ghost{background:transparent;color:inherit}
.os-btn--ghost:hover{background:color-mix(in srgb,currentColor 9%,transparent)}
.os-dark .os-btn--solid{background:#fff;color:#111318}
.os-dark .os-btn--soft{background:rgba(255,255,255,.16);color:#fff}
.os-fig{display:block;margin:0;border-radius:var(--radius);overflow:hidden;width:100%}
.os-fig img,.os-art{display:block;width:100%;height:100%;object-fit:var(--fit,cover);aspect-ratio:var(--ratio,auto)}
.os-art{min-height:120px}
.os-hr{border:0;border-top:1px solid;color:var(--line);width:100%;margin:0}
.os-spacer{height:40px}
.os-ib{display:flex;gap:16px;align-items:flex-start;flex-direction:column}
.os-ib--left{flex-direction:row}
.os-ib-ic{flex:none;display:grid;place-items:center;width:3em;height:3em;border-radius:calc(var(--radius)*1.2);background:color-mix(in srgb,var(--primary) 13%,transparent);color:var(--primary);font-size:1.5em}
.os-dark .os-ib-ic{background:rgba(255,255,255,.14);color:#fff}
.os-ib-t{margin:0 0 .3em;font:700 1.18em/1.25 var(--font-head);letter-spacing:-.01em}
.os-ib-p{margin:0;color:var(--muted);white-space:pre-line}
.os-stat-v{font:700 3.4em/1 var(--font-head);letter-spacing:-.03em}
.os-stat-l{margin-top:.5em;color:var(--muted)}
.os-tm{margin:0;display:flex;flex-direction:column;gap:20px}
.os-tm blockquote{margin:0;font:500 1.28em/1.45 var(--font-head);letter-spacing:-.01em;text-wrap:pretty}
.os-tm figcaption{display:flex;align-items:center;gap:12px;font-size:.92em}
.os-tm figcaption b{display:block;font-weight:600}
.os-tm figcaption small{color:var(--muted);font-size:1em}
.os-av{flex:none;display:grid;place-items:center;width:2.6em;height:2.6em;border-radius:50%;background:linear-gradient(135deg,var(--primary),var(--accent));color:var(--on-primary);font-weight:700}
.os-faq details{border-top:1px solid var(--line)}
.os-faq details:last-child{border-bottom:1px solid var(--line)}
.os-faq summary{list-style:none;cursor:pointer;display:flex;justify-content:space-between;gap:20px;align-items:center;padding:1.15em 0;font:600 1.08em/1.35 var(--font-head)}
.os-faq summary::-webkit-details-marker{display:none}
.os-faq summary::after{content:"";flex:none;width:.6em;height:.6em;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(45deg) translateY(-2px);transition:transform .25s}
.os-faq details[open] summary::after{transform:rotate(-135deg)}
.os-faq details p{margin:0 0 1.2em;color:var(--muted);white-space:pre-line;max-width:60ch}
.os-gal{display:grid;grid-template-columns:repeat(var(--c,4),minmax(0,1fr));gap:12px}
.os-gal .os-fig{border-radius:calc(var(--radius)*.8)}
.os-pg{display:grid;grid-template-columns:repeat(var(--c,4),minmax(0,1fr));gap:36px 24px}
.os-pg-2{--c:2}.os-pg-3{--c:3}.os-pg-4{--c:4}.os-pg-5{--c:5}
.os-pc{display:flex;flex-direction:column;gap:14px;color:inherit;text-decoration:none}
.os-pc-img{aspect-ratio:4/5;border-radius:calc(var(--radius)*1.2);overflow:hidden;background:var(--surface)}
.os-pc-img img,.os-pc-img .os-art{width:100%;height:100%;object-fit:cover;transition:transform .6s cubic-bezier(.2,.8,.2,1)}
.os-pc:hover .os-pc-img img,.os-pc:hover .os-pc-img .os-art{transform:scale(1.045)}
.os-pc-n{font:600 1.04em/1.3 var(--font-head)}
.os-pc-p{color:var(--muted);font-size:.95em;margin-top:2px}
.os-price{font:700 1.7em/1.1 var(--font-head);letter-spacing:-.015em}
.os-now{color:var(--text)}
.os-was{color:var(--muted);font-weight:500;font-size:.8em;margin-left:.2em}
.os-badge{display:inline-block;margin-left:.35em;padding:.15em .5em;border-radius:99px;background:var(--accent);color:var(--text);font:700 .72em/1.3 var(--font-body);vertical-align:middle;letter-spacing:0}
.os-price .os-badge{font-size:.42em}
.os-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.os-offers{display:grid;gap:8px;padding:14px 16px;border:1.5px solid var(--line);border-radius:var(--radius);background:var(--surface)}
.os-offers[hidden]{display:none}
.os-offers-h{margin:0;font:700 .8em/1.2 var(--font-body);text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.os-offer{margin:0;display:grid;grid-template-columns:1fr auto;gap:2px 12px;align-items:baseline;color:var(--muted)}
.os-offer b{color:var(--text);font-weight:600}
.os-offer small{grid-column:1/-1;font-size:.82em}
.os-offer--on b::before{content:"✓ ";color:var(--primary)}
.os-offer--on span{color:var(--text);font-weight:700}
.os-cart-pricing{display:grid;gap:14px;margin:20px 0}
.os-cart-pricing fieldset{border:1.5px solid var(--line);border-radius:var(--radius);padding:12px 16px;margin:0;display:grid;gap:8px}
.os-cart-pricing legend{font-weight:700;padding:0 4px}
.os-cart-pricing label{display:flex;gap:10px;align-items:baseline;cursor:pointer}
.os-cart-pricing .os-msg{margin:0;color:var(--muted)}
.os-cart-pricing .os-msg--bad{color:#B42318}
.os-codeform{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.os-codeform input{max-width:220px;text-transform:uppercase}
.os-linkbtn{background:none!important;border:0!important;color:var(--primary)!important;padding:0 4px!important;text-decoration:underline;cursor:pointer;font-weight:600}
.os-line-offers{font-size:.86em;color:var(--muted)}
.os-line-offers summary{cursor:pointer}
.os-line-offers ul{margin:6px 0 0;padding-left:18px}
.os-account-offers{margin-bottom:24px}
.os-pgal{display:grid;gap:12px}.os-pgal-t{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.os-pgal-t .os-fig{border-radius:calc(var(--radius)*.7)}
.os-atc{display:flex;gap:10px;flex-wrap:wrap;align-items:stretch}
.os-qty,.os-search input{padding:.9em 1.1em;border:1.5px solid var(--line);border-radius:calc(var(--radius)*1.5);background:var(--bg);color:inherit;font:inherit}
.os-qty{width:92px}
.os-search{display:flex;gap:10px;align-items:stretch;max-width:560px}.os-search input{flex:1;min-width:0}
.os-search--sug{position:relative}
.os-sug{position:absolute;z-index:20;top:calc(100% + 6px);left:0;right:0;max-height:70vh;overflow:auto;padding:6px;background:var(--bg);color:var(--text);border:1.5px solid var(--line);border-radius:calc(var(--radius)*1.5);box-shadow:0 12px 32px rgba(0,0,0,.14)}
.os-sug-h{padding:8px 10px 4px;font-size:.75em;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.os-sug-o{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:var(--radius);color:inherit;text-decoration:none}
.os-sug-o:hover,.os-sug-o[aria-selected=true]{background:var(--surface)}
.os-sug-o img,.os-sug-i{width:36px;height:36px;flex:none;border-radius:6px;object-fit:cover;background:var(--surface)}
.os-sug-o small{margin-left:auto;color:var(--muted)}
.os-sug-c{margin:0;padding:8px 10px;color:var(--muted);font-size:.9em}
.os-cnav{display:flex;flex-wrap:wrap;gap:8px}
.os-cnav a{padding:.5em 1.05em;border-radius:99px;border:1.5px solid var(--line);color:inherit;text-decoration:none;font-weight:600;font-size:.92em;transition:background-color .15s,color .15s,border-color .15s}
.os-cnav a:hover,.os-cnav a.on{background:var(--text);color:var(--bg);border-color:var(--text)}
.os-cnav--list{flex-direction:column;gap:2px}.os-cnav--list a{border:0;border-radius:8px;padding:.45em .7em}
.os-pgw{display:grid;gap:20px}
.os-art--plain{width:100%;height:100%;background:var(--surface)}
.os-corrected{margin:0;color:var(--muted)}
.os-pc-s{font-size:.82em;font-weight:600;color:var(--muted);margin-top:2px}
.os-rbar{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.os-rcount{margin:0;color:var(--muted);font-weight:600}
.os-sortf{display:flex;align-items:center;gap:8px}.os-sortf label{display:flex;align-items:center;gap:8px;color:var(--muted)}
.os-sortf select,.os-fprice input{padding:.55em .8em;border:1.5px solid var(--line);border-radius:calc(var(--radius)*.9);background:var(--bg);color:inherit;font:inherit}
.os-filters form{display:grid;gap:18px}
.os-filters--bar form{grid-template-columns:repeat(auto-fill,minmax(190px,1fr));align-items:start}
.os-filters--bar .os-specs-h,.os-filters--bar .os-chips{grid-column:1/-1}
.os-facet{border:0;margin:0;padding:0;display:grid;gap:6px;min-width:0}
.os-facet legend{font:700 .8em/1.2 var(--font-body);text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:6px;padding:0}
.os-fo{display:flex;align-items:center;gap:8px;cursor:pointer}.os-fo span{flex:1}.os-fo small{color:var(--muted)}
.os-fo input{accent-color:var(--primary);width:1.05em;height:1.05em}
.os-facet:not(:has(.os-fmore[open])) .os-more{display:none}
.os-fmore summary{cursor:pointer;color:var(--primary);font-weight:600;font-size:.9em}
.os-fprice{grid-template-columns:1fr auto 1fr;align-items:center}.os-fprice legend{grid-column:1/-1}.os-fprice input{width:100%;min-width:0}
.os-chips{display:flex;flex-wrap:wrap;gap:6px}
.os-chip{display:inline-flex;align-items:center;gap:4px;padding:.35em .8em;border-radius:99px;background:var(--surface);color:inherit;text-decoration:none;font-size:.9em;font-weight:600}
.os-chip--clear{background:none;text-decoration:underline}
.os-pager{display:flex;align-items:center;justify-content:center;gap:6px;flex-wrap:wrap}
.os-pager a,.os-pager span{display:inline-grid;place-items:center;min-width:2.4em;padding:.45em .8em;border-radius:calc(var(--radius)*.9);text-decoration:none;color:inherit}
.os-pager a{border:1.5px solid var(--line)}.os-pager [aria-current]{background:var(--primary);color:var(--on-primary);font-weight:700}.os-pager [aria-disabled]{opacity:.4}
.os-specs-h{margin:0 0 10px;font:700 .8em/1.2 var(--font-body);text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.os-specs dl{margin:0;display:grid;gap:0}.os-specs dl>div{display:grid;grid-template-columns:minmax(120px,40%) 1fr;gap:12px;padding:10px 0;border-bottom:1px solid var(--line)}
.os-specs dt{color:var(--muted)}.os-specs dd{margin:0;font-weight:600}
.os-bc ul{list-style:none;margin:0;padding:0;display:grid;gap:10px}.os-bc li{display:flex;align-items:center;gap:12px}
.os-bc-img{width:52px;height:52px;border-radius:calc(var(--radius)*.8);overflow:hidden;flex:none;background:var(--surface)}.os-bc-img img,.os-bc-img .os-art{width:100%;height:100%;object-fit:cover}
.os-bc-q{font-weight:700;color:var(--muted)}.os-bc-n a{color:inherit}
.os-bc-save{margin:12px 0 0;font-weight:700;color:var(--primary)}
.os-vars{display:grid;gap:14px}
.os-var{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.os-var-l{min-width:7em;font-weight:700}
.os-var-vs{display:flex;flex-wrap:wrap;gap:6px}
.os-vb{display:inline-flex;align-items:center;gap:6px;padding:.42em .9em;border:1.5px solid var(--line);border-radius:99px;color:inherit;text-decoration:none;font-weight:600;font-size:.95em;transition:border-color .15s}
a.os-vb:hover{border-color:var(--primary)}
.os-vb.is-selected{border-color:var(--primary);background:color-mix(in srgb,var(--primary) 10%,transparent)}
.os-vb.is-disabled{opacity:.42;cursor:not-allowed}.os-vb.is-struck{text-decoration:line-through}
.os-vsw{width:.95em;height:.95em;border-radius:50%;box-shadow:0 0 0 1px var(--line);flex:none}
.os-vso{color:var(--muted);font-weight:500}
.os-note{padding:28px;border:1.5px dashed var(--line);border-radius:var(--radius);color:var(--muted);text-align:center}
@keyframes os-rise{from{opacity:0;transform:translateY(32px)}to{opacity:1;transform:none}}
@keyframes os-fade{from{opacity:0}to{opacity:1}}
@keyframes os-zoom{from{opacity:0;transform:scale(.93)}to{opacity:1;transform:none}}
@keyframes os-slide{from{opacity:0;transform:translateX(-48px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:no-preference){@supports (animation-timeline:view()){
.os-a-rise,.os-a-fade,.os-a-zoom,.os-a-slide{animation-timing-function:linear;animation-fill-mode:both;animation-timeline:view();animation-range:entry 0% entry 42%}
.os-a-rise{animation-name:os-rise}.os-a-fade{animation-name:os-fade}.os-a-zoom{animation-name:os-zoom}.os-a-slide{animation-name:os-slide}
}}
.os-shell-nav{display:flex;gap:20px;padding:16px 28px;border-bottom:1px solid var(--line);font-weight:600}
.os-shell-nav a{color:inherit;text-decoration:none}
.os-shell{max-width:1000px;margin:0 auto;padding:40px 28px}
.os-shell table{border-collapse:collapse;width:100%}.os-shell td,.os-shell th{padding:10px;border-bottom:1px solid var(--line);text-align:left}
.os-shell input,.os-shell textarea,.os-shell button{font:inherit;padding:11px 13px;border-radius:calc(var(--radius)*.7);border:1.5px solid var(--line);background:var(--bg);color:inherit}
.os-shell button{background:var(--primary);color:var(--on-primary);border-color:transparent;font-weight:600;cursor:pointer}
.os-stack{display:grid;gap:10px;max-width:440px}
.os-shop-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:32px 22px}
.os-editor *{animation:none!important}
`.replace(/\n/g, "");

/** Final responsive CSS. Order matters: base, node desktop rules, then tablet, then mobile (each can override the previous). */
export function responsiveBlocks(nodes: Node[]): string {
  const flat: Node[] = [];
  const walk = (ns: Node[]) => ns.forEach((n) => { flat.push(n); if (n.children) walk(n.children); });
  walk(nodes);
  const desktop = flat.map((n) => nodeRules(n, n.style, true)).join("");
  const tablet = flat.map((n) => (n.responsive?.tablet ? nodeRules(n, n.responsive.tablet) : "")).join("");
  const mobile = flat.map((n) => (n.responsive?.mobile ? nodeRules(n, n.responsive.mobile) : "")).join("");
  return (
    desktop +
    `@media(max-width:${BP.tablet}px){.os-narrow{grid-column:span 6}.os-pg-4,.os-pg-5{--c:3}.os-gal{--c:3}${tablet}}` +
    `@media(max-width:${BP.mobile}px){.os-col{grid-column:span 12}.os-narrow{grid-column:span 12}.os-section{padding:56px 20px}.os-grid{gap:28px}.os-pg{--c:2}.os-gal{--c:2}${mobile}}`
  );
}

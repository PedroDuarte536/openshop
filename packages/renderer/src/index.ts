export type Block =
  | { type: "heading"; text: string; level?: 1 | 2 | 3 }
  | { type: "text"; text: string }
  | { type: "image"; src: string; alt?: string }
  | { type: "button"; label: string; href: string }
  | { type: "columns"; columns: Block[][] }
  | { type: "products"; items: ProductCard[] }
  /** Resolved by the API at render time: `items` is filled from the catalogue, never trusted from the client. */
  | { type: "productList"; categoryId?: string; limit?: number; items?: ProductCard[] };

export interface ProductCard { id?: string; name: string; price: number; image?: string; href?: string }

export interface PageDoc {
  title: string;
  blocks: Block[];
}

export const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Only allow http(s), mailto, relative and anchor URLs. Blocks javascript: etc. */
const safeUrl = (u: string) => (/^(https?:|mailto:|\/|#)/i.test(u.trim()) ? u.trim() : "#");

function block(b: Block): string {
  switch (b.type) {
    case "heading": {
      const l = b.level ?? 2;
      return `<h${l}>${esc(b.text)}</h${l}>`;
    }
    case "text":
      return `<p>${esc(b.text)}</p>`;
    case "image":
      return `<img src="${esc(safeUrl(b.src))}" alt="${esc(b.alt ?? "")}" loading="lazy">`;
    case "button":
      return `<a class="btn" href="${esc(safeUrl(b.href))}">${esc(b.label)}</a>`;
    case "columns":
      return `<div class="cols">${b.columns.map((c) => `<div>${c.map(block).join("")}</div>`).join("")}</div>`;
    case "products":
    case "productList":
      return `<div class="grid">${(b.items ?? [])
        .map((p) => {
          const inner = `${p.image ? `<img src="${esc(safeUrl(p.image))}" alt="${esc(p.name)}" loading="lazy">` : ""}<h3>${esc(p.name)}</h3><p>${esc(p.price.toFixed(2))}</p>`;
          return `<article>${p.href ? `<a href="${esc(safeUrl(p.href))}">${inner}</a>` : inner}</article>`;
        })
        .join("")}</div>`;
    default:
      throw new Error(`Unknown block type: ${(b as { type: string }).type}`);
  }
}

const CSS = `*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,sans-serif;color:#1a1a1a}main{max-width:960px;margin:0 auto;padding:24px}img{max-width:100%;height:auto}.btn{display:inline-block;padding:10px 20px;background:#111;color:#fff;border-radius:6px;text-decoration:none}.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:24px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px}.top{display:flex;gap:16px;padding:12px 24px;border-bottom:1px solid #eee}table{border-collapse:collapse;width:100%}td,th{padding:8px;border-bottom:1px solid #eee;text-align:left}input,textarea,button{font:inherit;padding:8px;margin:4px 0}.stack{display:grid;gap:8px;max-width:420px}.grid a{color:inherit;text-decoration:none}.grid article{border:1px solid #e5e5e5;border-radius:8px;padding:12px}`;

/** Wraps already-safe body HTML in the shared storefront document shell (no JS). */
export function renderDocument(title: string, bodyHtml: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body><nav class="top"><a href="/">Home</a> <a href="/shop">Shop</a> <a href="/shop/cart">Cart</a></nav><main>${bodyHtml}</main></body></html>`;
}

/** Pure function: page JSON in, a complete static HTML document (no JS) out. */
export function renderPage(page: PageDoc): string {
  return renderDocument(page.title, page.blocks.map(block).join(""));
}

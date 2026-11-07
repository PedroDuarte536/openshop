import { normalizeDoc, renderPage, type Node, type PageDoc, type ProductCard } from "@openshop/renderer";
import type { Db } from "./types.ts";

function collectGrids(nodes: Node[], out: Node[] = []): Node[] {
  for (const n of nodes) { if (n.type === "productGrid") out.push(n); if (n.children) collectGrids(n.children, out); }
  return out;
}

/** Validates, cleans and renders. Returns the cleaned document (safe to store) and its final static HTML. */
export async function renderStored(db: Db, raw: unknown): Promise<{ doc: PageDoc; html: string }> {
  const doc = normalizeDoc(raw); // throws on invalid structure
  const lists = new Map<string, ProductCard[]>();
  for (const g of collectGrids(doc.nodes)) {
    const p = g.props as { categoryId?: string; limit?: number };
    const filter = p.categoryId ? { active: true, categoryId: p.categoryId } : { active: true };
    const found = await db.products.find(filter, { sort: { name: 1 }, limit: p.limit ?? 4 });
    lists.set(g.id, found.map((x) => ({ id: x.id, name: x.name, price: x.price, image: x.images?.[0], href: `/shop/product/${x.id}` })));
  }
  return { doc, html: renderPage(doc, { products: (n) => lists.get(n.id) ?? [] }) };
}

/** Static HTML goes stale when the catalogue changes, so re-render pages that show product grids. */
export async function rerenderDynamicPages(db: Db): Promise<void> {
  for (const p of await db.pages.find()) {
    if (collectGrids(p.nodes).length) {
      const { html } = await renderStored(db, { title: p.title, theme: p.theme, nodes: p.nodes });
      await db.pages.update(p.id, { html });
    }
  }
}

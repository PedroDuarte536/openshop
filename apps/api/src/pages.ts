import { renderPage, type Block, type ProductCard } from "@openshop/renderer";
import type { Db } from "./types.ts";

async function resolveBlocks(db: Db, blocks: Block[]): Promise<Block[]> {
  return Promise.all(blocks.map(async (b): Promise<Block> => {
    if (b.type === "columns") return { ...b, columns: await Promise.all(b.columns.map((c) => resolveBlocks(db, c))) };
    if (b.type !== "productList") return b;
    const filter: Record<string, unknown> = { active: true };
    if (b.categoryId) filter.categoryId = b.categoryId;
    const found = await db.products.find(filter as never, { sort: { name: 1 }, limit: Math.min(Math.max(b.limit ?? 12, 1), 48) });
    const items: ProductCard[] = found.map((p) => ({ id: p.id, name: p.name, price: p.price, image: p.images?.[0], href: `/shop/product/${p.id}` }));
    return { ...b, items };
  }));
}

const hasDynamic = (blocks: Block[]): boolean =>
  blocks.some((b) => b.type === "productList" || (b.type === "columns" && b.columns.some(hasDynamic)));

/** Renders page JSON to final static HTML, filling dynamic blocks from the catalogue. Throws on invalid blocks. */
export async function renderStored(db: Db, title: string, blocks: Block[]): Promise<string> {
  return renderPage({ title, blocks: await resolveBlocks(db, blocks) });
}

/** Static HTML goes stale when the catalogue changes, so re-render pages with dynamic blocks. */
export async function rerenderDynamicPages(db: Db): Promise<void> {
  for (const p of await db.pages.find()) {
    if (hasDynamic(p.blocks)) await db.pages.update(p.id, { html: await renderStored(db, p.title, p.blocks) });
  }
}

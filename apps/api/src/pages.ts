import { SYSTEM_PAGES, normalizeDoc, renderPage, type CategoryRef, type Node, type PageDoc, type ProductCard, type RenderContext } from "@openshop/renderer";
import type { Db, Product } from "./types.ts";

function collect(nodes: Node[], types: string[], out: Node[] = []): Node[] {
  for (const n of nodes) { if (types.includes(n.type)) out.push(n); if (n.children) collect(n.children, types, out); }
  return out;
}
/** Pages whose static HTML depends on the catalogue and must be re-rendered when it changes. */
export const isDynamic = (nodes: Node[]) => collect(nodes, ["productGrid", "categoryNav"]).length > 0;

export const toCard = (p: Product): ProductCard => ({ id: p.id, name: p.name, price: p.price, image: p.images?.[0], href: `/shop/product/${p.id}` });
export const categoryRefs = async (db: Db): Promise<CategoryRef[]> => (await db.categories.find({}, { sort: { name: 1 } })).map((c) => ({ name: c.name, slug: c.slug }));

async function catalogueLists(db: Db, doc: PageDoc): Promise<Map<string, ProductCard[]>> {
  const lists = new Map<string, ProductCard[]>();
  for (const g of collect(doc.nodes, ["productGrid"])) {
    const p = g.props as { categoryId?: string; limit?: number; source?: string };
    if (p.source === "results") continue;
    const filter = p.categoryId ? { active: true, categoryId: p.categoryId } : { active: true };
    lists.set(g.id, (await db.products.find(filter, { sort: { name: 1 }, limit: p.limit ?? 4 })).map(toCard));
  }
  return lists;
}

/** Validates, cleans and renders. Returns the cleaned document (safe to store) and its final HTML. */
export async function renderDoc(db: Db, raw: unknown, ctx: RenderContext = {}): Promise<{ doc: PageDoc; html: string }> {
  const doc = normalizeDoc(raw); // throws on invalid structure
  const lists = await catalogueLists(db, doc);
  const categories = ctx.categories ?? (await categoryRefs(db));
  return { doc, html: renderPage(doc, { context: { ...ctx, categories }, products: (n) => lists.get(n.id) ?? [] }) };
}
export const renderStored = (db: Db, raw: unknown) => renderDoc(db, raw);

/** Static HTML goes stale when the catalogue changes, so re-render the pages that show it. System pages render per request. */
export async function rerenderDynamicPages(db: Db): Promise<void> {
  for (const p of await db.pages.find({ system: null })) {
    if (isDynamic(p.nodes)) await db.pages.update(p.id, { html: (await renderStored(db, { title: p.title, theme: p.theme, nodes: p.nodes })).html });
  }
}

const ensured = new WeakMap<Db, Promise<void>>();
/** Product, category and search pages always exist; they are created from templates the first time they are needed. */
export function ensureSystemPages(db: Db): Promise<void> {
  let p = ensured.get(db);
  if (!p) {
    p = (async () => {
      const [home] = await db.pages.find({ slug: "home", system: null }, { limit: 1 });
      for (const sp of SYSTEM_PAGES) {
        if ((await db.pages.count({ system: sp.key })) > 0) continue;
        const { doc, html } = await renderStored(db, { title: sp.name, theme: home?.theme, nodes: sp.build() });
        await db.pages.insert({ slug: `system-${sp.key}`, title: sp.name, theme: doc.theme!, nodes: doc.nodes, html, system: sp.key });
      }
    })();
    ensured.set(db, p);
    p.catch(() => ensured.delete(db));
  }
  return p;
}

export async function renderSystem(db: Db, key: "product" | "category" | "search", ctx: RenderContext, title?: string): Promise<string> {
  await ensureSystemPages(db);
  const [p] = await db.pages.find({ system: key }, { limit: 1 });
  return (await renderDoc(db, { title: title ?? p.title, theme: p.theme, nodes: p.nodes }, ctx)).html;
}

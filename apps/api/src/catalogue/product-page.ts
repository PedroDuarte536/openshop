// What a product page shows besides the basics: public details, a bundle's contents and savings, the variant
// selector, and the bundles that contain the product. Only visible products and public properties are used (C22).
import type { ProductCtx } from "@openshop/renderer";
import type { AttributeDef, Db, Product } from "../types.ts";
import { bundleAvailability, bundleSumCents, productsById } from "./bundles.ts";
import { isDeleted, productType, publicSpecs, toCents } from "./model.ts";
import { searchFor } from "./search/service.ts";
import { toCardOf } from "./shop-search.ts";
import { variantSelector } from "./variants.ts";

const visible = (p: Product | undefined): p is Product => !!p && p.active && !isDeleted(p);
const link = (id: string) => `/shop/product/${id}`;

export async function productPageContext(db: Db, p: Product): Promise<ProductCtx> {
  const defs = await db.attributes.find({});
  const defMap = new Map(defs.map((d) => [d.key, d] as [string, AttributeDef]));
  const ctx: ProductCtx = { id: p.id, name: p.name, price: p.price, description: p.description, images: p.images, stock: p.stock };
  const specs = publicSpecs(p, defs, "product");
  if (specs.length) ctx.specs = specs.map(({ label, value }) => ({ label, value }));

  if (productType(p) === "bundle" && p.bundle) {
    const comps = await productsById(db, p.bundle.components.map((c) => c.productId));
    ctx.stock = bundleAvailability(p.bundle, comps).available;
    const sum = bundleSumCents(p.bundle, comps);
    ctx.bundle = {
      components: p.bundle.components.map((c) => {
        const x = comps.get(c.productId);
        return { name: x?.name ?? "Product", qty: c.qty, ...(x?.images?.[0] ? { image: x.images[0] } : {}), ...(visible(x) ? { href: link(x.id) } : {}) };
      }),
      // Savings compared with buying separately, in list prices, only for a price set by the owner below the sum.
      ...(p.bundle.priceMode === "manual" && sum !== null && sum > toCents(p.price) ? { savings: (sum - toCents(p.price)) / 100 } : {}),
    };
  }

  if (p.variantGroupId) {
    const g = await db.variantGroups.get(p.variantGroupId);
    if (g) {
      const all = (await db.products.find({ variantGroupId: g.id })).filter((m) => !isDeleted(m));
      const members = all.filter(visible);
      // Only public properties can tell variants apart in the shop (an internal one is never shown, C22).
      const diffs = g.differentiators.filter((d) => defMap.get(d.key)?.visibility === "public");
      if (members.length >= 2 && diffs.length && members.some((m) => m.id === p.id)) {
        const comps = await productsById(db, members.flatMap((m) => m.bundle?.components.map((c) => c.productId) ?? []));
        const avail = (m: Product) => (productType(m) === "bundle" && m.bundle ? bundleAvailability(m.bundle, comps).available : m.stock);
        ctx.variants = variantSelector(p, members, diffs, defMap, avail, all).map((line) => ({
          label: line.label,
          badges: line.badges.map((b) => ({ label: b.label, state: b.state, ...(b.productId ? { href: link(b.productId) } : {}), ...(b.soldOut ? { soldOut: true } : {}), ...(b.swatch ? { swatch: b.swatch } : {}) })),
        }));
      }
    }
  }

  if (productType(p) === "simple") {
    // "As seen in these bundles": visible, sellable bundles that chose to be listed on their products' pages.
    const snap = await searchFor(db).snapshot();
    const byId = new Map(snap.products.map((x) => [x.id, x]));
    const bundles = snap.products.filter((b) => productType(b) === "bundle" && visible(b) && b.bundle?.showOnComponents !== false
      && !!b.bundle?.components.some((c) => c.productId === p.id) && b.bundle.components.every((c) => byId.has(c.productId)));
    if (bundles.length) ctx.inBundles = bundles.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 12).map((b) => toCardOf(b, snap.available.get(b.id) ?? 0));
  }
  return ctx;
}

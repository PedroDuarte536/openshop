// Bundles: several products sold as one. Stock is derived from the components (owner decision B-1); the price is the
// components' total unless the owner sets a manual price (B-3); automatic offers only apply when enabled (B-2).
import { allocate } from "@openshop/pricing";
import type { BundleSpec, Db, Product } from "../types.ts";
import { isDeleted, productType, toCents, type FieldError } from "./model.ts";

export async function productsById(db: Db, ids: string[]): Promise<Map<string, Product>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  return new Map((await db.products.find({ id: { $in: unique } })).map((p) => [p.id, p]));
}

/** The components' total in cents, or null when a component is missing. */
export function bundleSumCents(spec: BundleSpec, products: Map<string, Product>): number | null {
  let sum = 0;
  for (const c of spec.components) {
    const p = products.get(c.productId);
    if (!p) return null;
    sum += toCents(p.price) * c.qty;
  }
  return sum;
}

/** How many bundles can be sold now, and which component limits it. A missing component makes it unavailable. */
export function bundleAvailability(spec: BundleSpec, products: Map<string, Product>): { available: number; limitedBy: string | null } {
  let available = Infinity, limitedBy: string | null = null;
  for (const c of spec.components) {
    const p = products.get(c.productId);
    const n = p ? Math.floor(Math.max(0, p.stock) / c.qty) : 0;
    if (n < available) { available = n; limitedBy = c.productId; }
  }
  return { available: Number.isFinite(available) ? available : 0, limitedBy };
}

/** Bundles that contain `productId` (deleted bundles only when asked). */
export async function bundlesContaining(db: Db, productId: string, opts: { includeDeleted?: boolean } = {}): Promise<Product[]> {
  return (await db.products.find({ type: "bundle" })).filter((b) => (opts.includeDeleted || !isDeleted(b)) && !!b.bundle?.components.some((c) => c.productId === productId));
}

/**
 * References must exist and be simple products. New references may not point to deleted products (existing ones stay:
 * a deleted component keeps its bundles working when the owner chose "keep selling").
 */
export async function validateBundleRefs(db: Db, spec: BundleSpec, selfId: string | null, previous: BundleSpec | null | undefined): Promise<{ errors: FieldError[]; products: Map<string, Product> }> {
  const products = await productsById(db, spec.components.map((c) => c.productId));
  const before = new Set(previous?.components.map((c) => c.productId) ?? []);
  const errors: FieldError[] = [];
  for (const c of spec.components) {
    const p = products.get(c.productId);
    if (c.productId === selfId) errors.push({ field: "bundle.components", message: "a bundle can't contain itself" });
    else if (!p) errors.push({ field: "bundle.components", message: `unknown product ${c.productId}` });
    else if (productType(p) === "bundle") errors.push({ field: "bundle.components", message: `${p.name} is a bundle; bundles can't contain bundles` });
    else if (isDeleted(p) && !before.has(p.id)) errors.push({ field: "bundle.components", message: `${p.name} is deleted` });
  }
  return { errors, products };
}

/**
 * Stock needed per product for some order lines: simple products need their quantity, bundles need each component ×
 * the bundle quantity. The same product can be needed by several bundles and on its own.
 */
export function stockDemand(lines: { product: Product; qty: number }[]): Map<string, number> {
  const demand = new Map<string, number>();
  const add = (id: string, n: number) => demand.set(id, (demand.get(id) ?? 0) + n);
  for (const { product, qty } of lines) {
    if (productType(product) === "bundle" && product.bundle) for (const c of product.bundle.components) add(c.productId, c.qty * qty);
    else add(product.id, qty);
  }
  return demand;
}

/** Each component's share of one bundle's price (largest remainder, so the shares add up exactly). */
export function allocateBundle(unitCents: number, spec: BundleSpec, products: Map<string, Product>): number[] {
  return allocate(unitCents, spec.components.map((c) => toCents(products.get(c.productId)?.price ?? 0) * c.qty));
}

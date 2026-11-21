// Every product write goes through here (admin API, bulk actions, import), so the rules live in one place:
// validation, references, SKU claims, bundle prices, variant uniqueness, the lifecycle (never delete), audit and the
// catalogue version.
import { randomUUID } from "node:crypto";
import type { Filter } from "@openshop/db";
import { discountState } from "@openshop/pricing";
import type { AttributeDef, BundleSpec, Db, Product } from "../types.ts";
import { audit } from "../audit.ts";
import { catalogueChanged } from "./meta.ts";
import { CatalogueError, isDeleted, normalizeAttributes, normalizeProductFields, productType, toCents, type FieldError, type ProductInput } from "./model.ts";
import { bundleSumCents, bundlesContaining, productsById, validateBundleRefs } from "./bundles.ts";
import { claimSku, releaseSku } from "./skus.ts";
import { canonValue, displayValue } from "./model.ts";
import { byPosition, duplicateMessage, findDuplicates, type Defs } from "./variants.ts";

export interface WriteCtx { db: Db; user: string; now?: () => number }
export interface WriteOpts {
  /** Part of a batch (import, bulk): skip the per-write catalogue bump and page re-render; the caller does it once. */
  batch?: boolean;
  /** Optimistic concurrency: the version the editor loaded. */
  version?: number;
  /** Extra conditions for the write (import: "stock is still what the preview saw"). A mismatch is a conflict. */
  guard?: Filter;
}

const nowIso = (ctx: WriteCtx) => new Date((ctx.now ?? Date.now)()).toISOString();

export async function loadDefs(db: Db): Promise<Defs> {
  return new Map((await db.attributes.find({})).map((d) => [d.key, d] as [string, AttributeDef]));
}

const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k] ?? null]));
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

async function checkCategory(db: Db, id: string | null | undefined, errors: FieldError[]) {
  if (id && !(await db.categories.get(id))) errors.push({ field: "categoryId", message: "unknown category" });
}

/** Bundle rules that need the database: references, "a component can't become a bundle", "variants can't be bundles". */
async function checkType(db: Db, merged: Partial<Product> & { id?: string }, cur: Product | null, errors: FieldError[]): Promise<Map<string, Product> | null> {
  const type = merged.type ?? "simple";
  if (type === "simple") {
    if (merged.bundle) errors.push({ field: "bundle", message: "only bundles have components" });
    return null;
  }
  if (!merged.bundle) { errors.push({ field: "bundle.components", message: "add the products in this bundle" }); return null; }
  if (cur && productType(cur) !== "bundle") {
    if ((await bundlesContaining(db, cur.id, { includeDeleted: true })).length) errors.push({ field: "type", message: "this product is part of a bundle, so it can't become a bundle" });
  }
  if (merged.variantGroupId) errors.push({ field: "type", message: "variants can't be bundles; remove it from its variant group first" });
  const { errors: refErrors, products } = await validateBundleRefs(db, merged.bundle as BundleSpec, merged.id ?? null, cur?.bundle);
  errors.push(...refErrors);
  return products;
}

/**
 * A member's differentiator values changed: the group must stay free of duplicates (V-3). The group version is bumped
 * before the product is written, so two concurrent edits can't both pass the check (C21).
 */
async function checkVariantEdit(ctx: WriteCtx, cur: Product, attrs: Product["attributes"], defs: Defs): Promise<void> {
  if (!cur.variantGroupId) return;
  const g = await ctx.db.variantGroups.get(cur.variantGroupId);
  if (!g) return;
  const changed = g.differentiators.some((d) => canonValue(cur.attributes?.[d.key], defs.get(d.key)) !== canonValue(attrs?.[d.key], defs.get(d.key)));
  if (!changed) return;
  const members = (await ctx.db.products.find({ variantGroupId: g.id })).map((m) => (m.id === cur.id ? { ...m, attributes: attrs } : m));
  const mine = findDuplicates(members.sort(byPosition), g.differentiators, defs).filter((c) => c.productId === cur.id || c.withProductId === cur.id);
  if (mine.length) {
    const c = mine[0].productId === cur.id ? mine[0] : { ...mine[0], productId: cur.id, name: cur.name, withProductId: mine[0].productId, withName: mine[0].name };
    throw new CatalogueError(duplicateMessage(c, g.differentiators, defs), 409, "variant_duplicate", [{ field: "attributes", message: "same values as another variant" }], { conflicts: [c] });
  }
  if (!(await ctx.db.variantGroups.updateWhere(g.id, { version: g.version }, { inc: { version: 1 }, set: { updatedAt: nowIso(ctx), updatedBy: ctx.user } }))) {
    throw new CatalogueError("The variant group changed at the same time. Please try again.", 409, "version_conflict");
  }
}

/** Sum-priced bundles that contain one of `componentIds` get their price recalculated (and audited). */
export async function recomputeBundles(ctx: WriteCtx, componentIds: string[]): Promise<Product[]> {
  const ids = new Set(componentIds);
  const bundles = (await ctx.db.products.find({ type: "bundle" })).filter((b) => b.bundle?.priceMode === "sum" && b.bundle.components.some((c) => ids.has(c.productId)));
  const changed: Product[] = [];
  for (const b of bundles) {
    const sum = bundleSumCents(b.bundle!, await productsById(ctx.db, b.bundle!.components.map((c) => c.productId)));
    if (sum === null || sum === toCents(b.price)) continue;
    const u = await ctx.db.products.updateWhere(b.id, {}, { set: { price: sum / 100, updatedAt: nowIso(ctx) }, inc: { version: 1 } });
    if (u) { changed.push(u); await audit(ctx.db, ctx.user, "recalculate", "product", b.id, { price: b.price }, { price: u.price, reason: "component price changed" }); }
  }
  return changed;
}

async function finish(ctx: WriteCtx, opts: WriteOpts) {
  if (!opts.batch) await catalogueChanged(ctx.db);
}

function throwIf(errors: FieldError[]) {
  if (errors.length) throw new CatalogueError("Please fix the highlighted fields.", 400, "invalid", errors);
}

/** Creates a product. API default: visible, 0 in stock. */
export async function createProduct(ctx: WriteCtx, input: ProductInput & { active?: unknown }, opts: WriteOpts & { id?: string; extra?: Partial<Product> } = {}): Promise<Product> {
  const isBundle = input.type === "bundle" || (!!input.bundle && input.type === undefined);
  const fields = normalizeProductFields({ ...input, ...(isBundle && input.price === undefined ? { price: 0 } : {}) }, { create: true });
  const id = opts.id ?? randomUUID();
  const merged: Partial<Product> & { id: string } = { active: true, stock: 0, ...fields, id, type: fields.type ?? (fields.bundle ? "bundle" : "simple"), ...(opts.extra ?? {}) };
  if (merged.type === "simple") delete merged.bundle;
  const errors: FieldError[] = [];
  await checkCategory(ctx.db, merged.categoryId, errors);
  const defs = await loadDefs(ctx.db);
  if (merged.attributes) { const r = normalizeAttributes(merged.attributes, defs); errors.push(...r.errors); merged.attributes = r.attrs; }
  const comps = await checkType(ctx.db, merged, null, errors);
  throwIf(errors);
  if (merged.type === "bundle") {
    if (merged.bundle!.priceMode === "sum") merged.price = (bundleSumCents(merged.bundle!, comps!) ?? 0) / 100;
    else if (input.price === undefined) throwIf([{ field: "price", message: "is required for a manual price" }]);
    merged.stock = 0;
  }
  if (merged.sku) await claimSku(ctx.db, merged.sku, id);
  const at = nowIso(ctx);
  let p: Product;
  try { p = await ctx.db.products.insert({ ...merged, version: 1, createdAt: at, updatedAt: at, updatedBy: ctx.user } as Product); }
  catch (e) { if (merged.sku) await releaseSku(ctx.db, merged.sku, id); throw e; }
  await audit(ctx.db, ctx.user, "create", "product", p.id, undefined, p);
  await finish(ctx, opts);
  return p;
}

/** Updates the fields present in `input`. Deleted products can't be edited (restore first). */
export async function updateProduct(ctx: WriteCtx, id: string, input: ProductInput & { active?: unknown }, opts: WriteOpts & { extra?: Partial<Product> } = {}): Promise<Product> {
  const cur = await ctx.db.products.get(id);
  if (!cur) throw new CatalogueError("not found", 404, "not_found");
  if (isDeleted(cur)) throw new CatalogueError("This product is deleted. Restore it before editing.", 409, "restore_first");
  if (opts.version !== undefined && opts.version !== (cur.version ?? 0)) throw new CatalogueError("This product was changed by someone else. Reload it and try again.", 409, "version_conflict");
  const fields: Partial<Product> = { ...normalizeProductFields(input, { create: false }), ...(opts.extra ?? {}) };
  // A simple product never keeps a bundle spec (turning a bundle back into a simple product drops it).
  if ((fields.type ?? productType(cur)) === "simple" && fields.bundle === undefined && cur.bundle) fields.bundle = null;
  const merged: Product = { ...cur, ...fields };
  const errors: FieldError[] = [];
  if (fields.categoryId !== undefined && fields.categoryId !== cur.categoryId) await checkCategory(ctx.db, fields.categoryId, errors);
  const defs = await loadDefs(ctx.db);
  if (fields.attributes) { const r = normalizeAttributes(fields.attributes, defs); errors.push(...r.errors); fields.attributes = merged.attributes = r.attrs; }
  let comps: Map<string, Product> | null = null;
  if (fields.type !== undefined || fields.bundle !== undefined) comps = await checkType(ctx.db, merged, cur, errors);
  throwIf(errors);
  if (productType(merged) === "bundle" && merged.bundle) {
    if (merged.bundle.priceMode === "sum") {
      comps ??= await productsById(ctx.db, merged.bundle.components.map((c) => c.productId));
      const sum = bundleSumCents(merged.bundle, comps);
      if (sum !== null) fields.price = sum / 100;
    }
  }
  if (fields.attributes) await checkVariantEdit(ctx, cur, fields.attributes, defs);
  // Only fields that actually change are written (and audited).
  const changedKeys = Object.keys(fields).filter((k) => !sameJson((cur as Record<string, unknown>)[k], (fields as Record<string, unknown>)[k]));
  if (!changedKeys.length) return cur;
  const set = Object.fromEntries(changedKeys.map((k) => [k, (fields as Record<string, unknown>)[k] ?? null]));
  const skuChanged = changedKeys.includes("sku");
  if (skuChanged && fields.sku) await claimSku(ctx.db, fields.sku, id);
  const guard: Filter = { ...(opts.guard ?? {}), deletedAt: null, ...(opts.version !== undefined ? { version: cur.version ?? null } : {}) };
  const u = await ctx.db.products.updateWhere(id, guard, { set: { ...set, updatedAt: nowIso(ctx), updatedBy: ctx.user }, inc: { version: 1 } });
  if (!u) {
    if (skuChanged && fields.sku) await releaseSku(ctx.db, fields.sku, id);
    const now = await ctx.db.products.get(id);
    if (now && isDeleted(now)) throw new CatalogueError("This product is deleted. Restore it before editing.", 409, "restore_first");
    throw new CatalogueError("This product was changed by someone else. Reload it and try again.", 409, "version_conflict");
  }
  if (skuChanged) await releaseSku(ctx.db, cur.sku, id);
  await audit(ctx.db, ctx.user, "update", "product", id, pick(cur as Record<string, unknown>, changedKeys), set);
  if (changedKeys.includes("price") && productType(u) === "simple") await recomputeBundles(ctx, [id]);
  await finish(ctx, opts);
  return u;
}

export interface DeleteImpact {
  bundles: { id: string; name: string; active: boolean; priceMode: "sum" | "manual" }[];
  variantGroup: { id: string; name: string; valuesLost: { property: string; value: string }[] } | null;
  offers: { id: string; name: string; state: string }[];
  openOrders: number;
}

/** What deleting a product affects, for the confirmation page (L-2). */
export async function deleteImpact(ctx: WriteCtx, id: string): Promise<DeleteImpact> {
  const cur = await ctx.db.products.get(id);
  if (!cur) throw new CatalogueError("not found", 404, "not_found");
  const bundles = (await bundlesContaining(ctx.db, id)).map((b) => ({ id: b.id, name: b.name, active: b.active, priceMode: b.bundle?.priceMode ?? "sum" }));
  let variantGroup: DeleteImpact["variantGroup"] = null;
  if (cur.variantGroupId) {
    const g = await ctx.db.variantGroups.get(cur.variantGroupId);
    if (g) {
      const defs = await loadDefs(ctx.db);
      const others = (await ctx.db.products.find({ variantGroupId: g.id })).filter((m) => m.id !== id && m.active && !isDeleted(m));
      const valuesLost = g.differentiators.filter((d) => !others.some((m) => canonValue(m.attributes?.[d.key], defs.get(d.key)) === canonValue(cur.attributes?.[d.key], defs.get(d.key))))
        .map((d) => ({ property: defs.get(d.key)?.label ?? d.key, value: displayValue(cur.attributes?.[d.key], defs.get(d.key)) }));
      variantGroup = { id: g.id, name: g.name, valuesLost };
    }
  }
  const now = (ctx.now ?? Date.now)();
  const offers = (await ctx.db.discounts.find({})).filter((d) => (d.target?.type === "products" && d.target.productIds.includes(id)) || d.excludeProductIds?.includes(id))
    .map((d) => ({ id: d.id, name: d.name, state: discountState({ ...d, usedCount: Number(d.usedCount) || 0 }, now) }));
  const openOrders = (await ctx.db.orders.find({ status: { $in: ["pending", "paid"] } })).filter((o) => o.lines.some((l) => l.productId === id || l.bundle?.components.some((c) => c.productId === id))).length;
  return { bundles, variantGroup, offers, openOrders };
}

/**
 * Soft delete (S-4): only hidden products; the owner must decide, for every bundle containing the product, whether the
 * bundle keeps selling or is hidden (L-1). The product stays wherever it is referenced.
 */
export async function deleteProduct(ctx: WriteCtx, id: string, decisions: Record<string, "keep" | "hide">): Promise<Product> {
  const cur = await ctx.db.products.get(id);
  if (!cur) throw new CatalogueError("not found", 404, "not_found");
  if (isDeleted(cur)) return cur;
  if (cur.active) throw new CatalogueError("Hide this product from the shop before deleting it.", 409, "hide_first");
  const bundles = await bundlesContaining(ctx.db, id);
  const missing = bundles.filter((b) => decisions[b.id] !== "keep" && decisions[b.id] !== "hide");
  if (missing.length) {
    throw new CatalogueError(`Choose what happens to ${missing.length === 1 ? "the bundle" : `${missing.length} bundles`} containing this product.`, 409, "decision_required", undefined, { bundles: missing.map((b) => ({ id: b.id, name: b.name })) });
  }
  const unknown = Object.keys(decisions).filter((k) => !bundles.some((b) => b.id === k));
  if (unknown.length) throw new CatalogueError("Some bundles in the request don't contain this product.", 400, "invalid");
  const at = nowIso(ctx);
  const u = await ctx.db.products.updateWhere(id, { active: false, deletedAt: null }, { set: { deletedAt: at, deletedBy: ctx.user, updatedAt: at, updatedBy: ctx.user }, inc: { version: 1 } });
  if (!u) {
    const now = await ctx.db.products.get(id);
    if (now && isDeleted(now)) return now;
    throw new CatalogueError("Hide this product from the shop before deleting it.", 409, "hide_first");
  }
  for (const b of bundles) if (decisions[b.id] === "hide" && b.active) await updateProduct(ctx, b.id, { active: false }, { batch: true });
  await audit(ctx.db, ctx.user, "delete", "product", id, { active: false, deletedAt: null }, { deletedAt: at, bundles: bundles.map((b) => ({ id: b.id, name: b.name, decision: decisions[b.id] })) });
  await catalogueChanged(ctx.db);
  return u;
}

/** Restores a deleted product as hidden. If it would duplicate a variant of its group, it comes back outside the group. */
export async function restoreProduct(ctx: WriteCtx, id: string): Promise<{ product: Product; notice: string | null }> {
  const cur = await ctx.db.products.get(id);
  if (!cur) throw new CatalogueError("not found", 404, "not_found");
  if (!isDeleted(cur)) return { product: cur, notice: null };
  let notice: string | null = null;
  const set: Partial<Product> = { deletedAt: null, deletedBy: null, active: false, updatedAt: nowIso(ctx), updatedBy: ctx.user };
  if (cur.variantGroupId) {
    const g = await ctx.db.variantGroups.get(cur.variantGroupId);
    if (g) {
      const defs = await loadDefs(ctx.db);
      const members = (await ctx.db.products.find({ variantGroupId: g.id })).map((m) => (m.id === id ? { ...m, deletedAt: null } : m));
      const c = findDuplicates(members, g.differentiators, defs).find((x) => x.productId === id || x.withProductId === id);
      if (c) {
        set.variantGroupId = null;
        const other = c.productId === id ? c.withName : c.name;
        notice = `${cur.name} was restored outside the variant group "${g.name}": it has the same values as ${other}.`;
      }
    } else set.variantGroupId = null;
  }
  const u = await ctx.db.products.updateWhere(id, { deletedAt: { $ne: null } }, { set, inc: { version: 1 } });
  if (!u) return { product: (await ctx.db.products.get(id))!, notice: null };
  if (cur.sku && !(await ctx.db.productSkus.get(cur.sku.toUpperCase()))) await claimSku(ctx.db, cur.sku, id).catch(() => undefined);
  await audit(ctx.db, ctx.user, "restore", "product", id, { deletedAt: cur.deletedAt }, { deletedAt: null, ...(notice ? { notice } : {}) });
  await catalogueChanged(ctx.db);
  return { product: u, notice };
}

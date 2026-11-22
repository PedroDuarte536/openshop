// SKU uniqueness without unique indexes: the normalised SKU is the id of a claim document (like voucher codes), so
// the primary key guarantees that two products can't hold the same SKU, on both database adapters.
import { DuplicateKeyError } from "@openshop/db";
import type { Db } from "../types.ts";
import { CatalogueError, normalizeSku } from "./model.ts";

/** Claims `sku` for `productId`. Throws 409 when another product holds it. A stale claim (the holder no longer has
 *  that SKU, e.g. after a crash between steps) is taken over. */
export async function claimSku(db: Db, sku: string, productId: string): Promise<void> {
  const id = normalizeSku(sku);
  try { await db.productSkus.insert({ id, productId }); return; }
  catch (e) { if (!(e instanceof DuplicateKeyError)) throw e; }
  const claim = await db.productSkus.get(id);
  if (!claim || claim.productId === productId) return;
  const holder = await db.products.get(claim.productId);
  if (holder && holder.sku && normalizeSku(holder.sku) === id) {
    throw new CatalogueError(`SKU ${sku} is already used by ${holder.name}${holder.deletedAt ? " (deleted)" : ""}.`, 409, "sku_taken", [{ field: "sku", message: `already used by ${holder.name}${holder.deletedAt ? " (deleted)" : ""}` }], { productId: holder.id });
  }
  if (!(await db.productSkus.updateWhere(id, { productId: claim.productId }, { set: { productId } }))) throw new CatalogueError("The SKU changed at the same time. Please try again.", 409, "sku_taken");
}

/** Releases `sku` if `productId` holds it. */
export async function releaseSku(db: Db, sku: string | null | undefined, productId: string): Promise<void> {
  if (!sku) return;
  const id = normalizeSku(sku);
  const claim = await db.productSkus.get(id);
  if (claim?.productId === productId) await db.productSkus.delete(id);
}

/** Moves a claim from one product to another (import: "create as a new product" over a deleted one). */
export async function transferSku(db: Db, sku: string, fromId: string, toId: string): Promise<boolean> {
  return !!(await db.productSkus.updateWhere(normalizeSku(sku), { productId: fromId }, { set: { productId: toId } }));
}

export async function productIdBySku(db: Db, sku: string): Promise<string | null> {
  return (await db.productSkus.get(normalizeSku(sku)))?.productId ?? null;
}

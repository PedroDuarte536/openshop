import { DuplicateKeyError } from "@openshop/db";
import type { Db } from "../types.ts";
import { rerenderDynamicPages } from "../pages.ts";

// The catalogue version: a counter bumped on every product, category, property or variant-group write (and once per
// import batch). Search indexes in every process compare it to know when to rebuild (plan §2.5.4, "freshness").

const listeners = new WeakMap<Db, Set<() => void>>();

/** Called in this process right after a change, so local caches refresh immediately (other processes poll). */
export function onCatalogueChange(db: Db, fn: () => void): () => void {
  let set = listeners.get(db);
  if (!set) { set = new Set(); listeners.set(db, set); }
  set.add(fn);
  return () => set!.delete(fn);
}

export async function catalogueVersion(db: Db): Promise<number> {
  return (await db.meta.get("catalogue"))?.version ?? 0;
}

export async function bumpCatalogue(db: Db): Promise<number> {
  try { await db.meta.insert({ id: "catalogue", version: 0 }); } catch (e) { if (!(e instanceof DuplicateKeyError)) throw e; }
  const m = await db.meta.updateWhere("catalogue", {}, { inc: { version: 1 } });
  for (const fn of listeners.get(db) ?? []) { try { fn(); } catch (err) { console.error("catalogue listener failed", err); } }
  return m?.version ?? 0;
}

/** After a change: bump the version and re-render stored pages that show products (once, not once per product). */
export async function catalogueChanged(db: Db, opts: { rerender?: boolean } = {}): Promise<void> {
  await bumpCatalogue(db);
  if (opts.rerender !== false) await rerenderDynamicPages(db);
}

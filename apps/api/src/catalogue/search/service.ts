// Search backend lifecycle (plan §2.5.1, decision S-1): one shared in-process backend for both database adapters.
// The index is rebuilt when the catalogue version changes (checked at most once a second, so other processes catch
// up quickly) and at least every minute (stock changes by orders don't bump the version). Result pages are read from
// the database, so the data shown is always current even when the index is a little behind.
import type { Db, Product } from "../../types.ts";
import { catalogueVersion, onCatalogueChange } from "../meta.ts";
import { bundleAvailability } from "../bundles.ts";
import { isDeleted, productType } from "../model.ts";
import { newShared, SearchIndex, type Query, type Result, type Snapshot, type View } from "./memory-index.ts";
import { CONFIG } from "../../config.ts";

/** What any search backend must provide (a native SQLite/Mongo backend could implement it later, behind the same tests). */
export interface SearchBackend {
  query(view: View, q: Query): Promise<Result>;
  index(view: View): Promise<SearchIndex>;
}

const VERSION_CHECK_MS = CONFIG.search.versionCheckMs;
const MAX_AGE_MS = CONFIG.search.maxIndexAgeMs;
/**
 * Above this many products a rebuild takes noticeable time (about 1.2 s for 20,000 products with long descriptions,
 * measured), so shop searches keep using the previous index while the new one is built in the background (at most a
 * few seconds behind). The backoffice always waits, so the owner sees their own changes at once.
 */
const BACKGROUND_REBUILD_FROM = CONFIG.search.backgroundRebuildFrom;

/** Sellable quantity of every product: simple products their stock, bundles the minimum over their components. */
export function availability(products: Product[]): Map<string, number> {
  const byId = new Map(products.map((p) => [p.id, p]));
  const out = new Map<string, number>();
  for (const p of products) {
    if (productType(p) === "bundle" && p.bundle) out.set(p.id, bundleAvailability(p.bundle, byId).available);
    else out.set(p.id, Math.max(0, p.stock ?? 0));
  }
  return out;
}

export async function snapshot(db: Db): Promise<Snapshot> {
  const [products, categories, defs] = await Promise.all([db.products.find({}), db.categories.find({}), db.attributes.find({})]);
  return { products, categories, defs, available: availability(products) };
}

export class MemorySearch implements SearchBackend {
  private db: Db;
  private built: { version: number; at: number; admin: SearchIndex; public: SearchIndex; snap: Snapshot } | null = null;
  private building: Promise<void> | null = null;
  private dirty = true;
  private checkedAt = 0;
  private knownVersion = -1;

  constructor(db: Db) {
    this.db = db;
    onCatalogueChange(db, () => { this.dirty = true; });
  }

  private async rebuild(): Promise<void> {
    if (!this.building) {
      this.building = (async () => {
        this.dirty = false;
        const version = await catalogueVersion(this.db);
        const snap = await snapshot(this.db);
        const shared = newShared();
        this.built = { version, at: Date.now(), admin: new SearchIndex("admin", snap, shared), public: new SearchIndex("public", snap, shared), snap };
        this.knownVersion = version;
      })().finally(() => { this.building = null; });
    }
    return this.building;
  }

  private async fresh(view: View = "admin"): Promise<NonNullable<MemorySearch["built"]>> {
    const now = Date.now();
    if (!this.dirty && this.built && now - this.checkedAt > VERSION_CHECK_MS) {
      this.checkedAt = now;
      if ((await catalogueVersion(this.db)) !== this.knownVersion) this.dirty = true;
    }
    if (this.dirty || !this.built || now - this.built.at > MAX_AGE_MS) {
      if (view === "public" && this.built && this.built.snap.products.length >= BACKGROUND_REBUILD_FROM) {
        this.rebuild().catch((e) => console.error("search index rebuild failed", e));
        return this.built;
      }
      await this.rebuild();
    }
    return this.built!;
  }

  async index(view: View): Promise<SearchIndex> { return (await this.fresh(view))[view]; }
  async snapshot(view: View = "public"): Promise<Snapshot> { return (await this.fresh(view)).snap; }
  async query(view: View, q: Query): Promise<Result> { return (await this.index(view)).query(q); }

  /** The current documents for some ids, in that order (deleted ones only for the admin view). */
  async hydrate(ids: string[], view: View): Promise<Product[]> {
    if (!ids.length) return [];
    const docs = new Map((await this.db.products.find({ id: { $in: ids } })).map((p) => [p.id, p]));
    return ids.map((id) => docs.get(id)).filter((p): p is Product => !!p && (view === "admin" || (p.active && !isDeleted(p))));
  }
}

const instances = new WeakMap<Db, MemorySearch>();
/** One search backend per database (per process). */
export function searchFor(db: Db): MemorySearch {
  let s = instances.get(db);
  if (!s) { s = new MemorySearch(db); instances.set(db, s); }
  return s;
}

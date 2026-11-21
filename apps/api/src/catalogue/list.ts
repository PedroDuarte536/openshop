// GET /api/products: the backoffice product search (text, filters with counts, sort, paging) and, on the same URL
// by the Accept header, the CSV and full-JSON exports of what the search shows.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { negotiate } from "../negotiate.ts";
import { audit } from "../audit.ts";
import type { Db, Product } from "../types.ts";
import { bundleAvailability, bundleSumCents, productsById } from "./bundles.ts";
import { isDeleted, productType } from "./model.ts";
import { CATALOGUE_TYPE, catalogueJson, csvStream, exportContext, MAX_EXPORT_ROWS, type Delimiter } from "./export.ts";
import { parseAdminQuery, type Params } from "./search/params.ts";
import { searchFor } from "./search/service.ts";
import { urlValue, type FacetCounts, type SearchIndex } from "./search/memory-index.ts";

const TYPES = ["application/json", "text/csv", CATALOGUE_TYPE];

export interface ProductExtras {
  available: number; limitedBy?: { id: string; name: string } | null; componentsTotal?: number | null; containsDeleted?: boolean;
  variantGroup?: { id: string; name: string } | null;
}

/** Computed information the product list shows: bundle availability and what limits it, components total, group. */
export async function productExtras(db: Db, items: Product[]): Promise<Map<string, ProductExtras>> {
  const compIds = items.flatMap((p) => (productType(p) === "bundle" ? p.bundle?.components.map((c) => c.productId) ?? [] : []));
  const comps = await productsById(db, compIds);
  const groupIds = [...new Set(items.map((p) => p.variantGroupId).filter((g): g is string => !!g))];
  const groups = new Map(groupIds.length ? (await db.variantGroups.find({ id: { $in: groupIds } })).map((g) => [g.id, g]) : []);
  const out = new Map<string, ProductExtras>();
  for (const p of items) {
    const g = p.variantGroupId ? groups.get(p.variantGroupId) : undefined;
    const base: ProductExtras = { available: p.stock, variantGroup: g ? { id: g.id, name: g.name } : null };
    if (productType(p) === "bundle" && p.bundle) {
      const a = bundleAvailability(p.bundle, comps);
      const sum = bundleSumCents(p.bundle, comps);
      out.set(p.id, {
        ...base, available: a.available, limitedBy: a.limitedBy ? { id: a.limitedBy, name: comps.get(a.limitedBy)?.name ?? "" } : null,
        componentsTotal: sum === null ? null : sum / 100, containsDeleted: p.bundle.components.some((c) => { const x = comps.get(c.productId); return !x || isDeleted(x); }),
      });
    } else out.set(p.id, base);
  }
  return out;
}

/** Facet counts with the labels the backoffice (or the shop) shows. */
export function labelFacets(f: FacetCounts, index: SearchIndex, categories: Map<string, { name: string; slug: string }>) {
  return {
    categories: f.categories.map((c) => ({ id: c.id, slug: c.id ? categories.get(c.id)?.slug ?? null : null, name: c.id ? categories.get(c.id)?.name ?? "Unknown" : "No category", count: c.count }))
      .sort((a, b) => (a.id === null ? 1 : b.id === null ? -1 : a.name.localeCompare(b.name))),
    price: f.price ? { min: f.price.min / 100, max: f.price.max / 100 } : null,
    stock: f.stock, status: f.status, types: f.types, variants: f.variants, missing: f.missing,
    attributes: f.attributes.map((a) => {
      const d = index.defs.get(a.key)!;
      const order = (v: string) => d.options?.find((o) => `c:${o.value}` === v)?.position ?? Number.MAX_SAFE_INTEGER;
      const values = a.values.map((v) => ({ value: urlValue(v.value), label: index.valueLabel(a.key, v.value), count: v.count, ...(d.type === "choice" || d.type === "multi" ? { swatch: d.options?.find((o) => `c:${o.value}` === v.value)?.swatch ?? null } : {}) }));
      if (d.type === "choice" || d.type === "multi") values.sort((x, y) => order(`c:${x.value}`) - order(`c:${y.value}`));
      else if (d.type === "number") values.sort((x, y) => Number(x.value) - Number(y.value));
      return { key: a.key, label: d.label, type: d.type, unit: d.unit ?? null, values, ...(a.range ? { range: a.range } : {}) };
    }),
  };
}

export function registerProductList(admin: FastifyInstance, { db }: { db: Db }) {
  admin.get("/api/products", async (req: FastifyRequest<{ Querystring: Params }>, reply) => {
    reply.header("vary", "Accept");
    const type = negotiate(req.headers.accept, TYPES);
    if (!type) return reply.code(406).send({ error: "not acceptable", accepts: TYPES });
    const search = searchFor(db);
    const index = await search.index("admin");
    const q = parseAdminQuery(req.query, index.defs);

    if (type !== "application/json") {
      const r = index.query({ ...q, skip: 0, limit: MAX_EXPORT_ROWS, facets: false });
      const x = await exportContext(db, !!q.status?.includes("deleted"));
      const date = new Date().toISOString().slice(0, 10);
      await audit(db, req.userId ?? "unknown", "export", "products", "-", undefined, { format: type, rows: r.ids.length, filters: req.query });
      reply.header("cache-control", "no-store");
      if (type === "text/csv") {
        const d = String(req.query.delimiter ?? ",");
        const delim: Delimiter = d === ";" ? ";" : d === "tab" || d === "\t" ? "\t" : ",";
        const decimal = req.query.decimal === "," || (req.query.decimal === undefined && delim === ";") ? "," : ".";
        return reply.type("text/csv; charset=utf-8").header("content-disposition", `attachment; filename="products-${date}.csv"`).send(csvStream(db, r.ids, x, delim, decimal));
      }
      return reply.type(`${CATALOGUE_TYPE}; charset=utf-8`).header("content-disposition", `attachment; filename="catalogue-${date}.json"`).send(JSON.stringify(await catalogueJson(db, r.ids, x)));
    }

    const r = index.query(q);
    const items = await search.hydrate(r.ids, "admin");
    const snap = await search.snapshot("admin");
    const categories = new Map(snap.categories.map((c) => [c.id, c]));
    const facets = r.facets ? labelFacets(r.facets, index, categories) : undefined;
    if (q.view === "summary") {
      return {
        items: items.map((p) => ({ id: p.id, name: p.name, sku: p.sku ?? null, price: p.price, active: p.active, deleted: isDeleted(p), type: productType(p), categoryId: p.categoryId ?? null, image: p.images?.[0] ?? null, available: snap.available.get(p.id) ?? p.stock, variantGroupId: p.variantGroupId ?? null })),
        total: r.total, facets, corrected: r.corrected,
      };
    }
    const extras = await productExtras(db, items);
    return { items: items.map((p) => ({ ...p, extras: extras.get(p.id) })), total: r.total, facets, corrected: r.corrected };
  });
}

// Import jobs (plan §2.7.3): upload -> mapping -> preview (nothing written) -> the owner decides about deleted
// matches -> commit in batches -> report. One import at a time; rows keep their own state so a commit interrupted by a
// restart can be resumed without applying anything twice. Import never deletes (I-4).
import { createHash, randomUUID } from "node:crypto";
import { setImmediate as yieldLoop } from "node:timers/promises";
import { DuplicateKeyError } from "@openshop/db";
import type { AttributeDef, Db, Product } from "../../types.ts";
import { audit } from "../../audit.ts";
import { catalogueChanged } from "../meta.ts";
import { createAttribute, keyFromLabel, MAX_ATTRIBUTES, optionValue } from "../attributes.ts";
import { CatalogueError, findOption, isAttrKey, isDeleted, normalizeAttributes, normalizeProductFields, normalizeSku, productType, toCents } from "../model.ts";
import { createProduct, loadDefs, restoreProduct, updateProduct, type WriteCtx } from "../service.ts";
import { transferSku } from "../skus.ts";
import { byPosition, findDuplicates, GROUP_ID_RE, MAX_DIFFERENTIATORS, type Differentiator } from "../variants.ts";
import { decode, detectDelimiter, FileError, LIMITS, parseCsv } from "./csv.ts";
import { autoMap, checkMapping, convertCsvRow, convertJsonRow, inferType, PRESETS, type Preset, type RowInput } from "./mapping.ts";
import { copyServerImage, downloadRemote, MAX_MEDIA_BYTES, MAX_MEDIA_FILES, probeRemote, resolveImage, type MediaConfig } from "./media.ts";
import { pool } from "./remote.ts";
import type { FieldProblem, ImportJob, ImportOptions, ImportRow, RowPlan } from "./types.ts";
import { CONFIG } from "../../config.ts";

export const DEFAULT_OPTIONS: ImportOptions = {
  // New products are visible, as in the product editor (owner decision); the wizard can turn it off, and a "visible"
  // column decides per product.
  mode: "upsert", missing: "leave", empty: "leave", stock: "set", newVisible: true, createCategories: false,
  createProperties: true, addChoiceValues: true, stopOnError: false, remoteImages: "download",
};
const RETENTION_MS = CONFIG.import.retentionMs;
const BATCH = CONFIG.import.batchSize;
const LOCK_ID = "catalogue-import";
const LOCK_TTL_MS = CONFIG.import.lockTtlMs;

export interface ImportDeps { db: Db; user: string; media: MediaConfig; now?: () => number }
const iso = (d: ImportDeps) => new Date((d.now ?? Date.now)()).toISOString();

// Commits run in the background; tests (and shutdown) can wait for them.
const running = new Map<string, Promise<void>>();
export const whenDone = (jobId: string) => running.get(jobId) ?? Promise.resolve();

// ------------------------------------------------------------------------------------------------ upload

function uniqueHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, i) => {
    const base = h.trim() || `Column ${i + 1}`;
    const n = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), n);
    return n > 1 ? `${base} (${n})` : base;
  });
}

const safeName = (s: string) => s.replace(/[^\w.\- ()]/g, "_").slice(0, 120) || "import";

/** Reads the file, stores its rows, and suggests a mapping. Nothing in the catalogue changes. */
export async function createJob(d: ImportDeps, file: { body: Buffer; filename: string; contentType: string }): Promise<ImportJob> {
  const { text, encoding } = decode(file.body);
  const trimmed = text.trimStart();
  const isJson = /json/i.test(file.contentType) || /\.json$/i.test(file.filename) || trimmed.startsWith("{") || trimmed.startsWith("[");
  const defs = await d.db.attributes.find({});
  const at = iso(d);
  const id = randomUUID();
  const base = {
    status: "uploaded" as const, filename: safeName(file.filename), sha256: createHash("sha256").update(file.body).digest("hex"), bytes: file.body.length,
    options: { ...DEFAULT_OPTIONS }, createdBy: d.user, createdAt: at, updatedAt: at, expiresAt: new Date(Date.parse(at) + RETENTION_MS).toISOString(), error: null,
  };
  let rows: Record<string, unknown>[];
  let job: Omit<ImportJob, "id">;
  if (isJson) {
    let data: unknown;
    try { data = JSON.parse(trimmed); } catch { throw new FileError("The JSON file can't be read (it isn't valid JSON)."); }
    const doc = (Array.isArray(data) ? { products: data } : data) as Record<string, unknown>;
    if (!doc || typeof doc !== "object" || !Array.isArray(doc.products)) throw new FileError("The JSON file must be an OpenShop catalogue (with \"products\") or a list of products.");
    if (doc.products.length > LIMITS.rows) throw new FileError(`The file has more than ${LIMITS.rows.toLocaleString("en")} products. Split it into smaller files.`);
    rows = (doc.products as unknown[]).map((p) => (p && typeof p === "object" && !Array.isArray(p) ? p as Record<string, unknown> : {}));
    const list = <T>(v: unknown, max: number) => (Array.isArray(v) ? (v as T[]).filter((x) => x && typeof x === "object").slice(0, max) : []);
    const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))].slice(0, LIMITS.columns);
    job = {
      ...base, format: "json", rowCount: rows.length, columns, mapping: {}, newProperties: {}, preset: null,
      catalogue: {
        categories: list<{ slug: string; name: string }>(doc.categories, 1000).filter((c) => typeof c.slug === "string" && /^[a-z0-9-]{1,80}$/.test(c.slug) && typeof c.name === "string").map((c) => ({ slug: c.slug, name: c.name.slice(0, 200) })),
        attributes: list<Record<string, unknown>>(doc.attributes, MAX_ATTRIBUTES),
        variantGroups: list<{ id: string; name: string; differentiators: Differentiator[] }>(doc.variantGroups, 5000)
          .filter((g) => typeof g.id === "string" && GROUP_ID_RE.test(g.id) && Array.isArray(g.differentiators))
          .map((g) => ({ id: g.id, name: String(g.name ?? g.id).slice(0, 120), differentiators: g.differentiators.filter((x) => x && isAttrKey(String(x.key))).slice(0, MAX_DIFFERENTIATORS).map((x) => ({ key: String(x.key), order: x.order === "sorted" ? "sorted" as const : "products" as const })) })),
      },
    };
  } else {
    const delimiter = detectDelimiter(text);
    const records = parseCsv(text, delimiter);
    if (records.length < 2) throw new FileError("The file needs a header line and at least one product.");
    const headers = uniqueHeaders(records[0]);
    // Lines with only empty cells (e.g. ";;;;" left by spreadsheets) aren't products.
    rows = records.slice(1).filter((r) => r.some((x) => x.trim() !== "")).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""])));
    if (!rows.length) throw new FileError("The file needs a header line and at least one product.");
    const preset: Preset | null = PRESETS.find((p) => p.detect(headers)) ?? null;
    const mapping = autoMap(headers, defs, { preset, createProperties: true });
    job = {
      ...base, format: "csv", rowCount: rows.length, columns: headers, csv: { delimiter, decimal: delimiter === ";" ? "," : ".", encoding },
      mapping, newProperties: inferNew(mapping, rows as Record<string, string>[]), preset: preset?.key ?? null, catalogue: null,
    };
  }
  const created = await d.db.importJobs.insert({ id, ...job });
  for (let i = 0; i < rows.length; i++) {
    await d.db.importRows.insert({ id: `${id}:${i + 1}`, jobId: id, rowNo: i + 1, raw: rows[i], state: "pending", message: null });
    if (i % 1000 === 999) await yieldLoop();
  }
  await audit(d.db, d.user, "upload", "import", id, undefined, { filename: created.filename, sha256: created.sha256, rows: rows.length, format: created.format });
  return created;
}

/** New properties (mapped as "new:<label>"): their type guessed from the values. */
function inferNew(mapping: Record<string, string>, rows: Record<string, string>[], keep: ImportJob["newProperties"] = {}): ImportJob["newProperties"] {
  const out: ImportJob["newProperties"] = {};
  for (const [col, target] of Object.entries(mapping)) {
    if (!target.startsWith("new:")) continue;
    const label = target.slice(4).trim();
    out[label] = keep[label] ?? { label, type: inferType(rows.slice(0, 2000).map((r) => r[col] ?? "")) };
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ settings

export async function getJob(db: Db, id: string): Promise<ImportJob> {
  const j = await db.importJobs.get(id);
  if (!j) throw new CatalogueError("not found", 404);
  return j;
}

/** Changes the mapping, options or new-property types. The preview has to be computed again afterwards. */
export async function configureJob(d: ImportDeps, id: string, b: { mapping?: Record<string, string>; options?: Partial<ImportOptions>; newProperties?: ImportJob["newProperties"]; preset?: string | null; publish?: string[] }): Promise<ImportJob> {
  const j = await getJob(d.db, id);
  if (j.status === "committing" || j.status === "done") throw new CatalogueError("This import has already been applied.", 409, "already_committed");
  const defs = await d.db.attributes.find({});
  let mapping = j.mapping;
  if (b.preset !== undefined && j.format === "csv") {
    const preset = PRESETS.find((p) => p.key === b.preset) ?? null;
    mapping = autoMap(j.columns, defs, { preset, createProperties: true });
  }
  if (b.mapping) {
    const problems = checkMapping(b.mapping, j.columns, defs);
    if (problems.length) throw new CatalogueError("Please fix the column choices.", 400, "invalid", problems.map((p) => ({ field: p.column, message: p.message })));
    mapping = { ...Object.fromEntries(j.columns.map((c) => [c, "ignore"])), ...b.mapping };
  }
  let newProperties = j.newProperties;
  if (b.mapping || b.preset !== undefined) {
    const rows = (await d.db.importRows.find({ jobId: id }, { sort: { rowNo: 1 }, limit: 2000 })).map((r) => r.raw as Record<string, string>);
    newProperties = inferNew(mapping, rows, j.newProperties);
  }
  if (b.newProperties) {
    for (const [label, np] of Object.entries(b.newProperties)) if (newProperties[label] && ["text", "choice", "number", "boolean"].includes(np.type)) newProperties[label] = { label, type: np.type };
  }
  const options = { ...j.options, ...(b.options ?? {}) };
  return (await d.db.importJobs.update(id, {
    mapping, newProperties, options, status: "uploaded", preview: undefined, updatedAt: iso(d),
    ...(b.preset !== undefined ? { preset: b.preset } : {}),
    ...(b.publish ? { publish: [...new Set(b.publish.filter(isAttrKey))] } : {}),
  }))!;
}

// ------------------------------------------------------------------------------------------------ preview

interface Pending {
  categories: Map<string, string>;                              // lower-case name -> name (to create)
  properties: Map<string, PendingProperty>;
  options: Map<string, Set<string>>;                             // property key -> option labels to add
}

type PendingProperty = NonNullable<ImportJob["preview"]>["newProperties"][number];

/** Everything the preview needs to know about the shop, loaded once (not once per row). */
async function loadShop(db: Db) {
  const [products, categories, defs, groups] = await Promise.all([db.products.find({}), db.categories.find({}), db.attributes.find({}), db.variantGroups.find({})]);
  const bySku = new Map<string, Product>();
  for (const p of products) if (p.sku) bySku.set(normalizeSku(p.sku), p);
  return {
    products, byId: new Map(products.map((p) => [p.id, p])), bySku,
    catBySlug: new Map(categories.map((c) => [c.slug, c])), catByName: new Map(categories.map((c) => [c.name.trim().toLowerCase(), c])),
    defs: new Map(defs.map((x) => [x.key, x])), groups: new Map(groups.map((g) => [g.id, g])),
  };
}
type Shop = Awaited<ReturnType<typeof loadShop>>;

const PRICE_JUMP = CONFIG.import.priceJumpWarning;
/** Ids a new product may keep from the file: OpenShop's own (random UUIDs). Other systems' ids are not kept. */
const KEEP_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** "", [], {} and missing all mean "no value" when comparing a row with the product. */
const blankToNull = (v: unknown) => (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length) || (v && typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length) ? null : v);

/** Works out what every row would do, without writing anything to the catalogue. */
export async function previewJob(d: ImportDeps, id: string): Promise<ImportJob> {
  const j = await getJob(d.db, id);
  if (j.status === "committing" || j.status === "done") throw new CatalogueError("This import has already been applied.", 409, "already_committed");
  const shop = await loadShop(d.db);
  const rows = await d.db.importRows.find({ jobId: id }, { sort: { rowNo: 1 } });
  const o = j.options;
  const pending: Pending = { categories: new Map(), properties: new Map(), options: new Map() };
  const warnings = new Map<string, number>();
  const warn = (w: string) => warnings.set(w, (warnings.get(w) ?? 0) + 1);

  // Properties that will exist: the shop's, the JSON catalogue's definitions, and new ones from "new:<label>" columns.
  const defs = new Map(shop.defs);
  const variantKeys = new Set<string>();
  for (const r of rows) {
    const by = j.format === "csv" ? Object.entries(j.mapping).find(([, t]) => t === "variant_by")?.[0] : undefined;
    const v = by ? String((r.raw as Record<string, string>)[by] ?? "") : "";
    for (const k of v.split("|").map((x) => x.trim()).filter(Boolean)) variantKeys.add(k);
  }
  for (const g of j.catalogue?.variantGroups ?? []) for (const x of g.differentiators) variantKeys.add(x.key);
  const publish = new Set(j.publish ?? []);
  type FileDef = { options?: { value?: string; label: string; swatch?: string }[]; unit?: string | null; settings?: { public: boolean; filterable: boolean; searchable: boolean; showOnProduct: boolean } };
  const addPendingProperty = (key: string, label: string, type: "text" | "choice" | "multi" | "number" | "boolean", file: FileDef = {}) => {
    if (defs.has(key) || pending.properties.has(key)) return;
    // Created internal (C25) unless the file uses it to tell variants apart (shoppers must see it), or the owner ticked
    // "public in the shop" for it in the preview (owner decision on Q-2, option C).
    const locked = variantKeys.has(key);
    const pub = locked || publish.has(key);
    const choice = type === "choice" || type === "multi";
    const optionDefs = choice ? (file.options ?? []).slice(0, 500) : undefined;
    pending.properties.set(key, {
      key, label, type, public: pub, locked, publicInFile: !!file.settings?.public,
      ...(optionDefs ? { options: optionDefs.map((o) => o.label), optionDefs } : {}),
      ...(type === "number" && file.unit ? { unit: file.unit } : {}),
      ...(file.settings ? { fileSettings: file.settings } : {}),
    });
    defs.set(key, { id: key, key, label, type, unit: type === "number" ? file.unit ?? null : null, options: (optionDefs ?? []).map((o, i) => ({ value: o.value ? optionValue(o.value) : optionValue(o.label), label: o.label, position: i })), visibility: pub ? "public" : "internal", filterable: false, searchable: false, showOnProduct: pub, position: 999, version: 0, createdAt: "", updatedAt: "" });
  };
  for (const a of j.catalogue?.attributes ?? []) {
    const key = String(a.key ?? ""), label = String(a.label ?? a.key ?? "").slice(0, 80);
    const type = ["text", "choice", "multi", "number", "boolean"].includes(String(a.type)) ? a.type as "text" : "text";
    const options = Array.isArray(a.options) ? (a.options as Record<string, unknown>[]).filter((x) => x && typeof x === "object" && typeof x.label === "string" && x.label)
      .map((x) => ({ label: String(x.label).slice(0, 80), ...(typeof x.value === "string" ? { value: x.value.slice(0, 60) } : {}), ...(typeof x.swatch === "string" ? { swatch: x.swatch.slice(0, 20) } : {}) })) : undefined;
    const settings = { public: a.visibility === "public", filterable: a.filterable === true, searchable: a.searchable === true, showOnProduct: a.showOnProduct === true };
    if (isAttrKey(key) && label) addPendingProperty(key, label, type, { options, unit: typeof a.unit === "string" ? a.unit.slice(0, 20) : null, settings });
  }
  const newKeyByLabel = new Map<string, string>();
  for (const [label, np] of Object.entries(j.newProperties)) {
    let key = keyFromLabel(label);
    for (let n = 2; (shop.defs.has(key) && shop.defs.get(key)!.label !== label) || [...newKeyByLabel.values()].includes(key); n++) key = `${keyFromLabel(label).slice(0, 29)}_${n}`;
    if (shop.defs.get(key)?.label === label) { newKeyByLabel.set(label, key); continue; }
    newKeyByLabel.set(label, key);
    if (o.createProperties) addPendingProperty(key, label, np.type);
  }

  // Which file rows can be referred to by bundles (their SKU or id), and which products rows claim.
  const claimed = new Map<string, number[]>();
  const plans: { row: ImportRow; input: RowInput; plan: RowPlan }[] = [];
  const media = new Map<string, Awaited<ReturnType<typeof resolveImage>>>();
  for (const row of rows) {
    const conv = j.format === "csv"
      ? convertCsvRow(row.raw as Record<string, string>, j.mapping, { decimal: j.csv?.decimal ?? ".", empty: o.empty, preset: PRESETS.find((p) => p.key === j.preset) ?? null })
      : convertJsonRow(row.raw);
    const input = conv.input;
    const errors: FieldProblem[] = [...conv.problems];
    const plan: RowPlan = { action: "error", errors, warnings: [] };
    const cur = (input.id && shop.byId.get(input.id)) || (input.sku && shop.bySku.get(normalizeSku(input.sku))) || null;
    if (cur) claimed.set(cur.id, [...(claimed.get(cur.id) ?? []), row.rowNo]);
    // Deleted in the file: an import never deletes, so a product of the shop is left as it is; a product the shop
    // doesn't have is added to Deleted products (a backup restored into another shop keeps its history).
    if (input.deleted) {
      if (cur) { plan.action = "unchanged"; plan.productId = cur.id; plan.name = cur.name; plan.warnings!.push(isDeleted(cur) ? "deleted in the file and in the shop" : "deleted in the file: left as it is (an import never deletes)"); plans.push({ row, input, plan }); continue; }
      if (o.mode === "update") { plan.action = "unchanged"; plan.warnings!.push("deleted in the file: skipped (the import only updates existing products)"); plans.push({ row, input, plan }); continue; }
      plan.createDeleted = true;
      input.active = false;
      if (input.variant) { delete input.variant; }
    }
    if (cur && isDeleted(cur)) {
      const prev = row.plan?.deletedMatch?.productId === cur.id ? row.plan.deletedMatch.decision : null;
      plan.deletedMatch = { productId: cur.id, name: cur.name, deletedAt: cur.deletedAt!, decision: prev };
    }
    const decision = plan.deletedMatch?.decision ?? null;
    const target = cur && (!isDeleted(cur) || decision === "restore") ? cur : null;
    if (!target && o.mode === "update" && !(plan.deletedMatch && decision !== "new")) {
      // Nothing to update: this is the row's only problem (no "name is required" as if it were a new product).
      errors.push({ column: input.id ? "id" : "sku", message: "no product with this id or SKU (the import only updates existing products)" });
      plans.push({ row, input, plan }); continue;
    }
    if (target) plan.name = target.name;
    if (target && o.mode === "create") { plan.action = "unchanged"; plan.productId = target.id; plan.warnings!.push("already exists (the import only creates new products)"); plans.push({ row, input, plan }); continue; }
    if (plan.deletedMatch && decision === "skip") { plan.action = "unchanged"; plan.errors = []; plan.warnings!.push("matches a deleted product: skipped"); plans.push({ row, input, plan }); continue; }
    buildPlan({ d, j, o, shop, defs, pending, newKeyByLabel, input, target, plan, errors, media, warn });
    plans.push({ row, input, plan });
  }
  // Two new products with the same id in the file: both are errors.
  const newIds = new Map<string, number[]>();
  for (const p of plans) if (p.plan.newId) newIds.set(p.plan.newId, [...(newIds.get(p.plan.newId) ?? []), p.row.rowNo]);
  for (const p of plans) { const nos = p.plan.newId ? newIds.get(p.plan.newId)! : []; if (nos.length > 1) { p.plan.errors!.push({ column: "id", message: `rows ${nos.join(", ")} have the same id` }); p.plan.action = "error"; } }
  // Two rows for the same product: both are errors (which one should win is the owner's call).
  for (const [pid, nos] of claimed) if (nos.length > 1) for (const p of plans) if (nos.includes(p.row.rowNo) && p.plan.productId === pid) { p.plan.errors!.push({ column: "", message: `rows ${nos.join(", ")} are all for the same product` }); p.plan.action = "error"; }

  // Images: checked now (existence, folder, type), so problems show before anything is applied; copied at commit.
  // https images are downloaded unless the owner keeps them as links; the preview reads only their first bytes,
  // a few at a time (C7).
  const download = (o.remoteImages ?? "download") === "download";
  const checked = new Map<string, Awaited<ReturnType<typeof resolveImage>>>();
  const sources = [...new Set(plans.flatMap((p) => (p.plan.media ?? []).map((m) => m.source)))];
  const remote = download ? sources.filter((src) => /^https?:\/\//i.test(src.trim())).slice(0, MAX_MEDIA_FILES) : [];
  const probed = await pool(remote, CONFIG.import.remote.concurrency, (src) => probeRemote(j.id, src, d.media));
  remote.forEach((src, i) => checked.set(src, probed[i]));
  for (const p of plans) {
    for (const m of p.plan.media ?? []) {
      let r = checked.get(m.source);
      if (!r) { r = await resolveImage(m.source, d.media); checked.set(m.source, r); }
      if (!r.ok) p.plan.errors!.push({ column: "images", message: r.error });
      else if (r.kind === "url" && r.warning) warn(`a photo ${r.warning}`);
      else if (r.kind === "remote") m.kind = "remote";
    }
  }
  const remoteCount = [...checked.values()].filter((r) => r.ok && r.kind === "remote").length;
  if (remoteCount) warn(`${remoteCount} ${remoteCount === 1 ? "photo" : "photos"} will be downloaded from other websites and stored in the shop`);
  if (checked.size > MAX_MEDIA_FILES) for (const p of plans) if (p.plan.media?.length) p.plan.errors!.push({ column: "images", message: `at most ${MAX_MEDIA_FILES} different images per import` });
  // Total size of the server files to copy (each counted once): above the limit, rows with server images are refused.
  const copyBytes = [...checked.values()].reduce((a, r) => a + (r.ok && r.kind === "server" ? r.size : 0), 0);
  if (copyBytes > MAX_MEDIA_BYTES) {
    const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;
    for (const p of plans) if (p.plan.media?.some((m) => { const r = checked.get(m.source); return r?.ok && r.kind === "server"; })) p.plan.errors!.push({ column: "images", message: `the images to copy add up to ${mb(copyBytes)}; at most ${mb(MAX_MEDIA_BYTES)} per import (split the file)` });
  }

  resolveBundleRefs(plans, shop);
  checkVariants(plans, shop, defs, j);
  for (const p of plans) if (p.plan.errors?.length) p.plan.action = "error";

  // Rows that stay pending until the owner decides about the deleted product they match.
  const undecided = plans.filter((p) => p.plan.deletedMatch && !p.plan.deletedMatch.decision).length;
  const inFile = new Set(plans.map((p) => p.plan.productId).filter(Boolean));
  const toHide = o.missing === "hide" && o.mode !== "create" ? shop.products.filter((p) => !isDeleted(p) && p.active && !inFile.has(p.id)).length : 0;
  const visibleNow = plans.filter((p) => p.plan.action !== "error" && p.plan.set?.active === true && !(p.plan.productId && shop.byId.get(p.plan.productId)?.active)).length;
  if (visibleNow > CONFIG.import.manyVisibleWarning) warn(`${visibleNow} products will become visible in the shop`);
  const stats = { create: 0, update: 0, unchanged: 0, errors: 0 };
  // Rows waiting for a decision about a deleted product are counted there only (not as creates or errors yet).
  for (const p of plans) { if (p.plan.deletedMatch && !p.plan.deletedMatch.decision && p.plan.action !== "error") continue; if (p.plan.action === "error") stats.errors++; else stats[p.plan.action]++; }
  for (const p of plans) await d.db.importRows.update(p.row.id, { plan: p.plan, state: "pending", message: null });
  const at = iso(d);
  return (await d.db.importJobs.update(id, {
    status: "previewed", updatedAt: at,
    preview: {
      ...stats, deletedMatches: plans.filter((p) => p.plan.deletedMatch).length, undecided,
      warnings: [...warnings].map(([w, n]) => (n > 1 ? `${w} (${n} rows)` : w)),
      newProperties: [...pending.properties.values()].map((p) => ({ ...p, values: plans.filter((x) => x.plan.set?.attributes && (x.plan.set.attributes as Record<string, unknown>)[p.key] !== undefined).length })),
      newOptions: Object.fromEntries([...pending.options].map(([k, v]) => [k, [...v]])), newCategories: [...pending.categories.values()],
      toHide, catalogueSize: shop.products.filter((p) => !isDeleted(p)).length, at,
    },
  }))!;
}

interface BuildCtx {
  d: ImportDeps; j: ImportJob; o: ImportOptions; shop: Shop; defs: Map<string, AttributeDef>; pending: Pending; newKeyByLabel: Map<string, string>;
  input: RowInput; target: Product | null; plan: RowPlan; errors: FieldProblem[]; media: Map<string, Awaited<ReturnType<typeof resolveImage>>>; warn: (w: string) => void;
}

/** One row: the fields it sets (validated and normalised), the diff against the product, warnings. */
function buildPlan(c: BuildCtx): void {
  const { o, shop, input, target, plan, errors } = c;
  const set: Record<string, unknown> = {};
  const creating = !target;
  const type = input.type ?? (target ? productType(target) : input.bundle?.refs.length ? "bundle" : "simple");
  if (input.name !== undefined) set.name = input.name;
  if (input.sku !== undefined) set.sku = input.sku;
  if (input.type !== undefined || creating) set.type = type;
  if (input.active !== undefined) set.active = input.active; else if (creating) set.active = o.newVisible;
  if (input.price !== undefined) set.price = input.price;
  if (type === "simple" && o.stock === "set" && input.stock !== undefined) set.stock = input.stock;
  if (input.description !== undefined) set.description = input.description;
  if (input.htmlStripped) plan.warnings!.push("HTML in the description was converted to plain text");
  if (input.category !== undefined) {
    if (input.category === null) set.categoryId = null;
    else {
      const cat = shop.catBySlug.get(input.category) ?? shop.catByName.get(input.category.trim().toLowerCase());
      const fromFile = c.j.catalogue?.categories.find((x) => x.slug === input.category);
      if (cat) set.categoryId = cat.id;
      else if (fromFile || o.createCategories) { const name = fromFile?.name ?? input.category.trim().slice(0, 200); c.pending.categories.set(name.toLowerCase(), name); set.category = name; }
      else errors.push({ column: "category", message: `unknown category "${input.category.slice(0, 60)}" (tick "Create categories that don't exist yet" to add it)` });
    }
  }
  if (input.images !== undefined) {
    const imgs: string[] = [];
    for (const src of input.images.slice(0, CONFIG.catalogue.maxImages)) {
      const r = c.media.get(src);
      if (!r) { plan.media ??= []; plan.media.push({ source: src, kind: /^\/uploads\//.test(src) ? "uploads" : /^https?:/i.test(src) ? "url" : "server" }); }
      imgs.push(src);
    }
    if (input.images.length > CONFIG.catalogue.maxImages) errors.push({ column: "images", message: `at most ${CONFIG.catalogue.maxImages} photos per product` });
    set.images = imgs;
  }
  // Properties: existing ones by key, new ones by label; unknown choice values become new options when allowed.
  const raw: Record<string, unknown> = { ...(input.attributes ?? {}) };
  for (const [label, v] of Object.entries(input.newAttributes ?? {})) { const k = c.newKeyByLabel.get(label); if (k && c.defs.has(k)) raw[k] = v; }
  if (Object.keys(raw).length) {
    const merged: Record<string, unknown> = { ...(target?.attributes ?? {}) };
    const given: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!isAttrKey(k) || !c.defs.has(k)) { errors.push({ column: `attr:${k}`, message: "unknown property" }); continue; }
      if (v === null) { delete merged[k]; continue; }
      given[k] = v;
    }
    for (const [k, v] of Object.entries(given)) {
      const def = c.defs.get(k)!;
      if ((def.type === "choice" || def.type === "multi") && c.o.addChoiceValues) {
        const labels = def.type === "multi" && typeof v === "string" ? v.split("|").map((x) => x.trim()).filter(Boolean) : typeof v === "string" ? [v.trim()] : Array.isArray(v) ? v.map(String) : [];
        for (const l of labels) if (l && !findOption(def, l)) {
          def.options = [...(def.options ?? []), { value: optionValue(l), label: l, position: def.options?.length ?? 0 }];
          if (c.shop.defs.has(k)) { const s = c.pending.options.get(k) ?? new Set<string>(); s.add(l); c.pending.options.set(k, s); }
          else { const pp = c.pending.properties.get(k); pp?.options?.push(l); pp?.optionDefs?.push({ label: l }); }
        }
      }
    }
    const r = normalizeAttributes(Object.fromEntries(Object.entries(given)) as never, c.defs);
    for (const e of r.errors) errors.push({ column: `attr:${e.field.replace(/^attributes\./, "")}`, message: e.message });
    Object.assign(merged, r.attrs);
    set.attributes = merged;
  }
  // Bundles: references are resolved after every row is known (a bundle may contain products created by the same file).
  if (input.bundle) {
    if (type !== "bundle") errors.push({ column: "bundle_components", message: "only bundles have products (set type to bundle)" });
    else {
      plan.bundleRefs = input.bundle.refs;
      set.bundle = { components: [], priceMode: input.bundle.priceMode ?? target?.bundle?.priceMode ?? (input.price !== undefined ? "manual" : "sum"), offerScope: input.bundle.offerScope ?? target?.bundle?.offerScope ?? "targeted", showOnComponents: input.bundle.showOnComponents ?? target?.bundle?.showOnComponents ?? true };
    }
  } else if (type === "bundle" && creating) errors.push({ column: "bundle_components", message: "a new bundle needs its products (bundle_components)" });
  if (input.variant) {
    const group = input.variant.group ?? (input.variant.by ? target?.variantGroupId ?? null : null);
    const changed = group !== (target?.variantGroupId ?? null) || (input.variant.position !== null && input.variant.position !== target?.variantPosition);
    if (group || changed) plan.variant = { group, by: input.variant.by, position: input.variant.position, changed };
  } else if (target?.variantGroupId && set.attributes) {
    // A member's values change: its group is checked for duplicates too.
    plan.variant = { group: target.variantGroupId, by: null, position: null, changed: false };
  }
  // An unchanged bundle (same products, quantities and settings) isn't an update.
  if (target?.bundle && plan.bundleRefs && set.bundle) {
    const ids = plan.bundleRefs.map((r) => (shop.byId.get(r.ref) ?? shop.bySku.get(normalizeSku(r.ref)))?.id);
    const same = ids.every(Boolean) && JSON.stringify(target.bundle.components) === JSON.stringify(plan.bundleRefs.map((r, i) => ({ productId: ids[i], qty: r.qty })))
      && JSON.stringify({ ...target.bundle, components: [] }) === JSON.stringify(set.bundle);
    if (same) { delete plan.bundleRefs; delete set.bundle; }
  }

  // Domain checks with the same validator as the API (images are checked separately: they may be server paths).
  const forCheck = { ...set, images: undefined, category: undefined, attributes: undefined, bundle: undefined } as Record<string, unknown>;
  if (creating && type === "bundle" && forCheck.price === undefined) forCheck.price = 0;
  try { normalizeProductFields(forCheck, { create: creating }); }
  catch (e) {
    if (!(e instanceof CatalogueError)) throw e;
    // A column whose cell couldn't be read already has its error ("must be a price like 12.50"); no second one.
    const unread = new Set(errors.flatMap((x) => [x.column, c.j.mapping?.[x.column]]));
    for (const f of e.fields ?? []) { const column = f.field === "active" ? "visible" : f.field; if (!unread.has(column)) errors.push({ column, message: f.message }); }
  }
  if (set.sku && target?.sku !== set.sku) {
    const holder = shop.bySku.get(normalizeSku(String(set.sku)));
    if (holder && holder.id !== target?.id && !(plan.deletedMatch && plan.deletedMatch.decision !== "restore" && holder.id === plan.deletedMatch.productId)) errors.push({ column: "sku", message: `already used by ${holder.name}${holder.deletedAt ? " (deleted)" : ""}` });
  }

  plan.productId = target?.id ?? plan.deletedMatch?.productId;
  if (!target) {
    plan.action = "create"; plan.set = set;
    // A new product keeps its id from the file (OpenShop ids only), so links and bundle references survive a restore.
    if (input.id && !plan.deletedMatch && KEEP_ID_RE.test(input.id) && !shop.byId.has(input.id)) plan.newId = input.id;
    if (plan.createDeleted) plan.warnings!.push("deleted in the file: added to Deleted products");
    if (plan.deletedMatch?.decision === "new") plan.productId = undefined;
    if (plan.deletedMatch && !plan.deletedMatch.decision) plan.warnings!.push("matches a deleted product: choose restore, create a new product, or skip");
    return;
  }
  // Update: only fields that change; warnings for risky changes.
  const diff: Record<string, [unknown, unknown]> = {};
  const cur = target as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(set)) {
    if (k === "bundle" || k === "type" && v === productType(target)) continue;
    if (JSON.stringify(blankToNull(cur[k])) !== JSON.stringify(blankToNull(v))) diff[k] = [cur[k] ?? null, v];
  }
  if (set.bundle) diff.bundle = [target.bundle ?? null, "(updated)"];
  if (plan.deletedMatch?.decision === "restore") plan.warnings!.push("restores a deleted product (it stays hidden unless the file says visible)");
  if (typeof diff.price?.[1] === "number") {
    const before = toCents(target.price), after = toCents(diff.price[1] as number);
    if (after === 0) { c.warn("price set to 0"); plan.warnings!.push(`price set to 0 (was ${target.price.toFixed(2)})`); }
    else if (before && Math.abs(after - before) / before > PRICE_JUMP) plan.warnings!.push(`price changes by more than 50% (${target.price.toFixed(2)} → ${(diff.price[1] as number).toFixed(2)})`);
  }
  const setKeys = Object.keys(diff).filter((k) => k !== "bundle" || set.bundle);
  plan.diff = diff;
  plan.set = Object.fromEntries(setKeys.map((k) => [k, set[k]]));
  if (set.category !== undefined) plan.set.category = set.category;
  plan.baseVersion = target.version ?? null;
  if ("stock" in plan.set) plan.baseStock = target.stock;
  plan.action = setKeys.length || plan.variant?.changed || plan.deletedMatch ? "update" : "unchanged";
  // For the preview: category names rather than ids.
  if (diff.categoryId) {
    const nameOf = (id: unknown) => (typeof id === "string" ? [...shop.catBySlug.values()].find((x) => x.id === id)?.name ?? id : null);
    diff.category = [nameOf(diff.categoryId[0]), nameOf(diff.categoryId[1])];
    delete diff.categoryId;
  }
  // Shown in the preview only (the group is set after all products exist).
  if (plan.variant?.changed) {
    if (plan.variant.group !== (target.variantGroupId ?? null)) diff.variantGroupId = [target.variantGroupId ?? null, plan.variant.group];
    if (plan.variant.position !== null && plan.variant.position !== target.variantPosition) diff.variantPosition = [target.variantPosition ?? null, plan.variant.position];
  }
}

/** Bundle components by SKU or id: existing products, or products created by this file. */
function resolveBundleRefs(plans: { row: ImportRow; input: RowInput; plan: RowPlan }[], shop: Shop) {
  const fileBySku = new Map<string, { plan: RowPlan; type: string }>();
  const fileById = new Map<string, { plan: RowPlan; type: string }>();
  for (const p of plans) if (p.plan.set?.sku && p.plan.action !== "error") fileBySku.set(normalizeSku(String(p.plan.set.sku)), { plan: p.plan, type: String(p.plan.set.type ?? "simple") });
  for (const p of plans) if (p.plan.newId && p.plan.action !== "error") fileById.set(p.plan.newId, { plan: p.plan, type: String(p.plan.set?.type ?? "simple") });
  for (const p of plans) {
    const refs = p.plan.bundleRefs;
    if (!refs) continue;
    const seen = new Set<string>();
    if (refs.length < 2) p.plan.errors!.push({ column: "bundle_components", message: "a bundle needs at least 2 different products" });
    for (const r of refs) {
      if (r.qty < 1 || r.qty > CONFIG.catalogue.bundle.maxQty) { p.plan.errors!.push({ column: "bundle_components", message: `${r.ref}: quantity must be 1 to ${CONFIG.catalogue.bundle.maxQty}` }); continue; }
      const existing = shop.byId.get(r.ref) ?? shop.bySku.get(normalizeSku(r.ref));
      const inFile = fileById.get(r.ref) ?? fileBySku.get(normalizeSku(r.ref));
      const key = existing?.id ?? (fileById.has(r.ref) ? r.ref : `sku:${normalizeSku(r.ref)}`);
      if (seen.has(key)) { p.plan.errors!.push({ column: "bundle_components", message: `${r.ref} is listed twice (use the quantity)` }); continue; }
      seen.add(key);
      if (existing) {
        if (productType(existing) === "bundle") p.plan.errors!.push({ column: "bundle_components", message: `${r.ref} is a bundle; bundles can't contain bundles` });
        else if (isDeleted(existing) && !p.plan.productId) p.plan.errors!.push({ column: "bundle_components", message: `${r.ref} is deleted` });
      } else if (inFile) {
        if (inFile.type === "bundle") p.plan.errors!.push({ column: "bundle_components", message: `${r.ref} is a bundle; bundles can't contain bundles` });
      } else p.plan.errors!.push({ column: "bundle_components", message: `no product with SKU or id ${r.ref}` });
    }
  }
}

/** Variant groups in the file: differentiators known, and no two products with the same values (V-3). */
function checkVariants(plans: { row: ImportRow; input: RowInput; plan: RowPlan }[], shop: Shop, defs: Map<string, AttributeDef>, j: ImportJob) {
  const groups = new Map<string, { plan: RowPlan; row: ImportRow }[]>();
  for (const p of plans) {
    const g = p.plan.variant?.group;
    if (!g) continue;
    if (!GROUP_ID_RE.test(g)) { p.plan.errors!.push({ column: "variant_group", message: "lower-case letters, digits and dashes (e.g. linen-mug)" }); continue; }
    if ((p.plan.set?.type ?? (p.plan.productId ? productType(shop.byId.get(p.plan.productId)!) : "simple")) === "bundle") { p.plan.errors!.push({ column: "variant_group", message: "bundles can't be variants" }); continue; }
    groups.set(g, [...(groups.get(g) ?? []), { plan: p.plan, row: p.row }]);
  }
  for (const [g, rows] of groups) {
    const existing = shop.groups.get(g);
    const fromFile = j.catalogue?.variantGroups.find((x) => x.id === g);
    const bys = [...new Set(rows.map((r) => r.plan.variant?.by?.join("|")).filter((x): x is string => !!x))];
    const fail = (message: string) => rows.forEach((r) => r.plan.errors!.push({ column: "variant_by", message }));
    if (bys.length > 1) { fail(`the rows of group ${g} list different properties in variant_by`); continue; }
    const keys = bys[0]?.split("|") ?? fromFile?.differentiators.map((x) => x.key) ?? existing?.differentiators.map((x) => x.key) ?? [];
    if (!keys.length) { fail(`group ${g} is new: say which properties tell its variants apart (variant_by)`); continue; }
    if (keys.length > MAX_DIFFERENTIATORS) { fail(`at most ${MAX_DIFFERENTIATORS} properties`); continue; }
    const bad = keys.filter((k) => { const x = defs.get(k); return !x || x.type === "multi"; });
    if (bad.length) { fail(`unknown or multiple-choice properties in variant_by: ${bad.join(", ")}`); continue; }
    const diffs: Differentiator[] = keys.map((key) => ({ key, order: existing?.differentiators.find((x) => x.key === key)?.order ?? fromFile?.differentiators.find((x) => x.key === key)?.order ?? "products" }));
    // The group after the import: its current members (with their values) plus the file's rows (with theirs).
    const rowFor = new Map<string, { plan: RowPlan; row: ImportRow }>();
    const members: Product[] = [];
    for (const r of rows) {
      if (r.plan.errors?.length) continue;
      const base = r.plan.productId ? shop.byId.get(r.plan.productId) : undefined;
      const pid = r.plan.productId ?? `row:${r.row.rowNo}`;
      rowFor.set(pid, r);
      members.push({ ...(base ?? {}), id: pid, name: String(r.plan.set?.name ?? base?.name ?? `row ${r.row.rowNo}`), attributes: (r.plan.set?.attributes as Product["attributes"]) ?? base?.attributes ?? {}, variantPosition: r.plan.variant?.position ?? base?.variantPosition, deletedAt: null } as Product);
    }
    for (const p of shop.products) if (p.variantGroupId === g && !isDeleted(p) && !rowFor.has(p.id)) members.push(p);
    for (const c of findDuplicates(members.sort(byPosition), diffs, defs)) {
      for (const [pid, other] of [[c.productId, c.withName], [c.withProductId, c.name]] as const) {
        const r = rowFor.get(pid);
        const msg = `same ${keys.map((k) => defs.get(k)?.label ?? k).join(", ")} as ${other} (${c.values}): not added`;
        if (r && !r.plan.errors!.some((e) => e.message === msg)) r.plan.errors!.push({ column: "variant_group", message: msg });
      }
    }
    for (const r of rows) if (r.plan.variant) r.plan.variant.by = keys;
  }
}

// ------------------------------------------------------------------------------------------------ decisions

/** The owner's choice for rows that match deleted products: per row number, or for all of them ("all"). */
export async function decide(d: ImportDeps, id: string, decisions: Record<string, "restore" | "new" | "skip">): Promise<ImportJob> {
  const j = await getJob(d.db, id);
  if (j.status !== "previewed" && j.status !== "uploaded") throw new CatalogueError("This import can't be changed any more.", 409, "already_committed");
  const rows = await d.db.importRows.find({ jobId: id });
  for (const r of rows) {
    const dm = r.plan?.deletedMatch;
    if (!dm) continue;
    const choice = decisions[String(r.rowNo)] ?? decisions.all;
    if (choice) await d.db.importRows.update(r.id, { plan: { ...r.plan!, deletedMatch: { ...dm, decision: choice } } });
  }
  // Decisions change what rows do, so the preview is recomputed (keeping the decisions).
  return previewJob(d, id);
}

// ------------------------------------------------------------------------------------------------ commit

async function acquireLock(db: Db, holder: string, now: number): Promise<void> {
  const expiresAt = new Date(now + LOCK_TTL_MS).toISOString();
  try { await db.locks.insert({ id: LOCK_ID, holder, expiresAt }); return; } catch (e) { if (!(e instanceof DuplicateKeyError)) throw e; }
  const cur = await db.locks.get(LOCK_ID);
  if (cur && (cur.holder === holder || Date.parse(cur.expiresAt) <= now) && (await db.locks.updateWhere(LOCK_ID, { holder: cur.holder, expiresAt: cur.expiresAt }, { set: { holder, expiresAt } }))) return;
  throw new CatalogueError("Another import is running. Please wait until it finishes.", 409, "import_running");
}
async function releaseLock(db: Db, holder: string) { const l = await db.locks.get(LOCK_ID); if (l?.holder === holder) await db.locks.updateWhere(LOCK_ID, { holder }, { set: { expiresAt: new Date(0).toISOString() } }); }

/** Starts applying a previewed import in the background. `previewAt` must be the preview the owner looked at. */
export async function commitJob(d: ImportDeps, id: string, b: { previewAt: string; confirmHide?: boolean }): Promise<ImportJob> {
  const j = await getJob(d.db, id);
  if (j.status === "done") throw new CatalogueError("This import has already been applied.", 409, "already_committed");
  if (j.status === "committing") throw new CatalogueError("This import is being applied.", 409, "import_running");
  const resuming = j.status === "interrupted";
  if (!resuming) {
    if (j.status !== "previewed" || !j.preview) throw new CatalogueError("Preview the import first.", 409, "preview_required");
    if (j.preview.at !== b.previewAt) throw new CatalogueError("The import settings changed since your preview. Look at the new preview, then apply it.", 409, "preview_changed");
    if (j.preview.undecided) throw new CatalogueError(`Choose what to do with ${j.preview.undecided} ${j.preview.undecided === 1 ? "row" : "rows"} that match deleted products.`, 409, "decisions_required");
    if (j.options.stopOnError && j.preview.errors) throw new CatalogueError("Some rows have errors. Fix them (or turn off \"stop if any row has an error\").", 409, "has_errors");
    if (j.preview.toHide > j.preview.catalogueSize / 2 && !b.confirmHide) throw new CatalogueError(`This would hide ${j.preview.toHide} of your ${j.preview.catalogueSize} products. Confirm to continue.`, 409, "confirm_hide", undefined, { toHide: j.preview.toHide });
  }
  await acquireLock(d.db, id, (d.now ?? Date.now)());
  const u = (await d.db.importJobs.updateWhere(id, { status: j.status }, { set: { status: "committing", committedAt: iso(d), progress: { done: 0, total: j.rowCount }, updatedAt: iso(d) } }));
  if (!u) { await releaseLock(d.db, id); throw new CatalogueError("The import changed at the same time. Please try again.", 409); }
  const run = apply(d, u).catch(async (e) => {
    console.error("import failed", e);
    await d.db.importJobs.update(id, { status: "failed", error: e instanceof Error ? e.message : String(e), updatedAt: iso(d) });
  }).finally(async () => { await releaseLock(d.db, id); running.delete(id); });
  running.set(id, run);
  return u;
}

async function apply(d: ImportDeps, j: ImportJob): Promise<void> {
  const ctx: WriteCtx = { db: d.db, user: d.user, now: d.now };
  const db = d.db;
  const rows = await db.importRows.find({ jobId: j.id }, { sort: { rowNo: 1 } });
  const result = { created: 0, updated: 0, unchanged: 0, restored: 0, hidden: 0, conflicts: 0, failed: 0, skipped: 0 };
  const pv = j.preview!;

  // 1. Categories and properties the preview said would be created; new values for existing choice properties.
  const cats = new Map((await db.categories.find({})).map((c) => [c.name.trim().toLowerCase(), c.id]));
  for (const name of pv.newCategories) {
    if (cats.has(name.toLowerCase())) continue;
    const fromFile = j.catalogue?.categories.find((c) => c.name === name);
    let slug = fromFile?.slug ?? (name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "category");
    for (let n = 2; await db.categories.count({ slug }); n++) slug = `${slug.replace(/-\d+$/, "")}-${n}`;
    const c = await db.categories.insert({ name, slug });
    cats.set(name.toLowerCase(), c.id);
    await audit(db, d.user, "create", "category", c.id, undefined, { name, slug, importJobId: j.id });
  }
  for (const p of pv.newProperties) {
    if (await db.attributes.get(p.key)) continue;
    // Public ones take the file's settings when the file had them public; otherwise they are only shown on the page.
    const flags = !p.public ? { filterable: false, searchable: false, showOnProduct: false }
      : p.fileSettings?.public ? { filterable: p.fileSettings.filterable, searchable: p.fileSettings.searchable, showOnProduct: p.fileSettings.showOnProduct }
      : { filterable: false, searchable: false, showOnProduct: true };
    const options = p.optionDefs ?? p.options?.map((label) => ({ label }));
    await createAttribute(db, d.user, { key: p.key, label: p.label, type: p.type, ...(options ? { options } : {}), ...(p.unit ? { unit: p.unit } : {}), visibility: p.public ? "public" : "internal", ...flags, origin: { importJobId: j.id } }, { batch: true });
  }
  for (const [key, labels] of Object.entries(pv.newOptions)) {
    const def = await db.attributes.get(key);
    if (!def) continue;
    const opts = [...(def.options ?? [])];
    for (const l of labels) if (!findOption(def, l)) opts.push({ value: optionValue(l), label: l, position: opts.length });
    await db.attributes.updateWhere(key, { version: def.version }, { set: { options: opts, updatedAt: iso(d) }, inc: { version: 1 } });
    await audit(db, d.user, "update", "attribute", key, { options: def.options }, { options: opts, importJobId: j.id });
  }
  for (const g of j.catalogue?.variantGroups ?? []) {
    if (await db.variantGroups.get(g.id)) continue;
    await db.variantGroups.insert({ id: g.id, name: g.name, differentiators: g.differentiators, version: 1, createdAt: iso(d), updatedAt: iso(d), updatedBy: d.user });
  }

  const mediaUrl = new Map<string, string>();
  let copiedBytes = 0;
  // https images first, a few at a time: downloaded, checked again and stored (C7). A failure fails only the rows
  // that use that image.
  const remoteFailed = new Map<string, string>();
  if ((j.options.remoteImages ?? "download") === "download") {
    const srcs = [...new Set(rows.filter((r) => r.state === "pending" && r.plan?.action !== "error").flatMap((r) => (r.plan?.media ?? []).filter((m) => m.kind === "remote").map((m) => m.source)))].slice(0, MAX_MEDIA_FILES);
    await pool(srcs, CONFIG.import.remote.concurrency, async (src) => {
      const r = await downloadRemote(db, d.media, src);
      if (!r.ok) { remoteFailed.set(src, r.error); return; }
      if ((copiedBytes += r.size) > MAX_MEDIA_BYTES) { remoteFailed.set(src, `The images to copy add up to more than ${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)} MB per import.`); return; }
      mediaUrl.set(src, r.url);
      await audit(db, d.user, "download", "image", r.url, undefined, { source: src.slice(0, 2000), importJobId: j.id });
    });
  }
  const images = async (srcs: string[] | undefined) => {
    if (!srcs) return undefined;
    const out: string[] = [];
    for (const s of srcs) {
      if (mediaUrl.has(s)) { out.push(mediaUrl.get(s)!); continue; }
      const failed = remoteFailed.get(s);
      if (failed) throw new CatalogueError(failed, 400, "invalid", [{ field: "images", message: failed }]);
      const r = await resolveImage(s, d.media);
      if (!r.ok) throw new CatalogueError(r.error, 400, "invalid", [{ field: "images", message: r.error }]);
      if (mediaUrl.size >= MAX_MEDIA_FILES) throw new CatalogueError(`At most ${MAX_MEDIA_FILES} different images per import.`, 400);
      if (r.kind === "server" && (copiedBytes += r.size) > MAX_MEDIA_BYTES) throw new CatalogueError(`The images to copy add up to more than ${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)} MB per import.`, 400);
      const url = r.kind === "server" ? await copyServerImage(db, d.media, r.resolved, r.ext) : r.url;
      if (r.kind === "server") await audit(db, d.user, "copy", "image", url, undefined, { source: s, importJobId: j.id });
      mediaUrl.set(s, url); out.push(url);
    }
    return out;
  };
  const productIdByRow = new Map<number, string>();
  const done = async (row: ImportRow, state: ImportRow["state"], message: string | null = null, productId?: string) => {
    await db.importRows.update(row.id, { state, message, ...(productId ? { plan: { ...row.plan!, productId } } : {}) });
  };
  let processed = 0;
  const tick = async () => {
    if (++processed % BATCH === 0) {
      await db.importJobs.update(j.id, { progress: { done: processed, total: rows.length }, updatedAt: iso(d) });
      await catalogueChanged(db, { rerender: false });
      await yieldLoop();
    }
  };

  const applyRow = async (row: ImportRow) => {
    const plan = row.plan!;
    if (row.state !== "pending") { if (plan.productId) productIdByRow.set(row.rowNo, plan.productId); return; }
    if (plan.action === "error") { result.failed++; await done(row, "failed", plan.errors?.map((e) => `${e.column}: ${e.message}`).join("; ") ?? null); return; }
    if (plan.action === "unchanged") { result.unchanged++; if (plan.productId) productIdByRow.set(row.rowNo, plan.productId); await done(row, plan.deletedMatch?.decision === "skip" ? "skipped" : "applied"); if (plan.deletedMatch?.decision === "skip") { result.skipped++; result.unchanged--; } return; }
    const set = { ...(plan.set ?? {}) } as Record<string, unknown>;
    const variant = plan.variant;
    let groupOnly = false;
    try {
      if (set.category !== undefined) { set.categoryId = cats.get(String(set.category).toLowerCase()) ?? null; delete set.category; }
      if (set.images) set.images = await images(set.images as string[]);
      if (plan.bundleRefs && set.bundle) {
        const comps: { productId: string; qty: number }[] = [];
        for (const r of plan.bundleRefs) {
          const claim = await db.productSkus.get(normalizeSku(r.ref));
          const pid = (await db.products.get(r.ref))?.id ?? claim?.productId;
          if (!pid) throw new CatalogueError(`no product with SKU or id ${r.ref}`, 400);
          comps.push({ productId: pid, qty: r.qty });
        }
        set.bundle = { ...(set.bundle as object), components: comps };
      }
      let pid: string;
      if (plan.action === "create") {
        const dm = plan.deletedMatch;
        if (dm?.decision === "new" && set.sku) {
          // "Create as a new product": the SKU moves from the deleted product to the new one (C24).
          const old = await db.products.get(dm.productId);
          if (old?.sku && normalizeSku(old.sku) === normalizeSku(String(set.sku))) {
            const newId = randomUUID();
            if (!(await transferSku(db, old.sku, old.id, newId))) throw new CatalogueError("The SKU changed at the same time.", 409, "version_conflict");
            try { await createProduct(ctx, set as never, { batch: true, id: newId }); }
            catch (e) { await transferSku(db, old.sku, newId, old.id); throw e; }
            await db.products.updateWhere(old.id, {}, { set: { sku: null, formerSku: old.sku }, inc: { version: 1 } });
            await audit(db, d.user, "move-sku", "product", old.id, { sku: old.sku }, { sku: null, formerSku: old.sku, movedTo: newId, importJobId: j.id });
            pid = newId;
          } else pid = (await createProduct(ctx, set as never, { batch: true })).id;
        } else {
          try { pid = (await createProduct(ctx, set as never, { batch: true, ...(plan.newId ? { id: plan.newId } : {}) })).id; }
          catch (e) { if (e instanceof DuplicateKeyError && plan.newId && (await db.products.get(plan.newId))) throw new CatalogueError("a product with this id was added since your preview", 409, "id_taken"); throw e; }
        }
        if (plan.createDeleted) toDelete.push(pid);
        result.created++;
      } else {
        pid = plan.productId!;
        if (plan.deletedMatch?.decision === "restore") { await restoreProduct(ctx, pid); result.restored++; }
        const { stock, ...rest } = set;
        const input = { ...rest, ...(stock !== undefined ? { stock } : {}) } as Record<string, unknown>;
        if (Object.keys(input).length) {
          await updateProduct(ctx, pid, input as never, { batch: true, version: plan.deletedMatch?.decision === "restore" ? undefined : plan.baseVersion ?? 0, ...(stock !== undefined && plan.baseStock !== undefined ? { guard: { stock: plan.baseStock } } : {}) });
          result.updated++;
        } else if (variant?.changed) groupOnly = true; // counted when its group changes (step 3)
        else result.unchanged++;
      }
      productIdByRow.set(row.rowNo, pid);
      await done(row, "applied", null, pid);
      if (variant?.changed) pendingVariants.push({ row, pid, variant, groupOnly });
    } catch (e) {
      if (!(e instanceof CatalogueError)) throw e;
      const conflict = e.status === 409;
      if (conflict) result.conflicts++; else result.failed++;
      await done(row, conflict ? "conflict" : "failed", e.code === "version_conflict" ? "changed (or sold) since your preview: not applied. Preview again to apply it." : e.message);
    }
  };
  const pendingVariants: { row: ImportRow; pid: string; variant: NonNullable<RowPlan["variant"]>; groupOnly: boolean }[] = [];
  const toDelete: string[] = [];

  // 2. Products (simple first, then bundles, so bundles can contain products created by this file).
  for (const row of rows) if (!row.plan?.bundleRefs && String(row.plan?.set?.type ?? "") !== "bundle") { await applyRow(row); await tick(); }
  for (const row of rows) if (row.plan?.bundleRefs || String(row.plan?.set?.type ?? "") === "bundle") { await applyRow(row); await tick(); }

  // Products deleted in the file go to Deleted products once the bundles that contain them exist.
  for (const id of toDelete) {
    const at = iso(d);
    if (await db.products.updateWhere(id, { deletedAt: null }, { set: { active: false, deletedAt: at, deletedBy: d.user, updatedAt: at, updatedBy: d.user }, inc: { version: 1 } }))
      await audit(db, d.user, "delete", "product", id, { deletedAt: null }, { deletedAt: at, importJobId: j.id, reason: "deleted in the imported file" });
  }

  // 3. Variant groups: membership is set once all products exist, and checked again for duplicates (C21).
  const defs = await loadDefs(db);
  const byGroup = new Map<string | null, typeof pendingVariants>();
  for (const v of pendingVariants) byGroup.set(v.variant.group, [...(byGroup.get(v.variant.group) ?? []), v]);
  for (const [g, list] of byGroup) {
    if (g === null) {
      for (const v of list) { await db.products.updateWhere(v.pid, {}, { set: { variantGroupId: null }, inc: { version: 1 } }); if (v.groupOnly) result.updated++; }
      continue;
    }
    const keys = list[0].variant.by ?? [];
    let group = await db.variantGroups.get(g);
    // A new group is named after its first variant (lowest variant_position, else the first row); renamed in the Variants panel.
    const first = list.reduce((a, v) => ((v.variant.position ?? Infinity) < (a.variant.position ?? Infinity) ? v : a), list[0]);
    if (!group) group = await db.variantGroups.insert({ id: g, name: String((await db.products.get(first.pid))?.name ?? g).slice(0, 120), differentiators: keys.map((key) => ({ key, order: "products" })), version: 1, createdAt: iso(d), updatedAt: iso(d), updatedBy: d.user });
    else if (keys.length && keys.join("|") !== group.differentiators.map((x) => x.key).join("|")) {
      group = (await db.variantGroups.updateWhere(g, { version: group.version }, { set: { differentiators: keys.map((key) => ({ key, order: group!.differentiators.find((x) => x.key === key)?.order ?? "products" })), updatedAt: iso(d), updatedBy: d.user }, inc: { version: 1 } })) ?? group;
    }
    const current = (await db.products.find({ variantGroupId: g })).filter((p) => !list.some((v) => v.pid === p.id));
    const incoming = await Promise.all(list.map(async (v) => ({ v, p: (await db.products.get(v.pid))! })));
    const members = [...current, ...incoming.map(({ v, p }) => ({ ...p, variantPosition: v.variant.position ?? p.variantPosition }))];
    const dups = findDuplicates(members.sort(byPosition), group.differentiators, defs);
    const rejected = new Set(dups.flatMap((c) => [c.productId]).filter((id) => list.some((v) => v.pid === id)));
    for (const { v, p } of incoming) {
      if (rejected.has(v.pid)) { result.conflicts++; await done(v.row, "conflict", "same values as another variant: not added to the group"); continue; }
      await db.products.updateWhere(p.id, {}, { set: { variantGroupId: g, ...(v.variant.position !== null ? { variantPosition: v.variant.position } : {}) }, inc: { version: 1 } });
      if (v.groupOnly) result.updated++;
    }
    await db.variantGroups.updateWhere(g, {}, { inc: { version: 1 }, set: { updatedAt: iso(d) } });
  }

  // 4. "Hide products that aren't in the file" (never delete).
  if (j.options.missing === "hide" && j.options.mode !== "create") {
    const inFile = new Set([...productIdByRow.values(), ...rows.map((r) => r.plan?.productId).filter(Boolean)]);
    for (const p of await db.products.find({ active: true, deletedAt: null })) {
      if (inFile.has(p.id)) continue;
      try { await updateProduct(ctx, p.id, { active: false }, { batch: true }); result.hidden++; } catch (e) { if (!(e instanceof CatalogueError)) throw e; }
    }
  }

  await catalogueChanged(db);
  await db.importJobs.update(j.id, { status: "done", result, progress: { done: rows.length, total: rows.length }, updatedAt: iso(d) });
  await audit(db, d.user, "import", "import", j.id, undefined, { filename: j.filename, sha256: j.sha256, options: j.options, result });
}

// ------------------------------------------------------------------------------------------------ housekeeping

/** Startup: commits cut short by a restart become "interrupted" (resumable); old jobs and their rows are removed. */
export async function importHousekeeping(db: Db, now = Date.now()): Promise<void> {
  for (const j of await db.importJobs.find({ status: "committing" })) if (!running.has(j.id)) await db.importJobs.update(j.id, { status: "interrupted", updatedAt: new Date(now).toISOString() });
  for (const j of await db.importJobs.find({ expiresAt: { $lt: new Date(now).toISOString() } })) {
    if (j.status === "committing") continue;
    for (const r of await db.importRows.find({ jobId: j.id })) await db.importRows.delete(r.id);
    await db.importJobs.delete(j.id);
  }
}

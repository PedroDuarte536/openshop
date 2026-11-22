// Product properties ("Colour", "Capacity"): defined once, filled per product, optionally shown, filtered and searched
// in the shop. Internal properties never leave the admin API (C1, C2).
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { DuplicateKeyError } from "@openshop/db";
import { safeColor } from "@openshop/renderer";
import { strictValidator } from "../strict.ts";
import { audit } from "../audit.ts";
import type { AttributeDef, AttributeOption, AttributeType, Db } from "../types.ts";
import { CatalogueError, isAttrKey, type FieldError } from "./model.ts";
import { catalogueChanged } from "./meta.ts";
import { sendCatalogueError } from "./products.ts";
import { CONFIG } from "../config.ts";

const strict = { validatorCompiler: strictValidator };
export const ATTR_TYPES: AttributeType[] = ["text", "choice", "multi", "number", "boolean"];
export const MAX_ATTRIBUTES = CONFIG.catalogue.maxProperties;
export const MAX_OPTIONS = CONFIG.catalogue.maxOptionsPerProperty;

/** "Temperature (ºC)" -> "temperature_c". Keys start with a letter; reserved names are avoided. */
export function keyFromLabel(label: string): string {
  let k = label.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
  if (!/^[a-z]/.test(k)) k = `p_${k}`.slice(0, 32);
  return isAttrKey(k) ? k : `p_${k}`.replace(/_+$/, "").slice(0, 32) || "property";
}
/** Option values: lower-case slugs of the label. */
export const optionValue = (label: string) => label.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "value";

const optionShape = { type: "object", additionalProperties: false, required: ["label"], properties: { value: { type: "string", maxLength: 40 }, label: { type: "string", maxLength: 80 }, swatch: { type: ["string", "null"], maxLength: 64 } } } as const;
const props = {
  label: { type: "string", maxLength: 80 }, type: { type: "string", enum: ATTR_TYPES }, unit: { type: ["string", "null"], maxLength: 12 },
  options: { type: "array", maxItems: MAX_OPTIONS, items: optionShape },
  visibility: { type: "string", enum: ["public", "internal"] }, filterable: { type: "boolean" }, searchable: { type: "boolean" }, showOnProduct: { type: "boolean" },
  position: { type: "integer" },
} as const;
const createSchema = { type: "object", additionalProperties: false, required: ["label", "type"], properties: { ...props, key: { type: "string", maxLength: 32 } } } as const;
const patchSchema = { type: "object", additionalProperties: false, required: ["version"], properties: { ...props, version: { type: "integer" } } } as const;

/** Cleans a list of options: values from labels when missing, unique values, positions in list order. */
export function normalizeOptions(raw: { value?: string; label: string; swatch?: string | null }[] | undefined, errors: FieldError[]): AttributeOption[] {
  const out: AttributeOption[] = [];
  const seen = new Set<string>();
  for (const o of raw ?? []) {
    const label = o.label.replace(/[\u0000-\u001f\u007f]/g, "").trim();
    if (!label) { errors.push({ field: "options", message: "every value needs a name" }); continue; }
    const value = o.value ? optionValue(o.value) : optionValue(label);
    if (seen.has(value)) { errors.push({ field: "options", message: `"${label}" is listed twice` }); continue; }
    seen.add(value);
    const swatch = o.swatch ? safeColor(o.swatch) : null;
    if (o.swatch && !swatch) errors.push({ field: "options", message: `"${label}": the colour must be like #1f6feb` });
    out.push({ value, label, position: out.length, ...(swatch ? { swatch } : {}) });
  }
  return out;
}

/** How many products (not deleted) use each property, and which option values are in use. */
export async function attributeUsage(db: Db): Promise<Map<string, { products: number; values: Set<string> }>> {
  const usage = new Map<string, { products: number; values: Set<string> }>();
  for (const p of await db.products.find({ deletedAt: null })) {
    for (const [k, v] of Object.entries(p.attributes ?? {})) {
      let u = usage.get(k);
      if (!u) { u = { products: 0, values: new Set() }; usage.set(k, u); }
      u.products++;
      for (const x of Array.isArray(v) ? v : [v]) u.values.add(String(x));
    }
  }
  return usage;
}

/** Properties used as variant differentiators, with the groups that use them. */
async function differentiatorUse(db: Db): Promise<Map<string, string[]>> {
  const m = new Map<string, string[]>();
  for (const g of await db.variantGroups.find({})) for (const d of g.differentiators) m.set(d.key, [...(m.get(d.key) ?? []), g.name]);
  return m;
}

export interface CreateAttributeInput { key?: string; label: string; type: AttributeType; unit?: string | null; options?: { value?: string; label: string; swatch?: string | null }[]; visibility?: "public" | "internal"; filterable?: boolean; searchable?: boolean; showOnProduct?: boolean; position?: number; origin?: AttributeDef["origin"] }

/** Creates a property. Shared with import (which creates properties as internal, C25). */
export async function createAttribute(db: Db, user: string, b: CreateAttributeInput, opts: { batch?: boolean } = {}): Promise<AttributeDef> {
  const errors: FieldError[] = [];
  const label = b.label.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!label) errors.push({ field: "label", message: "is required" });
  const key = b.key ?? keyFromLabel(label);
  if (!isAttrKey(key)) errors.push({ field: "key", message: "lower-case letters, digits and _, starting with a letter (at most 32)" });
  const options = b.type === "choice" || b.type === "multi" ? normalizeOptions(b.options, errors) : [];
  if (b.unit && b.type !== "number") errors.push({ field: "unit", message: "only numbers have a unit" });
  if (errors.length) throw new CatalogueError("Please fix the highlighted fields.", 400, "invalid", errors);
  if ((await db.attributes.count()) >= MAX_ATTRIBUTES) throw new CatalogueError(`A shop can have at most ${MAX_ATTRIBUTES} properties.`, 400, "limit");
  const at = new Date().toISOString();
  const visibility = b.visibility ?? "public";
  const def: Omit<AttributeDef, "id"> = {
    key, label, type: b.type, unit: b.type === "number" ? (b.unit?.trim() || null) : null, options, visibility,
    filterable: visibility === "public" && (b.filterable ?? (b.type === "choice" || b.type === "multi" || b.type === "boolean")),
    searchable: visibility === "public" && (b.searchable ?? b.type !== "number"),
    showOnProduct: visibility === "public" && (b.showOnProduct ?? true),
    position: b.position ?? (await db.attributes.count()), origin: b.origin ?? null, version: 1, createdAt: at, updatedAt: at,
  };
  let d: AttributeDef;
  // id = key keeps keys unique through the primary key.
  try { d = await db.attributes.insert({ id: key, ...def }); }
  catch (e) { if (e instanceof DuplicateKeyError) throw new CatalogueError(`A property with the key "${key}" already exists.`, 409, "key_taken", [{ field: "key", message: "already used" }]); throw e; }
  await audit(db, user, "create", "attribute", d.id, undefined, d);
  if (!opts.batch) await catalogueChanged(db, { rerender: false });
  return d;
}

export function registerAttributeAdmin(admin: FastifyInstance, { db }: { db: Db }) {
  const userOf = (req: FastifyRequest) => req.userId ?? "unknown";
  const run = async <T>(reply: FastifyReply, fn: () => Promise<T>) => { try { return await fn(); } catch (e) { return sendCatalogueError(reply, e); } };
  const view = (d: AttributeDef, usage: Map<string, { products: number; values: Set<string> }>, diff: Map<string, string[]>) =>
    ({ ...d, usedBy: usage.get(d.key)?.products ?? 0, variantGroups: diff.get(d.key) ?? [] });

  admin.get("/api/attributes", async () => {
    const [defs, usage, diff] = await Promise.all([db.attributes.find({}, { sort: { position: 1 } }), attributeUsage(db), differentiatorUse(db)]);
    return defs.sort((a, b) => a.position - b.position || a.label.localeCompare(b.label)).map((d) => view(d, usage, diff));
  });

  admin.post("/api/attributes", { schema: { body: createSchema }, ...strict }, async (req, reply) =>
    run(reply, async () => reply.code(201).send(await createAttribute(db, userOf(req), req.body as CreateAttributeInput))));

  admin.patch<{ Params: { id: string } }>("/api/attributes/:id", { schema: { body: patchSchema }, ...strict }, async (req, reply) =>
    run(reply, async () => {
      const cur = await db.attributes.get(req.params.id);
      if (!cur) throw new CatalogueError("not found", 404);
      const b = req.body as Partial<CreateAttributeInput> & { version: number };
      if (b.version !== cur.version) throw new CatalogueError("This property was changed by someone else. Reload it and try again.", 409, "version_conflict");
      const errors: FieldError[] = [];
      const [usage, diff] = await Promise.all([attributeUsage(db), differentiatorUse(db)]);
      const used = usage.get(cur.key);
      const groups = diff.get(cur.key) ?? [];
      const type = b.type ?? cur.type;
      if (b.type && b.type !== cur.type) {
        if (used?.products) errors.push({ field: "type", message: `${used.products} products have a value; clear them (or export, fix and re-import) before changing the type` });
        if (groups.length) errors.push({ field: "type", message: `used to tell variants apart in ${groups.join(", ")}` });
      }
      const visibility = b.visibility ?? cur.visibility;
      if (visibility === "internal" && cur.visibility === "public" && groups.length) errors.push({ field: "visibility", message: `shoppers need it to choose variants in ${groups.join(", ")}` });
      let options = cur.options ?? [];
      if (b.options) {
        options = normalizeOptions(b.options, errors);
        const kept = new Set(options.map((o) => o.value));
        const removed = (cur.options ?? []).filter((o) => !kept.has(o.value) && used?.values.has(o.value));
        if (removed.length) errors.push({ field: "options", message: `still used by products: ${removed.map((o) => o.label).join(", ")}` });
      }
      if (b.unit && type !== "number") errors.push({ field: "unit", message: "only numbers have a unit" });
      const label = b.label !== undefined ? b.label.replace(/[\u0000-\u001f\u007f]/g, "").trim() : cur.label;
      if (!label) errors.push({ field: "label", message: "is required" });
      if (errors.length) throw new CatalogueError("Please fix the highlighted fields.", 400, "invalid", errors);
      const pub = visibility === "public";
      const set: Partial<AttributeDef> = {
        label, type, unit: type === "number" ? (b.unit !== undefined ? (b.unit?.trim() || null) : cur.unit ?? null) : null,
        options: type === "choice" || type === "multi" ? options : [], visibility,
        // Internal properties are never shown, filtered or searched in the shop.
        filterable: pub && (b.filterable ?? cur.filterable), searchable: pub && (b.searchable ?? cur.searchable), showOnProduct: pub && (b.showOnProduct ?? cur.showOnProduct),
        position: b.position ?? cur.position, updatedAt: new Date().toISOString(),
      };
      const u = await db.attributes.updateWhere(cur.id, { version: cur.version }, { set, inc: { version: 1 } });
      if (!u) throw new CatalogueError("This property was changed by someone else. Reload it and try again.", 409, "version_conflict");
      await audit(db, userOf(req), "update", "attribute", cur.id, cur, u);
      await catalogueChanged(db, { rerender: false });
      return view(u, usage, diff);
    }));

  admin.delete<{ Params: { id: string }; Querystring: { purge?: string } }>("/api/attributes/:id", async (req, reply) =>
    run(reply, async () => {
      const cur = await db.attributes.get(req.params.id);
      if (!cur) throw new CatalogueError("not found", 404);
      const groups = (await differentiatorUse(db)).get(cur.key) ?? [];
      if (groups.length) throw new CatalogueError(`This property tells variants apart in ${groups.join(", ")}. Change those groups first.`, 409, "in_use");
      const holders = (await db.products.find({})).filter((p) => p.attributes?.[cur.key] !== undefined);
      if (holders.length && req.query.purge !== "true") throw new CatalogueError(`${holders.length} products have a value for this property.`, 409, "in_use", undefined, { products: holders.length });
      for (const p of holders) {
        const { [cur.key]: _gone, ...rest } = p.attributes!;
        await db.products.updateWhere(p.id, {}, { set: { attributes: rest }, inc: { version: 1 } });
      }
      await db.attributes.delete(cur.id);
      await audit(db, userOf(req), "delete", "attribute", cur.id, cur, { clearedProducts: holders.length });
      await catalogueChanged(db);
      return reply.code(204).send();
    }));
}

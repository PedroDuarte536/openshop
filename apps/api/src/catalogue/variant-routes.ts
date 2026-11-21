// Variant groups (plan §2.8, owner's example): the owner links products and ticks the properties that tell them
// apart; values are read from the products. A product whose values all match another member is never added (V-3):
// every change is validated in full first, and the group version is bumped before members are written, so two
// concurrent edits can't both pass the check (C21).
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Filter } from "@openshop/db";
import { strictValidator } from "../strict.ts";
import { audit } from "../audit.ts";
import type { AttributeDef, Db, Product, VariantGroup } from "../types.ts";
import { CatalogueError, displayValue, isDeleted, normalizeAttributes, productType, type FieldError } from "./model.ts";
import { catalogueChanged } from "./meta.ts";
import { sendCatalogueError } from "./products.ts";
import { createProduct, loadDefs } from "./service.ts";
import { bundleAvailability, productsById } from "./bundles.ts";
import { optionValue } from "./attributes.ts";
import {
  byPosition, duplicateMessage, findDuplicates, GROUP_ID_RE, MAX_DIFFERENTIATORS, MAX_MEMBERS, uselessDifferentiators, unreachable, variantSelector,
  type Differentiator, type Defs,
} from "./variants.ts";

const strict = { validatorCompiler: strictValidator };
const diffShape = { type: "array", maxItems: MAX_DIFFERENTIATORS, items: { type: "object", additionalProperties: false, required: ["key"], properties: { key: { type: "string", maxLength: 32 }, order: { type: "string", enum: ["products", "sorted"] } } } } as const;
const ids = (max: number) => ({ type: "array", maxItems: max, items: { type: "string", maxLength: 64 } }) as const;
const suggestSchema = { type: "object", additionalProperties: false, required: ["productIds"], properties: { productIds: ids(MAX_MEMBERS), differentiators: diffShape, groupId: { type: "string", maxLength: 64 } } } as const;
const createSchema = { type: "object", additionalProperties: false, required: ["productIds", "differentiators"], properties: { id: { type: "string", maxLength: 64 }, name: { type: "string", maxLength: 120 }, productIds: ids(MAX_MEMBERS), differentiators: diffShape, makePublic: { type: "boolean" } } } as const;
const patchSchema = { type: "object", additionalProperties: false, required: ["version"], properties: { version: { type: "integer" }, name: { type: "string", maxLength: 120 }, differentiators: diffShape, add: ids(MAX_MEMBERS), remove: ids(MAX_MEMBERS), order: ids(MAX_MEMBERS), makePublic: { type: "boolean" } } } as const;
const variantSchema = { type: "object", additionalProperties: false, required: ["fromProductId", "values"], properties: { fromProductId: { type: "string", maxLength: 64 }, values: { type: "object", maxProperties: MAX_DIFFERENTIATORS, additionalProperties: { type: ["string", "number", "boolean", "null"], maxLength: 200 } }, name: { type: "string", maxLength: 200 } } } as const;

const SINGLE = new Set(["text", "choice", "number", "boolean"]);

/** Differentiators must be existing single-value properties; internal ones only if the owner agrees to publish them. */
function checkDifferentiators(diffs: Differentiator[], defs: Defs, makePublic: boolean): { errors: FieldError[]; toPublish: AttributeDef[] } {
  const errors: FieldError[] = [], toPublish: AttributeDef[] = [];
  if (!diffs.length) errors.push({ field: "differentiators", message: "tick at least one property" });
  if (new Set(diffs.map((d) => d.key)).size !== diffs.length) errors.push({ field: "differentiators", message: "a property is listed twice" });
  for (const d of diffs) {
    const def = defs.get(d.key);
    if (!def) errors.push({ field: "differentiators", message: `unknown property ${d.key}` });
    else if (!SINGLE.has(def.type)) errors.push({ field: "differentiators", message: `${def.label} can hold several values per product, so it can't tell variants apart` });
    else if (def.visibility !== "public") { if (makePublic) toPublish.push(def); else errors.push({ field: "differentiators", message: `${def.label} is internal: shoppers must see it to choose a variant (make it public)` }); }
  }
  return { errors, toPublish };
}

function throwIf(errors: FieldError[]) { if (errors.length) throw new CatalogueError(errors.map((e) => e.message).join("; "), 400, "invalid", errors); }

function assertNoDuplicates(members: Product[], diffs: Differentiator[], defs: Defs) {
  const dups = findDuplicates([...members].sort(byPosition), diffs, defs);
  if (dups.length) throw new CatalogueError(duplicateMessage(dups[0], diffs, defs), 409, "variant_duplicate", [{ field: "productIds", message: "same values as another variant" }], { conflicts: dups.map((c) => ({ ...c, message: duplicateMessage(c, diffs, defs) })) });
}

/** Members, values and warnings for the backoffice. */
async function groupView(db: Db, g: VariantGroup) {
  const defs = await loadDefs(db);
  const members = (await db.products.find({ variantGroupId: g.id })).sort(byPosition);
  const comps = await productsById(db, members.flatMap((m) => m.bundle?.components.map((c) => c.productId) ?? []));
  const visible = members.filter((m) => m.active && !isDeleted(m));
  return {
    ...g,
    differentiators: g.differentiators.map((d) => ({ ...d, label: defs.get(d.key)?.label ?? d.key, type: defs.get(d.key)?.type ?? "text", visibility: defs.get(d.key)?.visibility ?? "public" })),
    members: members.map((m) => ({
      id: m.id, name: m.name, sku: m.sku ?? null, price: m.price, active: m.active, deleted: isDeleted(m), position: m.variantPosition ?? null,
      available: productType(m) === "bundle" && m.bundle ? bundleAvailability(m.bundle, comps).available : m.stock,
      values: Object.fromEntries(g.differentiators.map((d) => [d.key, displayValue(m.attributes?.[d.key], defs.get(d.key))])),
    })),
    warnings: {
      duplicates: findDuplicates(members, g.differentiators, defs).map((c) => duplicateMessage(c, g.differentiators, defs)),
      useless: uselessDifferentiators(visible, g.differentiators, defs).map((k) => defs.get(k)?.label ?? k),
      unreachable: unreachable(visible, g.differentiators, defs).map((p) => ({ id: p.id, name: p.name })),
    },
  };
}

async function publish(db: Db, user: string, defs: AttributeDef[]) {
  for (const d of defs) {
    const u = await db.attributes.updateWhere(d.id, { version: d.version }, { set: { visibility: "public", showOnProduct: true, updatedAt: new Date().toISOString() }, inc: { version: 1 } });
    if (u) await audit(db, user, "update", "attribute", d.id, { visibility: d.visibility }, { visibility: "public", reason: "tells variants apart" });
  }
}

async function handleFor(db: Db, name: string): Promise<string> {
  const base = optionValue(name).slice(0, 56) || "variants";
  let id = base;
  for (let n = 2; await db.variantGroups.get(id); n++) id = `${base}-${n}`;
  return id;
}

export function registerVariantAdmin(admin: FastifyInstance, { db }: { db: Db }) {
  const userOf = (req: FastifyRequest) => req.userId ?? "unknown";
  const run = async <T>(reply: FastifyReply, fn: () => Promise<T>) => { try { return await fn(); } catch (e) { return sendCatalogueError(reply, e); } };
  const loadMembers = async (productIds: string[]) => {
    const unique = [...new Set(productIds)];
    const found = await productsById(db, unique);
    const missing = unique.filter((id) => !found.has(id));
    if (missing.length) throw new CatalogueError(`Unknown products: ${missing.slice(0, 5).join(", ")}`, 400, "invalid");
    return unique.map((id) => found.get(id)!);
  };
  const memberRules = (list: Product[], groupId: string | null) => {
    const errors: FieldError[] = [];
    for (const p of list) {
      if (isDeleted(p)) errors.push({ field: "productIds", message: `${p.name} is deleted` });
      else if (productType(p) === "bundle") errors.push({ field: "productIds", message: `${p.name} is a bundle; bundles can't be variants` });
      else if (p.variantGroupId && p.variantGroupId !== groupId) errors.push({ field: "productIds", message: `${p.name} is already in another variant group` });
    }
    return errors;
  };

  admin.get("/api/variant-groups", async () => {
    const groups = await db.variantGroups.find({}, { sort: { name: 1 } });
    const counts = new Map<string, number>();
    for (const p of await db.products.find({ deletedAt: null })) if (p.variantGroupId) counts.set(p.variantGroupId, (counts.get(p.variantGroupId) ?? 0) + 1);
    return groups.map((g) => ({ id: g.id, name: g.name, members: counts.get(g.id) ?? 0, differentiators: g.differentiators }));
  });

  admin.get<{ Params: { id: string } }>("/api/variant-groups/:id", async (req, reply) =>
    run(reply, async () => { const g = await db.variantGroups.get(req.params.id); if (!g) throw new CatalogueError("not found", 404); return groupView(db, g); }));

  // For the "Link as variants" dialog: which properties the products have (pre-ticked when their values differ),
  // and, for a choice of properties, the duplicates and warnings and what the shop would show.
  admin.post("/api/variant-groups/suggest", { schema: { body: suggestSchema }, ...strict }, async (req, reply) =>
    run(reply, async () => {
      const b = req.body as { productIds: string[]; differentiators?: Differentiator[]; groupId?: string };
      const products = await loadMembers(b.productIds);
      const defs = await loadDefs(db);
      const others = b.groupId ? (await db.products.find({ variantGroupId: b.groupId })).filter((m) => !b.productIds.includes(m.id) && !isDeleted(m)) : [];
      const all = [...products, ...others];
      const properties = [...defs.values()].filter((d) => all.some((p) => p.attributes?.[d.key] !== undefined)).sort((a, b) => a.position - b.position || a.label.localeCompare(b.label)).map((d) => {
        const values = all.map((p) => displayValue(p.attributes?.[d.key], d));
        return { key: d.key, label: d.label, type: d.type, visibility: d.visibility, usable: SINGLE.has(d.type), varies: new Set(values).size > 1, values: Object.fromEntries(all.map((p, i) => [p.id, values[i]])) };
      });
      const diffs = (b.differentiators ?? []).map((d) => ({ key: d.key, order: d.order ?? "products" as const }));
      let preview = null;
      if (diffs.length && diffs.every((d) => defs.has(d.key))) {
        const members = all.map((p, i) => ({ ...p, variantPosition: p.variantPosition ?? i }));
        const visible = members.filter((m) => m.active);
        preview = {
          duplicates: findDuplicates(members, diffs, defs).map((c) => ({ ...c, message: duplicateMessage(c, diffs, defs) })),
          useless: uselessDifferentiators(visible.length ? visible : members, diffs, defs).map((k) => defs.get(k)?.label ?? k),
          unreachable: unreachable(visible.length ? visible : members, diffs, defs).map((p) => ({ id: p.id, name: p.name })),
          selector: members.length ? variantSelector(members[0], visible.length ? visible : members, diffs, defs, (p) => p.stock, members) : [],
        };
      }
      return { products: all.map((p) => ({ id: p.id, name: p.name, active: p.active, inGroup: p.variantGroupId ?? null })), properties, preview };
    }));

  admin.post("/api/variant-groups", { schema: { body: createSchema }, ...strict }, async (req, reply) =>
    run(reply, async () => {
      const b = req.body as { id?: string; name?: string; productIds: string[]; differentiators: Differentiator[]; makePublic?: boolean };
      const products = await loadMembers(b.productIds);
      if (products.length < 2) throw new CatalogueError("Link at least 2 products.", 400, "invalid", [{ field: "productIds", message: "at least 2 products" }]);
      const defs = await loadDefs(db);
      const diffs = b.differentiators.map((d) => ({ key: d.key, order: d.order ?? "products" as const }));
      const { errors, toPublish } = checkDifferentiators(diffs, defs, !!b.makePublic);
      throwIf([...errors, ...memberRules(products, null)]);
      const members = products.map((p, i) => ({ ...p, variantPosition: i }));
      assertNoDuplicates(members, diffs, defs);
      const name = (b.name?.trim() || products[0].name).slice(0, 120);
      const id = b.id ?? await handleFor(db, name);
      if (!GROUP_ID_RE.test(id)) throwIf([{ field: "id", message: "lower-case letters, digits and dashes" }]);
      if (await db.variantGroups.get(id)) throw new CatalogueError(`A variant group "${id}" already exists.`, 409, "id_taken");
      await publish(db, userOf(req), toPublish);
      const at = new Date().toISOString();
      const g = await db.variantGroups.insert({ id, name, differentiators: diffs, version: 1, createdAt: at, updatedAt: at, updatedBy: userOf(req) });
      const linked: string[] = [];
      for (const m of members) {
        // Guarded: a product taken by another group (or deleted) at the same time isn't linked twice.
        const u = await db.products.updateWhere(m.id, { variantGroupId: null, deletedAt: null }, { set: { variantGroupId: id, variantPosition: m.variantPosition }, inc: { version: 1 } });
        if (!u) {
          for (const x of linked) await db.products.updateWhere(x, {}, { set: { variantGroupId: null }, inc: { version: 1 } });
          await db.variantGroups.delete(id);
          throw new CatalogueError(`${m.name} changed at the same time. Please try again.`, 409, "version_conflict");
        }
        linked.push(m.id);
      }
      await audit(db, userOf(req), "create", "variant-group", id, undefined, { name, differentiators: diffs, productIds: linked });
      await catalogueChanged(db);
      return reply.code(201).send(await groupView(db, g));
    }));

  admin.patch<{ Params: { id: string } }>("/api/variant-groups/:id", { schema: { body: patchSchema }, ...strict }, async (req, reply) =>
    run(reply, async () => {
      const g = await db.variantGroups.get(req.params.id);
      if (!g) throw new CatalogueError("not found", 404);
      const b = req.body as { version: number; name?: string; differentiators?: Differentiator[]; add?: string[]; remove?: string[]; order?: string[]; makePublic?: boolean };
      if (b.version !== g.version) throw new CatalogueError("This variant group was changed by someone else. Reload it and try again.", 409, "version_conflict");
      const defs = await loadDefs(db);
      const diffs = b.differentiators ? b.differentiators.map((d) => ({ key: d.key, order: d.order ?? "products" as const })) : g.differentiators;
      const { errors, toPublish } = b.differentiators ? checkDifferentiators(diffs, defs, !!b.makePublic) : { errors: [], toPublish: [] };
      const current = await db.products.find({ variantGroupId: g.id });
      const added = await loadMembers(b.add ?? []);
      errors.push(...memberRules(added, g.id));
      const removed = new Set(b.remove ?? []);
      let members = [...current.filter((m) => !removed.has(m.id)), ...added.filter((a) => !current.some((m) => m.id === a.id))];
      if (members.filter((m) => !isDeleted(m)).length > MAX_MEMBERS) errors.push({ field: "add", message: `at most ${MAX_MEMBERS} products in a group` });
      throwIf(errors);
      // Positions: the given order first, then the others as they were; new products at the end.
      const order = b.order ?? members.sort(byPosition).map((m) => m.id);
      const pos = new Map(order.map((id, i) => [id, i]));
      members = members.map((m) => ({ ...m, variantPosition: pos.get(m.id) ?? order.length + members.indexOf(m) }));
      assertNoDuplicates(members, diffs, defs);
      const name = b.name !== undefined ? (b.name.trim() || g.name).slice(0, 120) : g.name;
      const u = await db.variantGroups.updateWhere(g.id, { version: g.version }, { set: { name, differentiators: diffs, updatedAt: new Date().toISOString(), updatedBy: userOf(req) }, inc: { version: 1 } });
      if (!u) throw new CatalogueError("This variant group was changed by someone else. Reload it and try again.", 409, "version_conflict");
      await publish(db, userOf(req), toPublish);
      for (const id of removed) await db.products.updateWhere(id, { variantGroupId: g.id }, { set: { variantGroupId: null }, inc: { version: 1 } });
      for (const m of members) {
        const was = current.find((c) => c.id === m.id);
        if (was && was.variantPosition === m.variantPosition) continue;
        const where: Filter = was ? { variantGroupId: g.id } : { variantGroupId: null, deletedAt: null };
        if (!(await db.products.updateWhere(m.id, where, { set: { variantGroupId: g.id, variantPosition: m.variantPosition }, inc: { version: 1 } })) && !was) {
          throw new CatalogueError(`${m.name} was linked to another group at the same time.`, 409, "version_conflict");
        }
      }
      await audit(db, userOf(req), "update", "variant-group", g.id, { name: g.name, differentiators: g.differentiators }, { name, differentiators: diffs, added: added.map((a) => a.id), removed: [...removed], order: b.order ?? null });
      await catalogueChanged(db);
      return groupView(db, u);
    }));

  // "Add a variant": a hidden copy of a member with other values. Refused (nothing created) if the values already exist.
  admin.post<{ Params: { id: string } }>("/api/variant-groups/:id/variants", { schema: { body: variantSchema }, ...strict }, async (req, reply) =>
    run(reply, async () => {
      const g = await db.variantGroups.get(req.params.id);
      if (!g) throw new CatalogueError("not found", 404);
      const b = req.body as { fromProductId: string; values: Record<string, string | number | boolean | null>; name?: string };
      const from = await db.products.get(b.fromProductId);
      if (!from || from.variantGroupId !== g.id) throw new CatalogueError("Start from a product of this group.", 400, "invalid");
      const defs = await loadDefs(db);
      const attributes: Record<string, unknown> = { ...(from.attributes ?? {}) };
      for (const d of g.differentiators) if (d.key in b.values) { const v = b.values[d.key]; if (v === null || v === "") delete attributes[d.key]; else attributes[d.key] = v; }
      const members = await db.products.find({ variantGroupId: g.id });
      const last = Math.max(-1, ...members.map((m) => m.variantPosition ?? -1));
      // Validate the new product's values first (so "Blue" matches the stored "blue"), then check for duplicates.
      const norm = normalizeAttributes(attributes as never, defs);
      throwIf(norm.errors);
      const candidate = { ...from, id: "__new__", name: b.name?.trim() || `${from.name} (copy)`, attributes: norm.attrs, variantPosition: last + 1, deletedAt: null } as Product;
      assertNoDuplicates([...members, candidate], g.differentiators, defs);
      const bumped = await db.variantGroups.updateWhere(g.id, { version: g.version }, { inc: { version: 1 }, set: { updatedAt: new Date().toISOString(), updatedBy: userOf(req) } });
      if (!bumped) throw new CatalogueError("This variant group was changed at the same time. Please try again.", 409, "version_conflict");
      const p = await createProduct({ db, user: userOf(req) }, {
        name: candidate.name, price: from.price, active: false, stock: 0, categoryId: from.categoryId ?? null, description: from.description ?? "", images: from.images ?? [], attributes: norm.attrs,
      }, { extra: { variantGroupId: g.id, variantPosition: last + 1 } });
      return reply.code(201).send(p);
    }));

  admin.delete<{ Params: { id: string } }>("/api/variant-groups/:id", async (req, reply) =>
    run(reply, async () => {
      const g = await db.variantGroups.get(req.params.id);
      if (!g) throw new CatalogueError("not found", 404);
      const members = await db.products.find({ variantGroupId: g.id });
      for (const m of members) await db.products.updateWhere(m.id, { variantGroupId: g.id }, { set: { variantGroupId: null }, inc: { version: 1 } });
      await db.variantGroups.delete(g.id);
      await audit(db, userOf(req), "dissolve", "variant-group", g.id, { name: g.name, productIds: members.map((m) => m.id) });
      await catalogueChanged(db);
      return reply.code(204).send();
    }));
}

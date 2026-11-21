import { MongoClient, type Db, type Document } from "mongodb";
import { randomUUID } from "node:crypto";
import { DuplicateKeyError, type Change, type Collection, type DataStore, type Doc, type Filter, type FindOptions } from "./types.ts";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PATH = /^[A-Za-z_][A-Za-z0-9_.]*$/;

/** Our Filter is a Mongo-style subset, so it maps almost 1:1. `id` is stored as `_id`. */
function toMongoFilter(filter: Filter = {}): Document {
  const out: Document = {};
  for (const [field, cond] of Object.entries(filter)) {
    if (!PATH.test(field)) throw new Error(`Invalid field path: ${field}`);
    out[field === "id" ? "_id" : field] = cond;
  }
  return out;
}

class MongoCollection<T extends Doc> implements Collection<T> {
  private col;
  constructor(db: Db, name: string) { this.col = db.collection<Document>(name); }
  private out(d: Document): T {
    const { _id, ...rest } = d;
    return { ...rest, id: String(_id) } as T;
  }
  async insert(doc: Omit<T, "id"> & { id?: string }): Promise<T> {
    const { id, ...rest } = doc as Record<string, unknown>;
    const _id = (id as string | undefined) ?? randomUUID();
    try { await this.col.insertOne({ _id: _id as never, ...rest }); }
    catch (e) { if ((e as { code?: number }).code === 11000) throw new DuplicateKeyError(_id); throw e; }
    return { ...rest, id: _id } as T;
  }
  async get(id: string): Promise<T | null> {
    const d = await this.col.findOne({ _id: id as never });
    return d ? this.out(d) : null;
  }
  async find(filter?: Filter, opts: FindOptions = {}): Promise<T[]> {
    let c = this.col.find(toMongoFilter(filter));
    if (opts.sort) {
      for (const f of Object.keys(opts.sort)) if (!PATH.test(f)) throw new Error(`Invalid field path: ${f}`);
      c = c.sort(Object.fromEntries(Object.entries(opts.sort).map(([f, d]) => [f === "id" ? "_id" : f, d])));
    }
    if (opts.skip) c = c.skip(opts.skip);
    if (opts.limit != null) c = c.limit(opts.limit);
    return (await c.toArray()).map((d) => this.out(d));
  }
  async count(filter?: Filter): Promise<number> {
    return this.col.countDocuments(toMongoFilter(filter));
  }
  /** $set per top-level field (nested objects are replaced); `undefined` removes the field, as in the SQLite adapter. */
  async update(id: string, patch: Partial<Omit<T, "id">>): Promise<T | null> {
    const $set: Document = {}, $unset: Document = {};
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
      if (k === "id") continue;
      if (!NAME.test(k)) throw new Error(`Invalid field name: ${k}`);
      if (v === undefined) $unset[k] = ""; else $set[k] = v;
    }
    const update: Document = {};
    if (Object.keys($set).length) update.$set = $set;
    if (Object.keys($unset).length) update.$unset = $unset;
    if (!Object.keys(update).length) return this.get(id);
    const d = await this.col.findOneAndUpdate({ _id: id as never }, update, { returnDocument: "after" });
    return d ? this.out(d) : null;
  }
  async delete(id: string): Promise<boolean> {
    return (await this.col.deleteOne({ _id: id as never })).deletedCount > 0;
  }
  async deleteWhere(filter: Filter): Promise<number> {
    if (!Object.keys(filter).length) throw new Error("deleteWhere needs a filter");
    return (await this.col.deleteMany(toMongoFilter(filter))).deletedCount;
  }
  /** findOneAndUpdate with the guard in the filter: atomic on the server. */
  async updateWhere(id: string, where: Filter, change: Change<T>): Promise<T | null> {
    const $set: Document = {}, $inc: Document = {};
    for (const [k, v] of Object.entries(change.set ?? {})) { if (!NAME.test(k) || k === "id") throw new Error(`Invalid field name: ${k}`); $set[k] = v ?? null; }
    for (const [k, v] of Object.entries(change.inc ?? {})) {
      if (!NAME.test(k) || k === "id") throw new Error(`Invalid field name: ${k}`);
      if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`Invalid increment for ${k}`);
      $inc[k] = v;
    }
    const filter = { ...toMongoFilter(where), _id: id as never };
    const update: Document = {};
    if (Object.keys($set).length) update.$set = $set;
    if (Object.keys($inc).length) update.$inc = $inc;
    if (!Object.keys(update).length) { const d = await this.col.findOne(filter); return d ? this.out(d) : null; }
    const d = await this.col.findOneAndUpdate(filter, update, { returnDocument: "after" });
    return d ? this.out(d) : null;
  }
}

export class MongoDataStore implements DataStore {
  private client: { close(): Promise<void> };
  private db: Db;
  /** `url` is a MongoDB connection string. Tests may pass an already-open database (`{ db, close }`) instead. */
  constructor(url: string | { db: Db; close(): Promise<void> }, dbName = "openshop") {
    if (typeof url === "string") {
      const client = new MongoClient(url);
      this.client = client;
      this.db = client.db(dbName);
    } else {
      this.client = url;
      this.db = url.db;
    }
  }
  collection<T extends Doc = Doc>(name: string): Collection<T> {
    if (!NAME.test(name)) throw new Error(`Invalid collection name: ${name}`);
    return new MongoCollection<T>(this.db, name);
  }
  async close() { await this.client.close(); }
}

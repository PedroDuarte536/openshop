import { MongoClient, type Db, type Document } from "mongodb";
import { randomUUID } from "node:crypto";
import type { Collection, DataStore, Doc, Filter, FindOptions } from "./types.ts";

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
    await this.col.insertOne({ _id: _id as never, ...rest });
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
  async update(id: string, patch: Partial<Omit<T, "id">>): Promise<T | null> {
    const { id: _ignored, ...rest } = patch as Record<string, unknown>;
    const d = await this.col.findOneAndUpdate({ _id: id as never }, { $set: rest }, { returnDocument: "after" });
    return d ? this.out(d) : null;
  }
  async delete(id: string): Promise<boolean> {
    return (await this.col.deleteOne({ _id: id as never })).deletedCount > 0;
  }
}

export class MongoDataStore implements DataStore {
  private client: MongoClient;
  private db: Db;
  constructor(url: string, dbName = "openshop") {
    this.client = new MongoClient(url);
    this.db = this.client.db(dbName);
  }
  collection<T extends Doc = Doc>(name: string): Collection<T> {
    if (!NAME.test(name)) throw new Error(`Invalid collection name: ${name}`);
    return new MongoCollection<T>(this.db, name);
  }
  async close() { await this.client.close(); }
}

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { Collection, DataStore, Doc, Filter, FindOptions, Operators } from "./types.ts";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PATH = /^[A-Za-z_][A-Za-z0-9_.]*$/;

function assertName(n: string) {
  if (!NAME.test(n)) throw new Error(`Invalid collection name: ${n}`);
}
function jsonPath(field: string) {
  if (!PATH.test(field)) throw new Error(`Invalid field path: ${field}`);
  return `$.${field}`;
}

const OPS: Record<string, string> = {
  $eq: "=", $ne: "!=", $gt: ">", $gte: ">=", $lt: "<", $lte: "<=",
};

function toParam(v: unknown): string | number | null {
  if (typeof v === "boolean") return v ? 1 : 0;
  return v as string | number | null;
}

function buildWhere(filter: Filter = {}): { sql: string; params: (string | number | null)[] } {
  const parts: string[] = [];
  const params: (string | number | null)[] = [];
  for (const [field, cond] of Object.entries(filter)) {
    const expr = field === "id" ? "id" : `json_extract(data, '${jsonPath(field)}')`;
    if (cond === null) { parts.push(`${expr} IS NULL`); continue; }
    if (typeof cond !== "object") { parts.push(`${expr} = ?`); params.push(toParam(cond)); continue; }
    for (const [op, val] of Object.entries(cond as Operators)) {
      if (op === "$in") {
        const arr = val as unknown[];
        if (arr.length === 0) { parts.push("0"); continue; }
        parts.push(`${expr} IN (${arr.map(() => "?").join(",")})`);
        params.push(...arr.map(toParam));
      } else if (OPS[op]) {
        if (val === null) parts.push(`${expr} ${op === "$ne" ? "IS NOT" : "IS"} NULL`);
        else { parts.push(`${expr} ${OPS[op]} ?`); params.push(toParam(val)); }
      } else throw new Error(`Unsupported operator: ${op}`);
    }
  }
  return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", params };
}

class SqliteCollection<T extends Doc> implements Collection<T> {
  private db: DatabaseSync;
  private table: string;
  constructor(db: DatabaseSync, table: string) {
    this.db = db;
    this.table = table;
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
  }
  private parse(row: unknown): T {
    const { id, data } = row as { id: string; data: string };
    return { ...JSON.parse(data), id } as T;
  }
  async insert(doc: Omit<T, "id"> & { id?: string }): Promise<T> {
    const id = doc.id ?? randomUUID();
    const { id: _ignored, ...rest } = doc as Record<string, unknown>;
    this.db.prepare(`INSERT INTO ${this.table} (id, data) VALUES (?, ?)`).run(id, JSON.stringify(rest));
    return { ...rest, id } as T;
  }
  async get(id: string): Promise<T | null> {
    const row = this.db.prepare(`SELECT id, data FROM ${this.table} WHERE id = ?`).get(id);
    return row ? this.parse(row) : null;
  }
  async find(filter?: Filter, opts: FindOptions = {}): Promise<T[]> {
    const { sql, params } = buildWhere(filter);
    const order = Object.entries(opts.sort ?? {})
      .map(([f, d]) => `${f === "id" ? "id" : `json_extract(data, '${jsonPath(f)}')`} ${d === -1 ? "DESC" : "ASC"}`)
      .join(", ");
    let q = `SELECT id, data FROM ${this.table} ${sql}`;
    if (order) q += ` ORDER BY ${order}`;
    if (opts.limit != null || opts.skip) q += ` LIMIT ${Math.trunc(opts.limit ?? -1)} OFFSET ${Math.trunc(opts.skip ?? 0)}`;
    return this.db.prepare(q).all(...params).map((r) => this.parse(r));
  }
  async count(filter?: Filter): Promise<number> {
    const { sql, params } = buildWhere(filter);
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${this.table} ${sql}`).get(...params) as { n: number };
    return row.n;
  }
  async update(id: string, patch: Partial<Omit<T, "id">>): Promise<T | null> {
    const current = await this.get(id);
    if (!current) return null;
    const { id: _id, ...rest } = { ...current, ...patch } as Record<string, unknown>;
    this.db.prepare(`UPDATE ${this.table} SET data = ? WHERE id = ?`).run(JSON.stringify(rest), id);
    return { ...rest, id } as T;
  }
  async delete(id: string): Promise<boolean> {
    return this.db.prepare(`DELETE FROM ${this.table} WHERE id = ?`).run(id).changes > 0;
  }
}

export class SqliteDataStore implements DataStore {
  private db: DatabaseSync;
  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  }
  collection<T extends Doc = Doc>(name: string): Collection<T> {
    assertName(name);
    return new SqliteCollection<T>(this.db, name);
  }
  async close() { this.db.close(); }
}

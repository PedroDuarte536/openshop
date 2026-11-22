// A tiny in-memory stand-in for the parts of the MongoDB driver the adapter uses. It lets the adapter's own logic
// (id <-> _id, filter translation, duplicate-key mapping, updateWhere's $set/$inc) run in the shared contract suite
// when no MongoDB server is available. It is NOT MongoDB: real behaviour is covered by running the contract with MONGO_URL.
type D = Record<string, unknown>;

const get = (doc: D, path: string): unknown => path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as D)[k] : undefined), doc);
const cmp = (a: unknown, b: unknown) => (a === b ? 0 : (a as number) < (b as number) ? -1 : 1);

function matches(doc: D, filter: D): boolean {
  return Object.entries(filter).every(([path, cond]) => {
    const v = get(doc, path);
    if (cond === null) return v === null || v === undefined;
    if (typeof cond !== "object" || Array.isArray(cond)) return v === cond;
    return Object.entries(cond as D).every(([op, x]) => {
      switch (op) {
        case "$eq": return x === null ? v == null : v === x;
        case "$ne": return x === null ? v != null : v !== x;
        case "$gt": return v !== undefined && v !== null && cmp(v, x) > 0;
        case "$gte": return v !== undefined && v !== null && cmp(v, x) >= 0;
        case "$lt": return v !== undefined && v !== null && cmp(v, x) < 0;
        case "$lte": return v !== undefined && v !== null && cmp(v, x) <= 0;
        case "$in": return (x as unknown[]).includes(v);
        default: throw new Error(`fake-mongo: unsupported operator ${op}`);
      }
    });
  });
}

class Cursor {
  private docs: D[];
  constructor(docs: D[]) { this.docs = docs; }
  sort(spec: Record<string, 1 | -1>) {
    const keys = Object.entries(spec);
    this.docs.sort((a, b) => { for (const [k, d] of keys) { const c = cmp(get(a, k), get(b, k)); if (c) return c * d; } return 0; });
    return this;
  }
  skip(n: number) { this.docs = this.docs.slice(n); return this; }
  limit(n: number) { this.docs = this.docs.slice(0, n); return this; }
  async toArray() { return this.docs.map((d) => structuredClone(d)); }
}

class FakeCollection {
  private docs = new Map<unknown, D>();
  async insertOne(doc: D) {
    if (this.docs.has(doc._id)) throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
    this.docs.set(doc._id, structuredClone(doc));
    return { insertedId: doc._id };
  }
  async findOne(filter: D) { const d = [...this.docs.values()].find((x) => matches(x, filter)); return d ? structuredClone(d) : null; }
  find(filter: D = {}) { return new Cursor([...this.docs.values()].filter((x) => matches(x, filter))); }
  async countDocuments(filter: D = {}) { return [...this.docs.values()].filter((x) => matches(x, filter)).length; }
  async findOneAndUpdate(filter: D, update: { $set?: D; $unset?: D; $inc?: Record<string, number> }, _opts: unknown) {
    const d = [...this.docs.values()].find((x) => matches(x, filter));
    if (!d) return null;
    for (const [k, v] of Object.entries(update.$set ?? {})) d[k] = structuredClone(v);
    for (const k of Object.keys(update.$unset ?? {})) delete d[k];
    for (const [k, v] of Object.entries(update.$inc ?? {})) d[k] = ((d[k] as number) ?? 0) + v;
    return structuredClone(d);
  }
  async deleteMany(filter: D) {
    let n = 0;
    for (const d of [...this.docs.values()]) if (matches(d, filter)) { this.docs.delete(d._id); n++; }
    return { deletedCount: n };
  }
  async deleteOne(filter: D) {
    const d = [...this.docs.values()].find((x) => matches(x, filter));
    if (d) this.docs.delete(d._id);
    return { deletedCount: d ? 1 : 0 };
  }
}

export function fakeMongoDb() {
  const cols = new Map<string, FakeCollection>();
  return { collection(name: string) { let c = cols.get(name); if (!c) { c = new FakeCollection(); cols.set(name, c); } return c; } };
}

import assert from "node:assert/strict";
import { DuplicateKeyError, type DataStore } from "../src/index.ts";

type Product = { id: string; name: string; price: number; active: boolean; category: string | null };

/** Any adapter (SQLite, Mongo, ...) must pass this same suite. */
export async function runContract(store: DataStore, t: { test: Function }) {
  const products = store.collection<Product>("products");

  await t.test("insert generates id and get returns the doc", async () => {
    const p = await products.insert({ name: "Mug", price: 10, active: true, category: "home" });
    assert.ok(p.id);
    assert.deepEqual(await products.get(p.id), p);
    assert.equal(await products.get("missing"), null);
  });

  await t.test("find with equality, operators, sort, paging", async () => {
    await products.insert({ name: "Shirt", price: 25, active: true, category: "clothes" });
    await products.insert({ name: "Hat", price: 15, active: false, category: "clothes" });
    assert.equal((await products.find({ category: "clothes" })).length, 2);
    assert.equal((await products.find({ active: true })).length, 2);
    assert.deepEqual((await products.find({ price: { $gte: 15, $lt: 25 } })).map((p) => p.name).sort(), ["Hat"]);
    assert.deepEqual((await products.find({ name: { $in: ["Mug", "Hat"] } }, { sort: { price: -1 } })).map((p) => p.name), ["Hat", "Mug"]);
    assert.equal((await products.find({}, { sort: { price: 1 }, limit: 1, skip: 1 }))[0].name, "Hat");
    assert.equal(await products.count({ category: "clothes" }), 2);
  });

  await t.test("update merges, delete removes", async () => {
    const p = await products.insert({ name: "Pen", price: 2, active: true, category: null });
    const u = await products.update(p.id, { price: 3 });
    assert.equal(u?.price, 3);
    assert.equal(u?.name, "Pen");
    assert.equal(await products.update("missing", { price: 1 }), null);
    assert.equal(await products.delete(p.id), true);
    assert.equal(await products.delete(p.id), false);
  });

  await t.test("update replaces nested objects (no deep merge) and never loses a concurrent updateWhere", async () => {
    type Item = { id: string; name: string; stock: number; attrs?: Record<string, string> };
    const items = store.collection<Item>("contract_items");
    const it = await items.insert({ name: "A", stock: 100, attrs: { color: "blue", size: "m" } });
    const u = await items.update(it.id, { attrs: { color: "red" } });
    assert.deepEqual(u?.attrs, { color: "red" }, "the nested object is replaced, like Mongo $set");
    assert.equal(u?.stock, 100, "other fields are kept");
    // A product edit racing a checkout's atomic decrement: every decrement must survive.
    for (let i = 0; i < 50; i++) {
      await Promise.all([items.update(it.id, { name: `A${i}` }), items.updateWhere(it.id, { stock: { $gte: 1 } }, { inc: { stock: -1 } })]);
    }
    const after = (await items.get(it.id))!;
    assert.equal(after.stock, 50, "no decrement was overwritten by a concurrent update");
    assert.equal(after.name, "A49");
    await assert.rejects(() => items.update(it.id, { "a') OR 1=1 --": 1 } as never));
  });

  await t.test("deleteWhere removes only matching documents and refuses an empty filter", async () => {
    const events = store.collection<{ id: string; at: string; kind: string }>("contract_events");
    for (const [id, at, kind] of [["e1", "2026-01-01", "a"], ["e2", "2026-02-01", "a"], ["e3", "2026-03-01", "b"]]) await events.insert({ id, at, kind });
    assert.equal(await events.deleteWhere({ at: { $lt: "2026-02-15" }, kind: "a" }), 2);
    assert.deepEqual((await events.find({})).map((e) => e.id), ["e3"]);
    assert.equal(await events.deleteWhere({ kind: "zzz" }), 0);
    await assert.rejects(() => events.deleteWhere({}));
    await assert.rejects(() => events.deleteWhere({ "a') OR 1=1 --": 1 }));
  });

  await t.test("rejects unsafe collection and field names", async () => {
    assert.throws(() => store.collection("x; DROP TABLE y"));
    await assert.rejects(() => products.find({ "a') OR 1=1 --": 1 }));
  });

  type Counter = { id: string; used: number; total?: number; state?: string; tag?: string | null };
  const counters = store.collection<Counter>("contract_counters");

  await t.test("insert with an existing id throws DuplicateKeyError", async () => {
    await counters.insert({ id: "dup-1", used: 0 });
    await assert.rejects(() => counters.insert({ id: "dup-1", used: 5 }), DuplicateKeyError);
    assert.equal((await counters.get("dup-1"))?.used, 0);
  });

  await t.test("updateWhere applies set and inc only when the guard matches", async () => {
    await counters.insert({ id: "c-1", used: 2, state: "used" });
    const u = await counters.updateWhere("c-1", { used: { $lt: 3 } }, { inc: { used: 1, total: 250 }, set: { state: "more", tag: null } });
    assert.equal(u?.used, 3);
    assert.equal(u?.total, 250, "missing numeric fields count from 0");
    assert.equal(u?.state, "more");
    assert.equal(u?.tag, null);
    assert.equal(await counters.updateWhere("c-1", { used: { $lt: 3 } }, { inc: { used: 1 } }), null, "guard no longer matches");
    assert.equal((await counters.get("c-1"))?.used, 3, "a failed guard changes nothing");
    assert.equal(await counters.updateWhere("missing", {}, { inc: { used: 1 } }), null);
    const dec = await counters.updateWhere("c-1", { state: "more" }, { inc: { used: -3 } });
    assert.equal(dec?.used, 0);
  });

  await t.test("updateWhere is atomic: 50 concurrent single-use claims succeed exactly once", async () => {
    await counters.insert({ id: "single", used: 0 });
    const results = await Promise.all(Array.from({ length: 50 }, () => counters.updateWhere("single", { used: { $lt: 1 } }, { inc: { used: 1 } })));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal((await counters.get("single"))?.used, 1);
  });

  await t.test("updateWhere rejects unsafe or nested field names", async () => {
    await assert.rejects(() => counters.updateWhere("c-1", {}, { inc: { "a') OR 1=1 --": 1 } }));
    await assert.rejects(() => counters.updateWhere("c-1", {}, { set: { "a.b": 1 } as never }));
    await assert.rejects(() => counters.updateWhere("c-1", {}, { inc: { used: Number.NaN } }));
  });
}

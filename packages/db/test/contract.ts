import assert from "node:assert/strict";
import type { DataStore } from "../src/index.ts";

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

  await t.test("rejects unsafe collection and field names", async () => {
    assert.throws(() => store.collection("x; DROP TABLE y"));
    await assert.rejects(() => products.find({ "a') OR 1=1 --": 1 }));
  });
}

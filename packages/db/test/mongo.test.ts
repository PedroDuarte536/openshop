import { test } from "node:test";
import type { Db } from "mongodb";
import { MongoDataStore } from "../src/index.ts";
import { runContract } from "./contract.ts";
import { fakeMongoDb } from "./fake-mongo.ts";

test("MongoDataStore passes the DataStore contract", { skip: process.env.MONGO_URL ? false : "set MONGO_URL to run" }, async (t) => {
  const store = new MongoDataStore(process.env.MONGO_URL!, `openshop_test_${Date.now()}`);
  try { await runContract(store, t); } finally { await store.close(); }
});

// Without a server: the adapter's own logic against an in-memory stand-in for the driver (see fake-mongo.ts).
test("MongoDataStore adapter logic passes the DataStore contract (in-memory driver stand-in)", async (t) => {
  let closed = false;
  const store = new MongoDataStore({ db: fakeMongoDb() as unknown as Db, close: async () => { closed = true; } });
  await runContract(store, t);
  await store.close();
  if (!closed) throw new Error("close() was not forwarded");
});

test("MongoDataStore connects lazily: constructing and closing needs no server", async () => {
  const store = new MongoDataStore("mongodb://127.0.0.1:9/none", "openshop_lazy");
  store.collection("products");
  await store.close();
});

import { test } from "node:test";
import { MongoDataStore } from "../src/index.ts";
import { runContract } from "./contract.ts";

const url = process.env.MONGO_URL;

test("MongoDataStore passes the DataStore contract", { skip: !url && "set MONGO_URL to run" }, async (t) => {
  const store = new MongoDataStore(url!, `openshop_test_${Date.now()}`);
  await runContract(store, t);
  await store.close();
});

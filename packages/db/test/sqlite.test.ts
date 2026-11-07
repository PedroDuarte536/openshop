import { test } from "node:test";
import { SqliteDataStore } from "../src/index.ts";
import { runContract } from "./contract.ts";

test("SqliteDataStore passes the DataStore contract", async (t) => {
  const store = new SqliteDataStore(":memory:");
  await runContract(store, t);
  await store.close();
});

import { SqliteDataStore } from "@openshop/db";
import { buildApp } from "./app.ts";

const store = new SqliteDataStore(process.env.DB_PATH ?? "openshop.db");
const app = buildApp(store);

const shutdown = async () => { await app.close(); await store.close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });

import { randomBytes } from "node:crypto";
import { SqliteDataStore, MongoDataStore } from "@openshop/db";
import { buildApp } from "./app.ts";
import { ensureAdmin } from "./auth.ts";
import { openDb } from "./types.ts";

const store = process.env.MONGO_URL ? new MongoDataStore(process.env.MONGO_URL) : new SqliteDataStore(process.env.DB_PATH ?? "openshop.db");

if (!process.env.AUTH_SECRET) console.warn("AUTH_SECRET not set: using a random secret, sessions end on restart.");

const db = openDb(store);
const email = process.env.ADMIN_EMAIL ?? "admin@example.com";
if (process.env.ADMIN_PASSWORD) {
  await ensureAdmin(db, email, process.env.ADMIN_PASSWORD);
} else if ((await db.users.count()) === 0) {
  const pw = randomBytes(9).toString("base64url");
  await ensureAdmin(db, email, pw);
  console.warn(`First run: created admin ${email} with password ${pw} (shown once; set ADMIN_PASSWORD to choose your own).`);
}

const app = buildApp(store, { authSecret: process.env.AUTH_SECRET, uploadDir: process.env.UPLOAD_DIR ?? "uploads" });
const shutdown = async () => { await app.close(); await store.close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });

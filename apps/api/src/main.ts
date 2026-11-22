import { randomBytes } from "node:crypto";
import { SqliteDataStore, MongoDataStore } from "@openshop/db";
import { buildApp, parseTrustProxy } from "./app.ts";
import { createSudo, ensureAdmin } from "./auth.ts";
import { migrateIam } from "./migrations.ts";
import { openDb } from "./types.ts";

const store = process.env.MONGO_URL ? new MongoDataStore(process.env.MONGO_URL) : new SqliteDataStore(process.env.DB_PATH ?? "openshop.db");

if (!process.env.AUTH_SECRET) console.warn("AUTH_SECRET not set: using a random secret, sessions end on restart.");

const db = openDb(store);
const email = process.env.ADMIN_EMAIL ?? "admin@example.com";
// Databases from before staff accounts: one user becomes the owner, the others keep full access through a group.
await migrateIam(db, { adminEmail: email });
if (process.env.ADMIN_PASSWORD) {
  // Creates the owner on first run; later it only changes the owner's password (and only if ADMIN_EMAIL is the owner).
  await ensureAdmin(db, email, process.env.ADMIN_PASSWORD);
} else if ((await db.users.count()) === 0) {
  const pw = randomBytes(9).toString("base64url");
  await createSudo(db, email, pw);
  console.warn(`First run: created admin ${email} with password ${pw} (shown once; set ADMIN_PASSWORD to choose your own).`);
}

const app = buildApp(store, { authSecret: process.env.AUTH_SECRET, uploadDir: process.env.UPLOAD_DIR ?? "uploads", shopUrl: process.env.SHOP_URL, importMediaDir: process.env.IMPORT_MEDIA_DIR || null, adminEmail: email, backofficeUrl: process.env.BACKOFFICE_URL, trustProxy: parseTrustProxy(process.env.TRUST_PROXY) });
const shutdown = async () => { await app.close(); await store.close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });

# OpenShop

PrestaShop alternative. Monorepo (npm workspaces), TypeScript, Node 22+.

- `packages/db` – `DataStore` interface + SQLite (default) and MongoDB adapters, one shared contract test.
- `packages/renderer` – pure function: page-builder JSON -> static HTML/CSS (no JS).
- `apps/api` – Fastify API: products, pages (HTML rendered on save), `/s/:slug` storefront delivery.
- `apps/backoffice` – Angular app: product management + page builder with live preview.

## Run
    npm install
    npm start -w @openshop/api            # SQLite file openshop.db; set MONGO_URL to use MongoDB
    cd apps/backoffice && npx ng serve    # proxies /api and /s to :3000
    npm test                              # MONGO_URL=... also runs the Mongo contract

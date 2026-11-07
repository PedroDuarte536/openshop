# OpenShop

PrestaShop alternative. Monorepo (npm workspaces), TypeScript, Node 22+.

- `packages/db` – `DataStore` interface + SQLite (default) and MongoDB adapters, one shared contract test.
- `packages/renderer` – pure function: page-builder JSON -> static HTML/CSS (no JS).
- `apps/api` – Fastify API: products, pages (HTML rendered on save), `/s/:slug` storefront delivery.
- `apps/backoffice` – Angular app: product management + page builder with live preview.

## Features
- Admin API behind login (scrypt password hashes, signed expiring tokens, login throttling).
- Products (stock, category, images), categories, orders, customers; image uploads (PNG/JPEG/WebP/GIF, content-checked, no SVG).
- Public storefront with no JavaScript: `/shop`, product pages, cookie-based cart, checkout, order confirmation. Pages get a strict CSP.
- Page builder pages are saved as JSON and rendered to static HTML on save; `productList` blocks are filled from the catalogue and re-rendered whenever products or categories change. `/` serves the page with slug `home`.
- Orders take prices from the catalogue only; stock is checked and decremented under a lock. No payment gateway: orders start as `pending` and are marked paid by hand.

## Run
    npm install
    ADMIN_EMAIL=you@x.io ADMIN_PASSWORD=... AUTH_SECRET=<long random> npm start -w @openshop/api
    # SQLite file openshop.db by default; set MONGO_URL to use MongoDB. Without ADMIN_PASSWORD a first-run admin
    # is created and its password printed once. Without AUTH_SECRET, sessions end on restart.
    cd apps/backoffice && npx ng serve    # proxies /api and /s to :3000
    npm test                              # MONGO_URL=... also runs the Mongo contract

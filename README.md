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
- Visual page builder: sections > columns > 12 widgets, drag and drop on a live canvas, inline text editing, layers, undo/redo, tablet and mobile views with per-device style overrides, themes (colours, 4 font pairings), 12 ready-made sections and 3 page templates. The canvas shows the exact HTML the renderer publishes.
- Pages are saved as a validated document and rendered to static HTML and CSS on save (no JS, scroll animations are CSS-only). Product grids are filled from the catalogue and re-rendered whenever products or categories change. `/` serves the page with slug `home`; the shop picks up its theme.
- Essential pages (product, category, search) are designed in the builder like any page and filled with real data on every request; the editor shows sample data. The shop (`/shop`, `/shop/category/:slug`, `/search`, `/shop/product/:id`) uses them. Page addresses can be changed from the Pages list or the builder's address bar.
- Every style value is validated in `packages/renderer` (colours, URLs, numbers, ids), so a hostile document can't inject HTML or CSS.
- Orders take prices from the catalogue only; stock is checked and decremented under a lock. No payment gateway: orders start as `pending` and are marked paid by hand.

## Run
    npm install
    ADMIN_EMAIL=you@x.io ADMIN_PASSWORD=... AUTH_SECRET=<long random> npm start -w @openshop/api
    # SQLite file openshop.db by default; set MONGO_URL to use MongoDB. Without ADMIN_PASSWORD a first-run admin
    # is created and its password printed once. Without AUTH_SECRET, sessions end on restart.
    cd apps/backoffice && npx ng serve    # proxies /api and /s to :3000
    npm test                              # MONGO_URL=... also runs the Mongo contract

## Demo data
`python3 scripts/seed-demo.py` fills a running shop with a realistic catalogue (Maison Dune, ceramics): 5 categories, 25 products with generated photos, and 12 orders from 8 customers. It needs Pillow, reads the login from `.env.demo`, and is safe to re-run. `--only "Linen Mug,Bud Vase"` regenerates just those products.

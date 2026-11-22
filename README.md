# OpenShop

PrestaShop alternative. Monorepo (npm workspaces), TypeScript, Node 22+.

- `packages/db` – `DataStore` interface + SQLite (default) and MongoDB adapters, one shared contract test.
- `packages/renderer` – pure function: page-builder JSON -> static HTML/CSS. Published pages load one first-party script (`/assets/shop.js`) for prices and offers; the HTML never contains discount data.
- `packages/pricing` – pure, deterministic discounts engine (offers, vouchers, limits, time zones). Used by the API to charge and by the backoffice for previews.
- `packages/iam` – pure: the 17 backoffice permissions, group templates, password policies and the backoffice feature registry. Used by the API to authorise and by the backoffice for menus and screens.
- `apps/api` – Fastify API: products, pages (HTML rendered on save), `/s/:slug` storefront delivery.
- `apps/backoffice` – Angular app: product management + page builder with live preview.

## Features
- Products (stock, category, images, SKU, properties), categories, orders, customers; image uploads (PNG/JPEG/WebP/GIF, content-checked, no SVG).
- Catalogue (see `docs/catalogue-plan-v3.md`):
  - **Properties** (colour, size, material…): text, one or several choices (with colour swatches), numbers with a unit, yes/no. Each is public (shown on product pages, filterable, searchable, as chosen) or internal (backoffice only, never sent to the shop).
  - **Search**: one index for the backoffice and the shop (accents and case ignored, partial words, one typo corrected on longer words with "Showing results for…"), filters with counts (category, price, availability, properties), sorting and paging. Shop pages work without JavaScript (GET forms); sorting and filtering by price use each visitor's own prices, loaded by the storefront script, so pages never hold personal prices. The backoffice filters by visibility, stock, type, missing information and any property, with bulk show/hide/move. Search boxes suggest products and categories while typing (public data only). Insights lists the shop searches that found nothing (the words only, never who searched).
  - **Import and export**: CSV (comma, semicolon or tab; decimal comma; UTF-8 or Excel's Windows encoding; PrestaShop product exports recognised) and a full JSON backup. Export is the product search with `Accept: text/csv` or `application/vnd.openshop.catalogue+json`, so it exports what the list shows. Import: upload → match columns → preview (new properties are internal unless the owner ticks them there; from a backup, "public in the file" is shown) with a diff and plain-language problems (nothing written) → apply in the background. Products changed or sold since the preview are not overwritten; rows matching deleted products wait for the owner's choice (restore, create new, skip); an import never deletes. Photos can be existing uploads, `https://` addresses (downloaded and stored as copies, with SSRF protections; or kept as links if the owner prefers), or files in a server folder set by the operator (`IMPORT_MEDIA_DIR`), which are checked and copied.
  - **Bundles**: several products sold as one. Price = the sum of the products (kept up to date) or a manual price (the editor shows the % of the sum, with "Reset to sum"). Stock comes from the products; selling a bundle takes them from stock atomically. Shop-wide and category offers don't apply to bundles unless allowed (bundles still count towards order minimums); offers made for a bundle do. Product pages show the contents and the saving, and "As seen in these bundles" on the products inside.
  - **Variants**: separate products linked in a group; the owner ticks the properties that tell them apart (values are read from the products). Product pages show one line per property with one badge per value: a badge opens the product that differs in only that property, otherwise it is disabled. Two products with the same values can never be in a group (checked on every change, safe under concurrent edits).
  - **Products are never deleted**: a visible product can only be hidden; a hidden one can be deleted after a confirmation page where the owner decides, for each bundle that contains it, to keep selling or hide the bundle. Deleted products stay in orders, bundles, offers and groups, and can be restored from "Deleted products".
- Admin API behind login (scrypt password hashes, signed expiring tokens that can be revoked, login throttling per address and per account).
- Backoffice team (see `docs/iam-plan-v2.md`): one owner account plus staff members in permission groups. 17 permissions (e.g. "Mark orders as shipped", "Update stock levels", "See customers"), 8 group templates (Shop manager, Fulfilment, Catalogue editor, Content editor, Promotions, Customer support, Finance, Read-only). Invitations without email: the owner creates a one-time link (72 h, revocable, token in the URL fragment) and sends it by hand; password reset links the same way. Remove (soft delete: history kept, restore by re-inviting) and suspend. Every API route declares its permission (the server won't start otherwise) and is checked on every request, so changes apply at the next click; the menu shows only what a member can use, and other addresses show a "No access" page. An owner-only Activity page lists sign-ins, pages visited, changes and refused requests (401/403), with filters, CSV and retention. Password policies for staff and for customers are editable (Settings → Security, owner only).
- Public storefront: `/shop`, product pages, cookie-based cart, checkout, order confirmation. Everything works without JavaScript; one first-party script (`/assets/shop.js`) adds the visitor's discounts, loaded from the shop API. Pages get a strict CSP (scripts only from the shop itself, Trusted Types).
- Visual page builder: sections > columns > 12 widgets, drag and drop on a live canvas, inline text editing, layers, undo/redo, tablet and mobile views with per-device style overrides, themes (colours, 4 font pairings), 12 ready-made sections and 3 page templates. The canvas shows the exact HTML the renderer publishes.
- Pages are saved as a validated document and rendered to static HTML and CSS on save (scroll animations are CSS-only; prices and offers are filled in by the shop script, never stored in the HTML). Product grids are filled from the catalogue and re-rendered whenever products or categories change. `/` serves the page with slug `home`; the shop picks up its theme.
- Essential pages (product, category, search) are designed in the builder like any page and filled with real data on every request; the editor shows sample data. The shop (`/shop`, `/shop/category/:slug`, `/search`, `/shop/product/:id`) uses them. Page addresses can be changed from the Pages list or the builder's address bar.
- Every style value is validated in `packages/renderer` (colours, URLs, numbers, ids), so a hostile document can't inject HTML or CSS.
- Orders take prices from the catalogue and the discounts engine only; stock and discount limits are checked and claimed atomically. No payment gateway: orders start as `pending` and are marked paid by hand.
- Discounts (see `docs/discounts-plan.md`): shop-wide, category and product offers, and vouchers (one shared code or many single-use codes). Percent off, amount off or a fixed price, per item or once per order. Optional start and end in the shop's time zone (start defaults to now, may be in the past; no end = never). Minimum order value or quantity, total uses, maximum discount per order, and per-customer limits (number of purchases, € budget across purchases, first N orders). Each item gets its best price; a code can be combinable or compete with the automatic offers (shoppers see both totals and choose); limited offers can be saved for later. Shoppers see where every discount comes from and what other offers would cost. Backoffice: offer list and editor with live preview, codes (CSV via `Accept: text/csv`), redemptions, simulator, settings (time zone, display), history. Cancelling an order gives back what it claimed.
- Customer accounts without an email server: the owner creates a one-time link (activation or password reset) and shares it; the customer sets a password. Client prices (offers for chosen customers), discount profiles (groups such as trade buyers, with their own offers; editing a profile applies to every member), personal codes, "Your offers" page. Customer prices never apply to a typed email, only to a signed-in account.
- Insights: revenue and discount cost per day, by offer and by campaign, compared with the previous period; what shoppers chose when a code competed with the automatic offers (how many paid more to use an influencer's code); limited offers saved for later. All reports download as CSV.

## Run
    npm install
    ADMIN_EMAIL=you@x.io ADMIN_PASSWORD=... AUTH_SECRET=<long random> npm start -w @openshop/api
    # SQLite file openshop.db by default; set MONGO_URL to use MongoDB. SHOP_URL=https://your.shop makes the
    # backoffice show full customer account links. Without ADMIN_PASSWORD a first-run admin
    # is created and its password printed once. Without AUTH_SECRET, sessions end on restart.
    # IMPORT_MEDIA_DIR=/srv/import-images lets product imports name image files in that folder (they are copied
    # into the uploads). Only this folder can be read; it can't be set from the backoffice. Unset: no server paths.
    # backoffice show full customer account links, BACKOFFICE_URL=https://admin.your.shop full staff invitation links.
    # Behind a reverse proxy set TRUST_PROXY to the proxy's address (e.g. 10.0.0.5), or every visitor shares one
    # address for sign-in limits and the activity log (see docs/backoffice-hosting.md).
    # ADMIN_EMAIL is the owner account (sudo): created on first run (without ADMIN_PASSWORD a password is printed
    # once). On later starts ADMIN_PASSWORD only sets the owner's password when it differs (which signs the owner out
    # everywhere) and never creates a second owner; remove it from the environment once you have signed in.
    # Without AUTH_SECRET, sessions end on restart. Upgrading: the first start makes one existing user the owner and
    # puts any others in a "Shop manager (migrated)" group, so nobody loses access; everyone signs in once again.
    cd apps/backoffice && npx ng serve    # proxies /api, /s/, /shop, /assets ... to :3000 (Angular CLI needs Node >= 22.22.3 or 24.15)
    # production: docs/backoffice-hosting.md (backoffice security headers, reverse proxy and TRUST_PROXY,
    # several API processes, database indexes)
    npm test                              # every package + the backoffice unit tests (Angular CLI: Node >= 22.22.3 or 24)
                                          # MONGO_URL=... also runs the DataStore contract against a real MongoDB
    npm run coverage                      # the same, with line/branch/function coverage per file
    npm run typecheck                     # TypeScript check of packages, API, scripts and the storefront script

Browser tests (Python Playwright + Chromium; they place orders and create offers, so use a throw-away instance):

    DB_PATH=/tmp/e2e.db PORT=3100 ... npm start -w @openshop/api && API=http://localhost:3100 python3 scripts/seed-demo.py
    API=http://localhost:3100 python3 scripts/e2e-storefront.py       # also prints the storefront script's line coverage
    BO=http://localhost:4300 python3 scripts/e2e-backoffice.py    # ng serve --port 4300 with a proxy to :3100
    API=http://localhost:3100 BO=http://localhost:4300 python3 scripts/e2e-catalogue.py   # search, filters, variants, bundles, import

## Configuration
Every tunable number of the API is in `apps/api/src/config.ts`. The ones below can be changed when the server starts
(whole numbers; a wrong value stops the server with a clear message). Everything else is a product rule or a security
limit and changes in code.

| Variable | Default | What it sets |
|---|---|---|
| `HTTP_BODY_LIMIT_KB` | 1024 | Largest JSON request (uploads and imports have their own limits) |
| `UPLOAD_MAX_MB` | 5 | Largest image upload, and largest image an import may copy |
| `IMPORT_MAX_MB` / `IMPORT_MAX_ROWS` | 10 / 20000 | Largest import file, most products per file |
| `IMPORT_RETENTION_DAYS` | 30 | How long import jobs and their rows are kept |
| `ADMIN_SESSION_HOURS` | 8 | Backoffice sign-in duration |
| `CUSTOMER_SESSION_DAYS` / `ACCOUNT_LINK_HOURS` | 30 / 72 | Customer sign-in duration, validity of activation and reset links |
| `SEARCH_RATE_BURST` / `SEARCH_RATE_PER_SECOND` | 60 / 2 | Shop searches per visitor (IP) |
| `SEARCH_BACKGROUND_REBUILD_FROM` | 5000 | From this many products, shop searches use the previous index while a new one builds |

Backoffice timings (search debounce, confirmation buttons, page size) are in `apps/backoffice/src/app/config.ts`.

## Demo data
`scripts/demo-servers.sh seed` does everything below and starts a ready-to-test setup: the demo shop on :3000 with its
backoffice on :4200, and an empty shop on :3001 / :4201 for restoring a backup (`start`, `stop` and `status` too; set
`NODE_FOR_NG=/path/to/node/bin` if your default Node is too old for the Angular CLI). `docs/test-guide.md` walks
through every catalogue flow on that setup, with sample import files in `docs/test-guide/`.

`python3 scripts/seed-demo.py` fills a running shop with a realistic catalogue (Maison Dune, ceramics): 5 categories, 25 products with generated photos, 12 orders from 8 customers, demo offers (shop time zone Europe/Lisbon), an influencer code (MARTA10), customer accounts (password `dune-demo-2026`: Jonas Weber and Erik Lindqvist in the "Trade buyers" profile, Priya Nair with a VIP price on bowls, Sofia Rossi with a personal code). Then, with the API stopped, `DB_PATH=./demo-data/db.sqlite node scripts/seed-history.ts` adds 60 days of orders through the real checkout so Insights has history. It needs Pillow, reads the login from `.env.demo` (copy `.env.demo.example`), and is safe to re-run. `--only "Linen Mug,Bud Vase"` regenerates just those products. `python3 scripts/seed-catalogue.py` then adds the catalogue demo: SKUs, properties (with an internal Supplier), two variant groups (the 7-product example of the plan, §2.8.7, and a mug by colour), three bundles, and sample images in `IMPORT_MEDIA_DIR` for the import files.
    BO=http://localhost:4300 API=http://localhost:3100 python3 scripts/e2e-access.py   # team, permissions, activity (run last)

Each browser suite changes the shop, so give each one a freshly seeded instance. The access matrix (which persona may
do what) is `apps/api/test/access-matrix.json`; `npm test` checks every row × persona against the API and writes
`apps/api/test/out/access-report.md`.

## Demo data
`python3 scripts/seed-demo.py` fills a running shop with a realistic catalogue (Maison Dune, ceramics): 5 categories, 25 products with generated photos, 12 orders from 8 customers, demo offers (shop time zone Europe/Lisbon), an influencer code (MARTA10), customer accounts (password `dune-demo-2026`: Jonas Weber and Erik Lindqvist in the "Trade buyers" profile, Priya Nair with a VIP price on bowls, Sofia Rossi with a personal code), and the backoffice team: the 8 group templates and one staff member per group
(`<name>@maison-dune.test`, password `dune-staff-2026`: Sam Manager, Pat Packer, Cleo Catalogue, Dana Designer, Max
Marketing, Suki Support, Finn Finance, Vera Viewer, Nico NoGroups, Mia Multi; Ivy Invited has a pending invitation,
written to `demo-data/invite-links.txt`; Sid Suspended and Rex Removed can't sign in). See `docs/iam-testing.md`. The security review of the
team features (threat model, attack tests, findings) is `docs/iam-security-review.md`. Then, with the API stopped, `DB_PATH=./demo-data/db.sqlite node scripts/seed-history.ts` adds 60 days of orders through the real checkout so Insights has history. It needs Pillow, reads the login from `.env.demo` (copy `.env.demo.example`), and is safe to re-run. `--only "Linen Mug,Bud Vase"` regenerates just those products.

## License
MIT (see [LICENSE](LICENSE)).

# OpenShop catalogue: import/export, bundles and search. Implementation plan (v1)

Status: **proposal, not implemented.** Covers three features that change products for both the backoffice and the shop:

- **A. Import and export** of the product list in several formats.
- **B. Product bundles.**
- **C. Better product search** (text search and property filters) in the backoffice and the shop.

They share one foundation: products need a stable business key (SKU), typed properties (attributes) and safe bulk
writes. That's why this is one plan with one phase order. The owner decisions that are still open are listed in §1.8.
Each one has a recommendation.

---

## 0. How the current code shapes this plan

Findings from reading the code. The ones marked ✅ were confirmed by running a probe against the current code (a
throw-away `app.inject` / DataStore test, not committed). Baseline: `npm test` passes (db 19, pricing 33, renderer 23,
api 53).

| # | Finding | Where | Consequence for this plan |
|---|---|---|---|
| F1 | ✅ **`GET /api/shop/products` (public, no auth) returns the raw product document.** A `costPrice`, `supplier` or `internalNote` field added to a product is returned to anyone. | `app.ts` `/api/shop/products` | **Blocker.** Before any new product field ships, public responses must use an explicit allowlist projection (§2.3, C1). |
| F2 | ✅ **The SQLite `update()` is read-modify-write across an `await`.** A rename that runs at the same time as a checkout's atomic stock decrement writes back the old stock: the probe ends with stock 10 instead of 9, so the decrement is lost and items can oversell. Mongo uses `$set`, so it is not affected. | `packages/db/src/sqlite.ts` `update()` | This bug exists today. Bulk imports during live sales would hit it often. It must be fixed in P0 with a contract test. |
| F3 | Products have no SKU, no attributes, no `version`, no timestamps, and no audit trail (offers, customers and settings are audited; products are not). | `types.ts`, `app.ts` | New fields: `sku`, `attributes`, `type`, `version`, `createdAt/updatedAt`. Product writes get audited. |
| F4 | ✅ Product prices are floats with no upper bound and no cent precision: `10.129` and `1e300` are accepted. The engine later rounds with `toCents`. | `productProps` in `app.ts` | Import (and the API) must enforce at most 2 decimals and an upper bound, the same as the pricing package `LIMITS.maxCents`. |
| F5 | ✅ Deleting a product that an offer references succeeds. After that, the offer can't be edited (`400 unknown ids`). There are no reference checks on delete. | `DELETE /api/products/:id`, `checkRefs` | Bundles add a new kind of reference. Delete needs reference checks plus "hide instead" (§2.3). |
| F6 | `DataStore.Filter` only supports equality, ranges and `$in`. It has no text search, no OR, no "array contains" and no aggregation (facet counts). | `packages/db/src/types.ts` | Text search and facets can't be pushed into both adapters cheaply. Use an in-process search index (§2.5). |
| F7 | Every screen loads the **whole** catalogue: `GET /api/products` has no paging. The backoffice product search is client-side and matches the name only. The discount editor, simulator, builder and categories screens also load everything. `/shop` loads every active product on each request. | `products.ts`, `api.service.ts`, `storefront.ts` | Fine for 25 products, but not for an imported catalogue of 10k. The admin list and pickers move to a paged server search. |
| F8 | Shop search is a substring scan of name and description over all active products. It has no filters, no ranking, no paging, and "ceramique" doesn't match "céramique". | `storefront.ts` `/search` | Replaced by the index. The URL `/search?q=` stays. |
| F9 | `rerenderDynamicPages()` runs after **every** product write and re-renders every stored page with a product grid. | `pages.ts`, `app.ts` | An import of 5,000 rows must re-render once at the end, not 5,000 times. |
| F10 | The body limit is 1 MB for the whole app. Only JSON, urlencoded and image parsers are registered; ✅ `text/csv` gets 415. | `app.ts`, `uploads.ts`, `storefront.ts` | Import gets its own parsers and limit, scoped to the import route. |
| F11 | There is already a CSV convention: one URL per resource, format chosen by `Accept`, `sendList` / `csvCell` with formula neutralisation and a BOM, and 406 for other types. The backoffice downloads through `downloadCsv()` with the bearer header. | `negotiate.ts`, `api.service.ts` | Export is a representation of the product **search** URL (§2.7). `csvCell` prefixes `'`, so import must reverse it, or values would gain a `'` on every round trip. |
| F12 | Pricing is line-based (`LineInput {productId, categoryId, listCents, qty}`). One `matches()` function decides which offers apply to a line, in both the line and order phases. `allocate()` (largest remainder) already exists. | `packages/pricing/src/engine.ts`, `money.ts` | A bundle can be **one line with its own product id**. Offers see it as a product. Revenue per component uses `allocate()`. |
| F13 | `placeOrder` checks stock per product, then decrements each line with `updateWhere(stock >= qty)` and an undo list, inside the in-process `locked()`. Cancelling does not restock. | `orders.ts` | Bundles decrement **component** stock the same way. Cancel keeps today's behaviour (no restock), documented. |
| F14 | Product, category and search pages are builder pages rendered per request with a `RenderContext`. `renderer/model.ts` is the trust boundary that validates every widget prop. Discount data must never appear in HTML. | `renderer`, `pages.ts` | Filters, sorting, paging, product properties and bundle contents become new widgets validated in `normProps`. Filtering and sorting by price use the **list** price only (§2.5.6). |
| F15 | Product images accept any `https://` URL. The CSP allows `img-src https:`. | `productProps.images`, `PAGE_CSP` | Imported image URLs would hotlink third-party hosts (privacy). Fetching them server-side is an SSRF risk (C7, C8). |
| F16 | There is one admin role, with the bearer token in `localStorage`. | `auth.ts`, backoffice `api.service.ts` | Import is a powerful bulk write: any XSS in the backoffice means catalogue takeover, so imported strings must stay inert (C5). Roles are out of scope, but the routes are designed for a permission hook. |

---

# 1. Business user stories

## 1.1 Goals and personas

- **Owner** (admin user). Runs the shop alone or with one helper. Often migrating from PrestaShop or a spreadsheet.
  Wants to onboard a catalogue in minutes, sell kits and gift sets, and find products quickly.
- **Shopper.** Browses on mobile, often without knowing the exact product name. Wants to narrow results ("stoneware,
  blue, under €30, in stock").

Goals: faster onboarding and catalogue upkeep (import/export), higher average order value (bundles), and better
conversion from search and category pages (search and filters).

## 1.2 Foundation stories (needed by all three epics)

| ID | Story | Acceptance criteria |
|---|---|---|
| F-1 | As an owner I give products a **SKU**, so I can match them with my supplier sheets and spreadsheets. | Optional and unique (case-insensitive), 1–64 characters from `A–Z a–z 0–9 . _ -`. A duplicate gets a clear error naming the other product. Shown in the list, editor and exports. |
| F-2 | As an owner I define **properties** (colour, material, capacity in ml, dishwasher safe) once and fill them in per product. | Types: text, single choice, multiple choice, number (with unit), yes/no. Each property is marked *shown on product page*, *filterable in shop*, *searchable in shop*, or *internal* (backoffice only). Choice values can be renamed, and the rename applies everywhere. |
| F-3 | As an owner I can't accidentally break offers or bundles by deleting a product. | Deleting a product that an offer or bundle uses is refused, with the list of users and a one-click "Hide it instead". |
| F-4 | As an owner I can see who changed a product and when. | Product create, update, delete and import are in the audit log, with before/after values. |

## 1.3 Epic A: Import and export

| ID | Story | Acceptance criteria |
|---|---|---|
| A-1 | As an owner I **export** my product list to a spreadsheet (CSV) to edit prices in bulk or share it with my accountant. | "Export" on the Products screen exports **what the current search and filters show**, or everything. CSV opens correctly in Excel, LibreOffice and Numbers: UTF-8 with BOM, `,` or `;` separator (setting, default `;` for EU locales, chosen by the owner). Columns are documented (§2.7.2). Formula-like cells are neutralised. |
| A-2 | As an owner I export a **full backup** (JSON) and import it into another OpenShop (staging → live, or a second shop). | Includes categories, properties, bundles and their components by SKU. Importing it into an empty shop gives the same catalogue (round-trip test). Order history is not included. |
| A-3 | As an owner I **import** a CSV or JSON file to create and update products in bulk. | Wizard: upload → column mapping (auto-detected, editable, remembered) → **preview** (new / changed / unchanged / errors, with a field-by-field diff) → confirm → progress → summary. **Nothing is written before confirming.** |
| A-4 | As an owner I choose what an import may do. | Modes: *create and update* (default), *update only*, *create only*. Products missing from the file: *leave as is* (default) or *hide them*. **Import never deletes.** Empty cells: *clear the value* or *leave unchanged* (default). Stock: *set from file* or *don't touch stock*. |
| A-5 | As an owner I get an understandable **error report**. | Each problem has a row number, column and plain-language message ("Price must be a number with up to 2 decimals, got '12,5O'"). Downloadable as CSV. Rows with errors are skipped, and the rest can still be imported (or "stop if any error", a setting). |
| A-6 | As an owner migrating **from PrestaShop**, I import its product CSV without rearranging columns. | A built-in "PrestaShop 1.7/8 products CSV" mapping preset (`;` separator, `Reference #` → SKU, `Price tax excluded` → price, `Quantity` → stock, `Categories (x,y,z...)` → category, `Image URLs (x,y,z...)` → images). HTML in descriptions becomes plain text, with a warning in the preview. |
| A-7 | As an owner I'm warned about risky changes before confirming. | The preview flags: price changed by more than 50%, price set to 0, more than 20 products becoming visible, a stock change on products sold since the preview, and new categories that would be created. |
| A-8 | As an owner I can **undo** my last import (P5). | "Revert import" within 7 days restores the previous values of products not changed since. New products are hidden (or deleted if never ordered). The summary lists what couldn't be reverted. |
| A-9 | As an owner I import products **with photos** given as URLs (P5, owner decision I-2). | Photos are downloaded, checked as real PNG/JPEG/WebP/GIF files and stored like uploads. Failures are listed per row and don't block the product. |
| A-10 | (P5, optional) As an owner I export an **XLSX** file and a **Google Merchant / Meta product feed**. | XLSX has one sheet with the same columns as the CSV. The feed uses the standard TSV columns (id, title, description, link, image_link, price, availability). |

## 1.4 Epic B: Product bundles

| ID | Story | Acceptance criteria |
|---|---|---|
| B-1 | As an owner I create a **bundle** ("Breakfast set" = 2 × Linen Mug + 1 × Dune Plate) from existing products. | In the product editor: type *Bundle*, add components with a product search and a quantity (1–99). 2–20 different components. A bundle can't contain a bundle. |
| B-2 | As an owner I set the bundle's **price**. | Either a *fixed price* (€59) or *% off the components' total* (−15%, recalculated when a component's price changes). The editor shows "components total €70, shopper saves €11 (15.7%)" and warns when the bundle costs more than the components, or is more than 50% off. |
| B-3 | As an owner I don't manage bundle stock separately. | A bundle's availability is computed from its components: `min(floor(component stock / qty))`. Selling a bundle reduces each component's stock. Shown in the list as "12 available (limited by Dune Plate)". (Decision B-1 in §1.8.) |
| B-4 | As an owner I can sell components **only inside bundles**. | A component may be *hidden* (not sold on its own). The bundle stays sellable. Deleting a component is refused (F-3). |
| B-5 | As an owner I control whether automatic offers **stack** on bundles. | Per bundle: "Shop-wide and category offers also apply" (default **off**, decision B-2). Offers that name the bundle itself always apply. Offers on a component don't apply to the bundle. |
| B-6 | As a shopper I see what's in a bundle and what I save. | The product page shows the contents (image, name, quantity, linked when the component is visible) and "Save €11 compared with buying separately" (list prices only). Out of stock when any component is short. |
| B-7 | As a shopper I see the bundle's contents in my cart and order confirmation. | The cart line and order confirmation show "Includes: 2 × Linen Mug, 1 × Dune Plate". |
| B-8 | As an owner I see the contents of a bundle order so I can pack it. | Orders list and detail show bundle lines with their components, as they were when ordered (snapshot). |
| B-9 | As an owner I can search, filter, export and import bundles like other products. | Type filter (simple / bundle). CSV columns `bundle_components` (`SKU*qty|SKU*qty`) and `bundle_pricing` (`fixed` or `percent:15`). Components are matched by SKU or id. |

## 1.5 Epic C: Search (backoffice and shop)

**Backoffice**

| ID | Story | Acceptance criteria |
|---|---|---|
| C-1 | As an owner I find a product by **any of** name, SKU, description, category or property value. | Results as I type (250 ms debounce). An exact SKU match comes first. Accents and case are ignored. Partial last word ("sto" → stoneware). One typo is tolerated on longer words ("stonewre"). |
| C-2 | As an owner I **filter** the list by category, visibility, stock (in stock / low ≤ 3 / out), type (simple / bundle), price range and any property, and **sort** it. | Filters combine (AND), and values within one filter combine with OR. Counts are shown next to each value. Sort by relevance, name, price, stock or last updated. Paged, 50 per page. Filters are kept in the URL, so the view can be bookmarked. |
| C-3 | As an owner I find **incomplete products** (no photo, no SKU, no category, no description). | "Missing…" filters. Useful after an import. |
| C-4 | As an owner I apply **bulk actions** to the selected or filtered products: show/hide, set category, export. | A confirmation shows the count. Applied in the background for large sets. Audited. |
| C-5 | As an owner the **pickers** (offers, simulator, builder, bundles) stay fast with 10k products. | Typeahead on the same search API, limited to 20 results. |

**Shop**

| ID | Story | Acceptance criteria |
|---|---|---|
| C-6 | As a shopper I get **relevant results** for what I type. | Matches name, description, category and the properties the owner marked searchable. Ranked with name matches first. Accents and case are ignored, with partial and slightly misspelt words. "No results" suggests removing filters and shows the categories. |
| C-7 | As a shopper I **filter** search and category results by price range, availability, category (on search) and the properties the owner marked filterable. | Works **without JavaScript** (a GET form with "Apply"). With JS, results update on change. Active filters show as removable chips. Counts next to values. Values with 0 results are hidden or disabled. |
| C-8 | As a shopper I **sort** (relevance, price low–high, price high–low, name, newest) and **page** through results. | URLs are shareable and bookmarkable. The back button works. |
| C-9 | As a shopper I see a product's **properties** on its page. | "Details" table with only the properties marked *shown on product page*. |
| C-10 | (P5) As a shopper I get **suggestions** while typing. | Up to 6 products and 3 categories, after 2 characters, with keyboard navigation. Needs JavaScript. Without it, the normal search still works. |
| C-11 | As an owner I **design** where filters, sorting and paging appear. | New builder widgets: *Filters*, *Results bar* (count + sort), paging on the *Products (results)* grid, *Product details*, *Bundle contents*. Sample data in the editor. New shops get them in the category and search templates. Existing shops see a one-click "Add filters" in the builder (their designs aren't changed without asking). |

## 1.6 Out of scope (v1)

- Product **variants** (size/colour combinations with their own stock and price). Properties are descriptive only.
  They are groundwork for variants later.
- Mix-and-match bundles ("any 3 mugs for €60"), buy-X-get-Y and bundle suggestions ("frequently bought together").
  These are pricing-engine features.
- Bundles with their own pre-assembled stock (decision B-1), and nested bundles.
- Rich-text (HTML) descriptions: descriptions stay plain text.
- Restocking on cancel (today's behaviour is unchanged, F13).
- Roles and permissions (one admin role remains; F16).
- Multi-language search, synonyms managed by the owner, and search analytics dashboards. "Searches with no results"
  is a small P5 report.
- Scheduled or automatic imports from a URL or FTP, and supplier feeds.

## 1.7 Metrics

- Time to onboard a 500-product catalogue from a spreadsheet: under 15 minutes.
- Import success rate (rows imported / rows in file). Errors per import. Reverted imports.
- Share of orders containing a bundle. Average order value with and without a bundle.
- Search: share of sessions with a search, searches with zero results, click-through from results, use of filters,
  and conversion after search compared with browsing.
- Backoffice: median time to find a product (search latency p95 under 100 ms at 20k products).

## 1.8 Business risks and safeguards

| Risk | Safeguard |
|---|---|
| An import overwrites good data (wrong file, shifted columns, `12,50` read as 1250) | Mandatory preview with diff; risk warnings (A-7); mapping review; strict number format; "update only" mode; never delete; revert (A-8); audit |
| An import publishes unfinished products | "Visible" column optional; new products created **hidden** unless the file says otherwise (setting); warning when more than 20 become visible |
| Overselling during an import | Atomic single-statement updates (F2 fix). Stock in the file is only applied if it hasn't changed since the preview; otherwise the row is reported as a conflict |
| Bundle margin loss (bundle discount plus a shop-wide sale) | Offers don't stack on bundles by default (B-5); margin warnings in the editor; simulator supports bundles |
| A component sells out and the bundle silently disappears | Availability shows which component limits the bundle; low-stock filter includes "bundles limited by a component" |
| Shoppers confused by bundle savings | Savings based on **list prices** only, stated as such |
| Filters that don't help (too many values, empty facets) | Owner chooses which properties are filterable; empty values hidden; maximum 8 values shown per filter before "Show more" |
| Crawlers indexing endless filter combinations | `noindex, follow` on filtered/sorted/paged result pages; canonical link to the unfiltered page |

### Owner decisions needed (recommendation in bold)

| # | Question | Options | Recommendation |
|---|---|---|---|
| B-1 | Bundle stock | **Virtual kit: derived from components** / own stock (pre-assembled) | Virtual: no double bookkeeping, matches "kits and gift sets" |
| B-2 | Do shop-wide/category automatic offers apply to bundles? | Always / **never unless enabled per bundle** | Off by default: a bundle is already a deal; avoids stacking |
| B-3 | Bundle price | Fixed only / % off only / **both** | Both; fixed is the default |
| B-4 | Can components be hidden (sold only in bundles)? | **Yes** / no | Yes (common for gift-box contents) |
| I-1 | Formats | **CSV + JSON in P2; XLSX + feeds in P5** / XLSX from the start | XLSX needs a zip/XML parser, a new dependency surface (C18). CSV covers Excel |
| I-2 | Image URLs in imports | Keep as external links / **download and host (P5)** / reject | Download and host, with SSRF controls (C7). Until P5, accept `https://` links as today but warn (privacy, C8) |
| I-3 | New products from an import are | Visible / **hidden unless the file has a `visible` column** | Hidden: safer default |
| I-4 | Delete via import | **Never** / allowed | Never. "Hide missing products" covers the use case |
| S-1 | Search engine | **In-process index** / SQLite FTS5 + Mongo text index / external (Meilisearch) | In-process: works with both adapters, gives facets, no new service. Revisit above about 50k products (§2.12) |
| S-2 | Price filter/sort uses | **List price** / shopper's discounted price | List price: discounts are per shopper and must not reach HTML (F14) |
| S-3 | Typo tolerance | **On (1 edit, words of 5+ letters)** / off | On |
| S-4 | Delete policy for products | **Refuse when referenced; suggest hide** / cascade-remove references | Refuse |

## 1.9 Roadmap (rough, one developer)

Order: value first (import unblocks migration), and each phase builds on the previous one.

| Phase | Delivers | Effort |
|---|---|---|
| **P0 Foundations** | SQLite atomic `update` (F2) + contract test; public product projection (F1); product `version`, timestamps, audit; price rules (2 decimals, bounds); delete reference checks; `catalogueVersion` counter; batched re-render helper | 4–5 days |
| **P1 Catalogue model + backoffice search + export** | SKU (unique), properties (definitions + values), search index (admin view), `GET /api/products` search with filters, facets and paging; CSV and full JSON export via `Accept`; new Products screen (filters, paging, bulk show/hide/category), Properties screen; pickers become typeahead | 8–10 days |
| **P2 Import** | Import jobs: CSV (`,` `;` tab) and JSON; mapping; preview/diff; risk warnings; commit in batches; error report CSV; single-import lock; audit; PrestaShop preset | 8–10 days |
| **P3 Shop search and filters** | Public index view; `/search`, `/shop`, `/shop/category/:slug` with filters, sort and paging; builder widgets (Filters, Results bar, paging, Product details); templates + "Add filters"; `shop.js` auto-apply; SEO tags; rate limits | 6–8 days |
| **P4 Bundles** | Bundle model and validation; price modes; derived availability; engine `offerScope`; checkout component stock; order snapshot; storefront contents/savings; cart/confirmation; backoffice editor; bundle import/export columns | 8–10 days |
| **P5 Extras** | Image download (SSRF-safe), import revert, XLSX export (and import if I-1 allows), Google/Meta feed, search suggestions, "no results" report | 7–9 days |

---

# 2. Technical details

## 2.1 Architecture

```
packages/db         update() made a single statement in SQLite (json_set chain), contract test for lost updates
packages/pricing    LineInput.offerScope ("all" | "targeted"); matches() honours it; invariant tests
packages/renderer   new widgets: searchFilters, resultsBar, productSpecs, bundleContents; productGrid paging;
                    RenderContext: facets, filters, sort, page, total, product.specs, product.bundle; sample data
apps/api/src/catalogue/   NEW folder (products grow out of app.ts)
  products.ts       admin routes: CRUD (versioned, audited), search/list/export, bulk actions, reference checks
  model.ts          normalizeProduct() (second validation layer, like normalizeDiscount), public projection
  attributes.ts     property definitions CRUD, value validation
  skus.ts           SKU normalisation and uniqueness (product_skus collection, id = normalised SKU)
  bundles.ts        component validation, derived availability, price materialisation, order expansion
  search-index.ts   pure in-memory index: tokenizer, inverted index, facets, ranking (no I/O, unit-tested)
  search.ts         index lifecycle (build, freshness via catalogueVersion), admin and public query functions
  import/           csv.ts (RFC 4180 parser, streaming), json.ts, mapping.ts (presets), validate.ts,
                    jobs.ts (state machine, lock, batches), routes.ts
  export.ts         CSV (streamed), JSON catalogue document, (P5) XLSX, feed
apps/api/src/storefront.ts  search/category pages use search.ts; bundle product page; cart/confirmation contents
apps/api/src/orders.ts      stock demand expansion for bundles; line snapshot with components
apps/api/assets/shop.js     filters auto-apply; (P5) suggestions. Same rules: textContent/createElement only
apps/backoffice             Products (server search), Import wizard, Properties, bundle editor, typeahead picker
```

## 2.2 Data model

```ts
// Product (extends today's document; every new field optional, so existing documents stay valid)
interface Product extends Doc {
  name: string; price: number;            // price: decimal euros, ≤ 2 decimals, 0..1_000_000 (validated as cents)
  active: boolean; stock: number; categoryId?: string | null; description?: string; images?: string[];
  sku?: string | null;                    // as entered; uniqueness via product_skus (normalised upper-case)
  type?: "simple" | "bundle";             // absent = simple
  attributes?: Record<string, AttrValue>; // key = AttributeDef.key
  bundle?: BundleSpec;                    // only when type = "bundle"
  version?: number; createdAt?: string; updatedAt?: string; updatedBy?: string;
}
type AttrValue = string | string[] | number | boolean;

interface AttributeDef extends Doc {      // collection "attributes"
  key: string;                            // ^[a-z][a-z0-9_]{0,31}$, immutable, never "__proto__"/"constructor"/"prototype"
  label: string;                          // ≤ 80
  type: "text" | "choice" | "multi" | "number" | "boolean";
  unit?: string;                          // ≤ 12, number only
  options?: { value: string; label: string }[]; // choice/multi, ≤ 200, value ^[a-z0-9-]{1,40}$
  visibility: "public" | "internal";      // internal: never leaves the admin API
  filterable: boolean; searchable: boolean; showOnProduct: boolean; position: number;
  version: number; createdAt: string; updatedAt: string;
}

interface BundleSpec {
  components: { productId: string; qty: number }[];     // 2..20 distinct, qty 1..99, simple products only
  pricing: { mode: "fixed" } | { mode: "percentOffSum"; bp: number };  // bp 1..9000
  offerScope: "targeted" | "all";         // B-2: "targeted" = only offers naming this bundle
}

interface ProductSku extends Doc { productId: string }   // collection "product_skus", id = normalised SKU
interface CatalogueMeta extends Doc { version: number }  // collection "meta", id "catalogue"

interface ImportJob extends Doc {          // collection "import_jobs"
  status: "uploaded" | "previewed" | "committing" | "done" | "failed" | "cancelled" | "interrupted" | "expired";
  format: "csv" | "json"; filename: string; sha256: string; bytes: number; rowCount: number;
  csv?: { delimiter: "," | ";" | "\t"; decimal: "." | ","; encoding: "utf-8" | "windows-1252" };
  mapping: Record<string, string>;         // file column -> field ("sku", "price", "attr:colour", "ignore" …)
  options: { mode: "upsert" | "update" | "create"; missing: "leave" | "hide"; empty: "leave" | "clear";
             stock: "set" | "skip"; newVisible: boolean; createCategories: boolean; stopOnError: boolean };
  preview?: { create: number; update: number; unchanged: number; errors: number; warnings: Warning[]; at: string };
  progress?: { done: number; total: number }; result?: { created: number; updated: number; hidden: number; conflicts: number; failed: number };
  createdBy: string; createdAt: string; committedAt?: string; expiresAt: string;
}
interface ImportRow extends Doc {          // collection "import_rows", id = `${jobId}:${rowNo}` (chunks of 1 row; see §2.7.4)
  jobId: string; rowNo: number; raw: Record<string, string>;
  plan?: { action: "create" | "update" | "unchanged" | "error"; productId?: string; baseVersion?: number;
           baseStock?: number; set?: Partial<Product>; errors?: FieldError[]; warnings?: string[] };
  state: "pending" | "applied" | "conflict" | "failed" | "skipped";
}
interface ImportChange extends Doc {       // collection "import_changes" (for audit detail and revert), id = `${jobId}:${productId}`
  jobId: string; productId: string; before: Partial<Product> | null; after: Partial<Product>; afterVersion: number;
}

// Order line snapshot (orders keep what was sold, as today)
interface OrderLine { /* existing fields */ sku?: string;
  bundle?: { components: { productId: string; sku?: string; name: string; qty: number; allocatedCents: number }[] } }
```

Why these shapes:
- **SKU uniqueness** uses the same technique as voucher codes: the normalised SKU is the document id in
  `product_skus`, so the primary key guarantees uniqueness in both adapters (no unique indexes in `DataStore`, F6).
  Changing a SKU means: insert the new key (`DuplicateKeyError` → 409), update the product, delete the old key. If
  something fails part-way, the steps already done are undone.
- **Attribute keys** become DataStore paths (`attributes.colour`) and object keys, so they are restricted to
  `^[a-z][a-z0-9_]{0,31}$` plus a denylist. This blocks prototype pollution, and also blocks injection through the
  SQLite `jsonPath` regex, which would accept `__proto__` (C4).
- **Sum-priced bundles materialise `price`.** When a component's price changes (PATCH or import), dependent bundles
  are recomputed in the same request. Every existing reader (`toCard`, product page, cart, `priceItems`,
  `/api/shop/prices`, `placeOrder`) keeps reading `p.price`, so no price path can be missed. There are at most 2,000
  bundles, so the reverse lookup scans `find({ type: "bundle" })`.

## 2.3 P0 Foundations

1. **Atomic SQLite `update` (F2).** Replace the get-merge-write with one statement: a chain of `json_set(data,
   '$.<field>', json(?))`, one per top-level patch field, then `UPDATE … WHERE id = ? RETURNING id, data`. This is
   the same technique `updateWhere` already uses. **Not** `json_patch`: it merges nested objects recursively, so a
   patched `attributes` map would keep old keys (checked), while Mongo's `$set` replaces it, and the adapters would
   diverge.
   - Contract test: `update(name)` and `updateWhere(inc stock −1)` run concurrently, 50 times, and no decrement is
     lost. It runs on both adapters.
2. **Public projection (F1).** `publicProduct(p)` is an allowlist of `id, name, price, images, description,
   categoryId, type, stock status, public specs, bundle contents (public fields)`. It is used by
   `/api/shop/products`, search JSON and suggestions. A snapshot test asserts that an `internal` attribute, `sku`
   (unless configured public) or an unknown field never appears.
3. **`normalizeProduct()`** is a second validation layer, the same pattern as `normalizeDiscount`. It runs on API
   writes and import rows:
   - price in cents: integer, `0 ≤ cents ≤ 100_000_000`;
   - stock: integer `0..1_000_000`;
   - name: trimmed, 1–200 characters, no control characters;
   - description: ≤ 5,000 characters, control characters removed except `\n`;
   - images: ≤ 10, each `/uploads/<hex>.<ext>` or `https://`;
   - attributes checked against their definitions;
   - the bundle spec validated (§2.6).
   Existing documents are normalised on read for search, and never rejected.
4. **Versioned, audited product writes.** `PATCH` accepts an optional `version`. When it is given, the update is
   `updateWhere(id, {version}, {set, inc:{version:1}})`, and a stale version gets 409 (the backoffice always sends
   it). Create, update and delete write `audit(...)` entries.
5. **Reference checks on delete (F5).** Delete is refused with 409 `in_use` and a list of referencing offers and
   bundles (`target.productIds`, `excludeProductIds`, `bundle.components`). The backoffice offers "Hide instead".
6. **`catalogueVersion`.** `meta/catalogue` is incremented by `updateWhere` on every product, category or attribute
   write and once per import batch. It drives search index freshness across instances (§2.5.4).
7. **Batched re-render (F9).** `catalogueChanged(db, {rerender: true})` is called once per request or import batch.
   It bumps the version and calls `rerenderDynamicPages` once.

## 2.4 Properties (attributes)

- Admin CRUD at `/api/attributes`, using the strict validator and `version`. Each change is audited.
- **Delete:** refused while any product has a value, unless `?purge=true`, which removes the values in batches and
  is audited.
- **Change of type:** refused when there are values. The owner exports, fixes the values and re-imports.
- **Renaming a choice option:** only the label changes. The stored value (slug) stays, so nothing needs migrating.
  Removing an option is refused while products use it (with counts).
- **Product values:** validated per type:
  - text: ≤ 200 characters;
  - choice: must be one of the `options`;
  - multi: ≤ 20 values, each one of the options;
  - number: finite, `|n| ≤ 1e9`, ≤ 3 decimals;
  - boolean.
  Unknown keys are rejected (strict).
- **Storefront:** only `visibility = public` definitions, and the `showOnProduct` ones for the *Product details* widget.

## 2.5 Search

### 2.5.1 Why an in-process index (decision S-1)
- The `DataStore` can't do text search, OR, or facet counts (F6).
- Adding FTS5 (SQLite) and text indexes (Mongo) would mean two very different implementations. Mongo `$text` has no
  prefix search or facets without Atlas, and it would break the "one contract, two adapters" rule.
- The catalogues OpenShop targets (≤ 20k products) fit easily in memory (about 20–40 MB including facets).
- The index sits behind a `SearchBackend` interface (`build`, `query`, `suggest`), so an external engine can replace
  it later without touching routes.

### 2.5.2 Index (`search-index.ts`, pure and deterministic)
- **Normalisation.** NFKD, then remove combining marks (`\p{M}`), lower-case, and split on anything that isn't
  `\p{L}\p{N}`. A letter/digit boundary also splits ("350ml" → "350", "ml", plus the joined token "350ml"). There
  are no stop-words and no stemming, because the shop's language isn't known. Plurals are handled by prefix matching.
- **Fields and weights:**

  | Field | Weight |
  |---|---|
  | SKU (admin: exact match boosts to the top) | 10 |
  | name | 5 |
  | category name | 2 |
  | searchable property values (labels for choices) | 2 |
  | description | 1 |

- **Structures:**
  - token → posting list (product ordinal, field bitmask, term frequency);
  - a sorted token array for prefix ranges (binary search);
  - per facet value → bitset of product ordinals;
  - numeric arrays for price, stock and updatedAt;
  - bundle availability computed at build time.
- **Two views, built from the same snapshot** (C2):
  - **admin:** all products and all fields, including internal properties and SKU;
  - **public:** active and sellable products only (bundles need all components present), public searchable fields
    only.
  The public view is built from `publicProduct()` output, so hidden data can't reach it by construction.

### 2.5.3 Query
- **Matching:** every query word must match (AND). The last word also matches as a prefix (search as you type).
  Other words of 3+ letters match exact or prefix. With S-3 on, words of 5+ letters with no hit match at edit
  distance 1 (Damerau). Candidates come from the token array, filtered by length ±1 and capped at 50 expansions.
- **Score:** Σ over words of field weight × match factor. The factors are:

  | Match type | Factor |
  |---|---|
  | exact | 1.0 |
  | prefix | 0.7 |
  | fuzzy | 0.4 |

  A name that starts with the query adds +2. The score is multiplied by a log-scaled term-frequency factor. Ties are
  broken by in-stock first (shop), then name, then id, so the order is deterministic.
- **Filters:**
  - `category` (id or slug): OR within;
  - `price` `min`/`max`, list price in cents (S-2);
  - `stock` `in` (shop), or `in|low|out` (admin);
  - `type`: admin only;
  - `status`: admin only;
  - `missing=image|sku|category|description`: admin only;
  - `f.<key>=v1,v2`: choice/multi OR within, AND across keys;
  - `f.<key>=min..max`: number;
  - `f.<key>=true`: boolean.
- **Facets:** disjunctive counts, meaning each facet is counted with every filter applied **except its own**, so
  shoppers can widen a choice. Values are the top 20 by count (admin 50). The price facet returns the min and max of
  the current results for the slider bounds.
- **Sort:** `relevance` (default when `q` is set, otherwise `name`), `name`, `-name`, `price`, `-price`, `newest`.
  The admin can also sort by `stock`, `-stock`, `updated` and `-updated`. The sort fields are an allowlist (C17).
- **Paging:** `page` 1..200 and `per` ≤ 48 (shop); `skip` and `limit` ≤ 200 (admin); `limit` ≤ 20 for pickers.

### 2.5.4 Freshness
- Each process caches `meta/catalogue.version`, re-read at most once a second.
- When the version changes:
  - the index is rebuilt in the background (stale results are served meanwhile, typically under 300 ms for 20k
    products);
  - writes in this process update their own entries immediately (read-your-writes for the backoffice).
- Stock changed by orders does **not** bump the version (that would rebuild on every order). Instead, stock and
  availability are refreshed at most every 60 s when orders happened. Availability in results may lag up to 60 s; the
  product page, add-to-cart and checkout always read live stock. This is documented.

### 2.5.5 API
- **Admin:** `GET /api/products?q=&category=&status=&stock=&type=&min=&max=&missing=&f.<key>=&sort=&skip=&limit=`
  returns `{ items, total, facets }`. Items are full admin products (or `?view=summary` for pickers: id, name, sku,
  price, active, type, categoryId, image). `Accept: text/csv` etc. gives the export (§2.7).
  - **Compatibility:** the six backoffice screens that call `api.products()` (F7) and `scripts/seed-demo.py` are
    migrated in the same change.
  - `GET /api/products/:id` is unchanged.
- **Public JSON:** `GET /api/shop/search?…` (same public parameters) returns `{ items: publicProduct[], total,
  facets }`. It is used by `shop.js`. `GET /api/shop/products` keeps its array shape (e2e script) but becomes the
  projection. (P5) `GET /api/shop/search/suggest?q=`.
- **Public HTML:** `/search`, `/shop`, `/shop/category/:slug` accept the same parameters. Unknown parameters are
  ignored. The canonical parameter order is used for links.

### 2.5.6 Shop rendering
- `RenderContext` gains:
  - `filters` (the active filters);
  - `facets` (labels already resolved);
  - `sort`;
  - `page`, `pages`, `total`;
  - `baseUrl` (the current path, for links).
  Everything goes through `esc()` and `safeUrl()`. Facet links are built by the API as relative paths with
  `URLSearchParams` and validated by the renderer (`^/(search|shop)(/category/[a-z0-9-]+)?(\?[^"'<>\s]*)?$`).
- **New widgets** (all props validated in `normProps`, with sample data in the editor):
  - `searchFilters` `{ layout: "sidebar"|"bar", price: bool, availability: bool, category: bool, attributes: "all"|string[] ≤ 20, maxValues: 3..20 }`
    renders `<form method="get" action="<current path>">` with hidden `q`/`sort`, fieldsets of checkboxes, min/max
    number inputs, an "Apply" button (hidden by `shop.js` when JS runs) and removable chips.
  - `resultsBar` `{ showCount: bool, sort: bool }`: count plus a sort `<select>` inside a GET form.
  - `productGrid` with `source: "results"` gets `paginate: bool`, which renders `<nav class="os-pager">` with
    `rel="prev/next"` links.
  - `productSpecs` `{ heading }`: a `<dl>` of public, `showOnProduct` properties.
  - `bundleContents` `{ heading, images: bool }`: §2.6.
- **Templates and migration:**
  - `SYSTEM_PAGES` for category and search gain `searchFilters` + `resultsBar` + paging; product gains
    `productSpecs` + `bundleContents` (they render nothing for products without specs or bundles).
  - **Existing stored system pages are not modified.** The builder shows "New: filters for this page. Add them" when
    a category or search page has a results grid but no `searchFilters`.
  - `RENDERER_VERSION` stays, because stored custom pages are unaffected.
- **Price sort and filter use list prices only** (S-2).
  - **Reason:** discounts depend on the shopper and must never be in HTML (F14).
  - **Reason:** HTML sorted by a signed-in customer's prices would vary per user and could be cached wrongly.
  - **Consequence:** the "on sale" filter is out of scope for the same reason.
- **`shop.js`:**
  - on `change` inside `[data-os-filters]`, calls `form.requestSubmit()` (full page navigation; simple and
    accessible), and hides the Apply buttons;
  - (P5) suggestions are built with `createElement`/`textContent` from `/api/shop/search/suggest`.
  The CSP and Trusted Types stay as they are.
- **Headers:**
  - result pages: `cache-control: public, max-age=60`; they carry no personal data, because prices are added by JS;
  - filtered, sorted or paged pages: `<meta name="robots" content="noindex,follow">` and
    `<link rel="canonical">` to the unfiltered URL.
  `renderDocument` gains an optional `head` extras parameter, escaped.

### 2.5.7 Backoffice
- **Products screen:**
  - server search with debounce, with the query and filters in the URL query string;
  - filter panel with counts;
  - sortable columns, paging and row selection;
  - bulk bar (show, hide, set category, export selection, and "all N matching");
  - an "Import" and an "Export ▾" (CSV / full JSON) menu.
  Bulk actions: `POST /api/products/bulk { ids ≤ 1000 | filter, action, value }`, audited. Large filter-based
  actions run in batches.
- A **typeahead picker** component (`<app-product-picker>`) replaces the full-list loads in the discount editor,
  simulator, builder product-grid inspector and bundle editor. Categories get counts from facets (`limit=0`).
- **Properties screen** (`/products/properties`): definitions list, editor, and usage counts.

## 2.6 Bundles

- **Validation** (`bundles.ts`, called from `normalizeProduct` and the import):
  - 2–20 distinct components;
  - each one must exist, be `type: simple`, and not be the bundle itself;
  - qty 1..99;
  - for `percentOffSum`, `bp` must be 1..9000;
  - a product that is a component can't be turned into a bundle. This check is a scan of the bundles, so nesting
    and cycles are impossible.
- **Price:**
  - `fixed`: the owner's `price`;
  - `percentOffSum`: `price = fromCents(sum − percentOf(sum, bp))`, where `sum = Σ toCents(component.price) × qty`.
  Recomputed and audited whenever a component's price changes. Before the change is saved, the editor and preview
  show "This also changes the price of 3 bundles".
- **Availability (B-1, virtual):**
  - `available = min(floor(component.stock / qty))`;
  - sellable = `bundle.active` and every component exists (components may be hidden, B-4).
  The bundle's own `stock` field is ignored and shown as computed. The product page passes
  `stock: available` in `ProductCtx`, so `addToCart` already disables at 0 and caps the quantity.
- **Pricing engine (B-2):**
  - `priceItems` passes `offerScope` on the bundle's `LineInput`;
  - in `matches()`, a line with `offerScope: "targeted"` only matches `target.type === "products"` that lists its id;
  - because `matches()` is shared by the line and order phases, order-level percent offers skip the line too;
  - `excludeProductIds` keeps working.
  Tests:
  - the table tests cover it;
  - the 5,000-cart randomised invariant test adds bundle lines.
- **Checkout (`placeOrder`, inside `locked()`):**
  1. Expand the merged items into `demand: Map<productId, qty>`: simple products add `qty`; bundles add
     `qty × componentQty` for each component. The same component can come from several bundles and also be bought
     on its own.
  2. Check `stock ≥ demand` for every id, with a clear message ("not enough Dune Plate for 2 × Breakfast set").
  3. Decrement with `updateWhere(id, {stock:{$gte:n}}, {inc:{stock:-n}})` in **sorted id order**, pushing each undo.
     Any failure rolls back everything (the existing pattern).
  - The quote check already catches a bundle price change between cart and checkout (409 `prices_changed`).
  - Line snapshot: `bundle.components[]` with name, SKU, quantity and `allocatedCents`. The allocation is
    `allocate(unitLineCents, components.map(c => listCents×qty))`, so the component shares add up exactly
    (for future per-product revenue reports).
- **Storefront:**
  - `ProductCtx.bundle = { components: [{ name, qty, image, href? }], savingsCents }`. `href` is only set for
    visible components, so hidden ones aren't linked and don't 404.
  - `bundleContents` renders the list and "Save €X compared with buying separately" when `savingsCents > 0`.
    Savings are catalogue data (list prices), not discount data.
  - Cart rows and `/shop/order/:id` show "Includes: …" from the live product or the order snapshot respectively.
- **Backoffice:**
  - the product drawer gets a Type switch; for bundles, a components table (picker, qty, each component's stock),
    price mode, the computed components total, savings, "Available: N (limited by …)", and the offers toggle;
  - the list shows a "Bundle" tag and computed availability;
  - the orders view shows the components under bundle lines;
  - the simulator accepts bundles.

## 2.7 Import and export

### 2.7.1 Formats

| Format | Export | Import | Notes |
|---|---|---|---|
| CSV (`text/csv`) | P1 | P2 | RFC 4180, UTF-8 + BOM. Delimiter `,` `;` or tab (auto-detected on import from the header line; chosen on export). Decimal `.`, or `,` when the delimiter is `;` |
| JSON catalogue (`application/vnd.openshop.catalogue+json`) | P1 | P2 | `{ format: "openshop.catalogue", version: 1, exportedAt, categories[], attributes[], products[] }`. Full fidelity, components by SKU or id |
| PrestaShop CSV | none | P2 (mapping preset) | Preset only; same CSV parser |
| XLSX | P5 | P5 if I-1 allows | Writer is small (zip via `node:zlib`). A reader needs zip + XML parsing (C18) |
| Google/Meta feed (TSV) | P5 | none | From the public projection only |

### 2.7.2 CSV columns (export = import, so a round trip changes nothing)

| Column | Meaning | Rules |
|---|---|---|
| `id` | OpenShop id | Matching key 1. Ignored for creation (new ids are generated) |
| `sku` | SKU | Matching key 2 (normalised). Empty = none |
| `type` | `simple` / `bundle` | Default `simple` |
| `name` | Name | Required on create |
| `visible` | `yes/no/true/false/1/0` | Optional. New products default to hidden (I-3) |
| `price` | List price | `^\d{1,7}([.,]\d{1,2})?$` (comma only with `;`). No thousands separators. Required on create |
| `stock` | Stock | Integer `0..1,000,000`. Ignored for bundles |
| `category` | Category slug (or name; preset) | Unknown → error, or created when `createCategories` |
| `description` | Plain text | ≤ 5,000. HTML tags removed with a warning |
| `images` | `|`-separated | `/uploads/…` or `https://…`, ≤ 10 |
| `attr:<key>` | Property value | Multi: `|`-separated option values or labels. Number: `.` decimal. Boolean: yes/no |
| `bundle_components` | `SKU*2|SKU*1` (or `id*qty`) | Resolved after all simple rows (2 passes) |
| `bundle_pricing` | `fixed`, `percent:15` | |
| `bundle_offers` | `targeted` / `all` | |

- **Formula neutralisation:** export writes `'=…` (existing `csvCell`). Import removes one leading `'` **only**
  when the next character is one of `= + - @ \t \r`. Round-trip test: `-20% mug`, `=SUM(1)` and `'quoted` survive
  export → import unchanged.
- **Empty cell vs. missing column:**
  - a missing column never changes that field;
  - an empty cell clears optional fields only with `empty: "clear"`;
  - an empty cell in a required field is an error.

### 2.7.3 Pipeline

```
POST  /api/catalogue/imports            raw body (text/csv | application/json | vnd.openshop.catalogue+json), ≤ 10 MB
      → parse (streaming, limits) → rows stored → auto-mapping (header match or preset) → status "uploaded"
PUT   /api/catalogue/imports/:id        { mapping, options, preset? }  (strict schema)
POST  /api/catalogue/imports/:id/preview → validate every row with normalizeProduct + references; match by id → SKU;
      compute per-row plan (create/update(diff)/unchanged/error) and warnings; status "previewed"
GET   /api/catalogue/imports/:id/rows?state=&action=   JSON paged, or CSV (Accept) = error/diff report
POST  /api/catalogue/imports/:id/commit { previewAt }   → 409 if mapping/options changed after preview
      → background batches of 200 (yield between batches) → status "done" + result; progress via GET /:id
POST  /api/catalogue/imports/:id/cancel ;  (P5) POST /:id/revert
GET   /api/catalogue/imports           recent jobs (30 days)
```

- **Parsing:** a hand-written RFC 4180 state machine: linear time, no regex backtracking, quoted newlines, `""`
  escapes.
  - Limits: 10 MB; ≤ 20,000 rows; ≤ 200 columns; ≤ 10,000 characters per cell; ≤ 100,000 characters per line.
  - Rejected: a NUL byte, or an unbalanced quote at EOF (with its line number).
  - Encoding: UTF-8 (BOM stripped). If the text isn't valid UTF-8, `windows-1252` via `TextDecoder` (common for
    Excel exports), with a preview warning.
  - JSON: `JSON.parse`, then a strict Ajv schema (`additionalProperties: false`, no coercion) per product.
- **Matching:**
  - an `id` that exists → update;
  - else a SKU that exists → update;
  - else create (in `update` mode, a row with no match is an error);
  - two rows targeting the same product → error on both.
- **Commit, per row** (idempotent; row state is persisted before moving on):
  - **update:** `updateWhere(id, { version: baseVersion, ...(stockMapped ? { stock: baseStock } : {}) }, { set: diff, inc: { version: 1 } })`.
    A null result means a **conflict**: the product was edited, or items sold, since the preview. The row is
    reported and skipped. It never overwrites.
  - **create:** claim the SKU (`product_skus` insert; `DuplicateKeyError` → conflict), then insert the product (undo
    the SKU claim on failure).
  - SKU changes, sum-priced bundle recomputation and `import_changes` records are written per row.
  - Pass 2: bundle rows, once all simple rows are applied.
  - Then: `missing: "hide"` sets `active:false` on products not in the file, shown as a count in the preview and
    capped at 50% of the catalogue unless confirmed again.
  - End: one `catalogueChanged({rerender:true})`, and one audit entry `import` with the job id, file SHA-256,
    counts and user.
- **Concurrency:**
  - one import at a time: a `locks` document `catalogue-import` inserted with an expiry; `DuplicateKeyError` → 409
    "another import is running";
  - an import never holds the order `locked()` chain;
  - checkouts continue, and stock safety comes from the atomic statements (F2 fix plus the stock guard above).
- **Restart safety:** on `onReady`, jobs in `committing` become `interrupted`. "Resume" continues with `pending` rows.
  Applied rows are never re-applied, because the version guard would fail anyway.
- **Retention:** rows and jobs expire after 30 days (purged on startup and daily on access). Files are **not**
  stored under `/uploads` (which is public), only as parsed rows in the database.

### 2.7.4 Export
- `GET /api/products` with the search parameters, and:
  - `Accept: text/csv` → streamed CSV (a `Readable` over pages of 500 from the index, capped at 100,000 rows);
  - `Accept: application/vnd.openshop.catalogue+json` → the full document (streamed JSON array writer);
  - (P5) `Accept: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` → XLSX.
- `Vary: Accept`, `Cache-Control: no-store`, and `Content-Disposition` with a sanitised filename
  (`products-2026-05-01.csv`). `?delimiter=;` and `?columns=` select the layout.
- `negotiate()` gains the new types. The backoffice uses the existing blob download with the Authorization header.
- `import_rows` stores one row per document. This keeps every document far below the Mongo 16 MB limit and lets
  commit update row state atomically. 20k small documents is acceptable; batched inserts are a later optimisation if
  needed.

### 2.7.5 Images by URL (P5, decision I-2)
A background step after commit:
- per URL: `https:` only, with host checks (C7);
- at most 4 fetches in parallel, 10 s timeout, 5 MB, at most 3 redirects (each one re-validated);
- content checked with the existing `saveUpload` sniffing;
- the product's URL replaced by `/uploads/<hex>.<ext>`;
- failures listed on the job.
Identical URLs within one job are fetched once.

## 2.8 API summary (new or changed)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/products` | admin | Search, filters, facets, paging. JSON `{items,total,facets}`, CSV, catalogue JSON, (P5) XLSX by `Accept` |
| POST / PATCH / DELETE | `/api/products[/:id]` | admin | `normalizeProduct`, optional `version`, audit, reference checks, bundle validation, SKU claim |
| POST | `/api/products/bulk` | admin | `{ ids ≤ 1000 \| filter, action: show\|hide\|category, value }`, audited |
| GET / POST / PATCH / DELETE | `/api/attributes[/:id]` | admin | Strict schema, `version`, audit |
| GET / POST / PUT | `/api/catalogue/imports[/:id]` | admin | §2.7.3; upload body limit 10 MB on this route only |
| POST | `/api/catalogue/imports/:id/{preview,commit,cancel,revert}` | admin | |
| GET | `/api/catalogue/imports/:id/rows` | admin | JSON or CSV report |
| GET | `/api/shop/products` | public | Unchanged shape, **public projection** |
| GET | `/api/shop/search` | public | Public parameters only, `{items,total,facets}`, rate limited, `public, max-age=60` |
| GET | `/api/shop/search/suggest` (P5) | public | `q` 2–64 characters, ≤ 6+3 results, rate limited |
| GET | `/search`, `/shop`, `/shop/category/:slug` | public | + `category`, `min`, `max`, `stock`, `f.*`, `sort`, `page` |

## 2.9 Migration and compatibility
- All new product fields are optional. Documents without them behave as `type: simple`, no SKU, no attributes and
  `version` 0. The first versioned write sets `version: 1`.
- SKU backfill: none. Owners add SKUs by editing or importing.
- Existing offers keep referencing product ids. Bundles are products, so offers can target them directly.
- Orders without `bundle` snapshots are unchanged. Insights are unaffected: a bundle is a product line.
- The backoffice `Product` type, `api.products()` consumers, `scripts/seed-demo.py` and `e2e-*.py` are updated in the
  same phase as the API change (P1). The demo seed gains SKUs, 4 properties and 2 bundles (P4).

## 2.10 Performance budgets (20k products, 50 properties, 2k bundles)

| Operation | Budget |
|---|---|
| Index build | ≤ 500 ms |
| Index memory | ≤ 60 MB |
| Admin search p95 (server) | ≤ 50 ms |
| Shop search page p95 (server, incl. render) | ≤ 120 ms |
| Import preview, 20k rows | ≤ 20 s |
| Import commit, 20k rows (SQLite) | ≤ 60 s, with the event loop never blocked > 50 ms |
| CSV export, 20k rows | streamed, first byte ≤ 300 ms |

Above about 50k products or 150 MB of index, `SearchBackend` switches to an external engine. That is a documented
limit, not v1 work.

## 2.11 Testing
- **db:**
  - contract test for the lost update (concurrent `update` + `updateWhere`), on SQLite, fake Mongo, and real Mongo
    with `MONGO_URL`;
  - nested objects are replaced, not merged (same result on both adapters).
- **pricing:**
  - `offerScope` table tests (shop-wide, category, product-named, order-scope, exclusions);
  - bundle lines in the randomised invariant test.
- **renderer:**
  - new widgets: escaping of facet labels, values, chips, query and bundle names (`</style><script>` payloads);
  - `safeUrl` on facet links;
  - sample data and editor attributes;
  - a no-JS form works (markup snapshot).
- **api:**
  - **search:** tokenizer (accents, 350ml, Unicode), prefix, fuzzy, AND semantics, disjunctive facets, sort,
    paging caps, deterministic order;
  - **search privacy:** the public view never returns or matches inactive products, internal properties or SKU, and
    facet counts exclude them (an oracle test: the query for an internal value returns 0 and the same response as
    gibberish);
  - **bundles:** validation (nesting, self, duplicates, limits), derived availability, sum-price recompute on a
    component change, checkout demand aggregation (bundle + same component alone), 20 parallel checkouts never
    oversell a shared component, rollback on partial failure, snapshot allocation sums;
  - **import:**
    - parser fuzzing: random bytes and random CSV must never throw uncaught, must finish in linear time, and must
      respect the limits;
    - `;` with decimal comma; windows-1252;
    - the formula round trip; prototype keys (`attr:__proto__`, JSON `{"__proto__":…}`) are rejected;
    - the mapping presets;
    - the preview counts match the commit;
    - conflicts: edited after preview, sold after preview;
    - idempotent resume after a simulated crash;
    - the single-import lock;
    - audit entries;
    - one re-render per import (spy);
    - export → import = 0 changes (CSV and JSON);
  - **authorization:** every new admin route returns 401 without a token (exhaustive list, as in the discounts plan).
- **backoffice:**
  - product list with server search, filters in the URL, paging and bulk actions;
  - import wizard states (upload error, mapping, preview tabs, conflicts, done);
  - properties editor; bundle editor (availability, price modes, warnings);
  - the typeahead picker;
  - the CSV download sends `Accept`.
- **e2e (Playwright):**
  - shop search and filters without JS and with JS;
  - a bundle purchase reduces component stock;
  - importing a demo CSV end to end in the backoffice.

## 2.12 Phase acceptance criteria
- **P0:** all existing tests pass; the lost-update contract test passes on both adapters; a hidden field added to a
  product never appears in `/api/shop/products`; deleting a referenced product gives 409; product writes are
  audited.
- **P1:** stories F-1, F-2, C-1 to C-5 and A-1, A-2 (export); no screen loads the full product list any more.
- **P2:** A-3 to A-7; export → import round trip gives zero changes; 20k-row budget met.
- **P3:** C-6 to C-9 and C-11; everything works with JavaScript disabled; HTML contains no discount data.
- **P4:** B-1 to B-9; concurrency tests pass; the invariant tests include bundles.
- **P5:** A-8 to A-10 and C-10, as chosen by the owner.

---

# 3. Security

Each item gives the requirement, the reason, and how it is verified. They build on the existing S1–S18 of the
discounts plan, which stay in force. The "known limitations" there also remain: per-process throttles, `req.ip`
behind proxies, and no `Origin` checks on shop forms.

**C1. Data minimisation on public endpoints (F1, confirmed leak path).**
- **Requirement:**
  - Every public response (`/api/shop/products`, `/api/shop/search`, suggest, feed, HTML contexts) is built from
    `publicProduct()`, an **allowlist**.
  - Internal properties, SKU (unless the owner makes it public), `version`, `updatedBy`, import metadata and bundle
    pricing settings are never included.
- **Reason:** today the raw document is returned, so the first internal field added (for example, a cost price in an
  import) would be published.
- **Verified by:** a snapshot test with a product carrying every internal field, plus an unknown field; the
  response keys must equal the allowlist.

**C2. Search must not be an oracle for hidden data.**
- **Requirement:**
  - The public index contains only sellable, active products and public searchable fields. It is built from the
    public projection.
  - Facet values and counts are computed on the public view only.
  - Responses for "matches hidden data" and "matches nothing" are identical.
- **Reason:** even if a field is never displayed, *being able to match it* reveals it. For example, searching a
  supplier name, or a price range over hidden products, shows which products match.
- **Verified by:** oracle tests (internal property value, inactive product name, hidden component name via search
  and via facet counts).

**C3. Authorization.**
- **Requirement:**
  - All product, attribute, import, export and bulk routes are registered in the authenticated `admin` scope. There
    is no public export or feed endpoint in v1; a public feed URL, if ever added, needs a revocable random token.
  - Routes check a `can(user, "catalogue.import" | "catalogue.export" | "catalogue.write")` hook (always true today),
    so roles can be added later without changing routes.
- **Verified by:** an exhaustive 401 list including every new route.

**C4. Strict input validation for API and import.**
- **Requirement:**
  - `normalizeProduct()` runs on every write path: API, import and bulk.
  - Strict Ajv, the same as discount routes (no coercion, unknown fields rejected), replaces today's silently
    stripping product schema.
  - Prices in whole cents with bounds. Integer stock. Lengths capped. Control characters stripped.
  - Attribute keys match `^[a-z][a-z0-9_]{0,31}$` and are not `__proto__`, `constructor` or `prototype`.
    Attribute maps are built with `Object.create(null)` or a `Map`, then copied. `JSON.parse` input that contains
    those keys is rejected.
  - Filter and sort fields are allowlisted and never taken from request keys directly. Attribute filter keys must be
    existing definitions.
- **Reason:** F4 (floats and huge prices accepted today); F6 (DataStore paths come from keys); prototype pollution
  through CSV headers or JSON.
- **Verified by:** negative tests for each field; pollution tests (`({}).polluted === undefined` after importing
  hostile files).

**C5. Stored XSS through imported content.**
- **Requirement:**
  - Imported strings are data, never markup.
  - The renderer escapes everything (`esc`, `safeUrl`, `safeImage`).
  - The backoffice uses interpolation only (no `[innerHTML]`), **including the import preview and error report**,
    which echo raw cells.
  - `shop.js` uses `textContent` only, under Trusted Types.
  - HTML in descriptions (PrestaShop exports) is converted to plain text on import. No HTML is stored.
- **Reason:** the admin bearer token is in `localStorage` (F16). A script running in the backoffice means full
  takeover, and import files come from third parties (suppliers, old platforms).
- **Verified by:** an import fixture full of payloads (`<img src=x onerror>`, `</style><script>`,
  `javascript:` image URLs, `{{constructor}}`), rendered in the storefront, preview and error report: nothing
  executes and the URLs are rejected.

**C6. Spreadsheet formula injection.**
- **Requirement:**
  - Every CSV the server produces neutralises cells starting with `= + - @ \t \r` (existing `csvCell`). This covers
    product exports, import error reports (which echo untrusted input) and feeds.
  - Import reverses exactly one leading `'` before those characters only (§2.7.2).
  - (P5) XLSX cells are written as typed strings or numbers, never as formulas.
- **Verified by:** the round-trip test and a payload test (`=HYPERLINK(...)`, `@SUM`, `+cmd|`).

**C7. SSRF when fetching image URLs (P5).**
- **Requirement:**
  - `https:` only, default port only, no credentials in the URL.
  - Resolve DNS and reject loopback, private (RFC 1918 / 4193), link-local (including `169.254.169.254`), CGNAT,
    multicast and unspecified addresses, for IPv4, IPv6 and IPv4-mapped IPv6.
  - **Connect to the validated IP** (pinned, to defeat DNS rebinding) with SNI and Host set to the name.
  - Re-validate every redirect hop (≤ 3).
  - 10 s total timeout, 5 MB streamed cap, 4 concurrent fetches, a per-host limit.
  - No cookies or auth headers.
  - The content is checked by the existing magic-byte sniffing; SVG is never accepted.
- **Reason:** the server would otherwise fetch internal services or cloud metadata on the admin's behalf, or on a
  malicious supplier file's behalf.
- **Verified by:** tests with a stub resolver (private IPs, rebinding, redirect to `http://127.0.0.1`, oversize,
  wrong type).

**C8. Privacy of hotlinked images.**
- **Requirement:** until P5, imported `https://` image URLs are allowed (as today), but the preview warns that the
  shop will load images from third-party hosts, which see visitors' IP addresses. A setting "self-hosted images only"
  (P5) makes the import download or reject them.
- **Reason:** `img-src https:` in `PAGE_CSP`, and the existing schema (F15).

**C9. Integrity under concurrency.**
- **Requirement:**
  - The SQLite `update()` is a single statement (F2).
  - Product edits are versioned (409 when stale).
  - Import updates are guarded by version, and by stock when stock is mapped.
  - SKU uniqueness uses id-keyed claims.
  - One import at a time (lock document with expiry).
  - Bundle checkout decrements each component atomically in sorted order, with undo.
  - Sum-priced bundles are recomputed in the same request as the component change.
- **Reason:** a lost stock decrement means overselling. Imports create many writes alongside live checkouts.
- **Verified by:** the contract test, parallel checkout tests with shared components, and the import conflict tests.

**C10. Money integrity.**
- **Requirement:**
  - Prices are integer cents at the boundaries, and bundle prices are computed on the server only.
  - The cart and checkout never accept component lists or prices from the client; a bundle is added by its product
    id only.
  - `percentOffSum` is capped (≤ 90%).
  - A fixed price of 0 needs explicit confirmation.
  - Component allocations add up exactly (`allocate`).
  - The quote mismatch (409) covers price changes between cart and order.
- **Verified by:** the engine invariant tests with bundles, and forged form fields on `/shop/cart/add`.

**C11. Safety of bulk changes.**
- **Requirement:**
  - Import requires a preview, and commit must reference it (`previewAt`; 409 if the mapping or options changed
    after the preview).
  - Import never deletes.
  - Mass hide, mass publish and large price changes show warnings, and confirmation is required past the
    thresholds.
  - Bulk actions show the exact count and are audited.
  - Revert is available (P5).
- **Reason:** the most likely "attack" is a mistake (wrong file, shifted columns) or a compromised supplier file.

**C12. Audit and accountability.**
- **Requirement:**
  - Product create, update and delete (new, F3), attribute changes, bulk actions and imports are audited, including
    the user, file name, SHA-256, options and counts.
  - Per-product before/after goes in `import_changes`.
  - Exports are audited too (who exported which filter, and the row count), because a catalogue export is business
    data.
- **Verified by:** audit entries exist for every path.

**C13. Denial of service.**
- **Requirement:**
  - The 10 MB body limit is scoped to the import upload route; the global 1 MB limit stays.
  - Parser limits (rows, columns, cell and line lengths) and a linear-time parser.
  - Import batches yield to the event loop, and only one import runs at a time.
  - Streamed exports capped at 100k rows.
  - Public search caps:
    - `q` ≤ 100 characters and ≤ 10 words;
    - ≤ 20 `f.*` keys, ≤ 50 values each;
    - `page` ≤ 200, `per` ≤ 48;
    - fuzzy expansion ≤ 50 per word.
  - A per-IP token-bucket rate limit on `/search`, `/api/shop/search` and suggest (a new `RateLimiter` alongside the
    existing `FailureLimiter`). Same known limitation: `req.ip` behind a proxy needs `trustProxy`.
  - Index memory is capped and logged.
- **Verified by:** limit tests (413, 400, 429) and a timing test on a pathological CSV (100k quotes).

**C14. Confidentiality of exports and import files.**
- **Requirement:**
  - Export responses are `Cache-Control: no-store` with a sanitised `Content-Disposition`.
  - Downloads use the Authorization header through a blob (the existing pattern), never a token in the URL.
  - Import data is stored only as database rows, never under the public `/uploads` directory, and purged after 30
    days.
  - Import error messages don't echo other products' data beyond the id and name the owner can already see.

**C15. Bundle business-logic abuse.**
- **Requirement:**
  - Availability is checked at checkout from live component stock, including demand from several bundles and
    standalone lines.
  - Hidden components can only be bought through their bundle. `/shop/cart/add` still refuses inactive products, so a
    hidden component's id can't be added on its own.
  - Offers apply per B-2, decided in the pure engine, so the preview and checkout agree.
  - Quantity caps: line qty ≤ 99 and component qty ≤ 99, with the demand sum checked as a safe integer.
- **Verified by:** tests adding a hidden component directly (400), over-demand across lines (409), and
  offer-stacking cases.

**C16. Output, caching and SEO hygiene on result pages.**
- **Requirement:**
  - The query and filter values are escaped where they are echoed (title, chips, "nothing matches").
  - Facet links are built by the server and validated by `safeUrl` plus a path allowlist.
  - Result pages are cacheable only because they contain no personal data: no discounted prices (S-2) and no
    customer names. A test asserts that signed-in and anonymous HTML are identical.
  - `noindex` on filtered, sorted or paged pages.
- **Reason:** reflected XSS, cache poisoning with personal data, crawler traps.

**C17. Injection into the data layer.**
- **Requirement:**
  - Search never builds SQL or Mongo queries from user input: the index is queried in memory.
  - The remaining DataStore filters use typed values and known field names (the existing `PATH` checks stay).
  - No `RegExp` is built from user input (no ReDoS).
- **Verified by:** tests with `'`, `%`, `_`, `$`, `.*` and very long words as queries and filter values.

**C18. Dependencies and supply chain.**
- **Requirement:**
  - P0–P4 add **no new runtime dependencies**: the CSV parser, the index and the XLSX writer are in-house and small.
  - If an XLSX **reader** is adopted (I-1), it must be pinned, audited and run with:
    - a zip entry count cap;
    - an uncompressed size cap of 50 MB (zip bomb);
    - external entities disabled;
    - a time limit in a worker thread.
    Libraries with known prototype-pollution or ReDoS advisories are excluded.
- **Reason:** the project deliberately has a tiny dependency surface (fastify, ajv, mongodb).

**C19. CSRF and origin.**
- **Requirement:**
  - The admin API stays bearer-only (not cookie-based), so import, export and bulk actions are not CSRF-able.
  - The new public endpoints are GET and read-only.
  - The only public write touched is `/shop/cart/add` (bundles), which keeps its current protections. The known
    limitation on `Origin` checks (discounts plan item 7) still applies and is not widened.

---

## Appendix: Effort summary

| Phase | Days |
|---|---|
| P0 Foundations | 4–5 |
| P1 Catalogue model, backoffice search, export | 8–10 |
| P2 Import | 8–10 |
| P3 Shop search and filters | 6–8 |
| P4 Bundles | 8–10 |
| P5 Extras (owner's choice) | 7–9 |
| **Total** | **41–52 days** (one developer), of which P0–P4 = 34–43 |

# OpenShop catalogue: import/export, bundles, variants and search. Implementation plan (v2)

Status: **proposal v2, not implemented.** It replaces `docs/catalogue-plan.md` (v1, kept for comparison). v2 adds the
owner's answers to the v1 decisions, the new **product variants** feature and the **product lifecycle** (products are
never deleted).

**How changes are marked in this document**

| Marker | Meaning |
|---|---|
| 🆕 | New in v2 |
| ✏️ | Changed from v1 (what changed is said next to it) |
| ❌ | Removed from v1 |
| (no marker) | Unchanged from v1 |

---

## What changed since v1 (summary)

| # | Owner input | Effect on the plan | Where |
|---|---|---|---|
| 1 | 🆕 **Product variants**: separate products, linked; chosen properties act as "differentiators"; the shop shows the options and clicking one opens that product's page | A new epic V, a data model (variant groups), a selector algorithm, a builder widget, import/export columns, security items C21–C22 and a new phase P5 | §1.6, §2.8, C21, C22 |
| 2 | B-1 stock derived from components | Confirmed (no change) | §2.6 |
| 3 | B-2 offers off by default | Confirmed (no change) | §2.6 |
| 4 | ✏️ B-3: price defaults to the **sum** of the components; the owner can overwrite it, with a **reset** button; the backoffice shows the original price and the **%** the price represents; offers come from the Discounts tab | `percentOffSum` ❌ removed. Modes are now `sum` (automatic) and `manual`. A "Create an offer for this bundle" shortcut pre-fills the offer editor | B-2, B-10, §2.6.2 |
| 5 | B-4 hidden components allowed | Confirmed (no change) | §2.6 |
| 6 | ✏️ I-1: keep CSV and JSON | ❌ XLSX and Google/Meta feeds removed. No new dependencies at all | §1.9, §2.7.1, C18 |
| 7 | ✏️ I-2: also allow **local file paths on the server** | Images can be an existing `/uploads/…`, a path inside a server media folder (copied in), or an `https://` URL (downloaded, P6). New security item C20 (path traversal, file reads) | A-9, §2.7.5, C20 |
| 8 | I-3 `visible` column | Confirmed (no change) | §2.7.2 |
| 9 | I-4 import never deletes | Confirmed, and also follows from the new lifecycle | §2.7 |
| 10 | ✏️ S-1: each database should use its best approach, but performance-only differences can be deferred | A `SearchBackend` interface with its own contract test suite. The analysis in §2.5.1 shows that native engines are not better **functionally** at our scale (SQLite FTS5 has no typo tolerance; MongoDB `$text` has no prefix or typo tolerance), so the difference is performance only. v2 ships one shared in-process backend for both adapters; native backends are future work | §2.5.1, §2.13 |
| 11 | ✏️ S-2: filter and sort by the **shopper's discounted price** | New "your price" engine (`priceCatalogue`), the same value the price cards show, with a cache per shopper context. This **refines the rule "no discount data in HTML"**: result pages sorted or filtered by price are personal (`private, no-store`). New security item C23 | C-7, C-8, §2.5.7, C23 |
| 12 | ✏️ S-3: typo tolerance on, explained in depth | Full algorithm in §2.5.4: when it applies, candidate search, distance check, ranking, "Showing results for…", Unicode, limits, tests | §2.5.4 |
| 13 | ✏️ S-4: products are **never deleted**. Visible → only "Hide"; hidden → "Delete" with a confirmation page listing bundles; soft delete keeps the product in everything that references it; "Deleted products" view with restore | v1's "refuse delete when referenced" ❌ is replaced by a lifecycle (visible → hidden → deleted → restored as hidden). There is no hard-delete endpoint. This also fixes F5. New epic L, §2.3.5 and security item C24 | §1.2, §2.3.5, C24 |

**New open decisions** (recommendations included): V-1 to V-3, L-1 and L-2, and S-2a (acknowledging the changed HTML
rule). See §1.9.

**Effort:** ✏️ v1 was 41–52 days. v2 is **50–63 days** (P0–P5 without extras: 46–57). The main additions are variants
(a new phase of 7–9 days) and shopper-price sorting (+3 days in P3). Removing XLSX and feeds saves about 3 days. See §1.10.

---

## 0. How the current code shapes this plan

(Unchanged from v1, except F5, F8 and F14, and two new findings.) ✅ means confirmed by a probe against the current
code. Baseline `npm test` passes (db 19, pricing 33, renderer 23, api 53).

| # | Finding | Where | Consequence |
|---|---|---|---|
| F1 | ✅ `GET /api/shop/products` (public) returns the raw product document; any internal field leaks | `app.ts` | **Blocker.** Allowlist projection before any new field (C1) |
| F2 | ✅ SQLite `update()` is read-modify-write across an `await`: a concurrent stock decrement is lost (stock 10 instead of 9) | `packages/db/src/sqlite.ts` | Fix in P0 with a contract test |
| F3 | No SKU, attributes, `version`, timestamps or product audit | `types.ts`, `app.ts` | New fields; product writes audited |
| F4 | ✅ Prices accept `10.129` and `1e300` | `productProps` | Cents-precise validation with bounds |
| F5 | ✏️ ✅ Deleting a product referenced by an offer makes the offer uneditable (`400 unknown ids`) | `DELETE /api/products/:id`, `checkRefs` | **v2: solved by soft delete.** The record stays, so references stay valid (§2.3.5) |
| F6 | `DataStore.Filter` has no text search, OR, array-contains or aggregation | `packages/db` | Search needs its own backend (§2.5) |
| F7 | Every screen loads the whole catalogue | backoffice, `storefront.ts` | Paged server search and typeahead pickers |
| F8 | ✏️ Shop search is a substring scan, with no ranking, filters or accent handling | `storefront.ts` | Replaced (§2.5). **v2:** price sort and filter use the shopper's price (§2.5.7) |
| F9 | `rerenderDynamicPages()` runs after every product write | `pages.ts` | Once per request or import batch |
| F10 | ✅ Global 1 MB body limit; `text/csv` gets 415 | `app.ts` | Route-scoped parser and limit for import |
| F11 | CSV convention already exists (`Accept`, `csvCell` neutralises formulas) | `negotiate.ts` | Export = a representation of the search URL; import reverses the `'` prefix |
| F12 | Engine is line-based; one `matches()` for line and order phases; `allocate()` exists | `packages/pricing` | A bundle is one line; `offerScope` in `matches()` |
| F13 | `placeOrder` decrements stock per line with `updateWhere` + undo inside `locked()`; cancel does not restock | `orders.ts` | Bundles decrement their components |
| F14 | ✏️ System pages render per request; `renderer/model.ts` is the trust boundary; discount data must never be in HTML | `renderer`, `pages.ts` | New widgets validated in `normProps`. **v2:** the HTML rule is refined for price sorting (§2.5.7, C23) |
| F15 | Images accept any `https://` URL; the CSP allows `img-src https:` | `productProps`, `PAGE_CSP` | Hotlinking privacy and SSRF (C7, C8) |
| F16 | One admin role; the bearer token is in `localStorage` | `auth.ts`, backoffice | Imported strings must stay inert (C5) |
| F17 | 🆕 ✅ `node:sqlite` (Node 22.21) includes **FTS5** (prefix queries work; `stonewre` finds nothing) but **not `spellfix1`** | `node:sqlite` | A native SQLite search can't do typo tolerance (S-3) without our own code (§2.5.1) |
| F18 | 🆕 `/api/shop/prices` computes a product's "your price" as a one-line cart with qty 1, **including** order-scope offers allocated to that line and the cart's code and selection. The offer editor can't be pre-filled from a URL | `shop-api.ts`, `discounts/editor.ts` | Sorting by price must reuse exactly this computation, or the order won't match the prices shown (§2.5.7). The editor gains `?product=` (B-10) |

---

# 1. Business user stories

## 1.1 Goals and personas
Unchanged: the **owner** (onboarding, kits and gift sets, variants, finding products) and the **shopper** (narrowing
results, choosing a colour or size).

## 1.2 Foundation and ✏️ product lifecycle stories

| ID | Story | Acceptance criteria |
|---|---|---|
| F-1 | As an owner I give products a **SKU** | Optional, unique (case-insensitive), `A–Z a–z 0–9 . _ -`, 1–64. ✏️ SKUs of deleted products stay reserved, so a restore never clashes |
| F-2 | As an owner I define **properties** once and fill them per product | Types: text, single choice, multiple choice, number (unit), yes/no. Flags: shown on product page, filterable, searchable, internal. 🆕 Choice options have an order (used by variant selectors) and an optional colour swatch |
| ❌ F-3 (v1) | "Deleting a product used by an offer or bundle is refused" | **Replaced by L-1 to L-6** |
| F-4 | As an owner I see who changed a product and when | Create, update, hide, delete, restore and import are audited with before/after |
| 🆕 L-1 | As an owner, a **visible** product can only be **hidden** | A visible product has no delete action in the list or the editor, only "Hide from shop" |
| 🆕 L-2 | As an owner I delete a **hidden** product after confirming | The "Delete" button appears only when hidden. It opens a **confirmation page** that lists: bundles containing it (each with an "also hide this bundle" checkbox); variant groups it belongs to; offers that name it; and unshipped orders containing it (information only) |
| 🆕 L-3 | As an owner, a deleted product **stays visible wherever it is referenced** | Bundles still list it as a component (marked "deleted" in the backoffice); offers still show it (marked "deleted") and stay editable; orders show it; the variant group keeps it (inactive). It no longer appears in the product list, in pickers for new references, in exports (unless requested) or anywhere in the shop |
| 🆕 L-4 | As an owner I find and **restore** deleted products | A discreet "Deleted products (N)" link on the Products screen opens the list (searchable). "Restore" brings a product back as **hidden**, so it doesn't go live by accident |
| 🆕 L-5 | As an owner, **nothing ever hard-deletes** a product | No API, import or bulk action removes a product record |
| 🆕 L-6 | As an owner, a deleted component keeps its bundle working | Per decision L-1, the bundle stays on sale (the component behaves like a hidden component) unless "also hide this bundle" was ticked |

## 1.3 Epic A: Import and export

| ID | Story | Acceptance criteria |
|---|---|---|
| A-1 | Export the product list to CSV | As v1: exports the current search or everything; UTF-8 + BOM; `,` or `;`; formula-safe. ✏️ Deleted products are excluded unless the "Deleted products" view is exported |
| A-2 | Full backup as JSON, importable into another OpenShop | As v1. 🆕 Includes variant groups. ✏️ Deleted products are included with `deleted: true`, so a copy is complete |
| A-3 | Import CSV or JSON with mapping → preview → confirm | As v1: nothing is written before confirming |
| A-4 | Import options | Modes *create and update*, *update only*, *create only*; missing products *leave* or *hide*; **never delete**; empty cells *leave* or *clear*; stock *set* or *skip*. 🆕 Rows matching a **deleted** product: *report as error* (default) or *restore and update* |
| A-5 | Understandable error report (CSV) | As v1 |
| A-6 | PrestaShop CSV preset | As v1 (it is CSV, so it stays) |
| A-7 | Risk warnings before confirming | As v1. 🆕 Also: "3 products would be restored", "variant group *linen-mug* would get two products with Colour = Blue" |
| A-8 | Revert the last import (P6) | As v1 |
| A-9 | ✏️ Import **photos** | `images` cells may contain: (1) an existing OpenShop upload `/uploads/…` (checked to exist); (2) 🆕 **a file path on the server**, inside the folder the server administrator configured for imports (`IMPORT_MEDIA_DIR`); the file is checked and **copied** into the shop's uploads; (3) an `https://` URL, downloaded and hosted (P6; until then kept as an external link, with a warning). Each failure is listed per row and doesn't block the product. The same file used by many rows is stored once |
| ❌ A-10 (v1) | XLSX export and Google/Meta feeds | Removed (I-1). Possible future work |

## 1.4 Epic B: Product bundles

| ID | Story | Acceptance criteria |
|---|---|---|
| B-1 | Create a bundle from existing products | As v1: 2–20 components, qty 1–99, no nested bundles |
| ✏️ B-2 | Bundle **price** | **By default the price is the sum of the components** (price × quantity) and updates automatically when a component's price changes. The owner can type another price (**manual**). The editor then shows "Original price €70.00 · your price €59.00 = **84%** of it (−16%)" and a **"Reset to sum"** button. Warnings: manual price above the sum, below 50% of it, or 0 (needs confirmation). ❌ v1's "% off the components" mode is removed; percentage deals are made as offers (B-10) |
| B-3 | Availability derived from components (decision B-1 confirmed) | `min(floor(component stock / qty))`, shown with the limiting component |
| B-4 | Components may be sold only inside bundles (confirmed) | Hidden components are allowed. ✏️ Deleted components follow L-6 |
| B-5 | Offers don't stack on bundles unless enabled (confirmed) | Shop-wide and category offers don't apply unless enabled per bundle; offers that name the bundle always apply |
| B-6 | Shopper sees the contents and the savings | Contents list. ✏️ "Save €X compared with buying separately" only for a **manual** price below the sum (a sum-priced bundle saves nothing until an offer applies; offers are shown by the existing offers widget) |
| B-7 | Contents in the cart and on the confirmation | As v1 |
| B-8 | Owner sees the contents on orders (packing) | As v1 |
| B-9 | Search, filter, export and import bundles | ✏️ Columns `bundle_components`, `bundle_pricing` (`sum` / `manual`), `bundle_offers` |
| 🆕 B-10 | As an owner I **create an offer for a bundle** straight from the bundle editor | The "Create an offer for this bundle" button opens Discounts → New offer with *Product price* pre-selected and the bundle as the target (`/discounts/new?product=<id>`) |

## 1.5 Epic C: Search (backoffice and shop)

| ID | Story | Acceptance criteria |
|---|---|---|
| C-1 | Owner finds a product by name, SKU, description, category or property | ✏️ Typo tolerance exactly as §2.5.4 |
| C-2 | Owner filters, sorts and pages the list | As v1. 🆕 Plus "Status: visible / hidden / deleted" and "In a variant group" |
| C-3 | Owner finds incomplete products | As v1 |
| C-4 | Bulk actions | ✏️ Show, hide, set category, export. **Delete is not a bulk action** (it needs the per-product confirmation, L-2) |
| C-5 | Pickers stay fast (typeahead) | As v1. ✏️ Deleted products are never offered |
| C-6 | Shopper gets relevant results | As v1, with typos as §2.5.4 |
| ✏️ C-7 | Shopper filters by price, availability, category and properties | **The price filter uses the shopper's own price**: the price they see on the product card, including their offers, customer prices and the code in their cart. Works without JavaScript |
| ✏️ C-8 | Shopper sorts and pages | **"Price low–high / high–low" sorts by the shopper's own price.** Shareable URLs (the same URL can show a different order for a signed-in customer with special prices) |
| C-9 | Product properties on the product page | As v1 |
| C-10 | Suggestions while typing (P6) | As v1 |
| C-11 | Owner designs filters, sorting and paging in the builder | As v1. 🆕 Plus the *Variants* widget |
| 🆕 C-12 | As a shopper I understand when my typo was corrected | When every result comes from a corrected word: "Showing results for **stoneware**" above the results |

## 1.6 🆕 Epic V: Product variants (linked products)

Variants are **separate products** (own name, price, stock, SKU, photos and page), **linked** in a *variant group*.
The group names 1–3 properties as **differentiators** (for example Colour and Size). The shop shows a selector per
differentiator; each option is a link to the product with that value.

| ID | Story | Acceptance criteria |
|---|---|---|
| V-1 | As an owner I **link** existing products as variants of each other | From a product: "Link variants" → pick products with the search picker. A product belongs to at most one group. 2–100 products per group |
| V-2 | As an owner I choose the **differentiators** | 1–3 properties of type *single choice*, *number* or *yes/no*, all **public**. The order matters: the first is shown first and wins ties (§2.8.3) |
| V-3 | As an owner I'm told when the variants don't make sense | Every product in the group must have a value for every differentiator, and **no two products may have the same combination**. Errors name the products ("Linen Mug Blue S and Linen Mug Blue S (copy) are both Colour = Blue, Size = S"). Enforced when saving the group, a product, or an import |
| V-4 | As a shopper, on a product with variants I see the **options per differentiator** | "Colour: Blue · White · Sand", "Size: S · M · L". The current values are marked as selected. Option order follows the property's option order (numbers ascending). Optional colour swatches |
| V-5 | As a shopper, **clicking an option opens that product's page** | A plain link, so it works without JavaScript. If the exact combination doesn't exist (White in size M), it opens the **closest** product (White, keeping as many of my other choices as possible) and the option is marked "also changes Size" |
| V-6 | As a shopper I don't see options that can't be bought or viewed | Hidden and deleted products are left out of the selector (their values don't appear). Out-of-stock variants are shown as "sold out" but can still be opened |
| V-7 | As an owner I **create a new variant quickly** | "Add a variant" duplicates the current product (description, photos, category, properties) as a **hidden** product in the same group. I choose its differentiator values and edit price, stock and SKU, then make it visible |
| V-8 | As an owner I see and manage the group | The product editor's *Variants* section shows a table (product, differentiator values, price, stock, visibility) with reorder, "remove from group" and "change differentiators". The product list shows a "3 variants" tag and has an "In a variant group" filter |
| V-9 | As an owner I **import and export** variant groups | CSV columns `variant_group` (a group handle such as `linen-mug`) and `variant_by` (`colour|size`). JSON has `variantGroups[]`. The preview validates V-3 across the whole file |
| V-10 | As an owner I target **all variants** in an offer | The offer editor's product picker has "Add all variants" for a product in a group (adds the current members) |
| V-11 | (decision V-1) As an owner I choose how variants appear in **lists** | Per group: "show every variant" (default) or "show one card per group". With one card, lists and search show the best-matching variant with "+2 colours" |

## 1.7 Out of scope (v2)
- ✏️ ~~Product variants~~: now in scope as linked products (epic V). Still out of scope: variants as **one product
  with combinations**, meaning shared stock or a price matrix inside one product, and automatic generation of every
  combination.
- Mix-and-match bundles, buy-X-get-Y, "frequently bought together".
- Pre-assembled bundle stock; nested bundles; bundles as components.
- Rich-text (HTML) descriptions.
- Restock on cancel (unchanged, F13).
- Roles and permissions.
- Multi-language search, owner-managed synonyms, search analytics dashboards ("no results" report is P6).
- Scheduled or URL/FTP imports.
- 🆕 ❌ XLSX import/export and product feeds (I-1).
- 🆕 Native per-database search engines (future work, §2.13).
- 🆕 "On sale" filter (now technically easy with §2.5.7, but not requested).

## 1.8 Metrics
As v1, plus 🆕:
- share of product views that use the variant selector;
- conversion on products with variants compared with without;
- restores from "Deleted products";
- searches where a typo correction produced the results.

## 1.9 Business risks, safeguards and decisions

### Risks and safeguards

| Risk | Safeguard |
|---|---|
| An import overwrites good data | Mandatory preview with diff, warnings, "update only", never delete, revert (P6), audit |
| An import publishes unfinished products | `visible` column; new products hidden by default |
| Overselling during an import | Atomic updates; stock applied only if unchanged since the preview |
| Bundle margin loss | Offers off by default on bundles; warnings for manual prices; simulator |
| 🆕 An owner deletes something by mistake | Delete is possible only when hidden, goes through a confirmation page, is a soft delete, and is restorable |
| 🆕 A deleted component silently keeps a bundle on sale | The confirmation page lists each bundle with an "also hide" checkbox; the bundle editor shows "contains a deleted product" |
| 🆕 Confusing variant selectors | Validation of combinations (V-3); "also changes Size" hint; hidden variants left out |
| 🆕 Shoppers confused by price sorting without JavaScript | The order uses their price but cards show list prices until JS runs; a `<noscript>` note explains this |
| Crawler traps | `noindex` on filtered, sorted and paged pages |

### Decisions: recorded (owner answers)

| # | Decision | Notes |
|---|---|---|
| B-1 | Bundle stock derived from components | |
| B-2 | Automatic shop-wide and category offers don't apply to bundles unless enabled per bundle | |
| ✏️ B-3 | Price = sum of components by default; manual override with reset; show original price and %; offers via Discounts | |
| B-4 | Components may be hidden | |
| ✏️ I-1 | CSV and JSON only | |
| ✏️ I-2 | Download and host URLs; **also server file paths** | Server paths are limited to a folder set by the server administrator (C20) |
| I-3 | `visible` column; new products hidden unless set | |
| I-4 | Import never deletes | |
| ✏️ S-1 | Best approach per database, performance-only differences deferred | §2.5.1: shared backend now, native later |
| ✏️ S-2 | Filter and sort by the shopper's discounted price | Needs S-2a below |
| ✏️ S-3 | Typo tolerance on | §2.5.4 |
| ✏️ S-4 | Never delete; hide → delete (soft) → restore | §2.3.5 |

### 🆕 Decisions still open (recommendation in bold)

| # | Question | Options | Recommendation |
|---|---|---|---|
| S-2a | S-2 changes an existing rule ("discount data never goes into HTML", discounts plan F5/S11). Accept the refinement? | **Refine: HTML may be *ordered and filtered* by the visitor's own prices, only in private, non-cached responses; amounts, labels and offer details still never appear in HTML** / JS-only (results reordered by `shop.js`; no-JS shoppers get list-price order) | **Refine.** It works without JS and keeps the privacy goal: no shopper can see another shopper's prices, and nothing personal is cached |
| V-1 | How variants appear in lists | **Every variant (default) + per-group "one card" option** / always one card / always every variant | Every variant by default: they are real products and property filters then work naturally |
| V-2 | Option whose exact combination doesn't exist | **Link to the closest product, with an "also changes…" hint** / show disabled | Closest product: never a dead end |
| V-3 | Can bundles be variants (e.g. a gift set in blue or sand)? | **Yes** / simple products only | Yes; nothing in the model prevents it |
| L-1 | A bundle contains a product that gets deleted | **Stays on sale unless "also hide" is ticked on the confirmation page** / always hidden automatically | Stays on sale: you said deleted products "still show as part of other things", and the component keeps its stock |
| L-2 | An import row matches a deleted product (by id or SKU) | **Error by default; option "restore and update"** / restore silently | Error by default: restoring is a visible decision |

## 1.10 Roadmap ✏️

| Phase | Delivers | Effort |
|---|---|---|
| **P0 Foundations** ✏️ | SQLite atomic `update` + contract test; public projection; `normalizeProduct`; versioned and audited writes; `catalogueVersion`; batched re-render; 🆕 **product lifecycle** (hide → soft delete → restore, no hard delete, confirmation impact endpoint) instead of v1's reference checks | 5–6 days |
| **P1 Catalogue model + backoffice search + export** ✏️ | SKU, properties (🆕 option order, swatches), 🆕 `SearchBackend` interface + search contract suite, shared in-process backend, admin search API, CSV/JSON export, new Products screen (🆕 "Deleted products" view, confirmation page), Properties screen, typeahead pickers | 9–11 days |
| **P2 Import** ✏️ | CSV/JSON import, mapping, preview, commit, report, lock, audit, PrestaShop preset; 🆕 images from `/uploads` and **server paths** (`IMPORT_MEDIA_DIR`); 🆕 deleted-product matching | 9–11 days |
| **P3 Shop search and filters** ✏️ | Public view, pages with filters/sort/paging, builder widgets, templates, `shop.js`, SEO, rate limits; 🆕 **shopper-price sorting and filtering** (`priceCatalogue`, context cache, personal responses); 🆕 "Showing results for…" | 9–11 days |
| **P4 Bundles** ✏️ | Model, validation, 🆕 sum/manual pricing with reset, derived availability, `offerScope`, checkout, snapshot, storefront, editor, 🆕 "Create an offer" shortcut, import/export columns | 7–9 days |
| **P5 Variants** 🆕 | Variant groups, validation, selector algorithm, `productVariants` widget, "Add a variant", backoffice variants section, import/export columns, "Add all variants" in offers, optional one-card listing | 7–9 days |
| **P6 Extras** ✏️ | URL image download (SSRF-safe), import revert, suggestions, "no results" report. ❌ XLSX, feeds | 4–6 days |
| **Total** | | **50–63 days** (P0–P5: 46–57) |

---

# 2. Technical details

## 2.1 Architecture ✏️

```
packages/db         update() as a single json_set statement (SQLite); lost-update contract test
packages/pricing    LineInput.offerScope; 🆕 priceCatalogue() = one-unit "your price" for many products (§2.5.7)
packages/renderer   widgets: searchFilters, resultsBar, productSpecs, bundleContents, 🆕 productVariants;
                    productGrid paging; RenderContext additions; sample data
apps/api/src/catalogue/
  products.ts       admin routes; 🆕 lifecycle (hide / delete-impact / delete / restore)
  model.ts          normalizeProduct(), publicProduct()
  attributes.ts     property definitions (🆕 option order, swatch)
  skus.ts           SKU claims (product_skus, id = normalised SKU)
  bundles.ts        validation, availability, ✏️ sum/manual price materialisation, order expansion
  🆕 variants.ts     variant groups, combination validation, selector algorithm (pure, unit-tested)
  search/
    🆕 backend.ts    SearchBackend interface (+ contract suite in test/search-contract.ts)
    memory.ts       shared in-process backend (index, facets, ranking)
    🆕 fuzzy.ts      typo tolerance (§2.5.4), pure
    🆕 your-price.ts shopper context key, price-map cache, price filter/sort (§2.5.7)
  import/           csv.ts, json.ts, mapping.ts, validate.ts, jobs.ts, routes.ts, 🆕 media.ts (§2.7.5)
  export.ts         CSV (streamed), JSON catalogue   (❌ XLSX, feeds)
apps/api/src/storefront.ts  search/category pages, bundle contents, 🆕 variant selector context
apps/api/src/shop-api.ts    ✏️ /api/shop/prices uses the same unitPrices() as search (one implementation)
apps/backoffice             Products (deleted view, delete confirmation), Import wizard, Properties,
                            bundle editor, 🆕 variants section, typeahead picker, 🆕 offer editor ?product= prefill
```

## 2.2 Data model ✏️

```ts
interface Product extends Doc {
  name: string; price: number; active: boolean; stock: number; categoryId?: string | null;
  description?: string; images?: string[];
  sku?: string | null;
  type?: "simple" | "bundle";
  attributes?: Record<string, AttrValue>;
  bundle?: BundleSpec;
  variantGroupId?: string | null;        // 🆕 membership: the single source of truth
  variantPosition?: number;              // 🆕 order inside the group (backoffice table; tie-break)
  deletedAt?: string | null;             // 🆕 soft delete (deletedAt != null ⇒ active === false)
  deletedBy?: string | null;             // 🆕
  version?: number; createdAt?: string; updatedAt?: string; updatedBy?: string;
}

interface AttributeDef extends Doc {
  key: string; label: string; type: "text" | "choice" | "multi" | "number" | "boolean"; unit?: string;
  options?: { value: string; label: string; position: number; swatch?: string }[];  // ✏️ position, 🆕 swatch (safeColor)
  visibility: "public" | "internal"; filterable: boolean; searchable: boolean; showOnProduct: boolean; position: number;
  version: number; createdAt: string; updatedAt: string;
}

interface BundleSpec {
  components: { productId: string; qty: number }[];
  pricing: { mode: "sum" } | { mode: "manual" };         // ✏️ was fixed | percentOffSum
  offerScope: "targeted" | "all";
}

// 🆕 collection "variant_groups"; id = handle (^[a-z0-9-]{1,64}$, immutable; same "id is the unique key" technique as SKUs and voucher codes)
interface VariantGroup extends Doc {
  name: string;                          // internal label, ≤ 120
  differentiators: string[];             // 1..3 attribute keys (choice | number | boolean, public)
  listing: "all" | "one";                // decision V-1
  version: number; createdAt: string; updatedAt: string; updatedBy: string;
}

// ImportJob.options gains: deleted: "error" | "restore"   (🆕 L-2);  media: { sources: ("uploads" | "server" | "url")[] }
// ProductSku, CatalogueMeta, ImportRow, ImportChange: as v1
// OrderLine: as v1 (+ bundle.components snapshot)
```

Why membership lives on the product:
- The `DataStore` has no transactions. Keeping `productIds[]` on the group **and** `variantGroupId` on each product
  could drift apart.
- With only `variantGroupId`, a product can't be in two groups by construction.
- Members are `find({ variantGroupId })`, an equality filter that both adapters support.

## 2.3 P0 Foundations ✏️

1. **Atomic SQLite `update`** (F2): as v1. A `json_set` chain per top-level field, one statement. `json_patch` is not
   used because it merges nested objects, which would diverge from Mongo's `$set`. Lost-update contract test.
2. **Public projection** (F1): as v1. 🆕 The projection also drops `deletedAt`, `deletedBy`, `variantPosition` and
   the group's internal `name`.
3. **`normalizeProduct()`**: as v1. 🆕 It also enforces `deletedAt ⇒ active === false` and bundle and variant rules.
4. **Versioned, audited writes**: as v1.
5. ✏️ **Product lifecycle (S-4)**, replacing v1's "refuse delete when referenced". See §2.3.5.
6. **`catalogueVersion`**: as v1 (also bumped by variant-group changes).
7. **Batched re-render**: as v1.

### 2.3.5 🆕 Product lifecycle (never delete)

```
   visible ──hide──▶ hidden ──delete (confirm)──▶ deleted ──restore──▶ hidden
      ▲                 │                                                │
      └────show─────────┘◀───────────────────────────────────────────────┘
```

**API**
| Method | Path | Behaviour |
|---|---|---|
| PATCH | `/api/products/:id` `{active:false}` | Hide. ✏️ `{active:true}` on a deleted product → 409 `restore_first`. All PATCHes use `updateWhere(id, { deletedAt: null, ...version }, …)`, so a deleted product can't be edited, even by a racing request |
| GET | `/api/products/:id/delete-impact` 🆕 | `{ bundles: [{id, name, active}], variantGroup: {id, name, members} \| null, offers: [{id, name, state}], openOrders: n }` for the confirmation page |
| DELETE | `/api/products/:id` ✏️ | **Soft delete.** Body `{ hideBundles?: string[] ≤ 2000 }`. Returns 409 `hide_first` if the product is visible. Sets `deletedAt`, `deletedBy` and `active:false` (guard `{active:false, deletedAt:null}`). Hides the chosen bundles (which must actually contain it). Audited (with impact). Idempotent |
| POST | `/api/products/:id/restore` 🆕 | Clears `deletedAt`; the product stays **hidden**. If its variant combination is now taken, it is restored **outside** the group and the response says so. Audited |
| — | ❌ hard delete | No endpoint, no import mode, no bulk action. `scripts/seed-demo.py --only` switches to soft delete plus create |

**Effects of `deletedAt`**

| Area | Behaviour |
|---|---|
| Shop (lists, search, product page, cart add, checkout) | As hidden: not listed, 404 page, add refused, checkout "product unavailable" (existing code paths, because `active:false`) |
| Backoffice product list and search | Excluded by default. `status=deleted` shows them ("Deleted products" view) |
| Pickers (offers, bundles, variants, builder) | Excluded; existing references are shown with a "deleted" tag |
| Offers | Still reference the id; `checkRefs` finds the record, so the offer **stays editable** (fixes F5). The editor shows "(deleted)". Pricing is unaffected: the product can't be in a cart |
| Bundles | The component remains; decision L-1 (stays sellable; the component is treated like a hidden component). The bundle editor and list show "contains a deleted product" |
| Variant groups | The member keeps `variantGroupId`; it is excluded from the shop selector and from uniqueness checks (§2.8.2) |
| Orders | Snapshots unchanged; the link opens the product in the backoffice (read-only with "Restore") |
| SKU | Stays claimed, so a restore never clashes. Import matching follows L-2 |
| Export | Excluded unless exporting the Deleted view; the JSON backup includes them with `deleted: true` |
| Search index | Admin view keeps them with a flag (for the Deleted view); the public view never contains them |

## 2.4 Properties ✏️
As v1, plus:
- 🆕 **Option order.** `options[].position` sets the order of filter values and variant options. It can be
  reordered by drag and drop in the Properties screen.
- 🆕 **Swatches.** `options[].swatch` is an optional colour, validated with the renderer's `safeColor` (hex only), and
  shown in variant selectors and filters.
- 🆕 **Properties used as a differentiator by any variant group:**
  - they can't be deleted;
  - they can't change type;
  - they can't become `internal`;
  - an option can't be removed while a group member uses it.
  The error lists the groups.

## 2.5 Search ✏️

### 2.5.1 ✏️ Backend choice: "best approach per database" (S-1)

**Architecture.** Search is a `SearchBackend` interface:

```ts
interface SearchBackend {
  sync(change: CatalogueChange | "full"): Promise<void>;
  query(view: "admin" | "public", q: SearchQuery, price?: PriceLookup): Promise<SearchResult>;
  suggest(view: "public", prefix: string): Promise<Suggestion[]>;
}
```

Like the `DataStore`, it has a **shared contract test suite** (`test/search-contract.ts`): tokenisation, accents,
prefix, typo cases (§2.5.4), AND semantics, disjunctive facets, sort, paging, privacy of the public view,
deterministic order. Any backend must pass it. A `DataStore` may offer a native backend later through an optional
`searchBackend()` capability; without one, the shared in-process backend is used.

**What each database can do natively** (checked against Node 22.21 and MongoDB docs):

| Need | SQLite (FTS5, in `node:sqlite` ✅) | MongoDB `$text` (self-hosted) | MongoDB Atlas Search | Shared in-process backend |
|---|---|---|---|---|
| Accent/case folding | ✅ `unicode61 remove_diacritics 2` | ✅ (per-language) | ✅ | ✅ |
| Prefix ("sto…") | ✅ `stone*` | ❌ (whole words, stemming) | ✅ | ✅ |
| Typo tolerance (S-3) | ❌ (`spellfix1` not in `node:sqlite`, ✅ checked) | ❌ | ✅ | ✅ (§2.5.4) |
| Facet counts (disjunctive) | ⚠️ with one SQL `GROUP BY` per facet | ⚠️ `$facet` aggregation | ✅ | ✅ |
| Sort/filter by shopper price (S-2) | ❌ computed in app anyway | ❌ | ❌ | ✅ (same app code for all) |
| Same results on both adapters | no | no | no | ✅ |
| Works without extra services | ✅ | ✅ | ❌ (Atlas only) | ✅ |

**Conclusion.**
- At the target scale (≤ 20k products), the native options give **no functional benefit**. Each one lacks at least
  one required feature (typo tolerance, or prefix on self-hosted Mongo). Filling those gaps would mean
  re-implementing them in app code per adapter, with different results on each database.
- The real advantage of native engines is **performance and memory at larger catalogues** (no index in each
  process, no rebuild). Per your rule, that is deferred.
- **v2 ships one shared backend used by both adapters.** Native backends (SQLite FTS5 with our fuzzy layer over
  `fts5vocab`; Atlas Search for Mongo) are listed as future work (§2.13). They are enabled per adapter only once they
  pass the same contract suite.

### 2.5.2 Index
As v1. Normalisation, fields and weights (SKU 10, name 5, category 2, searchable properties 2, description 1),
posting lists, facet bitsets, two views (admin, public), and the public view built from `publicProduct()`.
- 🆕 The admin view carries `deleted` and `variantGroupId` flags.
- 🆕 Each view has its **own dictionary** (distinct tokens with document frequency), used by typo tolerance. The
  public dictionary is built only from public fields (C2).

### 2.5.3 Query
As v1 (AND across words, prefix on the last word, field-weighted score, disjunctive facets, allowlisted sorts,
paging caps), with two changes:
- ✏️ Match factors: exact 1.0, prefix 0.7, typo-corrected 0.4 (details in §2.5.4).
- ✏️ The `price` sort and `min`/`max` filters on the public view use the shopper's price (§2.5.7). The admin view
  uses list prices (the backoffice has no shopper).
- 🆕 `listing: "one"` groups are collapsed **after** ranking: the first hit of each such group is kept and the
  others are counted as `moreVariants: n` on the card.

### 2.5.4 ✏️ Typo tolerance in depth (S-3)

**Goal.** Find "stoneware" when the shopper types `stonewre`, `stoneward`, `stoenware` or `tsoneware` (one edit away), without
producing noise on short words ("mug" should never match "mud") or changing the meaning of numbers and SKUs (`350ml`
≠ `250ml`).

**1. Dictionary.**
- Built with the index, one per view: every distinct normalised token (after NFKD, mark stripping and lower-casing),
  with its document frequency `df`, grouped in **buckets by length** (code points, not UTF-16 units).
- Size at 20k products: typically 20–40k tokens; the cap is 200k tokens (larger catalogues disable typo tolerance
  and log a warning).

**2. When a query word is corrected.** Only if **all** of these hold:

| Condition | Reason |
|---|---|
| the word has **≥ 5 code points** (configurable 4–8, default 5) | short words have too many neighbours ("mug" → mud, mag, rug) |
| it contains **no digit** | sizes, capacities and SKUs must match exactly |
| it is written in a script with word spacing (not Han, Hiragana, Katakana or Hangul) | tokens in those scripts aren't words |
| it is **not** an exact dictionary token | a real word is never "corrected" |
| for the **last** word: no dictionary token starts with it | while typing, "stonew" is a valid prefix, not a typo |

**3. Finding candidates (edit distance 1).**
- Scan the length buckets `len−1`, `len` and `len+1` with a **linear-time check** `withinOne(a, b)`. This is
  Damerau (optimal string alignment) distance ≤ 1, where one of these counts as one edit: substitution, insertion,
  deletion, or swap of two adjacent letters.

```
withinOne(a, b):                       // a, b: arrays of code points, a != b
  if |len(a) − len(b)| > 1: return false
  i = first index where a[i] != b[i] (or min length)
  if len(a) == len(b):
    if a[i+1..] == b[i+1..]: return true                         // substitution  (stonewxre)
    return a[i] == b[i+1] && a[i+1] == b[i] && a[i+2..] == b[i+2..] // transposition (stoenware)
  longer, shorter = (len(a) > len(b)) ? (a, b) : (b, a)
  return longer[i+1..] == shorter[i..]                          // insertion / deletion (stonewre, stonewaare)
```

- Cost: at most about 3 buckets × a few thousand tokens × O(length), well under 2 ms per word. This needs no extra
  memory, unlike a symmetric-delete index, which would store about 10 entries per token. If profiling shows a need,
  a SymSpell delete index can replace the scan behind the same function.
- Distance 2 is **not** used: on product vocabularies it causes too many false matches. So `stonewear` (two
  edits: e→a and a→r) is **not** corrected. This is a deliberate limit, listed in the tests.

**4. Choosing among candidates.** At most **5** per word, ordered by:
1. same first letter first (people rarely mistype the first letter);
2. higher `df` (more common words are more likely what was meant);
3. alphabetical (deterministic).

**5. Matching and ranking.**
- The corrected word matches the union of its candidates' postings, with a factor of **0.4** (exact 1.0, prefix 0.7).
- AND across words is unchanged: `blue stonewre` needs "blue" **and** (stoneware ∪ other candidates).
- Exact results always rank above corrected ones with otherwise equal scores.

**6. Transparency (C-12).**
- If the results exist **only** thanks to corrections, the page says "Showing results for **blue stoneware**" (the
  top candidate per word, escaped).
- If the query with corrections still returns nothing, the normal "Nothing matches" appears.
- In the backoffice, corrected matches get a small "≈" marker.

**7. Limits (C13).**
- At most 3 corrected words per query (the first 3 eligible).
- Query ≤ 10 words and ≤ 100 characters.
- A setting *Typo tolerance: on/off* (default on) and *minimum word length* (default 5).

**8. Privacy (C2).**
- Candidates come from the **view's own dictionary**.
- The public dictionary contains only words from public fields of visible products, so "Showing results for …" can
  never reveal an internal property value or the name of a hidden product.

**9. Tests** (part of the search contract suite):

| Input | Expected |
|---|---|
| `stonewre`, `stonewaare`, `stoenware`, `stonewxre` | stoneware (deletion, insertion, transposition, substitution) |
| `stoneware` | exact, no correction note |
| `stonewear` | two edits: not corrected (deliberate) |
| `stonew` (last word) | prefix, no correction |
| `mugg` | 4 letters: no correction → "Nothing matches" (unless a prefix exists) |
| `350mk` | contains a digit: no correction |
| `céramique` / `ceramiqe` | exact after folding / corrected to ceramique |
| a hidden product's unique word with 1 typo | no results, no "Showing results for" (privacy) |
| 10 long random words | completes under the CPU budget; ≤ 3 corrected |

### 2.5.5 API ✏️
As v1, with these changes:
- `GET /api/products` gains ✏️ `status=visible|hidden|deleted` (default: visible + hidden) and 🆕 `variantGroup=<id>`,
  `inVariantGroup=true`.
- The public `GET /api/shop/search` and the HTML pages: when the price sort or a `min`/`max` filter is used, the
  response becomes **personal** (§2.5.7). Otherwise it stays `public, max-age=60`.

### 2.5.6 Shop rendering ✏️
As v1 (widgets `searchFilters`, `resultsBar`, paging, `productSpecs`, `bundleContents`; templates and "Add filters";
`shop.js` auto-apply; `noindex` and canonical), with these changes:
- ✏️ Result pages sorted or filtered by price add
  `<noscript><p class="os-msg">Sorted by your price. Turn on JavaScript to see it on each product.</p></noscript>`.
- 🆕 `RenderContext.correctedQuery` for "Showing results for …".
- 🆕 The `productVariants` widget (§2.8.4).

### 2.5.7 🆕 Sorting and filtering by the shopper's price (S-2)

**Definition.**
- "Your price" is **exactly** the `priceCents` that `/api/shop/prices` returns for the product and that `shop.js`
  shows on its card. It is the price of one unit for this visitor, with their automatic offers, customer and profile
  prices, and the code and selection in their cart (order offers allocated to the line included, F18).
- Showing one price and sorting by another would look broken, so both use **one function**.

**Implementation.**
1. **Extract `unitPrices(ctx, products)`** from the `/api/shop/prices` handler into `pricing-service.ts`. Both
   `/api/shop/prices` and search call it. A test asserts they return identical values for the same visitor.
2. **`priceCatalogue()` in `packages/pricing`** (pure). For many products, it gives the same result as calling
   `price()` with a one-line, qty-1 cart per product. It is faster because eligibility checks per offer (audience,
   schedule, sign-in, code) are done once, not per product.
   - Verified by a randomised equivalence test: 5,000 random catalogues, offer sets and shoppers give identical
     results to `price()`.
3. **Shopper context key:** `hash(signedIn, customerId, sorted profileIds, cart code, selection, discountsVersion,
   minute bucket for schedules)`.
   - All anonymous visitors without a code share **one** context.
4. **Price map cache:**
   - per context key, `Map<productId, cents>`;
   - TTL 30 s (the same as the pricing candidate cache);
   - LRU of at most 500 contexts;
   - cleared when offers change (`pricing.invalidate()`) or `catalogueVersion` changes;
   - filled **lazily**, only for the products being filtered or sorted.
5. **Shortcuts.** The engine never raises a price (invariant), so your price is always ≤ list price:
   - `max` filter: products with list ≤ max are in without pricing; only list > max need pricing;
   - `min` filter: products with list < min are out without pricing;
   - when no running offer applies to this context, your price = list price and nothing is priced at all.
6. **Sorting:** by your price, then list price, then name, then id (deterministic).
   - Price facet bounds (for the min/max inputs) use your prices too.
7. **Budget:** a cold price map for 20k products in ≤ 150 ms; warm ≤ 5 ms.

**Responses.**
- HTML and JSON that used your price are `Cache-Control: private, no-store` with `Vary: Cookie`.
- Responses without price sort or filter stay `public, max-age=60`, because they don't depend on the visitor.
- Cards in HTML still show **list prices**, and `shop.js` replaces them with the visitor's prices, as today. **No
  discount amounts, labels or offer details enter the HTML** (decision S-2a).

**What a visitor can learn.** Only what `/api/shop/prices` already tells them about their own prices. Anonymous
contexts never include customer or profile offers. See C23.

## 2.6 Bundles ✏️

### 2.6.1 Validation, availability, checkout, storefront
As v1 (2–20 components, simple products only, no nesting; availability `min(floor(stock/qty))`; `offerScope` in the
engine; checkout demand aggregation with sorted atomic decrements and undo; line snapshot with `allocate()`; contents
widget; cart and confirmation "Includes…"), with these changes:
- ✏️ Components may be hidden **or deleted** (L-6). A deleted component is shown in the contents without a link, like
  a hidden one.
- ✏️ Validation refuses **new** references to deleted products. Existing ones stay.
- 🆕 A bundle can be a member of a variant group (V-3).

### 2.6.2 ✏️ Price (B-3)
- **`sum` mode (default):**
  - `price = fromCents(Σ toCents(component.price) × qty)`;
  - **materialised**: recomputed in the same request whenever a component's price changes (API, bulk or import);
  - audited as "price recalculated (component X changed)";
  - the bundles affected are listed in the preview and editor before saving ("This also changes 3 bundles").
- **`manual` mode:**
  - the owner's price is kept when components change;
  - the backoffice always shows:
    - `sumCents`, the original price;
    - `percent = round(price / sum × 100)`;
    - the saving (`sum − price`).
- **Editor behaviour:**
  - the price field shows the sum and a "Sum of products" badge;
  - typing a different value switches to `manual`, and the line "Original price €70.00 · your price €59.00 = 84%
    (−16%)" appears;
  - **"Reset to sum"** switches back to `sum`.
- **Warnings** (not errors), shown in the editor and as list tags:
  - manual price > sum ("more expensive than buying separately");
  - < 50% of the sum;
  - = 0 (must confirm).
  When a component's price change makes a manual bundle more expensive than its parts, the list shows a warning tag.
- **Offers (B-10):**
  - a "Create an offer for this bundle" button opens `/discounts/new?product=<id>`;
  - the offer editor reads `product` (an existing, non-deleted product id) and pre-selects *Product price* with that
    target;
  - `offerScope: "targeted"` means this offer applies to the bundle even though shop-wide offers don't.
- **Shop:** "Save €X compared with buying separately" only when `manual` and price < sum (catalogue data, list
  prices). Offer savings are shown by the existing offers widget and `shop.js`.
- ❌ v1's `percentOffSum` mode, and its `bp` validation and cap.

## 2.7 Import and export ✏️

### 2.7.1 Formats ✏️

| Format | Export | Import |
|---|---|---|
| CSV (`text/csv`): `,` `;` tab, UTF-8 + BOM, decimal `.` (or `,` with `;`) | P1 | P2 |
| JSON catalogue (`application/vnd.openshop.catalogue+json`): `{ format, version: 1, categories, attributes, 🆕 variantGroups, products }` | P1 | P2 |
| PrestaShop CSV (mapping preset) | none | P2 |
| ❌ XLSX, ❌ Google/Meta feed | removed (I-1) | removed |

### 2.7.2 CSV columns ✏️
As v1 (`id`, `sku`, `type`, `name`, `visible`, `price`, `stock`, `category`, `description`, `images`, `attr:<key>`,
`bundle_components`, `bundle_offers`), with these changes:

| Column | Change |
|---|---|
| `bundle_pricing` | ✏️ `sum` (price column ignored and computed; the preview shows the result) or `manual` (price column used) |
| `images` | ✏️ `|`-separated; each item is `/uploads/<hex>.<ext>`, a **server path** (relative to `IMPORT_MEDIA_DIR`), or `https://…` (§2.7.5) |
| `variant_group` | 🆕 The group handle (`^[a-z0-9-]{1,64}$`). Empty = not in a group. A new handle creates the group |
| `variant_by` | 🆕 Differentiator keys, `colour|size`. Must be the same on every row of a group (or given once and empty on the others); conflicting values are an error |
| `variant_position` | 🆕 Optional integer |
| `deleted` | 🆕 Export only (Deleted view, JSON). Ignored on import; restoring uses the L-2 option |

Formula neutralisation and empty-cell rules: as v1.

### 2.7.3 Pipeline ✏️
As v1 (upload ≤ 10 MB → parse → mapping → preview → commit in batches → report; one import at a time; restart
safety; 30-day retention; never stored under `/uploads`), with these changes to the preview and commit:
- 🆕 **Deleted matches:** a row whose id or SKU belongs to a deleted product is an error ("deleted; restore it first")
  unless the option is `restore`. In that case the plan is "restore + update" and the product stays hidden unless
  `visible` says otherwise.
- 🆕 **Variant validation across the file:** rows are grouped by `variant_group` and checked, together with existing
  members not in the file, for V-3 (values present, unique combinations). Conflicting rows are errors with both row
  numbers.
- 🆕 **Order of application:**
  1. simple products;
  2. bundles (pass 2);
  3. variant groups and memberships (pass 3: create or update the group, then set `variantGroupId` per product,
     guarded by `version`).
- 🆕 **Media resolution** (§2.7.5) happens during the **preview** for `/uploads` and server paths, so errors show
  before committing. The files are copied during commit.

### 2.7.4 Export
As v1 (`Accept` negotiation, streamed CSV ≤ 100k rows, full JSON document, `no-store`, sanitised filename). ❌ XLSX.

### 2.7.5 ✏️ Images in imports (I-2)

| Source | Example | Phase | Handling |
|---|---|---|---|
| Existing upload | `/uploads/3f…9a.jpg` | P2 | Must match the existing pattern **and** exist in `UPLOAD_DIR`; kept as is |
| 🆕 Server path | `dune/linen-mug-blue.jpg` | P2 | Resolved inside `IMPORT_MEDIA_DIR` (see below), checked, **copied** to a new random upload name |
| URL | `https://cdn.example/m.jpg` | P6 | Downloaded with SSRF controls (C7). Until P6 it is kept as an external link, with the privacy warning (C8) |

**Server paths: how they work** (security in C20):
- **Opt-in.** `IMPORT_MEDIA_DIR` is set by whoever runs the server (environment variable, like `UPLOAD_DIR`).
  - It can **never** be set from the backoffice. Otherwise any admin could point it at `/`.
  - When unset, server paths are rejected with "Server image folder not configured".
  - The import screen shows the configured folder name (not the full path).
- **Resolution, per path:**
  1. reject if empty, > 1,024 characters, or containing NUL, `\`, a drive letter (`C:`), `//` or a `..` segment;
  2. `resolve(root, path)`, then `realpath()` (follows symlinks); it must equal or start with `realpath(root) + "/"`;
  3. open with `O_RDONLY | O_NOFOLLOW`, then `fstat` **on the open handle**: it must be a regular file (not a
     directory, FIFO, device or socket), ≤ 5 MB;
  4. the extension must be in `png jpg jpeg webp gif`, and the bytes are checked with the same magic-number sniffing
     as `saveUpload` (no SVG);
  5. the file is copied to `UPLOAD_DIR/<random>.<ext>`. The original is never served or referenced.
- **Deduplication:** the SHA-256 of the content; the same file used by several rows (or already imported before,
  through a `media_hashes` collection with id = hash) is stored once.
- **Errors:** every failure for a path gives the **same** message, "Image not found or not allowed: `<path as
  given>`". The import can't be used to probe which files exist outside the folder.
- **Limits:** ≤ 10 images per product; ≤ 2,000 distinct files per import; ≤ 500 MB copied per import; copies run 4
  at a time between batches.

## 2.8 🆕 Variants

### 2.8.1 Model and API
- `VariantGroup` (§2.2): the id is an immutable handle; `differentiators` holds 1–3 keys; `listing` is `all` or `one`.
- Membership is `product.variantGroupId` plus `variantPosition`.

| Method | Path | Behaviour |
|---|---|---|
| GET | `/api/variant-groups/:id` | Group + members (including hidden and deleted, flagged) + their differentiator values |
| POST | `/api/variant-groups` | `{ id?, name, differentiators, listing?, productIds: 2..100 }`. Creates the group and sets membership (see 2.8.2) |
| PATCH | `/api/variant-groups/:id` | `{ version, name?, differentiators?, listing?, add?: ids, remove?: ids, order?: ids }` |
| POST | `/api/variant-groups/:id/variants` | "Add a variant": `{ fromProductId, values: {key: value}, name? }` duplicates as hidden and joins the group |
| DELETE | `/api/variant-groups/:id` | Dissolves the group: clears membership on all members. The products are untouched |

All routes use the strict validator, are audited and bump `catalogueVersion`.

### 2.8.2 Validation and consistency
- **Differentiators:**
  - 1–3 distinct, existing, `public` properties of type `choice`, `number` or `boolean`;
  - `multi` and `text` are not allowed, because a product must have exactly one comparable value.
- **Members:**
  - each must exist, not be deleted, and not be in another group (checked with a guarded update:
    `updateWhere(id, { variantGroupId: null, deletedAt: null }, { set: { variantGroupId } })`);
  - bundles are allowed (decision V-3).
- **Combinations:**
  - every non-deleted member needs a value for each differentiator;
  - the tuple of values must be unique among the non-deleted members;
  - checked on: group create/update; **product PATCH** that changes a differentiator value or the product's
    membership; restore (if it clashes, the product is restored outside the group); import (whole file, §2.7.3).
- **Race protection:**
  - every change that affects a group bumps `group.version` with `updateWhere(groupId, { version: v }, { inc })`
    **after** validating and **before** writing members;
  - a concurrent change gets 409 and the request undoes its own member writes;
  - this keeps two parallel edits from both passing the uniqueness check;
  - as defence in depth, the selector algorithm is deterministic even if duplicates somehow exist, and the backoffice
    shows a warning on the group.
- **Groups with fewer than 2 visible members:** still stored (hidden or deleted members can come back); the shop
  shows no selector.

### 2.8.3 Selector algorithm (pure, `variants.ts`)
Input: the current product P, the group's differentiators `D = [d1…dk]` (k ≤ 3), and the group's **visible** members
`M` (active, not deleted; P is always one of them because its page is shown).

```
for each differentiator d in D (in order):
  values = distinct m.attributes[d] for m in M, ordered by the property's option position
           (numbers ascending; boolean: yes, no)
  for each value v in values:
    if v == P[d]: option = { value v, current: true }                              // rendered as selected, not a link
    else:
      candidates = members m with m[d] == v
      target = best of candidates by, in order:
        1. score = vector over the OTHER differentiators in D order: 1 if m[x] == P[x] else 0
           (compared lexicographically, so keeping d1 matters more than keeping d2)
        2. in stock (available > 0) before sold out
        3. variantPosition, then name, then id                                    // deterministic
      exact = all other differentiators equal P's values
      option = { value v, href: "/shop/product/" + target.id, exact,
                 changes: labels of differentiators where target differs from P,   // "also changes Size"
                 soldOut: target available == 0 }
```

- **Complexity:** ≤ 3 differentiators × ≤ 30 values × ≤ 100 members, a few thousand comparisons per product page
  (≤ 1 ms). Members are loaded with one `find({ variantGroupId })`.
- **Hidden and deleted members** are not in `M`, so their values never appear (C22).
- **Availability** uses live stock (bundles: derived availability).

### 2.8.4 Shop rendering
- `ProductCtx.variants = { differentiators: [{ label, options: [{ label, swatch?, href?, current, exact, changes[], soldOut }] }] }`,
  built in `storefront.ts` from the public projection and public property labels only.
- **Widget `productVariants`:**
  - props `{ style: "buttons" | "swatches", showSoldOut: bool }`, validated in `normProps`;
  - renders one `<fieldset class="os-var"><legend>Colour</legend>…</fieldset>` per differentiator;
  - the current option is `<span aria-current="true">`;
  - other options are `<a href>` with `aria-label="Colour: White"`, plus "(also changes Size)" and "(sold out)"
    visually hidden or shown as hints;
  - swatches use a validated colour in a `style` attribute (the renderer's `safeColor`; text label always present
    for accessibility).
  - No JavaScript needed. The editor shows sample variants.
- Added to the product page template for new shops. Existing shops get "New: variants widget. Add it" in the builder
  (designs are never changed automatically).
- Each variant keeps its own URL and `<link rel="canonical">` (they are separate products).
- Listings: `listing: "one"` collapses in search and category results (§2.5.3). The card shows the representative
  variant and "+N options".

### 2.8.5 Backoffice
- **Product editor, *Variants* section:**
  - not in a group: "Link variants" (choose differentiators → pick products → fill in missing values inline →
    validation messages → save);
  - in a group: a table (product, values, price, stock, visibility, "deleted" tag), drag to reorder, "Remove from
    group", "Change differentiators", "Add a variant" (V-7), "Dissolve group".
- **Product list:** a "N variants" tag, an "In a variant group" filter, and a link to the group.
- **Offer editor picker:** "Add all variants" (V-10), which adds the current members' ids. A note says that variants
  added later aren't included. A "variant group" offer target is possible future work (it would need an engine target
  type).

### 2.8.6 Interplay
- **Search:** members are indexed as normal products; `variantGroupId` is stored for collapsing and admin filters.
- **Bundles:** a component is a specific variant (e.g. the blue mug). A bundle can be a variant.
- **Discounts:** offers target product ids; V-10 covers "all variants".
- **Lifecycle:** §2.3.5. **Import and export:** §2.7.

## 2.9 API summary ✏️

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/products` | admin | ✏️ + `status` (incl. deleted), `variantGroup`, `inVariantGroup`; JSON / CSV / catalogue JSON (❌ XLSX) |
| POST / PATCH | `/api/products[/:id]` | admin | As v1; ✏️ PATCH refuses deleted products |
| DELETE | `/api/products/:id` | admin | ✏️ **Soft delete**, hidden products only, `{ hideBundles? }` |
| GET | `/api/products/:id/delete-impact` | admin | 🆕 |
| POST | `/api/products/:id/restore` | admin | 🆕 |
| POST | `/api/products/bulk` | admin | ✏️ Actions: show, hide, category (no delete) |
| CRUD | `/api/attributes[/:id]` | admin | As v1 (+ option order, swatch) |
| CRUD | `/api/variant-groups[/:id]`, `POST …/variants` | admin | 🆕 |
| … | `/api/catalogue/imports…` | admin | As v1 (+ `deleted`, media options) |
| GET | `/api/shop/products` | public | Public projection |
| GET | `/api/shop/search` | public | ✏️ Personal (`private, no-store`) when price sort or filter is used |
| GET | `/api/shop/prices` | public | ✏️ Now calls the shared `unitPrices()` |
| GET | `/search`, `/shop`, `/shop/category/:slug` | public | ✏️ Same caching rule as `/api/shop/search` |

## 2.10 Migration and compatibility ✏️
As v1, plus:
- 🆕 `deletedAt` absent = not deleted.
- 🆕 Bundles don't exist yet, so there's no `percentOffSum` to migrate.
- 🆕 `DELETE /api/products/:id` changes meaning (soft, hidden-only). The callers are the backoffice, the tests and
  `scripts/seed-demo.py --only`; all are updated in P0.
- 🆕 The offer editor's `?product=` is additive.

## 2.11 Performance budgets ✏️
As v1, plus:

| Operation | Budget |
|---|---|
| 🆕 Cold price map for 20k products (one shopper context) | ≤ 150 ms |
| 🆕 Warm price map | ≤ 5 ms |
| 🆕 Typo correction | ≤ 2 ms per corrected word; ≤ 3 words |
| 🆕 Variant selector | ≤ 1 ms per product page |
| 🆕 Server media copy | ≤ 500 MB per import, 4 parallel |

## 2.12 Testing ✏️
As v1, plus:
- 🆕 **Search contract suite** (`search-contract.ts`), run against every `SearchBackend`:
  - the typo table (§2.5.4);
  - privacy (no hidden words in results, facets or the "Showing results for" line);
  - `listing: "one"` collapse.
- 🆕 **Your price:**
  - `priceCatalogue` ≡ `price()` for one-line carts (5,000 randomised cases);
  - search order equals the order of `/api/shop/prices` values for the same visitor;
  - anonymous and VIP orders differ, and anonymous never reflects VIP offers;
  - the `private, no-store` + `Vary: Cookie` headers are exactly on price-dependent responses;
  - cache invalidation on offer change.
- 🆕 **Lifecycle:**
  - no delete while visible (409);
  - the delete-impact contents;
  - soft delete hides bundles only when asked;
  - a deleted product can't be PATCHed, shown, added to a cart, picked or exported (default view);
  - restore returns it hidden;
  - restore with a clashing variant combination;
  - offers that reference it stay editable (the F5 regression test);
  - no route hard-deletes (route inventory test).
- 🆕 **Bundles pricing:**
  - the sum recomputes on a component change (API and import);
  - manual mode is kept;
  - "Reset to sum";
  - the percentage and warnings in the editor;
  - `?product=` prefill.
- 🆕 **Variants:**
  - validation (missing values, duplicates, wrong property types, internal properties refused);
  - concurrent edits producing a duplicate → one gets 409;
  - the selector table tests (exact, closest with lexicographic priority, sold out, hidden and deleted excluded,
    bundles as variants);
  - widget escaping;
  - import across the file with existing members.
- 🆕 **Server media paths:**
  - `../`, absolute paths outside the folder, symlink escapes (file and directory), NUL, `\`, `C:`, a FIFO,
    `/dev/zero` via symlink, a directory, 6 MB, SVG renamed `.png`, a valid file;
  - identical error messages;
  - the feature is off when `IMPORT_MEDIA_DIR` is unset;
  - deduplication.
- ❌ XLSX tests.

## 2.13 🆕 Future work (deferred on purpose)
- Native `SearchBackend`s (S-1): SQLite FTS5 (+ our typo layer over `fts5vocab`, facets by SQL), MongoDB Atlas Search.
  Enabled per adapter once they pass the search contract. They are worth it above about 50k products or when memory
  per process matters.
- "Variant group" as an offer target (engine target type).
- "On sale" filter (cheap with the price map).
- XLSX and product feeds (I-1).

## 2.14 Phase acceptance criteria ✏️
- **P0:**
  - as v1;
  - 🆕 no route can hard-delete a product;
  - 🆕 the delete → restore cycle works;
  - 🆕 the F5 scenario (offer referencing a deleted product) stays editable.
- **P1:** as v1 + L-4 (the Deleted view) + the search contract suite green.
- **P2:** as v1 + A-9 for `/uploads` and server paths (C20 tests green) + L-2 handling.
- **P3:**
  - as v1 + C-7, C-8 and C-12;
  - "your price" equals the card price in every test;
  - personal responses are never publicly cacheable.
- **P4:** as v1 + B-2 (sum/manual/reset/%) + B-10.
- **P5:**
  - V-1 to V-11;
  - works without JavaScript;
  - no hidden variant value ever appears in the shop.
- **P6:** the chosen extras.

---

# 3. Security ✏️

Each item gives the requirement, the reason and the verification, as in v1. Items not mentioned here are unchanged
from v1. The discounts plan's S1–S18 and its known limitations still apply.

**C1. Data minimisation on public endpoints.** As v1. ✏️ The allowlist also excludes `deletedAt`, `deletedBy`,
`variantPosition`, internal group names and bundle pricing mode.

**C2. Search must not be an oracle for hidden data.** As v1. ✏️ This also covers:
- **typo corrections:** "Showing results for …" candidates come only from the public dictionary, built from public
  fields of visible products;
- **variant collapsing:** `+N options` counts only visible members.
- **Verified by:** oracle tests with one-typo versions of hidden words.

**C3. Authorization.** As v1. ✏️ The exhaustive 401 list adds `delete-impact`, `restore`, `variant-groups/*` and the
import media options.

**C4. Strict input validation.** As v1. ✏️ This also covers:
- variant group handles (`^[a-z0-9-]{1,64}$`);
- differentiator keys, which must be existing public single-value properties;
- `values` in "Add a variant", which go through the same attribute validation;
- `?product=` in the offer editor, which must be an existing, non-deleted product id (ignored otherwise).

**C5. Stored XSS through imported content.** As v1. ✏️ The payload fixture also covers variant option labels,
swatches (`red;background:url(…)` is rejected by `safeColor`), group names and media paths echoed in the report.

**C6. Spreadsheet formula injection.** As v1. ❌ XLSX item removed.

**C7. SSRF for image URLs (P6).** As v1.

**C8. Privacy of hotlinked images.** As v1 (until P6).

**C9. Integrity under concurrency.** As v1. ✏️ This also covers:
- **lifecycle:** guarded updates, so a deleted product can't be edited or re-shown by a racing request, and a
  visible product can't be deleted by a race with "show";
- **variants:** group version bump with undo, so two concurrent edits can't both pass the uniqueness check;
- **sum-priced bundles:** recomputed inside the request that changes the component.

**C10. Money integrity.** As v1. ✏️
- `percentOffSum` ❌ is removed.
- Manual bundle prices are bounded like any price; price 0 needs confirmation.
- Sum mode is computed only on the server.
- 🆕 `priceCatalogue` must equal `price()` (equivalence test), so the sort never uses a price different from the one
  charged and shown.

**C11. Safety of bulk changes.** As v1. ✏️ This also covers:
- delete is never a bulk action;
- delete needs hidden status plus the confirmation page;
- import can't delete, and restores only with an explicit option.

**C12. Audit.** As v1. ✏️ This also covers:
- hide, soft delete (with the impact shown and the bundles hidden), restore;
- variant group changes and "Add a variant";
- automatic bundle price recalculations;
- media copies (source path, hash, new name).

**C13. Denial of service.** As v1. ✏️ This also covers:
- typo correction caps (§2.5.4);
- price map caches (≤ 500 contexts, TTL, lazy, ≤ 20k entries each);
- variant group caps (≤ 100 members, 3 differentiators, 30 values);
- media caps (≤ 2,000 files, 500 MB, 5 MB each, 4 parallel);
- `delete-impact` lists capped at 200 items each, with counts.

**C14. Confidentiality of exports and import files.** As v1. ✏️ This also covers:
- deleted products are excluded from default exports;
- **the server media folder's absolute path is never shown** in the backoffice or error messages, only the paths as
  the owner typed them.

**C15. Bundle business-logic abuse.** As v1. ✏️ Deleted components behave like hidden ones: never addable on their
own (`active:false`); only via bundles, and only if the bundle stays on sale (L-1).

**C16. Output, caching and SEO.** ✏️
- As v1, **except** for caching.
- Result pages are publicly cacheable **only** when no price sort or filter is used.
- Otherwise they are `private, no-store, Vary: Cookie` (see C23).
- The test "signed-in and anonymous HTML are identical" now applies to non-price queries only. For price queries the
  test checks the headers instead.

**C17. Injection into the data layer.** As v1.

**C18. Dependencies.** ✏️ **No new runtime dependencies in any phase:**
- XLSX is removed;
- the CSV parser, search, typo tolerance, media checks and selector are in-house;
- `node:fs` and `node:crypto` cover media handling.

**C19. CSRF.** As v1 (the new routes are admin bearer-only; the public ones are GET).

**🆕 C20. Server file paths in imports (I-2).**
- **Requirement:**
  - The feature is off unless `IMPORT_MEDIA_DIR` is set by the server operator (environment). It is never
    configurable through the API or the backoffice.
  - Paths are resolved inside that folder only:
    - syntactic rejects (`..`, NUL, `\`, drive letters, `//`, > 1,024 characters);
    - `realpath` containment check;
    - open with `O_NOFOLLOW`, then `fstat` on the **handle**: a regular file ≤ 5 MB;
    - extension allowlist and magic-byte sniffing, no SVG.
  - Files are **copied** to a new random name in `UPLOAD_DIR`. Nothing is served from the media folder.
  - All failures give one generic message, so there is no file-existence oracle.
  - Caps as in C13. Every copy is audited.
  - **Residual risk (documented):** someone who can write to the media folder can swap path components between the
    check and the open (TOCTOU on intermediate directories). The containment check on the final real path plus
    `O_NOFOLLOW` limits this to files the operator put under that folder. Operators should keep the folder writable
    only by the people who upload import images.
- **Reason:** without these rules, any admin, or anyone holding a stolen admin token (F16), could read arbitrary
  server files (`/etc/passwd`, `.env` with `AUTH_SECRET`, the database file) by importing them as "images". Even with
  sniffing, error messages could reveal which files exist.
- **Verified by:** the C20 test list in §2.12.

**🆕 C21. Variant integrity.**
- **Requirement:**
  - Differentiators must be public single-value properties.
  - Combinations are unique among non-deleted members, enforced on every write path (API, import, restore) with the
    group version guard.
  - The selector is deterministic and built only from server data. Links are `/shop/product/<id>` built by the
    server and passed through `safeUrl`.
  - Group handles are validated. Membership is changed only through guarded updates.

**🆕 C22. Variants must not reveal hidden products.**
- **Requirement:**
  - The selector, "+N options" counts and collapsed listings use **visible members only**.
  - Values that exist only on hidden or deleted members are never rendered.
  - A hidden product's page stays 404 even if it is in a group.
  - Internal properties can never be differentiators (refused on save, and a property can't become internal while
    used).
- **Reason:** linking products must not leak what the owner has hidden, such as unreleased colours.
- **Verified by:** snapshot tests with hidden members carrying unique values.

**🆕 C23. Personal ordering by the shopper's price (S-2, S-2a).**
- **Requirement:**
  - Price sorting and filtering use only the visitor's own context: session, profiles, the cart's code. These are
    the same inputs as `/api/shop/prices` (one shared function).
  - Such responses (HTML and JSON) are `Cache-Control: private, no-store` with `Vary: Cookie`. Responses that don't
    use prices remain publicly cacheable.
  - Price map caches are keyed by the full context (including `discountsVersion`). Anonymous contexts never include
    customer or profile offers. A cached map is never reused for another context.
  - HTML still contains **no** discount amounts, labels, sources or offer ids. Only the *order and membership* of
    results depend on the visitor's prices.
  - The price filter reveals nothing beyond what the visitor's own `/api/shop/prices` already shows.
- **Reason:**
  - a shared cache (CDN or proxy) holding a VIP's sorted page could be served to others;
  - a mis-keyed in-process cache could let one customer's prices shape another's results;
  - this refines the discounts plan's "no discount data in HTML" rule, and the owner must accept it (S-2a).
- **Verified by:**
  - header tests;
  - VIP vs anonymous vs other-customer tests (each sees only their own order);
  - a cache key test (changing any context part changes the key);
  - an HTML scan (no offer labels or ids in price-sorted pages).

**🆕 C24. Product lifecycle integrity (S-4).**
- **Requirement:**
  - There is no hard delete anywhere. A route inventory test fails if any handler calls `db.products.delete`.
  - `deletedAt ⇒ active:false` is enforced by `normalizeProduct` and by guarded updates.
  - Delete requires hidden status (409 otherwise).
  - Restore returns the product hidden.
  - Deleted products are excluded from the public index, pickers and default exports, but remain resolvable for
    references (offers, bundles, orders, variant groups).
  - Every lifecycle step is audited with the user and the impact.
  - Import can't delete, and restores only with the explicit option.
- **Reason:**
  - the owner's rule (never lose a product);
  - it fixes the dangling references of F5;
  - it makes mistakes recoverable.
- **Verified by:** the lifecycle tests in §2.12.

---

## Appendix: Effort summary ✏️

| Phase | v1 | v2 |
|---|---|---|
| P0 Foundations (+ lifecycle) | 4–5 | 5–6 |
| P1 Model, backoffice search, export (+ search contract, deleted view) | 8–10 | 9–11 |
| P2 Import (+ server media, deleted matching) | 8–10 | 9–11 |
| P3 Shop search (+ your-price sorting/filtering) | 6–8 | 9–11 |
| P4 Bundles (sum/manual, offer shortcut) | 8–10 | 7–9 |
| P5 🆕 Variants | none | 7–9 |
| P6 Extras (− XLSX, − feeds) | 7–9 (was P5) | 4–6 |
| **Total** | **41–52** | **50–63** |

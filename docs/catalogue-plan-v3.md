# OpenShop catalogue: import/export, bundles, variants and search. Implementation plan (v3)

Status: **v3, implemented (P0–P5)**, see "Implementation status" below. It replaces `docs/catalogue-plan-v2.md` (v1 and v2 are kept for
comparison). v3 rewrites **product variants** to follow the owner's example, and records the owner's answers to the
open decisions of v2.

## Implementation status

P0–P5 are **implemented** on branch `feature/catalogue`, one commit per phase. From P6, photo downloads, search
suggestions and the "no results" report are implemented; import revert is not.

| Phase | Status |
|---|---|
| P0 Foundations | Done. SQLite `update` is one statement (lost-update contract test on both adapters). The public product projection is an allowlist. `normalizeProduct` validates all product writes (cents, bounds, SKU, properties, bundles). Writes are versioned and audited. There is a catalogue version and one re-render per change. Lifecycle: hide → delete (soft, with a decision per bundle, enforced by the API) → restore; no route can remove a product (a test scans the code). |
| P1 Model, backoffice search, export | Done. SKUs (unique, case-insensitive, reserved by deleted products). Properties (types, option order, swatches, internal/public, usage rules). The in-process search backend has admin and public views, typo tolerance as §2.5.4, and disjunctive counts. `GET /api/products` does search, filters, counts, paging and lookups by id. CSV and JSON export use the same URL. Backoffice: Products screen (filters in the URL, bulk actions, export, "Deleted products"), delete confirmation page, Properties screen, typeahead pickers everywhere products were loaded in full. |
| P2 Import | Done. CSV/JSON. Mapping with automatic detection and the PrestaShop preset. New properties (type guessed, created internal). Preview with a diff, warnings and problems. Per-row choices for deleted matches. Commit in the background with version and stock guards, one import at a time, resume after a restart. Error report as CSV. Images from `/uploads`, from `IMPORT_MEDIA_DIR` (C20), or `https://` links. Import wizard in the backoffice. |
| P3 Shop search and filters | Done. `/search`, `/shop`, `/shop/category/:slug` have filters with counts, chips, sort, paging, GET forms (no JS needed), `noindex` and canonical, cache headers and per-IP rate limits. Sorting and filtering by price use the visitor's own prices through `/api/shop/search` (S-2a); HTML is the same for everyone. Builder widgets: Filters, Results bar, paging, Product details, Bundle contents, In bundles, Variants, with an "Add them" offer for older essential pages. |
| P4 Bundles | Done. Sum or manual price (kept up to date, audited). Availability derived from components. Engine `offerScope` (line and order phases, in the 5,000-cart invariant test). Checkout adds up demand per component and decrements atomically in sorted order with undo. Order snapshots list the contents with price shares. Cart, confirmation and backoffice orders show "Includes…". "Create an offer for this bundle". |
| P5 Variants | Done. Groups with inferred values; 1–5 public single-value differentiators; "-" for missing values (V-7). Duplicates are refused on every path (link, add, add a variant, product edit, unticking a property, restore, import), with a group-version guard against races. The selector is exact single-change (your example, §2.8.7, is a test checked cell by cell on real product pages). Warnings for useless and unreachable variants. Backoffice "Link as variants" dialog with a live preview, Variants panel, "+ all variants" in pickers. |
| P6 Extras | **Partly done.** `https://` photos in imports are downloaded and stored (C7: https on port 443, host names only, every resolved address must be public, pinned connections, every redirect checked again, time and size limits, magic bytes; the preview reads only the first bytes and remembers the answers; "keep as links" is an option). Suggestions while typing in every search box (6 products, 3 categories, an accessible combobox, public data only, cacheable, own rate limit). "Shop searches that found nothing" in Insights (per day, no personal data, capped, 90 days, "finds now", CSV). Import revert is not done. |

**Checks**
- Unit tests: db 21, pricing 35, renderer 28, api 126, backoffice 122. All pass, and `npm run typecheck` is clean.
- Browser tests (Chromium, real CSP):
  - the existing `e2e-storefront.py` passes;
  - the existing `e2e-backoffice.py` passes (updated for the product pickers);
  - the new `e2e-catalogue.py` passes: filters with and without JS, a VIP's own price order, typo search, clicking through your variant example, buying a bundle, import, delete and restore, linking variants.
  - No console errors and no CSP violations in any of them.
- Bugs found and fixed along the way:
  - existing: F1 (public product data leak), F2 (lost stock updates on SQLite), F5 (offers uneditable after deleting a product);
  - new ones found by the browser tests: the storefront's `hidden` Apply buttons stayed visible because of the theme's button style; the import wizard's "new property" option for `attr:` columns selected nothing.
  - found while writing the manual test guide (`docs/test-guide.md`), all fixed with a test:
    - number filters showed the unit twice ("350 ml ml"), and backoffice number values weren't in numeric order;
    - "In a variant group" had no count;
    - `350ml` didn't find "350 ml";
    - variant values moved when a product was hidden;
    - an unreadable price gave two messages;
    - update-only imports reported "name is required" for unknown SKUs;
    - rows waiting for a decision about a deleted product were also shown as errors ("SKU already used");
    - PrestaShop `<script>` contents ended up as text;
    - the preview showed category ids and "(details)" instead of names and per-property changes, and didn't show joining a variant group;
    - a new group was named after whichever row came first;
    - a full JSON backup lost deleted products, product ids and bundle components without SKU when restored into another shop;
    - the upload and import size hints were fixed text instead of the server's configured limits.

**Measured performance** (synthetic catalogue of 20,000 products with 30-word descriptions):

| Measure | Result | Budget |
|---|---|---|
| Search queries with counts | 26–67 ms | ≤ 50 ms admin, ≤ 120 ms shop page |
| Index rebuild, 20,000 products | about 1.2 s | ≤ 500 ms (over budget; see below) |
| Index rebuild, 1,000 products | about 50 ms | — |
| Import preview, 5,000 rows | 0.7 s | — |
| Import commit, 5,000 new products | 1.3 s | — |
| Import commit, 5,000 updates | 2.0 s | — |

The rebuild is over budget. So above 5,000 products, shop searches keep the previous index while the new one builds in the background (at most a few seconds behind); the backoffice always waits, so the owner sees their own edits at once.

**Deviations from the plan (minor)**
- `priceCatalogue()` (an optimised engine run for many products) wasn't needed. Search uses the same per-product function as the price cards, cached per visitor context for 30 s. This also guarantees the sort and the cards agree.
- Bulk actions take a selection of up to 1,000 products. Bulk actions over "all products matching a filter" are not done.
- Order snapshots give each bundle component's share of **one** bundle's price.
- New properties from a file are internal (C25), except those that tell variants apart. Owner answer to Q-2 (option C): the preview lists them, with "public in the file" for backups, and the owner ticks the ones to make public; ticked backup properties come back with their settings from the file (filter, search, product page, unit, swatches).
- Owner answer to Q-3: a bundle that only takes its own offers still counts towards an offer's minimums (order value, quantity); it is never discounted by that offer.
- "-" (no value) is always the last value of a variant choice.
- A JSON backup restored into another shop keeps product ids (OpenShop UUIDs only), so links and bundle references survive; products deleted in the file are added to Deleted products. A file never deletes a live product (I-4).

**Open items: not done, or minor topics to discuss later**
1. P6: import revert (A-8).
2. Faster index updates for very large catalogues: incremental updates, or the native backends of §2.13.
3. ~~Variant value order?~~ Decided: a switch per property (default "as in the products"; "as in the property" for choice properties; A→Z), "-" always last (built). The switch is planned in "Next work session" below.
4. ~~Property visibility when restoring a backup?~~ Decided: option C (choose per property in the preview), built.
5. ~~Same visibility rule for created and imported products?~~ Decided: visible by default in both; the import option and a `visible` column can say otherwise.
6. ~~Out-of-stock bundles in "As seen in these bundles"?~~ Decided: keep them, marked as such.
7. Without JavaScript, "Show all" for long filter lists relies on CSS `:has` (all current browsers). Older browsers show every value.
8. Cancelling an order still doesn't restock (unchanged for all orders, bundles included).
9. The Mongo adapter passes the contract on the in-memory stand-in; no real MongoDB server was available here. The Angular CLI needs Node ≥ 22.22.3, so the backoffice tests ran on a local Node 24.
10. ~~Do bundles count towards order minimums?~~ Decided: yes, built.
11. ~~Variants that differ from every other variant in two or more properties can't be reached?~~ Decided: nearest-match links plus a collapsed "See all versions" list. Planned in "Next work session" below.

## Next work session (future work)

The core is stable and committed. These are the topics left for the next session, in a suggested order. Items 1 and
2 are decided by the owner; the rest are open items from this plan, known limitations, and observations from testing.

**1. Variant value order: a switch per property (owner decision on Q-1)**
- Each differentiator gets `order: "products" | "property" | "sorted"`. The default stays "products" (first appearance
  in the group's product order, hidden members included). "property" follows the option order set in Properties, for
  choice properties only (the API refuses it for other types). "sorted" is natural A→Z (numbers as numbers).
- "-" (no value) stays last in every order (already built).
- Where: `Differentiator` in `variants.ts` (the selector sorts by option `position` for "property"), validation in
  `variant-routes.ts` and in imports (JSON `variantGroups`), a select per property in the "Link as variants" /
  "Change properties" dialog with a live preview, export/import of the order in JSON backups.
- Tests: the three orders on a choice and a text property; "property" refused for text; editing a product's value
  never moves the values in "property" order; the Sizes S/M/L/XL example.
- Test guide: update VA-19, add a test per order.

**2. Every variant reachable: nearest match + "See all versions" (owner decision on Q-4)**
- **Nearest match.** Single-change links stay as they are. For a value with no single-change product, the badge links
  to the closest visible member that has that value: fewest other properties changed; ties keep the earlier
  properties (differentiator order), then the group's product order. Deterministic and computed on the server, so it
  works without JavaScript.
  - Badge state `near` with `changes: { label, value }[]`. Rendered as a link styled differently from exact links,
    with the changes spelled out for everyone (e.g. "also changes Size to 20": a tooltip plus screen-reader text).
  - Disabled badges remain only where no visible product has the value (cannot happen for values taken from visible
    products, so in practice none).
  - C22 still holds: only visible members are candidates.
- **"See all versions".** A collapsed `<details>` under the selector lists every visible member with its values and a
  link (no JavaScript needed). An option on the Variants widget: show it always, only when some variant is otherwise
  unreachable (default), or never.
- **Backoffice.** The "unreachable" warning is recomputed with near links; it remains only when a product still
  can't be reached; the preview in the dialog shows near links.
- **Tests.** Your example table (§2.8.7) extended with the near links (e.g. product 1: Male → product 7, "also
  changes Size to 20"; product 7: Black → product 8), tie-breaking, hidden members never chosen, no-JS rendering,
  accessibility labels.

**3. Open items of this plan**
- Import revert (A-8): undo an applied import from its audit trail (products it created are hidden and deleted, updated
  fields restored when they haven't changed since), with a preview like the import's.
- Faster index updates for very large catalogues: incremental updates, then the native backends of §2.13.
- Bulk actions on "all products matching a filter" (today: a selection of up to 1,000).
- Restocking when an order is cancelled (all orders, bundles included).
- Run the DataStore contract against a real MongoDB server (only the in-memory stand-in was available).
- C8: an optional "self-hosted photos only" setting (refuse `https://` links in the editor and in imports).
- C10: ask for confirmation when a simple product is saved with a price of 0 (bundles already ask; imports warn).
- Without JavaScript, "Show all" in long filter lists relies on CSS `:has`; add a fallback for older browsers.

**4. Known security limitations to address**
- Rate limits are per server process and keyed by `req.ip`: set Fastify `trustProxy` when behind a proxy (document it,
  make it configurable), and move the limits to a shared store when running several servers.
- Storefront forms (cart, checkout, sign-in) rely on `SameSite=Lax` cookies: add an Origin/Referer check as
  defence in depth.
- C20 residual risk: someone who can write to `IMPORT_MEDIA_DIR` could swap a file between the check and the copy.
  Document the folder's required permissions; consider opening relative to a directory handle when Node allows it.
- The backoffice keeps its sign-in token in `localStorage`: consider an HttpOnly cookie with a CSRF token.
- C3: roles and permissions (a `can()` hook in the admin scope) are not built; there is one admin role.
- Customer cookies are `Secure`: document that shops must be served over HTTPS (plain http works only on localhost).

**5. Observations from testing**
- The "You may also like" grid on product pages can list the product being viewed (existing behaviour: the grid is
  the same for every product).
- The backoffice Pages spec once timed out (5 s) on a busy machine: raise its timeout or make it lighter.
- `e2e-storefront.py` doesn't exercise the suggestion code (its shop.js coverage went from 87% to 75%); the
  suggestions are covered by `e2e-catalogue.py`. Add them to the storefront run's coverage.
- Photo downloads were tested against a local HTTPS server only (no internet here): try IM-18…21 on a machine with
  internet access.

**How changes are marked in this document (compared with v2)**

| Marker | Meaning |
|---|---|
| 🆕 | New in v3 |
| ✏️ | Changed from v2 (what changed is said next to it) |
| ❌ | Removed from v2 |
| (no marker) | Unchanged from v2 |

---

## What changed since v2 (summary)

| # | Owner input | Effect on the plan | Where |
|---|---|---|---|
| 1 | ✏️ **Variants didn't match the request.** The owner links products and ticks the properties that identify a variant. **Values are inferred** from the products (no value lists to type). The shop shows **every value** of each property; a value is a link only if **changing that single property** leads to a product, otherwise it is **disabled** | Variants rewritten: values inferred from products; differentiators can be any single-value property (text too); up to 5 differentiators; value order follows the products; the "closest product" logic ❌ is removed; the selector is now exact-match or disabled. Your example is the acceptance test (§2.8.7) | §1.6, §2.8 |
| 2 | 🆕 "If a shop owner tries to add a variant where all properties match another product, an alert is thrown and the product is never added" | A duplicate check on **every** path (link, add a variant, edit a property, change differentiators, restore, import). It is validated before anything is written; a conflict produces an alert naming the other product; nothing is saved | V-3, §2.8.3 |
| 3 | ✏️ V-1: one property per line, one inline badge per value | This is the selector layout (product page). Whether lists should show one card per variant is asked again (V-6) | §2.8.5 |
| 4 | ✏️ V-2: disabled | No "closest product" links. A disabled badge stays visible but isn't clickable | §2.8.4 |
| 5 | ✏️ V-3: bundles can't be variants. 🆕 Product pages can show **"As seen in these bundles"** | Bundles are refused as group members. A new widget `productBundles` and story B-11 | B-11, §2.6.4 |
| 6 | ✏️ L-1: the owner is alerted and **decides** per bundle | The delete confirmation now **requires** a choice for each bundle ("keep selling" or "hide the bundle"). The API refuses the delete until every bundle has a decision | L-2, L-6, §2.3.5 |
| 7 | ✏️ L-2: restore it, **or still create it as a new product** | Import rows matching a deleted product: *restore and update*, *create as new product* (the SKU moves to the new product), or *skip*. The owner must decide before committing | A-4, §2.7.3 |
| 8 | Server file paths (C20) | **Approved** as proposed | C20 |
| 9 | 🆕 (follows from "I loaded the products, so these can be inferred") | Import can **create missing properties** from columns (type inferred; created as *internal* until the owner publishes them) and **add new values** to choice properties | A-11, §2.7.6, C25 |

**Two things to confirm:**
1. **Your example has two values that contradict the single-change rule.** The table below shows them. v3 follows
   the **rule**; please confirm.
2. **S-2a from v2 is still open:** price sorting means result pages can be ordered by the visitor's own prices
   (private, never cached). See §1.9.

### 🆕 Your example, checked against the rule

Products: P1 White·10·Female·10º, P2 Black·10·Female·10º, P3 White·20·Female·10º, P4 White·30·Female·10º,
P5 White·10·Female·30º, P6 Black·10·Female·30º, P7 White·20·Male·10º.

| Page | Property | Your expectation | Rule result | |
|---|---|---|---|---|
| P1 | Colors | White (selected); Black | White (selected); Black → P2 | ✔ |
| P1 | Size | 10 (selected); 20; 30 | 10 (selected); 20 → P3; 30 → P4 | ✔ |
| P1 | Gender | Female (selected); Male (disabled) | Female (selected); Male (disabled) | ✔ |
| P1 | Temperature | 10º (selected); **30º (disabled)** | 10º (selected); **30º → P5** | ⚠ P5 is P1 with only the temperature changed |
| P3 | Colors | White (selected); **Black** | White (selected); **Black (disabled)** | ⚠ no product is Black·20·Female·10º |
| P3 | Size | 10; 20 (selected); 30 | 10 → P1; 20 (selected); 30 → P4 | ✔ |
| P3 | Gender | Female (selected); Male (enabled) | Female (selected); Male → P7 | ✔ |
| P3 | Temperature | 10º (selected); 30º (disabled) | 10º (selected); 30º (disabled) | ✔ |

"I select 20º – I get sent to product 3" is read as **Size 20**, because there is no 20º temperature.

**Effort:** v2 was 50–63 days. v3 is **52–65 days** (P0–P5 without extras: 48–59). The additions are property
inference in import (+1), the "As seen in these bundles" widget (+1) and the deleted-product choices in import
(+0.5). The simpler selector (no closest match) balances the wider value types in variants. See §1.10.

### 🆕 Final answers (recorded when implementation started)

| # | Decision | Effect |
|---|---|---|
| V-4 | **Follow the rule** ("the data in the example may have been mistaken") | §2.8.7 is the acceptance fixture as computed |
| V-6 | **Every variant is its own card** in lists | No collapsing |
| V-7 | **A missing value is shown as "-"** (not refused) | "-" is treated as a value of its own: it appears as a badge, takes part in single-change links, and two products that both lack a value (and match on the rest) are duplicates. V-4's "missing value" alert becomes the display rule |
| S-2a | **Price sorting and filtering by the shopper's price come from JavaScript**, loaded live from the API. Pages that might be cached never contain personal ordering | The server renders search and category pages with **list prices** (order and price filter), cacheable as before. When the visitor sorts or filters by price, `shop.js` asks `/api/shop/search` (private, no-store) for the visitor's order and replaces the result grid. Without JavaScript, the list-price order is used and a note explains this. The "no discount data in HTML" rule stays exactly as it was |

---

## 0. How the current code shapes this plan

✅ means confirmed by a probe against the current code. Baseline `npm test` passes (db 19, pricing 33, renderer 23,
api 53).

| # | Finding | Where | Consequence |
|---|---|---|---|
| F1 | ✅ `GET /api/shop/products` (public) returns the raw product document; any internal field leaks | `app.ts` | **Blocker.** Allowlist projection before any new field (C1) |
| F2 | ✅ SQLite `update()` is read-modify-write across an `await`: a concurrent stock decrement is lost | `packages/db/src/sqlite.ts` | Single-statement fix in P0 with a contract test |
| F3 | No SKU, attributes, `version`, timestamps or product audit | `types.ts`, `app.ts` | New fields; product writes audited |
| F4 | ✅ Prices accept `10.129` and `1e300` | `productProps` | Cents-precise validation with bounds |
| F5 | ✅ Deleting a product referenced by an offer makes the offer uneditable | `DELETE /api/products/:id`, `checkRefs` | Solved by soft delete (§2.3.5) |
| F6 | `DataStore.Filter` has no text search, OR, array-contains or aggregation | `packages/db` | Search has its own backend (§2.5) |
| F7 | Every screen loads the whole catalogue | backoffice, `storefront.ts` | Paged server search and typeahead pickers |
| F8 | Shop search is a substring scan, with no ranking, filters or accent handling | `storefront.ts` | Replaced (§2.5) |
| F9 | `rerenderDynamicPages()` runs after every product write | `pages.ts` | Once per request or import batch |
| F10 | ✅ Global 1 MB body limit; `text/csv` gets 415 | `app.ts` | Route-scoped parser and limit for import |
| F11 | CSV convention exists (`Accept`, `csvCell` neutralises formulas) | `negotiate.ts` | Export = a representation of the search URL; import reverses the `'` prefix |
| F12 | Engine is line-based; one `matches()` for line and order phases; `allocate()` exists | `packages/pricing` | A bundle is one line; `offerScope` in `matches()` |
| F13 | `placeOrder` decrements stock per line with `updateWhere` + undo inside `locked()`; cancel doesn't restock | `orders.ts` | Bundles decrement their components |
| F14 | System pages render per request; `renderer/model.ts` is the trust boundary; discount data must never be in HTML | `renderer`, `pages.ts` | New widgets validated in `normProps`; the HTML rule is refined for price sorting (§2.5.7) |
| F15 | Images accept any `https://` URL; the CSP allows `img-src https:` | `productProps`, `PAGE_CSP` | Hotlinking privacy and SSRF (C7, C8) |
| F16 | One admin role; the bearer token is in `localStorage` | `auth.ts`, backoffice | Imported strings must stay inert (C5) |
| F17 | ✅ `node:sqlite` has FTS5 (prefix works; `stonewre` finds nothing) but not `spellfix1` | `node:sqlite` | A native SQLite search can't do typo tolerance without our own code (§2.5.1) |
| F18 | `/api/shop/prices` computes "your price" as a one-line qty-1 cart, including order offers and the cart's code; the offer editor can't be pre-filled | `shop-api.ts`, `discounts/editor.ts` | Price sort reuses exactly this; the editor gains `?product=` |

---

# 1. Business user stories

## 1.1 Goals and personas
- The **owner** onboards a catalogue, sells kits and gift sets, links variants and finds products quickly.
- The **shopper** narrows results and switches between variants (colour, size…).

## 1.2 Foundation and product lifecycle stories

| ID | Story | Acceptance criteria |
|---|---|---|
| F-1 | As an owner I give products a **SKU** | Optional, unique (case-insensitive), `A–Z a–z 0–9 . _ -`, 1–64. SKUs of deleted products stay reserved (except when L-2 "create as new" moves them) |
| F-2 | As an owner I define **properties** and fill them per product | Types: text, single choice, multiple choice, number (unit), yes/no. Flags: shown on product page, filterable, searchable, internal. Choice options have an order and an optional colour swatch. ✏️ Properties can also be **created by an import** (A-11) |
| F-4 | As an owner I see who changed a product and when | Create, update, hide, delete, restore and import are audited with before/after |
| L-1 | A **visible** product can only be **hidden** | No delete action while visible |
| ✏️ L-2 | I delete a **hidden** product after confirming and **deciding** | The "Delete" button appears only when hidden and opens a confirmation page. **An alert lists every bundle containing the product, and for each one I must choose "Keep selling it with this product" or "Hide the bundle"** (no pre-selected answer; "Delete" stays disabled until each bundle has a choice; each bundle has an "Open bundle" link to change its contents instead). The page also shows the variant group effect (🆕 "Leaves the variant group *Trail Jacket*; the value *Male* will no longer be shown"), the offers that name it, and unshipped orders containing it |
| L-3 | A deleted product stays visible wherever it is referenced | Bundles, offers, orders and variant groups keep showing it (marked "deleted" in the backoffice). It disappears from the product list, pickers, default exports and the shop |
| L-4 | I find and **restore** deleted products | A discreet "Deleted products (N)" link; restore brings a product back as **hidden**. ✏️ If it would duplicate a variant in its group, the restore alerts and restores it **outside** the group |
| L-5 | Nothing ever hard-deletes a product | No API, import or bulk action removes a product record |
| ✏️ L-6 | A bundle that keeps a deleted component | Only if the owner chose "Keep selling" (L-2). The bundle then shows a persistent "contains a deleted product" alert in the list and editor |

## 1.3 Epic A: Import and export

| ID | Story | Acceptance criteria |
|---|---|---|
| A-1 | Export the product list to CSV | Exports the current search or everything; UTF-8 + BOM; `,` or `;`; formula-safe; deleted products only from the Deleted view |
| A-2 | Full backup as JSON, importable into another OpenShop | Categories, properties, bundles, variant groups, products (deleted ones flagged) |
| A-3 | Import CSV or JSON: mapping → preview → confirm | Nothing is written before confirming |
| ✏️ A-4 | Import options | Modes *create and update*, *update only*, *create only*; missing products *leave* or *hide*; **never delete**; empty cells *leave* or *clear*; stock *set* or *skip*. ✏️ **Rows matching a deleted product** (by id or SKU) appear in a "Matches deleted products" tab of the preview. For each row, or for all at once, the owner picks **Restore and update**, **Create as a new product**, or **Skip**. Commit is blocked until every such row has a choice |
| A-5 | Understandable error report (CSV) | Row, column, plain-language message |
| A-6 | PrestaShop CSV preset | Column mapping preset |
| A-7 | Risk warnings before confirming | Big price changes, price 0, more than 20 products becoming visible, stock sold since the preview, new categories, restores. ✏️ **Variant duplicates** are errors (V-3), not warnings |
| A-8 | Revert the last import (P6) | Within 7 days |
| A-9 | Import photos | `/uploads/…` (must exist), a **server path** inside `IMPORT_MEDIA_DIR` (checked and copied), or `https://` (downloaded in P6; until then kept as an external link, with a warning) |
| 🆕 A-11 | As an owner, **properties are inferred** from my file | Columns mapped to "New property" (or `attr:<Name>` headers for unknown properties) create properties. The type is inferred (all numbers → number; yes/no → yes/no; otherwise text) and can be changed in the mapping step. New properties are created **internal** (not shown in the shop) until I publish them. New values for choice properties are added to the property (listed in the preview) |

## 1.4 Epic B: Product bundles

| ID | Story | Acceptance criteria |
|---|---|---|
| B-1 | Create a bundle from existing products | 2–20 components, qty 1–99, no nested bundles |
| B-2 | Bundle price | Default = sum of components (updates automatically); manual override shows "Original price €70.00 · your price €59.00 = 84% (−16%)" and **Reset to sum**; warnings when above the sum, below 50%, or 0 |
| B-3 | Availability derived from components | `min(floor(component stock / qty))`, with the limiting component shown |
| B-4 | Components may be sold only inside bundles | Hidden components allowed; deleted components as L-6 |
| B-5 | Offers don't stack on bundles unless enabled | Shop-wide and category offers off by default; offers naming the bundle always apply |
| B-6 | Shopper sees contents and savings | Contents list; "Save €X compared with buying separately" only for a manual price below the sum |
| B-7 | Contents in the cart and on the confirmation | "Includes: …" |
| B-8 | Owner sees contents on orders (packing) | Snapshot of components |
| B-9 | Search, filter, export and import bundles | Columns `bundle_components`, `bundle_pricing` (`sum` / `manual`), `bundle_offers` |
| B-10 | Create an offer for a bundle from its editor | Opens `/discounts/new?product=<id>` pre-filled |
| 🆕 B-11 | As a shopper, on a product page I see **"As seen in these bundles"** | A new builder widget lists the **visible, sellable** bundles that contain this product: card with image, name and price, plus "Out of stock" when applicable. Per bundle, the owner can turn off "Show on the pages of its products" (default on). Hidden and deleted bundles never appear |

## 1.5 Epic C: Search (backoffice and shop)

| ID | Story | Acceptance criteria |
|---|---|---|
| C-1 | Owner finds a product by name, SKU, description, category or property | Typo tolerance as §2.5.4 |
| C-2 | Owner filters, sorts and pages the list | Including status (visible, hidden, deleted) and "In a variant group" |
| C-3 | Owner finds incomplete products | "Missing photo / SKU / category / description" |
| C-4 | Bulk actions | Show, hide, set category, export. Delete is never a bulk action |
| C-5 | Pickers stay fast (typeahead) | Deleted products are never offered |
| C-6 | Shopper gets relevant results | Name, description, category and searchable public properties; typo tolerance |
| C-7 | Shopper filters by price, availability, category and properties | The price filter uses the shopper's own price; works without JavaScript |
| C-8 | Shopper sorts and pages | Price sort uses the shopper's own price; shareable URLs |
| C-9 | Product properties on the product page | Only *shown on product page* properties |
| C-10 | Suggestions while typing (P6) | 6 products + 3 categories |
| ✏️ C-11 | Owner designs filters, sorting, paging, variants and bundle lists in the builder | Widgets: Filters, Results bar, paging, Product details, Bundle contents, Variants, 🆕 **As seen in these bundles** |
| C-12 | Shopper understands corrected typos | "Showing results for **stoneware**" |

## 1.6 ✏️ Epic V: Product variants (rewritten)

Variants are **separate products** (own name, price, stock, SKU, photos, page) that the owner **links** into a
*variant group*. The owner ticks which properties identify a variant: the **differentiators**. **The values are not
typed anywhere:** they are read from the linked products. On a product page the shop shows, for each differentiator,
**all the values found in the group**. A value is a link when changing **only that property** leads to another
product of the group. Otherwise it is **disabled**.

| ID | Story | Acceptance criteria |
|---|---|---|
| ✏️ V-1 | As an owner I **link** products as variants | From any product (or a selection in the product list): "Link as variants". Products in the same group: 2–100. A product is in at most one group. **Bundles can't be linked** |
| ✏️ V-2 | As an owner I **tick the differentiators**; I never type value lists | The dialog shows the properties of the selected products and **pre-ticks those whose values differ** between them. I can tick or untick any **single-value** property (text, single choice, number, yes/no), **1–5** of them. If a ticked property is internal, one click makes it public (shoppers have to see it) |
| 🆕 V-3 | As an owner I **can't create duplicate variants** | If a product would have **the same values for every differentiator** as another product in the group, an **alert** names both products and their values ("Product 8 has the same Color, Size, Gender and Temperature as Product 1: White · 10 · Female · 10º"), and **the product is not added**. This applies to every way of getting there: linking, "Add a variant", editing a property of a member, unticking a differentiator (which could make two products identical), restoring a deleted member, and importing. Nothing is saved when the alert appears |
| 🆕 V-4 | As an owner I'm told when a product has **no value** for a differentiator | Alert: "Product 8 has no Temperature". The product isn't added until it has one (decision V-7) |
| ✏️ V-5 | As a shopper I see **one line per property, one badge per value** | For example "Color: [White] [Black]". The current product's value is highlighted (selected). Values appear in the order they first appear in the group's products (the owner can drag products to reorder), or sorted (A→Z, 1→9) per property if the owner prefers |
| ✏️ V-6 | As a shopper, **clicking a badge changes only that property** | The badge links to the product that has that value and the same values for all other differentiators. If there is none, the badge is **disabled** (visible, greyed, not clickable, with a screen-reader note "not available with the current choices"). Sold-out targets are still links, marked "sold out" |
| V-7 | As a shopper I never see values of products I can't open | Values that exist only on hidden or deleted products aren't shown at all |
| ✏️ V-8 | As an owner I **add a variant** quickly | "Add a variant" duplicates the current product as a **hidden** product, with a form pre-filled with the current values. I must change at least one differentiator value; while the combination equals an existing product, **Save is disabled and the alert of V-3 is shown** |
| V-9 | As an owner I manage the group | Table: product, one column per differentiator (values read from the products), price, stock, visibility; drag to reorder; remove from group; change differentiators; dissolve. 🆕 **Warnings** (not errors): "Gender has the same value on every product" (doesn't help shoppers); "Product 9 can't be reached from the other variants by changing one property" (§2.8.3) |
| ✏️ V-10 | As an owner I import and export variant groups | `variant_group` (handle) and `variant_by` (`color|size|gender|temperature`); the values come from the property columns. The preview applies V-3 and V-4 to the whole file; rejected rows are **not imported at all** |
| V-11 | As an owner I target all variants in an offer | "Add all variants" in the offer editor's picker |
| ❌ (v2 V-5 "closest product") | | Replaced by disabled badges (V-2 answer) |
| ❌ (v2 V-11 "one card per group") | | Moved to open decision V-6 |

## 1.7 Out of scope (v3)
- Variants as one product with combinations (shared stock or a price matrix inside one product), and automatic
  generation of every combination.
- ✏️ **Bundles as variants** (V-3 answer). "As seen in these bundles" is in scope (B-11).
- Mix-and-match bundles, buy-X-get-Y, "frequently bought together".
- Pre-assembled bundle stock, nested bundles.
- Rich-text descriptions.
- Restock on cancel.
- Roles and permissions.
- Multi-language search, synonyms, search analytics dashboards.
- Scheduled or URL/FTP imports.
- XLSX and product feeds.
- Native per-database search engines (future work).
- "On sale" filter.

## 1.8 Metrics
- Time to onboard 500 products.
- Import success rate; reverted imports.
- Share of orders with a bundle; AOV with and without a bundle. 🆕 Clicks on "As seen in these bundles".
- Search: usage, zero-result rate, filter use, conversion after search; typo-corrected searches.
- Variant selector clicks; conversion on products with variants.
- Restores from "Deleted products".

## 1.9 Business risks, safeguards and decisions

### Risks and safeguards

| Risk | Safeguard |
|---|---|
| An import overwrites good data | Mandatory preview with diff, warnings, "update only", never delete, revert (P6), audit |
| An import publishes unfinished products or internal data | `visible` column, new products hidden; 🆕 auto-created properties are internal |
| Overselling during an import | Atomic updates; stock applied only if unchanged since the preview |
| Bundle margin loss | Offers off by default on bundles; manual price warnings |
| An owner deletes something by mistake | Hide first, confirmation page, soft delete, restore |
| ✏️ A bundle silently keeps selling a deleted product | The owner must decide per bundle (L-2); a persistent alert on the bundle afterwards |
| ✏️ Confusing or broken variant selectors | Duplicate and missing-value alerts (nothing saved); warnings for useless differentiators and unreachable variants |
| 🆕 Many disabled badges frustrate shoppers | The reachability warning shows the owner which variants are hard to reach; the order can be adjusted |
| Shoppers confused by price sorting without JavaScript | `<noscript>` note |
| Crawler traps | `noindex` on filtered, sorted and paged pages |

### Decisions recorded (owner answers)

| # | Decision |
|---|---|
| B-1 | Bundle stock derived from components |
| B-2 | Automatic shop-wide and category offers don't apply to bundles unless enabled per bundle |
| B-3 | Price = sum by default; manual override with reset and %; offers via Discounts |
| B-4 | Components may be hidden |
| I-1 | CSV and JSON only |
| I-2 | URLs downloaded and hosted; server paths inside `IMPORT_MEDIA_DIR`; ✏️ the approach in C20 is **approved** |
| I-3 | `visible` column; new products hidden unless set |
| I-4 | Import never deletes |
| S-1 | Best approach per database; performance-only differences deferred (shared backend now) |
| S-2 | Filter and sort by the shopper's price |
| S-3 | Typo tolerance on (§2.5.4) |
| S-4 | Never delete: hide → delete (soft) → restore |
| ✏️ V-1 | Selector layout: one property per line, one inline badge per value |
| ✏️ V-2 | A value without a single-change product is **disabled** |
| ✏️ V-3 | Bundles can't be variants; add "As seen in these bundles" |
| ✏️ L-1 | The owner is alerted and decides per bundle: keep selling or hide |
| ✏️ L-2 | Import rows matching deleted products: restore and update, or create as a new product (or skip) |

### Decisions still open (recommendation in bold)

| # | Question | Options | Recommendation |
|---|---|---|---|
| 🆕 V-4 | **Your example contradicts the rule twice** (P1 → 30º, P3 → Black) | **Follow the rule** (the example table becomes the corrected table in §2.8.7) / another rule | Follow the rule: it is what you described, and it is predictable for shoppers |
| 🆕 V-6 | How variants appear in **lists** (category, search) | **Every variant as its own card (default)**; optional per-group "one card per group" later | Every variant: they are real products, and property filters ("Black") then show exactly the matching products |
| 🆕 V-7 | A product without a value for a differentiator | **Refuse with an alert (V-4)** / treat "no value" as its own value | Refuse: a missing value makes the selector ambiguous |
| S-2a | Result pages ordered by the visitor's own prices (private, never cached; no discount data in HTML) | **Accept** / JS-only reordering | Accept (unchanged from v2) |

## 1.10 Roadmap

| Phase | Delivers | Effort |
|---|---|---|
| **P0 Foundations** | Atomic SQLite `update`; public projection; `normalizeProduct`; versioned, audited writes; `catalogueVersion`; batched re-render; product lifecycle (✏️ per-bundle decisions on delete) | 5–6 days |
| **P1 Model + backoffice search + export** | SKU, properties, `SearchBackend` + contract suite, admin search, CSV/JSON export, Products screen (Deleted view, confirmation page), Properties screen, typeahead pickers | 9–11 days |
| **P2 Import** ✏️ | CSV/JSON import, mapping, preview, commit, report, lock, audit, PrestaShop preset, images (`/uploads`, server paths); ✏️ deleted-row choices (restore, create as new, skip); 🆕 property inference | 10–12 days |
| **P3 Shop search and filters** | Public view, filters, sort, paging, widgets, shopper-price sorting and filtering, typo tolerance, "Showing results for…" | 9–11 days |
| **P4 Bundles** ✏️ | Model, sum/manual price, availability, `offerScope`, checkout, snapshot, storefront, editor, offer shortcut; 🆕 "As seen in these bundles" | 8–10 days |
| **P5 Variants** ✏️ | Rewritten per §2.8: inferred values, 1–5 differentiators, duplicate/missing alerts everywhere, exact single-change selector with disabled badges, badge layout, reachability warning, add a variant, import/export | 7–9 days |
| **P6 Extras** | URL image download, import revert, suggestions, "no results" report | 4–6 days |
| **Total** | | **52–65 days** (P0–P5: 48–59) |

---

# 2. Technical details

## 2.1 Architecture

```
packages/db         update() as a single json_set statement (SQLite); lost-update contract test
packages/pricing    LineInput.offerScope; priceCatalogue() (one-unit "your price" for many products)
packages/renderer   widgets: searchFilters, resultsBar, productSpecs, bundleContents, productVariants (✏️ badges,
                    disabled state), 🆕 productBundles; productGrid paging; RenderContext additions; sample data
apps/api/src/catalogue/
  products.ts       admin routes; lifecycle (hide / delete-impact / delete ✏️ with bundle decisions / restore)
  model.ts          normalizeProduct(), publicProduct()
  attributes.ts     property definitions; 🆕 value canonicalisation shared with variants
  skus.ts           SKU claims (product_skus); 🆕 transfer for "create as new"
  bundles.ts        validation, availability, sum/manual price, order expansion, 🆕 reverse index (product → bundles)
  variants.ts       ✏️ groups, inferred values, duplicate/missing checks, selector, reachability (pure, unit-tested)
  search/           backend.ts, memory.ts, fuzzy.ts, your-price.ts
  import/           csv.ts, json.ts, mapping.ts, validate.ts, jobs.ts, routes.ts, media.ts, 🆕 infer.ts (property inference)
  export.ts         CSV (streamed), JSON catalogue
apps/api/src/storefront.ts  search/category pages, bundle contents, variant selector, 🆕 "as seen in" bundles
apps/api/src/shop-api.ts    /api/shop/prices uses the shared unitPrices()
apps/backoffice             Products (Deleted view, ✏️ delete decisions), Import wizard (✏️ deleted matches, 🆕 new
                            properties), Properties, bundle editor, ✏️ Link-as-variants dialog + variants section,
                            typeahead picker, offer editor ?product=
```

## 2.2 Data model

```ts
interface Product extends Doc {
  name: string; price: number; active: boolean; stock: number; categoryId?: string | null;
  description?: string; images?: string[];
  sku?: string | null;
  formerSku?: string | null;             // 🆕 set when "create as new" moved the SKU to another product (L-2)
  type?: "simple" | "bundle";
  attributes?: Record<string, AttrValue>;
  bundle?: BundleSpec;
  variantGroupId?: string | null;        // membership: single source of truth (simple products only)
  variantPosition?: number;              // order inside the group (drives value order, §2.8.4)
  deletedAt?: string | null; deletedBy?: string | null;   // deletedAt != null ⇒ active === false
  version?: number; createdAt?: string; updatedAt?: string; updatedBy?: string;
}

interface AttributeDef extends Doc {
  key: string; label: string; type: "text" | "choice" | "multi" | "number" | "boolean"; unit?: string;
  options?: { value: string; label: string; position: number; swatch?: string }[];
  visibility: "public" | "internal"; filterable: boolean; searchable: boolean; showOnProduct: boolean; position: number;
  origin?: { importJobId: string } | null;   // 🆕 created by an import (A-11)
  version: number; createdAt: string; updatedAt: string;
}

interface BundleSpec {
  components: { productId: string; qty: number }[];
  pricing: { mode: "sum" } | { mode: "manual" };
  offerScope: "targeted" | "all";
  showOnComponents: boolean;             // 🆕 B-11, default true
}

// collection "variant_groups"; id = handle (^[a-z0-9-]{1,64}$, immutable)
interface VariantGroup extends Doc {
  name: string;                                            // internal label, defaults to the first product's name
  differentiators: { key: string; order: "products" | "sorted" }[];   // ✏️ 1..5 (was 1..3), ✏️ per-key value order
  version: number; createdAt: string; updatedAt: string; updatedBy: string;
  // ❌ listing ("all" | "one"): moved to open decision V-6
  // Note: NO value lists are stored. Values are always read from the member products.
}

// ImportJob.options: deleted: ❌ "error" | "restore"  →  ✏️ per-row decisions (see §2.7.3);
//                    🆕 properties: { create: boolean; addChoiceValues: boolean }
// ImportRow.plan gains: 🆕 deletedMatch?: { productId: string; decision: "restore" | "new" | "skip" | null }
```

## 2.3 P0 Foundations

1. **Atomic SQLite `update`:** a `json_set` chain per top-level field in one `UPDATE … RETURNING`. This is the same
   technique as `updateWhere`; `json_patch` is not used because it merges nested objects. Lost-update contract test
   on both adapters.
2. **Public projection:** `publicProduct()` is an allowlist. It excludes internal properties, SKU (unless public),
   `version`, `updatedBy`, `deletedAt`, `deletedBy`, `formerSku`, `variantPosition`, group names, bundle pricing mode
   and import metadata.
3. **`normalizeProduct()`:** the second validation layer for API, import and bulk writes:
   - prices in whole cents with bounds;
   - integer stock;
   - length caps and control characters stripped;
   - images checked;
   - attributes checked against their definitions;
   - bundle and variant rules;
   - `deletedAt ⇒ active:false`.
4. **Versioned, audited writes:** optional `version` on PATCH (409 when stale). Every write is audited.
5. **Product lifecycle:** §2.3.5.
6. **`catalogueVersion`:** bumped on product, category, property and variant-group writes, and per import batch.
7. **Batched re-render:** once per request or import batch.

### 2.3.5 Product lifecycle (never delete)

```
   visible ──hide──▶ hidden ──delete (confirm + decide)──▶ deleted ──restore──▶ hidden
      ▲                 │                                                        │
      └────show─────────┘◀───────────────────────────────────────────────────────┘
```

| Method | Path | Behaviour |
|---|---|---|
| PATCH | `/api/products/:id` | Hide/show and edits. Guard `{ deletedAt: null, version }`; a deleted product → 409 `restore_first` |
| GET | `/api/products/:id/delete-impact` | `{ bundles: [{id, name, active, sumPriced}], variantGroup: {id, name, valuesLost: [{property, value}]} \| null, offers: [...], openOrders: n }`. ✏️ `valuesLost` lists the values that only this product has among the visible members (they'll disappear from the selector) |
| DELETE | `/api/products/:id` | ✏️ Body `{ bundles: { [bundleId]: "keep" \| "hide" } }`. **Every** bundle containing the product (not deleted) must have a decision, otherwise 409 `decision_required` with the missing ids. 409 `hide_first` if visible. Sets `deletedAt`, `deletedBy`, `active:false` (guard `{active:false, deletedAt:null}`). Hides the "hide" bundles. Stores the decisions in the audit entry |
| POST | `/api/products/:id/restore` | Clears `deletedAt`; stays hidden. ✏️ If its combination now duplicates a member of its group (V-3), it is restored **outside** the group and the response includes the alert text |

**Effects of `deletedAt`:**
- **Shop:** as hidden (not listed, 404 page, add to cart refused, checkout "product unavailable").
- **Backoffice:** only in the Deleted view.
- **Pickers:** excluded; existing references shown with a "deleted" tag.
- **Offers:** stay editable (the F5 fix).
- **Bundles:** per the decision ("keep": the component behaves like a hidden component; a persistent "contains a
  deleted product" alert).
- **Variant groups:** the member stays, is excluded from the selector and from duplicate checks, and is shown as
  deleted in the group table.
- **Orders:** snapshots unchanged.
- **SKU:** stays claimed (except §2.7.3 "create as new").
- **Export:** only from the Deleted view, or flagged in the JSON backup.
- **Search:** admin view flags; public view excludes.

## 2.4 Properties
- Admin CRUD with the strict validator, `version` and audit.
- **Delete** is refused while values exist (or `?purge=true`). A **type change** is refused while values exist.
- **Options:** renaming changes only the label; an option in use can't be removed; options can be reordered;
  optional swatch (hex, validated with `safeColor`).
- **Properties used as a differentiator:**
  - can't be deleted;
  - can't change type;
  - can't become internal;
  - ✏️ can't become `multi` (a multi-choice property has no single value to compare).
- 🆕 **Canonical value** (shared by variants, search facets and import matching):
  - text: NFKC, trim, collapse inner whitespace, compared case-insensitively. The stored spelling is kept for
    display;
  - number: the numeric value (`10` = `10.0`);
  - boolean: true/false;
  - choice: the option value.
- 🆕 **Properties created by import** (A-11): §2.7.6.

## 2.5 Search

### 2.5.1 Backend choice (S-1)
- `SearchBackend` interface (`sync`, `query`, `suggest`) with a shared **search contract test suite**.
- Native options were compared in v2:

  | Option | What it lacks |
  |---|---|
  | SQLite FTS5 | No typo tolerance (`spellfix1` missing) |
  | MongoDB `$text` | No prefix search, no typo tolerance |
  | MongoDB Atlas Search | Works only on Atlas hosting |

  None is better *functionally* at ≤ 20k products; they differ in performance and memory only.
- So v3, like v2, ships one shared in-process backend for both adapters. Native backends are future work; they must
  pass the same contract suite before being enabled.

### 2.5.2 Index
- **Normalisation:** NFKD, combining marks removed, lower case, split on non-letters/digits, letter/digit boundaries
  split.
- **Field weights:**

  | Field | Weight |
  |---|---|
  | SKU | 10 |
  | name | 5 |
  | category | 2 |
  | searchable properties | 2 |
  | description | 1 |

- **Structures:** posting lists, prefix array, facet bitsets, numeric arrays.
- **Two views:** the admin view (everything, with deleted and variant flags) and the public view (visible, sellable
  products, public fields only, built from `publicProduct()`). Each view has its own dictionary for typo tolerance.

### 2.5.3 Query
- **Matching:** AND across words; prefix on the last word; typo correction (§2.5.4).
- **Match factors:**

  | Match type | Factor |
  |---|---|
  | exact | 1.0 |
  | prefix | 0.7 |
  | corrected | 0.4 |

- **Filters:** category, price `min`/`max`, availability, and properties (`f.<key>`: OR within, AND across).
  Admin-only: status, type, missing fields, variant group.
- **Facets:** disjunctive counts.
- **Sort:** relevance, name, price (the shopper's price in the shop, list price in the backoffice), newest (admin
  also: stock, updated).
- **Paging:** caps on page and page size.
- ❌ The collapsing of `listing: "one"` groups (open decision V-6).

### 2.5.4 Typo tolerance (S-3)
Unchanged from v2:

- **Eligible words:** ≥ 5 letters, no digits, scripts with word spacing only, not a dictionary word, and not a prefix
  of one when it is the last word.
- **Candidates:** length buckets ±1 are scanned with a linear `withinOne` check (one substitution, insertion,
  deletion or adjacent swap). Distance 2 is not used (so `stonewear` is not corrected).
- **Ranking:** at most 5 candidates per word, ordered same first letter, then higher document frequency, then
  alphabetical.
- **Scoring:** factor 0.4; at most 3 corrected words per query.
- **Transparency:** "Showing results for …" when every result comes from corrections.
- **Privacy:** candidates come from the view's own dictionary, so no hidden words.
- **Tests:** the same table as v2.

### 2.5.5 API
- **Admin:** `GET /api/products` with search, filters, facets, paging, `status` and variant filters.
  - JSON `{items,total,facets}`; CSV and catalogue JSON by `Accept`.
  - Pickers use `view=summary`.
- **Public:** `GET /api/shop/search`, and `/search`, `/shop`, `/shop/category/:slug` with the same parameters.
  - These are personal (`private, no-store`, `Vary: Cookie`) when a price sort or filter is used.
  - Otherwise they are `public, max-age=60`.

### 2.5.6 Shop rendering
- **Widgets:** `searchFilters`, `resultsBar`, `productGrid` paging, `productSpecs`, `bundleContents`, ✏️
  `productVariants` (§2.8.5), 🆕 `productBundles` (§2.6.4).
- **Templates:** added to the templates for new shops. Existing shops get one-click "Add it" hints in the builder.
- **Other:** `noindex` and canonical on filtered pages; `<noscript>` note on price-sorted pages; `correctedQuery`.

### 2.5.7 Sorting and filtering by the shopper's price (S-2)
Unchanged from v2:

1. One `unitPrices()` function is shared by `/api/shop/prices` and search.
2. `priceCatalogue()` in `packages/pricing` is equivalence-tested against `price()`.
3. Context key: signed-in state, customer, profiles, cart code, selection, discounts version, minute bucket.
4. Price map per context: 30 s TTL, LRU of 500, filled lazily.
5. Shortcuts, because a price never goes above list: the `max` filter only needs pricing for list > max; the `min`
   filter excludes list < min without pricing; nothing is priced when no offer applies.
6. Deterministic sort.
7. Responses using it are personal and never cached.
8. HTML still contains no discount amounts, labels or offer ids (S-2a).

## 2.6 Bundles

### 2.6.1 Validation, availability, checkout
- **Validation:** 2–20 components, simple and not-deleted for **new** references, qty 1–99, no nesting. ✏️ A bundle
  can't be in a variant group, and a variant-group member can't be turned into a bundle.
- **Availability:** `min(floor(stock/qty))`.
- **Offers:** `offerScope` in the engine's `matches()`, "targeted" by default.
- **Checkout:**
  1. aggregate the demand per component (including components bought on their own);
  2. check the stock;
  3. decrement atomically in sorted id order, with undo.
  The line snapshot lists the components with `allocate()` shares.

### 2.6.2 Price
- **`sum` (default):** materialised, and recomputed in the same request when a component's price changes (the
  affected bundles are listed before saving).
- **`manual`:** the backoffice shows the original price (sum), the `%` and the saving, with **Reset to sum** and
  warnings.
- **Offers:** "Create an offer for this bundle" → `/discounts/new?product=<id>`.

### 2.6.3 Storefront
- **Contents widget:** components with image, name and qty. Hidden and deleted components are shown without a link.
- **Savings:** shown only for manual prices below the sum.
- **Cart and confirmation:** "Includes …".

### 2.6.4 🆕 "As seen in these bundles" (B-11)
- **Reverse index:** `productId → bundleIds`, built in memory with the search snapshot (refreshed by
  `catalogueVersion`). It holds only bundles that are visible, not deleted, sellable (every component exists) and
  have `showOnComponents: true`. Stock status is read live, so out-of-stock bundles can show "Out of stock".
- **Widget `productBundles`:**
  - props `{ heading: "As seen in these bundles", limit: 1..12 (default 4), cols: 2..5, showOutOfStock: bool }`,
    validated in `normProps`;
  - renders the same product cards as `productGrid`, including the price hook, so `shop.js` shows the visitor's
    price;
  - renders nothing when there are no bundles;
  - sample cards in the editor.
- **Template and backoffice:** added to the product page template for new shops, with an "Add it" hint for existing
  shops. The bundle editor has a "Show on the pages of its products" toggle.

## 2.7 Import and export

### 2.7.1 Formats

| Format | Export | Import |
|---|---|---|
| CSV (`,` `;` tab, UTF-8 + BOM) | P1 | P2 |
| JSON catalogue (`application/vnd.openshop.catalogue+json`: categories, attributes, variantGroups, products) | P1 | P2 |
| PrestaShop CSV preset | none | P2 |

### 2.7.2 CSV columns

| Column | Meaning |
|---|---|
| `id` | Matching key 1 |
| `sku` | Matching key 2 |
| `type` | `simple` / `bundle` |
| `name` | Required on create |
| `visible` | New products default to hidden |
| `price` | ≤ 2 decimals, no thousands separators |
| `stock` | Integer |
| `category` | Slug, or name with the preset |
| `description` | Plain text |
| `images` | `|`-separated: `/uploads/…`, server path, or `https://` |
| `attr:<key or Name>` | ✏️ Value of an existing property, **or a new property** (A-11) |
| `bundle_components` | `SKU*qty|…` |
| `bundle_pricing` | `sum` / `manual` |
| `bundle_offers` | `targeted` / `all` |
| `bundle_show_on_components` | 🆕 `yes` / `no` |
| `variant_group` | Group handle |
| `variant_by` | ✏️ 1–5 property keys, `color|size|gender|temperature` |
| `variant_position` | Integer |
| `deleted` | Export only |

Formula neutralisation: export prefixes `'`; import removes exactly one `'` before `= + - @ \t \r`.

### 2.7.3 Pipeline
- **Flow:** upload ≤ 10 MB → parse (linear RFC 4180 parser with limits; UTF-8 or windows-1252) → mapping (presets,
  🆕 "New property" targets) → preview → commit in batches of 200 → report.
- **Safety:** one import at a time; restart-safe row states; 30-day retention; never stored under `/uploads`.
- **Matching:** id → SKU → new.
- ✏️ **Rows matching a deleted product (L-2):**
  - the preview shows them in a **"Matches deleted products"** tab, with both the deleted product (name, deleted
    date and by whom) and the row;
  - a decision per row, or "apply to all": **Restore and update**, **Create as a new product**, or **Skip**;
  - `POST /commit` returns 409 `decisions_required` while any such row is undecided;
  - **Restore and update:** clears `deletedAt` (the product stays hidden unless `visible` says otherwise), then
    applies the row like an update. Variant checks apply; a duplicate means the row is rejected.
  - **Create as a new product:** a new id. If the row has the deleted product's SKU, the **SKU moves**:
    1. `updateWhere(product_skus/<SKU>, { productId: deletedId }, { set: { productId: newId } })`;
    2. the deleted product gets `sku: null, formerSku: <SKU>`;
    3. the new product is inserted.
    Each step is undone if a later one fails. Audited on both products. If the deleted product is restored later, it
    comes back **without** a SKU, and the restore response says so.
  - **Skip:** the row is reported as skipped.
- **Updates:** guarded by `version` (and stock, when stock is mapped); a guard failure is a conflict and the row is
  skipped.
- **Creates:** claim the SKU, then insert.
- **Passes:**
  1. simple products;
  2. bundles;
  3. variant groups and memberships.
- ✏️ **Variant rows (V-3, V-4, V-10):**
  - all rows of a group and its existing members (not in the file) are validated together **before** commit;
  - a row whose combination duplicates another row or member, or that misses a value, is an **error**;
  - the **whole row** is rejected (not created, not updated, not linked): "the product is never added";
  - both rows (or the row and the existing product) are named in the report.
- **End of import:** one re-render and one audit entry with the file SHA-256 and the counts.
- **Media** (`/uploads`, server paths): resolved during the preview, copied during commit.

### 2.7.4 Export
- `Accept: text/csv` (streamed, ≤ 100k rows) or the catalogue JSON type.
- `no-store`, sanitised filename, `?delimiter=`, `?columns=`.

### 2.7.5 Images in imports (I-2, C20 approved)

| Source | Phase | Handling |
|---|---|---|
| `/uploads/<hex>.<ext>` | P2 | Must exist |
| Server path | P2 | Inside `IMPORT_MEDIA_DIR` (operator-set environment variable, off by default); syntactic rejects; `realpath` containment; `O_NOFOLLOW` open + `fstat` on the handle (regular file ≤ 5 MB); extension + magic bytes (no SVG); **copied** to a random upload name; SHA-256 dedupe; one generic error message; caps |
| `https://` | P6 | SSRF-safe download; until then an external link, with a warning |

### 2.7.6 🆕 Property inference (A-11)
- **Which columns.** Any `attr:<X>` column where `X` isn't an existing key or label, and any column the owner maps to
  **New property** in the mapping step.
- **Key and label:**
  - label = the header text (trimmed, ≤ 80);
  - key = slug of the label (`Temperature` → `temperature`, `Cor/Color` → `cor_color`), which must match
    `^[a-z][a-z0-9_]{0,31}$`;
  - denylist (`__proto__`, `constructor`, `prototype`);
  - a collision with an existing key gets `_2`.
- **Type, inferred from the non-empty values and editable in the mapping step before preview:**

  | Values | Inferred type |
  |---|---|
  | all match the strict number format | number |
  | all in {yes, no, true, false, 1, 0} | yes/no |
  | anything else | **text** (for example `10º`) |

  Choice types are never inferred, because free text is the safe default. The owner can pick *single choice*; the
  distinct values then become the options, in order of first appearance.
- **Defaults:** created properties are **internal**, not filterable, not searchable and not shown (C25). The preview
  lists them: "New properties: Temperature (text, 2 values), …". The owner publishes them later from the Properties
  screen, or with one click when ticking them as differentiators (V-2).
- **New values for choice properties:** with `addChoiceValues` (default on), unknown values are added as options at
  the end, listed in the preview. Otherwise they are errors.
- **Limits:** ≤ 50 new properties per import; ≤ 200 properties in total; ≤ 500 options per choice property. The
  properties are created at commit time (before the products), and each one is audited with the job id.

## 2.8 ✏️ Variants (rewritten)

### 2.8.1 Concepts
- A **variant group** links 2–100 **simple** products (bundles are refused).
- Its **differentiators** are 1–5 single-value properties (text, single choice, number, yes/no) ticked by the owner.
  They must be **public**.
- **No values are stored on the group.** A product's *combination* is the tuple of its canonical values (§2.4) for
  the differentiators, read from the product itself. Editing a product's Color changes what the selector shows.
- **Visible members** are the active, not deleted members. They are the only ones the shop ever looks at.

### 2.8.2 API

| Method | Path | Behaviour |
|---|---|---|
| GET | `/api/variant-groups/:id` | The group, all members (hidden and deleted flagged) with their values, and `warnings[]` |
| POST | `/api/variant-groups/suggest` | 🆕 `{ productIds }` returns the properties of these products, with `varies: true` for those whose values differ (the dialog pre-ticks these) and a preview of duplicates and missing values |
| POST | `/api/variant-groups` | `{ id?, name?, differentiators: [{key, order?}], productIds }`. All-or-nothing |
| PATCH | `/api/variant-groups/:id` | `{ version, name?, differentiators?, add?, remove?, order? }`. All-or-nothing |
| POST | `/api/variant-groups/:id/variants` | "Add a variant": `{ fromProductId, values: {key: value}, name? }`. Creates a hidden copy **only if** the combination is unique |
| DELETE | `/api/variant-groups/:id` | Dissolves the group (clears membership; products untouched) |

Errors, designed for the backoffice alert:
- `409 variant_duplicate`:
  `{ error: "Product 8 has the same Color, Size, Gender and Temperature as Product 1 (White · 10 · Female · 10º).", conflicts: [{ productId, name, withProductId, withName, values: [{property, value}] }] }`
- `400 variant_missing_value`:
  `{ error: "Product 8 has no Temperature.", missing: [{ productId, name, properties: [...] }] }`

### 2.8.3 Validation (every write path)
- **Which checks apply:**

  | Check | Applies to |
  |---|---|
  | Every **non-deleted** member has a value for every differentiator | V-4 |
  | Combinations are **unique** among non-deleted members (compared on canonical values) | V-3 |
  | Differentiators are public, single-value, existing properties | |
  | Members are simple products | |
  | A product is in at most one group | guarded update `{ variantGroupId: null, deletedAt: null }` |

- **Paths validated, in the same function `validateGroup(groupAfterChange)`:**
  - create/link;
  - add a member;
  - "Add a variant";
  - **a product PATCH that changes a differentiator's value** (for example Product 3's Size from 20 to 10 would
    duplicate Product 1 → 409, nothing saved);
  - changing differentiators (unticking Temperature would make P1 = P5 and P2 = P6 → 409 listing both pairs);
  - restore of a deleted member (a duplicate → restored outside the group, with the alert);
  - import (the whole file, §2.7.3).
- **All-or-nothing:**
  1. validate the complete future state **in memory first**;
  2. bump `group.version` with `updateWhere(groupId, { version: v }, { inc: { version: 1 } })`, so a concurrent
     change gets 409;
  3. only then write the members, with undo on failure.
  Nothing is written when an alert is returned ("the product is never added").
- **Warnings** (shown in the group table, never blocking):
  - *Useless differentiator:* all visible members have the same value.
  - *Unreachable variant:* build a graph where two visible members are connected when they differ in **exactly
    one** differentiator; warn for members outside the largest connected component ("Product 9 can't be reached
    from the other variants by changing one property; shoppers will only find it through search and lists").
    Your example is fully connected: all 7 reachable, verified.

### 2.8.4 Selector algorithm (pure, `variants.ts`)

```
input: current product P (visible), differentiators D = [d1..dk] (k ≤ 5), visible members M (P ∈ M)
index: byCombo = Map(comboKey(m) → m) for m in M        // comboKey = canonical values joined; unique by §2.8.3

for each d in D:
  values = distinct canonical values of d over M
  order  = d.order == "products" ? by first appearance in M sorted by variantPosition (then name, id)   // default
                                 : natural sort (numbers numeric, text with Intl.Collator {numeric:true}, yes before no)
  for each v in values (in that order):
    if v == P[d]:                  badge = { label(v), state: "selected" }
    else:
      t = byCombo.get(comboKey(P with d := v))          // change ONLY d
      if t:                        badge = { label(v), state: "link", href: "/shop/product/" + t.id, soldOut: available(t) == 0 }
      else:                        badge = { label(v), state: "disabled" }
```

- **Labels:** for choice properties, the option label; for text, the stored spelling of the first member (by
  position) that has this value; for numbers, the formatted number plus unit; for yes/no, "Yes"/"No".
- **Values come only from visible members** (V-7). A value that only a hidden or deleted member has is not listed;
  it doesn't even appear disabled.
- **Complexity:** O(k × values) Map lookups, ≤ 5 × 100, microseconds. Members are loaded with one
  `find({ variantGroupId })`.
- ❌ v2's "closest product" scoring and "also changes…" hints are removed.

### 2.8.5 Shop rendering: one property per line, one badge per value (V-1)
- `ProductCtx.variants = { lines: [{ label, badges: [{ label, state, href?, soldOut?, swatch? }] }] }`, built from the
  public projection and public property labels only.
- **Widget `productVariants`:**
  - props `{ swatches: bool, showSoldOut: bool, disabledStyle: "faded" | "struck" }`, validated in `normProps`;
  - the editor's sample data **is the owner's example** (Product 1's selector).
- **Markup (no JavaScript needed):**

```html
<div class="os-var" role="group" aria-labelledby="v-color">
  <span class="os-var-l" id="v-color">Color</span>
  <span class="os-badge is-selected" aria-current="true">White</span>
  <a class="os-badge" href="/shop/product/…">Black</a>
</div>
<div class="os-var" role="group" aria-labelledby="v-gender">
  <span class="os-var-l" id="v-gender">Gender</span>
  <span class="os-badge is-selected" aria-current="true">Female</span>
  <span class="os-badge is-disabled" aria-disabled="true">Male<span class="os-vh"> (not available with the current choices)</span></span>
</div>
```

- Disabled badges are `<span>`, not links, so they are not focusable or clickable. Sold-out targets are links with a
  "sold out" marker. All text goes through `esc()`, links through `safeUrl()`, swatches through `safeColor()`.
- Each variant keeps its own URL and canonical link. Lists show every variant as its own card (pending V-6).

### 2.8.6 Backoffice
- **"Link as variants" dialog** (from a product, or a selection in the list):
  1. pick products (typeahead);
  2. **differentiators pre-ticked from `/suggest`** (the properties whose values differ), which the owner adjusts
     (1–5);
  3. a live **preview of the selector** for the first product, plus the matrix (product × differentiator values,
     read-only: values are edited on the products themselves);
  4. alerts for duplicates and missing values, which block saving; warnings for useless or unreachable ones;
  5. "Make public" for internal differentiators;
  6. save.
- **Variants section** in the product editor: the same matrix, reorder, remove from group, change differentiators,
  "Add a variant" (form pre-filled with the current values; Save disabled and the alert shown while the combination
  exists), dissolve.
- **Product form:** when editing a member's differentiator value creates a duplicate, the API's 409 is shown as the
  alert and nothing is saved.
- **Product list:** "N variants" tag; "In a variant group" filter.
- **Offer editor:** "Add all variants".

### 2.8.7 🆕 Acceptance fixture (the owner's example)

Members in this order: P1 White·10·Female·10º, P2 Black·10·Female·10º, P3 White·20·Female·10º, P4 White·30·Female·10º,
P5 White·10·Female·30º, P6 Black·10·Female·30º, P7 White·20·Male·10º. Differentiators Color, Size, Gender, Temperature
(`order: products`). Computed with the algorithm above; these are the expected test outputs (`→` = link,
`(sel)` = selected, `(dis)` = disabled):

| Page | Color | Size | Gender | Temperature |
|---|---|---|---|---|
| P1 | White (sel) · Black → P2 | 10 (sel) · 20 → P3 · 30 → P4 | Female (sel) · Male (dis) | 10º (sel) · 30º → P5 ⚠ |
| P2 | White → P1 · Black (sel) | 10 (sel) · 20 (dis) · 30 (dis) | Female (sel) · Male (dis) | 10º (sel) · 30º → P6 |
| P3 | White (sel) · Black (dis) ⚠ | 10 → P1 · 20 (sel) · 30 → P4 | Female (sel) · Male → P7 | 10º (sel) · 30º (dis) |
| P4 | White (sel) · Black (dis) | 10 → P1 · 20 → P3 · 30 (sel) | Female (sel) · Male (dis) | 10º (sel) · 30º (dis) |
| P5 | White (sel) · Black → P6 | 10 (sel) · 20 (dis) · 30 (dis) | Female (sel) · Male (dis) | 10º → P1 · 30º (sel) |
| P6 | White → P5 · Black (sel) | 10 (sel) · 20 (dis) · 30 (dis) | Female (sel) · Male (dis) | 10º → P2 · 30º (sel) |
| P7 | White (sel) · Black (dis) | 10 (dis) · 20 (sel) · 30 (dis) | Female → P3 · Male (sel) | 10º (sel) · 30º (dis) |

⚠ marks the two cells that differ from the expectation in the request (open decision V-4). More fixtures:
- adding **P8 = White·10·Female·10º** → 409 `variant_duplicate` naming P1; P8 is not added;
- P8 without Temperature → 400 `variant_missing_value`;
- unticking Temperature → 409 listing P1 = P5 and P2 = P6;
- hiding P7 → on P1 and P3, Gender shows only "Female (sel)" (Male disappears entirely);
- P3's Size edited to 10 → 409 (duplicate of P1), Size stays 20.

### 2.8.8 Interplay
- **Search:** members are normal products; `variantGroupId` is used for admin filters.
- **Bundles:** components can be specific variants; bundles can't be members; "As seen in these bundles" works per
  product.
- **Discounts:** "Add all variants".
- **Lifecycle:** deleting a member shows `valuesLost` on the confirmation page; restore is re-validated.
- **Import and export:** §2.7.

## 2.9 API summary

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/products` | admin | Search, filters, facets, paging, status, variant filters; JSON / CSV / catalogue JSON |
| POST / PATCH | `/api/products[/:id]` | admin | `normalizeProduct`, `version`, audit; ✏️ variant re-validation on differentiator changes |
| GET | `/api/products/:id/delete-impact` | admin | ✏️ + `valuesLost` |
| DELETE | `/api/products/:id` | admin | ✏️ Soft delete; hidden only; **a decision required per bundle** |
| POST | `/api/products/:id/restore` | admin | Restores as hidden; variant re-validation |
| POST | `/api/products/bulk` | admin | Show, hide, category |
| CRUD | `/api/attributes[/:id]` | admin | |
| ✏️ CRUD | `/api/variant-groups[/:id]`, `POST /suggest`, `POST …/variants` | admin | All-or-nothing; 409 / 400 alert payloads |
| … | `/api/catalogue/imports…` | admin | ✏️ Deleted-row decisions (`PUT …/rows/decisions`), 409 `decisions_required`; 🆕 new-property mapping |
| GET | `/api/shop/products` | public | Public projection |
| GET | `/api/shop/search`, `/search`, `/shop`, `/shop/category/:slug` | public | Personal only for price sort/filter |
| GET | `/api/shop/prices` | public | Shared `unitPrices()` |

## 2.10 Migration and compatibility
- **New fields** are optional, with defaults: no `deletedAt` means not deleted; no `type` means `simple`.
- **`DELETE /api/products/:id` becomes a soft delete** that requires a decision per bundle. Its callers are updated
  in P0: the backoffice, the tests and `seed-demo.py --only`.
- **Bundles and variant groups are new,** so nothing needs migrating.
- **Demo seed (P5):** a variant group using the owner's example values.

## 2.11 Performance budgets

| Operation | Budget |
|---|---|
| Index build | ≤ 500 ms |
| Index memory | ≤ 60 MB |
| Admin search p95 | ≤ 50 ms |
| Shop search page p95 | ≤ 120 ms |
| Import preview, 20k rows | ≤ 20 s |
| Import commit, 20k rows | ≤ 60 s (event loop never blocked > 50 ms) |
| CSV export, first byte | ≤ 300 ms |
| Cold price map, 20k products | ≤ 150 ms |
| Typo correction | ≤ 2 ms per word |
| ✏️ Variant selector | ≤ 0.5 ms per page |
| 🆕 Variant validation (100 members, 5 differentiators) | ≤ 5 ms, including reachability |
| 🆕 "As seen in these bundles" | ≤ 1 ms (in-memory reverse index) |

## 2.12 Testing
Unchanged from v2: the db contract, pricing (`offerScope`, `priceCatalogue` equivalence), renderer escaping, search
contract (typo table, privacy), your-price (headers, contexts), lifecycle, bundles pricing, server media paths
(traversal, symlinks, FIFO, oversize, SVG, identical errors), import (parser fuzzing, formula round trip, pollution,
conflicts, resume, lock) and e2e. ✏️ Changed or new:
- ✏️ **Variants:**
  - the **§2.8.7 fixture table** as a table-driven test (every cell);
  - duplicate alert on **every** path (link, add member, "Add a variant", product PATCH, untick a differentiator,
    restore, import) with "nothing written" assertions;
  - missing values;
  - canonical comparison (`"White "` = `"white"`, `10` = `10.0`);
  - text values like `10º`;
  - value order by product position vs sorted;
  - hidden and deleted members excluded (values disappear);
  - reachability warning (an island case);
  - useless-differentiator warning;
  - bundles refused;
  - a concurrent PATCH of two members creating the same combination → one gets 409;
  - widget markup (disabled = `span` with `aria-disabled`; escaping).
- ✏️ **Lifecycle:**
  - DELETE without decisions for every bundle → 409 `decision_required`;
  - "keep" vs "hide" outcomes;
  - `valuesLost` contents;
  - the persistent bundle alert.
- ✏️ **Import:**
  - deleted matches: commit blocked until decided;
  - restore;
  - create as new (SKU moved, `formerSku`, restore without SKU, undo when a step fails);
  - skip.
- 🆕 **Property inference:**
  - number, yes/no and text inference (`10º` → text);
  - key slugging and collisions;
  - denylist;
  - created internal;
  - choice values added or refused;
  - limits.
- 🆕 **"As seen in these bundles":**
  - hidden, deleted and non-sellable bundles never listed;
  - `showOnComponents: false`;
  - out of stock labelled;
  - prices filled by `shop.js` only.

## 2.13 Future work
- Native `SearchBackend`s (SQLite FTS5 + typo layer; Atlas Search), behind the contract suite.
- "Variant group" as an offer target.
- "One card per group" in lists (if V-6 asks for it).
- "On sale" filter.
- XLSX, feeds.

## 2.14 Phase acceptance criteria
- **P0:**
  - the lost-update contract test passes;
  - no hidden field appears in public responses;
  - no hard delete exists;
  - ✏️ deleting requires hidden status **and** a decision per bundle;
  - the F5 scenario stays editable.
- **P1:** F-1, F-2, C-1 to C-5, A-1, A-2, L-4; the search contract suite is green.
- **P2:**
  - A-3 to A-7, A-9, ✏️ A-4 (deleted decisions), 🆕 A-11;
  - the round trip gives zero changes;
  - the 20k-row budget is met.
- **P3:**
  - C-6 to C-12;
  - everything works without JS;
  - personal responses are never publicly cached.
- **P4:** B-1 to B-11.
- **P5:**
  - ✏️ V-1 to V-11;
  - **the §2.8.7 fixture passes cell by cell**;
  - no duplicate can be created through any path;
  - no hidden variant value ever appears in the shop.
- **P6:** the chosen extras.

---

# 3. Security

Each item gives the requirement, the reason and how it is verified. The discounts plan's S1–S18 and its known
limitations still apply.

**C1. Data minimisation on public endpoints.**
- **Requirement:** every public response is built from the `publicProduct()` allowlist. That excludes internal
  properties, SKU unless public, version, audit fields, `deletedAt`, `formerSku`, variant positions, group names,
  bundle pricing mode and import metadata.
- **Verified by:** a snapshot test with every internal field.

**C2. Search must not be an oracle for hidden data.**
- **Requirement:**
  - The public index, facets, typo dictionary and "Showing results for" use visible products and public fields only.
  - "Matches hidden data" and "matches nothing" give identical responses.
- **Verified by:** oracle tests, including one-typo versions of hidden words.

**C3. Authorization.**
- **Requirement:** every new admin route sits in the authenticated scope, with a `can()` hook for future roles.
- **Verified by:** an exhaustive 401 list. ✏️ It adds `variant-groups/suggest` and the import decision routes.

**C4. Strict input validation.**
- **Requirement:**
  - `normalizeProduct` runs on every write.
  - The strict Ajv validator is used (no coercion; unknown fields rejected).
  - Cents and bounds for prices; attribute keys restricted with a denylist; maps built with `Object.create(null)`.
  - Allowlisted filter and sort fields.
  - Group handles are validated.
  - ✏️ Differentiators must be existing public **single-value** properties, 1–5 of them.
  - ✏️ Keys generated from import headers go through the same key regex and denylist (§2.7.6).
- **Verified by:** negative tests and prototype-pollution tests.

**C5. Stored XSS through imported content.**
- **Requirement:** imported strings are data. They are escaped everywhere: renderer, Angular interpolation only, and
  `shop.js` `textContent` only. HTML descriptions become plain text.
  - ✏️ This also covers **text variant values** (`10º`, or `<img onerror>`) in badges, the labels of properties
    created from headers, group names and media paths in reports.
- **Verified by:** a payload fixture rendered in the shop, the preview and the reports.

**C6. Spreadsheet formula injection.**
- **Requirement:** exports and reports neutralise formula-like cells. Import reverses exactly one `'`.
- **Verified by:** round-trip and payload tests.

**C7. SSRF for image URLs (P6).**
- **Requirement:**
  - `https` only, with DNS checks against private, loopback, link-local and metadata addresses.
  - Connections go to the validated IP (pinned); every redirect is re-validated (≤ 3).
  - Timeouts, a 5 MB cap, concurrency limits, and magic-byte checks.
- **Built:** as required, plus: port 443 only, no IP literals, no credentials in addresses (and never echoed in
  messages), a name is refused if **any** of its addresses is not public, IPv4-mapped IPv6 checked as IPv4, downloads
  audited with their source.
- **Verified by:** `remote-images.test.ts` (a local HTTPS server): address table, refusals before any connection,
  redirects to http and to private names, redirect loops, size limits with and without a declared length, time limit,
  untrusted certificate, SVG disguised as PNG, and the import flow.

**C8. Privacy of hotlinked images.**
- **Requirement:** a warning until P6; an optional "self-hosted images only" setting.

**C9. Integrity under concurrency.**
- **Requirement:**
  - The atomic SQLite update.
  - Versioned edits, and import guards on version and stock.
  - SKU claims, plus ✏️ the guarded **SKU transfer** for "create as new".
  - The single-import lock.
  - Bundle checkout decrements with undo.
  - Lifecycle guards.
  - ✏️ The **variant group version guard**, with validation of the full future state before any write.

**C10. Money integrity.**
- **Requirement:**
  - Cents only, with the bundle sum computed on the server.
  - Manual prices bounded; price 0 must be confirmed.
  - `priceCatalogue` ≡ `price()`.
  - The cart never accepts component lists or prices from the client.

**C11. Safety of bulk changes.**
- **Requirement:**
  - Preview is mandatory and commit refers to it.
  - Import never deletes.
  - No bulk delete.
  - ✏️ Deleting needs hidden status **plus an explicit decision per bundle** (enforced by the API, not only the UI).
  - ✏️ Import can't restore or create over a deleted product without an explicit per-row decision.

**C12. Audit.**
- **Requirement:**
  - Product, property, bulk, import, lifecycle (✏️ including the per-bundle decisions), variant group changes,
    bundle price recalculations and media copies.
  - ✏️ Plus SKU transfers (on both products) and 🆕 properties created by imports.

**C13. Denial of service.**
- **Requirement:**
  - Route-scoped body limits and parser limits; import batches.
  - Streamed, capped exports.
  - Public search caps and per-IP rate limits; typo caps; price map caps; media caps.
  - ✏️ Variant caps: 100 members, **5** differentiators, 100 values per differentiator.
  - 🆕 Inference caps: 50 new properties per import, 200 in total, 500 options per choice property.

**C14. Confidentiality of exports and import files.**
- **Requirement:**
  - `no-store`.
  - Downloads use the bearer token, never a token in the URL.
  - Import data is not kept under `/uploads` and is purged after 30 days.
  - The media folder's absolute path is never shown.

**C15. Bundle business-logic abuse.**
- **Requirement:**
  - Live component stock is checked at checkout.
  - Hidden or deleted components are never addable on their own.
  - `offerScope` is decided in the engine.
  - Quantity caps.

**C16. Output, caching and SEO.**
- **Requirement:**
  - Echoed values are escaped; facet links are built by the server.
  - Public caching only when no price sort or filter is used (otherwise C23).
  - `noindex` on filtered pages.

**C17. Injection into the data layer.**
- **Requirement:**
  - No queries are built from user input; the index is in memory.
  - Known field names only.
  - No `RegExp` is built from user input.

**C18. Dependencies.**
- **Requirement:** no new runtime dependencies in any phase.

**C19. CSRF.**
- **Requirement:** the admin API stays bearer-only; the new public routes are GET.

**C20. Server file paths in imports.**
- **Requirement:** as described in §2.7.5, **approved by the owner**:
  - the feature is on only when the operator sets the folder;
  - `realpath` containment;
  - `O_NOFOLLOW` and `fstat` on the open handle;
  - regular files ≤ 5 MB only, with the extension and magic bytes checked;
  - files are copied, never served in place;
  - one generic error message;
  - caps and audit.
  - The residual risk (swapping folders between the check and the open, by someone who can write to the media
    folder) is documented.
- **Verified by:** traversal, symlink, FIFO, device, oversize and SVG tests, and identical error messages.

**✏️ C21. Variant integrity.**
- **Requirement:**
  - Combinations are unique and complete among non-deleted members, on canonical values.
  - They are enforced by one validation function on **every** write path (API, product PATCH, differentiator change,
    "Add a variant", restore, import).
  - The full future state is validated before any write (all-or-nothing), with the group version guard against
    races.
  - The selector is built only from server data, with exact single-change lookups and `/shop/product/<id>` links.
  - Disabled values are rendered as non-interactive elements.
- **Reason:** an ambiguous group would send shoppers to the wrong product, which could mean the wrong size or colour
  ordered.
- **Verified by:** the fixture, the duplicate-on-every-path tests and the race test.

**✏️ C22. Linked products must not reveal hidden products.**
- **Requirement:**
  - The variant selector lists values from **visible members only**. Disabled badges show only values of visible
    products, which shoppers could already open.
  - 🆕 "As seen in these bundles" lists only visible, not deleted, sellable bundles that have not opted out.
  - Internal properties can't be differentiators.
  - `delete-impact` and variant warnings are admin-only.
- **Reason:** linking must not leak unreleased colours, sizes or bundles.
- **Verified by:** snapshot tests with hidden members and hidden bundles carrying unique values.

**C23. Personal ordering by the shopper's price.**
- **Requirement:**
  - Only the visitor's own context is used, through the same function as `/api/shop/prices`.
  - Responses that use it are `private, no-store` with `Vary: Cookie`.
  - Caches are keyed by the full context; anonymous contexts never include targeted offers.
  - No discount amounts, labels or ids appear in HTML.
- **Verified by:** header, cross-customer, cache-key and HTML-scan tests.

**✏️ C24. Product lifecycle integrity.**
- **Requirement:**
  - No hard delete anywhere (route inventory test).
  - `deletedAt ⇒ active:false`.
  - Delete requires hidden status and ✏️ **server-enforced decisions for every containing bundle**.
  - Restore returns the product hidden and re-validates its variant group.
  - Deleted products stay resolvable for references.
  - Every step is audited.
  - ✏️ Import can act on deleted products only through explicit per-row decisions. "Create as new" moves the SKU
    with a guarded, reversible transfer.

**🆕 C25. Properties created by imports are internal by default.**
- **Requirement:**
  - Properties created from file columns start as `internal`, not filterable, not searchable and not shown.
  - The preview lists them.
  - Publishing them is a separate, audited action, either in the Properties screen or through "Make public" when
    ticking a differentiator.
- **Reason:** supplier and ERP exports often carry columns such as cost, margin, supplier or internal notes.
  Auto-publishing inferred properties would put them on the shop, in search and in facets; C1 and C2 would be
  bypassed by configuration rather than code.
- **Verified by:** importing `attr:Cost`, `attr:Supplier`: they are absent from every public response, facet and
  search match until published.

---

## Appendix: Effort summary

| Phase | v2 | v3 |
|---|---|---|
| P0 Foundations | 5–6 | 5–6 |
| P1 Model, backoffice search, export | 9–11 | 9–11 |
| P2 Import | 9–11 | 10–12 (property inference, deleted-row choices) |
| P3 Shop search | 9–11 | 9–11 |
| P4 Bundles | 7–9 | 8–10 ("As seen in these bundles") |
| P5 Variants | 7–9 | 7–9 (rewritten: simpler selector, wider value types, alerts everywhere) |
| P6 Extras | 4–6 | 4–6 |
| **Total** | **50–63** | **52–65** (P0–P5: 48–59) |

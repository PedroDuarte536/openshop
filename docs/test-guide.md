# Catalogue features: testing guide

This guide walks through every flow of the catalogue work: product search and filters, properties, SKUs, the product
lifecycle, bundles, variants, shop search, import and export, and the new page-builder widgets. It ends with checks
you can run from a terminal. Each test has an id (for example **SR-3**), so you can report results by id.

Everything runs against a demo shop (Maison Dune, hand-made ceramics) with an **empty second shop** next to it for the
backup-restore test.

---

## 0. Before you start

### 0.1 What is running

| What | Address | Sign in |
|---|---|---|
| Shop (main) | http://localhost:3000/shop | customer accounts below (optional) |
| Backoffice (main) | http://localhost:4200 | `admin@example.com` / `dune-admin-2026` |
| Shop (empty, for the restore test) | http://localhost:3001/shop | – |
| Backoffice (empty shop) | http://localhost:4201 | `admin@example.com` / `dune-admin-2026` |

Customer accounts in the main shop (password `dune-demo-2026` for all):

| Customer | Why they matter |
|---|---|
| `priya.nair@example.com` | VIP: 25% off bowls (client price) – shows a *personal price order* |
| `jonas.weber@example.com` | "Trade buyers" profile: 30% off everything (shop-wide offer) – shows bundle offer rules |
| `sofia.rossi@example.com` | Personal discount code |

> **Use `localhost` in the address bar, not an IP address.** Customer sign-in cookies are `Secure`. Browsers accept
> them on `http://localhost` but not on plain `http://<ip>`, so signing in would silently fail.

### 0.2 Starting, stopping, resetting

```bash
scripts/demo-servers.sh status      # what is running
scripts/demo-servers.sh stop
scripts/demo-servers.sh start       # starts the four servers again (data is kept)
scripts/demo-servers.sh seed        # RESET: deletes both demo shops and seeds the main one again (~1 minute)
```

The backoffice needs Node ≥ 22.22.3. If your default `node` is older, put a newer one first:
`NODE_FOR_NG=/path/to/node/bin scripts/demo-servers.sh start` (same for `seed`). Logs are in `demo-data/logs/`.

Many tests change data. When in doubt, run `seed` and start again. The tests are written so that each section works
on a freshly seeded shop. Later sections don't depend on earlier ones, except where a test says so.

### 0.3 What the demo data contains

`seed-demo.py` adds the base shop: 25 products in 5 categories, orders, offers and customers.
`seed-catalogue.py` adds:

- **SKUs** `MD-<NAME>` on every product (for example `MD-LINEN-MUG`).
- **Properties:**
  - **Colour** – one choice, with swatches; filter, search.
  - **Material** – text.
  - **Capacity** – number, in ml; filter.
  - **Dishwasher safe** – yes/no.
  - **Supplier** – *internal*: never in the shop.
  - **Colors / Size / Gender / Temperature** – for the variant example.
- **Variant groups:**
  - **Example jacket** – your example: *Example jacket 1…7* in the category "Jackets (variant example)", told apart by
    Colors, Size, Gender and Temperature.
  - **Everyday mug** – Linen Mug, Night Market Mug and Speckle Mug, told apart by Colour.
- **Bundles** (category Gifts & sets):

  | Bundle | Contents | Price | Offers |
  |---|---|---|---|
  | Breakfast for Two | 2 Linen Mug, 2 Breakfast Bowl, 2 Side Plate | sum of products (€152) | only offers made for the bundle |
  | Morning Ritual Box | Tall Latte Mug, Dipping Bowl, Salt Cellar | manual €49 (the sum is €59) | only offers made for the bundle |
  | Flower Corner | 2 Bud Vase, Small Pot | sum (€84) | shop-wide and category offers apply too |

- **Server image folder** (`IMPORT_MEDIA_DIR` = `demo-data/import-media`), used by the import files:
  - `mugs/sand-mug.png`
  - `mugs/moss-mug.png`
  - `bowl.png`
  - `fake.png` – SVG text with a `.png` name; must be refused.

Running offers that matter here:

| Offer | Applies to |
|---|---|
| **Winter sale – mugs** | 20% off the Mugs & cups category |
| **Vase lovers** | 15% off vases |
| **Bud Vase clearance** | Bud Vase at €19 |
| **Big order bonus** | €10 off orders over €150 |
| **Trade – 30% off everything** | Jonas and Erik |
| **Priya – bowls** | 25% off bowls for Priya |

Sample import files are in `docs/test-guide/` (section 8).

---

## 1. Backoffice: product list, search and filters

Open http://localhost:4200 → **Products**.

| Id | Steps | Expected |
|---|---|---|
| PL-1 | Look at the left column | Filters with counts: Visibility, Stock (In stock / Low (3 or fewer) / Out of stock), Type (Single products 32, Bundles 3, In a variant group 10), Category, Missing information (No photo, No SKU…), then one block per property (Colour with swatches, Material, Capacity "90 ml … 900 ml" in numeric order, Dishwasher safe, **Supplier** – internal properties are filterable in the backoffice), Price range |
| PL-2 | Type `stonewre` (typo) in the search box | Stoneware products (typo tolerance). Results update as you type |
| PL-3 | Search `MD-LINEN` | Linen Mug first (SKU search). Search `olaria` → the 10 products whose internal Supplier is "Olaria do Tejo" (internal properties are searchable in the backoffice only) |
| PL-4 | Search `350ml`, then `350 ml` | Both find the three 350 ml mugs |
| PL-5 | Tick **Colour → Sage**, then also **Sand** | Products with Sage **or** Sand. The counts of the *other* Colour values don't drop to 0 (each filter's counts ignore its own selection). Other filter groups' counts update |
| PL-6 | Keep Sage, tick **Category → Mugs & cups** | Only Linen Mug. Filters combine with AND across groups |
| PL-7 | Reload the page; copy the address into a new tab | Same search and filters: they live in the address |
| PL-8 | Clear filters. Tick **Type → Bundles** | 3 bundles. Price shows "sum of products" or "83% of €59.00" (Morning Ritual Box). Stock shows what can be sold now and **what limits it** ("limited by Linen Mug") |
| PL-9 | Tick **Missing information → No photo** | The 3 bundles (they have no photos of their own) |
| PL-10 | Sort by **Price, high to low**, then **Stock, low to high** | Sorted accordingly; Pasta Plate (0) first by stock |
| PL-11 | Tick two products: a bar appears ("2 selected · Show in shop · Hide · Move to category… · Link as variants · Clear selection"). **Hide** | "2 products updated." Both show *Hidden*; the Visibility counts change. Select them again → **Show in shop** |
| PL-12 | Select two products → **Move to category…** | Category changes for both |
| PL-13 | Clear selection. **Export ▾ → Spreadsheet (CSV)** with the Sage filter on | Downloads a CSV of *the filtered products only*, with columns `id, sku, type, name, visible, price, stock, category, description, images, attr:…, bundle_*, variant_*` |
| PL-14 | **Export ▾ → Spreadsheet (CSV with ; and decimal comma)** | Same with `;` and `24,00` (opens correctly in a European Excel) |
| PL-15 | No filters, nothing selected. **Export ▾ → Full backup (JSON)** | A `.json` file with categories, properties, variant groups and all products. Deleted products are included and flagged `"deleted": true` (the hint under the menu says so). Keep this file for IM-17 |
| PL-16 | Select 2 products → **Export ▾** | Hint says "Exports the selected products"; the file has just those 2 |

## 2. Properties

**Products → Properties**.

| Id | Steps | Expected |
|---|---|---|
| PR-1 | Look at the list | Each property: type, visibility (Public/Internal), where it's used ("shown · filter · search"), how many products have a value, and "tells variants apart in …" for differentiators |
| PR-2 | **+ New property**: name "Finish", type **One choice**, values Matte, Satin, Glossy, Public, "Shoppers can filter by it" on | Created; key `finish` shown (fixed after creation) |
| PR-3 | Edit **Colour**: move **Moss** to the top with ↑ | Saved. On http://localhost:3000/shop the Colour filter lists Moss first (filters follow the order you set) |
| PR-4 | Edit **Capacity**: change the type | Not possible: "The type can't change while products have a value" |
| PR-5 | Edit **Supplier**: note it's Internal | Open any product page in the shop: no supplier anywhere (page, filters, search for `olaria` in the shop finds nothing) |
| PR-6 | Try to **Delete** "Colors" | Refused: it tells variants apart in "Example jacket" |
| PR-7 | **Delete** "Finish" (no product uses it) | Button turns into "Click to confirm"; second click deletes |
| PR-8 | **Delete** Material (23 products have a value) | The button says "Clear 23 values and delete" – it clears the values from every product, then deletes |

## 3. Product editor and SKUs

| Id | Steps | Expected |
|---|---|---|
| ED-1 | **+ New product**: name "Test cup", price 12, stock 5, SKU `md-linen-mug` | Refused: "sku: already used by Linen Mug" (SKUs are unique, case-insensitive) |
| ED-2 | SKU `TEST CUP!` | Refused: "1 to 64 letters, digits, dots, dashes or underscores" |
| ED-3 | SKU `TEST-CUP`, Colour Sand, Capacity 200, save | Saved; visible by default ("Visible in the shop" is on) |
| ED-4 | Edit Test cup, price `12.345` | Refused: "price: can have at most 2 decimals" |
| ED-5 | Open the same product in two tabs; change the price in tab 1, save; change the name in tab 2, save | Tab 2 is refused ("changed by someone else… reload"), nothing is overwritten |
| ED-6 | Upload a `.txt` renamed to `.png` as a photo | Refused (content is checked, not the name) |

## 4. Product lifecycle: hide → delete → restore

Products are never removed from the database (owner decision S-4).

| Id | Steps | Expected |
|---|---|---|
| LC-1 | On **Salt Cellar** (in the Morning Ritual Box bundle) there is no "Delete" | Only visible products' **Hide** is offered. Delete appears once it's hidden |
| LC-2 | **Hide** Salt Cellar → **Delete** | Confirmation page "Delete Salt Cellar?" listing what uses it: "It is part of a bundle" – Morning Ritual Box with **Keep selling it with Salt Cellar** / **Hide the bundle**; unshipped orders that contain it (not changed); offers that name it. **Delete product** stays disabled ("Choose for 1 more bundle") until you choose |
| LC-3 | Choose **Keep selling**, delete | Back to the list; a discreet **Deleted products (1)** link at the bottom. In the shop, Morning Ritual Box is still for sale and still lists the salt cellar (B-4/L-1: the owner decides) |
| LC-4 | Open **Deleted products** → **Restore** Salt Cellar | "was restored"; it comes back **hidden**. Show it again |
| LC-5 | Repeat LC-2 with **Hide the bundle** | The bundle is hidden too. Restore and show both afterwards |
| LC-6 | (API) Try to delete a visible product: `curl -X DELETE` (see §11) | 409 "Hide this product from the shop before deleting it." |
| LC-7 | Delete a member of a variant group (e.g. hide+delete **Example jacket 6**) | The confirmation page says which variant values disappear from the group |

## 5. Bundles

### 5.1 Backoffice

| Id | Steps | Expected |
|---|---|---|
| BU-1 | Edit **Breakfast for Two** | "What's in the bundle" with quantities and each product's stock. "Available now: 8 (limited by Linen Mug)". Price: **Sum of products** (updates when a product's price changes) |
| BU-2 | Change Linen Mug's price to 25 (edit Linen Mug) and reopen the bundle | Bundle price is now €154 (sum follows). Set it back to 24 |
| BU-3 | In the bundle, type a new price (e.g. 140) | Switches to a manual price: "Original price €152.00 · your price €140.00 = **92%** of it (…)" with a **Reset to sum** button. A price above the sum, or far below it, shows a warning |
| BU-4 | Add a product with "Add a product to the bundle" (type `bud`) | Appears with qty 1. Adding a product that is already in is not offered; bundles aren't offered (no bundles in bundles) |
| BU-5 | Remove products until one is left, save | Refused: "a bundle needs at least 2 different products" |
| BU-6 | New product → **Bundle** tab, add Linen Mug ×2, Dinner Plate ×1 | Price is the sum; stock field is replaced by "Available now" (derived, B-1). Save as "Test bundle" |
| BU-7 | In a bundle: **Create an offer for this bundle** | Opens a new offer with this bundle preselected as the target |
| BU-8 | Toggle **Show on its products' pages** off on Breakfast for Two, save | The Linen Mug page no longer lists it under "As seen in these bundles" |

### 5.2 Shop, cart, checkout, orders

| Id | Steps | Expected |
|---|---|---|
| BU-9 | Shop → **Morning Ritual Box** | "What's in the set" with each product, and the saving ("Save €10.00" compared with buying them separately) |
| BU-10 | Shop → **Linen Mug** | "As seen in these bundles": Breakfast for Two. (Out-of-stock bundles stay listed – your decision) |
| BU-11 | Add Morning Ritual Box to the cart | Cart line shows "Includes: 1 × Tall Latte Mug, 1 × Dipping Bowl, 1 × Salt Cellar" |
| BU-12 | Quantity: try to buy 15 Morning Ritual Boxes | The quantity field on the product page stops at 14 (limited by Tall Latte Mug). Raising it in the cart is refused at checkout: "Please check your cart – not enough Tall Latte Mug for Morning Ritual Box" |
| BU-13 | Place an order (any name/email/address) | The confirmation lists what's inside. Backoffice → **Orders**: the line shows the contents with SKUs. **Products**: Tall Latte Mug, Dipping Bowl, Salt Cellar stock went down by 1 each |
| BU-14 | **Offers on bundles (B-2).** Anonymous cart with Breakfast for Two + Flower Corner | No offer on either (no running shop-wide offer for everyone) |
| BU-15 | Sign in as **Jonas** (trade, 30% off everything), same cart | 30% off **Flower Corner only** (its "Shop-wide and category offers also apply" is on). Breakfast for Two stays €152 |
| BU-16 | Anonymous cart: Flower Corner ×2 (€168) | "€10 off orders over €150" applies |
| BU-17 | **Bundles count towards minimums (Q-3).** Anonymous cart: Breakfast for Two + Dinner Plate (€184) | "€10 off orders over €150" applies: the bundle counts towards the €150, but the €10 comes off the Dinner Plate only (the bundle itself is never discounted by a shop-wide offer) |
| BU-18 | Anonymous cart: Breakfast for Two alone (€152) | No discount: over €150, but nothing in the order can take a shop-wide offer |
| BU-19 | Edit Breakfast for Two | Under "Shop-wide and category offers also apply": "It still counts towards order minimums such as "orders over €100"." |

## 6. Variants

### 6.1 Your example (Example jacket 1–7)

| Product | Colors | Size | Gender | Temperature |
|---|---|---|---|---|
| Example jacket 1 | White | 10 | Female | 10º |
| Example jacket 2 | Black | 10 | Female | 10º |
| Example jacket 3 | White | 20 | Female | 10º |
| Example jacket 4 | White | 30 | Female | 10º |
| Example jacket 5 | White | 10 | Female | 30º |
| Example jacket 6 | Black | 10 | Female | 30º |
| Example jacket 7 | White | 20 | Male | 10º |

Rule: a value is a link when changing **only that property** leads to a product. Otherwise it's shown disabled.

| Id | Steps | Expected |
|---|---|---|
| VA-1 | Shop → category "Jackets (variant example)" | 7 cards: every variant is its own card (V-6) |
| VA-2 | Open **Example jacket 1** | Colors: **White** selected, Black → jacket 2. Size: **10** selected, 20 → jacket 3, 30 → jacket 4. Gender: Female selected, **Male disabled** (White/10/Male doesn't exist). Temperature: 10º selected, 30º → jacket 5 |
| VA-3 | From jacket 1 click Size **20**, then Gender **Male** | Jacket 3, then jacket 7. On jacket 7: Size 10 and 30 are **disabled** (White/10/Male and White/30/Male don't exist), Female → jacket 3 |
| VA-4 | Open **Example jacket 6** | Colors White → jacket 5; Temperature 10º → jacket 2; Size 20/30 disabled; Male disabled |
| VA-5 | Each selector button has a label such as "Size: 20" (screen readers) and the selected one is marked as current | – |

### 6.2 Backoffice

| Id | Steps | Expected |
|---|---|---|
| VA-6 | Products → filter **Type → In a variant group** | 10 products, each tagged "Variants: …" |
| VA-7 | Edit **Example jacket 5** → Variants panel | Table of the 7 products with their values, ↑/↓ to order, Edit (opens that product), Remove |
| VA-8 | **Duplicate alert (V-3).** In jacket 5 change Temperature to `10º`, save | Refused, naming **Example jacket 1** (same values). Nothing is saved |
| VA-9 | **Missing value (V-7).** Edit jacket 7, clear Temperature, save | Saved. In the shop, jacket 7's Temperature shows **"-"** selected, and 10º is disabled (nothing is White/20/Male/10º any more). Put 10º back |
| VA-10 | **Hidden member.** Hide jacket 3 | On jacket 1's page, Size **20** is now disabled (hidden products are never linked) and keeps its place between 10 and 30. Show it again |
| VA-11 | **Add a variant.** In jacket 4's panel → **+ Add a variant** | A form "New variant (a hidden copy of this product)" opens with jacket 4's values and "Example jacket 4 already has these values. Change at least one." – **Create variant** is disabled. Name it "Example jacket 8", set Colors **Black** and Gender **Male** → Create: "Example jacket 8 was created (hidden until you show it)." (stock 0, no SKU) |
| VA-12 | **Unreachable warning.** Show jacket 8 (Edit → Visible in the shop → Save), reopen the panel | Warning: "Example jacket 8 can't be reached from the other variants by changing one property" (Black/30/Male differs from every product in at least two properties). In the shop it's its own card; its page can still switch to others where one change leads somewhere |
| VA-13 | **Link as variants.** Products list: select **Tall Latte Mug** and **Dune Espresso Cup** → **Link as variants** | The dialog ticks the properties that differ: Colour, Capacity, Dishwasher safe **and Supplier**. Supplier is internal, so: "Make Supplier public: shoppers need to see it to choose a variant" and **Link 2 products** is disabled. Untick Supplier → enabled. Untick Capacity and Dishwasher safe → the preview shows a Colour choice Oat / Sand. Name the group and link |
| VA-14 | Select **Dinner Plate** + **Stoneware Bowl** (both Oat) → Link as variants, keep only Colour | "Stoneware Bowl has the same Colour as Dinner Plate (Oat)." – **Link** is disabled (V-3) |
| VA-15 | Select **Flower Corner** + **Bud Vase** → Link as variants | Refused: "Flower Corner is a bundle; bundles can't be variants" |
| VA-16 | Edit Linen Mug → Variants → **Change properties** → tick Capacity | "Capacity has the same value on every product: it doesn't help shoppers choose." Cancel |
| VA-17 | **Dissolve group** on Everyday mug (click twice) | The three mugs become independent products again |
| VA-18 | **Offers: "+ all variants".** Discounts → new offer → target products → search "jacket" | Each result in a variant group has **+ all variants**; one click adds every jacket of the group |
| VA-19 | **Value order (open question Q-1).** Properties → Colour: move Speckled white to the top. Open Linen Mug in the shop | The **filters** now list Speckled white first, but the **variant selector** still shows Sage, Ink blue, Speckled white (the order of the products in the group). This is what Q-1 is about |
| VA-20 | **"-" is always last.** Edit **Example jacket 1**, set Gender to "-" (no value), save. Open it in the shop | Gender: Female (disabled) · Male (disabled) · **-** (selected), last, although jacket 1 is the first product of the group. On jacket 3: Female (selected) · Male → jacket 7 · - (disabled). Put Female back |

## 7. Shop search and filters

| Id | Steps | Expected |
|---|---|---|
| SR-1 | http://localhost:3000/shop | All products, 24 per page with numbered pages; filters (Category, Colour with swatches, Capacity, Dishwasher safe, Price, Availability); result count; Sort by |
| SR-2 | Tick Colour **Sand** | The page updates without a reload button (JS). The address has `f.colour=sand`. A chip "Sand" appears; clicking it removes the filter |
| SR-3 | Search box: `stonewre` | "Showing results for **stoneware**" |
| SR-4 | Search `mug 350`, then `350ml` | Linen Mug and Night Market Mug: their descriptions say "350 ml" (every word must match; `350ml` also finds "350 ml"). Speckle Mug is 350 ml too, but only as the Capacity property, and Capacity isn't "Found by the shop search". Tick that in Properties → Capacity and it's found as well (the backoffice search already finds all three) |
| SR-5 | Search `olaria` or `MD-LINEN-MUG` | Nothing: internal properties and SKUs are not searchable in the shop |
| SR-6 | Search `zzzz` | "Nothing matches …. Try a different search" |
| SR-7 | **Price order, anonymous.** Sort by **Price, low to high** | First: Dune Espresso Cup (€12.80 with the mugs winter sale), then Dipping Bowl (€14.00). The order uses the **prices you pay** |
| SR-8 | **Price order, Priya.** Sign in as Priya (Shop → Account), sort by price again | First: **Dipping Bowl €10.50** (her 25% on bowls), then Dune Espresso Cup. Same address, different order: personal prices come from `/api/shop/search`, never from the cached page (S-2a) |
| SR-9 | **Without JavaScript** (DevTools → Disable JavaScript, reload) | Filters show an **Apply** button and work as a normal form. Sorting by price uses **list prices** (Dipping Bowl €14, Dune Espresso Cup €16…) and says so |
| SR-10 | View the page source of a filtered page (`/shop?f.colour=sand`) | `<meta name="robots" content="noindex,follow">` and a canonical link to the unfiltered page. The plain `/shop` has no noindex |
| SR-11 | Category page `/shop/category/bowls` | Same filters without the Category filter |
| SR-12 | Filter Capacity **350 ml** + Availability **In stock** | Combined; the counts next to each value stay meaningful |
| SR-13 | Out-of-stock product (Pasta Plate) | Listed and marked "Out of stock" |
| SR-14 | **Suggestions.** In any search box (e.g. on /shop) type `mug` slowly | After 2 letters a list opens: **Products** (up to 6, with photos) and **Categories** ("“mug” in Mugs & cups 6", up to 3), then "All results for “mug”". No prices (they're the same for everyone) |
| SR-15 | Keyboard: ↓ ↓ then Enter; type again, then Escape | Enter opens the highlighted product; Escape closes the list. A screen reader announces a combo box with a list of options |
| SR-16 | Type `stonewre` | "Showing results for **stoneware**" at the top of the list; the categories say "“stoneware” in …" |
| SR-17 | Type `olaria`, `secret`, or a hidden product's name | No product suggestions: internal properties and hidden products never appear (C2). "No suggestions. Search for “olaria”" |
| SR-18 | **Searches with no results.** Search the shop for `teapot` (twice), `jane@example.com`, and `teapot` with a filter ticked | Backoffice → **Insights** → "Shop searches that found nothing": `teapot` 2 times, "still nothing". The email address isn't kept (personal data), and the filtered search doesn't count. Create a product called "Teapot" and reload: "finds 1 product" (links to the backoffice search). CSV download available |

## 8. Import

Files are in `docs/test-guide/`. Go to **Products → Import**. Every import has four steps:

1. **File**
2. **Columns** – mapping and options
3. **Preview** – tabs New / Changed / Problems / Deleted products / Unchanged
4. **Done** – result and a CSV report

Nothing is written before **Apply import**.

| Id | File | Steps | Expected |
|---|---|---|---|
| IM-1 | `01-new-and-updates.csv`: semicolons, decimal comma, server images, a new property, 2 bad rows | Upload | "01-new-and-updates.csv · 6 products – semicolons, decimal ",", utf-8". Columns matched automatically: sku, name, price… **Colour → Colour**, **Capacity → Capacity**, **visible → Visible in the shop**, **Glaze finish → Don't import** (unknown column) |
| IM-2 | same | Set **Glaze finish → New property**, type **One choice**. **Preview** | New 2 · Changed 1 · Problems 3. A **New properties** table: Glaze finish · One choice · 4 products · In the shop: ☐ Public (unticked: new properties are internal, C25). Tick **Public**: the preview is made again and the box stays ticked (after applying, Glaze finish shows on product pages). Note "New values: colour: Deep teal". **Problems**: Ink Bowl – `unknown category "Serving bowls"`; Price typo – `must be a price like 12,50 … got "12.345,00"` (one message); Fake photo – `Image not found or not allowed: fake.png` (SVG text disguised as PNG). **Changed**: Linen Mug – price 24 → 25.5, stock 16 → 20, Glaze finish — → satin |
| IM-3 | same | **← Change columns or options**, tick **Create categories that don't exist yet**, Preview | New 3 · Changed 1 · Problems 2 |
| IM-4 | same | **Apply import** | "Import finished": Created 3 · Updated 1 · Not imported 2. Sand Mug has the picture from the server folder (copied into the uploads). **Moss Mug is hidden** (its `visible` cell says no). The others are visible (the default). **Download report (CSV)** lists every row with its outcome |
| IM-5 | `02-prestashop-export.csv` | Upload | Recognised as **PrestaShop 1.7 / 8 products CSV**: "Name *", "Reference #", "Price tax excluded", "Active (0/1)", "Quantity"… are mapped; Product ID and Summary ignored |
| IM-6 | same | Tick "Create categories…", Preview, Apply | Each row warns "HTML in the description was converted to plain text". Category = the **last** of the PrestaShop list ("Home,Kitchen,Vases & planters" → Vases & planters; "Home,Kitchen" → a new "Kitchen"). Butter Dish is hidden (Active 0). In the shop, Olive Oil Cruet's description is plain text ("A hand-thrown cruet with a cork stopper. / 250 ml / Food safe glaze"); the `<script>` and the `<img onerror>` are gone |
| IM-7 | `03-bundles-and-variants.csv` (do it before IM-10) | Preview | New 3 · Changed 1 · Problems 3. New: Tea for One (bundle, sum), Candle Night (bundle, manual €39, offers "all"), Espresso Cup Sage. Changed: Dune Espresso Cup – "variant group — → espresso-cup, variant position — → 0". Problems: Bundle in a bundle – "MD-BREAKFAST-FOR-TWO is a bundle; bundles can't contain bundles"; Espresso Cup Ink and Espresso Cup Ink (again) – "same Colour as … (Ink blue): not added" (V-3: both are refused; which one should win is your call) |
| IM-8 | same | Apply | Created 3 · Updated 1 · Not imported 3. A variant group "Dune Espresso Cup" (named after its position-0 product; rename it in the Variants panel) with Sand and Sage: both shop pages show the colour choice. Tea for One (€42) is "limited by Tall Latte Mug" |
| IM-9 | `04-price-update.csv` | Options: **Only update existing products**. Preview | Changed 4 · Problems 1. The rows show the product names although the file has only SKU and price. Problem: "MD-UNKNOWN-SKU – no product with this id or SKU (the import only updates existing products)" (only that message). Warnings: **Moon Vase** "price changes by more than 50% (68.00 → 120.00)"; **Salt Cellar** "price set to 0 (was 19.00)". **Cancel import** (don't apply this one) |
| IM-10 | `05-deleted-match.csv` | First hide + delete **Serving Platter** and **Planter with Saucer** (§4). Upload, Preview | Summary: "Match deleted products 2 – 2 to decide"; the **Deleted products** tab opens. Each row: "Deleted product Serving Platter (deleted …)" with **Restore and update / Create a new product / Skip**, and buttons to decide for all rows at once. No "SKU already used" errors. **Apply import** is disabled until every row has a choice |
| IM-11 | same | Row 1 → **Restore and update**, row 2 → **Create a new product**. Apply | Created 1 · Updated 1 · Restored 1. Serving Platter is back (hidden, €74). A **new** "Planter with Saucer (new glaze)" has SKU `MD-PLANTER-WITH-SAUCER`. The old planter stays in Deleted products without a SKU; its former SKU is kept for reference. Restoring it later brings it back without a SKU |
| IM-12 | `06-security.csv` | Preview | `attr:__proto__` and `attr:constructor` columns → **Don't import** (reserved names). Problems: `../../.env.demo`, `/etc/passwd`, `/uploads/../../.env.demo` → all "Image not found or not allowed" (the same message, so nobody can probe which files exist); `http://…` → "Only https:// image addresses can be used" |
| IM-13 | same | Apply, then **Export ▾ → Spreadsheet (CSV)** and open it in a spreadsheet | The name `=HYPERLINK(…)` and the description `+cmd…` are exported as `'=HYPERLINK…` / `'+cmd…`: the spreadsheet shows text and runs no formula. In the shop, the product named `<img src=x onerror=…>` shows that text literally (no image, no script) |
| IM-14 | `04-price-update.csv` | Options: **Products not in the file → Hide them from the shop**, Preview | On a fresh demo: "31 products not in the file will be hidden." More than half the catalogue, so a checkbox "Yes, hide 31 of my 35 products" must be ticked before **Apply import** works. Cancel unless you want to try it (reversible with bulk **Show in shop**) |
| IM-15 | export → edit → import | Export CSV (PL-13, no filters), change Side Plate's price in the file, import it | Preview: Changed 1 (price 24 → 25), everything else Unchanged – a round trip changes nothing else |
| IM-16 | stale preview | Preview a price file, then change the same product's price in the editor, then Apply | That row: "changed (or sold) since your preview: not applied. Preview again to apply it." Other rows are applied |

### 8.1 Backup into another shop (IM-17)

This tests the full JSON backup (A-2) and your decision on Q-2 (option C: choose per property in the preview).

1. Main backoffice (4200): **Export ▾ → Full backup (JSON)** with no filters (PL-15).
2. Copy the images too: an OpenShop backup refers to images; it doesn't contain them.
   In a terminal: `cp -r demo-data/uploads/. demo-data/restore/uploads/`
3. Empty shop backoffice http://localhost:4201 → Products → Import → upload the JSON.
4. **Preview**. Expected:
   - every product is **New**, no problems;
   - new categories are listed;
   - a **New properties** table with a column "In the file" (Public / Internal) and "In the shop":
     - Colour, Colors, Size, Gender, Temperature: "Public: tells variants apart" (can't be unticked);
     - Material, Capacity, Dishwasher safe: "Public" in the file, **unticked** in the shop (C25: nothing becomes public
       without you);
     - Supplier: "Internal" in the file, unticked.
   - Click **Make public what was public in the file (3)** (3 on a fresh demo): Material, Capacity and Dishwasher safe get ticked (the
     preview is made again). Supplier stays internal.
5. **Apply**. Expected:
   - Products keep their ids: `http://localhost:3001/shop/product/<same id as on :3000>` works.
   - Bundles (also components without SKU) and variant groups work.
   - Deleted products are in "Deleted products".
6. Open http://localhost:3001/shop. Expected:
   - The variant selector works (Linen Mug ↔ Night Market Mug, Example jackets).
   - Details, filters and search are as in the main shop: Capacity and Dishwasher safe filters, Colour swatches, the
     "ml" unit. Properties → Supplier is Internal.
   - (Repeat with a fresh empty shop without clicking "Make public…": those properties are internal, as before.)
7. Import the same JSON again. Expected: everything Unchanged (idempotent).

### 8.2 Photos from other websites (IM-18 … IM-21)

`07-remote-images.csv` names photos by `https://` address and tries to make the server fetch from its own network
(SSRF). **The shop's server needs internet access** for the first rows; without it, every download row says "the
site's name can't be found" (the refusals below don't need the internet).

| Id | Steps | Expected |
|---|---|---|
| IM-18 | Upload `07-remote-images.csv`. In **Options**, "Photos from other websites (https://)" is **Download a copy into the shop**. Preview | Warning "1 photo will be downloaded from other websites and stored in the shop" (with internet; the same address counts once). Problems, each "Image not downloaded (…): address": Web page instead of a photo – "isn't a PNG, JPEG, WebP or GIF image"; Missing web photo – "the site answered 404"; Plain http – "only https:// addresses can be downloaded"; Server itself (`localhost`) – "isn't a public site"; Cloud metadata (`169.254.169.254`) – "use the site's name, not an IP address"; Name pointing to 127.0.0.1 (`127.0.0.1.nip.io`) – "isn't a public site" (the name is resolved and refused **before** any connection); Other port – "only the standard https port (443)"; Password in address – "… user name or password aren't allowed", and the password isn't repeated in the message |
| IM-19 | same | Apply | Web photo (PNG) has a photo at `/uploads/….png` (a copy). "Web photo twice" has the same `/uploads/` file twice (stored once) |
| IM-20 | same, again | Options: **Keep them as links**. Preview, Apply | Warning "a photo is linked from another site…"; the products keep the `https://` address (visitors' browsers load it from that site) |
| IM-21 | A second preview | Tick/untick an option and preview again | The other site is not asked again for 15 minutes (the answers are remembered per import) |

## 9. Page builder

| Id | Steps | Expected |
|---|---|---|
| PB-1 | **Pages → Product page → Edit design**. Widgets panel, "Shop widgets" | New widgets: Filters, Results bar, Product details, Variants, Bundle contents, In bundles |
| PB-2 | Delete the **Variants** widget from the product page, **Publish**, reload the builder | A banner: "New for this page: variant choices. Your design isn't changed until you add them." → **Add them** puts it back after Add to cart |
| PB-3 | Category page → the results grid | Has pagination on; Filters and Results bar above the grid |
| PB-4 | Move **Filters** to another column, publish, open the shop | Filters render where you put them; they still work with and without JS |

## 10. Owner decisions you can see

| Decision | Where to see it |
|---|---|
| B-1 stock derived from components | BU-1, BU-13 |
| B-2 shop-wide/category offers skip bundles by default | BU-14…17 |
| B-3 sum by default, manual override with % and reset | BU-2, BU-3 |
| B-4 hidden components allowed | LC-3 (bundle keeps selling with a hidden/deleted component) |
| I-1 CSV + JSON | §8 |
| I-2 server folder images | IM-4, IM-12 |
| I-3 `visible` column / new products visible by default | IM-4 |
| I-4 import never deletes | IM-14, IM-17 (deleted products from a backup go to Deleted products; a live product is never deleted by a file) |
| S-2/S-2a personal price order | SR-7…SR-9 |
| S-3 typo tolerance | PL-2, SR-3 |
| S-4 never hard-delete | §4 |
| V-3/V-4/V-6/V-7 | §6 |
| L-1/L-2 | LC-2…5, IM-10/11 |
| Q-2 option C: choose which new properties are public | IM-2, IM-17 |
| Q-3 bundles count towards order minimums | BU-17, BU-18 |
| Extras: photo downloads, suggestions, "no results" report | IM-18…21, SR-14…18 |

## 11. Terminal checks (security and API)

```bash
API=http://localhost:3000
TOKEN=$(curl -s $API/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"dune-admin-2026"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
```

| Id | Command | Expected |
|---|---|---|
| SC-1 | `curl -s $API/api/shop/products \| grep -ci "olaria\|kiln\|MD-"` | `0` – the public projection has no internal properties, no SKUs, no cost data |
| SC-2 | `curl -si "$API/api/shop/search?sort=price" \| grep -i "cache-control\|vary"` | `cache-control: private, no-store` and `vary: Cookie` (personal prices are never cached) |
| SC-3 | `curl -si "$API/shop?sort=price" \| grep -i cache-control` | `public, max-age=60` (the HTML has list prices only) |
| SC-4 | `for i in $(seq 1 80); do curl -s -o /dev/null -w "%{http_code} " "$API/api/shop/search?q=mug"; done` | After about 60 requests: `429` (rate limit per visitor) |
| SC-5 | `curl -s -o /dev/null -w "%{http_code}\n" $API/api/products` (no token) | `401` |
| SC-6 | `curl -s -X POST "$API/api/catalogue/imports?filename=x.csv" -H "authorization: Bearer $TOKEN" -H 'content-type: text/csv' --data-binary @/bin/ls` | `400`: "This doesn't look like a text file (it contains NUL bytes)…" – binary files are refused before parsing |
| SC-7 | `curl -s -X DELETE $API/api/products/<id of a visible product> -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}'` | `409 hide_first` |
| SC-8 | `curl -s "$API/search?q=%3Cscript%3Ealert(1)%3C/script%3E" \| grep -c "<script>alert"` | `0` (escaped) |
| SC-9 | `curl -s "$API/shop?f.colour=sand&f.__proto__=x&page=99999&sort=evil" -o /dev/null -w "%{http_code}\n"` | `200`; unknown parameters are ignored |
| SC-10 | `curl -s $API/api/catalogue/limits -H "authorization: Bearer $TOKEN"` | The limits this server uses (`IMPORT_MAX_MB` etc. change them at start) |
| SC-11 | `curl -si "$API/api/shop/suggest?q=mug" \| grep -i cache-control` and `curl -s "$API/api/shop/suggest?q=olaria"` | `public, max-age=60` (no personal data); the second returns no products |
| SC-12 | `for i in $(seq 1 150); do curl -s -o /dev/null -w "%{http_code} " "$API/api/shop/suggest?q=mug"; done` | `429` after about 120 quick requests (suggestions have their own, higher limit) |
| SC-13 | `curl -s "$API/api/reports/search-misses" -H "authorization: Bearer $TOKEN"` | The "no results" report as JSON (`-H 'accept: text/csv'` for CSV); without the token: `401` |

## 12. Open questions to look at while testing

- **Q-1 Order of variant values (VA-19, VA-20).** Decided: a switch per property ("as in the products", the default;
  "as in the property" for choice properties; A→Z). Built so far: "-" always last. The switch is planned for the next
  work session (see the plan, "Next work session").
- **Q-2 Property visibility when restoring a backup.** Decided: option C, built (IM-2, IM-17).
- **Q-3 Bundles and order minimums.** Decided: they count, built (BU-17, BU-18).
- **Q-4 Variants that differ in two properties from all others (VA-12).** Decided: nearest-match links plus a collapsed
  "See all versions" list. Planned for the next work session; until then VA-12 shows the "can't be reached" warning.

## 13. Automated tests

```bash
npm test                 # db 21, pricing 35, renderer 28, API 126 and backoffice 122 tests
npm run typecheck
# Browser suites need a throw-away instance (they place orders); see README "Run".
```

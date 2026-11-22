# OpenShop discounts engine: implementation plan (v2)

Status: v2 plan, implemented (phases P0–P4). See
"Implementation status" below. The plan includes the owner's decisions D1–D6, P-a and P-b, and three pushbacks: CSV by
`Accept` header, no legal guidance, and discounts loaded only through the API and shown by JavaScript.

## Implementation status

| Phase | Status |
|---|---|
| P0 Foundations | Done: token audiences + derived keys, `requireAuth` checks the user, `updateWhere` + `DuplicateKeyError` (contract-tested on SQLite; written for Mongo but not run here, no Mongo server available), strict validator for discount routes, money/time-zone/code helpers, shop settings, `Accept` negotiation, global `nosniff`, repository-wide `npm run typecheck`. |
| P1 Automatic offers + JS price layer | Done: engine, admin CRUD + audit, backoffice list/editor/preview, settings page, renderer hooks + "Offers" widget, `/assets/shop.js`, `/api/shop/prices` + `/api/shop/cart`, CSP update, one-time page re-render, order snapshots, orders column. |
| P2 Vouchers + limits | Done: codes (shared, generated single-use; JSON/CSV on one URL), order-phase offers, allocation, redemptions, total and per-customer limits (purchases, € budget with remainder, first N orders), scenarios and save-for-later, cart JSON API, failed-code throttling, exactly-once release on cancel, identity backfill for past orders. |
| P3 Customers + profiles | Done: customer accounts through owner-generated one-time links (activate / reset, 72 h, hash stored, single use), sign-in with throttling and constant-time checks, `cs` session cookie (HttpOnly, Secure, SameSite=Lax, 30 days, revocable with a session version), "sign out on all devices", client prices (audience = customers), discount profiles (live, with members and optional end dates, public label, pause), personal codes, "Your offers" page, one-click personal codes in the cart, signed-in checkout (account email and customer id), customer deletion with clean-up, backoffice Customers and Profiles screens, simulator for a signed-in customer. |
| P4 Insights | Done: Insights screen with KPIs (vs previous period), revenue/discount-cost chart per day, cost by offer and by campaign, **code-vs-automatic choices** (who picked the less favourable option and how much extra they paid, per code and per day), limited offers saved for later. Every report is JSON or CSV on the same URL. Demo history generator (`scripts/seed-history.ts`). |

### Tests and coverage (end of session)
| Component | Tests | Line coverage |
|---|---|---|
| `packages/db` | shared DataStore contract on SQLite, and on an in-memory stand-in for the MongoDB driver (real MongoDB with `MONGO_URL`) | 100% |
| `packages/pricing` | table tests, DST edge cases, 5,000 randomised carts | 100% |
| `packages/renderer` | rendering, escaping, shop hooks, editor samples | 99.8% (one unreachable `default:`) |
| `apps/api` | route-level integration tests (`app.inject`), rollback under simulated races, the real `main.ts` as a process | 100% |
| `apps/backoffice` | Angular unit tests (Vitest + jsdom), every screen | 99.95% (one unreachable `return null`) |
| `apps/api/assets/shop.js` | measured in a real browser during `scripts/e2e-storefront.py` | 99.4% (one defensive fallback) |

### Choice insights (how they are measured)
- A *choice* exists when a code that can't be combined competes with the automatic offers (both totals are shown).
- When a cart shows a choice, a `choice_events` record is created once per cart and code offer (no personal data).
  At checkout it records what the shopper picked, which option was cheapest and the extra paid. Orders placed
  through the JSON API are recorded at order time.
- The report per code shows: shoppers who had the choice, who then ordered (cancelled orders don't count), who took
  the best price, who chose the code although it cost more ("supporting" the code, e.g. an influencer), who chose
  the automatic offers although the code was cheaper, who didn't order, and the extra paid.

Deviations from the plan, and why:
- An end date in the past is a warning, not an error (otherwise any later edit of an ended offer would be refused).
- "Save for later" is a toggle per limited offer, and the alternative total shown is a full re-price (not a 2^n
  enumeration of scenarios). The code-vs-automatic choice is the only scenario pair.
- Added a "your total has changed" confirmation step: when a per-customer limit can only be checked once the email is
  known (guests), checkout shows the new total with a one-click "Place order for €X" instead of a dead end.
- Orders without offers can still be reopened after cancelling; only orders that used offers become final.
- Fixed along the way: the backoffice dev proxy sent `/settings` (any path starting with `/s`) to the API; test scripts
  used `node --test test/`, which Node 22.21 doesn't accept; two type errors in existing code.

## Known limitations (for the security review)
1. **JSON shop endpoints accept any content type and don't check `Origin`.** The urlencoded form parser is registered
   for the whole app, so `/api/shop/cart/*` could also be called by a cross-site HTML form. Today only
   `SameSite=Lax` on the cart cookie protects them. (Plan S10, deferred by the owner.)
2. **Identity hashing is unkeyed.** Per-customer usage is keyed by SHA-256 of the normalised email. It keeps emails out
   of ids and logs and survives restarts, but it is not secret. A keyed hash must use a key stored in the database,
   not `AUTH_SECRET` (random per restart when unset, which would reset every limit). (Deferred by the owner.)
3. Guest per-customer limits are best effort: they follow the typed email (a different address gets around them), and
   the "total changed" step can reveal to someone typing another person's email that a limit applies to it.
4. Throttles (failed codes, login) are per process and per `req.ip`; behind a proxy without `trustProxy` all visitors
   share one IP.
5. The order confirmation page is reachable by anyone with the order id (unchanged behaviour).
6. The Mongo adapter runs the full contract against an in-memory stand-in for the driver (its own logic: id mapping,
   filters, duplicate keys, conditional updates). Real MongoDB semantics, including atomicity under concurrency, are
   only verified when the contract runs with `MONGO_URL`, which wasn't possible in this environment.
7. The account forms (sign in, sign out, set password) don't check `Origin` either (same class as item 1).
8. The session cookie is `Secure`: the shop must be served over HTTPS (browsers also accept it on `localhost`).
9. Without `SHOP_URL`, the backoffice builds account links from its own address; set `SHOP_URL` when the shop and
   the backoffice are on different addresses.
10. Deleting a customer keeps their orders (business records, with name, email and address) and the hashed usage
    counters (so per-customer limits still hold).
11. Choice insights only count carts where both options saved something (otherwise there was nothing to choose), and
    shoppers who never entered a code are not part of them.

## 0. How the current code shapes this plan

| # | Finding | Where | Consequence |
|---|---|---|---|
| F1 | Shoppers have no accounts. `placeOrder` finds customers by the email typed at checkout and **overwrites** their name and address. | `apps/api/src/orders.ts` | A typed email is not an identity. Customer and profile offers require sign-in. Per-customer limits for guests can only be best effort. |
| F2 | Admin tokens have no role. `requireAuth` accepts any token signed with `AUTH_SECRET`. | `auth.ts`, `app.ts` | Shopper sessions need a separate audience and signing key, or every shopper would be an admin. |
| F3 | `DataStore` has no transactions, atomic counters, unique indexes or array-contains queries. Stock uses an in-process `locked()` queue. | `packages/db`, `orders.ts` | Add an atomic conditional `updateWhere`. Use deterministic IDs so the primary key guarantees uniqueness. |
| F4 | Prices are float euros; totals use `Math.round(price*100)`. | `orders.ts`, `storefront.ts` | The engine works only in integer cents and basis points. |
| F5 | The storefront has no JavaScript and `default-src 'none'`. Custom pages are stored as static HTML. | `storefront.ts`, `renderer` | **Discount data never goes into HTML.** A first-party script loads it from the API (owner decision). Needs a CSP change. |
| F6 | Fastify 5 uses `removeAdditional: true`, so `additionalProperties:false` silently drops unknown fields. | `app.ts` | Discount routes must reject unknown fields. Otherwise a typo like `endAt` makes an offer that never ends. |
| F7 | The `application/x-www-form-urlencoded` parser is registered on the whole app. | `storefront.ts:28` | New JSON shop endpoints must require `application/json`, or a cross-site HTML form could call them. |
| F8 | Order status can move between any values. Cancelling does not restock. | `PATCH /api/orders/:id` | Redemptions, budgets and order counts must be released exactly once on cancel. Cancelled orders with discounts become final. |
| F9 | Without `AUTH_SECRET`, a random secret is generated on every restart. | `main.ts` | Anything that must stay stable (identity hashing) uses a key persisted in settings, not `AUTH_SECRET`. |
| F10 | One shop per deployment, one admin role. | `types.ts` | "Owner" means admin user. A hosted multi-tenant version would need `shopId` scoping everywhere. |

---

# 1. Business value

## 1.1 Goal
One flexible engine covering catalog price rules, cart rules or vouchers, per-client prices and customer groups (the
PrestaShop concepts), run by owners with no developer, and **transparent** to shoppers. Shoppers always see where each
discount comes from and what the other options would cost.

## 1.2 Requirements and how they are delivered

| Requirement | Delivered as | Phase |
|---|---|---|
| Backoffice management | Discounts section (offers, vouchers, profiles), customers, shop settings (time zone, display), simulator, reports | P1–P4 |
| Checkout selection | Cart panel (JS from API): enter a code, pick from "your offers", compare **scenarios** with totals, keep limited offers for later | P2–P3 |
| Client special price | Audience = specific customers (sign-in is always required) | P3 |
| Product special price | Target = products or categories | P1 |
| Whole-shop price | Target = all | P1 |
| Voucher | Trigger = code, either one shared code or many single-use codes | P2 |
| Optional dates | Start defaults to now, end defaults to never, past starts allowed, **in the shop time zone** (D6) | P0–P1 |
| Products / categories / all, % or fixed | Five effect × scope combinations, all supported (D1) | P1–P2 |
| Discount profiles | A profile is a live group: editing it changes it for every member (D2) | P3 |
| Guests or signed-in only (D4) | `access.requiresSignIn` per offer | P2–P3 |
| Max N purchases per user (D4) | `perCustomer.maxOrders` | P2 |
| Max € across purchases per user (D4) | `perCustomer.maxAmountCents`, a budget that can be partly used | P2 |
| Only the user's first N orders (D4) | `perCustomer.firstOrders` | P2 |
| Shop time zone (D6) | `settings.timezone` (IANA). Offers end at the same instant for everyone. | P0 |

**One model, presets on top.** In the backoffice the four entity types are cards that prefill
*who* (audience) × *what* (target) × *trigger* (automatic or code). There is a single engine underneath.

| Card | Audience | Target | Trigger | Sign-in |
|---|---|---|---|---|
| Shop-wide sale | everyone | all | automatic | optional |
| Product / category price | everyone | products / categories | automatic | optional |
| Client special price | customers | any | automatic | **forced** |
| Voucher | everyone / customers | any | code | optional / forced |
| Profile rule | profile members | any | automatic | **forced** |

## 1.3 Example use cases (demo shop Maison Dune)
1. Winter sale, −20% on Mugs, from 1 Dec 00:00 to 1 Jan 00:00 **Lisbon time**, the same instant worldwide.
2. Bud Vase at a fixed €19 (normally €29), from now, never ending.
3. `WELCOME10`: −10% over €40, **only on the shopper's first order**, guests allowed.
4. 200 single-use influencer codes, €5 off, exported as CSV via `Accept: text/csv`.
5. Trade profile: −30% on everything plus Linen Mug at €18. Editing the profile updates all 12 members.
6. Loyalty: −15% on tableware, **max €50 of discount per customer across all purchases**, signed-in only. The shopper can
   "save it for later".
7. VIP client: a personal price created with a start date last week. Orders already placed are never repriced.

## 1.4 Shopper transparency (D3)
- **Product pages and grids:** the discounted price, the original price struck through (can be turned off), and a "from"
  label (*Winter sale*, *Your member price: Trade*, *Your personal price*). Other offers that also apply are listed with
  the price each would give.
- **Cart:** per line, the applied offer and an expandable "2 offers apply" list with the price under each. For the
  order, **scenario cards** such as *"Automatic offers: €81.60 (save €20.40), best"* and *"Code WELCOME10: €84.00
  (save €18.00)"*. The best one is preselected and the shopper can switch.
- **Limited offers** (budget or N uses) show what remains (*"€12 of €50 left"*) and a *"Save for later"* toggle.
- Only shopper-facing labels are shown. Internal offer and profile names never reach the storefront.

## 1.5 Scope
- **In v1:** everything above, total and per-customer limits, minimum order value, priority, combining rules, order
  snapshots, reports, simulator, display settings.
- **Not in v1:**
  - Buy-X-get-Y, bundles, and a fixed price for a whole order.
  - Free shipping (there is no shipping yet) and taxes (none yet, but per-line allocations are ready for them).
  - Gift cards and multi-currency.
  - Self-service shopper sign-up (there is no email, D5).

## 1.6 Metrics
- Revenue and conversion lift during campaigns.
- Average order value on vouchers with a minimum.
- Redemption rate.
- Discount cost as a share of revenue.
- Repeat rate of profile members.
- First-order conversion for new shoppers.
- Time to create a campaign: under 2 minutes.
- "Code doesn't work" support tickets.

## 1.7 Business risks and safeguards

| Risk | Safeguard |
|---|---|
| Margin loss | Warnings above 50% off or a fixed price below 50% of list price, maximum discount per order, simulator, pause button |
| Code leaks | Single-use codes, total caps, per-customer limits, sign-in required |
| Guests bypassing per-customer limits with another email | Clear warning in the editor. "Signed-in only" gives strict limits. |
| Confusion about prices | Source labels, alternatives, scenario totals, reasons when a code is rejected |
| Backdated offers leading to refund requests | Existing orders are never repriced. Refunds stay manual. |
| Time-zone mistakes | All times are entered and shown in the shop time zone, with the owner's local time next to it. Changing the time zone shows which offers it affects before saving. |
| Shoppers without JavaScript | List prices are shown, with a `<noscript>` notice. Automatic offers are still applied at checkout and shown on the order confirmation. |

**Legal and regulatory note:** OpenShop provides neutral, configurable tools (for example, whether to show the original
price or a % badge). It does not give legal advice or claim compliance with any jurisdiction. Compliance with local law
is the shop owner's responsibility. The documentation will say only this.

## 1.8 Roadmap (rough, one developer)

| Phase | Delivers | Effort |
|---|---|---|
| P0 Foundations | Token audiences, `updateWhere`, strict validation, money helpers, settings (time zone, identity key), time-zone conversion helper, content negotiation, global `nosniff` | 4–5 days |
| P1 Automatic offers + JS price layer | Engine line phase with transparency, admin CRUD and audit, editor in the shop time zone, settings page, renderer hooks and Offers widget, `shop.js`, prices and quote API, CSP update, order snapshot | 9–11 days |
| P2 Vouchers + limits | Codes (JSON/CSV by `Accept`), order phase, redemptions, total and per-customer limits (orders, budget, first orders), scenarios and saving offers for later, cart JSON API, rate limits, cancel release | 7–9 days |
| P3 Customers + profiles | Accounts through owner-generated links, sessions, sign-in enforcement, customer and profile audiences, members, "your offers", Customers screens | 8–10 days |
| P4 Insights | Reports (JSON/CSV), simulator screen, demo seed data, docs | 3–4 days |

## 1.9 Owner decisions (recorded)
- **D1:** all effects: percent, amount off and fixed price.
- **D2:** profiles are live references.
- **D3:** best price per line, at most one code per order (optionally combinable with automatic offers), and full
  transparency.
- **D4:** sign-in required or guests allowed, set per offer. Per-customer max orders, max € budget, and first N orders.
- **D5:** no email server, ever.
- **D6:** one shop time zone, and boundaries are the same instant for everyone.

- **P-a:** when a budget offer has less left than the full discount, the remainder is applied.
- **P-b:** cancelled orders don't count towards "first N orders"; guest orders placed before an account existed do count.

---

# 2. Technical depth

## 2.1 Architecture

```
packages/pricing   NEW, pure (no I/O), shared by API and backoffice
  model.ts         types, normalizeDiscount(), normalizeProfile()   (second validation layer, like normalizeDoc)
  engine.ts        price(input) -> result, deterministic, `now` passed in
  money.ts         cents/bp arithmetic, largest-remainder allocation
  zoned.ts         shop-local wall clock <-> UTC instant (Intl based, handles DST gaps and overlaps)
  codes.ts         normalizeCode(), generateCode()
packages/db        + updateWhere(), + DuplicateKeyError   (contract-tested on SQLite and Mongo)
packages/renderer  + price hooks (data attributes), + "productOffers" widget, + <script src="/assets/shop.js" defer>
                   NO discount data, ever
apps/api
  settings.ts      shop settings (time zone, display, identity key)
  discounts.ts     admin routes, repository, in-memory candidate cache, audit
  shop-pricing.ts  public JSON API: prices, cart quote, codes, selection
  customers.ts     accounts via owner links, sessions, profile membership
  orders.ts        placeOrder(): pricing + limits + redemption inside locked()
  negotiate.ts     Accept-header negotiation helper
  assets/shop.js   storefront script, plain JS with // @ts-check (like backoffice/public/builder-frame.js)
apps/backoffice    Discounts, Profiles, Customers, Settings; preview and simulator via @openshop/pricing
```

**Rule:** the browser never computes a price. `shop.js` only *displays* what the API returns. Every amount that is
charged is computed on the server in `placeOrder`.

## 2.2 Data model

```ts
type Cents = number;   // integer
type Bp = number;      // basis points, 1% = 100

type Audience =
  | { type: "everyone" }
  | { type: "customers"; customerIds: string[] }      // ≤ 1000
  | { type: "profiles"; profileIds: string[] };       // ≤ 50
type Target =
  | { type: "all" }
  | { type: "products"; productIds: string[] }        // ≤ 1000
  | { type: "categories"; categoryIds: string[] };    // ≤ 200
type Effect =
  | { type: "percent"; bp: Bp }                       // 1..10000
  | { type: "amountOff"; cents: Cents }               // 1..1e9
  | { type: "fixedPrice"; cents: Cents };             // 0..1e9

interface Discount extends Doc {
  name: string;                        // internal only, ≤ 120
  label: string;                       // shopper-facing, ≤ 80
  trigger: "automatic" | "code";
  scope: "line" | "order";
  audience: Audience; target: Target; excludeProductIds: string[];
  effect: Effect;
  conditions: { minSubtotalCents: Cents | null; minQty: number | null };
  access: { requiresSignIn: boolean };             // forced true when audience is customers or profiles
  perCustomer: {
    maxOrders: number | null;                      // N purchases with this discount
    maxAmountCents: Cents | null;                  // € budget across purchases
    firstOrders: number | null;                    // only if the customer has placed fewer than N orders
  };
  declinable: boolean;                             // shopper may "save for later" (default true if perCustomer set)
  limits: { totalUses: number | null; maxDiscountPerOrderCents: Cents | null };
  schedule: { start: string; end: string | null }; // wall clock in the shop time zone, "YYYY-MM-DDTHH:mm"
  startsAt: string; endsAt: string | null;         // derived UTC instants, the only values the engine uses
  status: "active" | "paused" | "archived";
  priority: number;                                // 0..1000, tie-break
  combinable: boolean;                             // code offers: may combine with automatic ones
  usedCount: number;                               // changed only via updateWhere
  campaign?: string;                               // free tag for grouping and reports
  createdAt: string; updatedAt: string; createdBy: string; version: number;
}
```

**Effect × scope (D1: every combination that has a clear meaning):**

| | `line` (each unit of the matching products) | `order` (once, on the matching lines' total) |
|---|---|---|
| `percent` | −x% per unit | −x% of the matching total |
| `amountOff` | −€x per unit (never below 0) | −€x once (never above the matching total) |
| `fixedPrice` | each unit costs €x (**never raises a price**) | *rejected by validation: "fixed price for a set" is a future bundle feature* |

Other collections:

```ts
interface ShopSettings extends Doc {          // id "shop"
  timezone: string;                           // IANA, validated against Intl.supportedValuesOf("timeZone")
  display: { showOriginalPrice: boolean; showBadge: boolean; showAlternatives: boolean };
  identityKey: string;                        // 32 random bytes (hex), created on first run, never exposed (F9)
  updatedAt: string; updatedBy: string;
}
interface VoucherCode extends Doc {           // id = normalised code, so the primary key guarantees uniqueness
  discountId: string; kind: "shared" | "single"; usedCount: number;
  assignedCustomerId: string | null;          // personal codes appear in "your offers"
  createdAt: string;
}
interface Identity extends Doc {              // id = HMAC-SHA256(identityKey, normalisedEmail)
  orders: number;                             // non-cancelled orders, used by firstOrders
}
interface DiscountUsage extends Doc {         // id = `${discountId}:${identityId}`
  orders: number; amountCents: Cents;         // used by maxOrders and maxAmountCents
}
interface Redemption extends Doc {            // id = `${discountId}:${orderId}`
  discountId: string; code: string | null; orderId: string; identityId: string;
  customerId: string | null; amountCents: Cents; state: "used" | "released"; at: string;
}
interface DiscountProfile extends Doc {
  name: string;                               // internal
  publicLabel: string;                        // shopper-facing, e.g. "Trade member price"
  description?: string; status: "active" | "paused"; createdAt: string; updatedAt: string;
}
// A profile's rules are Discounts with audience {type:"profiles", profileIds:[id]}: one editor, one engine path.
interface ProfileMember extends Doc {         // id = `${profileId}:${customerId}`
  profileId: string; customerId: string; validUntil: string | null; addedAt: string; addedBy: string;
}
interface AccountLink extends Doc {           // owner-generated activation / reset link (D5)
  customerId: string; purpose: "activate" | "reset"; tokenHash: string; expiresAt: string; usedAt: string | null;
}
interface AuditEntry extends Doc { at: string; userId: string; action: string; entity: string; entityId: string; before?: unknown; after?: unknown }
```

Changes to existing documents:

- `Customer += { passwordHash?, activatedAt?, sessionVersion }`
- `Cart += { codes: string[]; selection: { scenario: string | null; declined: string[] } }`
- `OrderLine += { listPrice, unitPrice, discounts: { discountId, label, cents }[] }`
- `Order += { subtotal, discountTotal, discounts: { discountId, label, source, code?, amount }[], customerId, identityId, pricingVersion: 1 }`

Old orders have none of these fields and are treated as "no discount" (no migration needed).

**Identity (D4):** `normalisedEmail` = trimmed, lower-cased, `+tag` removed from the local part. It is hashed with a
**persisted** key from settings (F9), so emails don't appear in document IDs or logs and the ledger survives restarts.
Signed-in customers and guests with the same email share one identity. Limits can't be bypassed by switching between
guest checkout and an account.

## 2.3 Time and the shop time zone (D6)
- `settings.timezone` is set in Settings. On first run it defaults to the server's zone, and the backoffice shows a banner
  until the owner confirms it.
- The owner enters **wall-clock times in the shop zone**. The form labels them ("Lisbon time, currently UTC+0") and shows
  the owner's browser time next to them if it differs.
- Conversion is done by `zoned.ts`, which is tested on DST edges:
  - **Spring forward (gap):** a time that doesn't exist (Lisbon, last Sunday of March, 01:00–02:00) moves forward to the
    first valid instant.
  - **Fall back (overlap):** a time that happens twice (Lisbon, last Sunday of October, 01:00–02:00) uses the **first**
    occurrence.
- **"Ends at midnight of 31 Dec"** is shown as *Last day: 31 Dec*, stored as `end = "2026-01-01T00:00"`. The active
  window is `[startsAt, endsAt)`, so it stops at exactly 00:00 Lisbon time for everyone.
- Defaults: `start` is now (in the shop zone, to the minute); `end: null` means never. Past starts are allowed and active
  immediately. An end in the past is allowed only together with `paused` or `archived`.
- **Changing the shop time zone:**
  1. `GET /api/settings/timezone-impact?tz=…` lists affected offers.
  2. Saving recomputes the instants, keeping wall-clock meaning: scheduled offers get both instants recomputed, running
     offers only `endsAt`, and ended offers are untouched.
  3. The change is audited.
- Only server time is used. The engine receives `now`; only the admin simulator may pass another time.
- Shoppers see end times in the shop zone ("Ends 31 Dec, 23:59 Lisbon time"), formatted by `shop.js` with
  `Intl.DateTimeFormat({ timeZone })`. Reports group by day in the shop zone.

## 2.4 Pricing engine

```ts
price(input: {
  now: number; timezone: string;
  lines: { productId; categoryId: string | null; listCents; qty }[];
  shopper: { identityId: string | null; customerId: string | null; signedIn: boolean; profileIds: string[] };
  candidates: Discount[];                        // from the cache
  codes: { code; discount; voucher }[];          // resolved from cart.codes
  ledger: { identityOrders: number; usage: Record<discountId, { orders; amountCents }> };
  selection: { scenario: string | null; declined: string[] };
}): PricingResult

interface PricingResult {
  lines: {
    productId; qty; listCents; unitCents; lineCents;
    appliedFrom: OfferRef | null;
    offers: (OfferRef & { unitCents; status: "applied" | "better_offer_applied" | "declined" | "not_in_scenario" })[];
    allocations: { discountId; cents }[];
  }[];
  subtotalCents; discountCents; totalCents;
  applied: (OfferRef & { code?: string; cents; remaining?: { orders?: number; amountCents?: Cents } })[];
  scenarios: { key; title; appliedIds: string[]; totalCents; savingsCents; best: boolean; selected: boolean }[];
  pending: (OfferRef & { note: "checked_at_checkout" })[];   // guest per-customer checks need the email
  rejectedCodes: { code; message }[];
  quote: string;                                           // hash of the selected scenario's result
}
type OfferRef = { discountId; label; source: "shop" | "product" | "category" | "customer" | "profile" | "code"; sourceLabel?: string };
```

1. **Eligibility.** An offer must pass every check:
   - Status and time window.
   - Audience: profile members need a signed-in customer, an active profile and `validUntil` not passed.
   - `requiresSignIn`.
   - Trigger: automatic, or its code is in the cart.
   - `totalUses`.
   - `perCustomer`, checked against the ledger:
     - `maxOrders`: usage orders must be below N.
     - `maxAmountCents`: the remaining budget must be above 0; the discount is later capped at the remaining amount.
     - `firstOrders`: identity orders must be below N.
   - If a guest's email is not known yet, per-customer checks are reported as `pending` and re-run in `placeOrder`.
2. **Line phase.** For each line, every matching line-scope offer proposes a unit price:
   - percent: `list − round(list·bp/10000)`
   - amountOff: `max(0, list − c)`
   - fixedPrice: `min(list, c)`

   The lowest price wins. Ties go to higher priority, then lower ID, so results are deterministic. All proposals are kept
   in `offers` for transparency. A budget cap reduces a line discount proportionally.
3. **Order phase.** At most one code per order.
   - The base is the matching lines after the line phase. The minimum order value is checked on that base.
   - The discount is capped by the order maximum and the remaining budget.
4. **Scenarios (D3).** The engine lists the combinations the shopper can choose between:
   - (a) the code versus automatic offers, when the code is not combinable;
   - (b) use or save each declinable limited offer.

   It produces at most 8 scenarios, each fully priced. The best is marked, and `selection.scenario` picks one (default:
   best).
5. **Allocation.** Order discounts are split across lines with the largest-remainder method, so allocations add up
   exactly.
6. **Invariants.** If any of these fails, the engine throws. It never returns a wrong price.
   - `0 ≤ unit ≤ list`
   - `0 ≤ total ≤ subtotal`
   - allocations add up exactly
   - a scenario's total equals a full re-run with that scenario

Shopper messages are generic (§3, S4). Internal reason codes (`unknown`, `expired`, `not_started`, `min_subtotal`,
`used_up`, `limit_per_customer`, `first_orders_only`, `sign_in_required`, `not_eligible`) are logged and shown only in
the admin simulator.

## 2.5 DataStore additions (P0)

```ts
class DuplicateKeyError extends Error {}
interface Collection<T> {
  /** Atomically applies set/inc only if doc `id` also matches `where`. Returns the updated doc, or null. */
  updateWhere(id: string, where: Filter, change: { set?: Partial<Omit<T, "id">>; inc?: Record<string, number> }): Promise<T | null>;
}
```
- **SQLite:** a single `UPDATE … SET data = json_set(data, '$.f', COALESCE(json_extract(data,'$.f'),0) + ?) WHERE id = ? AND <buildWhere> RETURNING id, data`.
- **Mongo:** `findOneAndUpdate({ _id, ...filter }, { $set, $inc }, { returnDocument: "after" })`.
- **`insert`:** maps a duplicate primary key to `DuplicateKeyError`. Insert-if-missing is *insert, then ignore
  `DuplicateKeyError`*.
- **Contract tests:** 50 parallel conditional increments allow exactly one; duplicate IDs are detected; unsafe paths are
  rejected.

## 2.6 `placeOrder` (still inside `locked()`)
1. Validate items, products and stock (as today). Identity:
   - signed in: from the session;
   - guest: from the typed email, which is now known, so `pending` checks are resolved.
2. Load the ledger and run `price()` with the cart's codes and selection.
3. If `expectedQuote` differs, respond `409 prices_changed`. The cart is shown again and `shop.js` explains the change.
4. Create `orderId`.
5. Write the changes in order. If any step returns null, respond `409` and undo the steps already done:
   1. For each applied discount: `updateWhere(discountId, {usedCount:{$lt:totalUses}}?, {inc:{usedCount:1}})`.
   2. For single-use codes: `updateWhere(code, {usedCount:0}, {inc:{usedCount:1}})`.
   3. Per-customer usage (insert if missing), as one atomic check-and-increment:
      `updateWhere(usageId, {orders:{$lt:maxOrders}, amountCents:{$lte:max−amount}}, {inc:{orders:1, amountCents:amount}})`.
   4. Identity order count:
      - if a `firstOrders` offer is applied, conditionally: `updateWhere(identityId, {orders:{$lt:N}}, {inc:{orders:1}})`;
      - otherwise, unconditionally.
   5. Insert the redemption records.
   6. Decrement stock.
   7. Insert the order with its pricing snapshot.
6. A guest checkout no longer overwrites an existing customer's name or address (F1). The address is stored on the order.

**Cancel.**
- Redemptions flip `used → released` via `updateWhere(redemptionId, {state:"used"}, …)`.
- Only after that succeeds are these decremented: `usedCount`, the usage ledger (orders and amount) and the identity's
  order count.
- Cancellation therefore releases everything exactly once.
- Cancelled orders that carried discounts are **final**: the API returns 409 and the backoffice disables the option.

## 2.7 API

**Convention: one URL per resource, format chosen by the `Accept` header.**
- `application/json` is the default (no header or `*/*`). `text/csv` is available for exportable lists.
- Anything else gets **406**. Responses send `Vary: Accept`.
- CSV is RFC 4180, UTF-8, with `Content-Disposition: attachment`. Cells starting with `= + - @ \t \r` are neutralised.
- The same query parameters apply to both formats. JSON is paginated (`limit ≤ 500`, `{ items, total }`). CSV defaults
  to all rows (capped at 100,000), streamed.

**Admin** (inside the authenticated `admin.register` block; strict validator with `removeAdditional:false`, no
coercion):

| Method | Path | Notes |
|---|---|---|
| GET | `/api/settings` | |
| PATCH | `/api/settings` | time zone, display. A time-zone change recomputes offer instants and is audited. |
| GET | `/api/settings/timezone-impact?tz=` | preview before saving |
| GET / POST | `/api/discounts` | list (`state`, `trigger`, `q`, `campaign`) and create. JSON schema → `normalizeDiscount` → referenced IDs must exist → the time-zone helper derives instants |
| GET / PATCH / DELETE | `/api/discounts/:id` | PATCH needs `version` (409 on a stale edit). DELETE only if never used, otherwise archive |
| POST | `/api/discounts/:id/pause`, `/resume`, `/duplicate`, `/archive` | |
| GET | `/api/discounts/:id/codes` | **JSON or CSV by `Accept`** |
| POST | `/api/discounts/:id/codes` | `{ code }` or `{ generate: ≤10000, prefix?, assignedCustomerId? }` |
| DELETE | `/api/discounts/:id/codes/:code` | unused codes only |
| GET | `/api/discounts/:id/redemptions` | JSON or CSV by `Accept` |
| POST | `/api/discounts/simulate` | `{ items, customerId?, email?, codes?, at?, selection? }` returns the full result with internal reasons |
| GET / POST / PATCH / DELETE | `/api/discount-profiles[/:id]` | PATCH response includes `affectedMembers`. DELETE only without members |
| GET / POST | `/api/discount-profiles/:id/members` | GET: JSON or CSV. POST: `{ add: [{customerId, validUntil?}], remove: [] }`, ≤ 500 |
| GET | `/api/customers`, `/api/customers/:id` | detail with orders, profiles, usage ledger, personal codes |
| POST | `/api/customers/:id/links` | `{ purpose: "activate" | "reset" }` returns a one-time URL, shown once (D5) |
| GET | `/api/reports/discounts?from=&to=&groupBy=day\|discount\|campaign` | JSON or CSV by `Accept`, days in the shop zone |
| GET | `/api/audit?entity=&id=` | |

**Public shop API** (JSON only: non-JSON bodies get 415 (F7); `Origin` checked on writes; `Cache-Control: private, no-store`; no CORS):

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/shop/prices?ids=a,b` | ≤ 100 IDs. Per active product: `listCents`, `priceCents`, `appliedFrom`, `alternatives[]`, `endsAt`, and `display` settings, `timezone`, `currency` |
| GET | `/api/shop/cart` | the full `PricingResult` for this cart and shopper (internal fields removed) |
| POST | `/api/shop/cart/codes` | `{ code }`, rate limited |
| DELETE | `/api/shop/cart/codes/:code` | |
| PUT | `/api/shop/cart/selection` | `{ scenario, declined[] }` |
| GET | `/api/shop/account/offers` | signed-in only: personal codes, profile offers, remaining budgets and uses |
| POST | `/api/shop/orders` | + `codes`, `selection`, `quote`. The customer comes from the session only |

HTML (server-rendered per request, **no discount data**):
- Existing: `/shop/cart/add`, `/shop/cart/remove`, `POST /shop/checkout` (gains hidden `quote`, `scenario` and
  `declined` fields, filled by `shop.js`).
- Account pages: `/shop/account/activate/:token`, `/shop/account/reset/:token`, `/shop/account/login`, `/logout`,
  `/shop/account`.

## 2.8 Storefront delivery: API plus JavaScript only (owner decision)
- **Renderer (it never receives discount data):**
  - Price elements get hooks: product cards
    `<div class="os-pc-p" data-os-price="<productId>">€24.00</div>`, and the `productPrice` widget.
  - New builder widget **"Offers"** (`productOffers`) renders an empty `<div data-os-offers="<productId>">` that
    `shop.js` fills with source, alternatives and end time. The cart shell gets `<div id="os-cart-pricing">`.
  - Non-editor output adds `<meta name="os-currency" content="€">` and `<script src="/assets/shop.js" defer></script>`.
  - Editor and sample mode render a **sample sale state** (classes `.os-was`, `.os-now`, `.os-badge`, `.os-offers`,
    styled from theme variables), so designers can style it. No script runs in the builder canvas.
  - One-time migration: stored pages get a `rendererVersion`, and pages with an older version are re-rendered once at
    startup to add the hooks and script tag. **Changing a discount never re-renders pages**, and there is no scheduler.
- **`shop.js`** (plain JS, `// @ts-check`, no dependencies, under 10 KB):
  - Finds hooks, batches `GET /api/shop/prices`, and updates the DOM **only with
    `textContent`/`createElement`**. It shows `<s>` with a visually hidden "Original price" and an `aria-live` region.
  - On the cart page it calls `GET /api/shop/cart` and renders per-line sources, the "N offers apply" `<details>`,
    scenario radio cards, "save for later" toggles and the code form.
  - It writes `quote`, `scenario` and `declined` into the checkout form.
  - On any error it leaves list prices untouched. It never shows a price the server didn't return.
  - Served by the API with `text/javascript`, `nosniff`, `cache-control: no-cache` and an ETag.
- **Without JavaScript:** list prices are shown, with a `<noscript>` notice ("Enable JavaScript to see your discounts
  and use codes"). Automatic offers are still applied by the server at checkout. The order confirmation renders the
  order's own snapshot (order data, not offer data).
- **Known effects:** crawlers and link previews show list prices, and prices may briefly show the list price before the
  discount loads. An optional CSS-only reveal delay can reduce that flicker.
- **CSP** for storefront pages: the existing policy plus
  `script-src 'self'; connect-src 'self'; require-trusted-types-for 'script'; trusted-types 'none'`.
  The README's "no JavaScript" statement will be updated.

## 2.9 Customer accounts without email (D5)
- **Owner-generated links.** From the backoffice the owner creates an *activation* or *password reset* link:
  - 32 random bytes; only the SHA-256 hash is stored;
  - single use; valid for 72 hours;
  - shown once; the owner shares it through any channel.
- The customer sets a password (the existing scrypt helper, at least 10 characters).
- **No self sign-up in v1.** An account anyone can create proves nothing more than a guest email, so "signed in" means
  "known to the owner".
- **Session cookie** `cs`: `HttpOnly; Secure; SameSite=Lax; Path=/`, valid 30 days.
  - The token carries `aud:"customer"` and `sv:sessionVersion` and is signed with a derived customer key.
  - Logout, password reset or "sign out everywhere" increments `sessionVersion`.
- Login is throttled per IP and per email.

## 2.10 Backoffice (Angular 22, standalone components and signals, same patterns as today)
- **Navigation:** Discounts (tabs: Offers · Vouchers · Profiles), Customers, Settings.
- **Offer list:** name, preset badge, target summary, effect, schedule in the shop zone, status pill (Scheduled,
  Running, Ended, Paused, Used up), usage, and actions (Edit, Pause, Duplicate, Archive).
- **Editor** (a full page):
  1. Preset card.
  2. **Who:** everyone, customers or profiles.
  3. **Access:** "Guests and signed-in" or "Signed-in only". It is locked to signed-in for customer or profile audiences,
     with an explanation.
  4. **What:** all, products or categories, plus exclusions.
  5. **Discount:** the effect, plus a scope toggle ("each item" or "once per order"). Invalid combinations are disabled.
  6. **When:** "Starts now" and "Never ends" toggles, and a "Last day" helper. Times are labelled in the shop zone, with
     the owner's local time next to them. A past start shows a notice.
  7. **Limits:** total uses, maximum per order, minimum order value/quantity, and per customer (max purchases, max €,
     first N orders). If limits are set while guests are allowed, a warning explains that guests can bypass them with a
     different email.
  8. **Combining:** priority, combinable, "shopper may save for later".
  9. **Codes** (code offers only).

  The right-hand panel has a live preview using `@openshop/pricing`, with warnings.
- **Vouchers:** code table (paginated JSON), generate codes, and **Download CSV**. The download is an `HttpClient.get`
  with `Accept: text/csv` and `responseType: 'blob'`, saved via an object URL, because the bearer token can't go on a
  plain link.
- **Profiles:** name, public label and status, with rules edited in the same editor. Saving shows "This change applies
  to 12 customers". Members have an optional validity date.
- **Customers:** list, detail (orders, profiles, usage and remaining budgets, personal codes), and "Create activation
  link" / "Create reset link".
- **Settings:** a time-zone picker (searchable `Intl.supportedValuesOf`) with an impact preview, and display toggles.
- **Orders:** a discount column and per-line allocations.
- **Simulator:** build a cart, pick a customer or email, codes, a date and time in the shop zone, and a scenario. It
  shows the full result including internal reasons.

## 2.11 Performance
- Candidate offers are cached in memory (active and not ended). The cache is rebuilt on every admin write and every
  60 seconds. Limits are always re-checked against the database inside `placeOrder`.
- Caps: 500 active offers, 50 cart lines, 8 scenarios, 100 IDs per prices call.
- Prices calls are rate limited at about 120 per minute per IP.

## 2.12 Testing
- **pricing:**
  - Table tests for all five effect × scope combinations, audiences, exclusions, priorities, budgets (partial), first
    orders, maxOrders, scenarios and saving offers for later.
  - DST tests on Lisbon's gap and overlap, plus a non-DST and a half-hour zone.
  - Randomised invariant tests (seeded, 5,000 carts).
- **db contract:** `updateWhere` concurrency, `DuplicateKeyError`.
- **api:**
  - Security and access:
    - every new admin route returns 401 without a token;
    - a customer session is rejected on `/api/*` admin routes;
    - unknown fields are rejected (`endAt` → 400);
    - a customer-audience offer with `requiresSignIn:false` is rejected.
  - Time:
    - an offer ends at the exact Lisbon midnight instant (controlled clock);
    - a time-zone change recomputes instants as specified.
  - Exports: `Accept: text/csv` returns CSV with `Vary: Accept`; `Accept: application/xml` returns 406.
  - Public shop API:
    - JSON endpoints reject `x-www-form-urlencoded` (415) and a foreign `Origin` (403);
    - an anonymous prices call never reveals customer, profile or code offers;
    - storefront HTML contains no discount data.
  - Limits and concurrency:
    - 20 parallel checkouts: a single-use code is used once, a per-customer budget is never exceeded, and a first-order
      offer is used once per identity;
    - cancelling releases limits once, and a cancelled order with discounts is final;
    - a quote mismatch returns 409.
  - A guest using a VIP's email gets no VIP offer.
- **backoffice:**
  - `ng build`;
  - component tests for shop-zone date entry and cents/bp conversion;
  - a test that the CSV download sends `Accept: text/csv`.

## 2.13 Phase acceptance criteria
- **P0:** existing tests pass; contract tests pass on both databases; admins log in again once (old tokens have no
  audience); time-zone helper tests pass.
- **P1:** use cases 1, 2 and 7 (without sign-in) work end to end; prices appear only through the API and storefront HTML
  contains no discount data.
- **P2:** use cases 3, 4 and 6 (guest version); the concurrency and cancel tests pass; CSV is available via `Accept`.
- **P3:** use case 5 and the signed-in version of 6; a guest typing a VIP's email gets list prices.
- **P4:** the owner can see what each campaign cost and earned, in JSON or CSV.

---

# 3. Security criteria

Each criterion gives the requirement, the reason, and how it is verified.

**S1. Server-authoritative pricing.**
- **Requirement:** requests never carry prices or eligibility. `shop.js` only displays values. `placeOrder` recomputes
  everything under the lock. The `quote` is used only to detect changes.
- **Verified by:** forged quote or extra fields → the total is unchanged.

**S2. Identity for targeted offers.**
- **Requirement:** customer and profile audiences always require a verified session (`requiresSignIn` is forced), and a
  typed email never unlocks them. A guest checkout never modifies an existing customer's record (F1).
- **Verified by:** a test with a VIP's email as a guest.

**S3. Shopper and admin tokens are separate.**
- **Requirement:** tokens carry `aud`; each audience uses its own HKDF-derived key; `requireAuth` checks the audience and
  that the user exists. This must ship before any shopper session (F2).
- **Verified by:** a customer token gets 401 on admin routes.

**S4. Codes can't be guessed or probed.**
- **Requirement:**
  - Generated codes use a crypto random generator and a 31-character unambiguous alphabet, at least 10 characters
    (about 50 bits).
  - Input is normalised to `[A-Z0-9-]{4,32}`.
  - Rate limit: 10 attempts per 10 minutes per IP and per cart.
  - Messages are generic: unknown codes, codes belonging to someone else and codes not usable by this shopper all get
    the same response. Only public conditions ("add €12 more") are explained.
  - No public endpoint lists offers or codes.
- **Verified by:** rate-limit and identical-response tests.

**S5. Limits hold under concurrency.**
- **Requirement:** total uses, single-use codes, per-customer orders and budget, and first N orders are all enforced
  with `updateWhere` conditional increments and deterministic IDs. Writes happen in a fixed order with undo on failure.
  Cancel releases exactly once.
- **Verified by:** parallel checkout tests and contract tests.

**S6. Money integrity.**
- **Requirement:** integer cents and bp only; the engine invariants (§2.4); a fixed price never raises a price; caps on
  maximum per order and budget.
- **Verified by:** randomised invariant tests.

**S7. Strict input validation.**
- **Requirement:**
  - Unknown fields are rejected (F6); no type coercion.
  - Bounds on every number, array and string.
  - Wall-clock strings must match `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$`; years 2000–2100; `end > start`.
  - Time zone must be in `Intl.supportedValuesOf("timeZone")`.
  - `normalizeDiscount` runs on save **and** on load.
  - Referenced IDs must exist when saving.
- **Verified by:** negative tests for each field.

**S8. Output encoding.**
- **Requirement:**
  - Storefront HTML escapes everything through `esc()`.
  - `shop.js` uses only `textContent` and `createElement`, enforced by Trusted Types (`trusted-types 'none'`).
  - Angular uses interpolation only, no `innerHTML`.
  - CSV neutralises formula characters.
- **Verified by:** a label containing `</style><script>` and `=HYPERLINK(...)` renders inert everywhere.

**S9. Script delivery.**
- **Requirement:**
  - Scripts may load only from the shop's own origin (`script-src 'self'`); no inline or third-party scripts; fetch calls
    may go only to the shop's own origin (`connect-src 'self'`).
  - `X-Content-Type-Options: nosniff` on **every** response, so no JSON or upload can run as a script.
  - Uploads stay restricted to images.
- **Verified by:** header tests on the HTML, JSON, asset and upload routes.

**S10. CSRF.**
- **Requirement:**
  - Shopper cookies are `HttpOnly; Secure; SameSite=Lax`.
  - JSON shop endpoints require `Content-Type: application/json` (F7) and a matching `Origin`.
  - HTML form POSTs (cart, checkout, account) check `Origin`/`Referer`.
  - No CORS. The admin API stays bearer-only.
- **Verified by:** 415 and 403 tests.

**S11. Privacy of offers and prices.**
- **Requirement:**
  - Discount data is never in HTML.
  - Shop API responses are `private, no-store`.
  - Anonymous calls see only offers that apply to everyone.
  - Response objects include only allowed fields (no internal names, audiences, usage counts or other customers).
  - Profiles are shown only by `publicLabel`.
- **Verified by:** response snapshot tests.

**S12. Guest identity limits are documented and contained.**
- **Requirement:**
  - Guest per-customer limits are explicitly best effort: keyed on the normalised email, labelled as such in the
    editor, and strict only with sign-in.
  - The identity hash uses a persisted random key (F9).
  - "First order" results for guests are given only at checkout, with a generic message and checkout rate limiting,
    which limits probing whether an email has ordered before.
- **Verified by:** tests on the ledger and the messages.

**S13. Authorization.**
- **Requirement:** all new admin, settings, customer, report and simulator routes are registered inside the
  authenticated block.
- **Verified by:** an exhaustive list of routes that must return 401.

**S14. Audit and concurrency.**
- **Requirement:**
  - Every offer, profile, member, code, settings (time zone) and account-link action is written to the audit log with
    before/after values.
  - Backdated or large (over 50%) offers are flagged.
  - Edits use `version` for optimistic concurrency.
- **Verified by:** audit entries exist and stale versions get 409.

**S15. Business-logic abuse.**
- **Requirement:**
  - Minimum order value is checked after line discounts; one code per order; deterministic combining.
  - Full recomputation and quote check at checkout.
  - Paused or expired offers are re-checked at checkout.
  - Cancelled orders with discounts are final.
  - No client-supplied time.
- **Verified by:** a test for each scenario.

**S16. Account links and sessions (D5).**
- **Requirement:**
  - Links: single use, hash stored, valid 72 hours, shown once, audited.
  - Passwords: scrypt, at least 10 characters; throttled.
  - Sessions: `sessionVersion` allows revocation.
- **Verified by:** tests for reuse, expiry and throttling.

**S17. Denial of service.**
- **Requirement:** caps on active offers, cart lines, scenarios, IDs per prices call, generated codes, member changes
  and CSV rows (streamed). The prices API is rate limited.

**S18. Privacy.**
- **Requirement:**
  - Deleting a customer removes their memberships, personal codes, links and audience entries.
  - The usage ledger is keyed by a hash, not by email.
  - Orders keep their snapshot.

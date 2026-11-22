# OpenShop backoffice IAM (team, permission groups, invitations): implementation plan (v2)

Status: **plan v2, implemented** (all phases P0–P6 except the items listed below). It replaces `docs/iam-plan.md`
(v1, kept for comparison) and includes the owner's review of v1. How to try it: `docs/iam-testing.md`. Security
review (threat model, attack tests, 6 findings fixed): `docs/iam-security-review.md`.

## Implementation status

| Phase | Status |
|---|---|
| P0 Foundations | Done: `packages/iam` (17 permissions, closure, feature registry, templates, password policy); user model and `migrateIam` (single owner, "Shop manager (migrated)" group); `sv` session tokens; per-IP and per-account sign-in limiter with bounded inputs; every admin route declares `config.perm` (server refuses to start otherwise); body rules; `/api/me`; registry-driven menu, permission guard with No access page (address kept), Not found, Welcome. |
| P1 Team and invitations | Done: staff routes, invite/reset links (fragment URL, revocable, link history), soft delete and restore, suspend/reactivate, sign-out everywhere, `/join`, My account (password change, forced change), Members screen with Access overview and CSV. |
| P2 Groups | Done: group routes and editor (dependency auto-tick, impact preview with confirmation, version conflicts), the 8 templates, membership from both sides, read-only and fine-grained modes of existing screens (stock-only, order status targets, discount editor, simulator, profiles, customers). |
| P3 Activity log | Done: `activity` collection with time-ordered ids, recording at every source (sign-ins, links, beacons, 401 aggregation, 403, changes via `audit()`), `deleteWhere` + hourly pruning, Activity page with filters, before/after, CSV, member embed. |
| P4 Password policies | Done: editable staff and customer policies (bounds enforced on the server), Settings → Security (owner only), storefront set-password page uses the customer policy, "require at next sign-in". |
| P5 Access matrix and e2e | Done: `apps/api/test/access-matrix.json` (32 rows × 14 personas + menus + screens); API test of every cell with a generated report; backoffice menu test per persona; `scripts/e2e-access.py` (378 browser checks). |
| P6 Hardening | Mostly done: hash format upgrade (`scrypt$N$r$p$…`, old hashes still verify); backoffice CSP (`script-src 'self'`, `frame-ancestors 'none'`, …) on the dev server and documented for production in `docs/backoffice-hosting.md`, with critical-CSS inlining off so the production page has no inline script. Browser-verified: injected inline scripts and handlers don't run in the backoffice or in the builder canvas (which inherits the policy), and the existing backoffice suite shows no CSP violations. **Not done:** sandboxing the builder canvas behind `postMessage` (a rewrite of the canvas protocol and its tests). It is added to the future work register as FW15. |

Tests at the end of the session: `packages/iam` 9 (100% lines), `packages/db` contract incl. `deleteWhere` (100%),
API 568 (99.8% lines; 482 of them the access matrix, 12 attack tests), backoffice 154 unit tests (99.8% lines), browser:
`e2e-access.py` 392 checks, and the existing `e2e-backoffice.py` and `e2e-storefront.py` still pass (each on a freshly
seeded instance).

Deviations from the plan, and why:
- `PUT /api/staff/:id/groups` (set a member's groups in one call, for the member page) and `GET /api/activity/changes/:id`
  (the before/after behind a change event) were added.
- `ADMIN_PASSWORD` sets the owner's password only when it differs from the current one. A change ends the owner's
  sessions; a restart with the same password keeps them (otherwise every restart would sign the owner out).
- Restoring a removed member clears their password: they come back through a new invitation link.
- Record history (`GET /api/audit`, from the discounts work) returned only the newest 200 entries of a record, with
  no paging. It is now paged with a cursor (time + id, exact even for equal timestamps and stable while new entries
  arrive), filterable (action, person, time range), downloadable as CSV from the same URL, and shows who made each
  change. Response: `{ items, next }` instead of a bare array (the only client, the offer editor's History, was
  updated: "Older changes", "Download CSV").
- Refused old sessions (`session_ended`) appear under both the "Sign-ins" and the "Denied access" filters.
- The "No access yet" page checks `/api/me` every 15 s so a newly added member moves on by itself.
- Found and fixed during the browser tests: on a full page load the backoffice created the first screen twice (a
  second router outlet appeared with the menu), which doubled its API calls and "page denied" events. There is now one
  permanent outlet.
- The production build was checked with font inlining switched off for the check only (this environment has no
  internet): 744 kB initial (budget 900 kB), no inline scripts. It was then served with the CSP and used without CSP
  violations.

**How to read the highlights.**
- **`[v2 NEW]`**: added in this version.
- **`[v2 CHANGED]`**: different from v1.
- **`[v2 REMOVED]`**: v1 content dropped or moved to future work.

Unmarked text is unchanged from v1.

---

## Changes from v1 (summary)

| # | Area | v1 | v2 | Source |
|---|---|---|---|---|
| 1 | **Owner model** | One or more owners, with a race-safe "last owner" guard and step-up to promote a new owner. | **Exactly one sudo account** (the owner). No API can create, demote, suspend or remove it. The owner guard, owner promotion and step-up are removed. Delegation and multiple owners become future work. | D1 |
| 2 | **Remove user** | Tombstone, email released, new account on re-invite. | **Soft delete:** the account is kept with all its history; new sign-ins are blocked (and open sessions end). Re-inviting the same email **restores the same account**, so its history stays attached. | D2 |
| 3 | **Recovery / bootstrap** | `ADMIN_PASSWORD` reworked into an "ensure owner" recovery path. | Existing behaviour kept, only fenced so it can never create a second sudo or touch staff accounts. Recovery design becomes future work. | D3 |
| 4 | **Invite links** | Re-issuing revokes the previous link. | Also an explicit **"Revoke link"** at any time within the 72 h window. Link states (pending, used, expired, revoked) are shown with timestamps. | D5 |
| 5 | **Permissions** | 13 area-level permissions. | **Full list of 17 permissions** (§2.3), with finer control where real jobs differ: stock-only edits; orders split into ship, payment and cancel; customer deletion; voucher codes. `audit.view` is removed (the activity log is sudo-only). | D6 |
| 6 | **Group templates** | Mentioned only. | **8 concrete templates for review** (§2.4), each with its purpose, permissions and what it can't do. | D7 |
| 7 | **Password policies** | Fixed in code (staff 12, customers 10). | **Editable in the backoffice** for staff and for customers (sudo only). v1 values are the defaults. Optional "enforce at next sign-in" for staff. | Note on 2.7 |
| 8 | **Auditing** | Changes only; sign-ins deliberately not logged. | **A dedicated Activity page** with sign-ins (successful and failed), sign-outs, backoffice pages visited, changes, and access denied (403) or unauthenticated (401), with filters, CSV and retention. | Note on 2.8 |
| 9 | **Menus and "no permission" page** | Hide menu entries; redirect to `/forbidden`. | One **feature registry** drives the menu, the route guards and the landing page, so they can't disagree. There is a dedicated **No access** page that keeps the requested URL, says what is missing and who to ask, and is logged. A **Page not found** page is added. | Note on screens |
| 10 | **Testing** | A route-coverage test plus flow tests. | Also **test personas** (one user per realistic group, plus edge cases), an **access matrix** of users × functionality (§2.12) and a data-driven test of every cell at API, unit and browser level, with a generated report. | Note on 2.11 |
| 11 | **Future work** | Scattered across limitations. | One **future work register** (§4). The known limitations are logged there and are not addressed in this project. | Limitations, D1, D3 |
| 12 | **Phases** | 4 phases, about 11–15 days. | 6 phases, about 19–24 days (§2.13). | All of the above |

---

## 0. How the current code shapes this plan

Findings F1–F12 are unchanged from v1, except where marked.

| # | Finding | Where | Consequence for IAM |
|---|---|---|---|
| F1 | A `users` collection exists, but every user is a full admin: `{ email, passwordHash }` only. | `types.ts`, `app.ts` | The model needs extending, plus a migration. **`[v2 CHANGED]`** One existing user becomes the sudo. Any others keep full access through a migrated "Shop manager" group (§2.7). |
| F2 | One `requireAuth` hook covers all admin routes (about 60 routes in 4 files). | `app.ts` | Authorisation is one extra hook in the same scope, plus a declared permission on every route. |
| F3 | Admin tokens are stateless (8 h) with no session version. Verified: a token still works after a password change. | `auth.ts` | Add the `sv` claim (as customer sessions already have). |
| F4 | The token is kept in `localStorage` and sent as a Bearer header. | backoffice `api.service.ts` | Immune to CSRF, but exposed to XSS (S9). |
| F5 | The page-builder canvas is a same-origin, non-sandboxed `srcdoc` iframe. | `builder.ts`, `builder-frame.js` | Page content runs with backoffice privileges (S9). |
| F6 | Uniqueness only on `id`; no transactions; `updateWhere` is the only atomic primitive. | `packages/db` | Email reservation document; deterministic ids. |
| F7 | Customer one-time links already exist (hash only, single use, 72 h). | `accounts.ts` | Staff links reuse the pattern. |
| F8 | Login throttling per IP only. Verified: no per-account limit, and no `maxLength`. | `app.ts` | Use `FailureLimiter` keyed by IP and by account, and bound the inputs. |
| F9 | `ensureAdmin` runs on every start when `ADMIN_PASSWORD` is set. | `main.ts` | **`[v2 CHANGED]`** Keep it, fenced to the sudo account (§2.7). |
| F10 | The audit log stores `userId` and sometimes whole documents. | `audit.ts` | Project user records; show names. |
| F11 | Screens use other areas' APIs (the discount editor loads every customer; the builder loads products). | backoffice | Permission dependencies and body-dependent checks. |
| F12 | No CSP on the backoffice; it is hosted separately. | `angular.json` | Hosting and CSP are documented (S9). |
| F13 | **`[v2 NEW]`** `PATCH /api/orders/:id` allows **any** status change (pending, paid, shipped, cancelled, and back). The only exception is that cancelled orders which used offers can't be reopened. Cancelling releases discounts. | `orders.ts` `setOrderStatus` | Order permissions depend on the **target status** (and on reopening). The backoffice status menu lists only the states the user may choose. |
| F14 | **`[v2 NEW]`** The customer password minimum is a constant, `PASSWORD_MIN = 10`, used in the server-rendered set-password page (both the text and the `minlength` attribute). | `accounts.ts`, `account-pages.ts` | The editable policy must reach the storefront form and its server-side check. |
| F15 | **`[v2 NEW]`** The backoffice has no wildcard route (`**`), so unknown URLs render an empty shell. `''` always redirects to `/products`. | `app.routes.ts` | Add Page not found, and a permission-aware landing page. |
| F16 | **`[v2 NEW]`** The SPA changes screens without calling the server, so the server can't see "pages visited" on its own. | backoffice router | Page views are reported by the backoffice (a beacon). They are **informational**, unlike server-side 401/403 events (§2.9). |
| F17 | **`[v2 NEW]`** Angular 22 (installed: `@angular/router` 22.2.5) lets guards return `RedirectCommand(urlTree, { skipLocationChange: true })`. | router | The No access page can appear **without changing the address bar**, so a reload re-checks access once it is granted. |

---

# Part 1 — Business

## 1.1 Goal
Let the shop owner give other people access to the backoffice with only the rights they need, see at any moment who
can do what **`[v2 CHANGED]`** and what they did, and take access away instantly. No email server is needed.

## 1.2 Personas (demo shop Maison Dune)
- **Owner (sudo)** **`[v2 CHANGED]`**: the single account with every right, including the team, activity log and security settings. There is only one.
- **Shop manager**: a trusted right hand. Runs everything day to day except the team and security.
- **Fulfilment staff** (packer): sees orders, marks them shipped, and updates stock.
- **Catalogue editor** (merchandiser): maintains products, prices, photos and categories.
- **Content editor** (web designer, often a freelancer): designs pages.
- **Promotions / marketing**: runs offers and codes, and reads reports.
- **Customer support**: looks after customers and their accounts, and cancels orders on request.
- **Finance / accountant**: marks orders paid, and reads orders and reports.
- **Invitee**: someone who has received a link and has no account yet.

## 1.3 Glossary
- **Staff member**: a backoffice user. Separate from shop customers.
- **Permission**: a fixed capability defined by OpenShop (§2.3).
- **Permission group**: a named set of permissions created by the owner. A member gets the union of their groups.
- **Sudo / owner** **`[v2 CHANGED]`**: the one account with all permissions plus the sudo-only functions. It is set when the shop is installed or migrated, and can't be changed in the backoffice in v2.
- **Activity** **`[v2 NEW]`**: everything recorded about staff use: sign-ins, pages visited, changes, denied access.

## 1.4 User stories

Priority: **M** = must, **S** = should, **C** = could.

### Epic A: Team overview (sudo)

**A1 (M). See the team.** *As the owner, I want to see every staff member with their status and groups, so that I
know who has access.*
- The list shows the name, email, status (Owner, Active, Invited, Invitation expired, Suspended, Removed), groups, last sign-in and invitation date.
- **`[v2 CHANGED]`** Removed members are hidden by default. With the "Removed" filter they are listed with their removal date and who removed them. Their history stays available.
- Search by name or email; filter by status or group. Only the owner sees the Team menu entry; the API gives 403 to anyone else.

**A2 (M). See current permissions.** *As the owner, I want to see what each person can actually do.*
- An **Access overview** matrix shows people × areas, with each cell `—`, `View` or the specific actions (e.g. "Ship", "Cancel").
- Member detail lists each effective permission and the group(s) it comes from. The owner shows "All permissions".
- Computed live; CSV download.

### Epic B: Permission groups (sudo)

**B1 (M). Create a group.** Name, description, and permissions by area, each with a plain-language description that
says what data it exposes.
- Ticking a permission also ticks the ones it needs, with an explanation. The server applies the same rule.
- **`[v2 CHANGED]`** "Start from a template" offers the 8 templates in §2.4. They are copied into an editable group and never applied automatically.

**B2 (M). Edit a group.**
- Impact preview before saving ("changes access for 3 people: …").
- Takes effect on every member's next request.
- `version` conflict → "changed by someone else, reload" (possible with two browser tabs).

**B3 (M). Manage group members** from the group page and from the person's page. Idempotent; immediate. Invited
members can already be placed in groups.

**B4 (M). Delete a group.** The confirmation lists the people who lose its permissions.

**B5 (S). No surprise grants.** Permissions added in future releases are off in every existing group. The owner has them automatically.

### Epic C: Invitations and onboarding

**C1 (M). Invite someone.** Email, name, optional groups → a one-time link shown **once**, with "Copy link" and its
expiry, and a note that it is a bearer credential to send privately. The member shows as **Invited**.
- **`[v2 CHANGED]`** Inviting the email of a **removed** member offers "Restore *Name*": the same account goes back to Invited, with a new link and no groups (the owner picks groups again). Inviting any other existing member's email is refused.

**C2 (M). Accept an invitation.** The invitee sees the shop name and their email, chooses a password **that meets the
current staff password policy** **`[v2 CHANGED]`**, and is signed in to the first screen they may use (or a "No access
yet" page if they have no groups). An invalid link shows a single generic message.

**C3 (M) `[v2 CHANGED: S→M, extended]`. Re-issue or revoke a link.** *As the owner, I want to cancel a link I sent at
any time before it expires, e.g. because I sent it to the wrong person.*
- **Revoke link** works on any pending invite or reset link, at any time within its 72 h (or 24 h) validity. It takes effect immediately: opening the link shows the generic "no longer valid" page.
- **Create a new link** revokes earlier unused links for that person.
- **Cancel invitation** (for Invited members) revokes the link and marks the member Removed.
- The member page shows the link history: created (by whom and when), expiry, and the state with its timestamp (pending, used, expired, revoked). Tokens are never shown again.

**C4 (S). Password reset by the owner.** A reset link (24 h, single use, revocable as in C3). Using it ends all of the member's sessions.

### Epic D: Removing and suspending

**D1 (M) `[v2 CHANGED]`. Remove a user (soft delete).** *As the owner, I want to remove someone so that they can
never sign in again, while everything they did stays on record.*
- Two-step confirmation. After removal:
  - new sign-ins fail;
  - their open sessions end at the next request (no waiting 8 h);
  - pending links are revoked;
  - their group memberships are ended (recorded in the activity log, so it's visible what they had).
- The account record, name and email are **kept**. Every change, sign-in and page view stays in the activity log under their name, marked "(removed)". Objects they created keep their attribution.
- A removed member can only come back through an explicit "Restore" invitation (C1). Nothing reactivates them by accident.
- The owner (sudo) can't be removed.

**D2 (S). Suspend and reactivate.** Temporary: no sign-in and sessions end, but groups and password are kept.
Reactivating restores access. The owner can't be suspended.

**D3 `[v2 REMOVED]`** "Never lock out the last owner" is not needed with a single sudo that can't be removed or
suspended. The v1 race-safe owner guard is dropped.

**D4 `[v2 REMOVED → future work]`** "Make someone an owner" (and with it the step-up check).

### Epic E: Working with limited access (staff experience) `[v2 CHANGED: extended]`

**E1 (M). Menus show only what I can use.** *As a staff member, I want the menu to contain only the areas I have
access to.*
- Each menu entry (main menu and footer: Settings, Team, Activity) appears only if the user has the permission for that area's entry screen.
- The same list decides the **landing page** after sign-in: the first area the user may open. A user with no permissions gets "No access yet", which names the owner to ask.

**E2 (M). A clear "no permission" page.** *As a staff member who opens a link or bookmark to a feature I can't use,
I want a clear page telling me so, instead of an error or being signed out.*
- The **No access** page keeps the URL in the address bar. It shows:
  - the feature name ("You don't have access to **Discounts**");
  - the missing permission in plain language ("This needs: *Create and change offers*");
  - who to ask (the owner's name);
  - a button to the user's landing page.
- It appears for direct URLs, bookmarks, sub-pages (e.g. `/discounts/new` with view-only access), and when access is withdrawn while the page is open (see E4). Each time is recorded in the activity log as *Page denied*.
- An unknown URL shows **Page not found**, not an empty screen.

**E3 (M). Read-only where appropriate.** With View but not Manage, screens show data without edit controls.
Fine-grained actions follow the permissions. For example, a packer's order status menu offers only "Shipped".

**E4 (M). Access follows changes.** Permissions are checked on every API request. The backoffice refreshes the user's
permissions after any 403, on window focus, and every 5 minutes. If the current screen is no longer allowed, the No
access page replaces it and the menu updates.

### Epic F: Activity log `[v2 NEW]`

**F1 (M). One page with every event.** *As the owner, I want a single Activity page listing everything that happens in
the backoffice, so that I can answer "who did what, when, and from where".*
- Event kinds:
  - **Sign-ins:** successful and failed (with the reason, e.g. wrong password or suspended account), sign-outs, and sessions ended (removed, suspended or reset).
  - **Links:** invite/reset link created, opened, used, revoked, or an invalid link opened.
  - **Page views:** each backoffice screen a member opened.
  - **Changes:** every create, update or delete, with before → after (from the existing audit log), including team, group, policy and settings changes.
  - **Denied access:** No access pages shown (*Page denied*), API requests refused for lack of permission (403), and unauthenticated API requests (401, e.g. an expired session or a removed user still trying).
- Each event shows the time, the person (or "unknown" for anonymous requests), the kind, the target or page, the IP address and the browser.
- Filters: person, kind (chips), date range, IP, free text. "Show this person's / this IP's events" in one click. Newest first; "Load more". CSV download of the filtered view.
- The member detail page embeds the same list, filtered to that person.

**F2 (S). Retention.** *As the owner, I want to choose how long activity is kept.* Options: 30, 90, **180 (default)**
or 365 days. Older activity is deleted automatically. The full change history of offers and other records (the
existing audit log) is **not** deleted.

**F3 (S). Staff are informed.** "My account" states what is recorded (sign-ins, pages visited, changes, with IP and
browser) and for how long.

**F4 (C). Suspicious sign-in hints.** Sign-ins from an IP not seen for that person in 30 days, and bursts of failed
sign-ins, are highlighted.

### Epic G: Password policies `[v2 NEW]`

**G1 (M). Edit the staff password policy.** *As the owner, I want to set the password rules for staff accounts.*
- Settings: minimum length (8–64, **default 12**); must not contain the email (**default on**); block common passwords (default off); require character types (0–4 of lower, upper, digit, symbol; **default 0**). The maximum is fixed at 200 characters, a technical limit that isn't editable.
- The screen shows a live example and guidance: "Length protects better than character rules."
- Changes apply to **new** passwords: invitations, resets and password changes.

**G2 (M). Edit the customer password policy.** *As the owner, I want to set the password rules for customer
accounts.*
- Same settings, with **defaults matching today's behaviour** (minimum 10, no other rules), so nothing changes until the owner decides.
- Applies on the storefront's set-password page (activation and reset): the form hint, the `minlength` attribute and the server check.

**G3 (S). Enforce the staff policy at next sign-in.** *As the owner, after tightening the policy, I want staff whose
password doesn't meet it to change it.*
- Passwords are stored hashed and can only be checked when typed. So with "Require at next sign-in" on, each staff sign-in checks the typed password against the current policy.
- If it fails, the member is sent to "Choose a new password" and can't use anything else until they do.
- Customers: future work.

**G4 (M).** Only the owner can see or change the policies. Every change is in the activity log (before → after).

### Epic H: My account
**H1 (S).** Any staff member can change their own password (current password required, new one checked against the
policy) and "Sign out everywhere". **`[v2 NEW]`** The page also explains what activity is recorded (F3).

## 1.5 Out of scope for this project
Email delivery; self-service "forgot password"; MFA; SSO; per-record permissions; changing a member's email.
**`[v2 CHANGED]`** Also: several owners, delegating team management, transferring sudo, owner recovery, and customer
activity events. All of these are in the future work register (§4).

## 1.6 Business risks and safeguards
| Risk | Safeguard |
|---|---|
| An invite link is forwarded or intercepted. | Single use; 72 h; **revocable at any time `[v2]`**; "Invited" status visible; link opened/used events in Activity `[v2]`; one-click removal. |
| Too much access given by mistake. | Finer permissions `[v2]`; descriptions; impact preview; Access overview; realistic templates `[v2]`. |
| Former staff keep access. | Removal blocks sign-in and ends sessions at once; attempts afterwards appear in Activity as 401 `[v2]`. |
| Only one sudo account. `[v2]` | It can't be removed or suspended through the backoffice. Losing its password needs the existing `ADMIN_PASSWORD` restart procedure; a better recovery is future work (D3). |
| Staff object to being tracked. `[v2]` | Transparent "what is recorded" text (F3); limited retention (F2). |

## 1.7 Success measures
- Every admin API route has a declared permission (the server won't start otherwise).
- **`[v2 NEW]`** Every cell of the access matrix (§2.12) passes at API level, and the menu and No access behaviour pass for every persona in the browser.
- Access ends at the next request after removal, suspension or a permission change.
- **`[v2 NEW]`** Every sign-in (successful or failed), 401, 403 and page denial appears in Activity.

---

# Part 2 — Technical

## 2.1 Architecture

```
packages/iam                        NEW, pure TypeScript, no I/O
  src/catalog.ts                    17 permissions: ids, areas, labels, descriptions, requires   [v2 CHANGED]
  src/resolve.ts                    closure(), effective(), can()
  src/templates.ts                  8 group templates                                           [v2 CHANGED]
  src/password-policy.ts            PasswordPolicy type, defaults, bounds, checkPassword()      [v2 NEW]
  src/common-passwords.ts           deny-list (server only; not imported by the backoffice)     [v2 NEW]
  src/features.ts                   backoffice feature registry: path, label, menu, permission  [v2 NEW]

packages/db                         + deleteWhere(filter): Promise<number> (both adapters, contract-tested) [v2 NEW]

apps/api/src
  auth.ts                           sv claim; hash format prefix
  staff.ts, staff-admin.ts          staff, links (incl. revoke), groups, soft delete             [v2 CHANGED]
  staff-auth.ts                     login, logout, link inspect/consume, /api/me*
  authorize.ts                      route permissions, preHandler, boot check, body rules
  activity.ts                       record(), 401 aggregation, page-view beacon, query, pruning  [v2 NEW]
  security-settings.ts              password policies + activity retention (sudo)              [v2 NEW]
  account-pages.ts                  customer set-password page reads the customer policy        [v2 CHANGED]
  migrations.ts                     migrateIam()

apps/backoffice/src/app
  features.ts (from packages/iam)   drives menu, routes' data.perm, landing page                [v2 NEW]
  auth.ts                           permission-aware guard returning RedirectCommand            [v2 CHANGED]
  no-access.ts, not-found.ts        NEW pages                                                   [v2 NEW]
  team/                             members, member, groups, group, access-matrix
  activity/                         Activity page + reusable event list                         [v2 NEW]
  settings.ts                       + Security section (password policies, retention), sudo only [v2 CHANGED]
  join.ts, account.ts               invite/reset acceptance; My account (+ forced password change) [v2 CHANGED]
```

The server remains the only authority. Backoffice checks are for UX only.

## 2.2 Data model

```ts
// "users" (existing, extended)
interface StaffUser extends Doc {
  email: string; name: string;
  passwordHash: string | null;              // null while invited; cleared on removal
  status: "invited" | "active" | "suspended" | "removed";
  sudo: boolean;                            // [v2 CHANGED] exactly one user has sudo=true; never settable through the API
  sessionVersion: number; version: number;
  mustChangePassword?: boolean;             // [v2 NEW] set at sign-in when G3 enforcement finds a non-compliant password
  createdAt: string; createdBy: string | null;
  activatedAt: string | null; lastLoginAt: string | null;
  removedAt?: string | null; removedBy?: string | null;   // [v2 CHANGED] kept (soft delete); cleared on restore
}

interface StaffGroup extends Doc { name: string; description: string; permissions: PermissionId[]; template?: string | null; createdAt: string; updatedAt: string; createdBy: string; version: number }
interface StaffMembership extends Doc { groupId: string; userId: string; addedAt: string; addedBy: string }   // id = `${groupId}:${userId}`

// "staff_links"
interface StaffLink extends Doc {
  userId: string; purpose: "invite" | "reset"; tokenHash: string;
  expiresAt: string; usedAt: string | null; createdAt: string; createdBy: string;
  revokedAt: string | null; revokedBy: string | null;    // [v2 NEW] explicit revoke (D5); a link is valid only if usedAt, revokedAt are null and not expired
}

// "staff_emails": id = normalised email → userId. [v2 CHANGED] Kept after removal (the soft-deleted account still owns
// its email); that is what lets a re-invite restore the same account.
interface StaffEmail extends Doc { userId: string }

// "security_settings", single doc id "security". [v2 NEW] Read uncached (only on password set, sign-in and the
// activity pruner), so a change applies on every instance at once.
interface SecuritySettings extends Doc {
  passwordPolicy: { staff: PasswordPolicy; customers: PasswordPolicy };
  enforceStaffPolicyAtSignIn: boolean;      // G3, default false
  activityRetentionDays: 30 | 90 | 180 | 365; // default 180
  version: number; updatedAt: string; updatedBy: string;
}
interface PasswordPolicy { minLength: number; requireClasses: 0 | 1 | 2 | 3 | 4; disallowEmail: boolean; blockCommon: boolean }

// "activity" [v2 NEW], see 2.9
interface ActivityEvent extends Doc { /* id = `${at}~${random}` (time-ordered) */ }
```

**`[v2 REMOVED]`** The `iam_state` owner-guard document. With one sudo that the API can't change, the invariant holds
by construction: no code path writes `sudo`, `status` or `passwordHash:null` for the sudo user, and a test checks that.

Caps: 200 non-removed staff, 50 groups, 500 ids per membership call.

## 2.3 Permission catalogue: full list `[v2 CHANGED]` (D6)

Ids are stable and must never be renamed. "Requires" is applied automatically (closure). Effective permissions are
`closure(∪ groups)`. The sudo has all permissions plus the sudo-only functions.

| Area | Id | Label (UI) | Requires | What it unlocks / exposes |
|---|---|---|---|---|
| Catalogue | `catalog.view` | See products and categories | — | Product list and detail, categories. |
| | `catalog.stock` **[v2 NEW]** | Update stock levels | `catalog.view` | `PATCH /api/products/:id` when the body contains **only** `stock`. |
| | `catalog.manage` | Add, edit and delete products and categories; upload images | `catalog.view`, `catalog.stock` | Prices, texts, images, active flag, categories. Changes re-render shop pages. |
| Orders | `orders.view` | See orders | — | **Customer names, emails and addresses.** |
| | `orders.fulfil` **[v2 NEW]** | Mark orders as shipped | `orders.view` | Target status `shipped`. |
| | `orders.payments` **[v2 NEW]** | Mark orders as paid or back to pending | `orders.view` | Target status `paid` or `pending`. |
| | `orders.cancel` **[v2 NEW]** | Cancel and reopen orders | `orders.view` | Target `cancelled`, or any change **from** `cancelled`. Releases discounts; orders with offers become final. |
| Customers | `customers.view` | See customers and their details | — | **PII**, the customer's order summaries, usage, personal codes. |
| | `customers.manage` | Create and edit customers | `customers.view` | Name and address; new customers. |
| | `customers.delete` **[v2 NEW]** | Delete customers (erase personal data) | `customers.view` | Irreversible; unassigns codes and may archive offers. |
| | `customers.accounts` | Customer account links and sign-out | `customers.view` | **Account takeover capable** (a reset link lets the holder set the customer's password). |
| Discounts | `discounts.view` | See offers and profiles; use the simulator | `catalog.view` | Offer definitions, profile list, offer history. |
| | `discounts.manage` | Create and change offers and profiles | `discounts.view` | Create, edit, pause, resume, archive, duplicate and delete offers; create, edit and delete profiles. |
| | `discounts.codes` **[v2 NEW]** | See, generate, export and delete voucher codes | `discounts.view` | **Cash-equivalent** codes, CSV export. |
| Pages | `pages.manage` | Design and publish pages | `catalog.view` | The page builder. Saving publishes. See S9 on trust. |
| Insights | `insights.view` | See reports | — | Revenue, discount cost, choices; CSV. |
| Settings | `settings.manage` | Change shop time zone and display | — | A time-zone change moves every offer. |

**Combined requirements** (enforced in handlers, §2.5):

| Action | Needs |
|---|---|
| Offer for specific customers (client prices) | `discounts.manage` + `customers.view` |
| Personal code for a customer | `discounts.codes` + `customers.view` |
| Simulate as a signed-in customer | `discounts.view` + `customers.view` |
| Offer redemptions (show order emails) | `discounts.view` + `orders.view` |
| See profile members | `discounts.view` + `customers.view` |
| Change profile members | `discounts.manage` + `customers.view` |

**Sudo-only (not grantable in v2):**
- Team: members, invitations, links, suspend, remove, restore.
- Groups.
- The Activity page and `/api/activity` queries.
- Security settings (password policies, activity retention).
- The unfiltered `/api/audit`.

**`[v2 REMOVED]`** `audit.view`: the activity log is sudo-only. Per-record history (e.g. an offer's History tab) needs the area's view permission.

**Not a permission:** every active member can use My account, sign out, read `/api/settings` (time zone and display, which every screen needs) and send page-view beacons.

## 2.4 Group templates `[v2 NEW]` (D7, for review)

These are offered under "New group → start from a template". Choosing one creates a normal, editable group; nothing is
created automatically. The same groups are used by the test personas (§2.12), so each one is tested cell by cell.

| # | Template | Typical person | Permissions (after closure) | Deliberately **cannot** |
|---|---|---|---|---|
| T1 | **Shop manager** | Trusted right hand, business partner | All 17 | Team, groups, activity log, security settings (sudo-only). |
| T2 | **Fulfilment** | Packer, warehouse | `catalog.view`, `catalog.stock`, `orders.view`, `orders.fulfil` | Change prices or products, mark paid, cancel, see customers, reports. |
| T3 | **Catalogue editor** | Merchandiser | `catalog.view`, `catalog.stock`, `catalog.manage` | See orders, customers, offers, reports; edit pages. |
| T4 | **Content editor** | Web designer / freelancer | `pages.manage`, `catalog.view` | Change products, see orders or customers, offers, reports. |
| T5 | **Promotions** | Marketing | `catalog.view`, `discounts.view`, `discounts.manage`, `discounts.codes`, `insights.view` | See customers (so no client prices or personal codes), see orders or redemptions, change products. |
| T6 | **Customer support** | Support agent | `customers.view`, `customers.manage`, `customers.accounts`, `orders.view`, `orders.cancel` | Delete customers (erasure stays with the manager), mark paid or shipped, offers, reports. |
| T7 | **Finance** | Accountant, bookkeeper | `orders.view`, `orders.payments`, `insights.view`, `discounts.view`, `catalog.view` | Ship or cancel, change anything else, see customers' account pages. |
| T8 | **Read-only** | Advisor, investor, auditor | `catalog.view`, `orders.view`, `customers.view`, `discounts.view`, `insights.view` | Any change. (Includes customer PII; the UI says so.) |

Design notes for review:
- **Support cancels but doesn't refund or mark paid.** Payment state belongs to Finance (T7), which matches a typical separation of duties. Remove `orders.cancel` from T6 if cancellations should go through a manager.
- **Promotions has no customer access.** Client prices and personal codes for named customers need `customers.view`, so only T1 can create them. The owner can give Promotions `customers.view` if wanted.
- **Fulfilment gets stock.** Packers are the ones who notice stock differences; they can't change prices.
- **Content editor sees products read-only**, because product grids in pages need the catalogue.

## 2.5 Authorisation enforcement (API)

Unchanged from v1 except as marked:

1. **`onRequest` (`requireAuth`)**: checks the token (`aud:"admin"`), the user, `status === "active"` and `sv`. Any failure gives 401 and **`[v2 NEW]`** an `api_unauthenticated` activity event with a reason (`no_token`, `bad_token`, `expired`, `session_ended`, `inactive`). It then loads `req.staff = { id, sudo, perms }` (not cached).
   - **`[v2 NEW]`** While `mustChangePassword` is set, every route except `/api/me*` and `/api/auth/logout` returns 403 `code:"password_change_required"`.
2. **`preHandler`**: checks the route's declared `perm`. Failure gives 403 `{ code:"forbidden", permission }` and **`[v2 NEW]`** an `api_denied` event (route pattern, method, missing permission). It runs before any data is loaded.
3. **Boot check**: the server refuses to start if any admin route has no `perm`.
4. **Body-dependent rules** via `requirePerm(req, p)`, which also gives 403 and is also recorded. **`[v2 CHANGED]`** The full list:

| Route | Declared | Handler rule |
|---|---|---|
| `PATCH /api/products/:id` | `{any:[catalog.stock, catalog.manage]}` | Body keys ⊆ {`stock`} → `catalog.stock`; otherwise `catalog.manage`. |
| `PATCH /api/orders/:id` | `{any:[orders.fulfil, orders.payments, orders.cancel]}` | Target `shipped` → `orders.fulfil`; `paid`/`pending` → `orders.payments`; `cancelled` → `orders.cancel`. If the current status is `cancelled` (reopening): `orders.cancel` **and** the target's permission. |
| `POST /api/discounts`, `PATCH /api/discounts/:id` | `discounts.manage` | `audience.type === "customers"` (new or existing) → + `customers.view`. |
| `POST /api/discounts/:id/codes` | `discounts.codes` | `assignedCustomerId` → + `customers.view`. |
| `POST /api/discounts/simulate` | `discounts.view` | `customerId` → + `customers.view`. |
| `GET /api/audit` | `authenticated` | `entity`: `discount`/`profile` → `discounts.view`; `code` → `discounts.codes`; `customer` → `customers.view`; `product`/`category` → `catalog.view`; `order` → `orders.view`; `settings` → `settings.manage`; anything else or none → sudo. |

**Route mapping** `[v2 CHANGED]`:

| Routes | Requirement |
|---|---|
| `GET /api/products`, `GET /api/products/:id`, `GET /api/categories` | `catalog.view` |
| `POST /api/products`, `DELETE /api/products/:id`, `POST /api/categories`, `DELETE /api/categories/:id` | `catalog.manage` |
| `PATCH /api/products/:id` | see body rules |
| `POST /api/uploads` | `{any:[catalog.manage, pages.manage]}` |
| `GET /api/orders` | `orders.view` |
| `PATCH /api/orders/:id` | see body rules |
| `GET/POST/PUT/PATCH/DELETE /api/pages…` | `pages.manage` |
| `GET /api/customers`, `GET /api/customers/:id` | `customers.view` |
| `POST /api/customers`, `PATCH /api/customers/:id` | `customers.manage` |
| `DELETE /api/customers/:id` | `customers.delete` |
| `POST /api/customers/:id/links`, `POST /api/customers/:id/sign-out` | `customers.accounts` |
| `GET /api/discounts`, `GET /api/discounts/:id`, `GET /api/discount-profiles`, `GET /api/discount-profiles/:id` | `discounts.view` |
| `POST /api/discounts/simulate` | see body rules |
| `POST /api/discounts`, `PATCH /api/discounts/:id` | see body rules |
| `POST /api/discounts/:id/{pause,resume,archive,duplicate}`, `DELETE /api/discounts/:id` | `discounts.manage` |
| `POST/PATCH/DELETE /api/discount-profiles…` (except members) | `discounts.manage` |
| `GET /api/discounts/:id/codes`, `DELETE /api/discounts/:id/codes/:code` | `discounts.codes` |
| `POST /api/discounts/:id/codes` | see body rules |
| `GET /api/discounts/:id/redemptions` | `{all:[discounts.view, orders.view]}` |
| `GET /api/discount-profiles/:id/members` | `{all:[discounts.view, customers.view]}` |
| `POST /api/discount-profiles/:id/members` | `{all:[discounts.manage, customers.view]}` |
| `GET /api/reports/*` | `insights.view` |
| `GET /api/settings` | `authenticated` |
| `GET /api/settings/timezone-impact`, `PATCH /api/settings` | `settings.manage` |
| `GET /api/audit` | see body rules |
| `GET /api/me`, `POST /api/me/password`, `POST /api/me/sign-out-everywhere`, `POST /api/auth/logout`, `POST /api/activity/beacon` | `authenticated` |
| `/api/staff*`, `/api/staff-groups*`, `/api/permissions`, `GET /api/activity`, `GET/PATCH /api/security-settings` | `sudo` |

## 2.6 API (new endpoints)

New routes use the strict validator, accept JSON only, and send `cache-control: no-store`.

**Public:**
| Method and path | Purpose |
|---|---|
| `POST /api/auth/login` | Checks status, limiter (IP + account), bounded inputs, constant-time check, `sv` in the token. **`[v2 NEW]`** Records `sign_in` / `sign_in_failed` with a reason. If G3 enforcement is on and the typed password fails the policy: sets `mustChangePassword` and returns `{ token, mustChangePassword: true }`. |
| `POST /api/auth/links/inspect` `{ token }` | `{ purpose, email, name, shopName, expiresAt, passwordPolicy }` **`[v2 CHANGED]`** (includes the staff policy so the form can show the rules). Invalid → 410. **`[v2 NEW]`** Records `link_opened` or `link_invalid`. |
| `POST /api/auth/links/consume` `{ token, password }` | Policy check; atomic single use (`updateWhere(link, {usedAt:null, revokedAt:null}, …)` plus an expiry check); activate; increment `sv`; returns `{ token }`. **`[v2 NEW]`** Records `link_used`. |

**Authenticated:**
| Method and path | Purpose |
|---|---|
| `GET /api/me` | `{ id, email, name, sudo, permissions, mustChangePassword, owner: { name } }`. `owner.name` is shown on the No access page. |
| `POST /api/me/password` | Current password plus a new one meeting the policy. Clears `mustChangePassword`, increments `sv`, returns a new token. |
| `POST /api/me/sign-out-everywhere` | Increments `sv`. |
| `POST /api/auth/logout` **[v2 NEW]** | Records `sign_out`. The token is stateless; the client discards it. |
| `POST /api/activity/beacon` **[v2 NEW]** `{ kind: "page_view" \| "page_denied", path, feature?, permission? }` | Records the event for the **token's** user (the client can't choose who). The path is reduced to a pathname (no query, no fragment), at most 200 characters. Rate-limited to 120 per minute per user. |

**Sudo:**
| Method and path | Purpose |
|---|---|
| `GET /api/permissions` | Catalogue and templates. |
| `GET /api/staff`, `GET /api/staff/:id` | As in v1. **`[v2 CHANGED]`** Includes `links: [{ purpose, createdAt, createdBy, expiresAt, state, stateAt }]` (no tokens or hashes). |
| `POST /api/staff` `{ email, name, groupIds? }` | Invite. **`[v2 CHANGED]`** If the email belongs to a removed member, the response is 409 `code:"removed_member"` with `{ userId, name }`, and the UI offers Restore. |
| `POST /api/staff/:id/restore` **[v2 NEW]** | Removed → invited, with no groups, `removedAt` cleared and a new invite link. The response includes the link. |
| `PATCH /api/staff/:id` `{ name?, version }` | **`[v2 CHANGED]`** Renames only; `isOwner`/`sudo` are gone from the API. |
| `POST /api/staff/:id/links` `{ purpose }` | New link; revokes earlier pending links. |
| `POST /api/staff/:id/links/revoke` **[v2 NEW]** | Revokes **all** pending links of the member, sets `revokedAt`/`revokedBy`, records `link_revoked`. Idempotent (returns the number revoked). |
| `POST /api/staff/:id/suspend`, `POST /api/staff/:id/reactivate`, `POST /api/staff/:id/sign-out` | As in v1. Targeting the sudo gives 409 `code:"sudo"`. |
| `DELETE /api/staff/:id` | **`[v2 CHANGED]`** Soft delete (2.7). Targeting the sudo gives 409. Idempotent. |
| Groups: `GET/POST /api/staff-groups`, `GET/PATCH/DELETE /api/staff-groups/:id`, `POST /api/staff-groups/:id/members` | As in v1. |
| `GET /api/activity` **[v2 NEW]** | See 2.9. JSON or CSV (`Accept`). |
| `GET /api/security-settings`, `PATCH /api/security-settings` **[v2 NEW]** | Policies and retention. Strict schema, with bounds from `packages/iam`. `version` conflict → 409. Changes are recorded as change events with before → after. |

## 2.7 Key flows

**Invite:** as in v1 (email reservation by primary key → user `invited` → memberships → link → `/join#token`).
**`[v2 CHANGED]`** On `DuplicateKeyError`, look up the reserved user: if removed, return 409 `removed_member`
(→ Restore); otherwise return 409 "already on your team".

**Revoke `[v2 NEW]`:** `updateWhere(link, { usedAt: null, revokedAt: null }, { set: { revokedAt, revokedBy } })` for
each pending link. Because `consume` guards on both fields in one atomic statement, a revoke and a consume racing on
the same link can't both win. Test: 20 parallel consumes plus a revoke; at most one succeeds.

**Remove (soft delete) `[v2 CHANGED]` (D2):**
1. Refuse if the target is the sudo or the caller.
2. `updateWhere(id, { status: { $ne: "removed" }, sudo: false }, { set: { status: "removed", passwordHash: null, mustChangePassword: false, removedAt, removedBy }, inc: { sessionVersion: 1 } })`. Sign-in and open sessions end here.
3. Revoke pending links.
4. Delete memberships, recording the list in the change event so "what they had" stays visible.
5. **Keep** the user record and the email reservation.

Clearing the password hash means that even an accidental status change couldn't let the old password work again.
History, attribution and activity stay linked to the same id.

**Restore `[v2 NEW]`:** `updateWhere(id, { status: "removed" }, { set: { status: "invited", removedAt: null, removedBy: null }, inc: { sessionVersion: 1 } })`, then a new invite link. No groups are restored automatically.

**Session revocation:** `sv` and `status` are checked on every request (unchanged).

**Sudo and bootstrap `[v2 CHANGED]` (D1, D3):**
- **First run** (no users): create the sudo from `ADMIN_EMAIL` with `ADMIN_PASSWORD` or a random printed password (today's behaviour).
- **`ADMIN_PASSWORD` set on later starts:** reset the password **only if `ADMIN_EMAIL` equals the sudo's email**, increment its `sv`, and record a `system` change event. If the emails differ, log a warning and change nothing. Never create a second sudo, and never touch staff accounts.
- Everything else about recovery and transfer is future work.

**Migration `migrateIam` `[v2 CHANGED]`** (idempotent; `settings.migrations.iam`):
1. Choose the sudo: the only user; or the user whose email equals `ADMIN_EMAIL`; or else the first user by email, with a start-up warning naming it.
2. Every **other** existing user becomes an `active` member of an auto-created group **"Shop manager (migrated)"** with all 17 permissions. So nobody loses anything they could do before; team and security functions didn't exist before.
3. All users get a name (the email's local part), `sessionVersion: 0`, `version: 1` and an email reservation.
4. Tokens without `sv` are rejected, so everyone signs in once after the upgrade.

## 2.8 Passwords and password policies `[v2 CHANGED]`

- **Policy model** (`packages/iam/password-policy.ts`, shared by the API and the backoffice):

  | Field | Bounds | Staff default | Customer default |
  |---|---|---|---|
  | `minLength` | 8–64 | **12** | **10** (today's value) |
  | `requireClasses` | 0–4 | 0 | 0 |
  | `disallowEmail` | — | true | false (today's behaviour) |
  | `blockCommon` | — | false | false |

  The maximum length is fixed at 200. Password expiry is **deliberately not offered**, because current guidance (NIST SP 800-63B) advises against forced periodic changes.
- **`checkPassword(pw, policy, { email })`** returns a list of unmet rules, used for both the error message and live hints. The common-password list is checked on the server only; it isn't shipped to the browser.
- **Where it applies:**
  - staff: `links/consume`, `me/password`, and the sign-in check when G3 is on;
  - customers: `POST /shop/account/:purpose/:token`. The hint text and `minlength` in `account-pages.ts` come from the policy (replacing `PASSWORD_MIN`, F14).
- **Storage:** the `security_settings` doc, created with the defaults on first read, and read uncached.
- **Backoffice:** Settings → **Security** section, visible to the sudo only. It has two cards (Staff accounts, Customer accounts) with the four rules, a live "example passes / fails" tester, a note that rules apply to new passwords (and, for staff, an optional "require at next sign-in" switch), and the activity retention selector. Saving shows before → after and records a change event.
- **Hashing:** unchanged from v1 (scrypt; versioned `scrypt$N$r$p$…` format for future cost upgrades); login inputs at most 200 characters.

## 2.9 Activity log `[v2 NEW]` (replaces v1 §2.8 "Auditing")

**What is recorded:**

| Kind | Source (trust) | Fields |
|---|---|---|
| `sign_in` | server | user, ip, userAgent |
| `sign_in_failed` | server | user if the email matches a staff account, else `null`; reason `bad_password` / `unknown_account` / `invited` / `suspended` / `removed` / `throttled`. **The typed email is never stored for unknown accounts**: people sometimes type their password into the email field. |
| `sign_out`, `session_ended` | server | `session_ended` is recorded when a revoked or expired session is refused (useful after removing someone). |
| `link_created`, `link_opened`, `link_used`, `link_revoked`, `link_invalid` | server | target user, purpose. Never the token or its hash. |
| `page_view`, `page_denied` | **backoffice beacon (informational)** | path (pathname only), feature id, missing permission. The user comes from the token, so it can't be forged; the path can, and a user could also suppress beacons. |
| `api_denied` (403) | server (authoritative) | method, route pattern, missing permission |
| `api_unauthenticated` (401) | server | method, route pattern, reason, ip. Aggregated (below). |
| `change` | server (from `audit()`) | action, entity, entityId, summary, `auditId` (full before → after stays in `audit_log`) |

**Storage:**
- A new `activity` collection with **time-ordered ids** (`${ISO time}~${8 random chars}`). The primary key is then the time index in both adapters: newest-first listing and cursor pagination (`id < cursor`) use it, so `DataStore` needs no index support.
- `userAgent` is truncated to 200 characters and `path` to 200.
- `audit()` writes its `audit_log` row as today **and** a `change` event, so the Activity page reads one collection.

**Aggregation (log-flood protection):**
- `api_unauthenticated` and `sign_in_failed` with reason `throttled` use deterministic ids `${minute}~${hash(kind, ip, route, reason)}`: insert on the first hit, then `updateWhere(…, { inc: { count: 1 } })`. That is at most one row per key per minute, atomic and safe across instances.
- A global ceiling of 1,000 aggregated rows per minute; beyond it one `dropped` counter row. A scanner hammering the API can't fill the disk.

**Retention:**
- An hourly job calls `activity.deleteWhere({ at: { $lt: cutoff } })`. This adds **`deleteWhere`** to the `DataStore` contract (SQLite: `DELETE … WHERE`; Mongo: `deleteMany`), tested in the shared contract.
- `audit_log` (change history with before/after) is not pruned. It powers per-record history, as today.

**Query:** `GET /api/activity?kinds=&userId=&ip=&from=&to=&q=&before=<id>&limit=50`. Returns events newest-first with
the user's name and status (removed users show "(removed)"), or CSV via `Accept` (`csvCell` neutralises formulas, which
matters because paths and user agents are user-controlled).

**Backoffice:**
- **Activity** (menu, sudo only): filter chips for the kinds, person picker, date range, IP and text search.
- Each row shows time, person, kind icon, summary and IP. It expands to show details; for changes that means before → after, loaded from `audit_log` by `auditId`.
- One-click pivots "this person" / "this IP"; Load more; Download CSV.
- The same component, filtered, is used on the member detail page.
- **Beacons:** an `ActivityService` listens to `NavigationEnd` and posts `page_view { path: location.pathname, feature }`. The No access page posts `page_denied`. The `/join` page **never** sends beacons (it isn't signed in, and its fragment holds the token).

## 2.10 Backoffice `[v2 CHANGED]`

**Feature registry: a single source of truth** (`packages/iam/features.ts`):
```ts
{ id: "orders", label: "Orders", path: "/orders", menu: "main", icon: "orders", perm: "orders.view",
  children: [{ path: "/orders/:id", perm: "orders.view" }] }
{ id: "discounts", …, perm: "discounts.view", children: [{ path: "/discounts/new", perm: "discounts.manage" },
  { path: "/discounts/simulate", perm: "discounts.view" }, { path: "/discounts/profiles", perm: "discounts.view" }, …] }
{ id: "settings", menu: "foot", perm: "settings.manage" }   { id: "team", menu: "foot", perm: "sudo" }
{ id: "activity", menu: "main", perm: "sudo" }             { id: "account", menu: "foot", perm: "authenticated" }
```
- `app.routes.ts` builds `data: { feature, perm }` from the registry.
- `app.html` renders the menu from the registry, filtered by `api.can(perm)`. No hand-written `@if` per link, so the menu and the guards can't drift apart.
- The landing page (`''` and after sign-in) is the first registry entry the user may open; with none, it is `/welcome` ("No access yet").
- A unit test checks that every route in `app.routes.ts` is in the registry and vice versa.

**Guard:** the existing `authGuard` becomes `accessGuard`:
- no token → `/login`;
- wait for `me`;
- `mustChangePassword` → `/account?required=1`;
- missing permission → `new RedirectCommand(router.parseUrl('/no-access'), { skipLocationChange: true, state: { feature, perm, url } })`. The address bar keeps the requested URL, and reload re-checks.

**No access page** (`no-access.ts`):
- title "You don't have access to *{feature label}*";
- the missing permission's label from the catalogue;
- "Ask {owner name} to add you to a group that includes it";
- buttons "Go to {landing page}" and "Sign out".

It posts a `page_denied` beacon. It is also shown when:
- the interceptor gets a 403 `forbidden` on a page load: it refreshes `me` and re-runs the current route, and the guard then shows No access;
- `me` is refreshed (on focus or every 5 minutes) and the current route is no longer allowed.

The menu re-renders from the new `me` at the same time. A 401 still signs out.

**Not found page:** a wildcard route (`**`) → "Page not found", with a link to the landing page (F15).

**Screens:** read-only modes as in v1, plus finer controls:

| Screen | Change |
|---|---|
| Products | With only `catalog.stock`, the stock field is editable and everything else is read-only. |
| Orders | The status menu lists only allowed targets (F13 rules). An order the user can't change shows a pill, not a menu. |
| Discount editor | Codes tab needs `discounts.codes`. "Specific customers" audience and personal codes need `customers.view`. Redemptions tab needs `orders.view`. |
| Customer detail | Delete needs `customers.delete`. "Give a personal code" needs `discounts.codes`. |
| Settings | The whole page needs `settings.manage`; the Security section is sudo-only. |

**New screens:**
- Team: members, member, groups, group, Access overview. **`[v2 CHANGED]`** The member page has link history with **Revoke link**, Restore for removed members, and an embedded activity list.
- **Activity** (§2.9).
- **Settings → Security** (§2.8).
- No access, Not found, Welcome ("No access yet").
- `/join`.
- `/account`, including the forced-change mode and the "what is recorded" text.

## 2.11 Configuration and docs
- `BACKOFFICE_URL` (optional) for absolute invite and reset links (D8).
- README: IAM, the single sudo, the `ADMIN_PASSWORD` behaviour (§2.7), backoffice hosting and CSP, the activity log and retention.
- `seed-demo.py`: creates the 8 template groups and one member per template (the personas in §2.12), so the demo shop shows a realistic team. Demo only.

## 2.12 Testing `[v2 CHANGED]`: personas and access matrix

### 2.12.1 Test personas
The personas are created through the **real flows** (sudo invites → link consumed → password set), so every test run
also exercises onboarding.

| Persona | Groups | Purpose |
|---|---|---|
| **Olivia** | — (sudo) | Everything, including sudo-only functions. |
| **Sam** | T1 Shop manager | Everything except sudo-only. |
| **Pat** | T2 Fulfilment | |
| **Cleo** | T3 Catalogue editor | |
| **Dana** | T4 Content editor | |
| **Max** | T5 Promotions | |
| **Suki** | T6 Customer support | |
| **Finn** | T7 Finance | |
| **Vera** | T8 Read-only | |
| **Nico** | none | Active but no permissions. |
| **Mia** | T2 + T4 | Union of two groups. |
| **Ivy** | T2, **invited** (never accepted) | Can't sign in. |
| **Sid** | T2, **suspended** | Can't sign in; a token from before the suspension gets 401. |
| **Rex** | T2, **removed** | Can't sign in; old token 401; history kept; Restore works. |

### 2.12.2 Access matrix (expected results)

✓ = allowed, — = must be refused (403 from the API, and hidden or No access in the UI). For "View" rows, allowed
also means the menu entry is visible.

| # | Functionality | Olivia (sudo) | Sam (T1) | Pat (T2) | Cleo (T3) | Dana (T4) | Max (T5) | Suki (T6) | Finn (T7) | Vera (T8) | Nico (—) | Mia (T2+T4) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| C1 | See products and categories | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | — | ✓ |
| C2 | Update stock only | ✓ | ✓ | ✓ | ✓ | — | — | — | — | — | — | ✓ |
| C3 | Create or edit a product (price, text, images, active) | ✓ | ✓ | — | ✓ | — | — | — | — | — | — | — |
| C4 | Delete a product | ✓ | ✓ | — | ✓ | — | — | — | — | — | — | — |
| C5 | Create or delete a category | ✓ | ✓ | — | ✓ | — | — | — | — | — | — | — |
| C6 | Upload an image | ✓ | ✓ | — | ✓ | ✓ | — | — | — | — | — | ✓ |
| O1 | See orders | ✓ | ✓ | ✓ | — | — | — | ✓ | ✓ | ✓ | — | ✓ |
| O2 | Mark shipped | ✓ | ✓ | ✓ | — | — | — | — | — | — | — | ✓ |
| O3 | Mark paid / back to pending | ✓ | ✓ | — | — | — | — | — | ✓ | — | — | — |
| O4 | Cancel an order | ✓ | ✓ | — | — | — | — | ✓ | — | — | — | — |
| O5 | Reopen a cancelled order (to pending) | ✓ | ✓ | — | — | — | — | — ¹ | — | — | — | — |
| U1 | See customers and detail | ✓ | ✓ | — | — | — | — | ✓ | — | ✓ | — | — |
| U2 | Create or edit a customer | ✓ | ✓ | — | — | — | — | ✓ | — | — | — | — |
| U3 | Delete a customer | ✓ | ✓ | — | — | — | — | — | — | — | — | — |
| U4 | Customer activation/reset link; sign customer out | ✓ | ✓ | — | — | — | — | ✓ | — | — | — | — |
| D1 | See offers and profiles; simulator (no customer) | ✓ | ✓ | — | — | — | ✓ | — | ✓ | ✓ | — | — |
| D2 | Simulate as a specific customer | ✓ | ✓ | — | — | — | — | — | — | ✓ | — | — |
| D3 | Create, edit, pause, archive, delete offers; profiles | ✓ | ✓ | — | — | — | ✓ | — | — | — | — | — |
| D4 | Offer for specific customers (client price) | ✓ | ✓ | — | — | — | — ² | — | — | — | — | — |
| D5 | Voucher codes: list, generate, CSV, delete | ✓ | ✓ | — | — | — | ✓ | — | — | — | — | — |
| D6 | Give a customer a personal code | ✓ | ✓ | — | — | — | — | — | — | — | — | — |
| D7 | Offer redemptions | ✓ | ✓ | — | — | — | — | — | ✓ | ✓ | — | — |
| D8 | See profile members | ✓ | ✓ | — | — | — | — | — | — | ✓ | — | — |
| D9 | Change profile members | ✓ | ✓ | — | — | — | — | — | — | — | — | — |
| P1 | Pages: list, open builder, save/publish, rename, delete | ✓ | ✓ | — | — | ✓ | — | — | — | — | — | ✓ |
| I1 | Insights reports and CSV | ✓ | ✓ | — | — | — | ✓ | — | ✓ | ✓ | — | — |
| S1 | Change time zone / display settings | ✓ | ✓ | — | — | — | — | — | — | — | — | — |
| X1 | Team: list, invite, revoke link, suspend, remove, restore | ✓ | — | — | — | — | — | — | — | — | — | — |
| X2 | Permission groups | ✓ | — | — | — | — | — | — | — | — | — | — |
| X3 | Activity page | ✓ | — | — | — | — | — | — | — | — | — | — |
| X4 | Security settings (password policies, retention) | ✓ | — | — | — | — | — | — | — | — | — | — |
| A1 | Sign in; My account; change own password; sign out everywhere | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

¹ Reopening to `pending` needs `orders.cancel` **and** `orders.payments`; Suki has only the first. This cell tests the
combined rule; the owner may adjust T6 after review.
² Promotions has no `customers.view` by design (§2.4 notes).

Ivy, Sid and Rex: **A1 is refused** (sign-in returns the generic 401, recorded with its reason), and every other row is
— (an old token gets 401).

**Expected menu per persona** (checked in the browser):

| Persona | Menu entries |
|---|---|
| Olivia | Products, Categories, Orders, Discounts, Customers, Insights, Pages, Activity · Settings, Team, My account |
| Sam | Products, Categories, Orders, Discounts, Customers, Insights, Pages · Settings, My account |
| Pat | Products, Categories, Orders · My account |
| Cleo | Products, Categories · My account |
| Dana | Products, Categories, Pages · My account |
| Max | Products, Categories, Discounts, Insights · My account |
| Suki | Orders, Customers · My account |
| Finn | Products, Categories, Orders, Discounts, Insights · My account |
| Vera | Products, Categories, Orders, Discounts, Customers, Insights · My account |
| Nico | My account (landing: "No access yet") |
| Mia | Products, Categories, Orders, Pages · My account |

### 2.12.3 How the matrix is tested
- **One data file** (`apps/api/test/access-matrix.json`) holds the personas, and for each row: representative request(s) with fixtures and the expected status when allowed (e.g. 200/201/204), plus the set of personas allowed. It also lists the UI route(s) and the control selector for each row. The API tests, the Vitest tests and `e2e-backoffice.py` all read this file, so there is one truth.
- **Completeness checks:**
  - every registered admin route appears in at least one matrix row;
  - every permission in the catalogue is exercised by at least one row where it makes the difference (granted → ✓, removed → —);
  - every registry feature appears in the menu table.
- **API level** (`node --test`, in-memory SQLite): for every row × persona, run the request(s) on fresh fixtures (deletes get their own). Allowed → the exact expected status; refused → **403**, plus an `api_denied` event with the right permission. Invited, suspended and removed personas: sign-in refused and an old token gets 401 (plus `session_ended` or `api_unauthenticated` events). Around 35 rows × 14 personas ≈ 500 cases; in-memory this should take seconds.
- **Unit level (Vitest):** for each persona's `me`:
  - the rendered menu equals the expected menu table;
  - the guard lets allowed routes through and shows No access for the others (URL unchanged);
  - read-only controls are hidden or disabled as in §2.10 (e.g. Pat's order menu offers only "Shipped").
- **Browser level (Playwright, `e2e-backoffice.py`):** for each persona:
  1. sign in; check the landing page and the menu;
  2. open **every** feature URL directly: permitted → the screen; otherwise → No access with the URL kept;
  3. perform one real action per ✓ "change" row;
  4. check that the Activity page (as Olivia) lists the persona's sign-in, page views, denials and changes.

  Also: revoke Pat's group while Pat has Orders open → the next action shows No access, and the menu shrinks.
- **Report:** the test run writes `access-report.md`, the matrix with ✓/— actual vs expected and any mismatch highlighted, for review and as a CI artefact.

### 2.12.4 Other tests
- **`packages/iam`:** closure, templates valid (and equal to the §2.4 table), `checkPassword` table tests (each rule, bounds, Unicode length), feature registry consistency.
- **`packages/db`:** `deleteWhere` in the shared contract (both adapters).
- **Flows:**
  - invite, inspect, consume, sign-in;
  - parallel consume (exactly one), and consume racing revoke;
  - revoke within the window → 410; new link revokes old;
  - parallel invites of one email → one 201;
  - soft delete: can't sign in, old token 401, history kept, record kept, restore works, no groups restored;
  - the sudo can't be suspended or removed, and no route can change `sudo`;
  - migration with 1 user and with 3 users (sudo choice, migrated group);
  - the `ADMIN_PASSWORD` fence (different email → no change).
- **Password policy:** applies to staff consume, staff change and the customer set-password page (form hint, `minlength`, server check); bounds enforced; sudo-only; changes recorded; G3 forced change (`password_change_required` on other routes until changed).
- **Activity:** every kind recorded at its source; no secrets in events (`passwordHash`, `tokenHash`, tokens, unknown typed emails); 401 aggregation (1,000 anonymous requests in one minute → bounded rows with correct counts); flood ceiling; retention pruning; beacon can't set another user; `/join` sends no beacon; CSV formula neutralisation.
- Existing tests that hand-craft tokens add `sv`; `main.test.ts` still checks that a session survives a restart.

## 2.13 Phases (rough, one developer) `[v2 CHANGED]`
| Phase | Content | Estimate |
|---|---|---|
| **P0 Foundations** | `packages/iam` (catalogue, closure, registry); model and migration (single sudo, migrated group); `sv` tokens; login limiter and bounds; permissions on all routes, body rules, boot check; `/api/me`; registry-driven menu, guard, No access, Not found, Welcome. | 4–5 days |
| **P1 Team and invitations** | Staff routes, links with revoke and history, soft delete and restore, suspend, `/join`, My account, Members screen and Access overview. | 3–4 days |
| **P2 Groups** | Group routes and editor, templates, impact preview, membership both ways, read-only and fine-grained modes of existing screens. | 3 days |
| **P3 Activity log** | `activity` collection, recording at all sources, 401 aggregation, beacons, `deleteWhere` and pruning, Activity page and member embed, CSV. | 3 days |
| **P4 Password policies** | Policy model and checks, security settings API and UI, storefront integration, G3 enforcement. | 2 days |
| **P5 Access matrix and e2e** | Personas, matrix data file, API/unit/browser drivers, completeness checks, report. | 2–3 days |
| **P6 Hardening** | Backoffice CSP and hosting doc, builder canvas isolation (S9), hash-format upgrade. | 2 days |

Total about **19–24 days**. P0 is safe to release alone: the sudo sees no change, and migrated users keep full access.

---

# Part 3 — Security

Measures are unchanged from v1 except as marked.

| # | Topic | Measures |
|---|---|---|
| S1 | Server-side enforcement | Declared permission on every route; default deny; boot check; permission check before data access. **`[v2 CHANGED]`** Verified by the **full access matrix** at API level, plus completeness checks. |
| S2 | Cross-area data exposure | PII-marked permissions; `requires`; **`[v2 CHANGED]`** combined requirements table (§2.3) and body rules (§2.5). |
| S3 | Immediate revocation | `sv` and `status` checked per request; permissions not in the token. |
| S4 | Invitation links | 256-bit random, hash only, single use (atomic), 72 h / 24 h, fragment URL stripped on load, shown once, never logged. **`[v2 CHANGED]`** Explicit revoke at any time; consume and revoke guarded in one atomic statement; link events in Activity so the owner can see when a link was opened and used. |
| S5 | Privilege escalation | **`[v2 CHANGED]`** A single sudo; no API path can grant, change or remove sudo, so there's no owner escalation at all. Team, groups, activity and security settings are sudo-only. The delegation rules from v1 move to future work. |
| S6 | Step-up authentication | **`[v2 REMOVED → future work]`** Owner promotion no longer exists. |
| S7 | Brute force and enumeration | Limiter per IP and per account; bounded inputs; constant-time checks; generic 401. **`[v2 NEW]`** Failed sign-ins are visible in Activity (with the reason) without storing typed unknown emails. |
| S8 | Lock-out | **`[v2 CHANGED]`** The sudo can't be removed, suspended or demoted through the API (test-enforced). A lost sudo password → the existing `ADMIN_PASSWORD` restart, fenced to the sudo. Better recovery is future work. |
| S9 | XSS → session theft | Unchanged (backoffice CSP, builder isolation in P6; cookie sessions later per D4). Until P6 ships, give `pages.manage` only to trusted people; the T4 description says so. |
| S10 | CSRF | Bearer tokens; JSON-only IAM routes. **`[v2 NEW]`** The beacon endpoint is JSON-only and authenticated, so it can't be triggered cross-site. |
| S11 | Secrets in responses and logs | `publicStaff` projection; tokens only in the single link response; `no-store`. **`[v2 NEW]`** Activity events are built from explicit field lists (never whole documents); tests check that no hashes, tokens or unknown typed emails are stored. |
| S12 | Password storage and policy | scrypt, versioned format. **`[v2 CHANGED]`** Editable policies with **server-enforced bounds** (minimum never below 8; maximum fixed at 200), so the policy screen can't switch protection off. Only the sudo can edit it, and every change is recorded. No forced expiry (NIST). |
| S13 | Races without transactions | Email reservation; atomic consume and revoke; deterministic membership ids; `version`. **`[v2 CHANGED]`** Owner-guard counter removed (not needed). **`[v2 NEW]`** Aggregated activity rows use atomic `updateWhere` increments. |
| S14 | No MFA | Future work. |
| S15 | Separation from customers | Unchanged. **`[v2 NEW]`** The customer policy is separate from the staff policy. |
| S16 | Leavers' data / privacy | **`[v2 CHANGED]`** Soft delete keeps the name, email and full history by design (D2). **`[v2 NEW]`** Activity contains IPs and browsing of staff, which is personal data: retention is limited (default 180 days, auto-pruned), access is sudo-only, and staff are told what is recorded (F3). Whether consent or notice is needed depends on the jurisdiction; the owner should check. |
| S17 | Multi-instance | Permissions, status and security settings are uncached. **`[v2 NEW]`** Activity aggregation is multi-instance safe (deterministic ids). The limiter stays per process (future work). |
| S18 **[v2 NEW]** | Activity log integrity and abuse | (1) **Flooding:** 401 aggregation, a per-minute ceiling and beacon rate limits bound growth. (2) **Forgery:** beacons can't choose the user; page views are labelled informational, while authoritative events (sign-in, 401/403, changes) come only from the server. (3) **Tampering:** no API updates or deletes activity except the retention pruner; the log is append-only through the application. Protection against someone with database access is future work. (4) **Injection:** paths and user agents are truncated, rendered with Angular interpolation (escaped) and exported through `csvCell`. |

---

# Part 4 — Future work register `[v2 NEW]`

Logged on purpose and **not** addressed in this project, per the owner's review.

| # | Item | Origin | Notes |
|---|---|---|---|
| FW1 | Several owners; delegating team management (e.g. a grantable `team.manage`) | D1 | Rules already drafted: a delegate grants only permissions they hold themselves, can't touch the owner or themselves, and can't grant `team.manage`. |
| FW2 | Transfer sudo to another person | D1 | Needs step-up (FW3) and an acceptance by the new owner. |
| FW3 | Step-up re-authentication for critical actions | v1 S6 | Owner transfer, policy weakening, removal of many members. |
| FW4 | Owner account recovery and bootstrap redesign | D3 | Replace the `ADMIN_PASSWORD` restart with a deliberate, audited recovery procedure (e.g. a one-time CLI-generated reset link). |
| FW5 | Admin session in an HttpOnly cookie (+ CSRF `Origin` checks), with an idle timeout | D4, limitation 1, review R1/R8 | Confirmed as future work after the security review. Today: an 8 h token in `localStorage`, protected by the backoffice CSP and Angular escaping. |
| FW6 | Shared rate limiting across instances | limitation 2 | e.g. counters in the DataStore via `updateWhere`. Until then, see the deployment notes (`docs/backoffice-hosting.md`): limits are per process, and `TRUST_PROXY` must be set behind a reverse proxy. |
| FW7 | MFA (TOTP), owner first | limitation 3 | Needs no email. **Out of scope** (owner decision after the security review). |
| FW8 | Bearer-link hardening (e.g. the invitee confirms their email address) | limitation 4 | Inherent to copy-and-send links. |
| FW9 | Per-record permissions | limitation 5 | e.g. "only these pages". |
| FW10 | Customer password policy enforcement at sign-in | G3 | The storefront needs a forced-change page. |
| FW11 | Customer account events in Activity | F1 | Customer sign-ins and link use. |
| FW12 | Revoke customer account links explicitly | D5 (consistency) | Same mechanism as staff links. |
| FW13 | Tamper evidence for the activity log (hash chain or export to external storage) | S18 | |
| FW14 | Membership end dates for groups (temporary access, e.g. freelancers) | v1 1.5 | Same pattern as profile members. |
| FW15 | Sandbox the page-builder canvas (`sandbox="allow-scripts"`, `postMessage` protocol) | P6 | The CSP already blocks injected scripts there; sandboxing would also contain a bug in the canvas script itself. **Out of scope** (owner decision after the security review). |
| FW16 | Retention or anonymisation of the history log (`audit_log`) | open topics review | The history log is never deleted, unlike the activity log, and contains personal data (customer names and emails in customer changes, staff names and emails). It needs a retention period, or anonymisation of people who are deleted or removed, to match the privacy rules the shop follows. |
| FW17 | Run the DataStore contract and the IAM tests against a real MongoDB | open topics review | The Mongo adapter (including the new `deleteWhere` and the cursor and `$in` queries of the activity and history logs) has only run against the in-memory stand-in for the driver. Run `MONGO_URL=… npm test` before using MongoDB in production. |

**Decided out of scope** (owner review of the open topics after the security review; not planned):

| Topic | Origin |
|---|---|
| Raising the password-hashing cost and rehashing on sign-in | security review R3 |
| Sandboxing the page-builder canvas | FW15 |
| Two-factor sign-in (TOTP) | FW7 |
| `npm audit` in CI | security review R9 |
| Verifying the production build with font inlining | this environment has no internet |
| Highlighting suspicious sign-ins | story F4 (C) |
| A larger common-password list (today about 230 entries) | password policy |

The deployment notes (reverse proxy and `TRUST_PROXY`, per-process limits, database indexes) are in
`docs/backoffice-hosting.md`.

---

## Owner decisions (recorded)

| # | Decision | Where applied |
|---|---|---|
| **D1** | A single sudo account for now; multiple owners and delegation are future work. | §1.3, §2.2, §2.7, S5, FW1–FW2 |
| **D2** | Remove = soft delete: blocks new sign-ins (and ends open sessions), keeps all history; restore via re-invite. | D1 story, §2.7 |
| **D3** | Recovery and bootstrap are not a concern now: keep today's behaviour, fenced to the sudo; redesign later. | §2.7, FW4 |
| **D4** | Agreed: cookie sessions later; CSP and builder isolation in P6. | S9, FW5 |
| **D5** | Agreed: 72 h invites (24 h resets), **plus explicit revoke at any time within the window**. | C3, §2.6, §2.7 |
| **D6** | Initial approach: 17 permissions (§2.3) plus sudo-only functions. For review. | §2.3 |
| **D7** | 8 templates for review (§2.4), also used as the test personas. | §2.4, §2.12 |
| **D8** | Agreed: `/join#token` on the backoffice; `BACKOFFICE_URL` optional. | §2.6, §2.11 |
| **Open topics** | Reviewed after the security review: templates kept as they are; history-log retention (FW16), cookie session (FW5) and real MongoDB testing (FW17) are future work; several owners, delegation and recovery stay future work (FW1, FW2, FW4); reverse proxy and indexes become deployment notes; the rest is out of scope (list above). | Part 4 |

**Open points of v2** (all approved by the owner before implementation):
1. The 17 permissions (§2.3), especially the order split (ship / payment / cancel) and stock-only.
2. The 8 templates and their "cannot" lists (§2.4), including Support cancelling orders and Promotions having no customer access.
3. The default activity retention (180 days) and whether customer events are wanted later (FW11).
4. Password policy defaults and bounds (§2.8).

# OpenShop backoffice IAM (team, permission groups, invitations): implementation plan (v1)

Status: **plan, not implemented.** It covers (1) business user stories, (2) technical implementation, (3) security.
Items marked **Dn** are decisions for the owner. Each one comes with a recommended default, and the plan is written
assuming those defaults.

Scope requested by the owner:
- see every current staff member and their current permissions;
- create permission groups and manage who is in each;
- invite new users (no email: the backoffice generates a one-time URL that the owner copies and sends by hand);
- remove users.

---

## 0. How the current code shapes this plan

| # | Finding | Where | Consequence for IAM |
|---|---|---|---|
| F1 | A `users` collection exists, but every user is a full admin. `User` is only `{ email, passwordHash }`. There are no roles, names or status. | `apps/api/src/types.ts`, `app.ts` | The model needs extending, plus a migration. Every existing user becomes an **owner**, so nobody loses access on upgrade. |
| F2 | `requireAuth` is a single `onRequest` hook on one Fastify scope that holds **all** admin routes (about 60 routes in `app.ts`, `discounts.ts`, `customers-admin.ts`, `insights.ts`). It checks the token and that the user exists. | `app.ts` | Authorisation can go in the same scope as one extra hook, with a permission declared on each route. No route has one yet, so every route must be mapped (§2.4). |
| F3 | Admin tokens are stateless HMAC tokens (`aud:"admin"`, 8 h), with **no session version**. Verified: a token issued before a password change still returns 200 afterwards. | `auth.ts` | Suspending, removing or resetting a user would not end their open sessions. Admin tokens need the `sv` claim that customer sessions already have. |
| F4 | The backoffice keeps the token in **`localStorage`** and sends it as `Authorization: Bearer`. | `backoffice/src/app/api.service.ts`, `auth.ts` | This is immune to CSRF, but any XSS in the backoffice can steal the token. It matters more once staff have different privilege levels (§3, S9). |
| F5 | The page-builder canvas is a **same-origin, non-sandboxed `srcdoc` iframe** that calls `window.parent.osBuilderHost`. | `builder/builder.ts`, `public/builder-frame.js` | Renderer output runs with the backoffice's privileges. A staff member allowed only to edit pages must not be able to reach the owner's token (§3, S9). |
| F6 | `DataStore` guarantees uniqueness only on `id`. It has no transactions or secondary unique indexes; `updateWhere` is the only atomic primitive. | `packages/db` | Email uniqueness needs a reservation document keyed by email. The "at least one owner" rule needs an atomic guard document (§2.2, §2.6). |
| F7 | Customer accounts already use owner-generated one-time links: 32 random bytes, only the SHA-256 stored, single use through `updateWhere({usedAt:null})`, 72 h, earlier links revoked. | `accounts.ts`, `customers-admin.ts` | Staff invitations reuse the same proven pattern and the same backoffice "copy link" UI. |
| F8 | Admin login throttling is **per IP only**, in an unbounded in-process `Map`. Verified: after 10 failures from one IP, another IP can keep guessing the same account. The `password` field has no `maxLength` (a 900 KB password is accepted and hashed). | `app.ts` (login) | Switch to `FailureLimiter` keyed by IP **and** by account, and bound the input length. |
| F9 | `ensureAdmin` runs on **every start** when `ADMIN_PASSWORD` is set. It creates the user or resets its password. | `main.ts`, `auth.ts` | This is the recovery path (break-glass). It must also restore owner status and stay consistent with the last-owner guard (D3). |
| F10 | The audit log stores `userId` only, and some call sites store whole documents as before/after. | `audit.ts`, `discounts.ts` | User records must be projected (no hashes) before auditing. The UI needs names for user ids, including removed users (D2). |
| F11 | Screens call APIs outside their own area. The page builder needs products and categories. The discount editor loads the **full customer list** (PII). Customer detail creates codes through the discounts API. Almost every screen reads `/api/settings`. | `backoffice/src/app/**` | Permissions need declared dependencies, and some checks depend on the request body. A screen-by-screen list is not enough (§2.3). |
| F12 | No CSP is set for the backoffice. The API does not serve it; it's built with `ng build` and hosted separately. | `angular.json`, `proxy.conf.json` | The plan has to say how the backoffice is served (§3, S9). |

Baseline checked before planning: `npm install`, then API tests 53/53 and the DB contract tests pass.

---

# Part 1 — Business

## 1.1 Goal
Let the shop owner give other people access to the backoffice with only the rights they need, see at any moment who
can do what, and take access away instantly. No email server is needed.

## 1.2 Personas (demo shop Maison Dune)
- **Owner**: runs the shop and has full access. Usually one person, sometimes two partners.
- **Fulfilment staff** (e.g. a packer): sees orders, marks them paid or shipped, and checks stock. Must not see revenue reports or change prices.
- **Marketing freelancer**: edits pages and runs offers for a campaign, for a few weeks only. Must not export customers or change order states.
- **Customer support**: looks up customers and orders, and creates account activation or reset links for customers.
- **Invitee**: someone who received a link and has no account yet.

## 1.3 Glossary
- **Staff member**: a backoffice user. This is separate from shop **customers**; the two never share sessions or accounts.
- **Permission**: a fixed capability defined by OpenShop, e.g. "See orders" or "Change order status" (§2.3).
- **Permission group**: a named set of permissions created by the owner, e.g. "Fulfilment". A staff member can be in several groups and gets the **union** of their permissions.
- **Owner**: a staff member with every permission, including managing the team. Owner status is a flag on the user, not a group. There is always at least one active owner.

## 1.4 User stories

Priority: **M** = must (requested), **S** = should (needed for the feature to be safe or usable), **C** = could.

### Epic A: Team overview

**A1 (M). See the team.** *As the owner, I want to see every staff member with their status and groups, so that I
know who has access to my shop.*
- The list shows the name, email, status (Owner, Active, Invited, Invitation expired, Suspended), groups, last sign-in and invitation date.
- Removed members are hidden by default. A "Show removed" filter shows them read-only (D2).
- You can search by name or email and filter by status or group.
- Only owners can open the Team section. Other staff don't see the menu entry, and the API returns 403.

**A2 (M). See current permissions.** *As the owner, I want to see what each person can actually do, so that I can
check that nobody has more access than they need.*
- An **Access overview** matrix shows people as rows and areas as columns (Catalogue, Orders, Customers, Discounts, Pages, Insights, Settings, Activity log). Each cell says `—`, `View` or `Manage` (plus `+ accounts` for customer account links).
- A member's detail page lists their **effective** permissions, each with the group(s) it comes from, e.g. "Change order status, from *Fulfilment*".
- Owners show "All permissions".
- The view is always computed live from groups, so it can't get out of date.
- The list can be downloaded as CSV, using the same URL with `Accept: text/csv`, as elsewhere in the backoffice.

**A3 (C). See activity.** *As the owner, I want a history of team changes and of what each member did, so that I
can answer "who changed this?".*
- The Team area has an "Activity" tab showing invitations, acceptances, group changes, membership changes, suspensions and removals: who did it, when, and before → after.
- Member detail has a "Recent actions by this person" list, drawn from the existing audit log.
- The existing audit views (e.g. offer history) show **names** instead of user ids. Removed people show as "Name (removed)".

### Epic B: Permission groups

**B1 (M). Create a group.** *As the owner, I want to create a group with a name, a description and a set of
permissions, so that I can give the same access to several people at once.*
- Permissions are shown by area, each with **View** and **Manage** checkboxes and a plain-language description of what the permission unlocks and what data it exposes (e.g. "See orders: includes customer names, emails and addresses").
- Ticking a permission also ticks the ones it needs, with an explanation (e.g. "Manage products needs See products"). The server applies the same rule.
- Optional **templates** fill the form: Fulfilment, Catalogue editor, Marketing, Customer support (D7). Templates are a starting point only and are never applied automatically.
- Names are 1–120 characters and descriptions at most 500. A duplicate name gets a warning.

**B2 (M). Edit a group.** *As the owner, I want to change a group's permissions, so that access can change as the shop
evolves.*
- Before saving, the screen shows the impact: "This changes access for 3 people: Ana, Tomás, Lena". Removed permissions are highlighted.
- Changes take effect on every member's **next request**, without signing anyone out.
- If two owners edit the same group at once, the second save gets "This group was changed by someone else. Reload it and try again." (`version` check, as for offers and profiles).

**B3 (M). Manage members of a group.** *As the owner, I want to add people to and remove people from a group, from
the group page or from the person's page, so that I can manage access in whichever direction is quicker.*
- Adding and removing take effect immediately and are idempotent: adding someone twice does nothing.
- Invited (not yet active) members can already be placed in groups.

**B4 (M). Delete a group.** *As the owner, I want to delete a group I no longer need.*
- A confirmation says "N people will lose these permissions" and lists them. Memberships are removed together with the group.

**B5 (S). No surprise grants in future releases.** *As the owner, I want new OpenShop features to be off for existing
groups, so that an upgrade never gives staff more access.*
- New permissions are off in every group by default. Owners get them automatically. The release notes list new permissions.

### Epic C: Invitations and onboarding

**C1 (M). Invite someone.** *As the owner, I want to enter an email, a name and optionally some groups, and get a
one-time link to send myself, so that I can add staff without an email server.*
- The result shows the full link **once** with a "Copy link" button and its expiry ("works once, until 14 May, 18:00"). The text says: *Send it privately. Anyone who opens this link can create this account.*
- The member appears in the list as **Invited**, with the expiry date.
- Inviting an email that already belongs to a non-removed staff member is refused: "This person is already on your team."
- The email is fixed by the owner; the invitee can't change it.

**C2 (M). Accept an invitation.** *As an invitee, I want to open the link, see which shop and email it is for, choose a
password and land in the backoffice, so that I can start working.*
- The page shows the shop name, "You've been invited as *lena@…*", and password rules.
- Passwords are at least 12 characters, at most 200, and can't equal the email. A strength hint is shown.
- On success the invitee is signed in and taken to the first screen they are allowed to see. With no permissions yet, they see "You're in. The owner hasn't given you access to anything yet."
- An expired, used or revoked link shows "This link is no longer valid. Ask the shop owner for a new one." It doesn't say which of the three applies.

**C3 (S). Re-send or revoke an invitation.** *As the owner, I want to create a new link for a pending invitation
(which cancels the old one), or cancel the invitation altogether.*
- "Create a new link" invalidates earlier unused links for that person.
- "Cancel invitation" deletes the pending member. Nobody is left with access.

**C4 (S). Password reset by the owner.** *As the owner, I want to create a password-reset link for a staff member who
forgot their password, because there is no email to send "forgot password" messages.*
- This works like an invitation link with purpose "reset": 24 h, one use.
- Using it ends all of the member's existing sessions.

**C5 (S). Manage my own account.** *As any staff member, I want to change my password and sign out on all devices.*
- "My account" (bottom of the menu) lets you change your password (current password required) and "Sign out everywhere".

### Epic D: Removing and suspending

**D1 (M). Remove a user.** *As the owner, I want to remove someone from the team, so that their access ends
immediately and permanently.*
- Removal uses a two-step confirmation: "Remove Lena? She is signed out everywhere and can no longer sign in."
- The member's **next request** fails with 401 and their backoffice returns to the sign-in page. No waiting for the 8 h token expiry.
- Group memberships and pending links are deleted.
- Things the person created (offers, pages, products) are **kept**, and their history shows "Lena (removed)" (D2).
- The same email can be invited again later. That creates a new account.

**D2 (S). Suspend and reactivate.** *As the owner, I want to pause someone's access temporarily (e.g. a seasonal
helper) without losing their setup.*
- A suspended member can't sign in, and open sessions end. Groups are kept. Reactivating restores access with the same password.

**D3 (M). Never lock the shop out.** *As the owner, I want it to be impossible to remove, suspend or demote the
last active owner.*
- Such an action is refused with "Your shop needs at least one owner." This holds even when two owners act at the same moment.
- An owner can't remove, suspend or demote **themselves**. Another owner must do it. This prevents accidents.
- Recovery if every owner loses their password: restart the server with `ADMIN_EMAIL`/`ADMIN_PASSWORD` (documented, D3).

**D4 (C). Make someone an owner.** *As the owner, I want to give a partner full control, including team management.*
- Two-step confirmation, plus re-entering your own password (step-up, §3 S6). This is recorded in the activity log.

### Epic E: Working with limited access (what staff experience)

**E1 (M). Only see what I may use.** *As a staff member, I want the menu and screens to show only what I'm allowed to
use, so that I don't hit errors.*
- Menu entries, buttons and form controls for missing permissions are hidden, or disabled with an explanation.
- Opening a forbidden URL directly shows "You don't have access to this page", not a crash and not a sign-out.

**E2 (M). Read-only where appropriate.** *As a staff member with View but not Manage, I want to see the data without
edit controls.*
- Example: with "See products" only, the product list shows no add, edit or delete controls.

**E3 (M). Access follows changes.** *As the owner, I want permission changes to apply right away.*
- Permissions are checked on every API request, so a removed permission blocks the very next call.
- The backoffice updates its menu on the next 403 error, on window focus, and every 5 minutes.

## 1.5 Out of scope (v1)
- Email delivery of invites or resets (explicitly out of scope). Self-service "forgot password" (needs email).
- Multi-factor authentication. **Recommended next** because it needs no email: TOTP with an authenticator app (§3 S14).
- Per-record permissions (e.g. "only pages A and B") and time-limited group membership. A membership end date, as profiles have, is a cheap later addition (C).
- SSO / OIDC, API keys for integrations, changing a staff member's email (remove and re-invite instead).

## 1.6 Business risks and safeguards
| Risk | Safeguard |
|---|---|
| The invite link is forwarded or intercepted, and the wrong person joins. | Link works once; 72 h expiry; visible "Invited" status; the acceptance time and last sign-in are shown; the owner can remove the account in one click; advice to send the link through a private channel. |
| Someone is given too much access by mistake. | View/Manage split; descriptions that say what data a permission exposes; impact preview before saving; Access overview matrix. |
| Former staff keep access. | Removal ends sessions immediately; "last sign-in" makes dormant accounts visible. |
| The shop is locked out. | Atomic last-owner guard; no self-removal; documented recovery. |
| An upgrade silently widens access. | New permissions are off by default in groups (B5). |

## 1.7 Success measures
- Every admin API route has a declared permission. A test fails the build otherwise (§2.4).
- Access ends at the next request after removal, suspension or a permission change (tested).
- Onboarding an invited person takes under 2 minutes, from invite to first screen.

---

# Part 2 — Technical

## 2.1 Architecture

```
packages/iam           NEW, pure TypeScript, no I/O (same style as @openshop/pricing)
  src/catalog.ts       permission ids, labels, descriptions, areas, `requires` dependencies
  src/resolve.ts       closure(perms), effective(user, groups), can(effective, requirement)
  src/templates.ts     group templates (Fulfilment, Catalogue editor, Marketing, Support)
  test/                table tests: closure, union, owner-has-all, unknown ids rejected

apps/api/src
  auth.ts              + sv claim; password policy; hash format prefix (S12)
  staff.ts             NEW  createStaff(db, secret): links (invite/reset), sessions, owner guard, removal
  staff-admin.ts       NEW  owner-only routes: /api/staff*, /api/staff-groups*
  staff-auth.ts        NEW  public routes: login (moved from app.ts), link inspect/consume, /api/me*
  authorize.ts         NEW  route permission declarations, preHandler, route-coverage check
  migrations.ts        + migrateIam()
  app.ts, discounts.ts, customers-admin.ts, insights.ts   each route gets `config: { perm }`

apps/backoffice/src/app
  auth.ts              guard reads route data `perm`; 403 handling; `me` loading
  team/                NEW  members.ts, member.ts, groups.ts, group.ts, access-matrix.ts
  join.ts              NEW  public page for invite/reset links
  account.ts           NEW  "My account" (change password, sign out everywhere)
  existing screens     hide or disable write controls when the user lacks Manage (§2.9)
```

**Rule:** the server is the only authority. The backoffice's permission checks are for UX only. Every API route checks
permissions on every request. Nothing permission-related is stored in the token.

## 2.2 Data model

```ts
// collection "users" (existing, extended by the migration)
interface StaffUser extends Doc {
  email: string;                 // trim + lower-case (no "+tag" stripping: that is a customer-identity rule)
  name: string;                  // 1..120
  passwordHash: string | null;   // null while invited; cleared on removal
  status: "invited" | "active" | "suspended" | "removed";
  isOwner: boolean;
  sessionVersion: number;        // in every token as `sv`; incremented to end all sessions
  version: number;               // optimistic concurrency for PATCH
  createdAt: string; createdBy: string | null;   // null = bootstrap/migration
  activatedAt: string | null; lastLoginAt: string | null;
  removedAt?: string; removedBy?: string;
}

// collection "staff_groups"
interface StaffGroup extends Doc {
  name: string; description: string;
  permissions: PermissionId[];   // stored closed under `requires` (see 2.3), sorted, unique
  createdAt: string; updatedAt: string; createdBy: string; version: number;
}

// collection "staff_memberships"; id = `${groupId}:${userId}` so the primary key makes membership unique
// and add/remove idempotent (same pattern as profile_members)
interface StaffMembership extends Doc { groupId: string; userId: string; addedAt: string; addedBy: string }

// collection "staff_links": same shape and rules as account_links (F7)
interface StaffLink extends Doc {
  userId: string; purpose: "invite" | "reset";
  tokenHash: string;             // sha256(token); the token itself is never stored or logged
  expiresAt: string; usedAt: string | null; createdAt: string; createdBy: string;
}

// collection "staff_emails"; id = normalised email. Uniqueness reservation (F6): insert before creating the
// user; DuplicateKeyError means the email is taken. Deleted when a user is removed or an invitation is cancelled.
interface StaffEmail extends Doc { userId: string }

// collection "iam_state", single doc id "owners": the last-owner guard (2.6)
interface OwnerGuard extends Doc { active: number }   // number of users with isOwner && status === "active"
```

The `Db` interface and `openDb` get the five new collections.

Membership is stored in its own collection rather than as `groupIds` on the user. Reasons: the DataStore has no
array-contains query (F3 in the discounts plan); listing a group's members is one `find({groupId})`; and adding or
removing from the group page can't lose an update made concurrently from the user page.

Size caps: at most 200 non-removed staff, 50 groups, and 500 ids per membership call. With these sizes every list is a
small scan, and no indexes are needed in either adapter.

## 2.3 Permission catalogue (`packages/iam`)

Each entry has an id, area, label, description (including the data it exposes) and `requires`. The ids are stable
strings and must never be renamed.

| Id | Label | Requires | Notes |
|---|---|---|---|
| `catalog.view` | See products and categories | — | |
| `catalog.manage` | Add, edit and delete products and categories; upload images | `catalog.view` | Product changes re-render pages. |
| `orders.view` | See orders | — | **Exposes customer name, email and address.** |
| `orders.manage` | Change order status (paid, shipped, cancelled) | `orders.view` | Cancelling releases discounts. |
| `customers.view` | See customers and their details | — | **PII.** Includes each customer's order summaries. |
| `customers.manage` | Create, edit and delete customers | `customers.view` | Deleting also unassigns codes and may archive offers (existing behaviour). |
| `customers.accounts` | Create activation/reset links for customer accounts; sign customers out | `customers.view` | **Sensitive:** a reset link lets the holder take over a customer's account. Described as such in the UI. |
| `discounts.view` | See offers, profiles and the simulator | `catalog.view` | |
| `discounts.manage` | Create and change offers, codes and profiles | `discounts.view` | Voucher codes are cash-equivalent, so listing and exporting them needs Manage. |
| `pages.manage` | Design and publish pages | `catalog.view` | Publishing is public-facing; see S9. |
| `insights.view` | See reports (revenue, discount cost) | — | Business-confidential. |
| `settings.manage` | Change shop time zone and display settings | — | A time-zone change moves every offer. |
| `audit.view` | See the full activity log | — | Entity-scoped history is covered by the area's view permission (2.4). |

**Owner-only (not grantable):** team management (`/api/staff*`, `/api/staff-groups*`), making someone an owner, and
the activity log for staff and groups. Recommended default for **D1**. It removes the whole class of escalation where a
"team manager" grants themselves more. Delegating this later is possible (§3 S5 gives the rules).

**Closure:** `closure(perms)` adds `requires` transitively. Groups are stored closed, and effective permissions are
`closure(∪ groups)`. Owners have `ALL`, which includes permissions added in later releases. Unknown ids are rejected
with 400.

## 2.4 Authorisation enforcement (API)

**Declaration:** every route in the admin scope declares its requirement in the Fastify route config:
```ts
admin.patch("/api/orders/:id", { config: { perm: "orders.manage" }, schema: … }, handler)
// perm: PermissionId | { all: PermissionId[] } | { any: PermissionId[] } | "authenticated" | "owner"
```

**Enforcement:**
1. `onRequest` (existing `requireAuth`, extended) runs these checks in order:
   - verify the token (`aud:"admin"`);
   - load the user;
   - require `status === "active"`;
   - require `claims.sv === user.sessionVersion`.
   Any failure gives **401**. The hook then loads memberships and groups and sets `req.staff = { id, isOwner, perms: Set }`. That is 3 small reads, which is fine at this scale. Results are **not cached** across requests, so changes apply at once (E3).
2. `preHandler` (new, in the same scope) reads `req.routeOptions.config.perm`. If the requirement isn't met, it answers **403** `{ error: "You don't have permission to do this.", code: "forbidden", permission }`. It runs **before** the handler loads anything, so a 403 never reveals whether a resource exists.
3. **Default deny, checked at boot:** an `onRoute` hook in the admin scope throws if a route has no `perm`. The server doesn't start, so a new route can't be left unprotected by mistake.
4. **Body-dependent rules** (F11) run in the handler through `requirePerm(req, p)`, which also returns 403:
   - creating or patching an offer with `audience.type === "customers"`, or `codes` with `assignedCustomerId`, also needs `customers.view` (customer ids are chosen from PII);
   - `simulate` with `customerId` needs `customers.view`;
   - `/api/audit` is scoped by `entity`:

     | `entity` | Needs |
     |---|---|
     | `discount`, `profile` | `discounts.view` |
     | `code` | `discounts.manage` |
     | `customer` | `customers.view` |
     | `settings` | `settings.manage` |
     | `staff`, `staff-group` | owner |
     | none or other | `audit.view` |

**Route mapping** (every existing admin route):

| Routes | Requirement |
|---|---|
| `GET /api/products`, `GET /api/products/:id`, `GET /api/categories` | `catalog.view` |
| `POST/PATCH/DELETE /api/products…`, `POST/DELETE /api/categories…` | `catalog.manage` |
| `POST /api/uploads` | `{ any: [catalog.manage, pages.manage] }` |
| `GET /api/orders` | `orders.view` |
| `PATCH /api/orders/:id` | `orders.manage` |
| `GET/POST/PUT/PATCH/DELETE /api/pages…` | `pages.manage` |
| `GET /api/customers`, `GET /api/customers/:id` | `customers.view` |
| `POST /api/customers`, `PATCH/DELETE /api/customers/:id` | `customers.manage` |
| `POST /api/customers/:id/links`, `POST /api/customers/:id/sign-out` | `customers.accounts` |
| `GET /api/discounts`, `GET /api/discounts/:id`, `GET /api/discount-profiles`, `GET /api/discount-profiles/:id`, `POST /api/discounts/simulate` | `discounts.view` |
| `GET /api/discounts/:id/redemptions` | `{ all: [discounts.view, orders.view] }` (returns order emails) |
| `GET /api/discount-profiles/:id/members` | `{ all: [discounts.view, customers.view] }` |
| `POST/PATCH/DELETE /api/discounts…`, `pause`/`resume`/`archive`/`duplicate`, `GET/POST/DELETE …/codes…`, `POST/PATCH/DELETE /api/discount-profiles…` | `discounts.manage` |
| `POST /api/discount-profiles/:id/members` | `{ all: [discounts.manage, customers.view] }` |
| `GET /api/reports/*` | `insights.view` |
| `GET /api/settings` | `authenticated` (time zone and display flags; every screen needs them) |
| `GET /api/settings/timezone-impact`, `PATCH /api/settings` | `settings.manage` |
| `GET /api/audit` | `authenticated` + entity rule (above) |
| `GET /api/me`, `POST /api/me/password`, `POST /api/me/sign-out-everywhere` | `authenticated` |
| `/api/staff*`, `/api/staff-groups*`, `/api/permissions` | `owner` |

## 2.5 API (new endpoints)

New IAM routes use the strict validator (`strict.ts`: no unknown properties, no coercion) and accept
`application/json` only.

**Public (no token):**
| Method and path | Purpose |
|---|---|
| `POST /api/auth/login` | Unchanged shape, with stricter checks (S7): `maxLength` on both fields; only `active` users; constant-time against a real dummy scrypt hash; `FailureLimiter` keyed by `ip:` and `account:`; sets `lastLoginAt`; token carries `sv`. |
| `POST /api/auth/links/inspect` `{ token }` | For a valid, unused, unexpired link: `{ purpose, email, name, shopName, expiresAt }`. Otherwise **410** with a generic message. Throttled per IP. |
| `POST /api/auth/links/consume` `{ token, password }` | Checks the password policy. Then, atomically, `updateWhere(link, {usedAt:null}, {set:{usedAt}})`. Then sets `passwordHash`, `status: active` (invite) and `activatedAt`, and increments `sessionVersion`. Returns `{ token }` (signed in). Throttled per IP. |

**Authenticated (any active staff):**
| Method and path | Purpose |
|---|---|
| `GET /api/me` | `{ id, email, name, isOwner, permissions: PermissionId[] }` |
| `POST /api/me/password` `{ current, password }` | Changes the password. Increments `sessionVersion` and returns a fresh token, so other devices are signed out. |
| `POST /api/me/sign-out-everywhere` | Increments `sessionVersion`. |

**Owner-only:**
| Method and path | Purpose |
|---|---|
| `GET /api/permissions` | The catalogue (ids, areas, labels, descriptions, requires) and the templates. |
| `GET /api/staff` | `{ items, total }` or CSV via `Accept` (`sendList`). Each item is the `publicStaff` projection (no hashes) plus `groups: {id,name}[]`, `permissions` (effective), `pendingLink: {purpose, expiresAt} \| null`. `?status=removed` includes tombstones. |
| `GET /api/staff/:id` | Detail: effective permissions with their source groups, plus recent audit entries by and about this user. |
| `POST /api/staff` `{ email, name, groupIds? }` | **Invite.** Steps in 2.6. Responds **201** `{ member, link: { path, url, expiresAt } }`. The token is shown **once** and appears only in this response. |
| `PATCH /api/staff/:id` `{ name?, isOwner?, version, password? }` | Rename, or grant or revoke owner. `isOwner` needs the acting owner's `password` (step-up, S6) and goes through the owner guard. Stale `version` gives 409. |
| `POST /api/staff/:id/links` `{ purpose: "invite" \| "reset" }` | New link; revokes earlier unused links. `invite` only while the member is `invited`; `reset` only while `active` or `suspended`. |
| `POST /api/staff/:id/suspend`, `POST /api/staff/:id/reactivate` | Suspend ends sessions (increments `sessionVersion`) and goes through the owner guard. |
| `POST /api/staff/:id/sign-out` | Increments `sessionVersion`. |
| `DELETE /api/staff/:id` | Remove (2.6). An `invited` member is deleted outright (cancel invitation). Idempotent, so a retry completes an interrupted clean-up. |
| `GET /api/staff-groups`, `GET /api/staff-groups/:id` | Groups with `memberCount` and members `{id, name, status}`. |
| `POST /api/staff-groups` `{ name, description?, permissions }` | Stored closed under `requires`. |
| `PATCH /api/staff-groups/:id` `{ …, version }` | Responds with `affectedMembers` (as profiles do). Stale `version` gives 409. |
| `DELETE /api/staff-groups/:id` | Deletes the memberships, then the group. |
| `POST /api/staff-groups/:id/members` `{ add?: userId[], remove?: userId[] }` | Idempotent inserts and deletes by deterministic id. Unknown or removed users give 400. |

Self-protection: targeting **yourself** with `suspend`, `DELETE` or `isOwner:false` gives 409 `code:"self"`.

Errors follow the existing shape `{ error, code?, fields? }`. 401 means "who are you?"; 403 means "not allowed"; 409
is used for version conflicts, last-owner and self-action refusals, and duplicate emails.

## 2.6 Key flows

**Invite (`POST /api/staff`):**
1. Normalise and validate the email.
2. `insert staff_emails {id: email, userId: newId}`. On `DuplicateKeyError`, respond 409 "already on your team". This is race-safe.
3. `insert users {id: newId, status: "invited", passwordHash: null, isOwner: false, sessionVersion: 0, version: 1, …}`.
4. Insert the memberships for `groupIds`, which must exist (checked first).
5. `createLink(userId, "invite")`: 32 random bytes (base64url); store `sha256`; TTL 72 h (D5); earlier unused links revoked.
6. `audit("invite", "staff", id, undefined, publicStaff + groups)`. Neither the token nor its hash goes in the audit log.
7. Respond with `path = /join#<token>` and, if `BACKOFFICE_URL` is set, the absolute `url`. Otherwise the UI prefixes `location.origin` (same approach as customer links with `SHOP_URL`).

If step 3 or 4 fails, delete the reservation and the partial user. This is the compensating pattern already used in `placeOrder`.

**Why a fragment (`#token`) and not a path:** the fragment is never sent to any server. So it stays out of the API's and
any proxy's access logs, out of `Referer` headers, and out of the static host's logs. The Angular `join` page reads
`location.hash`, removes it right away with `history.replaceState`, and posts the token in a JSON body.

**Accept (`/join`):**
1. `inspect` → show the form.
2. `consume` → the server re-validates the link, uses it exactly once through `updateWhere`, and activates the user. If the user is no longer `invited`/`active`/`suspended`, or the link was revoked, the response is 410.
3. The returned token is stored; then `GET /api/me` → navigate to the first permitted screen.

**Remove (`DELETE /api/staff/:id`):**
1. Refuse with 409 if the target is the caller.
2. If the target is an active owner, run the owner guard first (below).
3. `updateWhere(id, {status: {$ne: "removed"}}, { set: { status: "removed", passwordHash: null, removedAt, removedBy }, inc: { sessionVersion: 1 } })`. Access ends here.
4. Delete memberships; mark unused links used; delete the `staff_emails` reservation, so the address can be invited again.
5. Audit the removal with `publicStaff` before and after.

If step 4 is interrupted, repeating the `DELETE` finishes it. The boot reconciliation (below) also does.

**Owner guard** ("at least one active owner", race-safe without transactions). Every change that takes away an active
owner (demote, suspend, remove) first runs:
```ts
updateWhere("owners", { active: { $gt: 1 } }, { inc: { active: -1 } })   // null → 409 "needs at least one owner"
```
and only then changes the user. If that user update fails (version conflict), the guard is put back with
`inc: { active: +1 }`. Changes that add an active owner (promote, reactivate an owner, recovery) increment it.
`migrateIam` and every start-up **recompute** `active` from the users collection. This corrects drift after a crash
between the two steps. Test: two owners removing each other in parallel; exactly one succeeds.

**Session revocation:** tokens carry `sv`, and `requireAuth` compares it with `user.sessionVersion` and checks
`status === "active"`. So remove, suspend, password reset, password change, and "sign out everywhere" take effect on the
next request. Tokens issued before the upgrade have no `sv` and are rejected, so everyone signs in once after
deploying.

**Bootstrap and recovery (D3):** `ensureAdmin(email, password)` becomes `ensureOwner`:
- create, or reset the password of, the user with that email;
- set `status: "active"` and `isOwner: true`;
- increment `sessionVersion`;
- recompute the owner guard;
- write an audit entry with actor `"system"`.

The first-run behaviour (random password printed once) is unchanged. The README gets a warning: remove
`ADMIN_PASSWORD` from the environment after first use, or every restart resets that account's password and restores it
as an owner.

**Migration `migrateIam`:** runs in `onReady`, is idempotent, and is recorded in `settings.migrations.iam`. Every
existing user gets:
- `isOwner: true` and `status: "active"` (nobody loses access);
- `name` = the local part of the email;
- `sessionVersion: 0` and `version: 1`;
- an email reservation.

Then the owner guard is computed. Duplicate emails among existing users, which are unlikely, are logged and the later
ones are suspended.

## 2.7 Passwords and sessions
- **Password policy for staff:** 12–200 characters, not equal to the email. A small common-password deny-list is optional. Customers keep their current 10-character minimum.
- **Hash format:** the current `salt:hash` keeps scrypt's parameters implicit. New hashes are written as `scrypt$N$r$p$salt$hash`, and `verifyPassword` accepts both formats. This allows raising the cost later (OWASP suggests N=2^17) with rehash-on-login. The change is small and optional in v1.
- **Tokens:** `aud:"admin"`, the derived key as today, 8 h TTL, plus `sv`. `AUTH_SECRET` must be set in production. Without it, all sessions end on restart (already the case).

## 2.8 Auditing
- Entities are `staff` and `staff-group`. Actions: `invite`, `link-invite`, `link-reset`, `accept`, `reset-used`, `rename`, `owner-grant`, `owner-revoke`, `suspend`, `reactivate`, `sign-out`, `remove`, `create`, `update` (before/after permissions), `delete`, `members`.
- `publicStaff(u)` drops `passwordHash` and `sessionVersion`. A test checks that no audit entry ever contains `passwordHash`, `tokenHash` or a link token.
- `userId` in audit entries stays the user id. Removed users keep a tombstone, so history can show their name (D2).
- Sign-ins update `lastLoginAt`. Individual successful or failed logins are **not** written to the audit collection (volume). Failures feed the limiter only.

## 2.9 Backoffice (Angular 22, standalone components, signals; same patterns as today)

**Session and permissions**
- `ApiService.me = signal<Me | null>`, loaded after login and at start-up when a token exists. `can(p)` and `canAll(...)` are computed from it.
- Routes declare `data: { perm: 'orders.view' }`. The existing `authGuard` becomes permission-aware: it waits for `me`, then allows the route or redirects to `/forbidden`.
- The `''` route redirects to the first permitted screen rather than always to `/products`. So does `Login` after signing in.
- The interceptor keeps 401 → sign out. **403 → show a message and refresh `me`; do not sign out.**
- `me` is also refreshed on `window` focus and every 5 minutes (E3).

**Navigation:** each menu entry is wrapped in `@if (api.can(…))`. The side footer gains **Team** (owners only) and **My account**.

**Existing screens** (read-only behaviour when Manage is missing):

| Screen | Change |
|---|---|
| Products, Categories | Hide "+ New", edit, delete and upload. |
| Orders | Show status as a pill instead of a select without `orders.manage`. |
| Discounts list, editor | Read-only editor without `discounts.manage` (no save, actions or codes tab). The "Specific customers" audience and personal codes are hidden without `customers.view`; the offer then shows "N customers". |
| Simulator | The customer picker is hidden without `customers.view`. |
| Profiles | Without `customers.view`, member lists show counts only. |
| Customers detail | Link and sign-out buttons need `customers.accounts`. "Give a personal code" and "Add to profile" need `discounts.manage`. Delete needs `customers.manage`. |
| Settings | Read-only without `settings.manage`. |

**New screens** (`team/`):
- **Members:** table (name and email, status pill, groups as tags, last sign-in, actions), search and filters, "+ Invite" panel (email, name, group checkboxes), and an **Access overview** toggle that shows the matrix (A2). CSV download.
- **Member detail:**
  - status and dates;
  - group checkboxes (changes apply on save);
  - effective permissions with their sources;
  - link box (the existing `linkbox` styles and copy button, with "shown once" text);
  - buttons: New invite link / Password reset link / Sign out everywhere / Suspend or Reactivate / Make owner;
  - a danger zone: Remove, with the existing armed two-step button;
  - recent activity.
- **Groups:** list with member counts and a permission summary; "+ New group" with templates.
- **Group editor:** a permission grid by area (View / Manage), descriptions, and auto-ticked dependencies with a note. Members add/remove. An impact preview on save ("affects N people"). Delete with a confirmation listing the members.
- **`/join`** (public, no guard): the same layout as Login. It reads and clears the fragment, inspects the link, and shows the password form and the invalid-link state.
- **`/account`:** change password and sign out everywhere.

## 2.10 Configuration and docs
- New env variable `BACKOFFICE_URL` (optional): the absolute invite and reset URLs shown to the owner.
- README: the IAM feature, the recovery procedure, the `ADMIN_PASSWORD` warning, and backoffice hosting and CSP requirements (S9).
- `scripts/seed-demo.py`: create the demo groups "Fulfilment" and "Marketing" and an invited member, so the screens have data.

## 2.11 Testing
Target: keep the current near-100% line coverage per package.

- **`packages/iam`:** closure (transitive, cycles rejected at definition time), union across groups, owners get all, unknown ids rejected, templates valid against the catalogue.
- **API, route coverage** (the central guarantee):
  - enumerate every admin route (`onRoute` collected list);
  - a user with **no** groups gets 403 on all of them, except `authenticated` ones;
  - for each route, a user with exactly the declared permission does **not** get 403;
  - the build fails if a route has no declaration (the boot check), and a test proves the boot check throws.
- **API, flows:**
  - invite → inspect → consume → sign-in → `me`;
  - a link can't be used twice, even in parallel (20 simultaneous consumes, exactly one succeeds);
  - expired, revoked and wrong-purpose links → 410;
  - re-issuing a link revokes the old one;
  - the same email invited in parallel → exactly one 201;
  - removal, suspension, reset, password change and sign-out-everywhere each reject a token issued before them;
  - permission removal applies on the next request;
  - last-owner guard with parallel demotions and removals;
  - self-removal refused;
  - `isOwner` change without a correct step-up password → 403;
  - body-dependent rules (customer audience, assigned codes, simulate with `customerId`, audit by entity);
  - login: limiter per account across IPs; oversized input → 400; suspended, invited or removed users → 401 with the same timing path;
  - the migration turns existing users into owners and is idempotent;
  - `ensureOwner` restores owner status;
  - the audit log never contains `passwordHash`, `tokenHash` or tokens.
- **Backoffice (Vitest harness):**
  - navigation filtered by `me`;
  - guard redirects;
  - 403 doesn't sign out;
  - read-only modes of Products, Orders and Discounts;
  - Team members, invite (link shown once, copy), member detail, groups, group editor (dependency auto-tick, impact text, version conflict), join page (fragment cleared, invalid-link state), my account.
- **E2E (`scripts/e2e-backoffice.py`):**
  1. The owner invites "Packer" into a Fulfilment group and copies the link.
  2. In a second browser context the packer accepts it and sees only Orders and Products, read-only.
  3. The packer marks an order as shipped.
  4. The owner removes the packer.
  5. The packer's next click returns them to sign-in.
- **Existing tests:** helpers that sign tokens by hand (`discounts.test.ts`, `accounts.test.ts`) must add `sv`. `main.test.ts` still checks that a session survives a restart with the same `AUTH_SECRET`.

## 2.12 Phases (rough, one developer)
| Phase | Content | Estimate |
|---|---|---|
| **P0 Foundations** | `packages/iam`; model and migration; `sv` tokens; login limiter and input bounds; permission declarations on **all** existing routes; preHandler, boot check and route-coverage test; `/api/me`; backoffice `me`, guards, 403 handling and nav filtering. Owners see no change. | 3–4 days |
| **P1 Team and invitations** | Staff routes, links, join page, Members screen with invite/remove/suspend/reset, owner guard, My account, audit. | 3–4 days |
| **P2 Groups** | Group routes, group editor with templates and impact preview, membership from both sides, Access overview matrix, read-only modes of existing screens. | 3 days |
| **P3 Hardening** | Backoffice CSP and hosting doc, builder canvas isolation, step-up for owner grants, hash-format upgrade, e2e. Optional: cookie sessions (D4). | 2–4 days |

Ship P0 → P1 → P2 together or in order. P0 alone is safe to release: everyone is an owner.

---

# Part 3 — Security

Threat model: (a) an **outsider** trying to become staff (link interception, brute force); (b) a **low-privilege
insider**, i.e. a staff member trying to reach data or actions beyond their groups, or to keep access after removal;
(c) an **honest mistake** by the owner (over-granting, lock-out).

| # | Topic | Risk | Measures in this plan |
|---|---|---|---|
| S1 | **Server-side enforcement** | The UI hides a button, but the API still allows the action. | Every admin route declares a permission. Default deny; the server refuses to start if a route has none. The permission check runs before any data is loaded. An automated matrix test covers every route. The UI is never trusted. |
| S2 | **Cross-area data exposure** (F11) | Read endpoints leak PII to people who don't need it (e.g. a marketer loading all customers in the discount editor). | The catalogue marks PII-bearing permissions. `requires` and body-dependent rules (customer audiences, assigned codes, simulator, redemptions, profile members, audit by entity). The UI degrades to counts instead of names. |
| S3 | **Immediate revocation** | A removed or suspended person keeps an 8 h token (verified today, F3). | `sv` in the token, and `status`/`sv` checked on every request. Permissions are resolved per request and never embedded in the token. Pre-upgrade tokens are rejected. |
| S4 | **Invitation links** | The link leaks, is guessed or is replayed. | 256-bit random; only SHA-256 stored; single use through atomic `updateWhere`; 72 h invites and 24 h resets (D5); earlier links revoked on re-issue and on removal; token in the URL **fragment** (not in server, proxy or `Referer` logs), removed from the address bar on load; shown once and never audited or logged; `inspect`/`consume` throttled; generic "no longer valid" message; email fixed by the owner. The owner UI says plainly that the link is a bearer credential, and shows the acceptance time so an unexpected acceptance can be noticed. |
| S5 | **Privilege escalation** | A staff member grants themselves more access. | Team management is **owner-only** in v1 (D1), so nobody else can change groups. Owner status isn't a group and can't be put in one. Promoting to owner needs owner + step-up. If delegation is wanted later, it needs these rules: a delegate may only grant permissions they hold themselves, can't touch owners or themselves, and can't grant team management. |
| S6 | **Step-up for critical actions** | A stolen owner session is used to create a persistent backdoor owner. | Granting owner status re-checks the acting owner's password. Recommended also for removing an owner. Invites into groups are **not** step-up gated (daily task), but they are audited and visible. |
| S7 | **Brute force and enumeration** | Password guessing; finding out which emails are staff. | `FailureLimiter` keyed by IP **and** account (fixes F8). Limits are kept moderate (e.g. 10 per 10 min per account) so an attacker can't lock the owner out for long; the IP key blocks the spray. `maxLength` on inputs. Every failure path verifies against a real scrypt hash, so the timing is the same. Same 401 message for unknown, invited, suspended, removed and wrong-password cases. |
| S8 | **Lock-out / availability** | Zero owners; owners removing each other. | Atomic owner guard (a conditional counter decrement with compensation), recomputed at start-up; no self-removal, self-suspension or self-demotion; documented `ADMIN_PASSWORD` recovery with an audit entry. |
| S9 | **XSS → session theft** (F4, F5, F12) | A low-privilege user with `pages.manage` crafts content that runs script in the backoffice origin (same-origin builder iframe) and reads the owner's `localStorage` token. Today the renderer validates every value, which is the main defence. IAM makes "page editor" a distinct, less-trusted role. | **P3:** (1) serve the backoffice with a strict CSP (`script-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`) plus `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`, and document the hosting (or serve `dist/` from the API with those headers); (2) isolate the builder canvas: `sandbox="allow-scripts"` without `allow-same-origin`, replacing `window.parent.osBuilderHost` with a `postMessage` protocol that validates message origin and shape; (3) **D4:** move the admin token to an `HttpOnly; Secure; SameSite=Strict` cookie, which then **requires** CSRF protection (checking `Origin` and a JSON-only content type on admin routes); (4) keep the renderer's hostile-document tests, and add cases for each new widget. Until (1) and (2) ship, the owner should give `pages.manage` only to trusted people. The permission description says so. |
| S10 | **CSRF** | Cross-site requests change team state. | Bearer tokens aren't sent automatically, so CSRF doesn't apply while D4 is "later". New IAM routes accept only `application/json`; the app registers a global urlencoded parser, so this is checked explicitly. If cookies are adopted (D4), `Origin` checks become mandatory on every admin route. |
| S11 | **Sensitive data in responses and logs** | Hashes or tokens leak through the API, CSV or audit. | `publicStaff` projection everywhere. Tokens appear only in the single invite/reset response. Fastify's logger is off today; if it is enabled, redact `authorization` and `/api/auth/links/*` bodies. CSV export uses the existing formula-injection-safe `csvCell`. `cache-control: no-store` on `/api/me`, `/api/staff*` and `/api/auth/*`. |
| S12 | **Password storage** | Weak or non-upgradable hashing. | scrypt with a per-user salt (existing). Versioned hash format so the cost can be raised with rehash-on-login. 12-character minimum for staff. The password is never logged and `maxLength` is 200. |
| S13 | **Races without transactions** (F6) | Duplicate accounts, double use of links, lost membership updates. | Email reservation by primary key; link consume via `updateWhere`; memberships keyed `${groupId}:${userId}`; `version` on groups and users; owner guard. Each is covered by parallel tests, as the discounts work did. |
| S14 | **Account takeover without MFA** | A reused or phished password gives full access. | Out of scope for v1, but TOTP needs no email and is the recommended next step, mandatory for owners first. Until then, "last sign-in" visibility and "sign out everywhere" limit the damage. |
| S15 | **Separation from customers** | Staff and customer realms get mixed. | Separate collections, separate token audiences and derived keys (already true). Staff emails may equal customer emails without any link between the two. `customers.accounts` is described as a takeover-capable permission. |
| S16 | **Leavers' data (privacy)** | Keeping ex-staff personal data longer than needed. | A removed user keeps a tombstone (name and email) for accountability of past changes (D2). Optionally anonymise after N months (`name: "Former staff #3"`, email hashed), keeping the id so history stays consistent. |
| S17 | **Multi-instance deployments** | Limiters are per process; settings are cached 30 s. | Permissions and status are **not** cached, so they are consistent across instances at once. Limiters stay per process (a known limitation, as for customer login). Set Fastify `trustProxy` correctly behind a proxy, or every user shares one IP key. |

### Known limitations after v1 (for the security review)
1. Admin tokens stay in `localStorage` unless D4 is taken. XSS impact is reduced by S9 (1)–(2), not removed.
2. Throttling is per process and in memory.
3. No MFA (S14).
4. Invitation links are bearer credentials: whoever opens one first gets the account. This is inherent to "copy and send by hand".
5. Permissions are area-level, not per record.

---

## Owner decisions needed

| # | Question | Recommended default |
|---|---|---|
| **D1** | Can team management be delegated to non-owners? | **No** in v1. Several owners are allowed; step-up is required to create one. |
| **D2** | What does "remove" keep? | Tombstone with name and email for history; access, memberships, links and the email reservation are removed; optional anonymisation later. |
| **D3** | What should `ADMIN_EMAIL`/`ADMIN_PASSWORD` do after IAM? | Stay as the recovery path: reset the password, reactivate, restore owner, write an audit entry. README warns to unset it after use. |
| **D4** | Move the admin session to an HttpOnly cookie (with CSRF checks)? | **Later (P3 or after)**; first ship the backoffice CSP and builder isolation. |
| **D5** | Link lifetimes? | Invite 72 h (same as customers); staff reset 24 h. |
| **D6** | Permission granularity? | Area × View/Manage, plus `customers.accounts` and `audit.view` (§2.3). |
| **D7** | Group templates? | Offered in "New group", never created automatically. |
| **D8** | Where do invite links point? | The backoffice, `/join#token`. Set `BACKOFFICE_URL` for absolute links; otherwise the browser's origin is used. |

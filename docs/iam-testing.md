# Testing the backoffice team features (IAM v2)

How to try every flow of `docs/iam-plan-v2.md` by hand on the demo shop (Maison Dune), and how to run the automated
tests. Story ids (A1, C3, …) refer to the plan.

## 1. What is running

| What | Address | Notes |
|---|---|---|
| Backoffice (Angular dev server) | http://localhost:4200 | Proxies `/api`, `/shop`, `/s/`, `/uploads`, `/assets` to the API |
| API + shop | http://localhost:3000 (shop: http://localhost:3000/shop) | Database `demo-data/db.sqlite`, uploads `demo-data/uploads` |

Started with the values in `.env.demo` plus `BACKOFFICE_URL=http://localhost:4200` (absolute invitation links). Logs:
`/tmp/demo/api.log`, `/tmp/demo/ng.log`. To restart them, see §6.

## 2. Accounts

**Owner (sudo):** `olivia@maison-dune.test` / `dune-owner-2026`. It has every permission plus Team, Activity and
Settings → Security.

**Staff:** every address is `<first name>@maison-dune.test`, password `dune-staff-2026`.

| Person | Group (template) | Lands on | Menu |
|---|---|---|---|
| Sam Manager | Shop manager | Products | Products, Categories, Orders, Discounts, Customers, Insights, Pages · Settings, My account |
| Pat Packer | Fulfilment | Products | Products, Categories, Orders · My account (stock only; can ship orders) |
| Cleo Catalogue | Catalogue editor | Products | Products, Categories · My account |
| Dana Designer | Content editor | Products | Products, Categories, Pages · My account (catalogue read-only) |
| Max Marketing | Promotions | Products | Products, Categories, Discounts, Insights · My account (no customers) |
| Suki Support | Customer support | Orders | Orders, Customers · My account (can cancel, can't delete customers) |
| Finn Finance | Finance | Products | Products, Categories, Orders, Discounts, Insights · My account (can mark paid) |
| Vera Viewer | Read-only | Products | Products, Categories, Orders, Discounts, Customers, Insights · My account (no edit controls) |
| Nico NoGroups | — | "You're in…" page | My account |
| Mia Multi | Fulfilment + Content editor | Products | Products, Categories, Orders, Pages · My account |
| Ivy Invited | Fulfilment, **invitation pending** | — | Her one-time link is in `demo-data/invite-links.txt` |
| Sid Suspended | Fulfilment, **suspended** | can't sign in | — |
| Rex Removed | Fulfilment, **removed** | can't sign in | — |

**Customers (shop):** Jonas, Erik, Priya, Sofia (`<first>.<last>@example.com`, password `dune-demo-2026`). See README.

Tip: use one normal window for the owner and a private window (or another browser) for the staff member, so both can
be signed in at once.

## 3. Scenarios

### Team overview (A1, A2)
1. Sign in as the owner → **Team**. Every member is listed with a status pill (Owner, Active, Invited, Suspended), groups and last sign-in. Try the search and the filters; choose **Removed** in the status filter to see Rex.
2. Tick **Access overview**: people × areas (`View`, `Stock`, `Ship`, `Payments`, …). Check it against the table above.
3. **Download CSV**.
4. Open **Pat Packer**: "What Pat Packer can do" lists every permission with the group it comes from, the link history and Pat's own activity.

### Invite someone and join (C1, C2)
1. Team → **+ Invite someone**: an email such as `lena@maison-dune.test`, a name, tick **Fulfilment** → **Create invitation link**.
2. The link is shown once, with a warning and **Copy link**. Open it in the private window.
3. The join page shows the shop, the email and the password rules, ticked live as you type. The token has already disappeared from the address bar.
4. Try `lena-password` (contains the email) or something short: the form refuses it. Then use e.g. `glazed stoneware 2026` → **Join and sign in**. You land on Products with the Fulfilment menu.
5. Open the same link again: "This link is no longer valid".
6. Also try the pending invitation of **Ivy Invited** from `demo-data/invite-links.txt`.

### Revoke or renew a link (C3, C4)
1. Owner → Team → open a member → **Create password reset link** (active members) or **Create a new invitation link** (invited members).
2. Press **Revoke link**: the member's page shows the link as *Revoked*. Opening it shows "no longer valid", even though it was inside its 72 h / 24 h window.
3. A new link always revokes the previous one (see the Links table).

### Permission groups (B1–B5)
1. Team → **Permission groups**: the 8 templates, with their access per area.
2. **+ New group** → pick a template (e.g. *Finance*): the card explains what it is for and what it **can't** do. Create → the editor opens.
3. In the editor, tick *Add, edit and delete products*: the permissions it needs are ticked too, with a note. Untick *See products*: everything that depends on it is unticked.
4. Change a group that has members (e.g. Fulfilment): the Save panel lists + / − changes and "This changes access for 4 people: …". It asks **Click to confirm**.
5. Add or remove members from the group page, or tick groups on a member's page (**Save groups**).
6. **Delete group**: the confirmation names everyone who loses the permissions.

### Access changes apply at the next click (E3, E4)
1. Private window: sign in as **Pat** and open Orders.
2. Owner: Team → Pat Packer → untick **Fulfilment** → **Save groups**.
3. Pat: click **Products** in the menu. You get **"You don't have access to Products"**, the address stays `/products` and the menu shrinks. Nothing signs Pat out.
4. Owner: tick Fulfilment again. Pat: reload, and Products is back.

### No access and not found (E1, E2)
1. As **Pat**, type `/customers`, `/discounts/new`, `/team` or `/settings` in the address bar. Each shows the No access page with the feature, the missing permission in plain words and whom to ask, and the address stays as typed.
2. `/anything-else` → **Page not found**.
3. As **Nico** (no groups): the "You're in…" page. If the owner adds Nico to a group, the page moves on by itself within about 15 s.

### Read-only and fine-grained screens (E3)
- **Pat:** Products shows only **Update stock** (no prices, no new product). In Orders the status menu offers only *Shipped*.
- **Finn:** Orders offers *Paid* or *Pending*. Discounts are read-only ("Read-only: you can see this offer…"), and voucher codes are hidden.
- **Suki:** Orders offers *Cancelled*. Reopening a cancelled order needs *Cancel* **and** *Payments*, so the pill stays. Customers: account links yes, no delete button, no offers or codes.
- **Max:** the discount editor works, but *Client price* and *Specific customers* are disabled (they need "See customers"), and Redemptions are hidden. The simulator has no customer picker.
- **Vera:** sees everything in her areas, with no edit control anywhere.

### Suspend, remove, restore (D1, D2, owner protection)
1. Owner → a member (e.g. Mia) → **Suspend**. Mia's open session fails at her next click (back to sign-in), and she can't sign in. **Reactivate** restores access with the same password and groups.
2. **Remove** (two-step). Access ends at once. The member disappears from the list (filter *Removed* shows them), and their history stays in Activity, marked *removed*.
3. Invite a removed person's email again (e.g. `rex@maison-dune.test`): you are offered **Restore Rex**. The same account comes back as *Invited* with a new link and no groups.
4. Open the owner's own page: no suspend, remove or reset buttons. The owner can't be changed here.

### My account (H1)
Any member → **My account**: what you can do, change password (current password required; the rules are shown), and
**Sign out everywhere**. The page also says what is recorded and for how long.

### Password policies (G1–G4)
1. Owner → **Settings → Security** (only the owner sees this section). Two policies: Staff and Customers. Use **Try a password** to test the rules live.
2. Set the staff minimum to 16, switch on **Require at next sign-in**, then save.
3. Sign in as Pat (`dune-staff-2026` is 15 characters): you land on **My account** with a banner, and every other page sends you back until you choose a longer password. Then you continue to Products.
4. Customers: set a rule (e.g. minimum 12 and "Block common passwords"). Then Customers → a customer → **Create activation link** (or reset link) → open it: the shop's set-password page lists the same rules and enforces them.
5. Put the policies back (12 / 10, enforcement off) when done. Every change appears in Activity with before and after.

### Activity (F1–F3)
Owner → **Activity**:
- Filter chips: Sign-ins, Links, Page views, Changes, Denied access. Also person (removed members included), dates, IP and free text.
- The seed left some examples: Pat's wrong password, Sid's refused sign-in (suspended), an unknown account, Max/Pat/Dana requests refused (403), an unauthenticated request (401), and page views.
- Click a **Change** row to see before and after. **Load more**; **Download CSV** (same filters).
- Anything you do in the scenarios above shows up here. A removed member who still has the backoffice open appears as *Refused: Old session refused (account removed)*.
- The retention period (default 180 days) is in Settings → Security.
- A single record's history is also in its own screen (e.g. an offer's **History**): who changed what, **Older
  changes** to page back, and **Download CSV**. Members who may see that area can see its history; the Activity page
  (everything, searchable) is for the owner.

### The API directly (optional)
```bash
TOKEN=$(curl -s localhost:3000/api/auth/login -H 'content-type: application/json' -d '{"email":"pat@maison-dune.test","password":"dune-staff-2026"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s localhost:3000/api/me -H "authorization: Bearer $TOKEN"                # permissions
curl -s localhost:3000/api/customers -H "authorization: Bearer $TOKEN"         # 403 {"code":"forbidden","permission":["customers.view"]}
curl -s -X PATCH localhost:3000/api/orders/<id> -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"status":"paid"}'   # 403: needs orders.payments
curl -s localhost:3000/api/orders                                               # 401, logged as api_unauthenticated
```

## 4. Automated tests

| Suite | Command | What it covers |
|---|---|---|
| Permission model | `npm test -w @openshop/iam` | Catalogue, closure, templates (= plan §2.4), password rules, feature registry |
| DataStore | `npm test -w @openshop/db` | Includes the new `deleteWhere` |
| API | `npm test -w @openshop/api` | 21 IAM flow tests, plus the **access matrix** (32 rows × 14 personas, every admin route) → `apps/api/test/out/access-report.md` |
| Backoffice | `cd apps/backoffice && npx ng test --no-watch` (Angular CLI needs Node ≥ 22.22.3 or 24) | Guards, menus per persona (from the matrix), No access, team, groups, join, account, activity, security, read-only screens |
| Browser | `scripts/e2e-access.py` (see README) | Every persona: landing page, menu, all 15 screens by address, real actions; owner flows end to end (392 checks, including CSP and hostile-text checks) |
| Security | part of `npm test -w @openshop/api` (`security.test.ts`) | 12 attack tests; see `docs/iam-security-review.md` |
| Types | `npm run typecheck` | |

## 5. Good to know
- The access matrix is data: `apps/api/test/access-matrix.json`. The API test checks that its expectations agree with the permission rules and the feature registry, then runs every cell. The backoffice and browser tests read the same file.
- Permissions are checked on every request, so group changes need no sign-out. The backoffice also re-reads them when the window gets focus and every 5 minutes.
- Page views are reported by the backoffice and are informational. Sign-ins, 401/403 and changes are recorded by the server.

## 6. Restart or reset the demo
```bash
cd openshop-v2-clean
set -a; . ./.env.demo; set +a; export BACKOFFICE_URL=http://localhost:4200
node apps/api/src/main.ts                                   # API on :3000
cd apps/backoffice && npx ng serve --port 4200              # backoffice (Node >= 22.22.3 or 24)
# fresh data: stop the API, rm -rf demo-data && mkdir demo-data, start the API, then
python3 scripts/seed-demo.py                                # shop, customers, team
# optional history for Insights (API stopped): DB_PATH=./demo-data/db.sqlite node scripts/seed-history.ts
```

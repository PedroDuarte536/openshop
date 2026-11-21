# Security review of the backoffice IAM (staff accounts, groups, invitations, activity)

Scope: the IAM of `docs/iam-plan-v2.md` as implemented (API `apps/api/src`, permission model `packages/iam`,
backoffice). The review combines reading the code with attacks run against it: automated tests that stay in the
suite, and one-off measurements (timing, brute force, flooding).

**Verdict:** the design holds up against the threat model below. Every control was exercised by an attack that must
fail, and it failed. The review found **6 issues** (2 medium, 3 low, 1 hygiene), all fixed and covered by regression
tests. The remaining risks are listed in §5 with the owner's decision for each: future work, deployment note, or out of
scope.

## 1. Threat model
| Actor | Wants to | Main defences |
|---|---|---|
| Outsider | become staff, guess passwords or links, learn who works there | scrypt + throttling, 256-bit single-use links, identical failure responses |
| Staff member with few rights | see or change more than their groups allow, become owner, keep access after removal | per-request permission checks (default deny), no API can grant owner, session version |
| Staff member with many rights (Shop manager) | take over the team or the owner account | team, groups, activity, security settings are owner-only; owner can't be changed by API |
| Anyone able to run script in the backoffice (XSS) | steal a session | Angular escaping, strict CSP (also inside the builder canvas) |
| Owner by mistake | over-grant, lock themselves out | explicit groups, impact preview, owner can't be removed or suspended |

## 2. Method and evidence
| Evidence | Where | What it does |
|---|---|---|
| Attack tests (12) | `apps/api/test/security.test.ts` | route inventory, escalation by the Shop manager, HEAD, method override and path tricks, forged tokens, mass assignment and prototype pollution, data leaks, log flooding, query injection, CSRF-style requests, link guessing, sign-in timing, hostile text, cache headers |
| Access matrix | `apps/api/test/access-matrix.test.ts` | 32 functions × 14 personas (482 cases; every admin route). Every response is **scanned**: no password hash, token hash or session version ever appears, and no customer email reaches a persona who may see neither customers nor orders. The scan was checked by re-introducing the leak of F1: it failed as it should. |
| Flow tests (23) | `apps/api/test/iam.test.ts` | invites, single use under 20 parallel requests, revoke vs use races, parallel invites, soft delete and restore, owner protection, migration, policies, activity aggregation and pruning |
| Browser | `scripts/e2e-access.py` | every persona's menu and all 15 screens by address, live revocation, removal, forced password change, **CSP**: injected scripts don't run in the backoffice or in the builder canvas; **hostile text**: names, group names and browser strings with script payloads are displayed as text on every team and activity screen |
| Measurements | this review | sign-in timing (table in §3.1), link guessing, lockout, flooding |

## 3. Controls, and how they were verified

### 3.1 Authentication
- **Passwords:** scrypt (N=2^14, r=8, p=1) with a 16-byte random salt per hash, stored as `scrypt$N$r$p$salt$hash`. The parameters are bounds-checked before use, so a corrupt or hostile stored value can't make a sign-in burn memory. Inputs are at most 200 characters, so scrypt can't be made to work on huge inputs. Policies are enforced on the server with fixed bounds (minimum never below 8).
- **No account discovery:** every failure (unknown email, wrong password, invited, suspended, removed) returns the same `401 {"error":"invalid credentials"}` after verifying a real scrypt hash. Measured median response times, 48 attempts each:

  | unknown | active | invited | suspended | removed |
  |---|---|---|---|---|
  | 75.1 ms | 78.4 ms | 74.8 ms | 73.1 ms | 73.0 ms |

  The differences are noise. A regression test keeps the medians within 2× of each other.
- **Throttling (changed by F2):** at most 10 failures per address, and 10 per address+account pair, in 10 minutes. Beyond that, 429. An account alone is limited only after 100 failures in 10 minutes: that slows guessing spread over many addresses, while a few failures elsewhere can't lock the owner out. Verified: 10 failures from one address block that address for the account, the owner still signs in from their own address, and 100 spread failures slow further guessing.

### 3.2 Sessions
- Tokens are HMAC-SHA256 signed, with a key derived (HKDF) from `AUTH_SECRET` per audience (`admin` / `customer`). They last 8 h and carry the user id and a **session version**.
- **Every request** re-checks the signature, the expiry, that the user exists and is `active`, and that the session version matches. So removal, suspension, a password change or reset, and "sign out everywhere" end sessions at the next request. Permissions are **never** in the token: they are read from the groups on every request, so group changes apply at once. Verified in flow tests and in the browser (a removed member's next click goes to sign-in).
- **Forgeries refused (401):**
  - changed user id, added `sudo` claim, pushed expiry, or changed session version, each with the original signature;
  - stripped signature, empty token;
  - customer-audience token, token signed with another secret, pre-upgrade token without a session version;
  - a session sent as a cookie instead of the `Authorization` header.

### 3.3 Authorisation
- **Default deny, checked when the server starts:** every admin route must declare `config.perm`, or the server refuses to start (test: a route without it stops `ready()`).
- **Route inventory (test):** every `/api` route is either an admin route with a permission, or on a short public allow-list (sign-in, links, shop). 81 admin routes; nothing else under `/api`.
- **Checked before anything is read:** the permission is checked in `onRequest`, before the body is even parsed, so a 403 never reveals whether a record exists.
- **Rules that depend on the request** are checked in the handler:
  - stock-only product edits (judged on the *validated* body, so unknown fields are dropped and `price` needs the real permission);
  - order status targets (reopening needs both "cancel" and the target's permission);
  - offers for named customers, personal codes and simulating a customer all need "See customers";
  - record history is scoped by entity.
- **No way around it (tests):**
  - `HEAD` gets 403;
  - `X-HTTP-Method-Override` is ignored;
  - `/api/staff/`, `/api/%73taff`, `..%2F` and `../` paths get 403 or 404;
  - upper case, `//`, `;` and `%2F` get 404;
  - repeated query parameters (`?entity=product&entity=staff`) keep the last value and still get 403.
- **No escalation (test):** the Shop manager (all 17 permissions) gets 403 `sudo` on all 17 owner functions tried, including reset links for the owner, deleting or suspending the owner, and changing their own groups. No request body can set `sudo`, `status`, `passwordHash`, `sessionVersion` or `email`, or add an unknown permission (strict schemas; `__proto__`/`constructor` payloads give 400).
- **Matrix:** all 482 cases give the reviewed result (allowed → expected status; refused → 403 and an `api_denied` record).

### 3.4 One-time links (invite, reset)
- 32 random bytes (256 bits), base64url. **Only the SHA-256 hash is stored.** Verified: the token appears in no table, audit entry or activity event.
- Single use, in one atomic statement guarded on "unused and not revoked". Verified with 20 parallel uses (exactly one wins) and with a use racing a revoke (exactly one wins). Expiry is 72 h for invites and 24 h for resets. A link can be revoked at any time, and a new link revokes the old one.
- The token is in the URL **fragment** (`/join#…`), which browsers never send to servers, so it stays out of server and proxy logs and `Referer` headers. The join page removes it from the address bar at once and posts it in a JSON body. Responses are `no-store` and `no-referrer`.
- **Guessing is throttled:** the 31st wrong token from one address gets 429, even the right one from that address. Invalid formats are refused before any lookup.

### 3.5 Data exposure
- Staff records go through a projection (`publicStaff`): no password hash or session version, ever. The matrix response scan checks this on every response.
- Customer personal data only reaches members with "See customers" or "See orders" (matrix scan). This scan found F1.
- Every authenticated API response is `Cache-Control: no-store` (F5), `nosniff`, JSON.

### 3.6 Browser
- **CSP** on the backoffice: `script-src 'self'`, no inline script, `frame-ancestors 'none'`, `object-src 'none'`. The production build has no inline script. Verified in the browser: injected `<img onerror>` and `<script>` don't run in the backoffice **or inside the page-builder canvas**, and the existing backoffice suite runs without a single CSP violation.
- **Hostile text** is stored verbatim and shown escaped: Angular interpolation everywhere in the IAM screens, with no `innerHTML`. Verified in the browser on Team, member, groups, group and Activity (including an expanded row). CSV downloads neutralise formulas (`=`, `+`, `-`, `@`).
- **CSRF:** admin routes need the `Authorization` header, which other sites can't make a browser send. Sign-in and link routes take JSON only (F6).

### 3.7 Activity log
- **Append-only** through the application: no API edits or deletes events; only the retention pruner removes old ones.
- **Bounded:** 401s, 403s (F3) and throttled sign-ins are counted per minute and key, with a global ceiling, so neither anonymous scanners nor a staff account can flood the database. Verified: 300 forbidden requests → one row with `count: 300`; 1,000 anonymous requests → bounded rows.
- **What to trust:** page views are reported by the browser (the user comes from the token, the path from the browser). They are marked informational in the UI. Sign-ins, 401/403 and changes are recorded by the server.

### 3.8 Concurrency (no database transactions)
Email uniqueness uses a reservation keyed by the email (10 parallel invites → exactly one). Links are used once through
a conditional update. Groups and members use `version` checks, and memberships have deterministic ids (idempotent).

## 4. Findings of this review (all fixed)
| # | Severity | Finding | Fix | Regression test |
|---|---|---|---|---|
| F1 | Medium (privacy) | The voucher code list (and CSV) showed the **email of the customer** a personal code belongs to, to anyone with "voucher codes" (e.g. Promotions), who may not see customers | The email is included only with "See customers" | `security.test.ts` "FIXED: voucher code lists…"; matrix PII scan |
| F2 | Medium (availability) | 10 wrong passwords from **anywhere** locked an account (including the owner's) for 10 minutes, repeatable by anyone who knew the email | Blocking per address and per address+account; a per-account limit only at 100 failures | `iam.test.ts` "sign-in throttling…" |
| F3 | Low | Any staff account could grow the activity log without limit by repeating forbidden requests (300 requests = 300 rows) | 403s are counted per minute (member × route × permission) under the global ceiling | `security.test.ts` "FIXED: refused requests…" |
| F4 | Low | A repeated query parameter reached handlers as an array: HTTP 500. This also affected the **public** shop API (`/api/shop/products?categoryId=a&categoryId=b`), a bug from before IAM | The query parser keeps one value per name | `security.test.ts` "FIXED: repeated query parameters…" |
| F5 | Hygiene | Some owner responses (member details, groups, security settings) lacked `Cache-Control: no-store` | `no-store` on every authenticated API response, refusals included | `security.test.ts` "hostile text…" |
| F6 | Info | Sign-in and link routes accepted form-encoded bodies (the plan says JSON only). Not exploitable, since a cross-site form can't read the response, but it broke the plan's rule | 415 unless `application/json` | `security.test.ts` "FIXED: … JSON only" |

## 5. Remaining risks and recommendations
| # | Risk | Status / recommendation |
|---|---|---|
| R1 | The session token is in `localStorage`: script running in the backoffice could steal it. | Mitigated by the CSP (also inside the builder canvas) and by Angular escaping, both verified. **Future work:** HttpOnly cookie session (FW5). Sandboxing the builder canvas: **out of scope**. |
| R2 | No multi-factor authentication. | **Out of scope** (owner decision). |
| R3 | The scrypt cost (N=2^14, about 16 MiB) is below current OWASP guidance (N=2^17 r=8 p=1, or N=2^16 r=8 p=2). This cost was inherited from the original code. | **Out of scope** (owner decision). The versioned hash format keeps raising it possible later. |
| R4 | Throttling is in memory, per process. Behind a reverse proxy, every visitor shares the proxy's address unless the API trusts the proxy. | **Deployment note** (`docs/backoffice-hosting.md`): set `TRUST_PROXY` (added for this) to the proxy's address or hop count. Shared limits across instances: FW6. |
| R5 | Invitation and reset links are bearer credentials until used or expired. | By design (no email). Single use, 72 h / 24 h, revocable, shown once, acceptance visible in Activity. |
| R6 | One owner account. Losing its password needs the `ADMIN_PASSWORD` restart, which needs server access. | Accepted (D1, D3). Recovery redesign is FW4. |
| R7 | The activity log is not tamper-evident against someone with database access. Page views are client-reported. | FW13. The UI labels page views as informational. |
| R8 | No idle timeout: a token lasts 8 h unless revoked. | **Future work**, together with the cookie session (FW5). |
| R9 | Third-party dependency advisories could not be checked here (`npm audit` is blocked in this environment). Versions: fastify 5.12.8, ajv 8.20.0, mongodb 6.22.0, secure-json-parse 4.1.1. | **Out of scope** (owner decision). |
| R10 | The history log (`audit_log`) keeps personal data forever. | **Future work** (FW16): retention or anonymisation. |
| R11 | The MongoDB adapter was only tested against an in-memory stand-in. | **Future work** (FW17): run the tests with `MONGO_URL` before using MongoDB in production. |

## 6. Re-running the checks
```bash
npm test -w @openshop/api            # includes security.test.ts, iam.test.ts and the access matrix (+ report in test/out/)
npm test -w @openshop/iam
BO=http://localhost:4300 API=http://localhost:3100 python3 scripts/e2e-access.py   # on a throw-away instance, see README
```

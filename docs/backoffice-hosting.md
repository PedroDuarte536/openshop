# Deployment notes: backoffice hosting, reverse proxy, database

The backoffice is a static Angular app (`cd apps/backoffice && npx ng build` → `dist/backoffice/browser`). Serve it
from its own address (e.g. `https://admin.your.shop`, and set `BACKOFFICE_URL` on the API so invitation links are
absolute). Send every backoffice response with these headers:

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' https: data: blob:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
X-Frame-Options: DENY
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
```

Why (plan S9): the session token is kept in `localStorage`. `script-src 'self'` means no injected inline script or event
handler can run: not in the backoffice, and not in the page-builder canvas either, because the canvas is an `srcdoc`
iframe and inherits the policy. That is what keeps a staff member who may only design pages from running script as
the owner. `frame-ancestors 'none'` / `X-Frame-Options` stop clickjacking, and `no-referrer` keeps URLs out of other
sites' logs. The production build has no inline scripts: critical-CSS inlining is off in `angular.json` because its
loader is an inline script.

The dev server (`ng serve`) sends the same CSP (see `angular.json` → `serve.options.headers`). It leaves out
`X-Frame-Options` there, because it would also be added to the proxied shop pages that the Pages screen previews in
iframes.

`/api`, `/shop`, `/s/`, `/uploads`, `/assets` and `/search` go to the API (same address through a reverse proxy, as in
`proxy.conf.json`, or a separate address). The API sends its own headers for the shop; don't add the backoffice headers
to those responses.

Example (nginx):

```nginx
server {
  server_name admin.your.shop;
  root /srv/openshop/backoffice/browser;
  location ~ ^/(api|shop|s|uploads|assets|search)(/|$) { proxy_pass http://127.0.0.1:3000; proxy_set_header X-Forwarded-For $remote_addr; }
  location / {
    try_files $uri /index.html;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' https: data: blob:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'" always;
    add_header X-Frame-Options DENY always;
    add_header Referrer-Policy no-referrer always;
    add_header X-Content-Type-Options nosniff always;
  }
}
```

## Reverse proxy: `TRUST_PROXY`

The sign-in limits (per address, per address + account) and the IP shown in the Activity log use the client's
address. Behind a reverse proxy or load balancer, the API only sees the proxy's address, so **every visitor would
share one address**: one person's failed sign-ins would slow everyone, and the log would show only the proxy.

Tell the API which proxy may report the real client address (in `X-Forwarded-For`):

    TRUST_PROXY=10.0.0.5                 # the proxy's address
    TRUST_PROXY=10.0.0.5,10.1.0.0/16     # several proxies or a range (CIDR)

- Use the proxy's address or range. `TRUST_PROXY=true` trusts any sender, so a client could put any address in the header and get around the sign-in limits. Don't use it on a server reachable without the proxy.
- Without `TRUST_PROXY` the header is ignored (safe, but behind a proxy everyone shares one address).
- Hop counts (e.g. `1`) are not supported by the server framework's current version; use addresses.
- Make sure the proxy *replaces* or *appends to* `X-Forwarded-For` (nginx: `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`).

Checked by `apps/api/test/security.test.ts` ("client addresses…").

**Several API processes:** the sign-in limits and the link-guessing limits are kept in memory, per process. With N
processes behind a load balancer, an attacker gets up to N times the attempts. Keep a single API process, or accept
this until shared limits exist (future work FW6 in `docs/iam-plan-v2.md`). Sessions, permissions and the activity log
are in the database and work across processes.

## Database indexes

The DataStore creates no secondary indexes. Lookups by a field (e.g. a person's group memberships on every request,
sign-in by email, a record's history) scan the collection. That is fine at the sizes the IAM caps allow (200 staff, 50
groups) and for a young shop. Add indexes when the history log (`audit_log`, never pruned) or the activity log grow to
tens of thousands of entries, or when order and customer lists feel slow.

**SQLite** (default): run once with the API stopped, e.g. `sqlite3 demo-data/db.sqlite < indexes.sql`. These match
the SQL the DataStore generates exactly, which SQLite requires for expression indexes. Checked with
`EXPLAIN QUERY PLAN`: every query below becomes an index search, with no separate sort step.

```sql
-- history of one record, newest first (GET /api/audit?entity=&id=)
CREATE INDEX IF NOT EXISTS audit_log_entity ON audit_log (json_extract(data, '$.entity'), json_extract(data, '$.entityId'), json_extract(data, '$.at'), id);
-- a person's activity, newest first (Activity page filtered by person, member page)
CREATE INDEX IF NOT EXISTS activity_user ON activity (json_extract(data, '$.userId'), id);
-- the signed-in member's groups, read on every API request
CREATE INDEX IF NOT EXISTS staff_memberships_user ON staff_memberships (json_extract(data, '$.userId'));
-- sign-in by email; one-time link lookup
CREATE INDEX IF NOT EXISTS users_email ON users (json_extract(data, '$.email'));
CREATE INDEX IF NOT EXISTS staff_links_token ON staff_links (json_extract(data, '$.tokenHash'));
```

The activity log needs nothing for its default view: its ids are time-ordered, so "newest first" already uses the
primary key. Old activity is deleted by the retention setting; the history log is kept (future work FW16).

**MongoDB:** the same indexes (`_id` is indexed already). These have **not** been run against a real MongoDB (future
work FW17):

```js
db.audit_log.createIndex({ entity: 1, entityId: 1, at: -1, _id: -1 })
db.activity.createIndex({ userId: 1, _id: -1 })
db.staff_memberships.createIndex({ userId: 1 })
db.users.createIndex({ email: 1 })
db.staff_links.createIndex({ tokenHash: 1 })
```

Still open (future work): isolating the builder canvas in a sandboxed iframe that talks to the backoffice only through
`postMessage`, and moving the session to an HttpOnly cookie (D4).

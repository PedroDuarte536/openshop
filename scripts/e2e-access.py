#!/usr/bin/env python3
"""Browser test of backoffice access control (docs/iam-plan-v2.md §2.12), driven by apps/api/test/access-matrix.json.

For every persona: sign in, check the landing page and the menu, open every screen by its address (allowed -> the
screen; otherwise the No access page, with the address unchanged) and do one real action where the matrix allows it.
Then the owner's flows end to end: invite -> join (second browser) -> permissions withdrawn while a screen is open ->
password reset link -> removal ends the session -> password policy forces a change at next sign-in -> Activity log.

It CHANGES DATA (orders, staff, security settings), so use a throw-away instance seeded with seed-demo.py:

    DB_PATH=/tmp/e2e.db PORT=3100 ... npm start -w @openshop/api && API=http://localhost:3100 python3 scripts/seed-demo.py
    BO=http://localhost:4300 API=http://localhost:3100 python3 scripts/e2e-access.py
"""
import json, os, re, sys, time, urllib.parse, urllib.request
from playwright.sync_api import sync_playwright, expect

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BO = os.environ.get("BO", "http://localhost:4300")
API = os.environ.get("API", "http://localhost:3100")
M = json.load(open(os.path.join(ROOT, "apps", "api", "test", "access-matrix.json")))
ENV = {k: v for k, v in (l.strip().split("=", 1) for l in open(os.path.join(ROOT, ".env.demo")) if "=" in l)}
SHOTS = os.environ.get("SHOTS", "/tmp/e2e-access")
os.makedirs(SHOTS, exist_ok=True)
problems, checks = [], 0

def ok(cond, what):
    global checks
    checks += 1
    if not cond: problems.append(what); print(f"FAIL {what}")

def creds(p):
    return (ENV["ADMIN_EMAIL"], ENV["ADMIN_PASSWORD"]) if p.get("sudo") else (p["email"], M["password"])

def api(method, path, body=None, token=None):
    req = urllib.request.Request(API + path, data=json.dumps(body).encode() if body is not None else None, method=method,
                                 headers={**({"content-type": "application/json"} if body is not None else {}), **({"authorization": f"Bearer {token}"} if token else {})})
    with urllib.request.urlopen(req) as r: b = r.read(); return json.loads(b) if b else None

def sign_in(page, email, password, expect_ok=True):
    page.goto(f"{BO}/login")
    page.fill("input[name=email]", email)
    page.fill("input[name=password]", password)
    page.click("button:has-text('Sign in')")
    if expect_ok: page.wait_for_url(lambda u: "/login" not in u, timeout=40000)

def menu(page):
    page.wait_for_selector(".side-foot")
    return [t.strip() for t in page.locator("nav[aria-label=Main] a").all_inner_texts()] + \
           [t.strip() for t in page.locator(".side-foot a[href^='/']:not([target])").all_inner_texts()]

def denied(page):
    page.wait_for_load_state("networkidle")
    return page.locator("h1:has-text(\"You don't have access\")").count() > 0

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    def context():
        ctx = browser.new_context(viewport={"width": 1440, "height": 1000})
        pg = ctx.new_page()
        pg.on("pageerror", lambda e: problems.append(f"page error: {e}"))
        return ctx, pg

    run_start = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(time.time() - 2))
    # ---------------------------------------------------------------- 1. every persona: menu, screens, actions
    first_screen = {"olivia": "/products", "sam": "/products", "pat": "/products", "cleo": "/products", "dana": "/products", "max": "/products",
                    "suki": "/orders", "finn": "/products", "vera": "/products", "nico": "/welcome", "mia": "/products"}
    for p in [x for x in M["personas"] if not x.get("state")]:
        ctx, page = context()
        email, pw_ = creds(p)
        sign_in(page, email, pw_)
        page.wait_for_load_state("networkidle")
        ok(urllib.parse.urlparse(page.url).path == first_screen[p["id"]], f"{p['id']}: lands on {first_screen[p['id']]} (got {page.url})")
        got = menu(page)
        ok(got == M["menus"][p["id"]], f"{p['id']}: menu {got} != {M['menus'][p['id']]}")
        for sc in M["screens"]:
            page.goto(BO + sc["path"])
            d = denied(page)
            allowed = p["id"] in sc["allowed"]
            ok(d == (not allowed), f"{p['id']}: {sc['path']} should be {'allowed' if allowed else 'refused'}")
            ok(urllib.parse.urlparse(page.url).path == sc["path"], f"{p['id']}: address stays {sc['path']} (got {page.url})")
        if p["id"] == "pat":
            page.screenshot(path=f"{SHOTS}/no-access-pat.png")
        print(f"ok  {p['id']:6} landing, menu, {len(M['screens'])} screens")
        ctx.close()

    # Each refused screen is logged exactly once (a screen must never be created twice).
    otok = api("POST", "/api/auth/login", {"email": ENV["ADMIN_EMAIL"], "password": ENV["ADMIN_PASSWORD"]})["token"]
    nico = next(u for u in api("GET", "/api/staff?status=all", token=otok)["items"] if u["email"] == "nico@maison-dune.test")
    refused = [e["path"] for e in api("GET", f"/api/activity?kinds=page_denied&userId={nico['id']}&from={run_start}&limit=200", token=otok)["items"]]
    ok(sorted(refused) == sorted(sc["path"] for sc in M["screens"] if "nico" not in sc["allowed"]), f"nico: each refused screen logged once: {sorted(refused)}")

    # Real actions allowed by the matrix (one per role), through the UI. Fresh pending orders for Pat and Finn:
    prod = next(x for x in api("GET", "/api/shop/products") if x["stock"] > 2)
    for _ in range(2): api("POST", "/api/shop/orders", {"items": [{"productId": prod["id"], "qty": 1}], "customer": {"name": "E2E Buyer", "email": "e2e.buyer@example.com", "address": "Rua 1, Lisboa"}})
    def as_persona(pid):
        p = next(x for x in M["personas"] if x["id"] == pid)
        ctx, page = context(); sign_in(page, *creds(p)); return ctx, page
    ctx, page = as_persona("pat")        # O2: ship a pending order; only Pending/Shipped offered
    page.goto(f"{BO}/orders"); page.wait_for_selector("select.status-sel.pending")
    sel = page.locator("tbody tr", has=page.locator("select.status-sel.pending")).first.locator("select")
    ok(sel.locator("option").all_inner_texts() == ["Pending", "Shipped"], "pat: status choices are Pending, Shipped")
    sel.select_option("shipped"); page.wait_for_load_state("networkidle")
    ok(page.locator("[role=alert]").count() == 0, "pat: shipping an order works")
    page.goto(f"{BO}/products")
    page.locator("button:has-text('Update stock')").first.click()
    page.fill(".stock-edit input", "42"); page.click(".stock-edit button:has-text('Save')"); page.wait_for_load_state("networkidle")
    ok(page.locator("tbody").inner_text().count("42") >= 1, "pat: stock updated")
    ok(page.locator("button:has-text('+ New product')").count() == 0, "pat: no new product button")
    page.screenshot(path=f"{SHOTS}/pat-products.png"); ctx.close()
    ctx, page = as_persona("finn")       # O3: mark paid
    page.goto(f"{BO}/orders"); page.wait_for_selector("select.status-sel.pending")
    sel = page.locator("tbody tr", has=page.locator("select.status-sel.pending")).first.locator("select")
    ok(sel.locator("option").all_inner_texts() == ["Pending", "Paid"], "finn: status choices are Pending, Paid")
    sel.select_option("paid"); page.wait_for_load_state("networkidle")
    ok(page.locator("[role=alert]").count() == 0, "finn: marking paid works"); ctx.close()
    ctx, page = as_persona("max")        # D3: create an offer; client price is not available
    page.goto(f"{BO}/discounts/new")
    ok(page.locator("button.preset:has-text('Client price')").is_disabled(), "max: client price needs See customers")
    page.fill("input[name=name]", "E2E Max offer"); page.fill("input[name=label]", "Max 5%")
    page.click("button:has-text('Create offer')"); page.wait_for_url(re.compile(r"/discounts/[0-9a-f-]{36}$"), timeout=15000)
    ok(True, "max: offer created"); ctx.close()
    ctx, page = as_persona("suki")       # U4: account link for a customer; no deletion
    page.goto(f"{BO}/customers"); page.locator("tbody a.link").first.click(); page.wait_for_load_state("networkidle")
    ok(page.locator(".danger-zone").count() == 0, "suki: can't delete customers")
    page.locator("button:has-text('link')").first.click(); page.wait_for_selector(".linkbox")
    ok("/shop/account/" in page.locator(".linkbox input").input_value(), "suki: customer account link created"); ctx.close()
    ctx, page = as_persona("cleo")       # C3: edit a price
    page.goto(f"{BO}/products"); page.locator("button:has-text('Edit')").first.click()
    page.fill("input[name=price]", "31"); page.click("button:has-text('Save changes')"); page.wait_for_selector(".drawer", state="detached")
    ok(True, "cleo: price edited"); ctx.close()
    print("ok  role actions: pat ships + stock, finn marks paid, max creates an offer, suki creates a customer link, cleo edits a price")

    # Invited, suspended and removed personas can't sign in.
    for p in [x for x in M["personas"] if x.get("state")]:
        ctx, page = context(); sign_in(page, p["email"], M["password"], expect_ok=False)
        expect(page.locator("[role=alert]")).to_be_visible()
        ok("/login" in page.url, f"{p['id']} ({p['state']}) can't sign in"); ctx.close()
    print("ok  invited, suspended and removed members can't sign in")

    # ---------------------------------------------------------------- 2. owner flows
    octx, owner = context()
    sign_in(owner, ENV["ADMIN_EMAIL"], ENV["ADMIN_PASSWORD"])
    owner.goto(f"{BO}/team")
    owner.click("button:has-text('+ Invite someone')")
    stamp = str(int(time.time()))
    new_email = f"lena.{stamp}@maison-dune.test"
    lena = f"Lena {stamp[-5:]}"
    owner.fill("input[name=email]", new_email); owner.fill("input[name=name]", lena)
    owner.locator(".picks label", has_text="Fulfilment").locator("input").check()
    owner.click("button:has-text('Create invitation link')")
    link = owner.locator(".linkbox input").input_value()
    ok("/join#" in link, "invitation link shown")
    owner.screenshot(path=f"{SHOTS}/owner-invite.png")
    mctx, member = context()
    member.goto(link)
    expect(member.locator("h2")).to_contain_text("Join")
    ok("#" not in member.url, "the token is removed from the address bar")
    member.fill("input[name=password]", "lena-short"); member.fill("input[name=confirm]", "lena-short")
    member.click("button:has-text('Join and sign in')")
    expect(member.locator("[role=alert]")).to_be_visible()
    member.fill("input[name=password]", "glazed stoneware 2026"); member.fill("input[name=confirm]", "glazed stoneware 2026")
    member.click("button:has-text('Join and sign in')")
    member.wait_for_url(re.compile(r"/products$"), timeout=15000)
    ok(menu(member) == ["Products", "Categories", "Orders", "My account"], "new member sees the Fulfilment menu")
    member.goto(f"{BO}/join")
    expect(member.locator("h2")).to_contain_text("no longer valid")
    member.goto(f"{BO}/orders"); member.wait_for_load_state("networkidle")
    print("ok  invite -> join -> signed in with the group's menu; the link works once")

    # Permissions withdrawn while the member has a screen open.
    owner.goto(f"{BO}/team"); owner.click(f"a:has-text('{lena}')"); owner.wait_for_load_state("networkidle")
    member_url = owner.url
    owner.locator(".picks label", has_text="Fulfilment").locator("input").uncheck()
    owner.click("button:has-text('Save groups')"); expect(owner.locator("[role=status]")).to_contain_text("Groups saved")
    member.click("nav a:has-text('Products')")
    expect(member.locator("h1")).to_contain_text("You don't have access to Products", timeout=15000)
    ok(member.url.endswith("/products"), "the address stays /products")
    expect(member.locator("nav[aria-label=Main] a")).to_have_count(0)
    member.screenshot(path=f"{SHOTS}/member-access-withdrawn.png")
    print("ok  access withdrawn while open: the next click shows No access and the menu shrinks")

    # Password reset link, then removal ends the session at the next click.
    owner.click("button:has-text('Create password reset link')")
    reset = owner.locator(".linkbox input").input_value()
    owner.click("button:has-text('Revoke link')"); expect(owner.locator("[role=status]")).to_contain_text("Link revoked")
    rctx, r = context(); r.goto(reset); expect(r.locator("h2")).to_contain_text("no longer valid"); rctx.close()
    owner.click(f"button:has-text('Remove {lena}')"); owner.click("button:has-text('Click to confirm')")
    expect(owner.locator("[role=status]")).to_contain_text("access ended immediately")
    member.click(".side-foot a:has-text('My account')")
    member.wait_for_url(re.compile(r"/login$"), timeout=15000)
    ok(True, "removed member is signed out at the next click")
    print("ok  reset link revoked inside its window; removal signs the member out at the next click")
    mctx.close()

    # Password policy: require a longer password and enforce it at the next sign-in.
    owner.goto(f"{BO}/settings"); owner.wait_for_selector("#security")
    owner.fill("input[name=staff-min]", "16")
    owner.locator("label.sw", has_text="Require at next sign-in").locator("i").click()
    owner.click("button:has-text('Save security settings')"); expect(owner.locator("#security [role=status]")).to_contain_text("saved")
    pctx, pat = context(); sign_in(pat, "pat@maison-dune.test", M["password"])
    pat.wait_for_url(re.compile(r"/account$"), timeout=15000)
    expect(pat.locator(".banner")).to_contain_text("no longer meets")
    pat.goto(f"{BO}/orders"); pat.wait_for_url(re.compile(r"/account$"))
    pat.fill("input[name=current]", M["password"]); pat.fill("input[name=password]", "dune-staff-2026-longer"); pat.fill("input[name=confirm]", "dune-staff-2026-longer")
    pat.click("button:has-text('Change password')"); pat.wait_for_url(re.compile(r"/products$"), timeout=15000)
    ok(True, "forced password change, then back to work"); pctx.close()
    # put the policy back for the other tests and the demo
    owner.goto(f"{BO}/settings"); owner.wait_for_selector("#security")
    owner.fill("input[name=staff-min]", "12")
    owner.locator("label.sw", has_text="Require at next sign-in").locator("i").click()
    owner.click("button:has-text('Save security settings')"); expect(owner.locator("#security [role=status]")).to_contain_text("saved")
    tok = api("POST", "/api/auth/login", {"email": "pat@maison-dune.test", "password": "dune-staff-2026-longer"})["token"]
    api("POST", "/api/me/password", {"current": "dune-staff-2026-longer", "password": M["password"]}, tok)
    print("ok  password policy: enforced at next sign-in, then restored")

    # Activity: everything above is on record, with filters.
    owner.goto(member_url)
    expect(owner.locator("app-activity-list")).to_contain_text("Signed in")
    owner.goto(f"{BO}/activity"); owner.wait_for_load_state("networkidle")
    text = owner.locator("app-activity-list").inner_text()
    for needle in ["Signed in", "Opened /", "Was refused", f"Created an invitation link for {lena}"]:
        ok(needle in text, f"activity shows '{needle}'")
    owner.select_option("select[name=user]", label=f"{lena} (removed)"); owner.click("button:has-text('Apply')")
    expect(owner.locator("app-activity-list")).to_contain_text("Used their invitation link", timeout=15000)
    owner.click("button.chip-toggle:has-text('Denied access')")
    expect(owner.locator("app-activity-list")).not_to_contain_text("Used their invitation link", timeout=15000)
    expect(owner.locator("app-activity-list")).to_contain_text("Old session refused (account removed)")
    denied_text = owner.locator("app-activity-list").inner_text()
    ok("Request refused" in denied_text and "Was refused /products" in denied_text and "Signed in" not in denied_text, f"person + kind filter: {lena}'s refusals")
    owner.screenshot(path=f"{SHOTS}/owner-activity.png", full_page=True)
    owner.goto(f"{BO}/team"); owner.check("text=Access overview")
    owner.screenshot(path=f"{SHOTS}/owner-access-overview.png", full_page=True)
    owner.goto(f"{BO}/this-does-not-exist"); expect(owner.locator("h1")).to_have_text("Page not found")

    # Backoffice CSP (plan S9): injected inline scripts and event handlers don't run, neither in the backoffice nor in
    # the page-builder canvas (the canvas iframe inherits the policy).
    resp = owner.goto(f"{BO}/team")
    csp = resp.headers.get("content-security-policy", "")
    ok("script-src 'self'" in csp and "frame-ancestors 'none'" in csp, f"backoffice CSP header: {csp[:80]}")
    owner.evaluate("""document.body.insertAdjacentHTML('beforeend', '<img src="/nope.png" onerror="window.__xss = 1">'); const s = document.createElement('script'); s.textContent = 'window.__xss2 = 1'; document.body.append(s);""")
    owner.wait_for_timeout(800)
    ok(owner.evaluate("window.__xss === undefined && window.__xss2 === undefined"), "inline handler and inline script blocked in the backoffice")
    owner.goto(f"{BO}/pages"); owner.locator("a:has-text('Design'), a:has-text('Edit')").first.click()
    owner.wait_for_url(re.compile(r"/pages/[0-9a-f-]{36}$")); owner.wait_for_timeout(1500)
    canvas = next(f for f in owner.frames if f != owner.main_frame and f.url in ("about:srcdoc", ""))
    canvas.evaluate("""document.body.insertAdjacentHTML('beforeend', '<img src="/nope.png" onerror="parent.__xss3 = 1">')""")
    owner.wait_for_timeout(800)
    ok(owner.evaluate("window.__xss3 === undefined"), "inline handler blocked inside the builder canvas")
    ok(canvas.evaluate("!!window.osEditor"), "the builder's own canvas script still runs")
    print("ok  activity log lists sign-ins, page views, refusals and changes; filters; access overview; page not found; CSP blocks injected scripts")

    # Hostile text (names, group names, a browser string in the activity log) is shown as text, never run.
    evil = '<img src=x onerror="window.__pwn=1">'
    inv = api("POST", "/api/staff", {"email": f"evil.{stamp}@maison-dune.test", "name": f"Eve {evil}"}, otok)
    grp = api("POST", "/api/staff-groups", {"name": f"Grp {evil}", "permissions": ["orders.view"]}, otok)
    req = urllib.request.Request(API + "/api/activity/beacon", data=json.dumps({"kind": "page_view", "path": "/x"}).encode(), method="POST",
                                 headers={"content-type": "application/json", "authorization": f"Bearer {otok}", "user-agent": f"UA {evil}<script>window.__pwn=2</script>"})
    urllib.request.urlopen(req)
    for path in ["/team", f"/team/{inv['member']['id']}", "/team/groups", f"/team/groups/{grp['id']}", "/activity"]:
        owner.goto(BO + path); owner.wait_for_load_state("networkidle")
        if path == "/activity": owner.locator("tbody tr.clickable").first.click(); owner.wait_for_timeout(300)
        ok(owner.evaluate("window.__pwn === undefined"), f"no script ran on {path}")
        ok(evil in owner.locator("main").inner_text(), f"the hostile text is shown literally on {path}")
    print("ok  hostile names, group names and browser strings are displayed as text on every team and activity screen")
    octx.close()
    browser.close()

print(f"\n{checks} checks, {len(problems)} problems")
for p in problems: print(" -", p)
sys.exit(1 if problems else 0)

#!/usr/bin/env python3
"""Browser test of the storefront discounts (shop.js under the real CSP), against a seeded demo shop.

    API=http://localhost:3100 python3 scripts/e2e-storefront.py

Needs Playwright for Python with Chromium. It PLACES ORDERS, so run it against a throw-away instance, not your demo.
Fails on any console error or CSP violation.
"""
import json, os, re, sys, urllib.request
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get("API", "http://localhost:3100")
SHOTS = os.environ.get("SHOTS", "/tmp/e2e-shots")
os.makedirs(SHOTS, exist_ok=True)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = dict(l.strip().split("=", 1) for l in open(os.path.join(ROOT, ".env.demo")) if "=" in l and not l.startswith("#"))
DEMO_PASSWORD = "dune-demo-2026"  # set for the demo accounts by seed-demo.py

def get(path):
    with urllib.request.urlopen(BASE + path) as r: return json.loads(r.read())

def admin(method, path, body=None):
    if not hasattr(admin, "token"):
        req = urllib.request.Request(BASE + "/api/auth/login", data=json.dumps({"email": ENV["ADMIN_EMAIL"], "password": ENV["ADMIN_PASSWORD"]}).encode(), headers={"content-type": "application/json"}, method="POST")
        admin.token = json.loads(urllib.request.urlopen(req).read())["token"]
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None, method=method, headers={"authorization": f"Bearer {admin.token}", **({"content-type": "application/json"} if body is not None else {})})
    try:
        with urllib.request.urlopen(req) as r: b = r.read(); return json.loads(b) if b else None
    except urllib.error.HTTPError as e: raise RuntimeError(f"{method} {path}: {e.code} {e.read().decode()[:300]}")

# ---- line coverage of the storefront script (Chromium precise coverage, merged over every page we open) ----
COVERED = {}  # char offset -> covered (True if any page executed it)
SESSIONS = []

def cover(page):
    s = page.context.new_cdp_session(page)
    s.send("Profiler.enable")
    s.send("Profiler.startPreciseCoverage", {"callCount": True, "detailed": True})
    SESSIONS.append(s)
    # V8 drops a document's coverage when the tab navigates away: collect before every navigation.
    original_goto = page.goto
    def goto(*a, **k):
        take_all()
        return original_goto(*a, **k)
    page.goto = goto
    return page

def take_all():
    for s in SESSIONS:
        try: result = s.send("Profiler.takePreciseCoverage")["result"]
        except Exception: continue  # page already closed
        for script in result:
            if not script["url"].endswith("/assets/shop.js"): continue
            # V8 block coverage: nested ranges; the innermost range decides whether a character ran.
            ranges = sorted((r for f in script["functions"] for r in f["ranges"]), key=lambda r: (r["startOffset"], -r["endOffset"]))
            state = {}
            for r in ranges:
                for i in range(r["startOffset"], r["endOffset"]): state[i] = r["count"] > 0
            for i, v in state.items(): COVERED[i] = COVERED.get(i, False) or v

def report():
    src = urllib.request.urlopen(BASE + "/assets/shop.js").read().decode()
    lines, offset, total, hit, missed = src.split("\n"), 0, 0, 0, []
    in_comment = False
    for n, line in enumerate(lines, 1):
        code = line.strip()
        start = offset + (len(line) - len(line.lstrip()))
        offset += len(line) + 1
        if in_comment or code.startswith("/*"):
            in_comment = not code.endswith("*/") if not (code.startswith("/*") and code.endswith("*/")) else False
            continue
        if not code or code.startswith("//") or code.startswith("*") or re.fullmatch(r"[})\];,]+", code): continue
        total += 1
        if COVERED.get(start): hit += 1
        else: missed.append(n)
    pct = 100 * hit / total if total else 0
    text = f"shop.js line coverage: {pct:.1f}% ({hit}/{total} lines); not executed: {missed}"
    open(f"{SHOTS}/shopjs-coverage.txt", "w").write(text + "\n")
    print(text)

def sign_in(page, email, password=DEMO_PASSWORD):
    page.goto(f"{BASE}/shop/account")
    page.fill("input[name=email]", email)
    page.fill("input[name=password]", password)
    page.locator("form[action='/shop/account/login'] button").click()
    expect(page.locator("h1")).to_contain_text("Hello")

def main():
    products = {p["name"]: p for p in get("/api/shop/products")}
    problems = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = cover(browser.new_page(viewport={"width": 1280, "height": 900}))
        def on_console(m):
            if m.type not in ("error", "warning"): return
            url = (m.location or {}).get("url", "")
            # Expected: web fonts (this may run offline), the deliberate invalid-code request (HTTP 400) and the
            # "your total has changed" page (HTTP 409).
            if "Failed to load resource" in m.text and (re.search(r"fonts\.(googleapis|gstatic)\.com", url) or url.endswith("/api/shop/cart/codes") or url.endswith("/shop/checkout") or "status of 410" in m.text and "/shop/account/activate/" in url): return
            problems.append(f"console {m.type}: {m.text} ({url})")
        page.on("console", on_console)
        page.on("pageerror", lambda e: problems.append(f"page error: {e}"))

        # 1. Shop grid: the Winter sale (20% on mugs) shows as new price + struck-through original + badge.
        page.goto(f"{BASE}/shop")
        mug = page.locator(f'[data-os-price="{products["Linen Mug"]["id"]}"]')
        expect(mug.locator(".os-now")).to_have_text("€19.20")
        expect(mug.locator(".os-was")).to_contain_text("€24.00")
        expect(mug.locator(".os-badge")).to_have_text("−20%")
        expect(mug).to_have_attribute("title", "Winter sale (Category offer)")
        # Not discounted: untouched list price
        expect(page.locator(f'[data-os-price="{products["Stoneware Bowl"]["id"]}"]')).to_have_text("€38.00")
        page.screenshot(path=f"{SHOTS}/1-shop.png", full_page=False)
        print("ok  shop grid shows sale prices from the API")

        # 2. Product page: offers box with the applied offer and the alternative (transparency).
        page.goto(f'{BASE}/shop/product/{products["Bud Vase"]["id"]}')
        box = page.locator("[data-os-offers]")
        expect(box).to_be_visible()
        expect(box.locator(".os-offer--on b")).to_have_text("Clearance price")
        expect(box.locator(".os-offer--on span")).to_have_text("€19.00")
        expect(box.locator(".os-offer").nth(1)).to_contain_text("Vase lovers")
        expect(box.locator(".os-offer").nth(1)).to_contain_text("€24.65")
        expect(box.locator(".os-offer").nth(1)).to_contain_text("Also applies; your best price is used")
        expect(page.locator(".os-price .os-now")).to_have_text("€19.00")
        page.screenshot(path=f"{SHOTS}/2-product.png", full_page=False)
        print("ok  product page lists the applied offer and the alternative")

        page.goto(f'{BASE}/shop/product/{products["Linen Mug"]["id"]}')
        expect(page.locator("[data-os-offers] .os-offer--on small")).to_contain_text(re.compile(r"Until .* \(Lisbon time\)"))
        print("ok  end time shown in shop time (Lisbon)")

        # 3. Cart: line prices, savings, limited offer (save for later), code vs automatic choice.
        page.locator("form.os-atc button").click()
        page.goto(f'{BASE}/shop/product/{products["Moon Vase"]["id"]}')
        page.locator("form.os-atc button").click()
        expect(page).to_have_url(re.compile(r"/shop/cart$"))
        panel = page.locator("#os-cart-pricing")
        expect(panel.locator("legend").first).to_contain_text("Your savings")
        mug_total = page.locator(f'[data-os-line-total="{products["Linen Mug"]["id"]}"]')
        expect(mug_total.locator(".os-now")).to_have_text("€19.20")
        expect(page.locator(f'[data-os-line-offers="{products["Moon Vase"]["id"]}"]')).to_contain_text("Vase lovers")
        # Moon Vase 68 -> 15% = 10.20 (within the €20 budget); total = 19.20 + 57.80 = 77.00
        expect(page.locator("[data-os-cart-total] .os-now")).to_have_text("€77.00")
        limited = panel.locator("label", has_text="Use Vase lovers on this order")
        expect(limited).to_contain_text("€87.20")
        page.screenshot(path=f"{SHOTS}/3-cart.png", full_page=True)
        print("ok  cart shows per-line sources, savings and the save-for-later option")

        # Unknown code: generic message
        panel.locator("input[name=code]").fill("NOPE-1234")
        panel.locator("form.os-codeform button").click()
        expect(panel.locator("[role=alert]")).to_have_text("This code isn't valid.")
        # WELCOME10 (10% on orders from €40, first order, not combinable): choose between options
        panel.locator("input[name=code]").fill("welcome10")
        panel.locator("form.os-codeform button").click()
        expect(panel).to_contain_text("Code WELCOME10 added.")
        choose = panel.locator("fieldset", has_text="Choose how to save")
        expect(choose).to_be_visible()
        expect(choose.locator("label").nth(0)).to_contain_text("Automatic offers: total €77.00")
        expect(choose.locator("label").nth(0)).to_contain_text("best price")
        expect(choose.locator("label").nth(1)).to_contain_text("Code WELCOME10: total €82.80")
        page.screenshot(path=f"{SHOTS}/4-choice.png", full_page=True)
        choose.locator("input[value=code]").check()
        expect(page.locator("[data-os-cart-total] .os-now")).to_have_text("€82.80")
        print("ok  code vs automatic offers: both totals shown, shopper can switch")
        choose.locator("input[value=automatic]").check()
        expect(page.locator("[data-os-cart-total] .os-now")).to_have_text("€77.00")

        # Save the limited offer for later
        panel.locator("label", has_text="Use Vase lovers on this order").locator("input").uncheck()
        expect(page.locator("[data-os-cart-total] .os-now")).to_have_text("€87.20")
        panel.locator("label", has_text="Use Vase lovers on this order").locator("input").check()
        expect(page.locator("[data-os-cart-total] .os-now")).to_have_text("€77.00")
        print("ok  save for later toggles the limited offer and the total")

        # 4. Checkout: the quote is sent; the order records what was charged.
        quote = page.locator("[data-os-quote]").input_value()
        assert quote, "quote filled in by the script"
        page.fill("input[name=name]", "E2E Shopper")
        page.fill("input[name=email]", "e2e.shopper@example.com")
        page.fill("textarea[name=address]", "1 Test Street")
        page.locator("form[action='/shop/checkout'] button").click()
        expect(page.locator("h1")).to_contain_text("Thank you, E2E Shopper")
        expect(page.locator("body")).to_contain_text("Winter sale: −4.80")
        expect(page.locator("body")).to_contain_text("Vase lovers: −10.20")
        expect(page.locator("table")).to_contain_text("77.00")
        page.screenshot(path=f"{SHOTS}/5-confirmation.png", full_page=True)
        print("ok  checkout charges the displayed total and the confirmation shows the discounts")

        # 5. Returning guest: the €20 Vase lovers budget is partly used, which can only be known once the email is typed.
        page.goto(f'{BASE}/shop/product/{products["Moon Vase"]["id"]}')
        page.locator("form.os-atc button").click()
        expect(page.locator("[data-os-cart-total] .os-now")).to_have_text("€57.80")
        expect(page.locator("#os-cart-pricing")).to_contain_text("checked when you place your order")
        page.fill("input[name=name]", "E2E Shopper")
        page.fill("input[name=email]", "E2E.Shopper+again@example.com")
        page.fill("textarea[name=address]", "1 Test Street")
        page.locator("form[action='/shop/checkout'] button").click()
        expect(page.locator("h1")).to_have_text("Your total has changed")
        expect(page.locator("table")).to_contain_text("Vase lovers")
        expect(page.locator("table")).to_contain_text("−9.80")
        page.screenshot(path=f"{SHOTS}/6-total-changed.png", full_page=True)
        page.locator("button", has_text="Place order for 58.20").click()
        expect(page.locator("h1")).to_contain_text("Thank you, E2E Shopper")
        expect(page.locator("table")).to_contain_text("58.20")
        print("ok  returning guest: remaining budget applied, new total confirmed before ordering")

        # 6. Accounts: a new customer activates the one-time link the owner created, and lands in their account.
        ctx = browser.new_context(viewport={"width": 1280, "height": 900})
        acc = cover(ctx.new_page())
        acc.on("console", on_console)
        cust = admin("POST", "/api/customers", {"email": "e2e.new@example.com", "name": "New Customer"})
        link = admin("POST", f"/api/customers/{cust['id']}/links", {"purpose": "activate"})
        acc.goto(BASE + link["path"])
        expect(acc.locator("h1")).to_have_text("Set your password")
        acc.fill("input[name=password]", "a long password")
        acc.fill("input[name=confirm]", "a long password")
        acc.locator("form button").click()
        expect(acc.locator("h1")).to_have_text("Hello, New Customer")
        acc.goto(BASE + link["path"])
        expect(acc.locator("h1")).to_have_text("This link is no longer valid")
        take_all(); ctx.close()
        print("ok  one-time activation link: set password, signed in, link can't be reused")

        # 7. Trade profile member: profile prices everywhere, with the profile's label; "Your offers" lists them.
        ctx = browser.new_context(viewport={"width": 1280, "height": 900})
        tp = cover(ctx.new_page())
        tp.on("console", on_console)
        sign_in(tp, "jonas.weber@example.com")
        offers = tp.locator("#os-account-offers")
        expect(offers).to_contain_text("You are a member of: Trade price")
        expect(offers).to_contain_text("Trade discount")
        expect(offers).to_contain_text("Trade mug price")
        tp.screenshot(path=f"{SHOTS}/7-account.png", full_page=True)
        tp.goto(f"{BASE}/shop")
        expect(tp.locator(f'[data-os-price="{products["Linen Mug"]["id"]}"] .os-now')).to_have_text("€15.00")
        expect(tp.locator(f'[data-os-price="{products["Stoneware Bowl"]["id"]}"] .os-now')).to_have_text("€26.60")
        tp.goto(f'{BASE}/shop/product/{products["Linen Mug"]["id"]}')
        box = tp.locator("[data-os-offers]")
        expect(box.locator(".os-offer--on")).to_contain_text("Trade mug price")
        expect(box.locator(".os-offer--on")).to_contain_text("Trade price")
        expect(box).to_contain_text("Winter sale")
        tp.screenshot(path=f"{SHOTS}/8-trade-product.png", full_page=False)
        tp.locator("form.os-atc button").click()
        expect(tp.locator("p.os-msg").first).to_contain_text("Signed in as Jonas Weber")
        expect(tp.locator("input[name=email]")).to_have_value("jonas.weber@example.com")
        expect(tp.locator(f'[data-os-line-offers="{products["Linen Mug"]["id"]}"]')).to_contain_text("Trade mug price · Trade price")
        tp.fill("textarea[name=address]", "Kastanienallee 71, Berlin")
        tp.locator("form[action='/shop/checkout'] button").click()
        expect(tp.locator("h1")).to_contain_text("Thank you")
        expect(tp.locator("body")).to_contain_text("Trade mug price")
        take_all(); ctx.close()
        print("ok  profile member: trade prices in grid, product page, cart and checkout; Your offers")

        # 8. Personal code: one click in the cart; nobody else can use it.
        sofia_code = next(c["code"] for c in admin("GET", "/api/customers/" + next(c["id"] for c in admin("GET", "/api/customers") if c["email"] == "sofia.rossi@example.com"))["codes"])
        ctx = browser.new_context(viewport={"width": 1280, "height": 900})
        sp = cover(ctx.new_page())
        sp.on("console", on_console)
        sign_in(sp, "sofia.rossi@example.com")
        expect(sp.locator("#os-account-offers")).to_contain_text(f"Your code {sofia_code}")
        sp.goto(f'{BASE}/shop/product/{products["Stoneware Bowl"]["id"]}')
        sp.locator("form.os-atc button").click()
        panel = sp.locator("#os-cart-pricing")
        panel.locator("button", has_text=f"Use {sofia_code}").click()
        expect(panel).to_contain_text(f"Code {sofia_code} added.")
        expect(sp.locator("[data-os-cart-total] .os-now")).to_have_text("€30.00")
        sp.screenshot(path=f"{SHOTS}/9-personal-code.png", full_page=True)
        take_all(); ctx.close()
        guest = cover(browser.new_page())
        guest.goto(f'{BASE}/shop/product/{products["Stoneware Bowl"]["id"]}')
        guest.locator("form.os-atc button").click()
        guest.locator("#os-cart-pricing input[name=code]").fill(sofia_code)
        guest.locator("#os-cart-pricing form.os-codeform button").click()
        expect(guest.locator("#os-cart-pricing [role=alert]")).to_have_text("This code isn't valid.")
        take_all(); guest.close()
        print("ok  personal code: one click for its owner, refused for anyone else")

        # 9. Edge cases: conditional alternatives, old product page designs, API failures.
        cond1 = admin("POST", "/api/discounts", {"name": "E2E min qty", "label": "Buy 3", "target": {"type": "products", "productIds": [products["Salt Cellar"]["id"]]}, "effect": {"type": "percent", "bp": 3000}, "conditions": {"minQty": 3}})
        cond2 = admin("POST", "/api/discounts", {"name": "E2E min order", "label": "Big basket", "target": {"type": "products", "productIds": [products["Salt Cellar"]["id"]]}, "effect": {"type": "percent", "bp": 2500}, "conditions": {"minSubtotalCents": 20000}})
        page.goto(f'{BASE}/shop/product/{products["Salt Cellar"]["id"]}')
        box = page.locator("[data-os-offers]")
        expect(box).to_contain_text("When you buy 3 or more")
        expect(box).to_contain_text("On orders from €200.00")
        for d in (cond1, cond2): admin("POST", f"/api/discounts/{d['id']}/archive")
        print("ok  offers with conditions are explained on the product page")

        # a product page designed before the Offers widget existed: the script adds the box under the price
        pages_list = admin("GET", "/api/pages")
        prod_page = next(x for x in pages_list if x.get("system") == "product")
        full = admin("GET", f"/api/pages/{prod_page['id']}")
        strip = lambda ns: [{**n, "children": strip(n["children"])} if n.get("children") else n for n in ns if n["type"] != "productOffers"]
        admin("PUT", f"/api/pages/{prod_page['id']}", {"slug": full["slug"], "title": full["title"], "theme": full["theme"], "nodes": strip(full["nodes"])})
        page.goto(f'{BASE}/shop/product/{products["Bud Vase"]["id"]}')
        expect(page.locator(".os-price + [data-os-offers]")).to_contain_text("Clearance price")
        admin("PUT", f"/api/pages/{prod_page['id']}", {"slug": full["slug"], "title": full["title"], "theme": full["theme"], "nodes": full["nodes"]})
        print("ok  older product page designs still show offers")

        # the API is down: list prices stay, the account page says offers still apply
        ctx = browser.new_context()
        down = cover(ctx.new_page())
        down.on("console", lambda m: problems.append(f"console {m.type}: {m.text}") if m.type == "error" and "fonts.g" not in ((m.location or {}).get("url", "")) and "status of 500" not in m.text and "ERR_FAILED" not in m.text else None)
        sign_in(down, "jonas.weber@example.com")
        down.route("**/api/shop/account/offers", lambda r: r.fulfill(status=500, body="{}"))
        down.route("**/api/shop/prices*", lambda r: r.abort())
        down.goto(f"{BASE}/shop/account")
        expect(down.locator("#os-account-offers")).to_have_text("Your offers couldn't be loaded. They are still applied in your cart.")
        down.goto(f"{BASE}/shop")
        expect(down.locator(f'[data-os-price="{products["Linen Mug"]["id"]}"]')).to_have_text("€24.00")
        take_all(); ctx.close()
        print("ok  when the API fails, list prices stay and the shopper is told offers still apply")

        # 10. Without JavaScript: list prices, a notice, and automatic offers still applied at checkout.
        ctx = browser.new_context(java_script_enabled=False)
        p2 = ctx.new_page()
        p2.goto(f"{BASE}/shop")
        expect(p2.locator(f'[data-os-price="{products["Linen Mug"]["id"]}"]')).to_have_text("€24.00")
        ctx.close()
        print("ok  without JavaScript the list price stays")
        take_all()
        browser.close()
    report()

    if problems:
        print("\n".join(problems)); sys.exit("FAILED: console errors or CSP violations")
    print("PASSED: no console errors, no CSP violations")

if __name__ == "__main__": main()

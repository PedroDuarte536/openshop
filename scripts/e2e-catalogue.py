#!/usr/bin/env python3
"""Browser test of the catalogue features (search and filters, visitor prices, variants, bundles, import, lifecycle),
against a seeded demo shop, with the storefront under its real CSP and the backoffice on ng serve.

    API=http://localhost:3100 BO=http://localhost:4300 python3 scripts/e2e-catalogue.py

Needs Playwright for Python with Chromium. It CREATES PRODUCTS AND PLACES ORDERS: use a throw-away instance.
Fails on any console error or CSP violation.
"""
import json, os, re, sys, time, urllib.request
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get("API", "http://localhost:3100")
BO = os.environ.get("BO", "http://localhost:4300")
SHOTS = os.environ.get("SHOTS", "/tmp/e2e-shots")
os.makedirs(SHOTS, exist_ok=True)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = dict(l.strip().split("=", 1) for l in open(os.path.join(ROOT, ".env.demo")) if "=" in l and not l.startswith("#"))
DEMO_PASSWORD = "dune-demo-2026"

def admin(method, path, body=None):
    if not hasattr(admin, "token"):
        req = urllib.request.Request(BASE + "/api/auth/login", data=json.dumps({"email": ENV["ADMIN_EMAIL"], "password": ENV["ADMIN_PASSWORD"]}).encode(), headers={"content-type": "application/json"}, method="POST")
        admin.token = json.loads(urllib.request.urlopen(req).read())["token"]
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None, method=method, headers={"authorization": f"Bearer {admin.token}", **({"content-type": "application/json"} if body is not None else {})})
    try:
        with urllib.request.urlopen(req) as r: b = r.read(); return json.loads(b) if b else None
    except urllib.error.HTTPError as e: raise RuntimeError(f"{method} {path}: {e.code} {e.read().decode()[:300]}")

def product_by_name(name):
    r = admin("GET", "/api/products?" + urllib.parse.urlencode({"q": name, "limit": "50"}))
    return next(p for p in r["items"] if p["name"] == name)

def setup():
    """Properties, the owner's variant example, a bundle and colours on a few demo products."""
    have = {a["key"] for a in admin("GET", "/api/attributes")}
    defs = [
        {"key": "colour", "label": "Colour", "type": "choice", "options": [{"label": "Sand", "swatch": "#d8c3a5"}, {"label": "Ink blue", "swatch": "#1f3b73"}]},
        {"key": "color", "label": "Colors", "type": "text"}, {"key": "size", "label": "Size", "type": "number"},
        {"key": "gender", "label": "Gender", "type": "choice", "options": [{"label": "Female"}, {"label": "Male"}]}, {"key": "temperature", "label": "Temperature", "type": "text"},
    ]
    for d in defs:
        if d["key"] not in have: admin("POST", "/api/attributes", d)
    for name, colour in [("Linen Mug", "sand"), ("Breakfast Bowl", "ink-blue"), ("Ramen Bowl", "sand")]:
        admin("PATCH", f"/api/products/{product_by_name(name)['id']}", {"attributes": {"colour": colour}})
    example = [("E2E Jacket 1", "White", 10, "Female", "10º"), ("E2E Jacket 2", "Black", 10, "Female", "10º"), ("E2E Jacket 3", "White", 20, "Female", "10º"),
               ("E2E Jacket 4", "White", 30, "Female", "10º"), ("E2E Jacket 5", "White", 10, "Female", "30º"), ("E2E Jacket 6", "Black", 10, "Female", "30º"), ("E2E Jacket 7", "White", 20, "Male", "10º")]
    ids = {}
    for name, color, size, gender, temp in example:
        ids[name] = admin("POST", "/api/products", {"name": name, "price": 80, "stock": 5, "attributes": {"color": color, "size": size, "gender": gender, "temperature": temp}})["id"]
    admin("POST", "/api/variant-groups", {"name": "E2E Jacket", "productIds": list(ids.values()), "differentiators": [{"key": "color"}, {"key": "size"}, {"key": "gender"}, {"key": "temperature"}]})
    mug, bowl = product_by_name("Linen Mug"), product_by_name("Breakfast Bowl")
    bundle = admin("POST", "/api/products", {"name": "E2E Breakfast set", "sku": "E2E-SET", "type": "bundle", "bundle": {"components": [{"productId": mug["id"], "qty": 2}, {"productId": bowl["id"], "qty": 1}], "priceMode": "manual"}, "price": 60})
    return ids, bundle, mug, bowl

def main():
    ids, bundle, mug, bowl = setup()
    problems = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        def on_console(m):
            if m.type != "error": return
            url = (m.location or {}).get("url", "")
            # Expected offline: web fonts. Everything else (CSP violations included) is a failure.
            if "Failed to load resource" in m.text and re.search(r"fonts\.(googleapis|gstatic)\.com", url): return
            problems.append(f"console: {m.text} ({url})")
        def watch(page):
            page.on("console", on_console)
            page.on("pageerror", lambda e: problems.append(f"page error: {e}"))
            return page

        # ---------------------------------------------------------------- storefront, with JavaScript
        page = watch(browser.new_page())
        page.goto(f"{BASE}/shop")
        form = page.locator("form[data-os-filters]")
        expect(form).to_be_visible()
        expect(form.locator(".os-apply")).to_be_hidden()  # the script applies filters as they change
        expect(page.locator(".os-pager")).to_be_visible()
        total = int(re.search(r"\d+", page.locator("[data-os-count]").inner_text()).group())
        form.locator("label.os-fo", has_text="Sand").locator("input").check()
        page.wait_for_url(re.compile(r"f\.colour=sand"))
        expect(page.locator("[data-os-count]")).to_have_text("2 products")
        expect(page.locator(".os-chip", has_text="Sand")).to_be_visible()
        page.locator(".os-chip", has_text="Sand").click()
        expect(page.locator("[data-os-count]")).to_have_text(f"{total} products")
        print("ok  filters apply on change; counts, chips and paging")

        page.select_option("form[data-os-sort] select", "price")
        page.wait_for_url(re.compile(r"sort=price"))
        page.wait_for_function("() => !document.querySelector('[data-os-search] .os-pg') || document.querySelector('[data-os-search]').className.includes('os-pgw')")
        time.sleep(0.5)
        anon = page.locator("[data-os-results] .os-pc-n").all_inner_texts()
        api_anon = page.evaluate("async () => (await (await fetch('/api/shop/search?sort=price')).json()).items.map(i => i.name)")
        assert anon == api_anon, (anon, api_anon)
        page.screenshot(path=f"{SHOTS}/cat-1-sorted.png", full_page=True)
        print("ok  price sorting: the order comes from the visitor's own prices (JSON), the page itself is the same for everyone")

        page.goto(f"{BASE}/search?q=stonewre")
        expect(page.locator(".os-corrected")).to_contain_text("Showing results for stoneware")
        print("ok  typo tolerance: 'stonewre' finds stoneware and says so")

        # Suggestions while typing: a combobox; arrows and Enter open a suggestion.
        page.goto(f"{BASE}/shop")
        box = page.locator("form.os-search input[name=q]").first
        box.click(); box.type("linen", delay=50)
        sug = page.locator(".os-sug").first
        expect(sug).to_be_visible()
        expect(sug.locator(".os-sug-o").first).to_contain_text("Linen Mug")
        assert box.get_attribute("aria-expanded") == "true"
        box.press("ArrowDown"); box.press("Enter")
        page.wait_for_url(re.compile(r"/shop/product/"))
        expect(page.locator("h1")).to_contain_text("Linen Mug")
        page.goto(f"{BASE}/search?q=e2eteapotnothing")
        print("ok  suggestions while typing (keyboard), and a search with no results")

        # The owner's variant example: one change at a time.
        page.goto(f"{BASE}/shop/product/{ids['E2E Jacket 1']}")
        size = page.locator(".os-var", has_text="Size")
        expect(size.locator(".os-vb.is-selected")).to_have_text("10")
        expect(page.locator(".os-var", has_text="Gender").locator(".os-vb.is-disabled")).to_contain_text("Male")
        size.locator("a.os-vb", has_text="20").click()
        page.wait_for_url(re.compile(ids["E2E Jacket 3"]))
        page.locator(".os-var", has_text="Gender").locator("a.os-vb", has_text="Male").click()
        page.wait_for_url(re.compile(ids["E2E Jacket 7"]))
        expect(page.locator(".os-var", has_text="Size").locator(".os-vb.is-disabled")).to_have_count(2)
        page.screenshot(path=f"{SHOTS}/cat-2-variants.png", full_page=True)
        print("ok  variants: Product 1 → Size 20 (Product 3) → Male (Product 7); unavailable choices disabled")

        # Bundle: contents, savings, purchase takes the components from stock.
        mug_before = admin("GET", f"/api/products/{mug['id']}")["stock"]
        page.goto(f"{BASE}/shop/product/{bundle['id']}")
        expect(page.locator(".os-bc")).to_contain_text("2 ×")
        expect(page.locator(".os-bc-save")).to_contain_text("Save")
        page.locator("form.os-atc button").click()
        page.wait_for_url(re.compile(r"/shop/cart"))
        expect(page.locator("table.os-cart")).to_contain_text("Includes: 2 × Linen Mug, 1 × Breakfast Bowl")
        page.fill("input[name=name]", "E2E Buyer"); page.fill("input[name=email]", "e2e.bundle@example.com"); page.fill("textarea[name=address]", "1 Road")
        page.locator("form[action='/shop/checkout'] button").click()
        page.wait_for_url(re.compile(r"/shop/order/"))
        expect(page.locator("table")).to_contain_text("Includes: 2 × Linen Mug, 1 × Breakfast Bowl")
        assert admin("GET", f"/api/products/{mug['id']}")["stock"] == mug_before - 2
        mug_page = f"{BASE}/shop/product/{mug['id']}"
        page.goto(mug_page)
        expect(page.locator(".os-inb")).to_contain_text("E2E Breakfast set")
        print("ok  bundle: contents and savings, cart and confirmation list what's inside, component stock taken, shown on the mug's page")

        # A VIP (client price on bowls) sees their own order when sorting by price.
        page.goto(f"{BASE}/shop/account")
        page.fill("input[name=email]", "priya.nair@example.com"); page.fill("input[name=password]", DEMO_PASSWORD)
        page.locator("form[action='/shop/account/login'] button").click()
        expect(page.locator("h1")).to_contain_text("Hello")
        page.goto(f"{BASE}/shop?sort=price")
        time.sleep(1)
        mine = page.locator("[data-os-results] .os-pc-n").all_inner_texts()
        api_mine = page.evaluate("async () => (await (await fetch('/api/shop/search?sort=price')).json()).items.map(i => i.name)")
        assert mine == api_mine, (mine, api_mine)
        print(f"ok  signed-in VIP: price order from their own prices ({'differs from' if mine != anon else 'same as'} the anonymous order)")
        page.close()

        # ---------------------------------------------------------------- storefront without JavaScript
        ctx = browser.new_context(java_script_enabled=False)
        nojs = watch(ctx.new_page())
        nojs.goto(f"{BASE}/shop/category/bowls")
        apply = nojs.locator("form[data-os-filters] .os-apply")
        expect(apply).to_be_visible()
        nojs.locator("form[data-os-filters] label.os-fo", has_text="Sand").locator("input").check()
        apply.click()
        nojs.wait_for_url(re.compile(r"f\.colour=sand"))
        expect(nojs.locator(".os-pc-n")).to_have_text(["Ramen Bowl"])
        nojs.goto(f"{BASE}/shop?sort=price")
        expect(nojs.locator("noscript")).to_have_count(1)
        print("ok  without JavaScript: GET forms with Apply, sorting by list price")
        ctx.close()

        # ---------------------------------------------------------------- backoffice
        bo = watch(browser.new_page())
        bo.goto(f"{BO}/login")
        bo.fill("input[name=email]", ENV["ADMIN_EMAIL"]); bo.fill("input[name=password]", ENV["ADMIN_PASSWORD"])
        bo.click("button:has-text('Sign in')")
        bo.wait_for_url(re.compile(r"/products"))
        bo.fill("input[aria-label='Search products']", "jacket")
        expect(bo.locator("tbody tr")).to_have_count(7)
        bo.fill("input[aria-label='Search products']", "")
        bo.locator(".facets label", has_text="Bundles").locator("input").check()
        expect(bo.locator("tbody tr")).to_have_count(1)
        expect(bo.locator("tbody tr")).to_contain_text("limited by")
        bo.locator(".facets label", has_text="Bundles").locator("input").uncheck()
        bo.screenshot(path=f"{SHOTS}/cat-3-products.png", full_page=True)
        print("ok  backoffice: server search and filters with counts")

        bo.goto(f"{BO}/insights")
        expect(bo.locator(".misses")).to_contain_text("e2eteapotnothing")
        expect(bo.locator(".misses")).to_contain_text("still nothing")
        print("ok  insights: the search with no results is reported")

        # Import: upload -> columns -> preview -> apply.
        bo.goto(f"{BO}/products/import")
        csv = "sku;name;price;stock;attr:Colour;attr:Material\nE2E-NEW-1;E2E Import Cup;12,50;4;Sand;Stoneware\nE2E-NEW-2;E2E Import Jug;30;2;Ink blue;Porcelain\nE2E-SET;E2E Breakfast set;61;;;\nBAD;E2E Bad;12.5O;1;;\n"
        bo.set_input_files("input[type=file]", files=[{"name": "e2e.csv", "mimeType": "text/csv", "buffer": csv.encode()}])
        expect(bo.locator(".sec-row")).to_contain_text("e2e.csv · 4 products")
        expect(bo.locator("select[aria-label='Column attr:Material']")).to_have_value("new:Material")
        bo.click("button:has-text('Preview')")
        expect(bo.locator(".kpis")).to_contain_text("New2")
        expect(bo.locator(".newprops")).to_contain_text("Material")
        expect(bo.locator("input[aria-label='Public in the shop: Material']")).not_to_be_checked()
        bo.click("button[role=tab]:has-text('Problems')")
        expect(bo.locator(".rows")).to_contain_text("must be a price like 12,50")
        bo.click("button[role=tab]:has-text('Changed')")
        expect(bo.locator(".rows")).to_contain_text("price 60 → 61")
        bo.screenshot(path=f"{SHOTS}/cat-4-import-preview.png", full_page=True)
        bo.click("button:has-text('Apply import')")
        expect(bo.locator("h3")).to_contain_text("Import finished", timeout=20000)
        expect(bo.locator(".kpis")).to_contain_text("Created2")
        print("ok  import: columns recognised (semicolons, decimal comma, new properties), preview, problems, apply")

        # Lifecycle: hide, delete with a decision for the bundle, restore from "Deleted products".
        bo.goto(f"{BO}/products?q=Breakfast%20Bowl")
        row = bo.locator("tbody tr", has_text="Breakfast Bowl").first
        row.locator("button:has-text('Hide')").click()
        expect(row).to_contain_text("Hidden")
        row.locator("a:has-text('Delete')").click()
        expect(bo.locator("h1")).to_contain_text("Delete Breakfast Bowl?")
        expect(bo.locator("[role=alert]")).to_contain_text("Choose what happens to each bundle")
        expect(bo.locator("button:has-text('Delete product')")).to_be_disabled()
        bo.locator("fieldset.decide", has_text="E2E Breakfast set").locator("label", has_text="Keep selling").locator("input").check()
        bo.click("button:has-text('Delete product')")
        bo.wait_for_url(re.compile(r"/products"))
        bo.click("button:has-text('Deleted products')")
        expect(bo.locator("h1")).to_have_text("Deleted products")
        bo.locator("tbody tr", has_text="Breakfast Bowl").locator("button:has-text('Restore')").click()
        expect(bo.locator("[role=status]")).to_contain_text("was restored")
        print("ok  lifecycle: hide, delete after deciding for its bundle, restore from Deleted products")

        # Link as variants from a selection.
        bo.goto(f"{BO}/products?q=E2E%20Import")
        for r in bo.locator("tbody tr").all(): r.locator("td.w-chk input").check()
        bo.click("button:has-text('Link as variants')")
        expect(bo.locator(".drawer h2")).to_have_text("Link as variants")
        expect(bo.locator("label.prop", has_text="Colour").locator("input")).to_be_checked()
        expect(bo.locator(".vpreview")).to_be_visible()
        # Material came from the import, so it is internal: it can't tell variants apart unless made public.
        expect(bo.locator(".warn-box", has_text="Make Material public")).to_be_visible()
        expect(bo.locator(".drawer-f button", has_text="Link 2 products")).to_be_disabled()
        bo.locator("label.prop", has_text="Material").locator("input").uncheck()
        expect(bo.locator(".drawer-f button", has_text="Link 2 products")).to_be_enabled()
        bo.fill("input[name=gname]", "E2E Import set")
        bo.locator(".drawer-f button", has_text="Link 2 products").click()
        expect(bo.locator("[role=status]")).to_contain_text("Linked as variants: E2E Import set")
        print("ok  link as variants: properties that differ are ticked, the shop is previewed")
        bo.close()
        browser.close()

    if problems:
        print("FAILED:", *problems, sep="\n  ")
        sys.exit(1)
    print("PASSED: no console errors, no CSP violations")

if __name__ == "__main__": main()

#!/usr/bin/env python3
"""Browser test of the backoffice Discounts screens, against a seeded demo shop served by `ng serve`.

    BO=http://localhost:4300 python3 scripts/e2e-backoffice.py

Reads the login from .env.demo. It CREATES OFFERS and CODES and changes settings, so use a throw-away instance.
"""
import os, re, sys
from playwright.sync_api import sync_playwright, expect

BO = os.environ.get("BO", "http://localhost:4300")
SHOTS = os.environ.get("SHOTS", "/tmp/e2e-shots")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.makedirs(SHOTS, exist_ok=True)
ENV = dict(l.strip().split("=", 1) for l in open(os.path.join(ROOT, ".env.demo")) if "=" in l and not l.startswith("#"))

def main():
    problems = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 1000}, accept_downloads=True)
        def on_console(m):
            if m.type != "error": return
            url = (m.location or {}).get("url", "")
            if re.search(r"fonts\.(googleapis|gstatic)\.com", url) or "fonts.googleapis" in m.text: return
            if "status of 409" in m.text and url.endswith("/codes"): return  # the deliberate duplicate-code attempt
            problems.append(f"console: {m.text} ({url})")
        page.on("console", on_console)
        page.on("pageerror", lambda e: problems.append(f"page error: {e}"))

        page.goto(f"{BO}/login")
        page.fill("input[name=email]", ENV["ADMIN_EMAIL"])
        page.fill("input[name=password]", ENV["ADMIN_PASSWORD"])
        page.click("button:has-text('Sign in')")
        page.wait_for_url(re.compile(r"/products$"))

        # 1. List: the seeded offers with states, tabs and filters
        page.click("nav >> text=Discounts")
        rows = page.locator("table.tbl tbody tr")
        expect(rows).to_have_count(12)
        expect(page.locator("tr", has_text="Spring preview").locator(".pill")).to_have_text("Scheduled")
        expect(page.locator("tr", has_text="Winter sale – mugs").locator(".pill")).to_have_text("Running")
        expect(page.locator("tr", has_text="Bud Vase clearance")).to_contain_text("€19.00 each")
        expect(page.locator("tr", has_text="Creator codes")).to_contain_text("40 codes")
        expect(page.locator("tr", has_text="Priya – bowls").locator(".tag")).to_have_text("Client")
        expect(page.locator("tr", has_text="Trade – 30% off everything").locator(".tag")).to_have_text("Profile")
        page.screenshot(path=f"{SHOTS}/bo-1-list.png", full_page=True)
        page.click("button[role=tab]:has-text('Vouchers')")
        expect(rows).to_have_count(4)
        page.click("button[role=tab]:has-text('All offers')")
        print("ok  list shows offers, states, effects, codes; tabs filter")

        # 2. Pause / resume from the list
        row = page.locator("tr", has_text="Big order bonus")
        row.locator("button:has-text('Pause')").click()
        expect(row.locator(".pill")).to_have_text("Paused")
        row.locator("button:has-text('Resume')").click()
        expect(row.locator(".pill")).to_have_text("Running")
        print("ok  pause and resume")

        # 3. Create a product offer with the editor (live preview, validation, shop time)
        page.click("a:has-text('+ New offer')")
        expect(page.locator("h1")).to_have_text("New offer")
        page.click("button.preset:has-text('Product price')")
        page.click("button:has-text('Create offer')")
        expect(page.locator(".save-bar .err")).to_have_text("Please fix the highlighted fields.")
        expect(page.locator(".ferr").first).to_be_visible()
        page.fill("input[name=name]", "E2E – Ramen bowl deal")
        page.fill("input[name=label]", "Ramen week")
        # The product picker searches the catalogue on the server (any catalogue size).
        page.fill(".picker app-product-picker input", "ramen")
        page.locator(".pick-row", has_text="Ramen Bowl").locator("input").check()
        page.click("button:has-text('Amount off')")
        page.fill("input[name=amt]", "7")
        expect(page.locator(".ed-side")).to_contain_text("Ramen Bowl")
        expect(page.locator(".ed-side tbody tr").first).to_contain_text("€35.00")
        expect(page.locator(".hint-top").first).to_contain_text("Lisbon")
        page.select_option("select[name=endMode]", "day")
        page.fill("input[name=endDay]", "2099-12-31")
        page.screenshot(path=f"{SHOTS}/bo-2-editor.png", full_page=True)
        page.click("button:has-text('Create offer')")
        page.wait_for_url(re.compile(r"/discounts/[0-9a-f-]{36}$"))
        expect(page.locator(".page-h .pill")).to_have_text("Running")
        expect(page.locator("select[name=endMode]")).to_have_value("day")
        expect(page.locator("input[name=endDay]")).to_have_value("2099-12-31")
        print("ok  editor: validation, preview with the pricing engine, shop-time dates, create")

        # 4. Edit and save (version), then history
        page.fill("input[name=amt]", "8")
        page.click("button:has-text('Save changes')")
        expect(page.locator(".ok-msg")).to_have_text("Saved.")
        expect(page.locator("section", has_text="History")).to_contain_text("update")
        print("ok  edit and save, history recorded")

        # 5. Voucher: create, add a code, generate codes, download CSV (Accept: text/csv on the same URL)
        page.goto(f"{BO}/discounts/new")
        page.click("button.preset:has-text('Voucher')")
        page.fill("input[name=name]", "E2E – Newsletter voucher")
        page.fill("input[name=label]", "Newsletter")
        page.fill("input[name=pct]", "15")
        page.click("button:has-text('Create offer')")
        page.wait_for_url(re.compile(r"/discounts/[0-9a-f-]{36}$"))
        page.fill("input[name=code]", "news15")
        page.click("form:has(input[name=code]) button:has-text('Add')")
        expect(page.locator("td.mono", has_text="NEWS15")).to_be_visible()
        page.fill("input[name=code]", "WELCOME10")
        page.click("form:has(input[name=code]) button:has-text('Add')")
        expect(page.locator(".err[role=alert]")).to_contain_text("already")
        page.fill("input[name=gen]", "5")
        page.fill("input[name=prefix]", "news")
        page.click("button:has-text('Generate single-use codes')")
        expect(page.locator("td.mono", has_text=re.compile(r"^NEWS-"))).to_have_count(5)
        with page.expect_download() as dl:
            page.click("section:has(h3:has-text('Codes')) button:has-text('Download CSV')")
        path = dl.value.path()
        csv = open(path, encoding="utf-8-sig", newline="").read().strip().split("\r\n")
        assert csv[0] == "code,kind,used,customer,created", csv[0]
        assert len(csv) == 7, len(csv)
        assert dl.value.suggested_filename == "codes-E2E – Newsletter voucher.csv" or dl.value.suggested_filename.startswith("codes-"), dl.value.suggested_filename
        page.screenshot(path=f"{SHOTS}/bo-3-voucher.png", full_page=True)
        print("ok  voucher codes: add, duplicate refused, generate, CSV download")

        # 6. Simulator: cart + moment in the future (scheduled offer) + explanations
        page.goto(f"{BO}/discounts/simulate")
        # Items are added with the product search: replace the suggested first item with the Linen Mug.
        page.locator(".sim-row button[aria-label^='Remove']").first.click()
        page.fill("app-product-picker input", "linen mug")
        page.locator(".pick-row", has_text="Linen Mug").first.click()
        expect(page.locator(".sim-row")).to_contain_text("Linen Mug")
        page.fill("input[name=at]", "2099-06-15T12:00")
        page.click("button:has-text('Simulate')")
        expect(page.locator(".ed-side")).to_contain_text("Every offer")
        expect(page.locator("tr", has_text="Spring preview")).to_contain_text("Ended")
        expect(page.locator("tr", has_text="Winter sale – mugs")).to_contain_text("Ended")
        page.fill("input[name=at]", "")
        page.fill("input[name=code]", "WELCOME10")
        page.click("button:has-text('Simulate')")
        expect(page.locator("tr", has_text="Welcome – first order")).to_contain_text("Minimum order value not reached")
        expect(page.locator("tr", has_text="Winter sale – mugs")).to_contain_text("Applied")
        page.screenshot(path=f"{SHOTS}/bo-4-simulator.png", full_page=True)
        print("ok  simulator explains every offer at any moment")

        # 7. Settings: time zone impact preview + display toggles
        page.goto(f"{BO}/settings")
        expect(page.locator("section", has_text="Shop time zone")).to_contain_text("Europe/Lisbon")
        page.fill("input[name=tz]", "America/New_York")
        page.click("button:has-text('Review change')")
        expect(page.locator(".impact")).to_contain_text("move")
        page.screenshot(path=f"{SHOTS}/bo-5-settings.png", full_page=True)
        page.click("button:has-text('Cancel')")
        page.locator("label.sw", has_text="Show a % badge").click()
        page.wait_for_timeout(400)
        page.reload()
        expect(page.locator("label.sw", has_text="Show a % badge").locator("input")).not_to_be_checked()
        page.locator("label.sw", has_text="Show a % badge").click()
        page.wait_for_timeout(400)
        print("ok  settings: time zone impact preview, display toggles persist")

        # 8. Orders: discount column
        page.goto(f"{BO}/orders")
        expect(page.locator("th", has_text="Discounts")).to_be_visible()
        print("ok  orders list has the discounts column")

        # 9. Customers: create, activation link, profile membership, personal code
        page.goto(f"{BO}/customers")
        page.click("button:has-text('+ New customer')")
        page.fill("input[name=email]", "new.trader@example.com")
        page.fill("input[name=name]", "New Trader")
        page.click("button:has-text('Create customer')")
        page.wait_for_url(re.compile(r"/customers/[0-9a-f-]{36}$"))
        expect(page.locator("h1")).to_have_text("New Trader")
        expect(page.locator("section", has_text="Account").first).to_contain_text("No account")
        page.click("button:has-text('Create activation link')")
        link = page.locator(".linkbox input").input_value()
        assert re.search(r"/shop/account/activate/[A-Za-z0-9_-]{43}$", link), link
        page.select_option("select[name=prof]", label="Trade buyers")
        page.click("form:has(select[name=prof]) button:has-text('Add')")
        expect(page.locator("section", has_text="Profiles").first).to_contain_text("Trade buyers")
        page.select_option("select[name=voucher]", label="Welcome back")
        page.fill("input[name=prefix]", "trade")
        page.click("button:has-text('Give a personal code')")
        expect(page.locator("td.mono", has_text=re.compile(r"^TRADE-"))).to_be_visible()
        page.screenshot(path=f"{SHOTS}/bo-7-customer.png", full_page=True)
        print("ok  customers: create, one-time activation link, add to profile, personal code")

        # 10. Client price from the customer page (audience preset, sign-in locked)
        page.click("a:has-text('+ New client price')")
        expect(page.locator("button.preset.on")).to_contain_text("Client price")
        expect(page.locator(".chip")).to_contain_text("New Trader")
        expect(page.locator("input[name=signin]")).to_be_disabled()
        page.fill("input[name=name]", "E2E – New Trader 15%")
        page.fill("input[name=label]", "Your price")
        page.fill("input[name=pct]", "15")
        page.click("button:has-text('Create offer')")
        page.wait_for_url(re.compile(r"/discounts/[0-9a-f-]{36}$"))
        expect(page.locator(".tag, .preset.on").first).to_be_visible()
        print("ok  client price created for a chosen customer")

        # 11. Profiles: live edit, affected members
        page.goto(f"{BO}/discounts/profiles")
        expect(page.locator("tr", has_text="Trade buyers")).to_contain_text("3")
        page.click("a:has-text('Trade buyers')")
        page.fill("input[name=label]", "Trade partner price")
        page.click("button:has-text('Save changes')")
        expect(page.locator(".ok-msg")).to_have_text("Saved. This applies to 3 customers now.")
        expect(page.locator("section", has_text="Offers for this profile")).to_contain_text("Trade – Linen Mug")
        page.screenshot(path=f"{SHOTS}/bo-8-profile.png", full_page=True)
        print("ok  profile: live edit tells how many customers it affects; rules and members listed")

        # 12. Insights: KPIs, charts, the influencer choice breakdown, CSV
        page.goto(f"{BO}/insights")
        expect(page.locator(".kpi", has_text="Revenue")).to_be_visible()
        expect(page.locator("svg.chart rect.bar").first).to_be_visible()
        stack = page.locator(".stack", has_text="MARTA10")
        expect(stack).to_be_visible()
        expect(page.locator(".insight-list")).to_contain_text(re.compile(r"picked MARTA10 although the automatic offers were cheaper"))
        with page.expect_download() as dl:
            page.click("section:has(h3:has-text('what shoppers chose')) button:has-text('Download CSV')")
        rows_csv = open(dl.value.path(), encoding="utf-8-sig", newline="").read().strip().split("\r\n")
        assert rows_csv[0].startswith("code,offer,campaign,shown,ordered"), rows_csv[0]
        assert rows_csv[1].startswith("MARTA10,"), rows_csv[1]
        page.click("button:has-text('Last 7 days')")
        expect(page.locator(".kpi", has_text="Orders").first).to_be_visible()
        page.screenshot(path=f"{SHOTS}/bo-9-insights.png", full_page=True)
        print("ok  insights: KPIs, charts, code choice breakdown with CSV, period switch")

        # 13. Builder: the Offers widget is in the palette
        page.goto(f"{BO}/pages")
        page.locator(".pcard", has_text="Product page").locator("a, button", has_text=re.compile("Design|Edit|Open")).first.click()
        expect(page.locator("button.tile", has_text="Offers")).to_be_visible(timeout=15000)
        page.screenshot(path=f"{SHOTS}/bo-6-builder.png")
        print("ok  builder palette has the Offers widget")
        # Regression: switches and typed slider values used to be undone by a bubbling native change event.
        page.click("nav.ptabs button:has-text('Layers')")
        page.locator(".lyr").nth(2).click()
        page.click(".tabs2 button:has-text('Style')")
        page.locator(".hides label.sw").nth(2).click()
        expect(page.locator(".lyr").nth(2)).to_contain_text("hidden")
        below = page.locator(".ctl", has=page.locator(".ctl-h span", has_text=re.compile("^Space below$"))).first.locator("input[type=number]")
        below.fill("30"); below.press("Tab")
        page.locator(".lyr").nth(3).click(); page.locator(".lyr").nth(2).click(); page.click(".tabs2 button:has-text('Style')")
        expect(page.locator(".ctl", has=page.locator(".ctl-h span", has_text=re.compile("^Space below$"))).first.locator("input[type=number]")).to_have_value("30")
        print("ok  builder: switches toggle once and typed values stay after leaving the field")
        browser.close()

    if problems:
        print("\n".join(problems)); sys.exit("FAILED: console errors")
    print("PASSED: no console errors")

if __name__ == "__main__": main()

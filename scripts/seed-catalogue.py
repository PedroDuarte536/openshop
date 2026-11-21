#!/usr/bin/env python3
"""Adds the catalogue demo on top of seed-demo.py: SKUs, properties, variant groups (including the owner's example),
bundles, and images in the server import folder. Safe to re-run (existing items are kept).

    python3 scripts/seed-demo.py && python3 scripts/seed-catalogue.py      # reads .env.demo like seed-demo.py

Needs Pillow for the generated pictures. IMPORT_MEDIA_DIR (from .env.demo, default ./demo-data/import-media) gets the
sample images that docs/test-guide/*.csv refer to.
"""
import io, json, os, re, sys, urllib.error, urllib.parse, urllib.request
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = dict(l.strip().split("=", 1) for l in open(os.path.join(ROOT, ".env.demo")) if "=" in l and not l.startswith("#"))
API = os.environ.get("API", f"http://localhost:{ENV.get('PORT', '3000')}")
MEDIA = os.path.normpath(os.path.join(ROOT, ENV.get("IMPORT_MEDIA_DIR", "./demo-data/import-media")))

def call(method, path, body=None, raw=None, ctype="application/json", ok=(200, 201, 204)):
    if not hasattr(call, "token"):
        r = urllib.request.Request(API + "/api/auth/login", data=json.dumps({"email": ENV["ADMIN_EMAIL"], "password": ENV["ADMIN_PASSWORD"]}).encode(), headers={"content-type": "application/json"}, method="POST")
        call.token = json.loads(urllib.request.urlopen(r).read())["token"]
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(API + path, data=data, method=method, headers={"authorization": f"Bearer {call.token}", **({"content-type": ctype} if data is not None else {})})
    try:
        with urllib.request.urlopen(req) as r: b = r.read(); return json.loads(b) if b else None
    except urllib.error.HTTPError as e:
        if e.code in ok: return None
        sys.exit(f"{method} {path} failed: {e.code} {e.read().decode()[:300]}")

def products():
    out, skip = [], 0
    while True:
        page = call("GET", f"/api/products?limit=200&skip={skip}&sort=name&facets=false&status=visible,hidden")
        out += page["items"]; skip += 200
        if skip >= page["total"]: return {p["name"]: p for p in out}

def sku(name): return "MD-" + re.sub(r"[^A-Z0-9]+", "-", name.upper()).strip("-")

def png(color, label, size=(640, 800)):
    img = Image.new("RGB", size, color)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([60, 260, size[0] - 60, 540], radius=36, fill=(255, 255, 255))
    d.text((100, 380), label, fill=(20, 26, 51))
    buf = io.BytesIO(); img.save(buf, "PNG"); return buf.getvalue()

GLAZES = {  # option label -> swatch
    "Sage": "#9caf88", "Sand": "#d8c3a5", "Oat": "#e7dcc8", "Ink blue": "#1f3b73", "Terracotta": "#c0643c",
    "Speckled white": "#f4f1ea", "Charcoal": "#36383d", "Rose clay": "#d49a8c", "Mustard": "#d4a72c", "Moss": "#6b7f4e",
}
PROPS = [
    {"key": "colour", "label": "Colour", "type": "choice", "options": [{"label": l, "swatch": s} for l, s in GLAZES.items()]},
    {"key": "material", "label": "Material", "type": "text", "filterable": False},
    {"key": "capacity", "label": "Capacity", "type": "number", "unit": "ml", "filterable": True},
    {"key": "dishwasher_safe", "label": "Dishwasher safe", "type": "boolean"},
    {"key": "supplier", "label": "Supplier", "type": "text", "visibility": "internal"},
    # the owner's variant example
    {"key": "color", "label": "Colors", "type": "text", "filterable": False, "showOnProduct": True},
    {"key": "size", "label": "Size", "type": "number", "filterable": False},
    {"key": "gender", "label": "Gender", "type": "choice", "options": [{"label": "Female"}, {"label": "Male"}], "filterable": False},
    {"key": "temperature", "label": "Temperature", "type": "text", "filterable": False},
]
# name -> (colour, capacity ml or None, dishwasher safe)
DETAILS = {
    "Linen Mug": ("Sage", 350, True), "Dune Espresso Cup": ("Sand", 90, True), "Tall Latte Mug": ("Oat", 420, False), "Night Market Mug": ("Ink blue", 350, False),
    "Terracotta Tumbler": ("Terracotta", 300, True), "Speckle Mug": ("Speckled white", 350, False), "Stoneware Bowl": ("Oat", None, True), "Ramen Bowl": ("Ink blue", 900, False),
    "Breakfast Bowl": ("Sage", 600, True), "Large Salad Bowl": ("Sand", None, False), "Dipping Bowl": ("Terracotta", None, False), "Dinner Plate": ("Oat", None, True),
    "Side Plate": ("Sage", None, False), "Serving Platter": ("Sand", None, False), "Pasta Plate": ("Charcoal", None, False), "Bud Vase": ("Rose clay", None, False),
    "Tall Cylinder Vase": ("Charcoal", None, False), "Moon Vase": ("Mustard", None, False), "Planter with Saucer": ("Terracotta", None, False), "Small Pot": ("Moss", None, False),
    "Candle Holder": ("Mustard", None, False), "Salt Cellar": ("Speckled white", None, False), "Trinket Dish": ("Rose clay", None, False),
}
EXAMPLE = [  # the owner's example: Product 1..7
    ("Example jacket 1", "White", 10, "Female", "10º"), ("Example jacket 2", "Black", 10, "Female", "10º"), ("Example jacket 3", "White", 20, "Female", "10º"),
    ("Example jacket 4", "White", 30, "Female", "10º"), ("Example jacket 5", "White", 10, "Female", "30º"), ("Example jacket 6", "Black", 10, "Female", "30º"),
    ("Example jacket 7", "White", 20, "Male", "10º"),
]

def main():
    have = {a["key"] for a in call("GET", "/api/attributes")}
    for p in PROPS:
        if p["key"] not in have: call("POST", "/api/attributes", {"visibility": "public", **p}); print(f"  + property {p['label']}")
    cats = {c["slug"]: c for c in call("GET", "/api/categories")}
    if "jackets-example" not in cats: cats["jackets-example"] = call("POST", "/api/categories", {"name": "Jackets (variant example)", "slug": "jackets-example"})
    by = products()

    # SKUs and properties on the demo products
    for name, (colour, ml, dish) in DETAILS.items():
        p = by.get(name)
        if not p or p.get("sku"): continue
        attrs = {"colour": colour, "material": "Terracotta" if colour == "Terracotta" else "Stoneware", "dishwasher_safe": dish, "supplier": "Olaria do Tejo" if len(name) % 2 else "Kiln & Co"}
        if ml: attrs["capacity"] = ml
        call("PATCH", f"/api/products/{p['id']}", {"sku": sku(name), "attributes": attrs})
    for name in ("Set of Two Mugs", "Breakfast Set"):
        p = by.get(name)
        if p and not p.get("sku"): call("PATCH", f"/api/products/{p['id']}", {"sku": sku(name)})
    print("  + SKUs and properties on the demo products")

    # The owner's variant example, with generated pictures
    for name, color, size, gender, temp in EXAMPLE:
        if name in by: continue
        url = call("POST", "/api/uploads", raw=png((236, 236, 232) if color == "White" else (40, 40, 46), f"{name}: {color} / {size} / {gender} / {temp}"), ctype="image/png")["url"]
        by[name] = call("POST", "/api/products", {"name": name, "sku": sku(name), "price": 89, "stock": 6, "categoryId": cats["jackets-example"]["id"], "images": [url],
            "description": "Part of the variant example: each value links to the product that differs only in that property.", "attributes": {"color": color, "size": size, "gender": gender, "temperature": temp}})
    groups = {g["id"] for g in call("GET", "/api/variant-groups")}
    if "example-jacket" not in groups:
        call("POST", "/api/variant-groups", {"id": "example-jacket", "name": "Example jacket", "productIds": [by[n]["id"] for n, *_ in EXAMPLE], "differentiators": [{"key": "color"}, {"key": "size"}, {"key": "gender"}, {"key": "temperature"}]})
        print("  + variant group: Example jacket (the owner's example, 7 products)")
    if "everyday-mug" not in groups:
        call("POST", "/api/variant-groups", {"id": "everyday-mug", "name": "Everyday mug", "productIds": [by[n]["id"] for n in ("Linen Mug", "Night Market Mug", "Speckle Mug")], "differentiators": [{"key": "colour"}]})
        print("  + variant group: Everyday mug (by colour, with swatches)")

    # Bundles
    bundles = [
        ("Breakfast for Two", {"components": [("Linen Mug", 2), ("Breakfast Bowl", 2), ("Side Plate", 2)], "priceMode": "sum", "offerScope": "targeted"}, None),
        ("Morning Ritual Box", {"components": [("Tall Latte Mug", 1), ("Dipping Bowl", 1), ("Salt Cellar", 1)], "priceMode": "manual", "offerScope": "targeted"}, 49),
        ("Flower Corner", {"components": [("Bud Vase", 2), ("Small Pot", 1)], "priceMode": "sum", "offerScope": "all"}, None),
    ]
    for name, spec, price in bundles:
        if name in by: continue
        body = {"name": name, "sku": sku(name), "type": "bundle", "categoryId": cats["gifts"]["id"], "description": "A bundle: its stock comes from the products inside.",
                "bundle": {**spec, "components": [{"productId": by[n]["id"], "qty": q} for n, q in spec["components"]]}, **({"price": price} if price else {})}
        call("POST", "/api/products", body); print(f"  + bundle: {name}")

    # Images in the server import folder (IMPORT_MEDIA_DIR) used by docs/test-guide/01-new-and-updates.csv
    os.makedirs(os.path.join(MEDIA, "mugs"), exist_ok=True)
    for path, color, label in [("mugs/sand-mug.png", (216, 195, 165), "Sand mug (server folder)"), ("mugs/moss-mug.png", (107, 127, 78), "Moss mug (server folder)"), ("bowl.png", (31, 59, 115), "Ink bowl (server folder)")]:
        with open(os.path.join(MEDIA, path), "wb") as f: f.write(png(color, label))
    with open(os.path.join(MEDIA, "fake.png"), "w") as f: f.write("<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>")
    print(f"  + sample images in {MEDIA}")
    print("Done.")

if __name__ == "__main__": main()

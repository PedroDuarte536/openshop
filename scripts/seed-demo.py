#!/usr/bin/env python3
"""Seeds a realistic demo shop (Maison Dune, hand-made ceramics) through the public admin API.

Draws a product image for every item (needs Pillow: pip install pillow), uploads it, and creates
categories and products. Safe to re-run: existing categories/products (matched by slug/name) are skipped.

    python3 scripts/seed-demo.py            # reads ADMIN_EMAIL / ADMIN_PASSWORD from .env.demo
    API=http://localhost:3000 python3 scripts/seed-demo.py
"""
import io, json, math, os, random, sys, urllib.request
from PIL import Image, ImageChops, ImageDraw, ImageFilter

API = os.environ.get("API", "http://localhost:3000")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
W, H, OUT_W, OUT_H = 1600, 2000, 800, 1000
BASE_Y = 1520

# ---------- drawing ----------
def hexrgb(h): h = h.lstrip("#"); return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
def mul(c, k): return tuple(max(0, min(255, int(v * k))) for v in c)
def mix(a, b, t): return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def vgrad(size, top, bottom):
    m = Image.linear_gradient("L").resize(size)
    return Image.composite(Image.new("RGB", size, bottom), Image.new("RGB", size, top), m)

def cyl(size, base, light=0.36):
    """Horizontal shading that reads as a rounded glazed surface."""
    w, h = size
    row = Image.new("RGB", (w, 1))
    for x in range(w):
        t = x / max(w - 1, 1)
        i = 0.60 + 0.52 * math.exp(-(((t - light) / 0.30) ** 2)) - 0.10 * max(0, t - 0.8) * 5
        row.putpixel((x, 0), mul(base, i))
    img = row.resize((w, h))
    fall = vgrad((w, h), (255, 255, 255), (214, 214, 214))
    return ImageChops.multiply(img, fall)

def paint(cv, mask, base, speckle=False, light=0.36):
    bb = mask.getbbox()
    if not bb: return
    sub = mask.crop(bb)
    tex = cyl(sub.size, base, light)
    if speckle:
        rnd = random.Random(bb[0] * 7 + bb[1])
        d = ImageDraw.Draw(tex)
        for _ in range(sub.size[0] * sub.size[1] // 2600):
            x, y, r = rnd.randrange(sub.size[0]), rnd.randrange(sub.size[1]), rnd.choice((2, 3, 4, 5))
            d.ellipse((x - r, y - r, x + r, y + r), fill=mul(base, rnd.choice((0.45, 0.55, 0.65))))
    cv.paste(tex, bb[:2], sub)

def shape(draw_fn):
    m = Image.new("L", (W, H), 0)
    draw_fn(ImageDraw.Draw(m))
    return m

def shadow(cv, cx, y, width, strength=95):
    s = Image.new("L", (W, H), 0)
    ImageDraw.Draw(s).ellipse((cx - width / 2, y - 34, cx + width / 2, y + 34), fill=strength)
    s = s.filter(ImageFilter.GaussianBlur(34))
    cv.paste(Image.new("RGB", (W, H), (60, 50, 40)), (0, 0), s)

def gloss(cv, x0, y0, x1, y1, a=70, r=10):
    m = Image.new("L", (W, H), 0)
    ImageDraw.Draw(m).rounded_rectangle((x0, y0, x1, y1), r, fill=a)
    cv.paste(Image.new("RGB", (W, H), (255, 255, 255)), (0, 0), m.filter(ImageFilter.GaussianBlur(6)))

def opening(cv, box, base):
    x0, y0, x1, y1 = box
    m = shape(lambda d: d.ellipse(box, fill=255))
    inner = vgrad((x1 - x0, y1 - y0), mul(base, 0.28), mul(base, 0.5))
    cv.paste(inner, (x0, y0), m.crop(box))

def rim(cv, box, base, speckle=False):
    paint(cv, shape(lambda d: d.ellipse(box, fill=255)), mul(base, 1.12), speckle)
    x0, y0, x1, y1 = box; p = (y1 - y0) * 0.16
    opening(cv, (int(x0 + (x1 - x0) * 0.05), int(y0 + p), int(x1 - (x1 - x0) * 0.05), int(y1 - p * 0.4)), base)

def mug(cv, cx, w, h, base, handle=True, speckle=False, tapered=False):
    top, bot = BASE_Y - h, BASE_Y
    shadow(cv, cx, bot, w * 1.25)
    if handle:
        hx = cx + w / 2 - 30
        hm = shape(lambda d: (d.ellipse((hx - 10, top + h * 0.14, hx + w * 0.50, top + h * 0.80), fill=255),
                              d.ellipse((hx + w * 0.10, top + h * 0.25, hx + w * 0.36, top + h * 0.68), fill=0)))
        paint(cv, hm, mul(base, 0.92), speckle)
    inset = w * 0.07 if tapered else 0
    body = shape(lambda d: d.polygon([(cx - w / 2, top), (cx + w / 2, top), (cx + w / 2 - inset, bot - 60), (cx + w / 2 - inset - 40, bot), (cx - w / 2 + inset + 40, bot), (cx - w / 2 + inset, bot - 60)], fill=255) if tapered
                 else d.rounded_rectangle((cx - w / 2, top, cx + w / 2, bot), 70, fill=255))
    paint(cv, body, base, speckle)
    gloss(cv, cx - w / 2 + w * 0.12, top + 70, cx - w / 2 + w * 0.17, bot - 110, 60)
    rim(cv, (int(cx - w / 2), int(top - 46), int(cx + w / 2), int(top + 54)), base, speckle)

def bowl(cv, cx, w, depth, base, speckle=False, rim_y=None):
    top = BASE_Y - depth
    shadow(cv, cx, BASE_Y + 30, w * 1.05)
    foot = shape(lambda d: d.rounded_rectangle((cx - w * 0.2, BASE_Y - 20, cx + w * 0.2, BASE_Y + 36), 14, fill=255))
    paint(cv, foot, mul(base, 0.75), speckle)
    body = shape(lambda d: d.ellipse((cx - w / 2, top - depth * 0.55, cx + w / 2, BASE_Y + 12), fill=255))
    body = ImageChops.multiply(body, shape(lambda d: d.rectangle((0, top, W, H), fill=255)))
    paint(cv, body, base, speckle)
    gloss(cv, cx - w / 2 + w * 0.10, top + depth * 0.42, cx - w / 2 + w * 0.145, top + depth * 0.80, 55)
    rim(cv, (int(cx - w / 2), int(top - 62), int(cx + w / 2), int(top + 62)), base, speckle)

def plate(cv, cx, w, base, speckle=False, lift=0, ringed=False):
    y = BASE_Y - 40 - lift; h = w * 0.2
    shadow(cv, cx, y + h / 2 + 16, w * 1.02, 85)
    paint(cv, shape(lambda d: d.ellipse((cx - w / 2, y - h / 2 + 22, cx + w / 2, y + h / 2 + 22), fill=255)), mul(base, 0.72), speckle)
    paint(cv, shape(lambda d: d.ellipse((cx - w / 2, y - h / 2, cx + w / 2, y + h / 2), fill=255)), mul(base, 1.08), speckle, 0.3)
    wl = w * 0.66
    paint(cv, shape(lambda d: d.ellipse((cx - wl / 2, y - h * 0.34, cx + wl / 2, y + h * 0.34), fill=255)), mul(base, 0.9), speckle, 0.4)
    if ringed:
        d = ImageDraw.Draw(cv); d.ellipse((cx - 60, y - 18, cx + 60, y + 24), outline=(201, 164, 84), width=10)

def vase(cv, cx, bulb_w, bulb_h, neck_w, neck_h, base, speckle=False, stems=True, lip=1.25):
    shadow(cv, cx, BASE_Y + 8, bulb_w * 1.15)
    top = BASE_Y - bulb_h
    m = shape(lambda d: (d.ellipse((cx - bulb_w / 2, top, cx + bulb_w / 2, BASE_Y), fill=255),
                         d.rectangle((cx - neck_w / 2, top - neck_h + bulb_h * 0.35, cx + neck_w / 2, top + bulb_h * 0.5), fill=255)))
    nt = top - neck_h + bulb_h * 0.35
    if stems: dry_stems(cv, cx, nt)
    paint(cv, m, base, speckle)
    gloss(cv, cx - bulb_w / 2 + bulb_w * 0.13, top + bulb_h * 0.28, cx - bulb_w / 2 + bulb_w * 0.18, top + bulb_h * 0.72, 60, 14)
    rim(cv, (int(cx - neck_w * lip / 2), int(nt - 34), int(cx + neck_w * lip / 2), int(nt + 34)), base, speckle)

def cylinder_vase(cv, cx, w, h, base, speckle=False):
    shadow(cv, cx, BASE_Y + 8, w * 1.3); top = BASE_Y - h
    dry_stems(cv, cx, top, tall=True)
    paint(cv, shape(lambda d: d.rounded_rectangle((cx - w / 2, top, cx + w / 2, BASE_Y), 36, fill=255)), base, speckle)
    gloss(cv, cx - w / 2 + w * 0.12, top + 90, cx - w / 2 + w * 0.17, BASE_Y - 100, 60)
    rim(cv, (int(cx - w / 2), int(top - 40), int(cx + w / 2), int(top + 40)), base, speckle)

def dry_stems(cv, cx, y, tall=False):
    d = ImageDraw.Draw(cv); rnd = random.Random(int(cx + y))
    for k, ang in enumerate((-24, -8, 10, 26, 0)):
        L = rnd.randrange(210, 330) if not tall else rnd.randrange(200, 290)
        x2 = cx + math.sin(math.radians(ang)) * L; y2 = y - math.cos(math.radians(ang)) * L
        col = (139, 118, 78) if k % 2 else (112, 124, 82)
        d.line((cx, y + 6, x2, y2), fill=col, width=9)
        for j in range(5):
            t = 0.55 + j * 0.09; px = cx + (x2 - cx) * t; py = y + 6 + (y2 - y - 6) * t
            d.ellipse((px - 11, py - 24, px + 11, py + 24), fill=mul(col, 1.1))

def planter(cv, cx, w, h, base, plant=True, speckle=False):
    top = BASE_Y - h; shadow(cv, cx, BASE_Y + 14, w * 1.2)
    paint(cv, shape(lambda d: d.ellipse((cx - w * 0.5, BASE_Y - 40, cx + w * 0.5, BASE_Y + 44), fill=255)), mul(base, 0.8), speckle)
    if plant:
        d = ImageDraw.Draw(cv); rnd = random.Random(cx)
        for ang in (-62, -40, -18, 0, 18, 40, 62, -28, 28):
            L = rnd.randrange(300, 470); a = math.radians(ang)
            tip = (cx + math.sin(a) * L, top - 20 - math.cos(a) * L)
            mid = ((cx + tip[0]) / 2 + 36, (top + tip[1]) / 2); mid2 = ((cx + tip[0]) / 2 - 36, (top + tip[1]) / 2)
            d.polygon([(cx, top + 10), mid, tip, mid2], fill=mix((70, 112, 76), (126, 160, 92), rnd.random()))
    body = shape(lambda d: d.polygon([(cx - w / 2, top), (cx + w / 2, top), (cx + w / 2 - w * 0.13, BASE_Y), (cx - w / 2 + w * 0.13, BASE_Y)], fill=255))
    paint(cv, body, base, speckle)
    paint(cv, shape(lambda d: d.rounded_rectangle((cx - w / 2 - 16, top - 20, cx + w / 2 + 16, top + h * 0.13), 18, fill=255)), mul(base, 1.1), speckle)
    gloss(cv, cx - w / 2 + w * 0.1, top + h * 0.22, cx - w / 2 + w * 0.145, BASE_Y - 70, 45)

def candle(cv, cx, base):
    shadow(cv, cx, BASE_Y + 6, 520, 90)
    paint(cv, shape(lambda d: d.rectangle((cx - 40, 870, cx + 40, BASE_Y - 220), fill=255)), (243, 232, 208))
    for r, a in ((190, 40), (120, 70)):
        g = Image.new("L", (W, H), 0); ImageDraw.Draw(g).ellipse((cx - r, 800 - r, cx + r, 800 + r), fill=a)
        cv.paste(Image.new("RGB", (W, H), (255, 190, 90)), (0, 0), g.filter(ImageFilter.GaussianBlur(50)))
    ImageDraw.Draw(cv).polygon([(cx, 730), (cx + 30, 820), (cx + 16, 872), (cx - 16, 872), (cx - 30, 820)], fill=(255, 176, 66))
    paint(cv, shape(lambda d: d.rounded_rectangle((cx - 210, BASE_Y - 340, cx + 210, BASE_Y), 46, fill=255)), base)
    rim(cv, (cx - 210, BASE_Y - 384, cx + 210, BASE_Y - 296), base)

def cellar(cv, cx, base):
    shadow(cv, cx, BASE_Y + 6, 560)
    paint(cv, shape(lambda d: d.rounded_rectangle((cx - 210, BASE_Y - 330, cx + 210, BASE_Y), 90, fill=255)), base, speckle=True)
    paint(cv, shape(lambda d: d.rounded_rectangle((cx - 175, BASE_Y - 420, cx + 175, BASE_Y - 320), 26, fill=255)), (196, 160, 112))
    gloss(cv, cx - 150, BASE_Y - 260, cx - 126, BASE_Y - 60, 55)

def make(kind, c, bg):
    cv = Image.new("RGB", (W, H))
    cv.paste(vgrad((W, 1380), mul(bg, 1.05), mix(bg, (255, 255, 255), 0.25)), (0, 0))
    cv.paste(vgrad((W, H - 1380), mix(bg, (120, 100, 80), 0.18), mix(bg, (120, 100, 80), 0.32)), (0, 1380))
    base, sp = hexrgb(c[0]), c[1]
    k = kind
    if k == "mug": mug(cv, 800, 560, 640, base, speckle=sp)
    elif k == "tall_mug": mug(cv, 800, 520, 780, base, speckle=sp, tapered=True)
    elif k == "espresso": mug(cv, 800, 400, 360, base, speckle=sp)
    elif k == "tumbler": mug(cv, 800, 520, 600, base, handle=False, speckle=sp, tapered=True)
    elif k == "bowl": bowl(cv, 800, 1000, 460, base, sp)
    elif k == "ramen": bowl(cv, 800, 1160, 640, base, sp)
    elif k == "breakfast": bowl(cv, 800, 820, 380, base, sp)
    elif k == "dip": bowl(cv, 800, 560, 250, base, sp)
    elif k == "plate": plate(cv, 800, 1180, base, sp)
    elif k == "side": plate(cv, 800, 920, base, sp)
    elif k == "platter": plate(cv, 800, 1380, base, sp, ringed=False)
    elif k == "dish": plate(cv, 800, 940, base, sp, ringed=True)
    elif k == "bud": vase(cv, 800, 520, 560, 140, 420, base, sp, lip=1.7)
    elif k == "moon": vase(cv, 800, 860, 860, 240, 220, base, sp, lip=1.4, stems=True)
    elif k == "cyl": cylinder_vase(cv, 800, 500, 820, base, sp)
    elif k == "planter": planter(cv, 800, 620, 520, base, True, sp)
    elif k == "pot": planter(cv, 800, 560, 460, base, True, sp)
    elif k == "candle": candle(cv, 800, base)
    elif k == "cellar": cellar(cv, 800, base)
    elif k == "set2":
        mug(cv, 520, 430, 540, base, speckle=sp); mug(cv, 960, 430, 540, hexrgb(c[2]) if len(c) > 2 else base, speckle=sp)
    elif k == "breakfast_set":
        plate(cv, 800, 1060, hexrgb(c[2]) if len(c) > 2 else base, sp); bowl(cv, 640, 470, 210, base, sp); mug(cv, 1040, 290, 330, base, speckle=sp)
    cv = cv.filter(ImageFilter.GaussianBlur(0.6))
    grain = Image.effect_noise((W, H), 9).convert("RGB")
    cv = Image.blend(cv, ImageChops.add(cv, grain, 1, -128), 0.35)
    out = cv.crop((170, 400, 1430, 1975)).resize((OUT_W, OUT_H), Image.LANCZOS)  # tighter framing: the object fills the card
    buf = io.BytesIO(); out.save(buf, "JPEG", quality=86, optimize=True)
    return buf.getvalue()

# ---------- catalogue ----------
BG = {"sage": "#E7ECE3", "sand": "#EFE8DD", "blue": "#E5EBF1", "rose": "#F2E6E6", "stone": "#ECEBE7", "clay": "#F1E5DD"}
G = {"sage": ("#8FAE8E", True), "sand": ("#DCC6A0", False), "terra": ("#C9744F", False), "ink": ("#4E719B", False), "oat": ("#EDE4D3", True),
     "char": ("#4F545B", False), "rose": ("#DFA199", False), "mustard": ("#D9AE45", False), "white": ("#F2EFE9", True), "moss": ("#6E8B5C", False)}
def gl(n, *more): return (G[n][0], G[n][1], *[G[m][0] for m in more])

CATEGORIES = [("Mugs & cups", "mugs"), ("Bowls", "bowls"), ("Plates & platters", "plates"), ("Vases & planters", "vases"), ("Gifts & sets", "gifts")]
P = [  # name, category slug, price, stock, kind, glaze, bg, description
 ("Linen Mug", "mugs", 24, 18, "mug", gl("sage"), "sage", "Our everyday mug. Thick-walled and 350 ml, glazed in a soft sage that pools a shade darker at the rim. Dishwasher and microwave safe."),
 ("Dune Espresso Cup", "mugs", 16, 30, "espresso", gl("sand"), "sand", "A small, heavy cup that keeps a double shot hot. Warm sand glaze, 90 ml. Stacks neatly, dishwasher safe."),
 ("Tall Latte Mug", "mugs", 26, 14, "tall_mug", gl("oat"), "stone", "Made for flat whites and long teas. A tapered 420 ml shape in speckled oat, with a handle sized for two fingers."),
 ("Night Market Mug", "mugs", 28, 9, "mug", gl("ink"), "blue", "Deep ink-blue glaze from the Night Market drop. 350 ml. Every piece breaks to a slightly different shade."),
 ("Terracotta Tumbler", "mugs", 18, 22, "tumbler", gl("terra"), "clay", "A handle-free tumbler in warm terracotta, 300 ml. Good for water, wine or a quick espresso. Dishwasher safe."),
 ("Speckle Mug", "mugs", 22, 3, "mug", gl("white"), "stone", "Creamy white with iron speckles that show through the glaze. Only a few left in this firing."),
 ("Stoneware Bowl", "bowls", 38, 16, "bowl", gl("oat"), "stone", "A wide, calm bowl for soup, grains or fruit. 18 cm across, speckled oat glaze. Oven, microwave and dishwasher safe."),
 ("Ramen Bowl", "bowls", 42, 11, "ramen", gl("ink"), "blue", "Deep and generous at 900 ml, with a wide rim that cools broth just enough. Ink-blue glaze, food safe."),
 ("Breakfast Bowl", "bowls", 28, 25, "breakfast", gl("sage"), "sage", "The right size for granola, porridge or yoghurt. 600 ml in soft sage."),
 ("Large Salad Bowl", "bowls", 64, 6, "bowl", gl("sand"), "sand", "A serving bowl that earns a place on the table. 28 cm across, warm sand glaze, thrown in one piece."),
 ("Dipping Bowl", "bowls", 14, 40, "dip", gl("terra"), "clay", "Small and useful for olive oil, salt or sauces. Terracotta glaze, 8 cm."),
 ("Dinner Plate", "plates", 32, 20, "plate", gl("oat"), "stone", "A 27 cm plate with a shallow well and a soft raised rim. Speckled oat glaze, dishwasher safe."),
 ("Side Plate", "plates", 24, 28, "side", gl("sage"), "sage", "21 cm, for bread, cheese or dessert. Sage glaze that matches the Linen Mug."),
 ("Serving Platter", "plates", 72, 5, "platter", gl("sand"), "sand", "A 38 cm platter for sharing. Thrown by hand, with a gentle edge that is easy to lift."),
 ("Pasta Plate", "plates", 36, 0, "plate", gl("char"), "stone", "Charcoal glaze with a deep well. Sold out for now; the next firing is in two weeks."),
 ("Bud Vase", "vases", 29, 19, "bud", gl("rose"), "rose", "A slim vase for a single stem or dried grasses. 16 cm tall, rose-clay glaze, watertight."),
 ("Tall Cylinder Vase", "vases", 54, 8, "cyl", gl("char"), "stone", "A statement vase for branches and long stems. 32 cm tall, charcoal glaze."),
 ("Moon Vase", "vases", 68, 4, "moon", gl("mustard"), "sand", "A round, sculptural vase with a narrow neck. Mustard glaze, 28 cm. Works as an object on its own."),
 ("Planter with Saucer", "vases", 44, 12, "planter", gl("terra"), "clay", "A 20 cm planter with a matching saucer and a drainage hole. Terracotta glaze, frost resistant."),
 ("Small Pot", "vases", 26, 24, "pot", gl("moss"), "sage", "A 12 cm pot for herbs and succulents. Moss glaze, with a drainage hole."),
 ("Set of Two Mugs", "gifts", 44, 10, "set2", gl("sage", "ink"), "sage", "A Linen Mug in sage and a Night Market Mug in ink, wrapped together in recycled paper. A good first gift."),
 ("Breakfast Set", "gifts", 96, 7, "breakfast_set", gl("sage", "oat"), "stone", "A plate, a bowl and a mug in matching glazes. Everything for a slow morning, boxed and ready to give."),
 ("Candle Holder", "gifts", 22, 17, "candle", gl("mustard"), "sand", "A small holder for a taper or tealight, in mustard glaze. Steady on a bookshelf or a table."),
 ("Salt Cellar", "gifts", 19, 21, "cellar", gl("white"), "stone", "A little jar with a cork lid for flaky salt. Speckled white glaze. Keeps the salt dry and in reach."),
 ("Trinket Dish", "gifts", 16, 33, "dish", gl("rose"), "rose", "A small dish with a hand-painted gold ring, for jewellery, keys or soap."),
]

# ---------- API ----------
def env(path):
    out = {}
    for line in open(path):
        if "=" in line: k, v = line.strip().split("=", 1); out[k] = v
    return out

def call(method, path, body=None, token=None, raw=None, ctype="application/json"):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(API + path, data=data, method=method, headers={**({"content-type": ctype} if data is not None else {}), **({"authorization": f"Bearer {token}"} if token else {})})
    try:
        with urllib.request.urlopen(req) as r: b = r.read(); return json.loads(b) if b else None
    except urllib.error.HTTPError as e: sys.exit(f"{method} {path} failed: {e.code} {e.read().decode()[:300]}")

CUSTOMERS = [
    ("Marta Costa", "marta.costa@example.com", "Rua das Flores 24, 1200-195 Lisboa, Portugal"),
    ("Jonas Weber", "jonas.weber@example.com", "Kastanienallee 71, 10435 Berlin, Germany"),
    ("Priya Nair", "priya.nair@example.com", "14 Hartland Road, London NW1 8DE, United Kingdom"),
    ("Lucas Moreau", "lucas.moreau@example.com", "8 rue des Martyrs, 75009 Paris, France"),
    ("Sofia Rossi", "sofia.rossi@example.com", "Via dei Serpenti 33, 00184 Roma, Italy"),
    ("Tomás Ferreira", "tomas.ferreira@example.com", "Rua de Santa Catarina 190, 4000-441 Porto, Portugal"),
    ("Anna Kowalska", "anna.kowalska@example.com", "ul. Mokotowska 12, 00-640 Warszawa, Poland"),
    ("Erik Lindqvist", "erik.lindqvist@example.com", "Hornsgatan 58, 118 21 Stockholm, Sweden"),
]
# (customer index, [(product, qty)], final status)
ORDERS = [
    (0, [("Linen Mug", 2), ("Breakfast Bowl", 2)], "shipped"), (1, [("Breakfast Set", 1)], "shipped"), (2, [("Set of Two Mugs", 1), ("Candle Holder", 1)], "paid"),
    (3, [("Bud Vase", 1)], "shipped"), (4, [("Dinner Plate", 4), ("Side Plate", 4)], "paid"), (5, [("Ramen Bowl", 2)], "pending"),
    (6, [("Moon Vase", 1), ("Trinket Dish", 2)], "paid"), (7, [("Terracotta Tumbler", 4)], "pending"), (0, [("Planter with Saucer", 1), ("Small Pot", 1)], "shipped"),
    (2, [("Night Market Mug", 1)], "cancelled"), (1, [("Salt Cellar", 2), ("Dipping Bowl", 3)], "shipped"), (3, [("Serving Platter", 1)], "pending"),
]

def seed_orders(token, products):
    if call("GET", "/api/orders", token=token): print("  orders already exist, skipping"); return
    by = {p["name"]: p for p in products}
    for ci, lines, status in ORDERS:
        name, email, addr = CUSTOMERS[ci]
        o = call("POST", "/api/shop/orders", {"items": [{"productId": by[n]["id"], "qty": q} for n, q in lines], "customer": {"name": name, "email": email, "address": addr}})
        if status != "pending": call("PATCH", f"/api/orders/{o['id']}", {"status": status}, token)
    print(f"  + {len(ORDERS)} orders from {len(CUSTOMERS)} customers")

def main():
    e = env(os.path.join(ROOT, ".env.demo"))
    token = call("POST", "/api/auth/login", {"email": e["ADMIN_EMAIL"], "password": e["ADMIN_PASSWORD"]})["token"]
    cats = {c["slug"]: c for c in call("GET", "/api/categories", token=token)}
    for name, slug in CATEGORIES:
        if slug not in cats: cats[slug] = call("POST", "/api/categories", {"name": name, "slug": slug}, token)
    existing = {p["name"]: p for p in call("GET", "/api/products", token=token)}
    only = {n.strip() for n in sys.argv[sys.argv.index("--only") + 1].split(",")} if "--only" in sys.argv else set()
    for n in only & existing.keys():  # regenerate: drop the old product so it is created again below
        call("DELETE", f"/api/products/{existing.pop(n)['id']}", token=token)
    made = 0
    for i, (name, cat, price, stock, kind, glaze, bg, desc) in enumerate(P):
        if name in existing: continue
        random.seed(i)
        url = call("POST", "/api/uploads", token=token, raw=make(kind, glaze, hexrgb(BG[bg])), ctype="image/jpeg")["url"]
        call("POST", "/api/products", {"name": name, "price": price, "stock": stock, "active": True, "categoryId": cats[cat]["id"], "description": desc, "images": [url]}, token)
        made += 1; print(f"  + {name}")
    for p in existing.values():  # leftover placeholder products stay in the catalogue but hidden from the shop
        if p["name"].strip().lower() == "test" and p.get("active"): call("PATCH", f"/api/products/{p['id']}", {"active": False}, token); print("  hid placeholder product 'Test'")
    seed_orders(token, call("GET", "/api/products", token=token))
    print(f"Done: {made} products created, {len(CATEGORIES)} categories.")

if __name__ == "__main__": main()

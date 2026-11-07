import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteDataStore } from "@openshop/db";
import { buildApp } from "../src/app.ts";
import { ensureAdmin } from "../src/auth.ts";
import { openDb } from "../src/types.ts";

async function make() {
  const store = new SqliteDataStore(":memory:");
  await ensureAdmin(openDb(store), "Admin@Test.io", "pw-123456");
  const app = buildApp(store, { authSecret: "test-secret", uploadDir: mkdtempSync(join(tmpdir(), "up-")) });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@test.io", password: "pw-123456" } });
  const h = { authorization: `Bearer ${login.json().token}` };
  return { app, h };
}
const form = (o: Record<string, string>) => ({ payload: new URLSearchParams(o).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });

test("admin routes need a token; login validates credentials", async () => {
  const { app } = await make();
  for (const [method, url] of [["GET", "/api/products"], ["GET", "/api/orders"], ["POST", "/api/pages"], ["POST", "/api/uploads"]] as const)
    assert.equal((await app.inject({ method, url })).statusCode, 401, `${method} ${url}`);
  assert.equal((await app.inject({ method: "GET", url: "/api/products", headers: { authorization: "Bearer a.b" } })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@test.io", password: "wrong" } })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "nobody@test.io", password: "x" } })).statusCode, 401);
});

test("login is throttled after repeated failures", async () => {
  const { app } = await make();
  let last = 0;
  for (let i = 0; i < 12; i++) last = (await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@test.io", password: "bad" } })).statusCode;
  assert.equal(last, 429);
});

test("products CRUD; PATCH does not reset other fields", async () => {
  const { app, h } = await make();
  assert.equal((await app.inject({ method: "POST", url: "/api/products", headers: h, payload: { name: "" } })).statusCode, 400);
  const c = await app.inject({ method: "POST", url: "/api/products", headers: h, payload: { name: "Mug", price: 9.5, stock: 3, active: false } });
  assert.equal(c.statusCode, 201);
  const { id } = c.json();
  const p = await app.inject({ method: "PATCH", url: `/api/products/${id}`, headers: h, payload: { price: 12 } });
  assert.equal(p.json().price, 12);
  assert.equal(p.json().active, false);
  assert.equal(p.json().stock, 3);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/products/${id}`, headers: h })).statusCode, 204);
  assert.equal((await app.inject({ method: "GET", url: `/api/products/${id}`, headers: h })).statusCode, 404);
});

const sec = (children: unknown[]) => ({ id: "s" + Math.random().toString(36).slice(2, 8), type: "section", children: [{ id: "c" + Math.random().toString(36).slice(2, 8), type: "column", children }] });
const grid = (props: object) => ({ id: "g" + Math.random().toString(36).slice(2, 8), type: "productGrid", props });

test("product grids are filled from the catalogue and re-rendered on change", async () => {
  const { app, h } = await make();
  const cat = (await app.inject({ method: "POST", url: "/api/categories", headers: h, payload: { name: "Home", slug: "home-goods" } })).json();
  const page = await app.inject({ method: "POST", url: "/api/pages", headers: h, payload: { slug: "landing", title: "L", nodes: [sec([grid({ categoryId: cat.id, items: [{ name: "FAKE", price: 1 }] })])] } });
  assert.equal(page.statusCode, 201);
  assert.doesNotMatch(page.json().html, /FAKE/);
  const pid = (await app.inject({ method: "POST", url: "/api/products", headers: h, payload: { name: "Lamp", price: 20, stock: 1, categoryId: cat.id } })).json().id;
  await app.inject({ method: "POST", url: "/api/products", headers: h, payload: { name: "Other", price: 5, stock: 1 } });
  const served = await app.inject({ method: "GET", url: "/s/landing" });
  assert.match(served.body, /Lamp/);
  assert.doesNotMatch(served.body, /Other/);
  assert.match(served.headers["content-security-policy"] as string, /default-src 'none'/);
  assert.match(served.headers["content-security-policy"] as string, /fonts\.googleapis\.com/);
  await app.inject({ method: "PATCH", url: `/api/products/${pid}`, headers: h, payload: { active: false } });
  assert.doesNotMatch((await app.inject({ method: "GET", url: "/s/landing" })).body, /Lamp/);
  assert.equal((await app.inject({ method: "POST", url: "/api/pages", headers: h, payload: { slug: "landing", title: "x", nodes: [] } })).statusCode, 409);
});

test("page documents are validated, cleaned, and rendered with theme", async () => {
  const { app, h } = await make();
  const bad = await app.inject({ method: "POST", url: "/api/pages", headers: h, payload: { slug: "bad", title: "x", nodes: [{ id: "a", type: "heading" }] } });
  assert.equal(bad.statusCode, 400);
  const evil = await app.inject({ method: "POST", url: "/api/pages", headers: h, payload: { slug: "evil", title: "x", theme: { primary: "red;}</style><script>1</script>" }, nodes: [{ id: "s1", type: "section", style: { color: "red;}</style>" }, children: [] }] } });
  assert.equal(evil.statusCode, 201);
  assert.doesNotMatch(evil.json().html, /<script/);
  assert.equal(evil.json().theme.primary, "#2B4BFF");
  const home = await app.inject({ method: "POST", url: "/api/pages", headers: h, payload: { slug: "home", title: "Home", theme: { primary: "#E4442B" }, nodes: [sec([{ id: "h1", type: "heading", props: { text: "Welcome" } }])] } });
  assert.match((await app.inject({ method: "GET", url: "/" })).body, /Welcome/);
  assert.match((await app.inject({ method: "GET", url: "/shop" })).body, /--primary:#E4442B/);
  const put = await app.inject({ method: "PUT", url: `/api/pages/${home.json().id}`, headers: h, payload: { slug: "home", title: "Home 2", nodes: [] } });
  assert.equal(put.json().title, "Home 2");
  assert.equal((await app.inject({ method: "GET", url: "/s/nope" })).statusCode, 404);
});

test("orders use catalogue prices, enforce stock, and decrement it", async () => {
  const { app, h } = await make();
  const pid = (await app.inject({ method: "POST", url: "/api/products", headers: h, payload: { name: "Pen", price: 2.5, stock: 3 } })).json().id;
  const customer = { name: "Ann", email: "Ann@x.io", address: "1 Road" };
  const ok = await app.inject({ method: "POST", url: "/api/shop/orders", payload: { items: [{ productId: pid, qty: 2 }], customer } });
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.json().total, 5);
  assert.equal(ok.json().customer.email, "ann@x.io");
  const smuggled = await app.inject({ method: "POST", url: "/api/shop/orders", payload: { items: [{ productId: pid, qty: 1, price: 0.01 }], customer } });
  assert.equal(smuggled.statusCode, 201);
  assert.equal(smuggled.json().total, 2.5); // client-supplied price ignored
  assert.equal((await app.inject({ method: "POST", url: "/api/shop/orders", payload: { items: [{ productId: pid, qty: 2 }], customer } })).statusCode, 409);
  assert.equal((await app.inject({ method: "GET", url: `/api/products/${pid}`, headers: h })).json().stock, 0);
  assert.equal((await app.inject({ method: "GET", url: "/api/customers", headers: h })).json().length, 1);
  const st = await app.inject({ method: "PATCH", url: `/api/orders/${ok.json().id}`, headers: h, payload: { status: "paid" } });
  assert.equal(st.json().status, "paid");
});

test("concurrent orders cannot oversell", async () => {
  const { app, h } = await make();
  const pid = (await app.inject({ method: "POST", url: "/api/products", headers: h, payload: { name: "Rare", price: 1, stock: 1 } })).json().id;
  const customer = { name: "A", email: "a@x.io", address: "x" };
  const res = await Promise.all(Array.from({ length: 5 }, () => app.inject({ method: "POST", url: "/api/shop/orders", payload: { items: [{ productId: pid, qty: 1 }], customer } })));
  assert.equal(res.filter((r) => r.statusCode === 201).length, 1);
});

test("image upload validates content and serves safely", async () => {
  const { app, h } = await make();
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const up = await app.inject({ method: "POST", url: "/api/uploads", headers: { ...h, "content-type": "image/png" }, payload: png });
  assert.equal(up.statusCode, 201);
  const got = await app.inject({ method: "GET", url: up.json().url });
  assert.equal(got.statusCode, 200);
  assert.equal(got.headers["content-type"], "image/png");
  assert.equal((await app.inject({ method: "POST", url: "/api/uploads", headers: { ...h, "content-type": "image/png" }, payload: Buffer.from("<script>") })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/api/uploads", headers: { ...h, "content-type": "image/svg+xml" }, payload: Buffer.from("<svg/>") })).statusCode, 415);
  assert.equal((await app.inject({ method: "GET", url: "/uploads/..%2Fsecret" })).statusCode, 404);
});

test("storefront: cart cookie, checkout, confirmation, escaping", async () => {
  const { app, h } = await make();
  const pid = (await app.inject({ method: "POST", url: "/api/products", headers: h, payload: { name: "<b>Hat</b>", price: 15, stock: 5 } })).json().id;
  const shop = await app.inject({ method: "GET", url: "/shop" });
  assert.match(shop.body, /&lt;b&gt;Hat/);
  assert.doesNotMatch(shop.body, /<b>Hat/);
  const add = await app.inject({ method: "POST", url: "/shop/cart/add", ...form({ productId: pid, qty: "2" }) });
  assert.equal(add.statusCode, 303);
  const cookie = String(add.headers["set-cookie"]).split(";")[0];
  const cart = await app.inject({ method: "GET", url: "/shop/cart", headers: { cookie } });
  assert.match(cart.body, /30\.00/);
  const bad = await app.inject({ method: "POST", url: "/shop/checkout", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, payload: "name=A&email=nope&address=x" });
  assert.equal(bad.statusCode, 400);
  const co = await app.inject({ method: "POST", url: "/shop/checkout", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, payload: "name=Ann&email=ann%40x.io&address=1+Road" });
  assert.equal(co.statusCode, 303);
  const conf = await app.inject({ method: "GET", url: String(co.headers.location) });
  assert.match(conf.body, /Thank you, Ann/);
  assert.match((await app.inject({ method: "GET", url: "/shop/cart", headers: { cookie } })).body, /empty/);
  assert.equal((await app.inject({ method: "GET", url: `/api/products/${pid}`, headers: h })).json().stock, 3);
  assert.equal((await app.inject({ method: "POST", url: "/shop/cart/add", ...form({ productId: "nope", qty: "1" }) })).statusCode, 400);
  assert.equal((await app.inject({ method: "GET", url: "/" })).statusCode, 302);
});

test("essential pages exist, render real data, and can't be moved or deleted", async () => {
  const { app, h } = await make();
  const list = (await app.inject({ method: "GET", url: "/api/pages", headers: h })).json();
  const sys = list.filter((p: any) => p.system);
  assert.deepEqual(sys.map((p: any) => p.system).sort(), ["category", "product", "search"]);
  const productPage = sys.find((p: any) => p.system === "product");
  // editing keeps the fixed address
  const full = (await app.inject({ method: "GET", url: `/api/pages/${productPage.id}`, headers: h })).json();
  const put = await app.inject({ method: "PUT", url: `/api/pages/${productPage.id}`, headers: h, payload: { slug: "hijack", title: "Product page", nodes: full.nodes } });
  assert.equal(put.json().slug, "system-product");
  assert.equal((await app.inject({ method: "DELETE", url: `/api/pages/${productPage.id}`, headers: h })).statusCode, 400);
  assert.equal((await app.inject({ method: "PATCH", url: `/api/pages/${productPage.id}`, headers: h, payload: { slug: "x" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "GET", url: "/s/system-product" })).statusCode, 404);

  const cat = (await app.inject({ method: "POST", url: "/api/categories", headers: h, payload: { name: "Mugs", slug: "mugs" } })).json();
  const mug = (await app.inject({ method: "POST", url: "/api/products", headers: h, payload: { name: "Blue <i>Mug</i>", price: 12.5, stock: 4, description: "Holds tea", categoryId: cat.id } })).json();
  await app.inject({ method: "POST", url: "/api/products", headers: h, payload: { name: "Plate", price: 8, stock: 4 } });

  const prod = await app.inject({ method: "GET", url: `/shop/product/${mug.id}` });
  assert.equal(prod.statusCode, 200);
  assert.match(prod.body, /Blue &lt;i&gt;Mug&lt;\/i&gt;/);
  assert.match(prod.body, /€12\.50/);
  assert.match(prod.body, new RegExp(`name="productId" value="${mug.id}"`));
  assert.doesNotMatch(prod.body, /Linen mug/); // never leaks the editor's sample data
  assert.equal((await app.inject({ method: "GET", url: "/shop/product/nope" })).statusCode, 404);

  const cats = await app.inject({ method: "GET", url: "/shop/category/mugs" });
  assert.match(cats.body, /Blue/); assert.doesNotMatch(cats.body, /Plate/);
  assert.equal((await app.inject({ method: "GET", url: "/shop/category/nope" })).statusCode, 404);
  assert.match((await app.inject({ method: "GET", url: "/shop" })).body, /Plate/);
  assert.equal((await app.inject({ method: "GET", url: "/shop?category=mugs" })).statusCode, 302);

  const found = await app.inject({ method: "GET", url: "/search?q=TEA" }); // matches the description, case-insensitively
  assert.match(found.body, /Blue/); assert.doesNotMatch(found.body, /Plate/);
  assert.match((await app.inject({ method: "GET", url: "/search?q=zzz" })).body, /Nothing matches/);
  assert.doesNotMatch((await app.inject({ method: "GET", url: "/search?q=%22%3E%3Cscript%3Ealert(1)%3C/script%3E" })).body, /<script>alert/);
});

test("page addresses can be edited, are unique, and pages can be deleted", async () => {
  const { app, h } = await make();
  const mk = async (slug: string) => (await app.inject({ method: "POST", url: "/api/pages", headers: h, payload: { slug, title: slug, nodes: [] } })).json();
  const a = await mk("about"), b = await mk("contact");
  const ok = await app.inject({ method: "PATCH", url: `/api/pages/${a.id}`, headers: h, payload: { slug: "our-story" } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().slug, "our-story");
  assert.equal((await app.inject({ method: "GET", url: "/s/our-story" })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/s/about" })).statusCode, 404);
  assert.equal((await app.inject({ method: "PATCH", url: `/api/pages/${b.id}`, headers: h, payload: { slug: "our-story" } })).statusCode, 409);
  assert.equal((await app.inject({ method: "PATCH", url: `/api/pages/${b.id}`, headers: h, payload: { slug: "Bad Slug!" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/pages/${b.id}`, headers: h })).statusCode, 204);
  assert.equal((await app.inject({ method: "GET", url: "/s/contact" })).statusCode, 404);
  // becoming the front page is just taking the address "home"
  await app.inject({ method: "PATCH", url: `/api/pages/${a.id}`, headers: h, payload: { slug: "home" } });
  assert.equal((await app.inject({ method: "GET", url: "/" })).statusCode, 200);
});

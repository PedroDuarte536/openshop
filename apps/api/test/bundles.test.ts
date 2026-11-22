// Bundles (plan §2.6): validation, price (sum or manual), derived stock, checkout (component stock, concurrency),
// offers (B-2: only offers naming the bundle, unless allowed), order snapshots, cart and confirmation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { make, form, cookieOf } from "./catalogue-helpers.ts";

type C = Awaited<ReturnType<typeof make>>;
const order = (c: C, items: [string, number][], email = "a@x.io") =>
  c.app.inject({ method: "POST", url: "/api/shop/orders", payload: { items: items.map(([productId, qty]) => ({ productId, qty })), customer: { name: "A", email, address: "1 Road" } } });
async function kit(c: C) {
  const mug = await c.product({ name: "Linen Mug", sku: "MUG", price: 24, stock: 10 });
  const plate = await c.product({ name: "Dune Plate", sku: "PLATE", price: 29, stock: 3 });
  const set = await c.product({ name: "Breakfast set", type: "bundle", bundle: { components: [{ productId: mug.id, qty: 2 }, { productId: plate.id, qty: 1 }] } });
  return { mug, plate, set };
}

test("bundles are validated: 2+ different simple products, no nesting, quantities 1–99", async () => {
  const c = await make();
  const { mug, plate, set } = await kit(c);
  const bad = async (bundle: object, field = "bundle.components") => {
    const r = await c.api("POST", "/api/products", { name: "X", type: "bundle", bundle });
    assert.equal(r.statusCode, 400, JSON.stringify(bundle));
    assert.ok(r.json().fields.some((f: { field: string }) => f.field === field), r.body);
    return r.json().fields.map((f: { message: string }) => f.message).join();
  };
  assert.match(await bad({ components: [{ productId: mug.id, qty: 1 }] }), /at least 2/);
  assert.match(await bad({ components: [{ productId: mug.id, qty: 1 }, { productId: mug.id, qty: 2 }] }), /once/);
  assert.match(await bad({ components: [{ productId: mug.id, qty: 0 }, { productId: plate.id, qty: 1 }] }), /1 to 99/);
  assert.match(await bad({ components: [{ productId: mug.id, qty: 1 }, { productId: set.id, qty: 1 }] }), /bundles can't contain bundles/);
  assert.match(await bad({ components: [{ productId: mug.id, qty: 1 }, { productId: "nope", qty: 1 }] }), /unknown product/);
  assert.match(await bad({ components: [{ productId: mug.id, qty: 1 }, { productId: plate.id, qty: 1 }], priceMode: "free" }, "bundle.priceMode"), /sum or manual/);
  assert.equal((await c.api("POST", "/api/products", { name: "X", price: 1, bundle: { components: [] }, type: "simple" })).statusCode, 400, "simple products have no components");
  const becomeBundle = await c.api("PATCH", `/api/products/${mug.id}`, { type: "bundle", bundle: { components: [{ productId: plate.id, qty: 1 }, { productId: set.id, qty: 1 }] } });
  assert.match(becomeBundle.body, /part of a bundle, so it can't become a bundle/);
  // a deleted product can't be added to a bundle (it can stay in bundles that already had it)
  const old = await c.product({ name: "Old", active: false });
  await c.api("DELETE", `/api/products/${old.id}`);
  assert.match(await bad({ components: [{ productId: mug.id, qty: 1 }, { productId: old.id, qty: 1 }] }), /Old is deleted/);
});

test("the price is the sum of the components by default, kept up to date; a manual price stays; availability is derived", async () => {
  const c = await make();
  const { mug, plate, set } = await kit(c);
  assert.equal(set.price, 77, "2 × 24 + 29");
  assert.equal(set.stock, 0, "a bundle has no stock of its own");
  await c.api("PATCH", `/api/products/${mug.id}`, { price: 25 });
  assert.equal((await c.api("GET", `/api/products/${set.id}`)).json().price, 79, "recalculated when a component's price changes");
  assert.ok((await c.db.audit.find({ action: "recalculate", entityId: set.id })).length === 1);
  const manual = await c.api("PATCH", `/api/products/${set.id}`, { price: 65, bundle: { components: [{ productId: mug.id, qty: 2 }, { productId: plate.id, qty: 1 }], priceMode: "manual" } });
  assert.equal(manual.json().price, 65);
  await c.api("PATCH", `/api/products/${plate.id}`, { price: 30 });
  assert.equal((await c.api("GET", `/api/products/${set.id}`)).json().price, 65, "a manual price isn't changed");
  const back = await c.api("PATCH", `/api/products/${set.id}`, { bundle: { components: [{ productId: mug.id, qty: 2 }, { productId: plate.id, qty: 1 }], priceMode: "sum" } });
  assert.equal(back.json().price, 80, "reset to the sum");
  const listed = (await c.api("GET", `/api/products?ids=${set.id}`)).json().items[0];
  assert.deepEqual([listed.extras.available, listed.extras.limitedBy.name, listed.extras.componentsTotal], [3, "Dune Plate", 80]);
  assert.equal((await c.api("POST", "/api/products", { name: "M", type: "bundle", bundle: { components: [{ productId: mug.id, qty: 1 }, { productId: plate.id, qty: 1 }], priceMode: "manual" } })).statusCode, 400, "a manual price must be given");
});

test("checkout: component stock is taken, demand adds up across bundles and single items, never oversold", async () => {
  const c = await make();
  const { mug, plate, set } = await kit(c);
  const o = await order(c, [[set.id, 1], [mug.id, 3]]);
  assert.equal(o.statusCode, 201, o.body);
  assert.equal((await c.api("GET", `/api/products/${mug.id}`)).json().stock, 5, "10 − 2 (bundle) − 3 (single)");
  assert.equal((await c.api("GET", `/api/products/${plate.id}`)).json().stock, 2);
  const short = await order(c, [[set.id, 2], [mug.id, 2]]);
  assert.equal(short.statusCode, 409);
  assert.match(short.json().error, /not enough Linen Mug for Breakfast set/);
  assert.equal((await c.api("GET", `/api/products/${mug.id}`)).json().stock, 5, "nothing taken by a refused order");
  // 20 parallel orders for the 2 remaining plates: exactly 2 succeed.
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => order(c, [[set.id, 1]], `p${i}@x.io`)));
  assert.equal(results.filter((r) => r.statusCode === 201).length, 2);
  assert.equal((await c.api("GET", `/api/products/${plate.id}`)).json().stock, 0);
  assert.equal((await c.api("GET", `/api/products/${mug.id}`)).json().stock, 1);
  // The order keeps what was inside, with each component's share of the price.
  const line = o.json().lines.find((l: { productId: string }) => l.productId === set.id);
  assert.deepEqual(line.bundle.components.map((x: { name: string; qty: number; sku: string }) => [x.name, x.qty, x.sku]), [["Linen Mug", 2, "MUG"], ["Dune Plate", 1, "PLATE"]]);
  assert.equal(line.bundle.components.reduce((a: number, x: { allocatedCents: number }) => a + x.allocatedCents, 0), 7700, "shares add up to the price");
});

test("offers: shop-wide and category offers skip bundles unless allowed; offers that name the bundle apply", async () => {
  const c = await make();
  const { mug, set } = await kit(c);
  await c.api("POST", "/api/discounts", { name: "Sale", label: "Sale", effect: { type: "percent", bp: 1000 } });
  const prices = async () => Object.fromEntries((await c.app.inject({ url: `/api/shop/prices?ids=${set.id},${mug.id}` })).json().items.map((i: { productId: string; priceCents: number }) => [i.productId, i.priceCents]));
  assert.deepEqual(await prices(), { [set.id]: 7700, [mug.id]: 2160 });
  const o1 = await order(c, [[set.id, 1]]);
  assert.equal(o1.json().total, 77, "checkout agrees");
  await c.api("POST", "/api/discounts", { name: "Set deal", label: "Set deal", target: { type: "products", productIds: [set.id] }, effect: { type: "amountOff", cents: 700 } });
  assert.equal((await prices())[set.id], 7000, "an offer made for the bundle applies");
  await c.api("PATCH", `/api/products/${set.id}`, { bundle: { components: set.bundle.components, priceMode: "sum", offerScope: "all" } });
  assert.equal((await prices())[set.id], 6930, "allowed: the better of the offers applies (10% of 77 = 7.70)");
});

test("cart and confirmation show what's inside; deleted components keep selling when chosen; hidden ones only in the bundle", async () => {
  const c = await make();
  const { mug, plate, set } = await kit(c);
  const add = await c.app.inject({ method: "POST", url: "/shop/cart/add", ...form({ productId: set.id, qty: "1" }) });
  const cart = cookieOf(add, "cart");
  const page = await c.app.inject({ url: "/shop/cart", headers: { cookie: cart } });
  assert.match(page.body, /Breakfast set<div class="os-line-offers">Includes: 2 × Linen Mug, 1 × Dune Plate<\/div>/);
  const checkout = await c.app.inject({ method: "POST", url: "/shop/checkout", ...form({ name: "Ann", email: "ann@x.io", address: "1 Road" }, cart) });
  assert.equal(checkout.statusCode, 303, checkout.body);
  const confirmation = await c.app.inject({ url: checkout.headers.location as string });
  assert.match(confirmation.body, /Breakfast set<div class="os-line-offers">Includes: 2 × Linen Mug, 1 × Dune Plate<\/div>/);
  // A hidden component is sold only inside the bundle.
  await c.api("PATCH", `/api/products/${plate.id}`, { active: false });
  assert.equal((await c.app.inject({ method: "POST", url: "/shop/cart/add", ...form({ productId: plate.id, qty: "1" }) })).statusCode, 400);
  assert.equal((await order(c, [[set.id, 1]], "b@x.io")).statusCode, 201);
  // Deleted, with "keep selling": the bundle still sells and takes it from stock.
  await c.api("DELETE", `/api/products/${plate.id}`, { bundles: { [set.id]: "keep" } });
  const after = await order(c, [[set.id, 1]], "c@x.io");
  assert.equal(after.statusCode, 201, after.body);
  assert.equal((await c.api("GET", `/api/products/${plate.id}`)).json().stock, 0);
  assert.equal((await order(c, [[set.id, 1]], "d@x.io")).statusCode, 409, "no plates left");
  const listed = (await c.api("GET", `/api/products?ids=${set.id}`)).json().items[0];
  assert.equal(listed.extras.containsDeleted, true);
  void mug;
});

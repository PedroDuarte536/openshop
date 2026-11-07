import type { Db, Order, OrderLine } from "./types.ts";

export class OrderError extends Error {
  status: number;
  constructor(msg: string, status = 400) { super(msg); this.status = status; }
}

// Serialises stock-changing work within this process. Multi-instance deployments need real DB transactions.
let chain: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const r = chain.then(fn, fn);
  chain = r.catch(() => undefined);
  return r;
}

export interface Customer { name: string; email: string; address: string }

/** Prices and names always come from the catalogue, never from the caller. */
export function placeOrder(db: Db, items: { productId: string; qty: number }[], customer: Customer): Promise<Order> {
  return locked(async () => {
    const merged = new Map<string, number>();
    for (const i of items) {
      if (!Number.isInteger(i.qty) || i.qty < 1 || i.qty > 99) throw new OrderError("invalid quantity");
      merged.set(i.productId, (merged.get(i.productId) ?? 0) + i.qty);
    }
    if (merged.size === 0) throw new OrderError("cart is empty");
    const lines: OrderLine[] = [];
    const products = [];
    for (const [id, qty] of merged) {
      const p = await db.products.get(id);
      if (!p || !p.active) throw new OrderError(`product unavailable: ${id}`, 409);
      if (p.stock < qty) throw new OrderError(`not enough stock for ${p.name}`, 409);
      products.push(p);
      lines.push({ productId: id, name: p.name, price: p.price, qty });
    }
    const total = lines.reduce((c, l) => c + Math.round(l.price * 100) * l.qty, 0) / 100;
    for (const p of products) await db.products.update(p.id, { stock: p.stock - merged.get(p.id)! });
    const email = customer.email.toLowerCase();
    const [existing] = await db.customers.find({ email }, { limit: 1 });
    if (existing) await db.customers.update(existing.id, { name: customer.name, address: customer.address });
    else await db.customers.insert({ email, name: customer.name, address: customer.address });
    return db.orders.insert({ lines, total, status: "pending", customer: { ...customer, email }, createdAt: new Date().toISOString() });
  });
}

import type { Collection, DataStore, Doc } from "@openshop/db";
import type { Block } from "@openshop/renderer";

export interface Product extends Doc { name: string; price: number; active: boolean; stock: number; categoryId?: string | null; description?: string; images?: string[] }
export interface Category extends Doc { name: string; slug: string }
export interface Page extends Doc { slug: string; title: string; blocks: Block[]; html: string }
export interface OrderLine { productId: string; name: string; price: number; qty: number }
export interface Order extends Doc {
  lines: OrderLine[]; total: number; status: "pending" | "paid" | "shipped" | "cancelled";
  customer: { name: string; email: string; address: string }; createdAt: string;
}
export interface Customer extends Doc { email: string; name: string; address: string }
export interface Cart extends Doc { items: { productId: string; qty: number }[] }
export interface User extends Doc { email: string; passwordHash: string }

export interface Db {
  products: Collection<Product>; categories: Collection<Category>; pages: Collection<Page>;
  orders: Collection<Order>; customers: Collection<Customer>; carts: Collection<Cart>; users: Collection<User>;
}
export const openDb = (s: DataStore): Db => ({
  products: s.collection("products"), categories: s.collection("categories"), pages: s.collection("pages"),
  orders: s.collection("orders"), customers: s.collection("customers"), carts: s.collection("carts"), users: s.collection("users"),
});

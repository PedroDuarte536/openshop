import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { tap } from 'rxjs';
import type { Block } from '@openshop/renderer';

export interface Product { id: string; name: string; price: number; active: boolean; stock: number; categoryId?: string | null; description?: string; images?: string[] }
export interface Category { id: string; name: string; slug: string }
export interface Order { id: string; total: number; status: string; createdAt: string; customer: { name: string; email: string; address: string }; lines: { name: string; qty: number; price: number }[] }
export interface PageSummary { id: string; slug: string; title: string; blocks: Block[] }
export type ProductInput = Omit<Product, 'id'>;

const KEY = 'openshop.token';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);
  token = signal<string | null>(read());
  login = (email: string, password: string) =>
    this.http.post<{ token: string }>('/api/auth/login', { email, password }).pipe(tap((r) => { this.token.set(r.token); write(r.token); }));
  logout() { this.token.set(null); write(null); }

  products = () => this.http.get<Product[]>('/api/products');
  createProduct = (p: ProductInput) => this.http.post<Product>('/api/products', p);
  updateProduct = (id: string, p: Partial<ProductInput>) => this.http.patch<Product>(`/api/products/${id}`, p);
  deleteProduct = (id: string) => this.http.delete<void>(`/api/products/${id}`);
  upload = (file: File) => this.http.post<{ url: string }>('/api/uploads', file, { headers: { 'Content-Type': file.type } });
  categories = () => this.http.get<Category[]>('/api/categories');
  createCategory = (c: { name: string; slug: string }) => this.http.post<Category>('/api/categories', c);
  deleteCategory = (id: string) => this.http.delete<void>(`/api/categories/${id}`);
  orders = () => this.http.get<Order[]>('/api/orders');
  setOrderStatus = (id: string, status: string) => this.http.patch<Order>(`/api/orders/${id}`, { status });
  pages = () => this.http.get<PageSummary[]>('/api/pages');
  page = (id: string) => this.http.get<PageSummary>(`/api/pages/${id}`);
  createPage = (p: { slug: string; title: string; blocks: Block[] }) => this.http.post<PageSummary>('/api/pages', p);
  savePage = (id: string, p: { slug: string; title: string; blocks: Block[] }) => this.http.put<PageSummary>(`/api/pages/${id}`, p);
}

function read() { try { return localStorage.getItem(KEY); } catch { return null; } }
function write(v: string | null) { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch { /* storage unavailable */ } }

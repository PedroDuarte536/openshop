import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { Block } from '@openshop/renderer';

export interface Product { id: string; name: string; price: number; active: boolean }
export interface PageSummary { id: string; slug: string; title: string; blocks: Block[] }

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);
  products = () => this.http.get<Product[]>('/api/products');
  createProduct = (p: { name: string; price: number; active: boolean }) => this.http.post<Product>('/api/products', p);
  updateProduct = (id: string, p: Partial<Product>) => this.http.patch<Product>(`/api/products/${id}`, p);
  deleteProduct = (id: string) => this.http.delete<void>(`/api/products/${id}`);
  pages = () => this.http.get<PageSummary[]>('/api/pages');
  page = (id: string) => this.http.get<PageSummary>(`/api/pages/${id}`);
  createPage = (p: { slug: string; title: string; blocks: Block[] }) => this.http.post<PageSummary>('/api/pages', p);
  savePage = (id: string, p: { slug: string; title: string; blocks: Block[] }) => this.http.put<PageSummary>(`/api/pages/${id}`, p);
}

import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, Category, Product } from './api.service';

@Component({
  selector: 'app-categories',
  imports: [FormsModule],
  template: `
    <header class="page-h"><div><h1>Categories</h1><p>Group products so visitors can browse them</p></div></header>
    <div class="card" style="padding:22px;margin-bottom:22px">
      <form (ngSubmit)="add()" class="nform">
        <label class="fld req"><span>Name</span><input class="inp" name="name" [(ngModel)]="name" (ngModelChange)="autoSlug()" placeholder="e.g. Mugs" required></label>
        <label class="fld req"><span>Address</span><div class="affix"><b style="font-size:12px">/shop/category/</b><input class="inp" style="padding-left:116px" name="slug" [(ngModel)]="slug" pattern="[a-z0-9\\-]+" placeholder="mugs" required></div></label>
        <button class="btn primary">Add category</button>
      </form>
      @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
    </div>
    <div class="card">
      @if (items().length) {
        <table class="tbl">
          <thead><tr><th>Category</th><th>Address</th><th>Products</th><th></th></tr></thead>
          <tbody>
            @for (c of items(); track c.id) {
              <tr>
                <td class="cell-main">{{ c.name }}</td>
                <td class="cell-sub">/shop/category/{{ c.slug }}</td>
                <td>{{ count(c.id) }}</td>
                <td><div class="acts">
                  <a class="btn sm" [href]="'/shop/category/' + c.slug" target="_blank" rel="noopener">View</a>
                  <button class="btn sm danger" [class.armed]="armed() === c.id" (click)="remove(c)">{{ armed() === c.id ? 'Click to confirm' : 'Delete' }}</button>
                </div></td>
              </tr>
            }
          </tbody>
        </table>
      } @else { <div class="empty-state"><b>No categories yet</b>Add one above, then assign products to it from the product form.</div> }
    </div>`,
})
export class Categories {
  private api = inject(ApiService);
  items = signal<Category[]>([]); products = signal<Product[]>([]); error = signal(''); armed = signal('');
  name = ''; slug = ''; private last = '';
  counts = computed(() => { const m = new Map<string, number>(); for (const p of this.products()) if (p.categoryId) m.set(p.categoryId, (m.get(p.categoryId) ?? 0) + 1); return m; });
  constructor() { this.load(); this.api.products().subscribe((p) => this.products.set(p)); }
  count(id: string) { return this.counts().get(id) ?? 0; }
  load() { this.api.categories().subscribe((c) => this.items.set(c)); }
  private slugify = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  autoSlug() { if (!this.slug || this.slug === this.slugify(this.last)) this.slug = this.slugify(this.name); this.last = this.name; }
  add() {
    this.api.createCategory({ name: this.name, slug: this.slug }).subscribe({
      next: () => { this.name = this.slug = this.last = ''; this.error.set(''); this.load(); },
      error: (e) => this.error.set(e.status === 409 ? 'That address is already used by another category.' : e.error?.error ?? 'Could not add the category.'),
    });
  }
  remove(c: Category) {
    if (this.armed() !== c.id) { this.armed.set(c.id); setTimeout(() => { if (this.armed() === c.id) this.armed.set(''); }, 3500); return; }
    this.api.deleteCategory(c.id).subscribe(() => { this.armed.set(''); this.load(); });
  }
}

import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, Category, Product, ProductInput } from './api.service';

const blank = (): ProductInput => ({ name: '', price: 0, active: true, stock: 0, categoryId: null, description: '', images: [] });

@Component({
  selector: 'app-products',
  imports: [FormsModule],
  template: `
    <h2>Products</h2>
    <form (ngSubmit)="save()" class="stack">
      <h3>{{ editing() ? 'Edit product' : 'New product' }}</h3>
      <input name="name" [(ngModel)]="form.name" placeholder="Name" required>
      <input name="price" type="number" step="0.01" min="0" [(ngModel)]="form.price" required>
      <input name="stock" type="number" step="1" min="0" [(ngModel)]="form.stock" required>
      <select name="cat" [(ngModel)]="form.categoryId">
        <option [ngValue]="null">No category</option>
        @for (c of categories(); track c.id) { <option [ngValue]="c.id">{{ c.name }}</option> }
      </select>
      <textarea name="desc" [(ngModel)]="form.description" placeholder="Description"></textarea>
      <label><input name="active" type="checkbox" [(ngModel)]="form.active"> Active</label>
      <div class="row">
        @for (img of form.images; track img) { <img [src]="img" width="64" alt="product image"> }
      </div>
      <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" (change)="pick($event)">
      <div class="row"><button>{{ editing() ? 'Save' : 'Add' }}</button>@if (editing()) { <button type="button" (click)="reset()">Cancel</button> }</div>
      @if (error()) { <p class="err">{{ error() }}</p> }
    </form>
    <table>
      <tr><th>Name</th><th>Price</th><th>Stock</th><th>Active</th><th></th></tr>
      @for (p of items(); track p.id) {
        <tr>
          <td>{{ p.name }}</td><td>{{ p.price.toFixed(2) }}</td><td>{{ p.stock }}</td><td>{{ p.active ? 'yes' : 'no' }}</td>
          <td class="row"><button (click)="edit(p)">Edit</button><button (click)="remove(p)">Delete</button></td>
        </tr>
      } @empty { <tr><td colspan="5">No products yet.</td></tr> }
    </table>`,
})
export class Products {
  private api = inject(ApiService);
  items = signal<Product[]>([]); categories = signal<Category[]>([]);
  editing = signal<string | null>(null); error = signal('');
  form: ProductInput = blank();
  constructor() { this.load(); this.api.categories().subscribe((c) => this.categories.set(c)); }
  load() { this.api.products().subscribe((p) => this.items.set(p)); }
  edit(p: Product) { const { id, ...rest } = p; this.editing.set(id); this.form = { ...blank(), ...rest, images: [...(p.images ?? [])] }; }
  reset() { this.editing.set(null); this.form = blank(); this.error.set(''); }
  save() {
    const id = this.editing();
    const body = { ...this.form, price: Number(this.form.price), stock: Number(this.form.stock) };
    const req = id ? this.api.updateProduct(id, body) : this.api.createProduct(body);
    req.subscribe({ next: () => { this.reset(); this.load(); }, error: (e) => this.error.set(e.error?.message ?? e.error?.error ?? 'Save failed') });
  }
  remove(p: Product) { this.api.deleteProduct(p.id).subscribe(() => this.load()); }
  pick(ev: Event) {
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (!file) return;
    this.api.upload(file).subscribe({
      next: (r) => { this.form.images = [...(this.form.images ?? []), r.url]; },
      error: (e) => this.error.set(e.error?.error ?? 'Upload failed'),
    });
  }
}

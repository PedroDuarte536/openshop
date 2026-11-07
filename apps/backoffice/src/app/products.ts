import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ART } from '@openshop/renderer';
import { ApiService, Category, Product, ProductInput } from './api.service';

const blank = (): ProductInput => ({ name: '', price: 0, active: true, stock: 0, categoryId: null, description: '', images: [] });
const ARTS = Object.values(ART);

@Component({
  selector: 'app-products',
  imports: [FormsModule],
  template: `
    <header class="page-h">
      <div><h1>Products</h1><p>{{ items().length }} {{ items().length === 1 ? 'product' : 'products' }} in your catalogue</p></div>
      <button class="btn primary" (click)="openNew()">+ New product</button>
    </header>

    <div class="toolbar">
      <input class="inp search" type="search" placeholder="Search by name" [ngModel]="q()" (ngModelChange)="q.set($event)" aria-label="Search products">
      <select class="inp" [ngModel]="cat()" (ngModelChange)="cat.set($event)" aria-label="Filter by category">
        <option value="">All categories</option>
        @for (c of categories(); track c.id) { <option [value]="c.id">{{ c.name }}</option> }
      </select>
    </div>

    <div class="card">
      @if (shown().length) {
        <table class="tbl">
          <thead><tr><th>Product</th><th>Price</th><th>Stock</th><th>Status</th><th></th></tr></thead>
          <tbody>
            @for (p of shown(); track p.id) {
              <tr>
                <td>
                  <div class="who">
                    @if (p.images?.[0]) { <img class="thumb" [src]="p.images![0]" alt=""> } @else { <span class="thumb" [style.background]="art(p)"></span> }
                    <div><div class="cell-main">{{ p.name }}</div><div class="cell-sub">{{ catName(p) }}</div></div>
                  </div>
                </td>
                <td class="cell-main">€{{ p.price.toFixed(2) }}</td>
                <td>
                  @if (p.stock <= 0) { <span class="pill bad">Out of stock</span> }
                  @else if (p.stock <= 3) { <span class="pill warn">{{ p.stock }} left</span> }
                  @else { {{ p.stock }} }
                </td>
                <td><span class="pill" [class.ok]="p.active">{{ p.active ? 'Visible' : 'Hidden' }}</span></td>
                <td><div class="acts">
                  <button class="btn sm" (click)="edit(p)">Edit</button>
                  <button class="btn sm danger" [class.armed]="armed() === p.id" (click)="remove(p)">{{ armed() === p.id ? 'Click to confirm' : 'Delete' }}</button>
                </div></td>
              </tr>
            }
          </tbody>
        </table>
      } @else {
        <div class="empty-state">
          @if (items().length) { <b>No products match</b>Try a different search or category. }
          @else { <b>Add your first product</b>Products appear in your shop, on category pages and in search. <br><br><button class="btn primary" (click)="openNew()">+ New product</button> }
        </div>
      }
    </div>

    @if (open()) {
      <div class="drawer-back" (click)="close()"></div>
      <form class="drawer" (ngSubmit)="save()" role="dialog" aria-modal="true" [attr.aria-label]="editing() ? 'Edit product' : 'New product'">
        <div class="drawer-h"><h2>{{ editing() ? 'Edit product' : 'New product' }}</h2><button type="button" class="btn ghost sm" (click)="close()" aria-label="Close">✕</button></div>
        <div class="drawer-b">
          <label class="fld req"><span>Name</span><input class="inp" name="name" [(ngModel)]="form.name" required placeholder="e.g. Linen mug"></label>
          <div class="fgrid">
            <label class="fld req"><span>Price</span><div class="affix"><b>€</b><input class="inp" name="price" type="number" step="0.01" min="0" [(ngModel)]="form.price" required></div></label>
            <label class="fld req"><span>Stock</span><input class="inp" name="stock" type="number" step="1" min="0" [(ngModel)]="form.stock" required><small>How many you can sell right now</small></label>
          </div>
          <label class="fld"><span>Category</span>
            <select class="inp" name="cat" [(ngModel)]="form.categoryId">
              <option [ngValue]="null">No category</option>
              @for (c of categories(); track c.id) { <option [ngValue]="c.id">{{ c.name }}</option> }
            </select>
          </label>
          <label class="fld"><span>Description</span><textarea class="inp" name="desc" [(ngModel)]="form.description" placeholder="What makes it special? Shown on the product page."></textarea></label>
          <div class="fld"><span class="lbl">Photos</span>
            <div class="photos">
              @for (img of form.images; track img; let i = $index) {
                <div class="photo" [class.main]="i === 0"><img [src]="img" alt=""><button type="button" (click)="removePhoto(i)" aria-label="Remove photo">✕</button></div>
              }
              <label class="dropzone">+ Add<input type="file" hidden multiple accept="image/png,image/jpeg,image/webp,image/gif" (change)="pick($event)"></label>
            </div>
            <small>The first photo is the main one. PNG, JPEG, WebP or GIF, up to 5 MB each.</small>
          </div>
          <label class="sw"><span><b>Visible in the shop</b><small>Turn off to hide it without deleting</small></span><input type="checkbox" name="active" [(ngModel)]="form.active"><i></i></label>
          @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
        </div>
        <div class="drawer-f"><button type="button" class="btn" (click)="close()">Cancel</button><button class="btn primary" [disabled]="saving()">{{ saving() ? 'Saving…' : editing() ? 'Save changes' : 'Create product' }}</button></div>
      </form>
    }`,
})
export class Products {
  private api = inject(ApiService);
  items = signal<Product[]>([]); categories = signal<Category[]>([]);
  q = signal(''); cat = signal('');
  open = signal(false); editing = signal<string | null>(null); saving = signal(false); error = signal(''); armed = signal('');
  form: ProductInput = blank();
  shown = computed(() => {
    const q = this.q().trim().toLowerCase(), c = this.cat();
    return this.items().filter((p) => (!q || p.name.toLowerCase().includes(q)) && (!c || p.categoryId === c));
  });
  constructor() { this.load(); this.api.categories().subscribe((c) => this.categories.set(c)); }
  load() { this.api.products().subscribe((p) => this.items.set(p)); }
  catName(p: Product) { return this.categories().find((c) => c.id === p.categoryId)?.name ?? 'No category'; }
  art(p: Product) { return ARTS[p.name.length % ARTS.length].css; }
  openNew() { this.editing.set(null); this.form = blank(); this.error.set(''); this.open.set(true); }
  edit(p: Product) { const { id, ...rest } = p; this.editing.set(id); this.form = { ...blank(), ...rest, images: [...(p.images ?? [])] }; this.error.set(''); this.open.set(true); }
  close() { this.open.set(false); }
  save() {
    const id = this.editing();
    const body = { ...this.form, price: Number(this.form.price), stock: Math.round(Number(this.form.stock)) };
    this.saving.set(true); this.error.set('');
    (id ? this.api.updateProduct(id, body) : this.api.createProduct(body)).subscribe({
      next: () => { this.saving.set(false); this.close(); this.load(); },
      error: (e) => { this.saving.set(false); this.error.set(e.error?.message ?? e.error?.error ?? 'Could not save. Check the fields and try again.'); },
    });
  }
  remove(p: Product) {
    if (this.armed() !== p.id) { this.armed.set(p.id); setTimeout(() => { if (this.armed() === p.id) this.armed.set(''); }, 3500); return; }
    this.api.deleteProduct(p.id).subscribe(() => { this.armed.set(''); this.load(); });
  }
  removePhoto(i: number) { this.form.images = (this.form.images ?? []).filter((_, j) => j !== i); }
  pick(ev: Event) {
    const input = ev.target as HTMLInputElement;
    for (const file of Array.from(input.files ?? [])) {
      this.api.upload(file).subscribe({
        next: (r) => { this.form.images = [...(this.form.images ?? []), r.url]; },
        error: (e) => this.error.set(e.error?.error ?? 'That image could not be uploaded'),
      });
    }
    input.value = '';
  }
}

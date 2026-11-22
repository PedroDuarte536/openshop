import { ChangeDetectorRef, Component, effect, inject, input, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService, AttributeDef, AttrValue, BundleSpec, Category, Product, ProductInput, ProductSummary } from '../api.service';
import { ProductPicker } from '../shared/product-picker';
import { VariantsPanel } from './variants-panel';
import { VariantDialog } from './variant-dialog';

interface Comp { productId: string; qty: number; name: string; price: number; available: number; deleted: boolean; active: boolean }
interface Form {
  name: string; sku: string; price: number | null; stock: number; categoryId: string | null; description: string; images: string[]; active: boolean;
  type: 'simple' | 'bundle'; attributes: Record<string, AttrValue | '' | null>; components: Comp[];
  priceMode: 'sum' | 'manual'; offerScope: 'targeted' | 'all'; showOnComponents: boolean;
}
const blank = (): Form => ({
  name: '', sku: '', price: 0, stock: 0, categoryId: null, description: '', images: [], active: true,
  type: 'simple', attributes: {}, components: [], priceMode: 'sum', offerScope: 'targeted', showOnComponents: true,
});
const cents = (n: number | null | undefined) => Math.round((Number(n) || 0) * 100);

/** The product drawer: details, photos, properties and (for bundles) contents and price. */
@Component({
  selector: 'app-product-editor',
  imports: [FormsModule, RouterLink, ProductPicker, VariantsPanel, VariantDialog],
  template: `
    <div class="drawer-back" (click)="close()"></div>
    <form class="drawer wide" (ngSubmit)="save()" role="dialog" aria-modal="true" [attr.aria-label]="productId() ? 'Edit product' : 'New product'">
      <div class="drawer-h"><h2>{{ productId() ? 'Edit product' : 'New product' }}</h2><button type="button" class="btn ghost sm" (click)="close()" aria-label="Close">✕</button></div>
      @if (loading()) { <div class="drawer-b"><p class="hint">Loading…</p></div> } @else {
      <div class="drawer-b">
        <div class="seg" role="group" aria-label="Product type">
          <button type="button" [class.on]="f.type === 'simple'" (click)="setType('simple')">Single product</button>
          <button type="button" [class.on]="f.type === 'bundle'" (click)="setType('bundle')">Bundle</button>
        </div>
        <label class="fld req"><span>Name</span><input class="inp" name="name" [(ngModel)]="f.name" required [placeholder]="f.type === 'bundle' ? 'e.g. Breakfast set' : 'e.g. Linen mug'"></label>
        @if (f.type === 'simple') {
          <div class="fgrid three">
            <label class="fld req"><span>Price</span><div class="affix"><b>€</b><input class="inp" name="price" type="number" step="0.01" min="0" [(ngModel)]="f.price" required></div></label>
            <label class="fld req"><span>Stock</span><input class="inp" name="stock" type="number" step="1" min="0" [(ngModel)]="f.stock" required><small>How many you can sell now</small></label>
            <label class="fld"><span>SKU</span><input class="inp mono" name="sku" [(ngModel)]="f.sku" placeholder="Optional" maxlength="64"><small>Your own reference</small></label>
          </div>
        } @else {
          <section class="bundle-box" aria-label="Bundle contents">
            <h3>What's in the bundle</h3>
            @if (f.components.length) {
              <table class="tbl mini">
                <thead><tr><th>Product</th><th class="num">Price</th><th>Qty</th><th class="num">In stock</th><th></th></tr></thead>
                <tbody>
                  @for (c of f.components; track c.productId; let i = $index) {
                    <tr>
                      <td>{{ c.name }}@if (c.deleted) { <span class="pill bad">deleted</span> } @else if (!c.active) { <span class="pill">hidden</span> }</td>
                      <td class="num">€{{ c.price.toFixed(2) }}</td>
                      <td><input class="inp qty" type="number" min="1" max="99" step="1" [name]="'qty' + i" [(ngModel)]="c.qty" [attr.aria-label]="'Quantity of ' + c.name"></td>
                      <td class="num">{{ c.available }}</td>
                      <td><button type="button" class="btn sm ghost" (click)="removeComp(i)" [attr.aria-label]="'Remove ' + c.name">✕</button></td>
                    </tr>
                  }
                </tbody>
              </table>
            } @else { <p class="hint-top">Add at least two products. Each product can be added once; use the quantity for more.</p> }
            <app-product-picker [single]="true" placeholder="Add a product to the bundle" [params]="{ type: 'simple' }" [exclude]="compIds()" (picked)="addComp($event)" />
            @if (availability(); as a) { <p class="hint">Available now: <b>{{ a.n }}</b>@if (a.by) {<span> (limited by {{ a.by }})</span>}. Selling a bundle takes its products from stock.</p> }

            <h3 class="mt2">Price</h3>
            <div class="fgrid">
              <label class="fld req"><span>Bundle price</span><div class="affix"><b>€</b>
                <input class="inp" name="bprice" type="number" step="0.01" min="0" [ngModel]="f.priceMode === 'sum' ? sum() / 100 : f.price" (ngModelChange)="setManual($event)" required></div>
                @if (f.priceMode === 'sum') { <small><span class="tag">Sum of products</span> Updates when a product's price changes.</small> }
              </label>
              <label class="fld"><span>SKU</span><input class="inp mono" name="sku" [(ngModel)]="f.sku" placeholder="Optional" maxlength="64"></label>
            </div>
            @if (f.priceMode === 'manual') {
              <p class="note-box">Original price €{{ (sum() / 100).toFixed(2) }} · your price €{{ (+(f.price ?? 0)).toFixed(2) }} = <b>{{ percent() }}%</b> of it ({{ savingText() }})
                <button type="button" class="btn sm" (click)="resetPrice()">Reset to sum</button></p>
              @for (w of priceWarnings(); track w) { <p class="warn-box">{{ w }}</p> }
            }
            <label class="sw"><span><b>Shop-wide and category offers also apply</b><small>Off: only offers made for this bundle apply (a bundle is usually already a deal). It still counts towards order minimums such as "orders over €100".</small></span><input type="checkbox" name="offerScope" [ngModel]="f.offerScope === 'all'" (ngModelChange)="f.offerScope = $event ? 'all' : 'targeted'"><i></i></label>
            <label class="sw"><span><b>Show on its products' pages</b><small>"As seen in these bundles" on the pages of the products inside</small></span><input type="checkbox" name="showOn" [(ngModel)]="f.showOnComponents"><i></i></label>
            @if (productId()) { <p><a class="btn sm" [routerLink]="['/discounts/new']" [queryParams]="{ product: productId() }">Create an offer for this bundle</a></p> }
          </section>
        }
        <label class="fld"><span>Category</span>
          <select class="inp" name="cat" [(ngModel)]="f.categoryId">
            <option [ngValue]="null">No category</option>
            @for (c of categories(); track c.id) { <option [ngValue]="c.id">{{ c.name }}</option> }
          </select>
        </label>
        <label class="fld"><span>Description</span><textarea class="inp" name="desc" [(ngModel)]="f.description" placeholder="What makes it special? Shown on the product page."></textarea></label>
        <div class="fld"><span class="lbl">Photos</span>
          <div class="photos">
            @for (img of f.images; track img; let i = $index) {
              <div class="photo" [class.main]="i === 0"><img [src]="img" alt=""><button type="button" (click)="removePhoto(i)" aria-label="Remove photo">✕</button></div>
            }
            <label class="dropzone">+ Add<input type="file" hidden multiple accept="image/png,image/jpeg,image/webp,image/gif" (change)="pick($event)"></label>
          </div>
          <small>The first photo is the main one. PNG, JPEG, WebP or GIF, up to {{ uploadMaxMb() }} MB each.</small>
        </div>
        @if (defs().length) {
          <fieldset class="props">
            <legend>Properties</legend>
            @for (d of defs(); track d.key) {
              <label class="fld"><span>{{ d.label }}@if (d.visibility === 'internal') { <small class="tag">internal</small> }</span>
                @switch (d.type) {
                  @case ('choice') {
                    <select class="inp" [name]="'a_' + d.key" [attr.aria-label]="d.label" [(ngModel)]="f.attributes[d.key]"><option [ngValue]="''">-</option>@for (o of d.options ?? []; track o.value) { <option [ngValue]="o.value">{{ o.label }}</option> }</select>
                  }
                  @case ('multi') {
                    <span class="multi">@for (o of d.options ?? []; track o.value) { <label class="chk"><input type="checkbox" [checked]="has(d.key, o.value)" (change)="toggleMulti(d.key, o.value)"> {{ o.label }}</label> }</span>
                  }
                  @case ('boolean') {
                    <select class="inp" [name]="'a_' + d.key" [attr.aria-label]="d.label" [(ngModel)]="f.attributes[d.key]"><option [ngValue]="''">-</option><option [ngValue]="true">Yes</option><option [ngValue]="false">No</option></select>
                  }
                  @case ('number') {
                    <div class="affix suffix"><input class="inp" type="number" step="any" [name]="'a_' + d.key" [attr.aria-label]="d.label" [(ngModel)]="f.attributes[d.key]">@if (d.unit) { <b>{{ d.unit }}</b> }</div>
                  }
                  @default { <input class="inp" [name]="'a_' + d.key" [attr.aria-label]="d.label" [(ngModel)]="f.attributes[d.key]" maxlength="200"> }
                }
              </label>
            }
            <small class="hint"><a routerLink="/products/properties" (click)="close()">Manage properties</a></small>
          </fieldset>
        }
        @if (productId() && f.type === 'simple') {
          <fieldset class="props">
            <legend>Variants</legend>
            @if (variantGroupId(); as gid) {
              <app-variants-panel [groupId]="gid" [productId]="productId()" (open)="openProduct.emit($event)" (changed)="refreshVariant()" />
            } @else {
              <p class="hint-top">Link this product with others that differ by colour, size… Shoppers then switch between them on the product page.</p>
              <p><button type="button" class="btn sm" (click)="linking.set(true)">Link variants…</button></p>
            }
          </fieldset>
        }
        <label class="sw"><span><b>Visible in the shop</b><small>Turn off to hide it. Hidden products can be deleted.</small></span><input type="checkbox" name="active" [(ngModel)]="f.active"><i></i></label>
        @if (error()) { <div class="alert" role="alert">{{ error() }}</div> }
      </div>
      <div class="drawer-f"><button type="button" class="btn" (click)="close()">Cancel</button><button class="btn primary" [disabled]="saving()">{{ saving() ? 'Saving…' : productId() ? 'Save changes' : f.type === 'bundle' ? 'Create bundle' : 'Create product' }}</button></div>
      }
    </form>
    @if (linking()) { <app-variant-dialog [productIds]="[productId()!]" (closed)="linking.set(false)" (saved)="linking.set(false); refreshVariant()" /> }`,
})
export class ProductEditor {
  private api = inject(ApiService);
  private cdr = inject(ChangeDetectorRef);
  productId = input<string | null>(null);
  categories = input<Category[]>([]);
  closed = output<void>();
  saved = output<Product>();
  /** Open another product (a variant) in the editor. */
  openProduct = output<string>();
  variantGroupId = signal<string | null>(null);
  linking = signal(false);
  f: Form = blank();
  defs = signal<AttributeDef[]>([]);
  uploadMaxMb = signal(5);
  loading = signal(true); saving = signal(false); error = signal('');
  private version: number | undefined;
  // The form is a plain object edited through ngModel, so these are recalculated on every render (cheap).
  compIds() { return [...this.f.components.map((c) => c.productId), ...(this.productId() ? [this.productId()!] : [])]; }
  sum() { return this.f.components.reduce((a, c) => a + cents(c.price) * (Number(c.qty) || 0), 0); }
  percent() { const s = this.sum(); return s ? Math.round((cents(this.f.price) / s) * 100) : 0; }
  availability() {
    if (!this.f.components.length) return null;
    let n = Infinity, by = '';
    for (const c of this.f.components) { const k = Math.floor(c.available / Math.max(1, Number(c.qty) || 1)); if (k < n) { n = k; by = c.name; } }
    return { n: Number.isFinite(n) ? n : 0, by: this.f.components.length > 1 ? by : '' };
  }

  constructor() {
    effect(() => { const id = this.productId(); untracked(() => this.load(id)); });
    this.api.catalogueLimits().subscribe({ next: (l) => this.uploadMaxMb.set(l.uploadMaxMb), error: () => undefined });
  }

  private load(id: string | null) {
    this.loading.set(true); this.error.set('');
    this.api.attributes().subscribe((d) => this.defs.set(d));
    if (!id) { this.f = blank(); this.version = undefined; this.variantGroupId.set(null); this.loading.set(false); return; }
    this.api.product(id).subscribe({
      next: (p) => this.fill(p),
      error: () => { this.error.set('This product could not be loaded.'); this.loading.set(false); },
    });
  }

  /** Variant changes touch the product (group, position, version): reload those, keep the form as it is. */
  refreshVariant() {
    const id = this.productId();
    if (id) this.api.product(id).subscribe((p) => { this.version = p.version; this.variantGroupId.set(p.variantGroupId ?? null); });
  }

  private fill(p: Product) {
    this.version = p.version;
    this.variantGroupId.set(p.variantGroupId ?? null);
    const b = p.bundle;
    this.f = {
      name: p.name, sku: p.sku ?? '', price: p.price, stock: p.stock, categoryId: p.categoryId ?? null, description: p.description ?? '', images: [...(p.images ?? [])],
      active: p.active, type: p.type ?? 'simple', attributes: { ...(p.attributes ?? {}) }, components: [],
      priceMode: b?.priceMode ?? 'sum', offerScope: b?.offerScope ?? 'targeted', showOnComponents: b?.showOnComponents ?? true,
    };
    if (b?.components.length) {
      this.api.lookupProducts(b.components.map((c) => c.productId)).subscribe((r) => {
        const by = new Map(r.items.map((x) => [x.id, x]));
        this.f.components = b.components.map((c) => { const x = by.get(c.productId); return { productId: c.productId, qty: c.qty, name: x?.name ?? 'Unknown product', price: x?.price ?? 0, available: x?.available ?? 0, deleted: !x || x.deleted, active: !!x?.active }; });
        this.loading.set(false);
      });
    } else { this.loading.set(false); }
  }

  setType(t: 'simple' | 'bundle') { this.f.type = t; }
  addComp(p: ProductSummary) {
    if (this.f.components.some((c) => c.productId === p.id)) return;
    this.f.components = [...this.f.components, { productId: p.id, qty: 1, name: p.name, price: p.price, available: p.available, deleted: p.deleted, active: p.active }];
   
  }
  removeComp(i: number) { this.f.components = this.f.components.filter((_, j) => j !== i); }
  setManual(v: number | null) {
    if (this.f.priceMode === 'sum' && cents(v) === this.sum()) return;
    this.f.priceMode = 'manual'; this.f.price = v;
  }
  resetPrice() { this.f.priceMode = 'sum'; this.f.price = this.sum() / 100; }
  savingText() { const p = 100 - this.percent(); return p > 0 ? `−${p}%` : p < 0 ? `+${-p}%` : 'same as the products'; }
  priceWarnings(): string[] {
    const price = cents(this.f.price), s = this.sum(), out: string[] = [];
    if (price === 0) out.push('The price is 0: the bundle would be free.');
    else if (price > s) out.push('The bundle costs more than buying its products separately.');
    else if (price < s / 2) out.push('The bundle costs less than half of its products. Double-check the price.');
    return out;
  }
  has(key: string, v: string) { const x = this.f.attributes[key]; return Array.isArray(x) && x.includes(v); }
  toggleMulti(key: string, v: string) {
    const cur = Array.isArray(this.f.attributes[key]) ? [...(this.f.attributes[key] as string[])] : [];
    this.f.attributes[key] = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
  }
  removePhoto(i: number) { this.f.images = this.f.images.filter((_, j) => j !== i); }
  pick(ev: Event) {
    const el = ev.target as HTMLInputElement;
    for (const file of Array.from(el.files ?? [])) {
      this.api.upload(file).subscribe({
        next: (r) => { this.f.images = [...this.f.images, r.url].slice(0, 10); this.cdr.markForCheck(); },
        error: (e) => this.error.set(e.error?.error ?? 'Upload failed'),
      });
    }
    el.value = '';
  }
  close() { this.closed.emit(); }

  body(): ProductInput {
    const attrs: Record<string, AttrValue> = {};
    for (const d of this.defs()) {
      const v = this.f.attributes[d.key];
      if (v === '' || v === null || v === undefined || (Array.isArray(v) && !v.length)) continue;
      attrs[d.key] = d.type === 'number' ? Number(v) : v;
    }
    const base: ProductInput = {
      name: this.f.name, sku: this.f.sku.trim() || null, categoryId: this.f.categoryId, description: this.f.description, images: this.f.images,
      active: this.f.active, type: this.f.type, attributes: attrs,
    };
    if (this.f.type === 'simple') return { ...base, price: Number(this.f.price), stock: Math.round(Number(this.f.stock) || 0) };
    const bundle: BundleSpec = { components: this.f.components.map((c) => ({ productId: c.productId, qty: Math.round(Number(c.qty) || 1) })), priceMode: this.f.priceMode, offerScope: this.f.offerScope, showOnComponents: this.f.showOnComponents };
    return { ...base, bundle, ...(this.f.priceMode === 'manual' ? { price: Number(this.f.price) } : {}) };
  }

  save() {
    if (this.f.type === 'bundle' && this.f.priceMode === 'manual' && cents(this.f.price) === 0 && !confirm('The bundle price is 0. Save it as free?')) return;
    const id = this.productId();
    this.saving.set(true); this.error.set('');
    (id ? this.api.updateProduct(id, { ...this.body(), version: this.version }) : this.api.createProduct(this.body())).subscribe({
      next: (p) => { this.saving.set(false); this.saved.emit(p); },
      error: (e) => {
        this.saving.set(false);
        const fields = (e.error?.fields ?? []) as { field: string; message: string }[];
        this.error.set(fields.length ? fields.map((x) => `${x.field.replace(/^attributes\./, '')}: ${x.message}`).join(' · ') : e.error?.message ?? e.error?.error ?? 'Could not save. Check the fields and try again.');
      },
    });
  }
}

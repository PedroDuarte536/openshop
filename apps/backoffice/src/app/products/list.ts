import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ART } from '@openshop/renderer';
import { ApiService, Category, Facets, Product } from '../api.service';
import { ProductEditor } from './editor';
import { VariantDialog } from './variant-dialog';
import { UI } from '../config';

const ARTS = Object.values(ART);
const PER = UI.productPageSize;
type ListKey = 'status' | 'stock' | 'type' | 'category' | 'missing';

/**
 * Products: server-side search with filters and counts, sort, paging, bulk actions and export. Filters live in the
 * URL so a view can be bookmarked. Products are never removed: visible products can be hidden, hidden ones deleted
 * (after a confirmation page), and deleted ones restored from the "Deleted products" view.
 */
@Component({
  selector: 'app-products',
  imports: [FormsModule, RouterLink, ProductEditor, VariantDialog],
  template: `
    <header class="page-h">
      @if (deletedView()) {
        <div><h1>Deleted products</h1><p>{{ total() }} deleted {{ total() === 1 ? 'product' : 'products' }}. They stay in orders, bundles and offers that use them, and can be restored.</p></div>
        <button class="btn" (click)="setDeleted(false)">← Back to products</button>
      } @else {
        <div><h1>Products</h1><p>{{ total() }} {{ total() === 1 ? 'product' : 'products' }}{{ filtered() ? ' match' : ' in your catalogue' }}</p></div>
        <div class="acts-h">
          <a class="btn" routerLink="/products/properties">Properties</a>
          @if (manage) { <a class="btn" routerLink="/products/import">Import</a> }
          <details class="menu">
            <summary class="btn">Export ▾</summary>
            <div class="menu-b">
              <button type="button" (click)="exportAs('csv', ',')">Spreadsheet (CSV)</button>
              <button type="button" (click)="exportAs('csv', ';')">Spreadsheet (CSV with ; and decimal comma)</button>
              <button type="button" (click)="exportAs('json')">Full backup (JSON)</button>
              <small>Exports {{ selected().size ? 'the selected products' : filtered() ? 'the products matching your filters' : 'every product (the full backup also has deleted products, flagged)' }}.</small>
            </div>
          </details>
          @if (manage) { <button class="btn primary" (click)="openNew()">+ New product</button> }
        </div>
      }
    </header>

    <div class="toolbar">
      <input class="inp search" type="search" placeholder="Search by name, SKU, description or property" [value]="q()" (input)="typeQ($any($event.target).value)" aria-label="Search products">
      <select class="inp" [ngModel]="sort()" (ngModelChange)="set('sort', $event)" aria-label="Sort">
        @if (q()) { <option value="relevance">Best match</option> }
        <option value="name">Name A–Z</option><option value="-name">Name Z–A</option>
        <option value="price">Price, low to high</option><option value="-price">Price, high to low</option>
        <option value="stock">Stock, low to high</option><option value="-updated">Recently changed</option><option value="newest">Newest</option>
      </select>
      @if (filtered()) { <button class="btn ghost" (click)="clearFilters()">Clear filters</button> }
    </div>
    @if (corrected()) { <p class="hint-top">Showing results for <b>{{ corrected() }}</b></p> }

    <div class="catalogue">
      <aside class="facets" aria-label="Filters">
        @if (facets(); as fc) {
          @if (!deletedView()) {
            <fieldset><legend>Visibility</legend>
              <label class="chk"><input type="checkbox" [checked]="on('status', 'visible')" (change)="toggle('status', 'visible')"> Visible <small>{{ fc.status.visible }}</small></label>
              <label class="chk"><input type="checkbox" [checked]="on('status', 'hidden')" (change)="toggle('status', 'hidden')"> Hidden <small>{{ fc.status.hidden }}</small></label>
            </fieldset>
          }
          <fieldset><legend>Stock</legend>
            <label class="chk"><input type="checkbox" [checked]="on('stock', 'in')" (change)="toggle('stock', 'in')"> In stock <small>{{ fc.stock.in }}</small></label>
            <label class="chk"><input type="checkbox" [checked]="on('stock', 'low')" (change)="toggle('stock', 'low')"> Low ({{ lowStock }} or fewer) <small>{{ fc.stock.low }}</small></label>
            <label class="chk"><input type="checkbox" [checked]="on('stock', 'out')" (change)="toggle('stock', 'out')"> Out of stock <small>{{ fc.stock.out }}</small></label>
          </fieldset>
          <fieldset><legend>Type</legend>
            <label class="chk"><input type="checkbox" [checked]="on('type', 'simple')" (change)="toggle('type', 'simple')"> Single products <small>{{ fc.types.simple }}</small></label>
            <label class="chk"><input type="checkbox" [checked]="on('type', 'bundle')" (change)="toggle('type', 'bundle')"> Bundles <small>{{ fc.types.bundle }}</small></label>
            <label class="chk"><input type="checkbox" [checked]="params()['inVariantGroup'] === 'true'" (change)="set('inVariantGroup', $any($event.target).checked ? 'true' : '')"> In a variant group <small>{{ fc.variants }}</small></label>
          </fieldset>
          @if (fc.categories.length) {
            <fieldset><legend>Category</legend>
              @for (c of fc.categories; track c.id) {
                <label class="chk"><input type="checkbox" [checked]="on('category', c.id ?? 'none')" (change)="toggle('category', c.id ?? 'none')"> {{ c.name }} <small>{{ c.count }}</small></label>
              }
            </fieldset>
          }
          <fieldset><legend>Missing information</legend>
            <label class="chk"><input type="checkbox" [checked]="on('missing', 'image')" (change)="toggle('missing', 'image')"> No photo <small>{{ fc.missing.image }}</small></label>
            <label class="chk"><input type="checkbox" [checked]="on('missing', 'sku')" (change)="toggle('missing', 'sku')"> No SKU <small>{{ fc.missing.sku }}</small></label>
            <label class="chk"><input type="checkbox" [checked]="on('missing', 'category')" (change)="toggle('missing', 'category')"> No category <small>{{ fc.missing.category }}</small></label>
            <label class="chk"><input type="checkbox" [checked]="on('missing', 'description')" (change)="toggle('missing', 'description')"> No description <small>{{ fc.missing.description }}</small></label>
          </fieldset>
          @for (a of fc.attributes; track a.key) {
            <fieldset><legend>{{ a.label }}</legend>
              @for (v of (expanded().has(a.key) ? a.values : a.values.slice(0, 8)); track v.value) {
                <label class="chk"><input type="checkbox" [checked]="attrOn(a.key, v.value)" (change)="toggleAttr(a.key, v.value)">@if (v.swatch) { <i class="sw-dot" [style.background]="v.swatch"></i> } {{ v.label }} <small>{{ v.count }}</small></label>
              }
              @if (a.values.length > 8 && !expanded().has(a.key)) { <button type="button" class="btn sm ghost" (click)="expand(a.key)">Show all {{ a.values.length }}</button> }
            </fieldset>
          }
          <fieldset><legend>Price (€)</legend>
            <div class="range"><input class="inp" type="number" min="0" step="0.01" placeholder="Min" [value]="params()['min'] ?? ''" (change)="set('min', $any($event.target).value)" aria-label="Minimum price">
              <input class="inp" type="number" min="0" step="0.01" placeholder="Max" [value]="params()['max'] ?? ''" (change)="set('max', $any($event.target).value)" aria-label="Maximum price"></div>
          </fieldset>
        }
      </aside>

      <div>
        @if (selected().size) {
          <div class="bulkbar" role="region" aria-label="Selected products">
            <b>{{ selected().size }} selected</b>
            <button class="btn sm" (click)="bulk('show')">Show in shop</button>
            <button class="btn sm" (click)="bulk('hide')">Hide</button>
            <select class="inp sm" [ngModel]="''" (ngModelChange)="moveTo($event)" aria-label="Move to category">
              <option value="" disabled>Move to category…</option>
              <option value="none">No category</option>
              @for (c of categories(); track c.id) { <option [value]="c.id">{{ c.name }}</option> }
            </select>
            @if (selected().size >= 2) { <button class="btn sm" (click)="linking.set(true)">Link as variants</button> }
            <button class="btn sm ghost" (click)="clearSelection()">Clear selection</button>
          </div>
        }
        @if (message()) { <p class="ok-msg" role="status">{{ message() }}</p> }
        <div class="card">
          @if (items().length) {
            <table class="tbl">
              <thead><tr>
                @if (manage) { <th class="w-chk"><input type="checkbox" [checked]="allOnPage()" (change)="selectPage($any($event.target).checked)" aria-label="Select all on this page"></th> }
                <th>Product</th><th class="num">Price</th><th>Stock</th><th>Status</th><th></th>
              </tr></thead>
              <tbody>
                @for (p of items(); track p.id) {
                  <tr>
                    @if (manage) { <td class="w-chk"><input type="checkbox" [checked]="selected().has(p.id)" (change)="select(p.id, $any($event.target).checked)" [attr.aria-label]="'Select ' + p.name"></td> }
                    <td>
                      <div class="who">
                        @if (p.images?.[0]) { <img class="thumb" [src]="p.images![0]" alt=""> } @else { <span class="thumb" [style.background]="art(p)"></span> }
                        <div>
                          <div class="cell-main">{{ p.name }}</div>
                          <div class="cell-sub">@if (p.sku) { <span class="mono">{{ p.sku }}</span> · } {{ catName(p) }}
                            @if (p.type === 'bundle') { <span class="tag">Bundle</span> }
                            @if (p.extras?.variantGroup; as g) { <span class="tag" [title]="'Variant group ' + g.name">Variants: {{ g.name }}</span> }
                            @if (p.extras?.containsDeleted) { <span class="pill bad">contains a deleted product</span> }
                          </div>
                        </div>
                      </div>
                    </td>
                    <td class="num cell-main">€{{ p.price.toFixed(2) }}
                      @if (p.type === 'bundle' && p.extras?.componentsTotal) { <div class="cell-sub">{{ p.bundle?.priceMode === 'sum' ? 'sum of products' : pct(p) + '% of €' + p.extras!.componentsTotal!.toFixed(2) }}</div> }
                    </td>
                    <td>
                      @let n = p.extras?.available ?? p.stock;
                      @if (stockEdit() === p.id) {
                        <form class="stock-edit" (ngSubmit)="saveStock(p)"><input class="inp" type="number" min="0" step="1" name="stock" [(ngModel)]="stockValue" aria-label="Stock"><button class="btn sm primary">Save</button><button type="button" class="btn sm ghost" (click)="stockEdit.set('')">Cancel</button></form>
                      } @else {
                      @if (n <= 0) { <span class="pill bad">Out of stock</span> }
                      @else if (n <= lowStock) { <span class="pill warn">{{ n }} left</span> }
                      @else { {{ n }} }
                      }
                      @if (p.type === 'bundle' && p.extras?.limitedBy) { <div class="cell-sub">limited by {{ p.extras!.limitedBy!.name }}</div> }
                    </td>
                    <td>@if (p.deletedAt) { <span class="pill bad">Deleted</span> } @else { <span class="pill" [class.ok]="p.active">{{ p.active ? 'Visible' : 'Hidden' }}</span> }</td>
                    <td><div class="acts">
                      @if (manage) {
                        @if (p.deletedAt) {
                          <button class="btn sm" (click)="restore(p)">Restore</button>
                        } @else {
                          <button class="btn sm" (click)="edit(p)">Edit</button>
                          @if (p.active) { <button class="btn sm" (click)="setActive(p, false)">Hide</button> }
                          @else {
                            <button class="btn sm" (click)="setActive(p, true)">Show</button>
                            <a class="btn sm danger" [routerLink]="['/products', p.id, 'delete']">Delete</a>
                          }
                        }
                      } @else if (stockOnly && !p.deletedAt && p.type !== 'bundle') { <button class="btn sm" (click)="editStock(p)">Update stock</button> }
                    </div></td>
                  </tr>
                }
              </tbody>
            </table>
          } @else if (!loading()) {
            <div class="empty-state">
              @if (deletedView()) { <b>No deleted products</b>Products you delete appear here and can be restored. }
              @else if (filtered()) { <b>No products match</b>Try a different search or fewer filters. }
              @else { <b>{{ manage ? 'Add your first product' : 'No products yet' }}</b>Products appear in your shop, on category pages and in search. @if (manage) { <br><br><button class="btn primary" (click)="openNew()">+ New product</button> <a class="btn" routerLink="/products/import">Import a file</a> } }
            </div>
          }
        </div>
        @if (total() > per) {
          <nav class="pager" aria-label="Pages">
            <button class="btn sm" [disabled]="page() <= 1" (click)="goPage(page() - 1)">← Previous</button>
            <span>{{ (page() - 1) * per + 1 }}–{{ min(page() * per, total()) }} of {{ total() }}</span>
            <button class="btn sm" [disabled]="page() * per >= total()" (click)="goPage(page() + 1)">Next →</button>
          </nav>
        }
        @if (!deletedView() && (facets()?.status?.deleted ?? 0) > 0) {
          <p class="discreet"><button class="btn ghost sm" (click)="setDeleted(true)">Deleted products ({{ facets()!.status.deleted }})</button></p>
        }
        @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
      </div>
    </div>

    @if (editorOpen()) {
      <app-product-editor [productId]="editing()" [categories]="categories()" (closed)="editorOpen.set(false); reload()" (saved)="onSaved()" (openProduct)="editing.set($event)" />
    }
    @if (linking()) {
      <app-variant-dialog [productIds]="selectedIds()" (closed)="linking.set(false)" (saved)="onLinked($event.name)" />
    }`,
})
export class Products {
  private api = inject(ApiService);
  /** Full editing, or only stock levels (e.g. fulfilment staff). */
  manage = this.api.can('catalog.manage');
  stockOnly = this.api.can('catalog.stock');
  stockEdit = signal(''); stockValue = 0;
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  readonly per = PER;
  readonly lowStock = UI.lowStock;
  /** The current search, as URL query parameters. */
  params = signal<Record<string, string>>({});
  q = signal('');
  items = signal<Product[]>([]); total = signal(0); facets = signal<Facets | null>(null); corrected = signal<string | null>(null);
  categories = signal<Category[]>([]);
  loading = signal(true); error = signal(''); message = signal('');
  selected = signal(new Set<string>());
  expanded = signal(new Set<string>());
  editorOpen = signal(false); editing = signal<string | null>(null);
  linking = signal(false);
  selectedIds = computed(() => [...this.selected()]);
  sort = computed(() => this.params()['sort'] ?? (this.q() ? 'relevance' : 'name'));
  page = computed(() => Math.max(1, Number(this.params()['page']) || 1));
  deletedView = computed(() => this.params()['status'] === 'deleted');
  filtered = computed(() => Object.keys(this.params()).some((k) => !['sort', 'page'].includes(k) && !(k === 'status' && this.deletedView())));
  allOnPage = computed(() => this.items().length > 0 && this.items().every((p) => this.selected().has(p.id)));
  private timer: ReturnType<typeof setTimeout> | undefined;
  private seq = 0;

  constructor() {
    const qp = this.route.snapshot.queryParamMap;
    const init: Record<string, string> = {};
    for (const k of qp.keys) init[k] = qp.get(k) ?? '';
    const edit = init['edit'];
    delete init['edit'];
    this.params.set(init);
    this.q.set(init['q'] ?? '');
    if (edit) { this.editing.set(edit); this.editorOpen.set(true); }
    this.api.categories().subscribe((c) => this.categories.set(c));
    effect(() => { const p = this.params(); untracked(() => this.load(p)); });
  }

  private load(p: Record<string, string>) {
    const n = ++this.seq;
    this.loading.set(true);
    const { page, ...rest } = p;
    const query: Record<string, string> = { ...rest, limit: String(PER), skip: String((Math.max(1, Number(page) || 1) - 1) * PER) };
    this.api.searchProducts(query).subscribe({
      next: (r) => {
        if (n !== this.seq) return;
        this.items.set(r.items); this.total.set(r.total); this.facets.set(r.facets ?? null); this.corrected.set(r.corrected ?? null);
        this.loading.set(false); this.error.set('');
      },
      error: (e) => { if (n === this.seq) { this.loading.set(false); this.error.set(e.error?.error ?? 'Products could not be loaded.'); } },
    });
    this.router.navigate([], { relativeTo: this.route, queryParams: p, replaceUrl: true });
  }

  /** Sets (or clears, with '') one parameter; any change but paging goes back to page 1. */
  set(key: string, value: string) {
    const next = { ...this.params() };
    if (value === '' || value === undefined || value === null) delete next[key]; else next[key] = value;
    if (key !== 'page') delete next['page'];
    this.params.set(next);
  }
  typeQ(v: string) { this.q.set(v); clearTimeout(this.timer); this.timer = setTimeout(() => this.set('q', v.trim()), UI.searchDebounceMs); }
  values(key: string) { return (this.params()[key] ?? '').split(',').filter(Boolean); }
  on(key: ListKey, v: string) { return this.values(key).includes(v); }
  toggle(key: ListKey, v: string) { const cur = this.values(key); this.set(key, (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]).join(',')); }
  attrOn(key: string, v: string) { return this.values(`f.${key}`).includes(v); }
  toggleAttr(key: string, v: string) { const cur = this.values(`f.${key}`); this.set(`f.${key}`, (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]).join(',')); }
  expand(key: string) { this.expanded.update((s) => new Set([...s, key])); }
  clearFilters() { this.q.set(''); this.params.set(this.deletedView() ? { status: 'deleted' } : {}); }
  setDeleted(on: boolean) { this.selected.set(new Set()); this.q.set(''); this.params.set(on ? { status: 'deleted' } : {}); }
  goPage(n: number) { this.set('page', String(n)); }
  min = Math.min;

  catName(p: Product) { return this.categories().find((c) => c.id === p.categoryId)?.name ?? 'No category'; }
  art(p: Product) { return ARTS[p.name.length % ARTS.length].css; }
  pct(p: Product) { const t = p.extras?.componentsTotal; return t ? Math.round((p.price / t) * 100) : 0; }

  clearSelection() { this.selected.set(new Set()); }
  select(id: string, on: boolean) { this.selected.update((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; }); }
  selectPage(on: boolean) { this.selected.update((s) => { const n = new Set(s); for (const p of this.items()) { if (on) n.add(p.id); else n.delete(p.id); } return n; }); }
  reload() { this.params.set({ ...this.params() }); }

  openNew() { this.editing.set(null); this.editorOpen.set(true); }
  edit(p: Product) { this.editing.set(p.id); this.editorOpen.set(true); }
  onSaved() { this.editorOpen.set(false); this.reload(); }
  onLinked(name: string) { this.linking.set(false); this.selected.set(new Set()); this.message.set(`Linked as variants: ${name}.`); this.reload(); }

  editStock(p: Product) { this.stockValue = p.stock; this.stockEdit.set(p.id); }
  saveStock(p: Product) {
    this.api.updateProduct(p.id, { stock: Math.max(0, Math.round(Number(this.stockValue))) }).subscribe({
      next: () => { this.stockEdit.set(''); this.reload(); },
      error: (e) => this.error.set(e.error?.error ?? 'Could not update the stock.'),
    });
  }
  setActive(p: Product, active: boolean) {
    this.api.updateProduct(p.id, { active }).subscribe({ next: () => this.reload(), error: (e) => this.error.set(e.error?.error ?? 'Could not update the product.') });
  }
  restore(p: Product) {
    this.api.restoreProduct(p.id).subscribe({
      next: (r) => { this.message.set(r.notice ?? `${p.name} was restored. It is hidden until you show it in the shop.`); this.reload(); },
      error: (e) => this.error.set(e.error?.error ?? 'Could not restore the product.'),
    });
  }
  bulk(action: 'show' | 'hide') { this.runBulk({ ids: [...this.selected()], action }); }
  moveTo(categoryId: string) { if (categoryId) this.runBulk({ ids: [...this.selected()], action: 'category', categoryId: categoryId === 'none' ? null : categoryId }); }
  private runBulk(body: { ids: string[]; action: 'show' | 'hide' | 'category'; categoryId?: string | null }) {
    this.api.bulkProducts(body).subscribe({
      next: (r) => { this.message.set(`${r.changed} ${r.changed === 1 ? 'product' : 'products'} updated.${r.failed.length ? ` ${r.failed.length} could not be changed.` : ''}`); this.selected.set(new Set()); this.reload(); },
      error: (e) => this.error.set(e.error?.error ?? 'Could not update the products.'),
    });
  }
  exportAs(format: 'csv' | 'json', delimiter: ',' | ';' = ',') {
    const { page: _p, sort, ...filters } = this.params();
    const params: Record<string, string> = this.selected().size ? { ids: [...this.selected()].join(',') } : { ...filters, ...(sort ? { sort } : {}) };
    if (format === 'csv' && delimiter === ';') params['delimiter'] = ';';
    // The full backup of the whole catalogue includes deleted products (flagged), so a restore keeps them (A-2).
    if (format === 'json' && !this.selected().size && !this.filtered() && !this.deletedView()) params['status'] = 'visible,hidden,deleted';
    this.api.exportProducts(params, format).subscribe({ error: () => this.error.set('The export failed. Please try again.') });
  }
}

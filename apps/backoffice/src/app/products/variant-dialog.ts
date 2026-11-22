import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, Differentiator, ProductSummary, VariantGroupView, VariantSuggestion } from '../api.service';
import { ProductPicker } from '../shared/product-picker';

/**
 * "Link as variants": choose the products and tick the properties that tell them apart. Values are read from the
 * products (never typed here). Properties whose values differ are ticked for you. Two products with the same values
 * can't be linked: the alert names them and nothing is saved (owner rule V-3).
 * With `groupId`, the dialog changes an existing group's properties instead.
 */
@Component({
  selector: 'app-variant-dialog',
  imports: [FormsModule, ProductPicker],
  template: `
    <div class="drawer-back" (click)="closed.emit()"></div>
    <div class="drawer wide" role="dialog" aria-modal="true" [attr.aria-label]="title()">
      <div class="drawer-h"><h2>{{ title() }}</h2><button type="button" class="btn ghost sm" (click)="closed.emit()" aria-label="Close">✕</button></div>
      <div class="drawer-b">
        @if (!groupId()) {
          <h3 class="sub">Products</h3>
          <div class="chips">
            @for (p of products(); track p.id) { <span class="chip">{{ p.name }}@if (!p.active) { <small>(hidden)</small> }<button type="button" (click)="removeProduct(p.id)" [attr.aria-label]="'Remove ' + p.name">✕</button></span> }
          </div>
          <app-product-picker [single]="true" placeholder="Add a product" [params]="{ type: 'simple' }" [exclude]="ids()" (picked)="addProduct($event)" />
          <label class="fld mt"><span>Group name</span><input class="inp" name="gname" [(ngModel)]="name" [placeholder]="products()[0]?.name ?? 'e.g. Trail jacket'" maxlength="120"><small>Only you see it.</small></label>
        }
        <h3 class="sub">What tells them apart?</h3>
        @if (suggestion(); as s) {
          @if (!s.properties.length) { <p class="hint-top">These products have no properties yet. Add properties (colour, size…) to them first.</p> }
          @for (p of s.properties; track p.key) {
            <label class="chk prop" [class.off]="!p.usable">
              <input type="checkbox" [checked]="ticked().includes(p.key)" [disabled]="!p.usable" (change)="toggle(p.key)">
              <b>{{ p.label }}</b>@if (p.visibility === 'internal') { <span class="tag">internal</span> }
              <small>{{ valuesOf(p) }}@if (!p.usable) { · holds several values per product, so it can't tell variants apart }@else if (!p.varies) { · the same for all }</small>
            </label>
          }
          @if (internalTicked().length) {
            <label class="chk warn-box"><input type="checkbox" name="makePublic" [(ngModel)]="makePublic"> Make {{ internalTicked().join(', ') }} public: shoppers need to see it to choose a variant</label>
          }
          @if (s.preview; as pv) {
            @for (d of pv.duplicates; track d.productId) { <div class="alert" role="alert">{{ d.message }} It can't be added: change its values or leave it out.</div> }
            @if (pv.useless.length) { <p class="warn-box">{{ pv.useless.join(', ') }} {{ pv.useless.length === 1 ? 'has' : 'have' }} the same value on every product: {{ pv.useless.length === 1 ? 'it doesn\\'t' : 'they don\\'t' }} help shoppers choose.</p> }
            @if (pv.unreachable.length) { <p class="warn-box">{{ names(pv.unreachable) }} can't be reached from the other variants by changing one property. Shoppers will only find {{ pv.unreachable.length === 1 ? 'it' : 'them' }} through search and lists.</p> }
            <table class="tbl mini">
              <thead><tr><th>Product</th>@for (k of ticked(); track k) { <th>{{ labelOf(k) }}</th> }</tr></thead>
              <tbody>@for (p of s.products; track p.id) { <tr [class.dup]="isDup(p.id)"><td>{{ p.name }}</td>@for (k of ticked(); track k) { <td>{{ valueOf(k, p.id) }}</td> }</tr> }</tbody>
            </table>
            @if (pv.selector.length) {
              <p class="hint">In the shop, on <b>{{ s.products[0]?.name }}</b>:</p>
              <div class="vpreview">@for (l of pv.selector; track l.key) { <div><span>{{ l.label }}</span>@for (b of l.badges; track b.label) { <i [class]="'vb ' + b.state">{{ b.label }}</i> }</div> }</div>
            }
          }
        } @else { <p class="hint">Loading…</p> }
        @if (error()) { <div class="alert" role="alert">{{ error() }}</div> }
      </div>
      <div class="drawer-f"><button type="button" class="btn" (click)="closed.emit()">Cancel</button>
        <button type="button" class="btn primary" [disabled]="!canSave() || saving()" (click)="save()">{{ saving() ? 'Saving…' : groupId() ? 'Save properties' : 'Link ' + products().length + ' products' }}</button></div>
    </div>`,
})
export class VariantDialog {
  private api = inject(ApiService);
  /** The products to link (new group). */
  productIds = input<string[]>([]);
  /** An existing group whose properties change. */
  groupId = input<string | null>(null);
  groupVersion = input<number>(0);
  current = input<Differentiator[]>([]);
  closed = output<void>();
  saved = output<VariantGroupView>();
  ids = signal<string[]>([]);
  ticked = signal<string[]>([]);
  suggestion = signal<VariantSuggestion | null>(null);
  saving = signal(false); error = signal('');
  name = ''; makePublic = false;
  private firstLoad = true;
  title = computed(() => (this.groupId() ? 'Properties that tell the variants apart' : 'Link as variants'));
  products = computed(() => this.suggestion()?.products.filter((p) => this.ids().includes(p.id)) ?? []);
  internalTicked = computed(() => (this.suggestion()?.properties ?? []).filter((p) => p.visibility === 'internal' && this.ticked().includes(p.key)).map((p) => p.label));

  constructor() {
    effect(() => {
      const gid = this.groupId(), initial = this.productIds(), cur = this.current();
      untracked(() => {
        this.ids.set(gid ? [] : [...initial]);
        if (gid) { this.ticked.set(cur.map((d) => d.key)); this.firstLoad = false; }
        this.refresh();
      });
    });
  }

  private refresh() {
    const gid = this.groupId();
    const diffs = this.ticked().map((key) => ({ key }));
    this.api.suggestVariants({ productIds: this.ids(), ...(diffs.length ? { differentiators: diffs } : {}), ...(gid ? { groupId: gid } : {}) }).subscribe({
      next: (s) => {
        if (this.firstLoad) {
          // First look: tick the properties whose values differ between the products.
          this.firstLoad = false;
          const pre = s.properties.filter((p) => p.varies && p.usable).map((p) => p.key);
          if (pre.length) { this.ticked.set(pre); this.suggestion.set(s); this.refresh(); return; }
        }
        this.suggestion.set(s);
      },
      error: (e) => this.error.set(e.error?.error ?? 'Could not read the products.'),
    });
  }

  addProduct(p: ProductSummary) { if (!this.ids().includes(p.id)) { this.ids.set([...this.ids(), p.id]); this.refresh(); } }
  removeProduct(id: string) { this.ids.set(this.ids().filter((x) => x !== id)); this.refresh(); }
  toggle(key: string) { const t = this.ticked(); this.ticked.set(t.includes(key) ? t.filter((k) => k !== key) : [...t, key]); this.error.set(''); this.refresh(); }
  labelOf(key: string) { return this.suggestion()?.properties.find((p) => p.key === key)?.label ?? key; }
  valueOf(key: string, id: string) { return this.suggestion()?.properties.find((p) => p.key === key)?.values[id] ?? '-'; }
  valuesOf(p: VariantSuggestion['properties'][number]) { const v = [...new Set(Object.values(p.values))]; return v.slice(0, 6).join(', ') + (v.length > 6 ? '…' : ''); }
  isDup(id: string) { return !!this.suggestion()?.preview?.duplicates.some((d) => d.productId === id || d.withProductId === id); }
  names(list: { name: string }[]) { return list.map((x) => x.name).join(', '); }

  canSave() {
    const s = this.suggestion();
    if (!s || !this.ticked().length) return false;
    if (!this.groupId() && this.ids().length < 2) return false;
    if (s.preview?.duplicates.length) return false;
    if (this.internalTicked().length && !this.makePublic) return false;
    return true;
  }

  save() {
    this.saving.set(true); this.error.set('');
    const differentiators = this.ticked().map((key) => ({ key }));
    const gid = this.groupId();
    const req = gid
      ? this.api.updateVariantGroup(gid, { version: this.groupVersion(), differentiators, makePublic: this.makePublic })
      : this.api.createVariantGroup({ ...(this.name.trim() ? { name: this.name.trim() } : {}), productIds: this.ids(), differentiators, makePublic: this.makePublic });
    req.subscribe({
      next: (g) => { this.saving.set(false); this.saved.emit(g); },
      error: (e) => { this.saving.set(false); this.error.set(e.error?.error ?? 'Could not save the variants.'); },
    });
  }
}

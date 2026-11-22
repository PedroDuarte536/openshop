import { Component, computed, effect, inject, input, model, output, signal, untracked } from '@angular/core';
import { ApiService, ProductSummary } from '../api.service';
import { UI } from '../config';

/**
 * Typeahead product picker: searches the catalogue on the server (so it stays fast with any number of products) and
 * shows the chosen products as chips. `single` mode emits `picked` instead of keeping a selection (e.g. to add a
 * bundle component or a simulator row). Deleted products are never offered; already chosen ones show "(deleted)".
 */
@Component({
  selector: 'app-product-picker',
  template: `
    @if (!single() && selected().length) {
      <div class="chips picked">
        @for (id of selected(); track id) {
          <span class="chip" [class.gone]="names()[id]?.deleted">{{ names()[id]?.name ?? '…' }}@if (names()[id]?.deleted) { <small>(deleted)</small> }
            <button type="button" (click)="remove(id)" [attr.aria-label]="'Remove ' + (names()[id]?.name ?? id)">✕</button></span>
        }
      </div>
    }
    <input class="inp" type="search" [placeholder]="placeholder()" [value]="q()" (input)="type($any($event.target).value)" [attr.aria-label]="placeholder()" autocomplete="off">
    @if (q().trim() || open()) {
      <div class="pick-results" role="listbox">
        @for (p of results(); track p.id) {
          @if (single()) {
            <button type="button" class="pick-row" role="option" (click)="choose(p)"><span>{{ p.name }}@if (p.sku) { <small class="mono">{{ p.sku }}</small> }</span><small>€{{ p.price.toFixed(2) }}@if (!p.active) { · hidden }</small></button>
          } @else {
            <div class="pick-line">
              <label class="pick-row"><input type="checkbox" [checked]="selected().includes(p.id)" (change)="toggle(p)"><span>{{ p.name }}@if (p.sku) { <small class="mono">{{ p.sku }}</small> }</span><small>€{{ p.price.toFixed(2) }}@if (!p.active) { · hidden }</small></label>
              @if (p.variantGroupId) { <button type="button" class="btn sm ghost" (click)="addVariants(p.variantGroupId)" [attr.aria-label]="'Add all variants of ' + p.name">+ all variants</button> }
            </div>
          }
        } @empty { <small class="pick-none">{{ loading() ? 'Searching…' : 'No products match.' }}</small> }
        @if (total() > results().length) { <small class="pick-none">{{ total() - results().length }} more: type more of the name or SKU.</small> }
      </div>
    }`,
  styles: [`
    :host{display:grid;gap:8px}
    .picked .chip small{font-weight:600;opacity:.7}.chip.gone{background:#FDE7E8;color:var(--bad)}
    .pick-results{display:grid;gap:2px;max-height:260px;overflow:auto;border:1.5px solid var(--line);border-radius:11px;padding:4px;background:#fff}
    .pick-row{display:flex;align-items:center;gap:10px;justify-content:space-between;padding:7px 9px;border:0;border-radius:8px;background:none;text-align:left;cursor:pointer;font-weight:600}
    .pick-row:hover{background:var(--paper)}.pick-row span{flex:1;display:flex;gap:8px;align-items:baseline}.pick-row small{color:var(--mut)}
    label.pick-row input{flex:none}
    .pick-line{display:flex;align-items:center;gap:4px}.pick-line .pick-row{flex:1}
    .pick-none{color:var(--mut);padding:6px 9px}`],
})
export class ProductPicker {
  private api = inject(ApiService);
  selected = model<string[]>([]);
  single = input(false);
  placeholder = input('Find products by name or SKU');
  /** Extra search parameters, e.g. { type: 'simple' } for bundle components. */
  params = input<Record<string, string>>({});
  /** Ids never offered (e.g. the product being edited). */
  exclude = input<string[]>([]);
  /** Show the first results before anything is typed. */
  open = input(false);
  picked = output<ProductSummary>();

  q = signal('');
  private found = signal<ProductSummary[]>([]);
  total = signal(0);
  loading = signal(false);
  names = signal<Record<string, ProductSummary>>({});
  results = computed(() => this.found().filter((p) => !this.exclude().includes(p.id)));
  private timer: ReturnType<typeof setTimeout> | undefined;
  private seq = 0;

  constructor() {
    // Names for the chosen ids (including hidden and deleted products they may refer to).
    effect(() => {
      const missing = this.selected().filter((id) => !untracked(this.names)[id]);
      if (missing.length) this.api.lookupProducts(missing.slice(0, 200)).subscribe((r) => this.names.update((n) => ({ ...n, ...Object.fromEntries(r.items.map((p) => [p.id, p])) })));
    });
    effect(() => { if (this.open()) untracked(() => this.search('')); });
  }

  type(v: string) {
    this.q.set(v);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.search(v), UI.searchDebounceMs);
  }

  search(v: string) {
    const n = ++this.seq;
    this.loading.set(true);
    this.api.productSummaries({ q: v.trim(), limit: String(UI.pickerResults), status: 'visible,hidden', sort: v.trim() ? 'relevance' : 'name', ...this.params() }).subscribe({
      next: (r) => {
        if (n !== this.seq) return;
        this.found.set(r.items); this.total.set(r.total); this.loading.set(false);
        this.names.update((x) => ({ ...x, ...Object.fromEntries(r.items.map((p) => [p.id, p])) }));
      },
      error: () => { if (n === this.seq) { this.found.set([]); this.loading.set(false); } },
    });
  }

  toggle(p: ProductSummary) {
    const cur = this.selected();
    this.selected.set(cur.includes(p.id) ? cur.filter((x) => x !== p.id) : [...cur, p.id]);
  }
  remove(id: string) { this.selected.set(this.selected().filter((x) => x !== id)); }
  /** Adds every current member of a variant group (products added to the group later are not included). */
  addVariants(groupId: string) {
    this.api.productSummaries({ variantGroup: groupId, limit: '100', status: 'visible,hidden' }).subscribe((r) => {
      this.names.update((x) => ({ ...x, ...Object.fromEntries(r.items.map((p) => [p.id, p])) }));
      this.selected.set([...new Set([...this.selected(), ...r.items.map((p) => p.id)])]);
    });
  }
  choose(p: ProductSummary) { this.picked.emit(p); this.q.set(''); this.found.set([]); }
}

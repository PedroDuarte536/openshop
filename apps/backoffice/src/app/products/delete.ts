import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ApiService, DeleteImpact, Product } from '../api.service';
import { STATE_LABEL } from '../discounts/ui';

/**
 * Confirmation before deleting a hidden product. Products are never removed: the product stays in the orders,
 * bundles, offers and variant groups that use it, and can be restored. For every bundle containing it, the owner
 * must decide whether the bundle keeps selling or is hidden (owner decision L-1).
 */
@Component({
  selector: 'app-product-delete',
  imports: [RouterLink],
  template: `
    <a class="back-link" routerLink="/products">← Products</a>
    @if (product(); as p) {
      <header class="page-h"><div><h1>Delete {{ p.name }}?</h1>
        <p>It disappears from your product list and the shop. Orders, bundles and offers that use it keep showing it, and you can restore it from "Deleted products".</p></div></header>
      @if (p.deletedAt) {
        <div class="card pad"><p>This product is already deleted.</p><a class="btn" routerLink="/products" [queryParams]="{ status: 'deleted' }">Deleted products</a></div>
      } @else if (p.active) {
        <div class="card pad">
          <p class="warn-box">This product is visible in the shop. Hide it first; then it can be deleted.</p>
          <p class="mt"><button class="btn" (click)="hide()">Hide it from the shop</button></p>
        </div>
      } @else if (impact(); as im) {
        <div class="ed-main">
          @if (im.bundles.length) {
            <section class="card pad" aria-labelledby="b-h">
              <h3 id="b-h">It is part of {{ im.bundles.length === 1 ? 'a bundle' : im.bundles.length + ' bundles' }}</h3>
              <p class="alert" role="alert">Choose what happens to each bundle. A bundle that keeps selling still contains {{ p.name }} and takes it from stock.</p>
              @for (b of im.bundles; track b.id) {
                <fieldset class="decide">
                  <legend>{{ b.name }} @if (!b.active) { <span class="pill">hidden</span> }</legend>
                  <label class="chk"><input type="radio" [name]="'b_' + b.id" [checked]="choice()[b.id] === 'keep'" (change)="decide(b.id, 'keep')"> Keep selling it with {{ p.name }}</label>
                  <label class="chk"><input type="radio" [name]="'b_' + b.id" [checked]="choice()[b.id] === 'hide'" (change)="decide(b.id, 'hide')"> Hide the bundle</label>
                  <a class="btn sm" [routerLink]="['/products']" [queryParams]="{ edit: b.id }">Open the bundle to change its contents</a>
                </fieldset>
              }
            </section>
          }
          @if (im.variantGroup; as g) {
            <section class="card pad"><h3>Variants</h3>
              <p>It leaves the variant choices of <b>{{ g.name }}</b>.@for (v of g.valuesLost; track v.property) { The value <b>{{ v.value }}</b> will no longer be shown for {{ v.property }}. }</p>
            </section>
          }
          @if (im.offers.length) {
            <section class="card pad"><h3>Offers that name it</h3>
              <ul class="plain">@for (o of im.offers; track o.id) { <li><a [routerLink]="['/discounts', o.id]">{{ o.name }}</a> <small class="cell-sub">{{ stateLabel[o.state] }}</small></li> }</ul>
              <p class="hint">They keep it in their list; it just can't be bought any more.</p>
            </section>
          }
          @if (im.openOrders) { <p class="note-box">{{ im.openOrders }} unshipped {{ im.openOrders === 1 ? 'order contains' : 'orders contain' }} this product. They are not changed.</p> }
          @if (!im.bundles.length && !im.variantGroup && !im.offers.length) { <p class="hint-top">Nothing else uses this product.</p> }
          @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
          <div class="save-bar">
            @if (missing() > 0) { <small>Choose for {{ missing() }} more {{ missing() === 1 ? 'bundle' : 'bundles' }}</small> }
            <a class="btn" routerLink="/products">Cancel</a>
            <button class="btn primary danger-solid" [disabled]="missing() > 0 || busy()" (click)="confirm()">{{ busy() ? 'Deleting…' : 'Delete product' }}</button>
          </div>
        </div>
      }
    } @else if (error()) { <p class="err" role="alert">{{ error() }}</p> }`,
})
export class ProductDelete {
  private api = inject(ApiService);
  private router = inject(Router);
  id = input.required<string>();
  product = signal<Product | null>(null);
  impact = signal<DeleteImpact | null>(null);
  choice = signal<Record<string, 'keep' | 'hide'>>({});
  busy = signal(false); error = signal('');
  stateLabel = STATE_LABEL;
  missing = computed(() => (this.impact()?.bundles ?? []).filter((b) => !this.choice()[b.id]).length);

  constructor() { effect(() => { const id = this.id(); untracked(() => this.load(id)); }); }

  private load(id: string) {
    this.api.product(id).subscribe({
      next: (p) => { this.product.set(p); if (!p.active && !p.deletedAt) this.api.deleteImpact(id).subscribe((im) => this.impact.set(im)); },
      error: () => this.error.set('This product could not be found.'),
    });
  }
  decide(bundleId: string, d: 'keep' | 'hide') { this.choice.update((c) => ({ ...c, [bundleId]: d })); }
  hide() {
    this.api.updateProduct(this.id(), { active: false }).subscribe({ next: () => this.load(this.id()), error: (e) => this.error.set(e.error?.error ?? 'Could not hide the product.') });
  }
  confirm() {
    this.busy.set(true); this.error.set('');
    this.api.deleteProduct(this.id(), this.choice()).subscribe({
      next: () => this.router.navigate(['/products']),
      error: (e) => { this.busy.set(false); this.error.set(e.error?.error ?? 'Could not delete the product.'); },
    });
  }
}

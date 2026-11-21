import { ChangeDetectorRef, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { formatMoney, type Reason } from '@openshop/pricing';
import { ApiService, Customer, ProductSummary, Settings, SimulateResult } from '../api.service';
import { ProductPicker } from '../shared/product-picker';
import { city, fmtLocal } from './ui';

const REASONS: Record<Reason, string> = {
  applied: 'Applied', paused: 'Paused', archived: 'Archived', not_started: 'Not started yet', expired: 'Ended', audience: 'Not for this customer',
  sign_in_required: 'Needs a signed-in customer', code_missing: 'Needs its code', code_used: 'Code already used', code_not_yours: 'Code belongs to another customer',
  used_up: 'All uses taken', limit_orders: 'Customer used it the maximum number of times', limit_budget: "Customer's discount budget is used up",
  first_orders_only: 'Only for first orders', no_matching_items: 'No matching items in the cart', min_subtotal: 'Minimum order value not reached',
  min_qty: 'Minimum quantity not reached', declined: 'Saved for later by the shopper', other_scenario: 'The shopper’s choice uses the other option',
  better_offer: 'Another offer gives a better price', no_effect: 'Would not change the price',
};

@Component({
  selector: 'app-simulator',
  imports: [FormsModule, RouterLink, ProductPicker],
  template: `
    <header class="page-h"><div><a class="back-link" routerLink="/discounts">← Discounts</a><h1>Simulator</h1><p>Try any cart, customer email, code and moment, and see exactly what the checkout would charge and why.</p></div></header>
    <div class="editor">
      <form class="card pad ed-main" (ngSubmit)="run()">
        <h3>Cart</h3>
        @for (row of rows; track $index; let i = $index) {
          <div class="sim-row">
            <span class="inp sim-name">{{ row.name }} <small>€{{ row.price.toFixed(2) }}</small></span>
            <input class="inp qty" type="number" min="1" max="99" [name]="'q' + i" [(ngModel)]="row.qty" [attr.aria-label]="'Quantity of ' + row.name">
            <button class="btn sm ghost" type="button" (click)="rows.splice(i, 1)" [attr.aria-label]="'Remove ' + row.name">✕</button>
          </div>
        }
        <app-product-picker [single]="true" placeholder="Add an item: find a product" [params]="{ status: 'visible' }" (picked)="add($event)" />
        <div class="fgrid">
          @if (canCustomers) {
          <label class="fld"><span>Signed-in customer (optional)</span>
            <select class="inp" name="cust" [(ngModel)]="customerId"><option value="">A guest</option>@for (c of customers(); track c.id) { <option [value]="c.id">{{ c.name }} ({{ c.email }})</option> }</select>
            <small>Their client prices and profiles apply.</small></label>
          }
          <label class="fld"><span>Guest email (optional)</span><input class="inp" name="email" type="email" [(ngModel)]="email" placeholder="Checks per-customer limits" [disabled]="!!customerId"></label>
          <label class="fld"><span>Discount code (optional)</span><input class="inp code" name="code" [(ngModel)]="code"></label>
          <label class="fld"><span>Moment ({{ tzCity() }} time)</span><input class="inp" name="at" type="datetime-local" [(ngModel)]="at"><small>Empty = now</small></label>
          <label class="fld"><span>Shopper's choice</span><select class="inp" name="scenario" [(ngModel)]="scenario"><option value="">Best price</option><option value="automatic">Automatic offers</option><option value="code">The code</option></select></label>
        </div>
        <button class="btn primary">Simulate</button>
        @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
      </form>
      <aside class="ed-side">
        @if (res(); as r) {
          <section class="card pad">
            <h3>Total {{ m(r.result.totalCents) }}</h3>
            <p class="cell-sub">Subtotal {{ m(r.result.subtotalCents) }} · saving {{ m(r.result.discountCents) }} · at {{ fmt(r.atLocal) }}</p>
            <table class="tbl mini"><tbody>
              @for (l of r.result.lines; track l.productId) {
                <tr><td>{{ l.qty }} × {{ l.name }}<div class="cell-sub">{{ l.appliedFrom ? l.appliedFrom.label : 'List price' }}</div></td><td class="num">@if (l.lineCents < l.lineListCents) { <s class="was">{{ m(l.lineListCents) }}</s> }</td><td class="num cell-main">{{ m(l.lineCents) }}</td></tr>
              }
            </tbody></table>
            @for (a of r.result.applied; track a.discountId) { <p class="note-box"><b>{{ a.label }}</b> −{{ m(a.cents) }}{{ a.code ? ' (code ' + a.code + ')' : '' }}{{ a.pending ? ' · checked at checkout' : '' }}</p> }
            @for (s of r.result.scenarios; track s.key) { <p class="cell-sub">Option “{{ s.title }}”: {{ m(s.totalCents) }}{{ s.best ? ' (best)' : '' }}{{ s.selected ? ' ← selected' : '' }}</p> }
            @for (c of r.result.choices; track c.discountId) { <p class="cell-sub">{{ c.label }} can be saved for later: total would be {{ m(c.totalIfToggled) }}</p> }
          </section>
          <section class="card pad block">
            <h3>Every offer</h3>
            <table class="tbl mini"><tbody>
              @for (d of r.result.diagnostics; track d.discountId) {
                <tr><td><a [routerLink]="['/discounts', d.discountId]">{{ d.name }}</a></td><td><span class="pill" [class.ok]="d.reason === 'applied'">{{ reason(d.reason) }}</span></td></tr>
              }
            </tbody></table>
          </section>
        } @else { <section class="card pad"><p class="cell-sub">Build a cart and press Simulate.</p></section> }
      </aside>
    </div>`,
})
export class Simulator {
  private api = inject(ApiService);
  private cdr = inject(ChangeDetectorRef);
  /** Simulating a named, signed-in customer needs "See customers" too. */
  canCustomers = this.api.can('customers.view');
  settings = signal<Settings | null>(null); res = signal<SimulateResult | null>(null); error = signal('');
  rows: { productId: string; qty: number; name: string; price: number }[] = [];
  email = ''; code = ''; at = ''; scenario = ''; customerId = '';
  customers = signal<Customer[]>([]);
  tzCity = computed(() => city(this.settings()?.timezone ?? 'UTC'));
  m = (c: number) => formatMoney(c);
  fmt = fmtLocal;
  reason = (r: Reason) => REASONS[r] ?? r;
  constructor() {
    // Start with the first visible product so there is something to simulate.
    this.api.productSummaries({ status: 'visible', sort: 'name', limit: '1' }).subscribe((r) => { const p = r.items[0]; if (p && !this.rows.length) { this.rows.push({ productId: p.id, qty: 1, name: p.name, price: p.price }); this.cdr.markForCheck(); } });
    this.api.settings().subscribe((s) => this.settings.set(s));
    if (this.canCustomers) this.api.customers().subscribe((c) => this.customers.set(c.filter((x) => x.activated)));
  }
  add(p: ProductSummary) {
    const row = this.rows.find((r) => r.productId === p.id);
    if (row) row.qty = Math.min(99, (Number(row.qty) || 0) + 1); else this.rows.push({ productId: p.id, qty: 1, name: p.name, price: p.price });
  }
  run() {
    this.error.set('');
    this.api.simulate({
      items: this.rows.filter((r) => r.productId).map((r) => ({ productId: r.productId, qty: Number(r.qty) || 1 })),
      email: this.customerId ? null : this.email.trim() || null, customerId: this.customerId || null, codes: this.code.trim() ? [this.code.trim()] : [], at: this.at || null,
      selection: { scenario: this.scenario || null },
    }).subscribe({ next: (r) => this.res.set(r), error: (e) => this.error.set(e.error?.fields?.[0]?.message ?? e.error?.message ?? e.error?.error ?? 'Could not simulate.') });
  }
}

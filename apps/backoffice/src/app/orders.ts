import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ApiService, Order } from './api.service';

@Component({
  selector: 'app-orders',
  imports: [DatePipe],
  template: `
    <header class="page-h"><div><h1>Orders</h1><p>{{ items().length }} {{ items().length === 1 ? 'order' : 'orders' }} so far</p></div></header>
    <div class="card">
      @if (items().length) {
        <table class="tbl">
          <thead><tr><th>Placed</th><th>Customer</th><th>Items</th><th>Discounts</th><th class="num">Total</th><th>Status</th></tr></thead>
          <tbody>
            @for (o of items(); track o.id) {
              <tr>
                <td class="cell-sub">{{ o.createdAt | date: 'd MMM, HH:mm' }}</td>
                <td><div class="cell-main">{{ o.customer.name }}</div><div class="cell-sub">{{ o.customer.email }}</div></td>
                <td>@for (l of o.lines; track $index) { <div>{{ l.qty }} × {{ l.name }}@if (l.discounts?.length) { <span class="cell-sub"> · €{{ (l.lineTotal ?? 0).toFixed(2) }}</span> }
                  @if (l.bundle) { <div class="cell-sub includes">@for (c of l.bundle.components; track c.productId) { <span>{{ c.qty * l.qty }} × {{ c.name }}@if (c.sku) { <span class="mono"> {{ c.sku }}</span> }</span> }</div> }</div> }</td>
                <td>
                  @for (d of o.discounts ?? []; track d.discountId) { <div class="cell-sub"><b>−€{{ d.amount.toFixed(2) }}</b> {{ d.label }}@if (d.code) { <span class="mono"> {{ d.code }}</span> }</div> }
                  @empty { <span class="cell-sub">—</span> }
                </td>
                <td class="num cell-main">€{{ o.total.toFixed(2) }}@if (o.discountTotal) { <div class="cell-sub"><s>€{{ (o.subtotal ?? 0).toFixed(2) }}</s></div> }</td>
                <td>
                  @if (targets(o).length > 1) {
                  <select class="status-sel" [class]="'status-sel ' + o.status" (change)="setStatus(o, $any($event.target).value)" [attr.aria-label]="'Status of order for ' + o.customer.name">
                    @for (s of targets(o); track s.v) { <option [value]="s.v" [selected]="s.v === o.status">{{ s.label }}</option> }
                  </select>
                  } @else { <span class="status-sel static" [class]="'status-sel static ' + o.status">{{ label(o.status) }}</span> }
                </td>
              </tr>
            }
          </tbody>
        </table>
      } @else { <div class="empty-state"><b>No orders yet</b>Orders appear here as soon as someone checks out.</div> }
    </div>
    @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
    <p class="hint">Cancelling an order gives back any offer uses, codes and per-customer allowances it used. A cancelled order that used offers can't be reopened.</p>`,
})
export class Orders {
  private api = inject(ApiService);
  /**
   * The statuses this member may choose (the server applies the same rule): Shipped needs "Mark orders as shipped",
   * Paid or Pending needs "Mark orders as paid", Cancelled needs "Cancel and reopen"; leaving Cancelled needs both.
   */
  targets(o: Order) {
    const need = (to: string): boolean => {
      const forTarget = to === 'shipped' ? 'orders.fulfil' : to === 'cancelled' ? 'orders.cancel' : 'orders.payments';
      return this.api.can(forTarget) && (o.status !== 'cancelled' || to === 'cancelled' || this.api.can('orders.cancel'));
    };
    return this.statuses.filter((s) => s.v === o.status || need(s.v));
  }
  label(v: string) { return this.statuses.find((s) => s.v === v)?.label ?? v; }
  items = signal<Order[]>([]); error = signal('');
  statuses = [{ v: 'pending', label: 'Pending' }, { v: 'paid', label: 'Paid' }, { v: 'shipped', label: 'Shipped' }, { v: 'cancelled', label: 'Cancelled' }];
  constructor() { this.load(); }
  load() { this.api.orders().subscribe((o) => this.items.set(o)); }
  setStatus(o: Order, status: string) {
    this.error.set('');
    this.api.setOrderStatus(o.id, status).subscribe({ next: () => this.load(), error: (e) => { this.error.set(e.error?.error ?? 'Could not change the status.'); this.load(); } });
  }
}

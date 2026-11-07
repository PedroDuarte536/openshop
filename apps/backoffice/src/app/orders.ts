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
          <thead><tr><th>Placed</th><th>Customer</th><th>Items</th><th class="num">Total</th><th>Status</th></tr></thead>
          <tbody>
            @for (o of items(); track o.id) {
              <tr>
                <td class="cell-sub">{{ o.createdAt | date: 'd MMM, HH:mm' }}</td>
                <td><div class="cell-main">{{ o.customer.name }}</div><div class="cell-sub">{{ o.customer.email }}</div></td>
                <td>@for (l of o.lines; track $index) { <div>{{ l.qty }} × {{ l.name }}</div> }</td>
                <td class="num cell-main">€{{ o.total.toFixed(2) }}</td>
                <td>
                  <select class="status-sel" [class]="'status-sel ' + o.status" (change)="setStatus(o, $any($event.target).value)" [attr.aria-label]="'Status of order for ' + o.customer.name">
                    @for (s of statuses; track s.v) { <option [value]="s.v" [selected]="s.v === o.status">{{ s.label }}</option> }
                  </select>
                </td>
              </tr>
            }
          </tbody>
        </table>
      } @else { <div class="empty-state"><b>No orders yet</b>Orders appear here as soon as someone checks out.</div> }
    </div>`,
})
export class Orders {
  private api = inject(ApiService);
  items = signal<Order[]>([]);
  statuses = [{ v: 'pending', label: 'Pending' }, { v: 'paid', label: 'Paid' }, { v: 'shipped', label: 'Shipped' }, { v: 'cancelled', label: 'Cancelled' }];
  constructor() { this.load(); }
  load() { this.api.orders().subscribe((o) => this.items.set(o)); }
  setStatus(o: Order, status: string) { this.api.setOrderStatus(o.id, status).subscribe(() => this.load()); }
}

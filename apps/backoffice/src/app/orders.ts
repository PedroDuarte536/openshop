import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ApiService, Order } from './api.service';

@Component({
  selector: 'app-orders',
  imports: [DatePipe],
  template: `
    <h2>Orders</h2>
    <table>
      <tr><th>Date</th><th>Customer</th><th>Items</th><th>Total</th><th>Status</th></tr>
      @for (o of items(); track o.id) {
        <tr>
          <td>{{ o.createdAt | date: 'short' }}</td>
          <td>{{ o.customer.name }}<br><small>{{ o.customer.email }}</small></td>
          <td>@for (l of o.lines; track $index) { <div>{{ l.qty }} × {{ l.name }}</div> }</td>
          <td>{{ o.total.toFixed(2) }}</td>
          <td>
            <select [value]="o.status" (change)="setStatus(o, $any($event.target).value)">
              @for (s of statuses; track s) { <option [value]="s" [selected]="s === o.status">{{ s }}</option> }
            </select>
          </td>
        </tr>
      } @empty { <tr><td colspan="5">No orders yet.</td></tr> }
    </table>`,
})
export class Orders {
  private api = inject(ApiService);
  items = signal<Order[]>([]);
  statuses = ['pending', 'paid', 'shipped', 'cancelled'];
  constructor() { this.load(); }
  load() { this.api.orders().subscribe((o) => this.items.set(o)); }
  setStatus(o: Order, status: string) { this.api.setOrderStatus(o.id, status).subscribe(() => this.load()); }
}

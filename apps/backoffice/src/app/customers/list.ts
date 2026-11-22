import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ApiService, Customer } from '../api.service';

@Component({
  selector: 'app-customers',
  imports: [FormsModule, RouterLink],
  template: `
    <header class="page-h">
      <div><h1>Customers</h1><p>Everyone who ordered, and the customers you invited to an account</p></div>
      @if (manage) { <button class="btn primary" (click)="open.set(!open())">{{ open() ? 'Close' : '+ New customer' }}</button> }
    </header>
    @if (open()) {
      <div class="card pad block-b">
        <form class="nform" (ngSubmit)="create()">
          <label class="fld req"><span>Email</span><input class="inp" name="email" type="email" [(ngModel)]="email" required></label>
          <label class="fld req"><span>Name</span><input class="inp" name="name" [(ngModel)]="name" required></label>
          <label class="fld"><span>Address</span><input class="inp" name="address" [(ngModel)]="address"></label>
          <button class="btn primary">Create customer</button>
        </form>
        <p class="hint">Then create an activation link on their page and send it to them. Accounts are only created by you.</p>
        @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
      </div>
    }
    <div class="toolbar">
      <input class="inp search" type="search" placeholder="Search by name or email" [ngModel]="q()" (ngModelChange)="q.set($event)" aria-label="Search customers">
      <select class="inp" [ngModel]="acc()" (ngModelChange)="acc.set($event)" aria-label="Filter by account">
        <option value="">All customers</option><option value="yes">With an account</option><option value="no">Without an account</option>
      </select>
    </div>
    <div class="card">
      @if (shown().length) {
        <table class="tbl">
          <thead><tr><th>Customer</th><th>Account</th><th>Profiles</th><th></th></tr></thead>
          <tbody>
            @for (c of shown(); track c.id) {
              <tr>
                <td><a class="cell-main link" [routerLink]="['/customers', c.id]">{{ c.name }}</a><div class="cell-sub">{{ c.email }}</div></td>
                <td><span class="pill" [class.ok]="c.activated">{{ c.activated ? 'Active' : 'No account' }}</span></td>
                <td>@for (p of c.profiles ?? []; track p.id) { <span class="tag">{{ p.name }}</span> } @empty { <span class="cell-sub">—</span> }</td>
                <td><div class="acts"><a class="btn sm" [routerLink]="['/customers', c.id]">Open</a></div></td>
              </tr>
            }
          </tbody>
        </table>
      } @else { <div class="empty-state"><b>No customers match</b>Customers appear when they order, or when you create them.</div> }
    </div>`,
})
export class Customers {
  private api = inject(ApiService);
  manage = this.api.can('customers.manage');
  private router = inject(Router);
  items = signal<Customer[]>([]); q = signal(''); acc = signal(''); open = signal(false); error = signal('');
  email = ''; name = ''; address = '';
  shown = computed(() => {
    const q = this.q().trim().toLowerCase(), a = this.acc();
    return this.items().filter((c) => (!q || c.name.toLowerCase().includes(q) || c.email.includes(q)) && (!a || (a === 'yes') === c.activated));
  });
  constructor() { this.api.customers().subscribe((c) => this.items.set(c)); }
  create() {
    this.error.set('');
    this.api.createCustomer({ email: this.email, name: this.name, address: this.address }).subscribe({
      next: (c) => this.router.navigate(['/customers', c.id]),
      error: (e) => this.error.set(e.error?.fields?.[0]?.message ? `Email: ${e.error.fields[0].message}` : e.error?.error ?? 'Could not create the customer.'),
    });
  }
}

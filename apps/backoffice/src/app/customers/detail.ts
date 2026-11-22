import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { ApiService, AccountLink, CustomerDetail, DiscountView, Profile } from '../api.service';
import { STATE_CLASS, STATE_LABEL } from '../discounts/ui';
import { UI } from '../config';

@Component({
  selector: 'app-customer',
  imports: [FormsModule, RouterLink, DatePipe],
  template: `
    @if (c(); as c) {
      <header class="page-h">
        <div><a class="back-link" routerLink="/customers">← Customers</a><h1>{{ c.name }}</h1><p>{{ c.email }} · {{ c.identityOrders }} {{ c.identityOrders === 1 ? 'order' : 'orders' }}</p></div>
      </header>

      <div class="grid2">
        <section class="card pad">
          <h3>Account</h3>
          @if (c.activated) {
            <p><span class="pill ok">Active</span> Signed up {{ c.activatedAt | date: 'd MMM y' }}. They get their customer prices and profile offers when signed in.</p>
          } @else {
            <p><span class="pill">No account</span> Customer prices and profile offers only apply once they have an account and sign in.</p>
          }
          @if (c.pendingLink) { <p class="cell-sub">{{ c.pendingLink.purpose === 'activate' ? 'An activation' : 'A password reset' }} link is waiting, valid until {{ c.pendingLink.expiresAt | date: 'd MMM, HH:mm' }}.</p> }
          @if (accounts) {
          <div class="acts-h">
            <button class="btn" (click)="link(c.activated ? 'reset' : 'activate')">{{ c.activated ? 'Create password reset link' : 'Create activation link' }}</button>
            @if (c.activated) { <button class="btn" (click)="signOut()">Sign out everywhere</button> }
          </div>
          }
          @if (newLink(); as l) {
            <div class="linkbox">
              <p><b>Send this link to {{ c.name }}</b> yourself (email, chat, SMS). It works once, and until {{ l.expiresAt | date: 'd MMM, HH:mm' }}. It won't be shown again.</p>
              <input class="inp mono" readonly [value]="full(l)" (focus)="$any($event.target).select()" aria-label="One-time link">
              <button class="btn sm" (click)="copy(full(l))">{{ copied() ? 'Copied' : 'Copy link' }}</button>
            </div>
          }
          @if (msg()) { <p class="ok-msg" role="status">{{ msg() }}</p> }
        </section>

        <section class="card pad">
          <h3>Profiles</h3>
          @for (p of c.profiles; track p.id) {
            <div class="row-line">
              <a [routerLink]="['/discounts/profiles', p.id]"><b>{{ p.name }}</b></a>
              <span class="cell-sub">shoppers see “{{ p.publicLabel }}”{{ p.validUntil ? ' · until ' + (p.validUntil | date: 'd MMM y') : '' }}{{ p.status === 'paused' ? ' · profile paused' : '' }}</span>
              @if (changeProfiles) { <button class="btn sm ghost" (click)="removeProfile(p.id)">Remove</button> }
            </div>
          } @empty { <p class="cell-sub">Not in any profile.</p> }
          @if (!changeProfiles) {
          } @else if (otherProfiles().length) {
            <form class="nform" (ngSubmit)="addProfile()">
              <label class="fld"><span>Add to profile</span>
                <select class="inp" name="prof" [(ngModel)]="profileId">@for (p of otherProfiles(); track p.id) { <option [value]="p.id">{{ p.name }}</option> }</select></label>
              <label class="fld small"><span>Last day (optional)</span><input class="inp" type="date" name="last" [(ngModel)]="lastDay"></label>
              <button class="btn" [disabled]="!profileId">Add</button>
            </form>
          } @else { <p class="cell-sub">{{ profiles().length ? 'Already in every profile.' : 'No profiles yet.' }} <a routerLink="/discounts/profiles">Manage profiles</a></p> }
        </section>
      </div>

      <section class="card pad block">
        <div class="sec-row"><h3>Client prices</h3>@if (clientPrices) { <a class="btn sm" [routerLink]="['/discounts/new']" [queryParams]="{ customer: c.id }">+ New client price</a> }</div>
        @for (d of c.personalOffers; track d.id) {
          <div class="row-line"><a [routerLink]="['/discounts', d.id]"><b>{{ d.name }}</b></a><span>{{ d.effect }}</span><span class="pill" [class]="'pill ' + stateClass[d.state]">{{ stateLabel[d.state] }}</span></div>
        } @empty { <p class="cell-sub">No offers just for this customer.</p> }
      </section>

      <section class="card pad block">
        <h3>Personal codes</h3>
        <p class="hint-top">Only {{ c.name }} can use these, when signed in. They appear in their account and in their cart.</p>
        @if (c.codes.length) {
          <table class="tbl mini"><thead><tr><th>Code</th><th>Offer</th><th class="num">Used</th></tr></thead><tbody>
            @for (k of c.codes; track k.code) { <tr><td class="mono cell-main">{{ k.code }}</td><td><a [routerLink]="['/discounts', k.discountId]">{{ k.offer }}</a></td><td class="num">{{ k.usedCount }}</td></tr> }
          </tbody></table>
        }
        @if (giveCodes) {
        <form class="nform" (ngSubmit)="giveCode()">
          <label class="fld"><span>Voucher offer</span>
            <select class="inp" name="voucher" [(ngModel)]="voucherId">@for (v of vouchers(); track v.id) { <option [value]="v.id">{{ v.name }}</option> }</select></label>
          <label class="fld small"><span>Prefix</span><input class="inp code" name="prefix" [(ngModel)]="prefix" maxlength="12" placeholder="VIP"></label>
          <button class="btn" [disabled]="!voucherId">Give a personal code</button>
        </form>
        @if (!vouchers().length) { <p class="cell-sub">Create a voucher offer first.</p> }
        }
        @if (codeMsg()) { <p class="ok-msg" role="status">{{ codeMsg() }}</p> }
      </section>

      <div class="grid2">
        <section class="card pad block">
          <h3>Use of limited offers</h3>
          @if (c.usage.length) {
            <table class="tbl mini"><thead><tr><th>Offer</th><th class="num">Orders</th><th class="num">Discount received</th></tr></thead><tbody>
              @for (u of c.usage; track u.discountId) { <tr><td><a [routerLink]="['/discounts', u.discountId]">{{ u.offer }}</a></td><td class="num">{{ u.orders }}</td><td class="num">€{{ u.amount.toFixed(2) }}</td></tr> }
            </tbody></table>
          } @else { <p class="cell-sub">None yet.</p> }
        </section>
        <section class="card pad block">
          <h3>Orders</h3>
          @if (c.orders.length) {
            <table class="tbl mini"><tbody>
              @for (o of c.orders; track o.id) { <tr><td class="cell-sub">{{ o.createdAt | date: 'd MMM y' }}</td><td>{{ o.status }}</td><td class="num">@if (o.discountTotal) { <span class="cell-sub">−€{{ o.discountTotal.toFixed(2) }}</span> }</td><td class="num cell-main">€{{ o.total.toFixed(2) }}</td></tr> }
            </tbody></table>
          } @else { <p class="cell-sub">No orders yet.</p> }
        </section>
      </div>

      @if (canDelete) {
      <section class="card pad block danger-zone">
        <h3>Delete customer</h3>
        <p class="hint-top">Removes their details, account, profile memberships and personal codes. Orders keep their own copy of the order details.</p>
        <button class="btn danger" [class.armed]="armed()" (click)="remove()">{{ armed() ? 'Click to confirm' : 'Delete ' + c.name }}</button>
      </section>
      }
      @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
    } @else { <div class="card pad">Loading…</div> }`,
})
export class CustomerPage {
  private api = inject(ApiService);
  // What this member may do here (the server checks the same rules).
  accounts = this.api.can('customers.accounts');
  canDelete = this.api.can('customers.delete');
  seeDiscounts = this.api.can('discounts.view');
  changeProfiles = this.api.can('discounts.manage');
  clientPrices = this.api.can('discounts.manage');
  giveCodes = this.api.can('discounts.codes');
  private router = inject(Router);
  id = input.required<string>();
  c = signal<CustomerDetail | null>(null);
  profiles = signal<Profile[]>([]); discounts = signal<DiscountView[]>([]);
  newLink = signal<AccountLink | null>(null); copied = signal(false); msg = signal(''); codeMsg = signal(''); error = signal(''); armed = signal(false);
  profileId = ''; lastDay = ''; voucherId = ''; prefix = '';
  stateLabel = STATE_LABEL; stateClass = STATE_CLASS;
  otherProfiles = computed(() => this.profiles().filter((p) => !this.c()?.profiles.some((x) => x.id === p.id)));
  vouchers = computed(() => this.discounts().filter((d) => d.trigger === 'code' && d.status !== 'archived'));
  constructor() {
    effect(() => { const id = this.id(); untracked(() => this.load(id)); });
    if (this.seeDiscounts) {
      this.api.profiles().subscribe((p) => this.profiles.set(p));
      this.api.discounts().subscribe((d) => { this.discounts.set(d); this.voucherId = this.vouchers()[0]?.id ?? ''; });
    }
  }
  load(id = this.id()) {
    this.api.customer(id).subscribe({ next: (c) => { this.c.set(c); this.profileId = this.otherProfiles()[0]?.id ?? ''; }, error: () => this.router.navigate(['/customers']) });
  }
  full(l: AccountLink) { return l.url ?? `${location.origin}${l.path}`; }
  link(purpose: 'activate' | 'reset') {
    this.msg.set(''); this.copied.set(false);
    this.api.customerLink(this.id(), purpose).subscribe((l) => { this.newLink.set(l); this.load(); });
  }
  copy(text: string) { navigator.clipboard?.writeText(text).then(() => this.copied.set(true), () => undefined); }
  signOut() { this.api.signOutCustomer(this.id()).subscribe(() => this.msg.set('Signed out on every device.')); }
  addProfile() {
    if (!this.profileId) return;
    this.api.changeMembers(this.profileId, { add: [{ customerId: this.id(), lastDay: this.lastDay || null }] }).subscribe({ next: () => { this.lastDay = ''; this.api.profiles().subscribe((p) => this.profiles.set(p)); this.load(); }, error: (e) => this.error.set(e.error?.error ?? 'Could not add.') });
  }
  removeProfile(profileId: string) { this.api.changeMembers(profileId, { remove: [this.id()] }).subscribe(() => this.load()); }
  giveCode() {
    if (!this.voucherId) return;
    this.api.personalCode(this.voucherId, this.id(), this.prefix.trim().toUpperCase()).subscribe({
      next: (r) => { this.codeMsg.set(`Personal code ${r.items[0]} created.`); this.load(); },
      error: (e) => this.error.set(e.error?.fields?.[0]?.message ?? e.error?.error ?? 'Could not create the code.'),
    });
  }
  remove() {
    if (!this.armed()) { this.armed.set(true); setTimeout(() => this.armed.set(false), UI.confirmMs); return; }
    this.api.deleteCustomer(this.id()).subscribe(() => this.router.navigate(['/customers']));
  }
}

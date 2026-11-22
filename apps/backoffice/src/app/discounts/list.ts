import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ApiService, Category, DiscountView, ProductSummary, Settings } from '../api.service';
import { city, effectText, kindLabel, scheduleText, STATE_CLASS, STATE_LABEL, targetText, usesText } from './ui';

type Tab = 'all' | 'automatic' | 'code';

@Component({
  selector: 'app-discounts',
  imports: [FormsModule, RouterLink],
  template: `
    <header class="page-h">
      <div><h1>Discounts</h1><p>Offers, vouchers and special prices. Times are in shop time{{ settings() ? ' (' + cityOf(settings()!.timezone) + ')' : '' }}.</p></div>
      <div class="acts-h">
        <a class="btn" routerLink="/discounts/profiles">Profiles</a>
        <a class="btn" routerLink="/discounts/simulate">Simulator</a>
        @if (manage) { <a class="btn primary" routerLink="/discounts/new">+ New offer</a> }
      </div>
    </header>

    @if (settings() && !settings()!.timezoneConfirmed) {
      <div class="banner">Your shop time zone is <b>{{ settings()!.timezone }}</b> (from the server). Offers start and end in this time zone for every customer.
        <a routerLink="/settings">Confirm or change it</a></div>
    }

    <div class="tabs" role="tablist">
      @for (t of tabs; track t.key) {
        <button role="tab" [attr.aria-selected]="tab() === t.key" [class.on]="tab() === t.key" (click)="tab.set(t.key)">{{ t.label }} <small>{{ count(t.key) }}</small></button>
      }
    </div>
    <div class="toolbar">
      <input class="inp search" type="search" placeholder="Search by name, label or campaign" [ngModel]="q()" (ngModelChange)="q.set($event)" aria-label="Search offers">
      <select class="inp" [ngModel]="state()" (ngModelChange)="state.set($event)" aria-label="Filter by status">
        <option value="">Any status</option>
        @for (s of states; track s) { <option [value]="s">{{ stateLabel[s] }}</option> }
      </select>
    </div>

    <div class="card">
      @if (shown().length) {
        <table class="tbl">
          <thead><tr><th class="w-offer">Offer</th><th>Applies to</th><th>Discount</th><th>When</th><th>Status</th><th class="num">Uses</th><th></th></tr></thead>
          <tbody>
            @for (d of shown(); track d.id) {
              <tr>
                <td>
                  <a class="cell-main link" [routerLink]="['/discounts', d.id]">{{ d.name }}</a>
                  <div class="cell-sub"><span class="tag">{{ preset(d) }}</span> Shoppers see “{{ d.label }}”@if (d.campaign) { · {{ d.campaign }} }</div>
                </td>
                <td class="cell-sub">{{ target(d) }}</td>
                <td class="cell-main">{{ effect(d) }}</td>
                <td class="cell-sub">{{ schedule(d) }}</td>
                <td><span class="pill" [class]="'pill ' + stateClass[d.state]">{{ stateLabel[d.state] }}</span></td>
                <td class="num">{{ uses(d) }}@if (d.trigger === 'code') { <div class="cell-sub">{{ d.codeCount ?? 0 }} {{ d.codeCount === 1 ? 'code' : 'codes' }}</div> }</td>
                <td><div class="acts">
                  @if (!manage) { <a class="btn sm" [routerLink]="['/discounts', d.id]">View</a> } @else {
                  @if (d.status === 'active') { <button class="btn sm" (click)="act(d, 'pause')">Pause</button> }
                  @else if (d.status === 'paused' || d.status === 'archived') { <button class="btn sm" (click)="act(d, 'resume')">{{ d.status === 'archived' ? 'Restore' : 'Resume' }}</button> }
                  <button class="btn sm" (click)="duplicate(d)">Duplicate</button>
                  }
                </div></td>
              </tr>
            }
          </tbody>
        </table>
      } @else {
        <div class="empty-state">
          @if (items().length) { <b>No offers match</b>Try another tab, status or search. }
          @else { <b>Create your first offer</b>A shop-wide sale, a special product price or a voucher code.<br><br><a class="btn primary" routerLink="/discounts/new">+ New offer</a> }
        </div>
      }
    </div>
    @if (error()) { <p class="err" role="alert">{{ error() }}</p> }`,
})
export class Discounts {
  private api = inject(ApiService);
  manage = this.api.can('discounts.manage');
  private router = inject(Router);
  items = signal<DiscountView[]>([]); products = signal<ProductSummary[]>([]); categories = signal<Category[]>([]); settings = signal<Settings | null>(null);
  tab = signal<Tab>('all'); q = signal(''); state = signal(''); error = signal('');
  tabs: { key: Tab; label: string }[] = [{ key: 'all', label: 'All offers' }, { key: 'automatic', label: 'Automatic' }, { key: 'code', label: 'Vouchers' }];
  states = ['running', 'scheduled', 'paused', 'used-up', 'ended', 'archived'] as const;
  stateLabel = STATE_LABEL; stateClass = STATE_CLASS;
  shown = computed(() => {
    const q = this.q().trim().toLowerCase(), st = this.state(), tab = this.tab();
    return this.items().filter((d) => (tab === 'all' || d.trigger === tab) && (!st || d.state === st) && (!st && d.state === 'archived' ? false : true)
      && (!q || [d.name, d.label, d.campaign ?? ''].some((x) => x.toLowerCase().includes(q))));
  });
  constructor() {
    this.load();
    this.api.categories().subscribe((c) => this.categories.set(c));
    this.api.settings().subscribe((s) => this.settings.set(s));
  }
  load() {
    this.api.discounts().subscribe((d) => {
      this.items.set(d);
      // Names only for the products that offers name (hidden and deleted ones included).
      const ids = [...new Set(d.flatMap((x) => (x.target.type === 'products' ? x.target.productIds.slice(0, 2) : [])))].slice(0, 200);
      if (ids.length) this.api.lookupProducts(ids).subscribe((r) => this.products.set(r.items));
    });
  }
  count(tab: Tab) { return this.items().filter((d) => d.state !== 'archived' && (tab === 'all' || d.trigger === tab)).length; }
  cityOf = city;
  preset = (d: DiscountView) => kindLabel(d);
  target = (d: DiscountView) => targetText(d, this.products(), this.categories());
  effect = effectText; schedule = scheduleText; uses = usesText;
  act(d: DiscountView, action: 'pause' | 'resume') { this.api.discountAction(d.id, action).subscribe({ next: () => this.load(), error: (e) => this.error.set(e.error?.error ?? 'Could not update the offer.') }); }
  duplicate(d: DiscountView) { this.api.discountAction(d.id, 'duplicate').subscribe((copy) => this.router.navigate(['/discounts', copy.id])); }
}

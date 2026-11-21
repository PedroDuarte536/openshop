import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import {
  DiscountValidationError, addLocalDays, discountState, normalizeDiscount, price, toCents, zonedToInstant, formatMoney,
  type Discount, type FieldError,
} from '@openshop/pricing';
import { ApiService, AuditEntry, Category, Customer, DiscountInput, DiscountView, Profile, ProductSummary, Redemption, Settings, VoucherCode } from '../api.service';
import { ProductPicker } from '../shared/product-picker';
import { PRESETS, Preset, STATE_CLASS, STATE_LABEL, city, fmtLocal, presetOf } from './ui';
import { UI } from '../config';

/** The editor's form: what the owner types (euros and percentages), converted to cents and basis points on save. */
interface Form {
  name: string; label: string; campaign: string;
  trigger: 'automatic' | 'code';
  audience: 'everyone' | 'customers' | 'profiles'; customerIds: string[]; profileIds: string[];
  requiresSignIn: boolean;
  target: 'all' | 'products' | 'categories'; productIds: string[]; categoryIds: string[]; excludeProductIds: string[];
  effectType: 'percent' | 'amountOff' | 'fixedPrice'; percent: number | null; amount: number | null;
  scope: 'line' | 'order';
  startNow: boolean; start: string;
  endMode: 'never' | 'day' | 'exact'; endDay: string; end: string;
  minSubtotal: number | null; minQty: number | null;
  totalUses: number | null; maxPerOrder: number | null;
  pcMaxOrders: number | null; pcMaxAmount: number | null; pcFirstOrders: number | null;
  priority: number; combinable: boolean; declinable: boolean;
  status: 'active' | 'paused' | 'archived';
}
const blank = (): Form => ({
  name: '', label: '', campaign: '', trigger: 'automatic', audience: 'everyone', customerIds: [], profileIds: [], requiresSignIn: false,
  target: 'all', productIds: [], categoryIds: [], excludeProductIds: [],
  effectType: 'percent', percent: 10, amount: null, scope: 'line',
  startNow: true, start: '', endMode: 'never', endDay: '', end: '',
  minSubtotal: null, minQty: null, totalUses: null, maxPerOrder: null, pcMaxOrders: null, pcMaxAmount: null, pcFirstOrders: null,
  priority: 0, combinable: false, declinable: false, status: 'active',
});
const cents = (eur: number | null) => (eur === null || eur === undefined || (eur as unknown) === '' ? null : Math.round(Number(eur) * 100));
const euros = (c: number | null) => (c === null ? null : c / 100);
const num = (v: number | null) => (v === null || v === undefined || (v as unknown) === '' ? null : Number(v));

@Component({
  selector: 'app-discount-editor',
  imports: [FormsModule, RouterLink, DatePipe, ProductPicker],
  template: `
    <header class="page-h">
      <div>
        <a class="back-link" routerLink="/discounts">← Discounts</a>
        <h1>{{ isNew() ? 'New offer' : (f.name || 'Offer') }}</h1>
        @if (current(); as d) {
          <p><span class="pill" [class]="'pill ' + stateClass[d.state]">{{ stateLabel[d.state] }}</span> Used {{ d.usedCount }} {{ d.usedCount === 1 ? 'time' : 'times' }}@if (d.limits.totalUses) { of {{ d.limits.totalUses }} }</p>
        } @else { <p>Choose what kind of offer this is, then fill in the details. Times are in shop time.</p> }
      </div>
      @if (current(); as d) {
        @if (manage) {
        <div class="acts-h">
          @if (d.status === 'active') { <button class="btn" (click)="act('pause')">Pause</button> }
          @if (d.status === 'paused' || d.status === 'archived') { <button class="btn" (click)="act('resume')">Resume</button> }
          <button class="btn" (click)="duplicate()">Duplicate</button>
          @if (d.status !== 'archived') { <button class="btn danger" [class.armed]="armed() === 'archive'" (click)="arm('archive')">{{ armed() === 'archive' ? 'Click to confirm' : 'Archive' }}</button> }
          @if (d.usedCount === 0) { <button class="btn danger" [class.armed]="armed() === 'delete'" (click)="arm('delete')">{{ armed() === 'delete' ? 'Click to confirm' : 'Delete' }}</button> }
        </div>
        }
      }
    </header>

    @if (loading()) { <div class="card pad">Loading…</div> } @else {
    <div class="editor">
      <form class="ed-main" (ngSubmit)="save()" novalidate>
        @if (!manage) { <p class="note-box" role="status">Read-only: you can see this offer but not change it (that needs “Create and change offers”).</p> }
        <fieldset class="plain" [disabled]="!manage">
        <section class="card pad">
          <h3>1. Kind of offer</h3>
          <div class="presets">
            @for (p of presets; track p.key) {
              <button type="button" class="preset" [class.on]="preset() === p.key" [disabled]="!p.available || (p.key === 'client' && !canCustomers)" (click)="choose(p.key)" [attr.aria-pressed]="preset() === p.key">
                <b>{{ p.title }}</b><small>{{ p.key === 'client' && !canCustomers ? 'Needs “See customers and their details”.' : p.blurb }}</small>
              </button>
            }
          </div>
        </section>

        <section class="card pad">
          <h3>2. Names</h3>
          <div class="fgrid">
            <label class="fld req"><span>Name (only you see it)</span><input class="inp" name="name" [(ngModel)]="f.name" maxlength="120" placeholder="e.g. Winter sale 2026 – mugs">
              @if (err('name')) { <small class="ferr">{{ err('name') }}</small> }</label>
            <label class="fld req"><span>Label (shoppers see it)</span><input class="inp" name="label" [(ngModel)]="f.label" maxlength="80" placeholder="e.g. Winter sale">
              @if (err('label')) { <small class="ferr">{{ err('label') }}</small> } @else { <small>Shown next to prices and in the cart.</small> }</label>
          </div>
          <label class="fld"><span>Campaign (optional)</span><input class="inp" name="campaign" [(ngModel)]="f.campaign" maxlength="60" placeholder="e.g. Black Friday"><small>Groups offers in lists and reports.</small></label>
        </section>

        <section class="card pad">
          <h3>3. Who can use it</h3>
          <div class="seg">
            <button type="button" [class.on]="f.audience === 'everyone'" (click)="setAudience('everyone')">Everyone</button>
            <button type="button" [class.on]="f.audience === 'customers'" [disabled]="!canCustomers" [attr.title]="canCustomers ? null : 'Needs “See customers and their details”'" (click)="setAudience('customers')">Specific customers</button>
            <button type="button" [class.on]="f.audience === 'profiles'" (click)="setAudience('profiles')">Profiles</button>
          </div>
          @if (f.audience === 'customers') {
            <div class="picker">
              <input class="inp" type="search" placeholder="Find customers by name or email" [ngModel]="cq()" (ngModelChange)="cq.set($event)" name="cq" aria-label="Find customers">
              <div class="chips">@for (id of f.customerIds; track id) { <span class="chip">{{ customerName(id) }} <button type="button" (click)="toggle(f.customerIds, id)" [attr.aria-label]="'Remove ' + customerName(id)">✕</button></span> }</div>
              <div class="picks">
                @for (c of filteredCustomers(); track c.id) {
                  <label><input type="checkbox" [checked]="f.customerIds.includes(c.id)" (change)="toggle(f.customerIds, c.id)"> {{ c.name }} <small>{{ c.email }}{{ c.activated ? '' : ' · no account yet' }}</small></label>
                }
              </div>
            </div>
            @if (err('audience.customerIds')) { <small class="ferr">{{ err('audience.customerIds') }}</small> }
          }
          @if (f.audience === 'profiles') {
            <div class="picks">
              @for (p of profiles(); track p.id) {
                <label><input type="checkbox" [checked]="f.profileIds.includes(p.id)" (change)="toggle(f.profileIds, p.id)"> {{ p.name }} <small>{{ p.activeMembers }} members · shows “{{ p.publicLabel }}”</small></label>
              } @empty { <small>No profiles yet. <a routerLink="/discounts/profiles">Create one</a>.</small> }
            </div>
            @if (err('audience.profileIds')) { <small class="ferr">{{ err('audience.profileIds') }}</small> }
          }
          <label class="sw" [class.locked]="f.audience !== 'everyone'"><span><b>Signed-in customers only</b><small>{{ f.audience === 'everyone' ? 'Off: guests can use it too.' : 'Always on for specific customers and profiles: a typed email never unlocks their prices.' }}</small></span><input type="checkbox" name="signin" [(ngModel)]="f.requiresSignIn" [disabled]="f.audience !== 'everyone'"><i></i></label>
        </section>

        <section class="card pad">
          <h3>4. What it applies to</h3>
          <div class="seg">
            <button type="button" [class.on]="f.target === 'all'" (click)="f.target = 'all'">All products</button>
            <button type="button" [class.on]="f.target === 'products'" (click)="f.target = 'products'">Specific products</button>
            <button type="button" [class.on]="f.target === 'categories'" (click)="f.target = 'categories'">Categories</button>
          </div>
          @if (f.target === 'products') {
            <div class="picker">
              <app-product-picker [(selected)]="f.productIds" placeholder="Find products by name or SKU" />
              <small>{{ f.productIds.length }} selected</small>
            </div>
            @if (err('target.productIds')) { <small class="ferr">{{ err('target.productIds') }}</small> }
          }
          @if (f.target === 'categories') {
            <div class="picks">
              @for (c of categories(); track c.id) {
                <label><input type="checkbox" [checked]="f.categoryIds.includes(c.id)" (change)="toggle(f.categoryIds, c.id)"> {{ c.name }}</label>
              } @empty { <small>No categories yet.</small> }
            </div>
            @if (err('target.categoryIds')) { <small class="ferr">{{ err('target.categoryIds') }}</small> }
          }
          @if (f.target !== 'products') {
            <details class="more" [open]="f.excludeProductIds.length > 0">
              <summary>Exclude products ({{ f.excludeProductIds.length }})</summary>
              <app-product-picker [(selected)]="f.excludeProductIds" placeholder="Find products to exclude" />
            </details>
          }
        </section>

        <section class="card pad">
          <h3>5. The discount</h3>
          <div class="seg">
            <button type="button" [class.on]="f.effectType === 'percent'" (click)="setEffect('percent')">% off</button>
            <button type="button" [class.on]="f.effectType === 'amountOff'" (click)="setEffect('amountOff')">Amount off</button>
            <button type="button" [class.on]="f.effectType === 'fixedPrice'" (click)="setEffect('fixedPrice')">Fixed price</button>
          </div>
          <div class="fgrid">
            @if (f.effectType === 'percent') {
              <label class="fld req"><span>Percentage</span><div class="affix suffix"><input class="inp" name="pct" type="number" min="0.01" max="100" step="0.01" [(ngModel)]="f.percent"><b>%</b></div>
                @if (err('effect.bp')) { <small class="ferr">Enter 0.01 to 100</small> }</label>
            } @else {
              <label class="fld req"><span>{{ f.effectType === 'fixedPrice' ? 'New price for each item' : 'Amount' }}</span><div class="affix"><b>€</b><input class="inp" name="amt" type="number" min="0" step="0.01" [(ngModel)]="f.amount"></div>
                @if (err('effect.cents')) { <small class="ferr">Enter an amount</small> }</label>
            }
            <div class="fld"><span class="lbl">Applies</span>
              <div class="seg small">
                <button type="button" [class.on]="f.scope === 'line'" (click)="f.scope = 'line'">To each item</button>
                <button type="button" [class.on]="f.scope === 'order'" [disabled]="f.effectType === 'fixedPrice'" (click)="f.scope = 'order'">Once per order</button>
              </div>
              <small>{{ f.scope === 'line' ? 'Changes the price of every matching item.' : 'Taken off the total of the matching items.' }}</small>
            </div>
          </div>
        </section>

        <section class="card pad">
          <h3>6. When</h3>
          <p class="hint-top">Shop time: <b>{{ tzCity() }}</b> ({{ settings()?.offset }}). An offer ends at the same moment for every customer, wherever they are.</p>
          <div class="fgrid">
            <div class="fld">
              <span class="lbl">Starts</span>
              @if (isNew()) { <label class="chk"><input type="checkbox" name="startNow" [(ngModel)]="f.startNow"> Now</label> }
              @if (!isNew() || !f.startNow) { <input class="inp" type="datetime-local" name="start" [(ngModel)]="f.start" aria-label="Start date and time (shop time)">
                @if (yourTime(f.start); as y) { <small>= {{ y }}</small> } }
              @if (err('schedule.start')) { <small class="ferr">{{ err('schedule.start') }}</small> }
            </div>
            <div class="fld">
              <span class="lbl">Ends</span>
              <select class="inp" name="endMode" [(ngModel)]="f.endMode" aria-label="How the offer ends">
                <option value="never">Never</option><option value="day">At the end of a day</option><option value="exact">At a specific time</option>
              </select>
              @if (f.endMode === 'day') { <input class="inp mt" type="date" name="endDay" [(ngModel)]="f.endDay" aria-label="Last day"><small>Runs until 23:59 on this day ({{ tzCity() }} time).</small> }
              @if (f.endMode === 'exact') { <input class="inp mt" type="datetime-local" name="end" [(ngModel)]="f.end" aria-label="End date and time (shop time)">
                @if (yourTime(f.end); as y) { <small>= {{ y }}</small> } }
              @if (err('schedule.end')) { <small class="ferr">{{ err('schedule.end') }}</small> }
            </div>
          </div>
        </section>

        <section class="card pad">
          <h3>7. Conditions and limits</h3>
          <div class="fgrid">
            <label class="fld"><span>Minimum order value</span><div class="affix"><b>€</b><input class="inp" name="minSub" type="number" min="0" step="0.01" [(ngModel)]="f.minSubtotal" placeholder="None"></div><small>Of the matching items, after item discounts.</small></label>
            <label class="fld"><span>Minimum quantity</span><input class="inp" name="minQty" type="number" min="1" step="1" [(ngModel)]="f.minQty" placeholder="None"></label>
            <label class="fld"><span>Total uses (all customers)</span><input class="inp" name="total" type="number" min="1" step="1" [(ngModel)]="f.totalUses" placeholder="Unlimited"></label>
            <label class="fld"><span>Maximum discount per order</span><div class="affix"><b>€</b><input class="inp" name="maxOrder" type="number" min="0.01" step="0.01" [(ngModel)]="f.maxPerOrder" placeholder="No cap"></div></label>
          </div>
          <h4>Per customer</h4>
          <div class="fgrid three">
            <label class="fld"><span>Purchases with this offer</span><input class="inp" name="pcOrders" type="number" min="1" step="1" [(ngModel)]="f.pcMaxOrders" placeholder="Unlimited"><small>e.g. 1 = once per customer</small></label>
            <label class="fld"><span>Total discount across purchases</span><div class="affix"><b>€</b><input class="inp" name="pcAmount" type="number" min="0.01" step="0.01" [(ngModel)]="f.pcMaxAmount" placeholder="No cap"></div><small>When less is left, the rest is applied.</small></label>
            <label class="fld"><span>Only for the customer's first</span><div class="affix suffix"><input class="inp" name="pcFirst" type="number" min="1" step="1" [(ngModel)]="f.pcFirstOrders" placeholder="Any"><b>orders</b></div><small>1 = first order only. Cancelled orders don't count.</small></label>
          </div>
          @if (limited() && !f.requiresSignIn) {
            <p class="warn-box">Guests are recognised by the email they type, so someone could use a different email to get around per-customer limits. Turn on “Signed-in customers only” for strict limits.</p>
          }
        </section>

        <section class="card pad">
          <h3>8. Combining</h3>
          @if (f.trigger === 'code') {
            <label class="sw"><span><b>Can be combined with automatic offers</b><small>Off: shoppers choose between this code and the automatic offers (both totals are shown, the best is preselected).</small></span><input type="checkbox" name="comb" [(ngModel)]="f.combinable"><i></i></label>
          } @else {
            <p class="hint-top">Each item gets its single best price. At most one “once per order” automatic offer applies (the biggest).</p>
          }
          <label class="sw"><span><b>Shoppers can save it for later</b><small>For offers with per-customer limits: shoppers can choose not to use it on this order.</small></span><input type="checkbox" name="decl" [(ngModel)]="f.declinable"><i></i></label>
          <label class="fld narrow"><span>Priority</span><input class="inp" name="prio" type="number" min="0" max="1000" step="1" [(ngModel)]="f.priority"><small>Only breaks ties between equal prices. Higher wins.</small></label>
        </section>

        @if (isNew()) {
          <section class="card pad">
            <label class="sw"><span><b>Publish when saved</b><small>Off: saved as paused, so you can review it first.</small></span><input type="checkbox" name="pub" [ngModel]="f.status === 'active'" (ngModelChange)="f.status = $event ? 'active' : 'paused'"><i></i></label>
          </section>
        }

        </fieldset>
        @if (manage) {
        <div class="save-bar">
          @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
          @if (saved()) { <p class="ok-msg" role="status">Saved.</p> }
          <button class="btn primary" [disabled]="saving()">{{ saving() ? 'Saving…' : isNew() ? 'Create offer' : 'Save changes' }}</button>
        </div>
        }
      </form>

      <aside class="ed-side">
        <section class="card pad sticky">
          <h3>Preview</h3>
          <p class="cell-sub">{{ previewNote() }}</p>
          @if (preview().rows.length) {
            <table class="tbl mini">
              <tbody>
                @for (r of preview().rows; track r.name) {
                  <tr><td>{{ r.name }}</td><td class="num"><s class="was">{{ r.list }}</s></td><td class="num cell-main">{{ r.now }}</td></tr>
                }
              </tbody>
            </table>
          }
          @for (w of preview().warnings; track w) { <p class="warn-box">{{ w }}</p> }
          @for (n of preview().notes; track n) { <p class="note-box">{{ n }}</p> }
        </section>
      </aside>
    </div>

    @if (current(); as d) {
      @if (d.trigger === 'code' && !canCodes) {
        <section class="card pad block"><h3>Codes</h3><p class="cell-sub">Voucher codes are worth money: seeing them needs “See, generate, export and delete voucher codes”.</p></section>
      }
      @if (d.trigger === 'code' && canCodes) {
        <section class="card pad block">
          <div class="sec-row"><h3>Codes <small>{{ codesTotal() }}</small></h3>
            <button class="btn sm" type="button" (click)="downloadCodes()" [disabled]="!codesTotal()">Download CSV</button></div>
          <div class="code-forms">
            <form class="nform" (ngSubmit)="addCode()">
              <label class="fld"><span>Add a code</span><input class="inp code" name="code" [(ngModel)]="newCode" placeholder="WELCOME10" maxlength="32"><small>Shared: anyone can use it (within the limits above).</small></label>
              <button class="btn">Add</button>
            </form>
            <form class="nform" (ngSubmit)="generate()">
              <label class="fld small"><span>Generate</span><input class="inp" name="gen" type="number" min="1" max="10000" [(ngModel)]="genCount"></label>
              <label class="fld small"><span>Prefix</span><input class="inp code" name="prefix" [(ngModel)]="genPrefix" maxlength="12" placeholder="DUNE"></label>
              <button class="btn">Generate single-use codes</button>
            </form>
          </div>
          @if (codeError()) { <p class="err" role="alert">{{ codeError() }}</p> }
          @if (codes().length) {
            <table class="tbl">
              <thead><tr><th>Code</th><th>Kind</th><th class="num">Used</th><th>Created</th><th></th></tr></thead>
              <tbody>
                @for (c of codes(); track c.id) {
                  <tr><td class="cell-main mono">{{ c.id }}</td><td>{{ c.kind === 'single' ? 'Single use' : 'Shared' }}</td><td class="num">{{ c.usedCount }}</td><td class="cell-sub">{{ c.createdAt | date: 'd MMM y, HH:mm' }}</td>
                    <td><div class="acts">@if (!c.usedCount) { <button class="btn sm danger" type="button" (click)="deleteCode(c)">Delete</button> }</div></td></tr>
                }
              </tbody>
            </table>
            @if (codes().length < codesTotal()) { <p><button class="btn sm" type="button" (click)="moreCodes()">Show more</button></p> }
          } @else { <p class="cell-sub">No codes yet. Shoppers need a code to use this offer.</p> }
        </section>
      }

      @if (canRedemptions) {
      <section class="card pad block">
        <div class="sec-row"><h3>Redemptions <small>{{ redemptions().length }}</small></h3>
          <button class="btn sm" type="button" (click)="downloadRedemptions()" [disabled]="!redemptions().length">Download CSV</button></div>
        @if (redemptions().length) {
          <table class="tbl">
            <thead><tr><th>Date</th><th>Customer</th><th>Code</th><th class="num">Discount</th><th class="num">Order total</th><th>State</th></tr></thead>
            <tbody>
              @for (r of redemptions().slice(0, 20); track r.orderId) {
                <tr><td class="cell-sub">{{ r.at | date: 'd MMM y, HH:mm' }}</td><td>{{ r.customerEmail }}</td><td class="mono">{{ r.code ?? '—' }}</td><td class="num">€{{ r.amount.toFixed(2) }}</td><td class="num">@if (r.orderTotal !== null) { €{{ r.orderTotal.toFixed(2) }} }</td>
                  <td><span class="pill" [class.ok]="r.state === 'used'">{{ r.state === 'used' ? 'Used' : 'Released (cancelled)' }}</span></td></tr>
              }
            </tbody>
          </table>
        } @else { <p class="cell-sub">Not used in any order yet.</p> }
      </section>
      }

      <section class="card pad block">
        <div class="sec-row"><h3>History</h3>
          <button class="btn sm" type="button" (click)="downloadHistory()" [disabled]="!history().length">Download CSV</button></div>
        @for (a of history(); track a.id) { <p class="cell-sub">{{ a.at | date: 'd MMM y, HH:mm' }}: {{ a.action }}{{ a.userName ? ' · ' + a.userName : '' }}</p> }
        @if (historyNext()) { <p><button class="btn sm" type="button" (click)="olderHistory()">Older changes</button></p> }
      </section>
    }
    }`,
})
export class DiscountEditor {
  private api = inject(ApiService);
  private router = inject(Router);
  id = input<string>();
  presets = PRESETS; stateLabel = STATE_LABEL; stateClass = STATE_CLASS;
  f: Form = blank();
  current = signal<DiscountView | null>(null);
  settings = signal<Settings | null>(null);
  /** Products the preview is computed on: the ones this offer targets (a sample of up to 50), loaded on demand. */
  products = signal<ProductSummary[]>([]); categories = signal<Category[]>([]);
  private poolKey = '';
  private poolTotal = signal(0);
  loading = signal(true); saving = signal(false); saved = signal(false); error = signal(''); armed = signal('');
  /** Errors returned by the server on the last save. */
  fieldErrors = signal<FieldError[]>([]);
  /** After the first save attempt, client-side errors update live as the owner fixes fields. */
  attempted = signal(false);
  cq = signal('');
  customers = signal<Customer[]>([]); profiles = signal<Profile[]>([]);
  /** Preselect from a customer, profile or product page: /discounts/new?customer=..., ?profile=... or ?product=... */
  customer = input<string>(); profile = input<string>(); product = input<string>();
  filteredCustomers = computed(() => { const q = this.cq().trim().toLowerCase(); return this.customers().filter((c) => !q || c.email.includes(q) || c.name.toLowerCase().includes(q)).slice(0, 100); });
  codes = signal<VoucherCode[]>([]); codesTotal = signal(0); codeError = signal(''); newCode = ''; genCount = 10; genPrefix = '';
  redemptions = signal<Redemption[]>([]); history = signal<AuditEntry[]>([]); historyNext = signal<string | null>(null);
  isNew = computed(() => !this.id());
  tzCity = computed(() => city(this.settings()?.timezone ?? 'UTC'));
  private selectedPreset = signal<Preset>('shop');
  preset = this.selectedPreset.asReadonly();

  // What this member may do here (the server checks the same rules).
  manage = this.api.can('discounts.manage');
  canCustomers = this.api.can('customers.view');
  canCodes = this.api.can('discounts.codes');
  canRedemptions = this.api.can({ all: ['discounts.view', 'orders.view'] });

  constructor() {
    this.api.categories().subscribe((c) => this.categories.set(c));
    if (this.canCustomers) this.api.customers().subscribe((c) => this.customers.set(c));
    this.api.profiles().subscribe((p) => this.profiles.set(p));
    // Reload whenever the route's id changes (e.g. after "Duplicate", which opens the copy in the same editor).
    effect(() => {
      const id = this.id();
      untracked(() => this.open(id));
    });
  }

  private open(id: string | undefined) {
    this.loading.set(true); this.error.set(''); this.saved.set(false); this.fieldErrors.set([]); this.attempted.set(false);
    this.current.set(null); this.codes.set([]); this.codesTotal.set(0); this.redemptions.set([]); this.history.set([]);
    this.api.settings().subscribe((s) => {
      this.settings.set(s);
      if (!id) {
        this.f = blank(); this.selectedPreset.set('shop');
        const customer = this.customer(), profile = this.profile();
        if (customer) { this.choose('client'); this.f.customerIds = [customer]; }
        if (profile) { this.choose('profile'); this.f.profileIds = [profile]; }
        const product = this.product();
        if (product && /^[A-Za-z0-9_-]{1,64}$/.test(product)) { this.choose('product'); this.f.target = 'products'; this.f.productIds = [product]; }
        this.loading.set(false); return;
      }
      this.api.discount(id).subscribe({
        next: (d) => { this.loadOffer(d); this.loading.set(false); },
        error: () => this.router.navigate(['/discounts']),
      });
    });
  }

  private loadOffer(d: DiscountView) {
    this.current.set(d);
    this.selectedPreset.set(presetOf(d));
    const end = d.schedule.end;
    const isMidnight = !!end && end.endsWith('T00:00');
    this.f = {
      name: d.name, label: d.label, campaign: d.campaign ?? '', trigger: d.trigger, audience: d.audience.type, requiresSignIn: d.access.requiresSignIn,
      customerIds: d.audience.type === 'customers' ? [...d.audience.customerIds] : [], profileIds: d.audience.type === 'profiles' ? [...d.audience.profileIds] : [],
      target: d.target.type, productIds: d.target.type === 'products' ? [...d.target.productIds] : [], categoryIds: d.target.type === 'categories' ? [...d.target.categoryIds] : [],
      excludeProductIds: [...d.excludeProductIds],
      effectType: d.effect.type, percent: d.effect.type === 'percent' ? d.effect.bp / 100 : null, amount: d.effect.type !== 'percent' ? d.effect.cents / 100 : null, scope: d.scope,
      startNow: false, start: d.schedule.start,
      endMode: !end ? 'never' : isMidnight ? 'day' : 'exact', endDay: isMidnight ? addLocalDays(end!, -1).slice(0, 10) : '', end: end ?? '',
      minSubtotal: euros(d.conditions.minSubtotalCents), minQty: d.conditions.minQty, totalUses: d.limits.totalUses, maxPerOrder: euros(d.limits.maxDiscountPerOrderCents),
      pcMaxOrders: d.perCustomer.maxOrders, pcMaxAmount: euros(d.perCustomer.maxAmountCents), pcFirstOrders: d.perCustomer.firstOrders,
      priority: d.priority, combinable: d.combinable, declinable: d.declinable, status: d.status,
    };
    if (d.trigger === 'code' && this.canCodes) this.loadCodes(true);
    if (this.canRedemptions) this.api.redemptions(d.id).subscribe((r) => this.redemptions.set(r.items));
    this.api.audit('discount', d.id).subscribe((a) => { this.history.set(a.items); this.historyNext.set(a.next); });
  }

  setAudience(a: Form['audience']) {
    this.f.audience = a;
    if (a !== 'everyone') this.f.requiresSignIn = true;
  }
  customerName(id: string) { return this.customers().find((c) => c.id === id)?.name ?? (this.canCustomers ? 'Unknown customer' : 'A customer'); }
  choose(p: Preset) {
    this.selectedPreset.set(p);
    if (p === 'client') this.setAudience('customers');
    else if (p === 'profile') this.setAudience('profiles');
    else if (this.f.audience !== 'everyone') { this.f.audience = 'everyone'; this.f.requiresSignIn = false; }
    if (p === 'voucher') { this.f.trigger = 'code'; if (this.f.scope === 'line' && this.f.effectType !== 'fixedPrice' && this.isNew()) this.f.scope = 'order'; }
    else { this.f.trigger = 'automatic'; }
    if (p === 'product' && this.f.target === 'all') this.f.target = 'products';
    if (p === 'shop' && this.f.target === 'products') this.f.target = 'all';
  }
  setEffect(t: Form['effectType']) {
    this.f.effectType = t;
    if (t === 'fixedPrice') this.f.scope = 'line';
    if (t === 'percent' && this.f.percent === null) this.f.percent = 10;
  }
  toggle(list: string[], id: string) { const i = list.indexOf(id); if (i >= 0) list.splice(i, 1); else list.push(id); }
  limited() { return num(this.f.pcMaxOrders) !== null || num(this.f.pcMaxAmount) !== null || num(this.f.pcFirstOrders) !== null; }
  err(field: string) {
    if (this.attempted()) { const v = this.validate(); if (!v.ok) { const m = v.errors.find((e) => e.field === field); if (m) return m.message; } }
    return this.fieldErrors().find((e) => e.field === field)?.message ?? '';
  }

  /** "1 Dec, 01:00 your time (Berlin)" when the owner's browser is in another time zone than the shop. */
  yourTime(local: string): string {
    const tz = this.settings()?.timezone, mine = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!tz || !local || tz === mine) return '';
    try {
      const at = zonedToInstant(local, tz);
      return `${new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)} your time (${city(mine)})`;
    } catch { return ''; }
  }

  /** The request body (cents and basis points). */
  input(): DiscountInput {
    const f = this.f;
    const effect = f.effectType === 'percent' ? { type: 'percent' as const, bp: Math.round(Number(f.percent ?? 0) * 100) } : { type: f.effectType, cents: cents(f.amount) ?? 0 };
    const end = f.endMode === 'never' ? null : f.endMode === 'day' ? (f.endDay ? addLocalDays(`${f.endDay}T00:00`, 1) : '') : f.end || '';
    return {
      name: f.name.trim(), label: f.label.trim(), campaign: f.campaign.trim() || null,
      trigger: f.trigger, scope: f.effectType === 'fixedPrice' ? 'line' : f.scope,
      audience: f.audience === 'customers' ? { type: 'customers', customerIds: [...f.customerIds] } : f.audience === 'profiles' ? { type: 'profiles', profileIds: [...f.profileIds] } : { type: 'everyone' },
      access: { requiresSignIn: f.audience !== 'everyone' || f.requiresSignIn },
      target: f.target === 'all' ? { type: 'all' } : f.target === 'products' ? { type: 'products', productIds: [...f.productIds] } : { type: 'categories', categoryIds: [...f.categoryIds] },
      excludeProductIds: f.target === 'products' ? [] : [...f.excludeProductIds],
      effect: effect as DiscountInput['effect'],
      conditions: { minSubtotalCents: cents(f.minSubtotal), minQty: num(f.minQty) },
      limits: { totalUses: num(f.totalUses), maxDiscountPerOrderCents: cents(f.maxPerOrder) },
      perCustomer: { maxOrders: num(f.pcMaxOrders), maxAmountCents: cents(f.pcMaxAmount), firstOrders: num(f.pcFirstOrders) },
      declinable: f.declinable, combinable: f.trigger === 'code' ? f.combinable : false, priority: num(f.priority) ?? 0,
      schedule: { start: this.isNew() && f.startNow ? null : f.start || '', end },
      status: f.status,
    };
  }

  /** Runs the same validator as the server, so mistakes show up before saving. */
  private validate(): { ok: true; data: ReturnType<typeof normalizeDiscount> } | { ok: false; errors: FieldError[] } {
    try { return { ok: true, data: normalizeDiscount(this.input(), { timezone: this.settings()?.timezone ?? 'UTC', now: Date.now() }) }; }
    catch (e) { if (e instanceof DiscountValidationError) return { ok: false, errors: e.errors }; throw e; }
  }

  previewNote() {
    const v = this.validate();
    if (!v.ok) return 'Complete the form to see a preview.';
    return v.data.scope === 'order' ? 'A sample order with matching products, with only this offer applied:' : 'Matching products with only this offer applied:';
  }

  /** Live preview using the same pricing engine as checkout, with only this offer (conditions assumed met). */
  preview(): { rows: { name: string; list: string; now: string }[]; warnings: string[]; notes: string[] } {
    const v = this.validate();
    const out = { rows: [] as { name: string; list: string; now: string }[], warnings: [] as string[], notes: [] as string[] };
    if (!v.ok) return out;
    const d = v.data, now = Date.now();
    this.ensurePool(d.target);
    const matching = this.products().filter((p) => p.active && !p.deleted && !d.excludeProductIds.includes(p.id) && (d.target.type === 'all' || (d.target.type === 'products' ? d.target.productIds.includes(p.id) : !!p.categoryId && d.target.categoryIds.includes(p.categoryId))));
    // The preview shows what the offer does to prices, for anyone it is meant for.
    const draft: Discount = { ...d, id: 'draft', usedCount: 0, status: 'active', startsAt: new Date(0).toISOString(), endsAt: null, trigger: 'automatic', conditions: { minSubtotalCents: null, minQty: null }, audience: { type: 'everyone' }, access: { requiresSignIn: false } };
    const sample = matching.slice(0, 5);
    const run = (items: ProductSummary[]) => price({ now, lines: items.map((p) => ({ productId: p.id, categoryId: p.categoryId ?? null, listCents: toCents(p.price), qty: 1, name: p.name })), shopper: { identityId: null, customerId: null, signedIn: true, profileIds: [] }, discounts: [draft] });
    if (d.scope === 'line') {
      for (const p of sample) { const r = run([p]); out.rows.push({ name: p.name, list: formatMoney(r.subtotalCents), now: formatMoney(r.totalCents) }); }
    } else if (sample.length) {
      const r = run(sample.slice(0, 3));
      out.rows.push({ name: `Order of ${Math.min(sample.length, 3)} items`, list: formatMoney(r.subtotalCents), now: formatMoney(r.totalCents) });
    }
    if (!matching.length) out.warnings.push('No visible products match right now.');
    if (d.effect.type === 'percent' && d.effect.bp > 5000) out.warnings.push('More than half off. Double-check the percentage.');
    if (d.effect.type === 'fixedPrice') {
      const fixed = d.effect.cents;
      const above = matching.filter((p) => toCents(p.price) <= fixed).length;
      if (above) out.notes.push(`${above} matching ${above === 1 ? 'product already costs' : 'products already cost'} ${formatMoney(fixed)} or less; ${above === 1 ? 'its' : 'their'} price won't change (a fixed price never raises a price).`);
      if (matching.some((p) => fixed < toCents(p.price) / 2)) out.warnings.push('Some products drop to less than half their price.');
    }
    const state = discountState({ ...d, usedCount: this.current()?.usedCount ?? 0 }, now);
    if (state === 'ended') out.warnings.push('The end date is in the past: this offer has already ended.');
    if (state === 'scheduled') out.notes.push(`Scheduled: starts ${fmtLocal(d.schedule.start)} (${this.tzCity()} time).`);
    const startChanged = this.isNew() ? !this.f.startNow : d.schedule.start !== this.current()?.schedule.start;
    if (startChanged && Date.parse(d.startsAt) < now - 60_000 && state !== 'ended') out.notes.push('Starts in the past: it is active as soon as you save. Orders already placed are not changed.');
    if (d.conditions.minSubtotalCents || d.conditions.minQty) out.notes.push('The preview assumes the minimum order conditions are met.');
    if (d.audience.type === 'customers') {
      const without = d.audience.customerIds.filter((id) => !this.customers().find((c) => c.id === id)?.activated).length;
      out.notes.push(`Only for ${d.audience.customerIds.length} chosen ${d.audience.customerIds.length === 1 ? 'customer' : 'customers'}, when signed in.${without ? ` ${without} ${without === 1 ? 'has' : 'have'} no account yet: create an activation link on their customer page.` : ''}`);
    } else if (d.audience.type === 'profiles') {
      const members = d.audience.profileIds.reduce((a, id) => a + (this.profiles().find((p) => p.id === id)?.activeMembers ?? 0), 0);
      out.notes.push(`For the ${members} ${members === 1 ? 'member' : 'members'} of the chosen ${d.audience.profileIds.length === 1 ? 'profile' : 'profiles'}, when signed in. New members get it too.`);
    } else if (d.access.requiresSignIn) out.notes.push('Only for customers with an account, when signed in.');
    if (d.trigger === 'code' && !this.codesTotal()) out.notes.push(this.isNew() ? 'After saving, add or generate codes so shoppers can use this voucher.' : 'No codes yet: add or generate codes below.');
    if (d.status !== 'active') out.notes.push(d.status === 'paused' ? 'Paused: shoppers don’t get this offer until you resume it.' : 'Archived.');
    return out;
  }

  /** Loads the products the preview needs when the target changes (a sample: the preview shows at most 5). */
  private ensurePool(t: Discount['target']) {
    const key = JSON.stringify(t);
    if (key === this.poolKey) return;
    this.poolKey = key;
    const params: Record<string, string> = t.type === 'products' ? { ids: t.productIds.slice(0, 200).join(',') } : { status: 'visible', limit: '50', ...(t.type === 'categories' ? { category: t.categoryIds.join(',') } : {}) };
    if (t.type === 'products' && !t.productIds.length) { this.products.set([]); return; }
    this.api.productSummaries(params).subscribe({ next: (r) => { if (this.poolKey === key) { this.products.set(r.items); this.poolTotal.set(r.total); } }, error: () => {} });
  }

  save() {
    this.saved.set(false); this.error.set('');
    const v = this.validate();
    this.attempted.set(true);
    this.fieldErrors.set([]);
    if (!v.ok) { this.error.set('Please fix the highlighted fields.'); return; }
    this.saving.set(true);
    const body = this.input();
    const cur = this.current();
    const req = cur ? this.api.updateDiscount(cur.id, { ...body, version: cur.version }) : this.api.createDiscount(body);
    req.subscribe({
      next: (d) => {
        this.saving.set(false);
        if (!cur) { this.router.navigate(['/discounts', d.id]); return; }
        this.loadOffer(d); this.saved.set(true);
      },
      error: (e) => {
        this.saving.set(false);
        this.fieldErrors.set(e.error?.fields ?? []);
        this.error.set(e.status === 409 ? 'Someone else changed this offer. Reload the page to see their changes.' : e.error?.error ?? e.error?.message ?? 'Could not save.');
      },
    });
  }

  act(action: 'pause' | 'resume' | 'archive') { const d = this.current(); if (d) this.api.discountAction(d.id, action).subscribe((x) => this.loadOffer(x)); }
  duplicate() { const d = this.current(); if (d) this.api.discountAction(d.id, 'duplicate').subscribe((copy) => this.router.navigate(['/discounts', copy.id])); }
  arm(what: 'archive' | 'delete') {
    const d = this.current(); if (!d) return;
    if (this.armed() !== what) { this.armed.set(what); setTimeout(() => { if (this.armed() === what) this.armed.set(''); }, UI.confirmMs); return; }
    this.armed.set('');
    if (what === 'archive') this.act('archive');
    else this.api.deleteDiscount(d.id).subscribe({ next: () => this.router.navigate(['/discounts']), error: (e) => this.error.set(e.error?.error ?? 'Could not delete.') });
  }

  // ---- codes ----
  private loadCodes(reset: boolean) {
    const d = this.current(); if (!d) return;
    this.api.codes(d.id, reset ? 0 : this.codes().length, 50).subscribe((p) => { this.codes.set(reset ? p.items : [...this.codes(), ...p.items]); this.codesTotal.set(p.total); });
  }
  moreCodes() { this.loadCodes(false); }
  private codeDone = { next: () => { this.codeError.set(''); this.loadCodes(true); }, error: (e: { error?: { error?: string; fields?: FieldError[] } }) => this.codeError.set(e.error?.fields?.[0]?.message ? `${e.error.fields[0].message}` : e.error?.error ?? 'Could not add the code.') };
  addCode() { const d = this.current(); if (d && this.newCode.trim()) this.api.addCode(d.id, this.newCode).subscribe({ ...this.codeDone, next: () => { this.newCode = ''; this.codeDone.next(); } }); }
  generate() { const d = this.current(); if (d) this.api.generateCodes(d.id, Number(this.genCount), this.genPrefix.trim()).subscribe(this.codeDone); }
  deleteCode(c: VoucherCode) { const d = this.current(); if (d) this.api.deleteCode(d.id, c.id).subscribe(this.codeDone); }
  downloadCodes() { const d = this.current(); if (d) this.api.downloadCsv(`/api/discounts/${d.id}/codes`, `codes-${d.name}.csv`).subscribe(); }
  olderHistory() {
    const d = this.current();
    if (d) this.api.audit('discount', d.id, this.historyNext()).subscribe((a) => { this.history.set([...this.history(), ...a.items]); this.historyNext.set(a.next); });
  }
  downloadHistory() { const d = this.current(); if (d) this.api.downloadCsv('/api/audit', `history-${d.name}.csv`, { entity: 'discount', id: d.id }).subscribe(); }
  downloadRedemptions() { const d = this.current(); if (d) this.api.downloadCsv(`/api/discounts/${d.id}/redemptions`, `redemptions-${d.name}.csv`).subscribe(); }
}

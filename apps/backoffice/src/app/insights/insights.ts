import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import { addLocalDays } from '@openshop/pricing';
import { ApiService, CampaignRow, ChoiceDay, ChoiceRow, DayRow, OfferRow, SavedRow, SearchMissRow, Summary } from '../api.service';
import { city } from '../discounts/ui';
import { Columns, HBars, SegmentDef, Stacked, shortDay } from './charts';

const money = (n: number) => `€${n.toFixed(2)}`;
const CHOICE_DEFS: SegmentDef[] = [
  { key: 'codeMore', label: 'Chose the code, paying more', color: '#2B4BFF' },
  { key: 'autoMore', label: 'Chose the automatic offers, paying more', color: '#8B5CF6' },
  { key: 'best', label: 'Took the best price', color: '#12805C' },
  { key: 'none', label: "Saw the choice, didn't order", color: '#CBD0E0' },
];

@Component({
  selector: 'app-insights',
  imports: [FormsModule, RouterLink, Columns, HBars, Stacked],
  template: `
    <header class="page-h">
      <div><h1>Insights</h1><p>What your discounts cost and bring in. Days are in shop time ({{ tzCity() }}).</p></div>
    </header>
    <div class="toolbar">
      <div class="period">
        @for (n of [7, 30, 90]; track n) { <button class="btn sm" [class.primary]="preset() === n" (click)="last(n)">Last {{ n }} days</button> }
        <input class="inp" type="date" [ngModel]="from()" (ngModelChange)="custom($event, to())" aria-label="From">
        <span>to</span>
        <input class="inp" type="date" [ngModel]="to()" (ngModelChange)="custom(from(), $event)" aria-label="To">
      </div>
    </div>
    @if (error()) { <p class="err" role="alert">{{ error() }}</p> }

    @if (s(); as s) {
      <div class="kpis">
        <div class="kpi"><small>Revenue</small><b>{{ m(s.revenue) }}</b><span [class]="deltaClass(s.revenue, s.previous.revenue)">{{ delta(s.revenue, s.previous.revenue) }}</span></div>
        <div class="kpi"><small>Orders</small><b>{{ s.orders }}</b><span [class]="deltaClass(s.orders, s.previous.orders)">{{ delta(s.orders, s.previous.orders) }}</span></div>
        <div class="kpi"><small>Orders with a discount</small><b>{{ s.ordersWithDiscount }}</b><span class="muted">{{ s.orders ? ((s.ordersWithDiscount / s.orders) * 100).toFixed(0) : 0 }}% of orders</span></div>
        <div class="kpi"><small>Discount cost</small><b>{{ m(s.discountCost) }}</b><span class="muted">{{ s.discountShare }}% of list-price sales</span></div>
        <div class="kpi"><small>Average discount</small><b>{{ m(s.avgDiscount) }}</b><span class="muted">per discounted order</span></div>
        <div class="kpi"><small>Average order</small><b>{{ m(s.avgOrderValue) }}</b><span [class]="deltaClass(s.avgOrderValue, s.previous.avgOrderValue)">{{ delta(s.avgOrderValue, s.previous.avgOrderValue) }}</span></div>
      </div>

      <section class="card pad block">
        <div class="sec-row"><h3>Revenue and discount cost per day</h3><button class="btn sm" (click)="csv('/api/reports/discounts', 'day')">Download CSV</button></div>
        <os-columns [labels]="dayLabels()" [bars]="dayRevenue()" [line]="dayCost()" barLabel="Revenue" lineLabel="Discount cost" ariaLabel="Revenue and discount cost per day"></os-columns>
      </section>

      <div class="grid2">
        <section class="card pad block">
          <div class="sec-row"><h3>Discount cost by offer</h3><button class="btn sm" (click)="csv('/api/reports/discounts', 'discount')">CSV</button></div>
          <os-hbars [rows]="offerBars()"></os-hbars>
        </section>
        <section class="card pad block">
          <div class="sec-row"><h3>By campaign</h3><button class="btn sm" (click)="csv('/api/reports/discounts', 'campaign')">CSV</button></div>
          <os-hbars [rows]="campaignBars()" color="#FFB020"></os-hbars>
        </section>
      </div>

      <section class="card pad block">
        <div class="sec-row"><h3>Code or automatic offers: what shoppers chose</h3><button class="btn sm" (click)="csv('/api/reports/choices', 'code')">Download CSV</button></div>
        <p class="hint-top">When a code can't be combined with the automatic offers, shoppers see both totals and pick one (the cheaper one is preselected).
          Shoppers who pick a code although it costs them more are choosing to support it, for example an influencer's code. That is a signal for partnerships.</p>
        <div class="kpis small">
          <div class="kpi"><small>Shoppers who had the choice</small><b>{{ s.choices.shown }}</b></div>
          <div class="kpi"><small>Then ordered</small><b>{{ s.choices.ordered }}</b></div>
          <div class="kpi"><small>Chose the less favourable option</small><b>{{ s.choices.lessFavourable }}</b><span class="muted">{{ s.choices.lessFavourableRate }}% of those orders</span></div>
          <div class="kpi"><small>Extra paid by choice</small><b>{{ m(s.choices.extraPaid) }}</b><span class="muted">avg {{ m(s.choices.avgExtraWhenLessFavourable) }}</span></div>
        </div>
        <os-stacked [rows]="choiceBars()" [defs]="choiceDefs"></os-stacked>
        @if (choices().length) {
          <ul class="insight-list">
            @for (c of choices(); track c.code + c.discountId) { <li>{{ sentence(c) }}</li> }
          </ul>
          <table class="tbl mini block">
            <thead><tr><th>Code</th><th>Offer</th><th class="num">Had the choice</th><th class="num">Ordered</th><th class="num">Code, paying more</th><th class="num">Best price</th><th class="num">Less favourable</th><th class="num">Extra paid</th></tr></thead>
            <tbody>
              @for (c of choices(); track c.code + c.discountId) {
                <tr><td class="mono cell-main">{{ c.code }}</td><td><a [routerLink]="['/discounts', c.discountId]">{{ c.name }}</a>@if (c.campaign) { <div class="cell-sub">{{ c.campaign }}</div> }</td>
                  <td class="num">{{ c.shown }}</td><td class="num">{{ c.ordered }}</td><td class="num">{{ c.choseCodePayingMore }}</td><td class="num">{{ c.tookBest }}</td><td class="num">{{ c.lessFavourableRate }}%</td><td class="num">{{ m(c.extraPaid) }}</td></tr>
              }
            </tbody>
          </table>
          <h4 class="block">Over time</h4>
          <os-columns [labels]="dayLabels()" [bars]="choiceShown()" [line]="choiceLess()" barLabel="Had the choice" lineLabel="Chose the less favourable option" [money]="false" ariaLabel="Choices per day"></os-columns>
        }
      </section>

      <section class="card pad block">
        <div class="sec-row"><h3>Limited offers saved for later</h3><button class="btn sm" (click)="csv('/api/reports/saved-for-later')">CSV</button></div>
        <p class="hint-top">Shoppers can keep an offer with a per-customer limit for a later order. {{ s.savedForLater.orders }} {{ s.savedForLater.orders === 1 ? 'order' : 'orders' }} did, paying {{ m(s.savedForLater.extraPaid) }} more at the time.</p>
        <os-hbars [rows]="savedBars()" color="#8B5CF6"></os-hbars>
      </section>

      <section class="card pad block" aria-labelledby="misses-h">
        <div class="sec-row"><h3 id="misses-h">Shop searches that found nothing</h3><button class="btn sm" (click)="csv('/api/reports/search-misses')">CSV</button></div>
        <p class="hint-top">What shoppers looked for and didn't find: a product you don't sell (yet), another word for one you do, or a missing description. Only the words are kept, never who searched.</p>
        @if (misses().length) {
          <table class="tbl mini misses">
            <thead><tr><th>Search</th><th class="num">Times</th><th class="num">Days</th><th>Last searched</th><th>Today</th></tr></thead>
            <tbody>
              @for (r of misses().slice(0, 50); track r.q) {
                <tr><td>{{ r.q }}</td><td class="num">{{ r.count }}</td><td class="num">{{ r.days }}</td><td>{{ r.lastAt.slice(0, 10) }}</td>
                  <td>@if (r.findsNow) { <a [routerLink]="['/products']" [queryParams]="{ q: r.q }">finds {{ r.findsNow }} {{ r.findsNow === 1 ? 'product' : 'products' }}</a> } @else { <span class="muted">still nothing</span> }</td></tr>
              }
            </tbody>
          </table>
          @if (missesTotal() > 50) { <p class="hint">{{ missesTotal() - 50 }} more in the CSV.</p> }
        } @else { <p class="muted">No searches without results in this period.</p> }
      </section>
    } @else { <div class="card pad">Loading…</div> }`,
})
export class Insights {
  private api = inject(ApiService);
  s = signal<Summary | null>(null); days = signal<DayRow[]>([]); offers = signal<OfferRow[]>([]); campaigns = signal<CampaignRow[]>([]);
  choices = signal<ChoiceRow[]>([]); choiceDays = signal<ChoiceDay[]>([]); saved = signal<SavedRow[]>([]);
  misses = signal<SearchMissRow[]>([]); missesTotal = signal(0);
  from = signal(''); to = signal(''); preset = signal<number | null>(30); tz = signal('UTC'); error = signal('');
  choiceDefs = CHOICE_DEFS;
  m = money;
  tzCity = computed(() => city(this.tz()));
  dayLabels = computed(() => this.days().map((d) => d.day));
  dayRevenue = computed(() => this.days().map((d) => d.revenue));
  dayCost = computed(() => this.days().map((d) => d.discountCost));
  choiceShown = computed(() => this.choiceDays().map((d) => d.shown));
  choiceLess = computed(() => this.choiceDays().map((d) => d.lessFavourable));
  offerBars = computed(() => this.offers().slice(0, 10).map((o) => ({ label: o.name, value: o.discountCost, note: `${o.orders} ${o.orders === 1 ? 'order' : 'orders'} · ${money(o.revenue)} revenue` })));
  campaignBars = computed(() => this.campaigns().map((c) => ({ label: c.campaign, value: c.discountCost, note: `${c.orders} ${c.orders === 1 ? 'order' : 'orders'} · ${money(c.revenue)} revenue` })));
  savedBars = computed(() => this.saved().map((r) => ({ label: r.name, value: r.extraPaid, note: `${r.orders} ${r.orders === 1 ? 'order' : 'orders'}` })));
  choiceBars = computed(() => this.choices().map((c) => ({
    label: c.code, note: c.name,
    segments: [{ key: 'codeMore', value: c.choseCodePayingMore }, { key: 'autoMore', value: c.choseAutomaticPayingMore }, { key: 'best', value: c.tookBest }, { key: 'none', value: c.notOrdered }],
  })));

  constructor() {
    this.api.settings().subscribe((st) => { this.tz.set(st.timezone); this.today = st.nowLocal.slice(0, 10); this.last(30); });
  }
  private today = '';
  last(n: number) {
    this.preset.set(n);
    this.to.set(this.today);
    this.from.set(addLocalDays(`${this.today}T00:00`, -(n - 1)).slice(0, 10));
    this.load();
  }
  custom(from: string, to: string) {
    if (!from || !to) return;
    this.preset.set(null); this.from.set(from); this.to.set(to); this.load();
  }
  load() {
    const f = this.from(), t = this.to();
    this.error.set('');
    forkJoin({
      s: this.api.summary(f, t), days: this.api.reportDays(f, t), offers: this.api.reportOffers(f, t), campaigns: this.api.reportCampaigns(f, t),
      choices: this.api.reportChoices(f, t), choiceDays: this.api.reportChoiceDays(f, t), saved: this.api.reportSaved(f, t),
    }).subscribe({
      next: (r) => { this.s.set(r.s); this.days.set(r.days.items); this.offers.set(r.offers.items); this.campaigns.set(r.campaigns.items); this.choices.set(r.choices.items); this.choiceDays.set(r.choiceDays.items); this.saved.set(r.saved.items); },
      error: (e) => this.error.set(e.error?.error ?? 'Could not load the reports.'),
    });
    // Loaded on its own: the search report never holds up the sales reports.
    this.api.reportSearchMisses(f, t).subscribe({ next: (r) => { this.misses.set(r.items); this.missesTotal.set(r.total); }, error: () => this.misses.set([]) });
  }
  delta(cur: number, prev: number) {
    if (!prev) return cur ? 'new this period' : '';
    const p = ((cur - prev) / prev) * 100;
    return `${p >= 0 ? '▲' : '▼'} ${Math.abs(p).toFixed(0)}% vs previous period`;
  }
  deltaClass(cur: number, prev: number) { return !prev ? 'muted' : cur >= prev ? 'up' : 'down'; }
  /** Plain-language reading of one code's row. */
  sentence(c: ChoiceRow) {
    const parts: string[] = [];
    if (c.ordered) {
      parts.push(c.choseCodePayingMore
        ? `${c.choseCodePayingMore} of ${c.ordered} shoppers who ordered (${Math.round((c.choseCodePayingMore / c.ordered) * 100)}%) picked ${c.code} although the automatic offers were cheaper, paying ${money(c.extraPaid)} more in total.`
        : `All ${c.ordered} shoppers who ordered took the best price.`);
      if (c.choseAutomaticPayingMore) parts.push(`${c.choseAutomaticPayingMore} chose the automatic offers although ${c.code} was cheaper.`);
    }
    if (c.notOrdered) parts.push(`${c.notOrdered} saw the choice but didn't order.`);
    return parts.join(' ');
  }
  csv(url: string, groupBy?: string) {
    const params: Record<string, string> = { from: this.from(), to: this.to(), ...(groupBy ? { groupBy } : {}) };
    this.api.downloadCsv(url, `${url.split('/').pop()}-${groupBy ?? 'all'}-${this.from()}-${this.to()}.csv`, params).subscribe();
  }
  day = shortDay;
}

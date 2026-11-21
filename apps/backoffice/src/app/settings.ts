import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { instantToLocal } from '@openshop/pricing';
import { ApiService, Display, Settings, ZoneChange } from './api.service';
import { city, fmtLocal } from './discounts/ui';
import { SecuritySettings } from './security-settings';

const ZONES: string[] = (() => { try { return [...(Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone'), 'UTC']; } catch { return ['UTC', 'Europe/Lisbon']; } })();

@Component({
  selector: 'app-settings',
  imports: [FormsModule, SecuritySettings],
  template: `
    <header class="page-h"><div><h1>Settings</h1><p>Shop time and how discounts are shown to customers{{ api.me()?.sudo ? '; security' : '' }}</p></div></header>
    @if (s(); as st) {
      <section class="card pad block">
        <h3>Shop time zone</h3>
        <p class="hint-top">Offers start and end in this time zone. An offer that ends at midnight in {{ cityOf(st.timezone) }} ends at that moment for every customer in the world.</p>
        <p>Current: <b>{{ st.timezone }}</b> ({{ st.offset }}, now {{ fmt(st.nowLocal) }})
          @if (!st.timezoneConfirmed) { <span class="pill warn">Not confirmed</span> }</p>
        <form class="nform" (ngSubmit)="preview()">
          <label class="fld"><span>Time zone</span><input class="inp" name="tz" list="zones" [(ngModel)]="tz" autocomplete="off" placeholder="e.g. Europe/Lisbon"></label>
          <datalist id="zones">@for (z of zones; track z) { <option [value]="z"></option> }</datalist>
          <button class="btn">{{ tz === st.timezone ? 'Confirm' : 'Review change' }}</button>
        </form>
        @if (impact(); as im) {
          <div class="impact">
            @if (im.changes.length) {
              <p><b>{{ im.changes.length }} {{ im.changes.length === 1 ? 'offer moves' : 'offers move' }}</b> so they keep their times on the clock in {{ cityOf(im.timezone) }} ({{ im.offset }}). Offers that already started keep their start; ended offers don't change.</p>
              <table class="tbl mini"><thead><tr><th>Offer</th><th>Starts</th><th>Ends</th></tr></thead><tbody>
                @for (c of im.changes; track c.id) { <tr><td>{{ c.name }}</td><td class="cell-sub">{{ local(c.newStartsAt, im.timezone) }}</td><td class="cell-sub">{{ c.newEndsAt ? local(c.newEndsAt, im.timezone) : 'never' }}</td></tr> }
              </tbody></table>
            } @else { <p>No offers are affected.</p> }
            <button class="btn primary" type="button" (click)="apply(im.timezone)">Use {{ im.timezone }}</button>
            <button class="btn ghost" type="button" (click)="impact.set(null)">Cancel</button>
          </div>
        }
        @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
        @if (msg()) { <p class="ok-msg" role="status">{{ msg() }}</p> }
      </section>

      <section class="card pad block">
        <h3>How discounts look in the shop</h3>
        <label class="sw"><span><b>Show the original price</b><small>Struck through next to the discounted price.</small></span><input type="checkbox" [ngModel]="st.display.showOriginalPrice" (ngModelChange)="setDisplay('showOriginalPrice', $event)"><i></i></label>
        <label class="sw"><span><b>Show a % badge</b><small>For example “−20%”.</small></span><input type="checkbox" [ngModel]="st.display.showBadge" (ngModelChange)="setDisplay('showBadge', $event)"><i></i></label>
        <label class="sw"><span><b>Show other offers that apply</b><small>On product pages and in the cart, with the price each would give.</small></span><input type="checkbox" [ngModel]="st.display.showAlternatives" (ngModelChange)="setDisplay('showAlternatives', $event)"><i></i></label>
      </section>
    }
    @if (api.me()?.sudo) { <app-security-settings /> }`,
})
export class SettingsPage {
  api = inject(ApiService);
  s = signal<Settings | null>(null);
  impact = signal<{ timezone: string; offset: string; changes: ZoneChange[] } | null>(null);
  error = signal(''); msg = signal('');
  tz = '';
  zones = ZONES;
  cityOf = city; fmt = fmtLocal;
  local = (iso: string, tz: string) => fmtLocal(instantToLocal(Date.parse(iso), tz));
  constructor() { this.load(); }
  load() { this.api.settings().subscribe((s) => { this.s.set(s); this.tz = s.timezone; }); }
  preview() {
    this.error.set(''); this.msg.set('');
    this.api.timezoneImpact(this.tz.trim()).subscribe({ next: (r) => this.impact.set(r), error: () => this.error.set('Unknown time zone. Pick one from the list, e.g. Europe/Lisbon.') });
  }
  apply(tz: string) {
    this.api.updateSettings({ timezone: tz }).subscribe({
      next: (s) => { this.s.set(s); this.tz = s.timezone; this.impact.set(null); this.msg.set(`Shop time zone set to ${s.timezone}.`); },
      error: (e) => this.error.set(e.error?.error ?? 'Could not save.'),
    });
  }
  setDisplay(key: keyof Display, value: boolean) { this.api.updateSettings({ display: { [key]: value } }).subscribe((s) => this.s.set(s)); }
}

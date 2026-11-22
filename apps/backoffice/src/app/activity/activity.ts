import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { ActivityQuery, ApiService, StaffMember } from '../api.service';
import { ActivityList, KIND_GROUPS } from './list';

@Component({
  selector: 'app-activity',
  imports: [FormsModule, ActivityList],
  template: `
    <header class="page-h">
      <div><h1>Activity</h1><p>Sign-ins, pages visited, changes and refused access in the backoffice. Kept for {{ api.me()?.activityRetentionDays ?? 180 }} days.</p></div>
      <button class="btn" (click)="csv()">Download CSV</button>
    </header>
    <div class="chips block-b" role="group" aria-label="Kinds of events">
      @for (g of groups; track g.id) {
        <button type="button" class="chip-toggle" [class.on]="kinds().includes(g.id)" [attr.aria-pressed]="kinds().includes(g.id)" (click)="toggleKind(g.id)">{{ g.label }}</button>
      }
    </div>
    <form class="toolbar" (ngSubmit)="apply()">
      <select class="inp" name="user" [(ngModel)]="userId" aria-label="Person">
        <option value="">Everyone</option>@for (m of staff(); track m.id) { <option [value]="m.id">{{ m.name }}{{ m.status === 'removed' ? ' (removed)' : '' }}</option> }
      </select>
      <input class="inp" type="date" name="from" [(ngModel)]="from" aria-label="From">
      <input class="inp" type="date" name="to" [(ngModel)]="to" aria-label="To">
      <input class="inp" name="ip" [(ngModel)]="ip" placeholder="IP address" aria-label="IP address">
      <input class="inp search" type="search" name="q" [(ngModel)]="q" placeholder="Search (page, permission, reason…)" aria-label="Search">
      <button class="btn primary">Apply</button>
      @if (filtered()) { <button type="button" class="btn ghost" (click)="clear()">Clear</button> }
    </form>
    <div class="card pad"><app-activity-list [query]="query()" /></div>`,
})
export class Activity {
  api = inject(ApiService);
  staff = signal<StaffMember[]>([]);
  groups = KIND_GROUPS;
  kinds = signal<string[]>([]);
  query = signal<ActivityQuery>({});
  userId = ''; from = ''; to = ''; ip = ''; q = '';
  filtered = computed(() => Object.keys(this.query()).length > 0);
  constructor() {
    this.api.staff('all').subscribe((r) => this.staff.set(r.items));
    const p = inject(ActivatedRoute).snapshot.queryParamMap;
    this.userId = p.get('userId') ?? ''; this.ip = p.get('ip') ?? '';
    this.apply();
  }
  toggleKind(id: string) { this.kinds.set(this.kinds().includes(id) ? this.kinds().filter((k) => k !== id) : [...this.kinds(), id]); this.apply(); }
  apply() {
    const kinds = [...new Set(KIND_GROUPS.filter((g) => this.kinds().includes(g.id)).flatMap((g) => g.kinds))].join(',');
    // Dates are days in the owner's time zone: from the start of "from" to the end of "to".
    const from = this.from ? new Date(`${this.from}T00:00:00`).toISOString() : undefined;
    const to = this.to ? new Date(new Date(`${this.to}T00:00:00`).getTime() + 86_400_000).toISOString() : undefined;
    const q: ActivityQuery = { kinds: kinds || undefined, userId: this.userId || undefined, ip: this.ip.trim() || undefined, q: this.q.trim() || undefined, from, to };
    this.query.set(Object.fromEntries(Object.entries(q).filter(([, v]) => v)) as ActivityQuery);
  }
  clear() { this.kinds.set([]); this.userId = this.from = this.to = this.ip = this.q = ''; this.apply(); }
  csv() { this.api.downloadCsv('/api/activity', 'activity.csv', this.query() as Record<string, string>).subscribe(); }
}

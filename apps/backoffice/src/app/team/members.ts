import { Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { ApiService, NewLink, StaffGroup, StaffMember } from '../api.service';
import { AREA_LIST, LinkBox, areaCell, statusOf } from './ui';

@Component({
  selector: 'app-team-tabs',
  imports: [RouterLink],
  template: `<nav class="tabs" aria-label="Team"><a routerLink="/team" [class.on]="on() === 'members'" class="tab-a">Members</a><a routerLink="/team/groups" [class.on]="on() === 'groups'" class="tab-a">Permission groups</a></nav>`,
})
export class TeamTabs { on = input<'members' | 'groups'>('members'); }

@Component({
  selector: 'app-team',
  imports: [FormsModule, DatePipe, RouterLink, LinkBox, TeamTabs],
  template: `
    <header class="page-h">
      <div><h1>Team</h1><p>Who can use the backoffice, and what they can do</p></div>
      <button class="btn primary" (click)="toggleInvite()">{{ inviting() ? 'Close' : '+ Invite someone' }}</button>
    </header>
    <app-team-tabs />
    @if (inviting()) {
      <section class="card pad block-b">
        <h3>Invite someone</h3>
        <p class="hint-top">You'll get a one-time link to send them yourself. They choose their own password.</p>
        <form class="nform" (ngSubmit)="invite()">
          <label class="fld req"><span>Email</span><input class="inp" name="email" type="email" [(ngModel)]="email" required></label>
          <label class="fld req"><span>Name</span><input class="inp" name="name" [(ngModel)]="name" required maxlength="120"></label>
        </form>
        <div class="fld"><span class="lbl">Groups</span>
          <div class="picks">
            @for (g of groups(); track g.id) { <label><input type="checkbox" [checked]="picked().includes(g.id)" (change)="pick(g.id, $any($event.target).checked)"> {{ g.name }}</label> }
            @empty { <small>No groups yet. <a routerLink="/team/groups">Create one</a>, or invite now and add groups later.</small> }
          </div>
        </div>
        <button class="btn primary" (click)="invite()" [disabled]="busy()">Create invitation link</button>
        @if (removed(); as r) {
          <div class="warn-box">{{ r.name }} was removed from your team earlier. <button class="btn sm" (click)="restore(r.userId)">Restore {{ r.name }}</button></div>
        }
        @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
        <app-link-box [link]="newLink()" [name]="linkName()" />
      </section>
    }
    <div class="toolbar">
      <input class="inp search" type="search" placeholder="Search by name or email" [ngModel]="q()" (ngModelChange)="q.set($event)" aria-label="Search the team">
      <select class="inp" [ngModel]="status()" (ngModelChange)="setStatus($event)" aria-label="Filter by status">
        <option value="">Everyone current</option><option value="active">Active</option><option value="invited">Invited</option><option value="suspended">Suspended</option><option value="removed">Removed</option>
      </select>
      <select class="inp" [ngModel]="group()" (ngModelChange)="group.set($event)" aria-label="Filter by group">
        <option value="">All groups</option>@for (g of groups(); track g.id) { <option [value]="g.id">{{ g.name }}</option> }
      </select>
      <label class="chk"><input type="checkbox" [ngModel]="overview()" (ngModelChange)="overview.set($event)"> Access overview</label>
      <button class="btn" (click)="csv()">Download CSV</button>
    </div>
    <div class="card">
      @if (shown().length) {
        @if (overview()) {
          <table class="tbl access-matrix">
            <thead><tr><th>Person</th>@for (a of areas; track a.id) { <th>{{ a.label }}</th> }</tr></thead>
            <tbody>
              @for (m of shown(); track m.id) {
                <tr>
                  <td><a class="cell-main link" [routerLink]="['/team', m.id]">{{ m.name }}</a><div class="cell-sub">{{ st(m).label }}</div></td>
                  @for (a of areas; track a.id) { <td [class.none]="cell(m, a.id) === '—'">{{ cell(m, a.id) }}</td> }
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <table class="tbl">
            <thead><tr><th>Person</th><th>Status</th><th>Groups</th><th>Last sign-in</th><th></th></tr></thead>
            <tbody>
              @for (m of shown(); track m.id) {
                <tr>
                  <td><a class="cell-main link" [routerLink]="['/team', m.id]">{{ m.name }}</a><div class="cell-sub">{{ m.email }}</div></td>
                  <td><span class="pill" [class]="'pill ' + st(m).cls">{{ st(m).label }}</span>
                    @if (m.pendingLink && m.status === 'invited') { <div class="cell-sub">until {{ m.pendingLink.expiresAt | date: 'd MMM, HH:mm' }}</div> }
                    @if (m.status === 'removed') { <div class="cell-sub">{{ m.removedAt | date: 'd MMM y' }}</div> }
                  </td>
                  <td>@if (m.sudo) { <span class="cell-sub">All permissions</span> } @else { @for (g of m.groups; track g.id) { <span class="tag">{{ g.name }}</span> } @empty { <span class="cell-sub">No groups</span> } }</td>
                  <td class="cell-sub">{{ m.lastLoginAt ? (m.lastLoginAt | date: 'd MMM, HH:mm') : 'Never' }}</td>
                  <td><div class="acts"><a class="btn sm" [routerLink]="['/team', m.id]">Open</a></div></td>
                </tr>
              }
            </tbody>
          </table>
        }
      } @else { <div class="empty-state"><b>Nobody matches</b>Try another search or filter, or invite someone.</div> }
    </div>`,
})
export class Members {
  private api = inject(ApiService); private router = inject(Router);
  items = signal<StaffMember[]>([]); groups = signal<StaffGroup[]>([]);
  q = signal(''); status = signal(''); group = signal(''); overview = signal(false);
  inviting = signal(false); busy = signal(false); error = signal(''); newLink = signal<NewLink | null>(null); linkName = signal('');
  removed = signal<{ userId: string; name: string } | null>(null); picked = signal<string[]>([]);
  email = ''; name = '';
  areas = AREA_LIST;
  st = statusOf;
  shown = computed(() => {
    const q = this.q().trim().toLowerCase(), s = this.status(), g = this.group();
    return this.items().filter((m) => (!q || m.name.toLowerCase().includes(q) || m.email.includes(q)) && (!s || s === 'removed' || m.status === s) && (!g || m.groups.some((x) => x.id === g)));
  });
  constructor() { this.load(); this.api.groups().subscribe((g) => this.groups.set(g)); }
  load() { this.api.staff(this.status() === 'removed' ? 'removed' : 'active').subscribe((r) => this.items.set(r.items)); }
  setStatus(v: string) { this.status.set(v); this.load(); }
  cell(m: StaffMember, area: string) { return m.sudo ? 'All' : areaCell(m.permissions, area); }
  toggleInvite() { this.inviting.set(!this.inviting()); this.newLink.set(null); this.error.set(''); this.removed.set(null); }
  pick(id: string, on: boolean) { this.picked.set(on ? [...this.picked(), id] : this.picked().filter((x) => x !== id)); }
  invite() {
    this.error.set(''); this.removed.set(null); this.newLink.set(null);
    if (!this.email.trim() || !this.name.trim()) { this.error.set('Enter an email and a name.'); return; }
    this.busy.set(true);
    this.api.invite({ email: this.email, name: this.name, groupIds: this.picked() }).subscribe({
      next: (r) => { this.busy.set(false); this.newLink.set(r.link); this.linkName.set(r.member.name); this.email = this.name = ''; this.picked.set([]); this.load(); },
      error: (e) => {
        this.busy.set(false);
        if (e.error?.code === 'removed_member') this.removed.set({ userId: e.error.userId, name: e.error.name });
        else this.error.set(e.error?.fields?.[0] ? `${e.error.fields[0].field === 'email' ? 'Email' : 'Groups'}: ${e.error.fields[0].message}` : e.error?.error ?? 'Could not create the invitation.');
      },
    });
  }
  restore(id: string) {
    this.api.restoreStaff(id).subscribe({
      next: (r) => { this.removed.set(null); this.newLink.set(r.link); this.linkName.set(r.member.name); this.load(); },
      error: (e) => this.error.set(e.error?.error ?? 'Could not restore.'),
    });
  }
  csv() { this.api.downloadCsv('/api/staff', 'team.csv', { status: this.status() === 'removed' ? 'removed' : 'active' }).subscribe(); }
}

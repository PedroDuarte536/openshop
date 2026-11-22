import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { ApiService, Customer, Profile, ProfileMember } from '../api.service';
import { STATE_CLASS, STATE_LABEL } from './ui';
import { UI } from '../config';

@Component({
  selector: 'app-profile',
  imports: [FormsModule, RouterLink, DatePipe],
  template: `
    @if (p(); as p) {
      <header class="page-h">
        <div><a class="back-link" routerLink="/discounts/profiles">← Profiles</a><h1>{{ p.name }}</h1><p>{{ p.activeMembers }} {{ p.activeMembers === 1 ? 'member' : 'members' }} · members see “{{ p.publicLabel }}”</p></div>
      </header>
      <div class="grid2">
        <form class="card pad" (ngSubmit)="save()">
          <h3>Profile</h3>
          <fieldset class="plain" [disabled]="!manage">
          <label class="fld req"><span>Name (only you see it)</span><input class="inp" name="name" [(ngModel)]="f.name" maxlength="120"></label>
          <label class="fld req"><span>Label (members see it next to their prices)</span><input class="inp" name="label" [(ngModel)]="f.publicLabel" maxlength="80"></label>
          <label class="fld"><span>Notes</span><textarea class="inp" name="desc" [(ngModel)]="f.description" maxlength="500"></textarea></label>
          <label class="sw"><span><b>Active</b><small>Paused: members keep their membership but get none of the profile's offers.</small></span><input type="checkbox" name="active" [ngModel]="f.status === 'active'" (ngModelChange)="f.status = $event ? 'active' : 'paused'"><i></i></label>
          </fieldset>
          @if (manage) {
          <div class="save-bar">
            @if (saved()) { <p class="ok-msg" role="status">{{ saved() }}</p> }
            @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
            <button class="btn primary">Save changes</button>
          </div>
          }
        </form>
        <section class="card pad">
          <div class="sec-row"><h3>Offers for this profile</h3>@if (manage) { <a class="btn sm" [routerLink]="['/discounts/new']" [queryParams]="{ profile: p.id }">+ Add an offer</a> }</div>
          @for (r of p.rules; track r.id) {
            <div class="row-line"><a [routerLink]="['/discounts', r.id]"><b>{{ r.name }}</b></a><span>{{ r.effect }}</span><span class="pill" [class]="'pill ' + stateClass[r.state]">{{ stateLabel[r.state] }}</span></div>
          } @empty { <p class="cell-sub">No offers yet. Add one: a % off everything, a special price for some products, a voucher only members can use…</p> }
        </section>
      </div>

      @if (!seeMembers) {
        <section class="card pad block"><h3>Members</h3><p class="cell-sub">{{ p.activeMembers }} active {{ p.activeMembers === 1 ? 'member' : 'members' }}. Names need “See customers and their details”.</p></section>
      } @else {
      <section class="card pad block">
        <div class="sec-row"><h3>Members <small>{{ members().length }}</small></h3>
          <button class="btn sm" type="button" (click)="download()" [disabled]="!members().length">Download CSV</button></div>
        @if (changeMembers) {
        <form class="nform" (ngSubmit)="add()">
          <label class="fld"><span>Find a customer</span><input class="inp" name="q" [ngModel]="q()" (ngModelChange)="q.set($event)" placeholder="Name or email" list="cust-list" autocomplete="off"></label>
          <datalist id="cust-list">@for (c of candidates(); track c.id) { <option [value]="c.email">{{ c.name }}</option> }</datalist>
          <label class="fld small"><span>Last day (optional)</span><input class="inp" type="date" name="last" [(ngModel)]="lastDay"></label>
          <button class="btn" [disabled]="!match()">Add member</button>
        </form>
        }
        @if (match(); as m) { <p class="cell-sub">Adds {{ m.name }} ({{ m.email }}){{ m.activated ? '' : ': they have no account yet, so they get the offers once they sign in' }}.</p> }
        @if (members().length) {
          <table class="tbl">
            <thead><tr><th>Customer</th><th>Account</th><th>Until</th><th></th></tr></thead>
            <tbody>
              @for (m of members(); track m.customerId) {
                <tr>
                  <td><a class="cell-main link" [routerLink]="['/customers', m.customerId]">{{ m.name }}</a><div class="cell-sub">{{ m.email }}</div></td>
                  <td><span class="pill" [class.ok]="m.activated">{{ m.activated ? 'Active' : 'No account' }}</span></td>
                  <td class="cell-sub">{{ m.validUntil ? (m.validUntil | date: 'd MMM y, HH:mm') : 'No end' }}</td>
                  <td><div class="acts">@if (changeMembers) { <button class="btn sm ghost" (click)="removeMember(m.customerId)">Remove</button> }</div></td>
                </tr>
              }
            </tbody>
          </table>
        }
      </section>
      }
      @if (manage) {
      <section class="card pad block danger-zone">
        <h3>Delete profile</h3>
        <p class="hint-top">Only possible without members, and after archiving its offers.</p>
        <button class="btn danger" [class.armed]="armed()" (click)="remove()">{{ armed() ? 'Click to confirm' : 'Delete profile' }}</button>
      </section>
      }
    } @else { <div class="card pad">Loading…</div> }`,
})
export class ProfilePage {
  private api = inject(ApiService);
  manage = this.api.can('discounts.manage');
  /** Member lists show customers' names and emails. */
  seeMembers = this.api.can({ all: ['discounts.view', 'customers.view'] });
  changeMembers = this.api.can({ all: ['discounts.manage', 'customers.view'] });
  private router = inject(Router);
  id = input.required<string>();
  p = signal<Profile | null>(null); members = signal<ProfileMember[]>([]); customers = signal<Customer[]>([]);
  saved = signal(''); error = signal(''); armed = signal(false); q = signal('');
  f = { name: '', publicLabel: '', description: '', status: 'active' as 'active' | 'paused' };
  lastDay = '';
  stateLabel = STATE_LABEL; stateClass = STATE_CLASS;
  candidates = computed(() => {
    const q = this.q().trim().toLowerCase(), inside = new Set(this.members().map((m) => m.customerId));
    return this.customers().filter((c) => !inside.has(c.id) && (!q || c.email.includes(q) || c.name.toLowerCase().includes(q))).slice(0, 50);
  });
  match = computed(() => { const q = this.q().trim().toLowerCase(); return this.candidates().find((c) => c.email === q) ?? (this.candidates().length === 1 && q ? this.candidates()[0] : null); });
  constructor() {
    effect(() => { const id = this.id(); untracked(() => this.load(id)); });
    if (this.changeMembers) this.api.customers().subscribe((c) => this.customers.set(c));
  }
  load(id = this.id()) {
    this.api.profile(id).subscribe({ next: (p) => { this.p.set(p); this.f = { name: p.name, publicLabel: p.publicLabel, description: p.description, status: p.status }; }, error: () => this.router.navigate(['/discounts/profiles']) });
    if (this.seeMembers) this.api.profileMembers(id).subscribe((m) => this.members.set(m.items));
  }
  save() {
    const p = this.p(); if (!p) return;
    this.saved.set(''); this.error.set('');
    this.api.updateProfile(p.id, { ...this.f, version: p.version }).subscribe({
      next: (r) => { this.p.set(r); this.saved.set(`Saved. This applies to ${r.affectedMembers} ${r.affectedMembers === 1 ? 'customer' : 'customers'} now.`); },
      error: (e) => this.error.set(e.status === 409 ? 'Someone else changed this profile. Reload the page.' : e.error?.error ?? 'Could not save.'),
    });
  }
  add() {
    const m = this.match(); if (!m) return;
    this.api.changeMembers(this.id(), { add: [{ customerId: m.id, lastDay: this.lastDay || null }] }).subscribe(() => { this.q.set(''); this.lastDay = ''; this.load(); });
  }
  removeMember(customerId: string) { this.api.changeMembers(this.id(), { remove: [customerId] }).subscribe(() => this.load()); }
  download() { const p = this.p(); if (p) this.api.downloadCsv(`/api/discount-profiles/${p.id}/members`, `profile-${p.name}-members.csv`).subscribe(); }
  remove() {
    if (!this.armed()) { this.armed.set(true); setTimeout(() => this.armed.set(false), UI.confirmMs); return; }
    this.api.deleteProfile(this.id()).subscribe({ next: () => this.router.navigate(['/discounts/profiles']), error: (e) => { this.armed.set(false); this.error.set(e.error?.error ?? 'Could not delete.'); } });
  }
}

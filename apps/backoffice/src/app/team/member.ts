import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { AREA_LABELS, type Area } from '@openshop/iam';
import { ApiService, NewLink, StaffDetail, StaffGroup } from '../api.service';
import { ActivityList } from '../activity/list';
import { LinkBox, statusOf } from './ui';

@Component({
  selector: 'app-team-member',
  imports: [FormsModule, DatePipe, RouterLink, LinkBox, ActivityList],
  template: `
    @if (m(); as m) {
      <header class="page-h">
        <div><a class="back-link" routerLink="/team">← Team</a>
          @if (renaming()) {
            <form class="nform" (ngSubmit)="rename()"><input class="inp" name="n" [(ngModel)]="newName" maxlength="120" aria-label="Name"><button class="btn sm primary">Save</button><button type="button" class="btn sm ghost" (click)="renaming.set(false)">Cancel</button></form>
          } @else { <h1>{{ m.name }} @if (m.status !== 'removed') { <button class="btn sm ghost" (click)="startRename()" aria-label="Rename">✎</button> }</h1> }
          <p>{{ m.email }} · <span class="pill" [class]="'pill ' + st().cls">{{ st().label }}</span></p></div>
      </header>

      <div class="grid2">
        <section class="card pad">
          <h3>Access</h3>
          <div class="facts">
            <div><small>Invited</small>{{ m.createdAt ? (m.createdAt | date: 'd MMM y, HH:mm') : '—' }}{{ m.createdByName ? ' by ' + m.createdByName : '' }}</div>
            <div><small>Joined</small>{{ m.activatedAt ? (m.activatedAt | date: 'd MMM y, HH:mm') : 'Not yet' }}</div>
            <div><small>Last sign-in</small>{{ m.lastLoginAt ? (m.lastLoginAt | date: 'd MMM y, HH:mm') : 'Never' }}</div>
            @if (m.status === 'removed') { <div><small>Removed</small>{{ m.removedAt | date: 'd MMM y, HH:mm' }}{{ m.removedByName ? ' by ' + m.removedByName : '' }}</div> }
            @if (m.pendingLink) { <div><small>Pending link</small>{{ m.pendingLink.purpose === 'invite' ? 'Invitation' : 'Password reset' }}, valid until {{ m.pendingLink.expiresAt | date: 'd MMM, HH:mm' }}</div> }
          </div>
          @if (m.sudo) {
            <p class="cell-sub">This is the owner account. It has every permission and can't be suspended or removed here. Change your password in <a routerLink="/account">My account</a>.</p>
          } @else {
            <div class="acts-h">
              @if (m.status === 'invited') { <button class="btn" (click)="link('invite')">{{ m.pendingLink ? 'Create a new invitation link' : 'Create invitation link' }}</button> }
              @if (m.status === 'active' || m.status === 'suspended') { <button class="btn" (click)="link('reset')">Create password reset link</button> }
              @if (m.pendingLink) { <button class="btn" (click)="revoke()">Revoke link</button> }
              @if (m.status === 'active') { <button class="btn" (click)="act('sign-out')">Sign out everywhere</button><button class="btn" (click)="act('suspend')">Suspend</button> }
              @if (m.status === 'suspended') { <button class="btn primary" (click)="act('reactivate')">Reactivate</button> }
              @if (m.status === 'removed') { <button class="btn primary" (click)="restore()">Restore {{ m.name }}</button> }
            </div>
          }
          <app-link-box [link]="newLink()" [name]="m.name" />
          @if (msg()) { <p class="ok-msg" role="status">{{ msg() }}</p> }
        </section>

        <section class="card pad">
          <h3>Groups</h3>
          @if (m.sudo) { <p class="cell-sub">The owner isn't in groups: they have every permission.</p> }
          @else if (m.status === 'removed') { <p class="cell-sub">Removed members have no groups. Restore them first.</p> }
          @else {
            <div class="picks">
              @for (g of groups(); track g.id) { <label><input type="checkbox" [checked]="chosen().includes(g.id)" (change)="choose(g.id, $any($event.target).checked)"> <a [routerLink]="['/team/groups', g.id]">{{ g.name }}</a></label> }
              @empty { <small>No groups yet. <a routerLink="/team/groups">Create one</a>.</small> }
            </div>
            @if (groupsChanged()) { <div class="acts-h"><button class="btn primary" (click)="saveGroups()">Save groups</button><button class="btn ghost" (click)="chosen.set(current())">Undo</button></div> }
          }
        </section>
      </div>

      <section class="card pad block">
        <h3>What {{ m.name }} can do</h3>
        @if (m.sudo) { <p>All permissions, plus the team, activity log and security settings.</p> }
        @else {
          <table class="tbl mini">
            <thead><tr><th>Area</th><th>Permission</th><th></th><th>From</th></tr></thead>
            <tbody>
              @for (p of m.permissionSources; track p.id) {
                <tr [class.none]="!p.granted"><td class="cell-sub">{{ area(p.area) }}</td><td>{{ p.label }}</td><td>{{ p.granted ? '✓' : '—' }}</td>
                  <td>@for (g of p.groups; track g.id) { <span class="tag">{{ g.name }}</span> }</td></tr>
              }
            </tbody>
          </table>
        }
      </section>

      @if (m.links.length) {
        <section class="card pad block">
          <h3>Links</h3>
          <table class="tbl mini">
            <thead><tr><th>Link</th><th>Created</th><th>State</th></tr></thead>
            <tbody>
              @for (l of m.links; track l.id) {
                <tr><td>{{ l.purpose === 'invite' ? 'Invitation' : 'Password reset' }}</td><td class="cell-sub">{{ l.createdAt | date: 'd MMM, HH:mm' }} by {{ l.createdBy }}</td>
                  <td><span class="pill" [class.ok]="l.state === 'used'" [class.warn]="l.state === 'pending'" [class.bad]="l.state === 'revoked'">{{ stateLabel[l.state] }}</span>
                    <span class="cell-sub"> {{ l.state === 'pending' ? 'until ' + (l.expiresAt | date: 'd MMM, HH:mm') : l.stateAt ? (l.stateAt | date: 'd MMM, HH:mm') : '' }}{{ l.revokedBy ? ' by ' + l.revokedBy : '' }}</span></td></tr>
              }
            </tbody>
          </table>
        </section>
      }

      <section class="card pad block">
        <div class="sec-row"><h3>Activity</h3><a class="btn sm" routerLink="/activity" [queryParams]="{ userId: m.id }">Open in Activity</a></div>
        <app-activity-list [userId]="m.id" [compact]="true" />
      </section>

      @if (!m.sudo && m.status !== 'removed') {
        <section class="card pad block danger-zone">
          <h3>{{ m.status === 'invited' ? 'Cancel invitation' : 'Remove from the team' }}</h3>
          <p class="hint-top">{{ m.name }} can't sign in any more and is signed out everywhere at once. Their history stays in the activity log, and you can restore them later with a new invitation.</p>
          <button class="btn danger" [class.armed]="armed()" (click)="remove()">{{ armed() ? 'Click to confirm' : (m.status === 'invited' ? 'Cancel invitation' : 'Remove ' + m.name) }}</button>
        </section>
      }
      @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
    } @else { <div class="card pad">Loading…</div> }`,
})
export class MemberPage {
  private api = inject(ApiService); private router = inject(Router);
  id = input.required<string>();
  m = signal<StaffDetail | null>(null); groups = signal<StaffGroup[]>([]);
  chosen = signal<string[]>([]); current = signal<string[]>([]);
  newLink = signal<NewLink | null>(null); msg = signal(''); error = signal(''); armed = signal(false); renaming = signal(false);
  newName = '';
  stateLabel: Record<string, string> = { pending: 'Pending', used: 'Used', revoked: 'Revoked', expired: 'Expired' };
  st = computed(() => statusOf(this.m()!));
  groupsChanged = computed(() => [...this.chosen()].sort().join() !== [...this.current()].sort().join());
  constructor() {
    effect(() => { const id = this.id(); untracked(() => this.load(id)); });
    this.api.groups().subscribe((g) => this.groups.set(g));
  }
  area = (a: string) => AREA_LABELS[a as Area] ?? a;
  load(id = this.id()) {
    this.api.staffMember(id).subscribe({ next: (m) => this.set(m), error: () => this.router.navigate(['/team']) });
  }
  private set(m: StaffDetail) { this.m.set(m); const ids = m.groups.map((g) => g.id); this.current.set(ids); this.chosen.set(ids); }
  private done = (text: string) => (m: StaffDetail) => { this.set(m); this.msg.set(text); this.error.set(''); };
  private fail = (e: { error?: { error?: string } }) => this.error.set(e.error?.error ?? 'That did not work.');
  startRename() { this.newName = this.m()!.name; this.renaming.set(true); }
  rename() { this.api.renameStaff(this.id(), this.newName, this.m()!.version).subscribe({ next: (m) => { this.renaming.set(false); this.done('Name saved.')(m); }, error: (e) => this.fail(e) }); }
  choose(id: string, on: boolean) { this.chosen.set(on ? [...this.chosen(), id] : this.chosen().filter((x) => x !== id)); }
  saveGroups() { this.api.setStaffGroups(this.id(), this.chosen()).subscribe({ next: this.done('Groups saved. The new access applies from their next click.'), error: (e) => this.fail(e) }); }
  link(purpose: 'invite' | 'reset') {
    this.msg.set('');
    this.api.staffLink(this.id(), purpose).subscribe({ next: (l) => { this.newLink.set(l); this.load(); }, error: (e) => this.fail(e) });
  }
  revoke() {
    this.api.revokeStaffLinks(this.id()).subscribe({ next: (r) => { this.newLink.set(null); this.msg.set(r.revoked ? 'Link revoked. It no longer works.' : 'There was no pending link.'); this.load(); }, error: (e) => this.fail(e) });
  }
  act(a: 'suspend' | 'reactivate' | 'sign-out') {
    const text = { suspend: 'Suspended. They are signed out and can\u2019t sign in until you reactivate them.', reactivate: 'Reactivated. They can sign in again.', 'sign-out': 'Signed out on every device.' }[a];
    this.api.staffAction(this.id(), a).subscribe({ next: this.done(text), error: (e) => this.fail(e) });
  }
  restore() { this.api.restoreStaff(this.id()).subscribe({ next: (r) => { this.newLink.set(r.link); this.done('Restored as invited. Send them the new link, then choose their groups.')(r.member); }, error: (e) => this.fail(e) }); }
  remove() {
    if (!this.armed()) { this.armed.set(true); setTimeout(() => this.armed.set(false), 3500); return; }
    this.api.removeStaff(this.id()).subscribe({ next: () => { this.armed.set(false); this.newLink.set(null); this.msg.set('Removed. Their access ended immediately.'); this.load(); }, error: (e) => this.fail(e) });
  }
}

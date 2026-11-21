import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { PERMISSIONS } from '@openshop/iam';
import { ApiService, StaffGroup, StaffMember } from '../api.service';
import { PermissionGrid, statusOf } from './ui';

@Component({
  selector: 'app-team-group',
  imports: [FormsModule, RouterLink, PermissionGrid],
  template: `
    @if (g(); as g) {
      <header class="page-h"><div><a class="back-link" routerLink="/team/groups">← Permission groups</a><h1>{{ g.name }}</h1><p>{{ g.memberCount }} {{ g.memberCount === 1 ? 'member' : 'members' }}</p></div></header>
      <div class="editor">
        <div class="ed-main">
          <section class="card pad">
            <div class="fgrid">
              <label class="fld req"><span>Name</span><input class="inp" name="name" [(ngModel)]="name" maxlength="120"></label>
              <label class="fld"><span>Description</span><input class="inp" name="desc" [(ngModel)]="description" maxlength="500"></label>
            </div>
            <h3>Permissions</h3>
            <app-permission-grid [(value)]="perms" />
          </section>
        </div>
        <aside class="ed-side"><div class="sticky">
          <section class="card pad">
            <h3>Save</h3>
            @if (dirty()) {
              @if (added().length || removedPerms().length) {
                <div class="impact-list">
                  @for (p of added(); track p) { <div class="plus">+ {{ label(p) }}</div> }
                  @for (p of removedPerms(); track p) { <div class="minus">− {{ label(p) }}</div> }
                </div>
              }
              <p class="cell-sub">@if (affected().length) { This changes access for {{ affected().length }} {{ affected().length === 1 ? 'person' : 'people' }}: {{ affectedNames() }}. It applies from their next click. } @else { Nobody is in this group yet. }</p>
              <button class="btn primary" [class.armed]="armedSave()" (click)="save()">{{ armedSave() && affected().length ? 'Click to confirm' : 'Save changes' }}</button>
              <button class="btn ghost" (click)="reset()">Undo</button>
            } @else { <p class="cell-sub">No unsaved changes.</p> }
            @if (msg()) { <p class="ok-msg" role="status">{{ msg() }}</p> }
            @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
          </section>
          <section class="card pad block">
            <h3>Members</h3>
            @for (m of g.members; track m.id) {
              <div class="row-line"><a [routerLink]="['/team', m.id]"><b>{{ m.name }}</b></a><span class="cell-sub">{{ status(m) }}</span><button class="btn sm ghost" (click)="removeMember(m.id)">Remove</button></div>
            } @empty { <p class="cell-sub">Nobody yet.</p> }
            @if (candidates().length) {
              <form class="nform mt" (ngSubmit)="addMember()">
                <label class="fld"><span>Add someone</span><select class="inp" name="add" [(ngModel)]="addId">@for (c of candidates(); track c.id) { <option [value]="c.id">{{ c.name }}</option> }</select></label>
                <button class="btn" [disabled]="!addId">Add</button>
              </form>
            }
          </section>
          <section class="card pad block danger-zone">
            <h3>Delete group</h3>
            <p class="hint-top">@if (g.memberCount) { {{ g.memberCount }} {{ g.memberCount === 1 ? 'person loses' : 'people lose' }} these permissions: {{ memberNames() }}. } @else { Nobody is in this group. }</p>
            <button class="btn danger" [class.armed]="armedDelete()" (click)="remove()">{{ armedDelete() ? 'Click to confirm' : 'Delete ' + g.name }}</button>
          </section>
        </div></aside>
      </div>
    } @else { <div class="card pad">Loading…</div> }`,
})
export class GroupPage {
  private api = inject(ApiService); private router = inject(Router);
  id = input.required<string>();
  g = signal<StaffGroup | null>(null); staff = signal<StaffMember[]>([]);
  perms = signal<string[]>([]);
  msg = signal(''); error = signal(''); armedSave = signal(false); armedDelete = signal(false);
  name = ''; description = ''; addId = '';
  added = computed(() => this.perms().filter((p) => !this.g()?.permissions.includes(p)));
  removedPerms = computed(() => (this.g()?.permissions ?? []).filter((p) => !this.perms().includes(p)));
  affected = computed(() => (this.g()?.members ?? []).filter((m) => m.status !== 'removed'));
  affectedNames = computed(() => this.affected().map((m) => m.name).join(', '));
  memberNames = computed(() => (this.g()?.members ?? []).map((m) => m.name).join(', '));
  candidates = computed(() => this.staff().filter((s) => !s.sudo && s.status !== 'removed' && !this.g()?.members.some((m) => m.id === s.id)));
  constructor() {
    effect(() => { const id = this.id(); untracked(() => this.load(id)); });
    this.api.staff().subscribe((r) => this.staff.set(r.items));
  }
  dirty() { const g = this.g(); return !!g && (this.added().length > 0 || this.removedPerms().length > 0 || this.name !== g.name || this.description !== g.description); }
  label = (id: string) => PERMISSIONS.find((p) => p.id === id)?.label ?? id;
  status = (m: { status: StaffMember['status'] }) => statusOf({ ...m, sudo: false, inviteExpired: false }).label;
  load(id = this.id()) { this.api.group(id).subscribe({ next: (g) => this.set(g), error: () => this.router.navigate(['/team/groups']) }); }
  private set(g: StaffGroup) { this.g.set(g); this.perms.set([...g.permissions]); this.name = g.name; this.description = g.description; this.addId = this.candidates()[0]?.id ?? ''; }
  reset() { this.set(this.g()!); this.msg.set(''); }
  save() {
    const g = this.g()!;
    if (this.affected().length && !this.armedSave()) { this.armedSave.set(true); setTimeout(() => this.armedSave.set(false), 4000); return; }
    this.armedSave.set(false); this.error.set('');
    this.api.updateGroup(g.id, { name: this.name, description: this.description, permissions: this.perms(), version: g.version }).subscribe({
      next: (u) => { this.set(u); this.msg.set(u.affectedMembers ? `Saved. Access changed for ${u.affectedMembers} ${u.affectedMembers === 1 ? 'person' : 'people'}.` : 'Saved.'); },
      error: (e) => this.error.set(e.error?.error ?? 'Could not save the group.'),
    });
  }
  addMember() {
    if (!this.addId) return;
    this.api.groupMembers(this.id(), { add: [this.addId] }).subscribe({ next: (g) => { this.set(g); this.msg.set('Added.'); }, error: (e) => this.error.set(e.error?.error ?? 'Could not add.') });
  }
  removeMember(userId: string) { this.api.groupMembers(this.id(), { remove: [userId] }).subscribe((g) => { this.set(g); this.msg.set('Removed from the group.'); }); }
  remove() {
    if (!this.armedDelete()) { this.armedDelete.set(true); setTimeout(() => this.armedDelete.set(false), 3500); return; }
    this.api.deleteGroup(this.id()).subscribe(() => this.router.navigate(['/team/groups']));
  }
}

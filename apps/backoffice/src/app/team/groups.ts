import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { TEMPLATES, type GroupTemplate } from '@openshop/iam';
import { ApiService, StaffGroup } from '../api.service';
import { TeamTabs } from './members';
import { AREA_LIST, areaCell } from './ui';

@Component({
  selector: 'app-team-groups',
  imports: [FormsModule, RouterLink, TeamTabs],
  template: `
    <header class="page-h">
      <div><h1>Team</h1><p>Permission groups: give the same access to several people at once</p></div>
      <button class="btn primary" (click)="open.set(!open())">{{ open() ? 'Close' : '+ New group' }}</button>
    </header>
    <app-team-tabs on="groups" />
    @if (open()) {
      <section class="card pad block-b">
        <h3>New group</h3>
        <p class="hint-top">Start from a template or from scratch. Templates only fill in the form: you can change everything afterwards.</p>
        <div class="presets">
          <button type="button" class="preset" [class.on]="!tpl()" (click)="useTemplate(null)"><b>Empty group</b><small>Tick the permissions yourself</small></button>
          @for (t of templates; track t.id) {
            <button type="button" class="preset" [class.on]="tpl()?.id === t.id" (click)="useTemplate(t)"><b>{{ t.name }}</b><small>{{ t.person }}</small></button>
          }
        </div>
        @if (tpl(); as t) {
          <div class="note-box"><b>{{ t.name }}:</b> {{ t.description }} <br><b>Can't:</b> {{ t.cannot }}</div>
        }
        <form class="nform mt" (ngSubmit)="create()">
          <label class="fld req"><span>Name</span><input class="inp" name="name" [(ngModel)]="name" maxlength="120" required></label>
          <label class="fld"><span>Description</span><input class="inp" name="desc" [(ngModel)]="description" maxlength="500"></label>
          <button class="btn primary">Create and edit permissions</button>
        </form>
        @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
      </section>
    }
    <div class="card">
      @if (items().length) {
        <table class="tbl access-matrix">
          <thead><tr><th>Group</th><th>Members</th>@for (a of areas; track a.id) { <th>{{ a.label }}</th> }<th></th></tr></thead>
          <tbody>
            @for (g of items(); track g.id) {
              <tr>
                <td><a class="cell-main link" [routerLink]="['/team/groups', g.id]">{{ g.name }}</a><div class="cell-sub">{{ g.description }}</div></td>
                <td>{{ g.memberCount }}</td>
                @for (a of areas; track a.id) { <td [class.none]="cell(g, a.id) === '—'">{{ cell(g, a.id) }}</td> }
                <td><div class="acts"><a class="btn sm" [routerLink]="['/team/groups', g.id]">Open</a></div></td>
              </tr>
            }
          </tbody>
        </table>
      } @else { <div class="empty-state"><b>No groups yet</b>Create a group, for example from the “Fulfilment” template, then add people to it.</div> }
    </div>`,
})
export class Groups {
  private api = inject(ApiService); private router = inject(Router);
  items = signal<StaffGroup[]>([]); open = signal(false); error = signal(''); tpl = signal<GroupTemplate | null>(null);
  name = ''; description = '';
  templates = TEMPLATES; areas = AREA_LIST;
  constructor() { this.api.groups().subscribe((g) => this.items.set(g)); }
  cell(g: StaffGroup, area: string) { return areaCell(g.permissions, area); }
  useTemplate(t: GroupTemplate | null) { this.tpl.set(t); this.name = t?.name ?? ''; this.description = t?.description ?? ''; }
  create() {
    this.error.set('');
    if (!this.name.trim()) { this.error.set('Give the group a name.'); return; }
    const t = this.tpl();
    this.api.createGroup({ name: this.name, description: this.description, permissions: t ? [...t.permissions] : [], template: t?.id ?? null }).subscribe({
      next: (g) => this.router.navigate(['/team/groups', g.id]),
      error: (e) => this.error.set(e.error?.error ?? 'Could not create the group.'),
    });
  }
}

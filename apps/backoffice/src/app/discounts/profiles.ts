import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ApiService, Profile } from '../api.service';

@Component({
  selector: 'app-profiles',
  imports: [FormsModule, RouterLink],
  template: `
    <header class="page-h">
      <div><a class="back-link" routerLink="/discounts">← Discounts</a><h1>Discount profiles</h1>
        <p>A profile is a group of customers with its own offers, e.g. trade buyers. Changing a profile or its offers applies to every member straight away.</p></div>
    </header>
    @if (manage) {
    <div class="card pad block-b">
      <form class="nform" (ngSubmit)="create()">
        <label class="fld req"><span>Name (only you see it)</span><input class="inp" name="name" [(ngModel)]="name" maxlength="120" placeholder="e.g. Trade buyers"></label>
        <label class="fld req"><span>Label (members see it)</span><input class="inp" name="label" [(ngModel)]="label" maxlength="80" placeholder="e.g. Trade price"></label>
        <button class="btn primary">Create profile</button>
      </form>
      @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
    </div>
    }
    <div class="card">
      @if (items().length) {
        <table class="tbl">
          <thead><tr><th>Profile</th><th>Offers</th><th class="num">Members</th><th>Status</th><th></th></tr></thead>
          <tbody>
            @for (p of items(); track p.id) {
              <tr>
                <td><a class="cell-main link" [routerLink]="['/discounts/profiles', p.id]">{{ p.name }}</a><div class="cell-sub">Members see “{{ p.publicLabel }}”</div></td>
                <td class="cell-sub">@for (r of p.rules; track r.id) { <div>{{ r.name }}: {{ r.effect }}</div> } @empty { No offers yet }</td>
                <td class="num">{{ p.activeMembers }}@if (p.memberCount !== p.activeMembers) { <span class="cell-sub"> ({{ p.memberCount - p.activeMembers }} ended)</span> }</td>
                <td><span class="pill" [class.ok]="p.status === 'active'" [class.warn]="p.status === 'paused'">{{ p.status === 'active' ? 'Active' : 'Paused' }}</span></td>
                <td><div class="acts"><a class="btn sm" [routerLink]="['/discounts/profiles', p.id]">Open</a></div></td>
              </tr>
            }
          </tbody>
        </table>
      } @else { <div class="empty-state"><b>No profiles yet</b>Create one above, add customers, then give it offers.</div> }
    </div>`,
})
export class Profiles {
  private api = inject(ApiService);
  manage = this.api.can('discounts.manage');
  private router = inject(Router);
  items = signal<Profile[]>([]); error = signal('');
  name = ''; label = '';
  constructor() { this.api.profiles().subscribe((p) => this.items.set(p)); }
  create() {
    this.error.set('');
    if (!this.name.trim() || !this.label.trim()) { this.error.set('Enter a name and a label.'); return; }
    this.api.createProfile({ name: this.name.trim(), publicLabel: this.label.trim() }).subscribe({ next: (p) => this.router.navigate(['/discounts/profiles', p.id]), error: (e) => this.error.set(e.error?.error ?? 'Could not create.') });
  }
}

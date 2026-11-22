import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AREA_LABELS, AREAS, PERMISSIONS, checkPassword } from '@openshop/iam';
import { ApiService } from './api.service';

@Component({
  selector: 'app-account',
  imports: [FormsModule],
  template: `
    @if (api.me(); as me) {
      <header class="page-h"><div><h1>My account</h1><p>{{ me.name }} · {{ me.email }} @if (me.sudo) { <span class="pill info">Owner</span> }</p></div></header>
      @if (me.mustChangePassword) {
        <div class="banner" role="alert">Your password no longer meets the shop's password rules. Choose a new one to continue.</div>
      }
      <div class="grid2">
        <section class="card pad">
          <h3>Change password</h3>
          <form (ngSubmit)="change()">
            <label class="fld"><span>Current password</span><input class="inp" name="current" type="password" [(ngModel)]="current" autocomplete="current-password" required></label>
            <label class="fld"><span>New password</span><input class="inp" name="password" type="password" [(ngModel)]="password" autocomplete="new-password" required maxlength="200"></label>
            <label class="fld"><span>Repeat the new password</span><input class="inp" name="confirm" type="password" [(ngModel)]="confirm" autocomplete="new-password" required maxlength="200"></label>
            <ul class="rules">@for (r of me.passwordRules; track r) { <li>{{ r }}</li> }</ul>
            <button class="btn primary" [disabled]="busy()">{{ busy() ? 'Saving…' : 'Change password' }}</button>
            @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
            @if (msg()) { <p class="ok-msg" role="status">{{ msg() }}</p> }
          </form>
        </section>
        <section class="card pad">
          <h3>Sessions</h3>
          <p class="hint-top">Signed in on a shared or lost device? This signs you out everywhere, including here.</p>
          <button class="btn" (click)="everywhere()">Sign out everywhere</button>
          <h3 class="block">What is recorded</h3>
          <p class="cell-sub">To keep the shop safe, the backoffice records your sign-ins, the pages you open, the changes you make and any refused access,
            with your IP address and browser. Records are kept for {{ me.activityRetentionDays }} days and only the shop owner can see them.</p>
        </section>
      </div>
      <section class="card pad block">
        <h3>What you can do</h3>
        @if (me.sudo) { <p>You are the shop owner: every permission, plus the team, activity log and security settings.</p> }
        @else if (!me.permissions.length) { <p class="cell-sub">Nothing yet. Ask {{ me.owner.name }} to add you to a group.</p> }
        @else {
          @for (a of mine(); track a.area) {
            <div class="row-line"><b class="w-area">{{ a.label }}</b><span>@for (p of a.perms; track p) { <span class="tag">{{ p }}</span> }</span></div>
          }
        }
      </section>
    }`,
})
export class Account {
  api = inject(ApiService); private router = inject(Router);
  current = ''; password = ''; confirm = '';
  busy = signal(false); error = signal(''); msg = signal('');
  mine = computed(() => {
    const have = new Set(this.api.me()?.permissions ?? []);
    return AREAS.map((a) => ({ area: a, label: AREA_LABELS[a], perms: PERMISSIONS.filter((p) => p.area === a && have.has(p.id)).map((p) => p.label as string) })).filter((x) => x.perms.length);
  });
  constructor() { this.api.ensureMe().subscribe({ error: () => undefined }); }
  change() {
    const me = this.api.me()!;
    this.error.set(''); this.msg.set('');
    const issues = checkPassword(this.password, me.passwordPolicy, { email: me.email });
    if (issues.length) { this.error.set(issues.map((i) => i.message).join(' ')); return; }
    if (this.password !== this.confirm) { this.error.set('The two new passwords are different.'); return; }
    this.busy.set(true);
    this.api.changePassword(this.current, this.password).subscribe({
      next: () => {
        this.busy.set(false); this.current = this.password = this.confirm = '';
        const wasForced = me.mustChangePassword;
        this.msg.set('Password changed. You are signed out on your other devices.');
        this.api.me.set(null);
        this.api.ensureMe().subscribe(() => { if (wasForced) this.router.navigateByUrl(this.api.landing()); });
      },
      error: (e) => { this.busy.set(false); this.error.set(e.status === 429 ? 'Too many attempts. Please wait a few minutes.' : e.error?.error ?? 'Could not change your password.'); },
    });
  }
  everywhere() {
    this.api.signOutEverywhere().subscribe(() => { this.api.logout(false); this.router.navigate(['/login']); });
  }
}

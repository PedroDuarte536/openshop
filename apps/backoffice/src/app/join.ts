import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { ART } from '@openshop/renderer';
import { checkPassword } from '@openshop/iam';
import { ApiService, LinkInfo } from './api.service';

/**
 * The page behind invite and password-reset links: /join#<token>. The token is in the fragment, which browsers never
 * send to servers; it is removed from the address bar at once and posted in a JSON body.
 */
@Component({
  selector: 'app-join',
  imports: [FormsModule, DatePipe, RouterLink],
  template: `
    <div class="login">
      <section class="login-art" [style.background]="art">
        <a class="brand"><i></i>OpenShop</a>
        <h1>{{ info()?.purpose === 'reset' ? 'A fresh start.' : 'Welcome to the team.' }}</h1>
        <p>{{ info() ? info()!.shopName + ' runs on OpenShop.' : 'Set your password to continue.' }}</p>
      </section>
      <section class="login-form">
        @if (state() === 'loading') { <p>Checking your link…</p> }
        @if (state() === 'invalid') {
          <div class="login-card" role="alert">
            <h2>This link is no longer valid</h2>
            <p>It has expired, was already used, or was cancelled. Ask the shop owner for a new one.</p>
            <a class="btn" routerLink="/login">Go to sign in</a>
          </div>
        }
        @if (state() === 'form' && info(); as i) {
          <form class="login-card" (ngSubmit)="save()">
            <h2>{{ i.purpose === 'reset' ? 'Choose a new password' : 'Join ' + i.shopName }}</h2>
            <p>{{ i.purpose === 'reset' ? 'For' : 'You have been invited as' }} <b>{{ i.email }}</b>. This link works until {{ i.expiresAt | date: 'd MMM, HH:mm' }}.</p>
            <ul class="rules">@for (r of i.rules; track r) { <li [class.met]="password && met(r)">{{ r }}</li> }</ul>
            <label class="fld"><span>Password</span><input class="inp" name="password" type="password" [(ngModel)]="password" autocomplete="new-password" required maxlength="200"></label>
            <label class="fld"><span>Repeat the password</span><input class="inp" name="confirm" type="password" [(ngModel)]="confirm" autocomplete="new-password" required maxlength="200"></label>
            <button class="btn primary" [disabled]="busy()">{{ busy() ? 'Saving…' : i.purpose === 'reset' ? 'Save and sign in' : 'Join and sign in' }}</button>
            @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
          </form>
        }
        @if (state() === 'done') {
          <div class="login-card" role="status"><h2>Password saved</h2><p>{{ doneMsg() }}</p><a class="btn" routerLink="/login">Go to sign in</a></div>
        }
      </section>
    </div>`,
})
export class Join {
  private api = inject(ApiService); private router = inject(Router);
  art = ART.aurora.css;
  state = signal<'loading' | 'invalid' | 'form' | 'done'>('loading');
  info = signal<LinkInfo | null>(null); error = signal(''); busy = signal(false); doneMsg = signal('');
  password = ''; confirm = '';
  private token = '';
  constructor() {
    this.token = location.hash.replace(/^#/, '');
    // Take the one-time token out of the address bar (history, screenshots, shoulder-surfing).
    history.replaceState(history.state, '', location.pathname);
    if (!this.token) { this.state.set('invalid'); return; }
    this.api.inspectLink(this.token).subscribe({ next: (i) => { this.info.set(i); this.state.set('form'); }, error: () => this.state.set('invalid') });
  }
  /** Live hint for a rule (the server also checks the common-password list). */
  met(rule: string) {
    const i = this.info()!;
    const codes = checkPassword(this.password, i.passwordPolicy, { email: i.email }).map((x) => x.code);
    if (rule.startsWith('At least') && rule.includes('characters')) return !codes.includes('too_short');
    if (rule.startsWith('At least')) return !codes.includes('classes');
    if (rule.includes('email')) return !codes.includes('contains_email');
    return true;
  }
  save() {
    const i = this.info()!;
    this.error.set('');
    const local = checkPassword(this.password, i.passwordPolicy, { email: i.email });
    if (local.length) { this.error.set(local.map((x) => x.message).join(' ')); return; }
    if (this.password !== this.confirm) { this.error.set('The two passwords are different.'); return; }
    this.busy.set(true);
    this.api.consumeLink(this.token, this.password).subscribe({
      next: (r) => {
        this.busy.set(false);
        if (r.token) { this.api.setToken(r.token); this.api.me.set(null); this.router.navigate(['/']); return; }
        this.doneMsg.set("Your account is suspended at the moment, so you can't sign in yet. The shop owner can reactivate it.");
        this.state.set('done');
      },
      error: (e) => {
        this.busy.set(false);
        if (e.status === 410) this.state.set('invalid');
        else this.error.set(e.status === 429 ? 'Too many attempts. Please wait a few minutes.' : e.error?.error ?? 'Could not save your password.');
      },
    });
  }
}

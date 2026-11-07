import { Component, inject, signal } from '@angular/core';
import { HttpInterceptorFn } from '@angular/common/http';
import { CanActivateFn, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { tap } from 'rxjs';
import { ART } from '@openshop/renderer';
import { ApiService } from './api.service';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const api = inject(ApiService), router = inject(Router);
  const t = api.token();
  const r = t && req.url.startsWith('/api/') ? req.clone({ setHeaders: { Authorization: `Bearer ${t}` } }) : req;
  return next(r).pipe(tap({ error: (e) => { if (e.status === 401 && !req.url.includes('/auth/')) { api.logout(); router.navigate(['/login']); } } }));
};

export const authGuard: CanActivateFn = () => {
  const api = inject(ApiService);
  return api.token() ? true : inject(Router).parseUrl('/login');
};

@Component({
  selector: 'app-login',
  imports: [FormsModule],
  template: `
    <div class="login">
      <section class="login-art" [style.background]="art">
        <a class="brand"><i></i>OpenShop</a>
        <h1>Your shop, your way.</h1>
        <p>Design pages, manage products and take orders from one calm place.</p>
      </section>
      <section class="login-form">
        <form class="login-card" (ngSubmit)="go()">
          <h2>Welcome back</h2>
          <p>Sign in to manage your shop.</p>
          <label class="fld"><span>Email</span><input class="inp" name="email" type="email" [(ngModel)]="email" required autocomplete="username" placeholder="you@yourshop.com"></label>
          <label class="fld"><span>Password</span><input class="inp" name="password" type="password" [(ngModel)]="password" required autocomplete="current-password"></label>
          <button class="btn primary" [disabled]="busy()">{{ busy() ? 'Signing in…' : 'Sign in' }}</button>
          @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
        </form>
      </section>
    </div>`,
})
export class Login {
  private api = inject(ApiService); private router = inject(Router);
  art = ART.aurora.css;
  email = ''; password = ''; error = signal(''); busy = signal(false);
  constructor() { if (this.api.token()) this.router.navigate(['/products']); }
  go() {
    this.busy.set(true); this.error.set('');
    this.api.login(this.email, this.password).subscribe({
      next: () => this.router.navigate(['/products']),
      error: (e) => { this.busy.set(false); this.error.set(e.status === 429 ? 'Too many attempts. Wait a minute and try again.' : 'That email and password don\'t match.'); },
    });
  }
}

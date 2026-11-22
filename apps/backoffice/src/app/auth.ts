import { Component, inject, signal } from '@angular/core';
import { HttpInterceptorFn } from '@angular/common/http';
import { CanActivateFn, RedirectCommand, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { catchError, map, of, tap } from 'rxjs';
import { ART } from '@openshop/renderer';
import type { Requirement } from '@openshop/iam';
import { ApiService } from './api.service';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const api = inject(ApiService), router = inject(Router);
  const t = api.token();
  const r = t && req.url.startsWith('/api/') ? req.clone({ setHeaders: { Authorization: `Bearer ${t}` } }) : req;
  return next(r).pipe(tap({
    error: (e) => {
      // 401: the session is over (expired, signed out elsewhere, suspended or removed).
      if (e.status === 401 && !req.url.includes('/auth/')) { api.logout(false); router.navigate(['/login']); }
      // 403: permissions changed (or the screen asked for something it may not have): reload them. If the current
      // screen is no longer allowed, its guard shows the No access page. Never a sign-out.
      else if (e.status === 403 && e.error?.code === 'password_change_required') router.navigate(['/account']);
      else if (e.status === 403 && !req.url.includes('/api/me')) api.refreshMe();
    },
  }));
};

/**
 * Every backoffice screen: signed in, then the route's permission (from the feature registry). A missing permission
 * shows the No access page without changing the address bar, so a reload checks again once access is granted.
 */
export const accessGuard: CanActivateFn = (route, state) => {
  const api = inject(ApiService), router = inject(Router);
  if (!api.token()) return router.parseUrl('/login');
  const perm = route.data['perm'] as Requirement, feature = (route.data['feature'] as string) ?? null;
  return api.ensureMe().pipe(
    map((me) => {
      if (me.mustChangePassword && feature !== 'account') return router.parseUrl('/account');
      if (api.can(perm)) return true;
      api.denied.set({ feature, perm, url: state.url });
      return new RedirectCommand(router.parseUrl('/no-access'), { skipLocationChange: true });
    }),
    catchError(() => of(router.parseUrl('/login'))),
  );
};

/** "/": the first screen this user may open. */
export const homeGuard: CanActivateFn = () => {
  const api = inject(ApiService), router = inject(Router);
  if (!api.token()) return router.parseUrl('/login');
  return api.ensureMe().pipe(map((me) => router.parseUrl(me.mustChangePassword ? '/account' : api.landing())), catchError(() => of(router.parseUrl('/login'))));
};

/** Pages for any signed-in member (No access yet). */
export const signedInGuard: CanActivateFn = () => {
  const api = inject(ApiService), router = inject(Router);
  if (!api.token()) return router.parseUrl('/login');
  return api.ensureMe().pipe(map(() => true), catchError(() => of(router.parseUrl('/login'))));
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
  constructor() { if (this.api.token()) this.router.navigate(['/']); }
  go() {
    this.busy.set(true); this.error.set('');
    this.api.login(this.email, this.password).subscribe({
      next: (r) => this.router.navigate([r.mustChangePassword ? '/account' : '/']),
      error: (e) => { this.busy.set(false); this.error.set(e.status === 429 ? 'Too many attempts. Wait a minute and try again.' : 'That email and password don\'t match.'); },
    });
  }
}

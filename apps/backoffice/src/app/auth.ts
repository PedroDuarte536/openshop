import { Component, inject, signal } from '@angular/core';
import { HttpInterceptorFn } from '@angular/common/http';
import { CanActivateFn, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { tap } from 'rxjs';
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
    <h2>Sign in</h2>
    <form (ngSubmit)="go()" class="stack">
      <input name="email" type="email" [(ngModel)]="email" placeholder="Email" required autocomplete="username">
      <input name="password" type="password" [(ngModel)]="password" placeholder="Password" required autocomplete="current-password">
      <button>Sign in</button>
      @if (error()) { <p class="err">{{ error() }}</p> }
    </form>`,
})
export class Login {
  private api = inject(ApiService); private router = inject(Router);
  email = ''; password = ''; error = signal('');
  go() {
    this.api.login(this.email, this.password).subscribe({
      next: () => this.router.navigate(['/products']),
      error: (e) => this.error.set(e.status === 429 ? 'Too many attempts, wait a minute' : 'Invalid email or password'),
    });
  }
}

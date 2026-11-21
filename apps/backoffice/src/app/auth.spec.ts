import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter, RedirectCommand, Router, UrlTree, type ActivatedRouteSnapshot, type RouterStateSnapshot } from '@angular/router';
import { Observable, firstValueFrom } from 'rxjs';
import { accessGuard, authInterceptor, homeGuard, Login, signedInGuard } from './auth';
import { meFor } from './testing/fixtures';
import { ApiService } from './api.service';
import { mount, button } from './testing/harness';

describe('authentication', () => {
  beforeEach(() => localStorage.clear());

  function setup(token: string | null) {
    if (token) localStorage.setItem('openshop.token', token);
    TestBed.configureTestingModule({ providers: [provideHttpClient(withInterceptors([authInterceptor])), provideHttpClientTesting(), provideRouter([{ path: '**', children: [] }])] });
    return { http: TestBed.inject(HttpClient), ctl: TestBed.inject(HttpTestingController), router: TestBed.inject(Router), api: TestBed.inject(ApiService) };
  }

  it('adds the bearer token to API calls only', async () => {
    const { http, ctl } = setup('tok');
    firstValueFrom(http.get('/api/products')).catch(() => undefined);
    expect(ctl.expectOne('/api/products').request.headers.get('Authorization')).toBe('Bearer tok');
    firstValueFrom(http.get('/other')).catch(() => undefined);
    expect(ctl.expectOne('/other').request.headers.has('Authorization')).toBe(false);
  });

  it('signs out and goes to the login page when the API says 401 (but not for the login call itself)', async () => {
    const { http, ctl, router, api } = setup('tok');
    const nav = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const p = firstValueFrom(http.get('/api/products')).catch((e) => e);
    ctl.expectOne('/api/products').flush({}, { status: 401, statusText: 'x' });
    await p;
    expect(api.token()).toBeNull();
    expect(nav).toHaveBeenCalledWith(['/login']);
    nav.mockClear();
    const q = firstValueFrom(http.post('/api/auth/login', {})).catch((e) => e);
    ctl.expectOne('/api/auth/login').flush({}, { status: 401, statusText: 'x' });
    await q;
    expect(nav).not.toHaveBeenCalled();
  });

  const route = (perm: unknown, feature = 'orders') => ({ data: { perm, feature } }) as unknown as ActivatedRouteSnapshot;
  const state = (url: string) => ({ url }) as RouterStateSnapshot;
  const run = async (g: typeof accessGuard, r = route('orders.view'), s = state('/orders')) => {
    const out = TestBed.runInInjectionContext(() => g(r, s));
    return out instanceof Observable ? firstValueFrom(out) : out;
  };

  it('guards screens: no session → sign-in page', async () => {
    setup(null);
    expect(((await run(accessGuard)) as UrlTree).toString()).toBe('/login');
    expect(((await run(homeGuard)) as UrlTree).toString()).toBe('/login');
    expect(((await run(signedInGuard)) as UrlTree).toString()).toBe('/login');
  });

  it('guards screens by permission: allowed passes; otherwise the No access page, keeping the address', async () => {
    const { ctl, api } = setup('tok');
    const p = run(accessGuard, route('orders.view'), state('/orders'));
    ctl.expectOne('/api/me').flush(meFor(['orders.view']));
    expect(await p).toBe(true);
    const denied = (await run(accessGuard, route({ all: ['discounts.view', 'customers.view'] }, 'discounts'), state('/discounts/simulate'))) as RedirectCommand;
    expect(denied).toBeInstanceOf(RedirectCommand);
    expect(denied.redirectTo.toString()).toBe('/no-access');
    expect(denied.navigationBehaviorOptions?.skipLocationChange).toBe(true);
    expect(api.denied()).toEqual({ feature: 'discounts', perm: { all: ['discounts.view', 'customers.view'] }, url: '/discounts/simulate' });
  });

  it('sends a member who must change their password to My account first; a failed /api/me goes to sign-in', async () => {
    const { ctl, api } = setup('tok');
    const p = run(accessGuard);
    ctl.expectOne('/api/me').flush(meFor(['orders.view'], { mustChangePassword: true }));
    expect(((await p) as UrlTree).toString()).toBe('/account');
    expect(await run(accessGuard, route('authenticated', 'account'), state('/account'))).toBe(true);
    expect(((await run(homeGuard)) as UrlTree).toString()).toBe('/account');
    api.me.set(null);
    const q = run(signedInGuard);
    ctl.expectOne('/api/me').flush({}, { status: 500, statusText: 'x' });
    expect(((await q) as UrlTree).toString()).toBe('/login');
  });

  it('lands on the first screen the member may use (menu order), or "No access yet"', async () => {
    const { api } = setup('tok');
    const landing = async (perms: string[] | 'sudo') => { api.me.set(meFor(perms)); return ((await run(homeGuard)) as UrlTree).toString(); };
    expect(await landing('sudo')).toBe('/products');
    expect(await landing(['customers.view', 'orders.cancel'])).toBe('/orders');
    expect(await landing(['pages.manage'])).toBe('/products');
    expect(await landing(['insights.view'])).toBe('/insights');
    expect(await landing(['settings.manage'])).toBe('/settings');
    expect(await landing([])).toBe('/welcome');
    expect(await run(signedInGuard)).toBe(true);
  });

  it('a 403 reloads the permissions (and never signs out); a required password change opens My account', async () => {
    const { http, ctl, router, api } = setup('tok');
    api.me.set(meFor(['orders.view']));
    const nav = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const p = firstValueFrom(http.get('/api/orders')).catch((e) => e);
    ctl.expectOne('/api/orders').flush({ code: 'forbidden' }, { status: 403, statusText: 'x' });
    await p;
    ctl.expectOne('/api/me').flush(meFor([]));
    expect(api.token()).toBe('tok');
    expect(api.me()!.permissions).toEqual([]);
    const q = firstValueFrom(http.get('/api/orders')).catch((e) => e);
    ctl.expectOne('/api/orders').flush({ code: 'password_change_required' }, { status: 403, statusText: 'x' });
    await q;
    expect(nav).toHaveBeenCalledWith(['/account']);
  });
});

describe('permissions withdrawn while a screen is open', () => {
  beforeEach(() => localStorage.clear());
  it('the next refusal reloads permissions and the same address shows No access; a broken /api/me means sign in', async () => {
    @Component({ template: 'orders screen' }) class OrdersScreen {}
    @Component({ template: 'no access' }) class Denied {}
    localStorage.setItem('openshop.token', 'tok');
    TestBed.configureTestingModule({ providers: [provideHttpClient(withInterceptors([authInterceptor])), provideHttpClientTesting(), provideRouter([
      { path: 'orders', component: OrdersScreen, canActivate: [accessGuard], runGuardsAndResolvers: 'always', data: { perm: 'orders.view', feature: 'orders' } },
      { path: 'no-access', component: Denied }, { path: 'login', component: Denied },
    ])] });
    const ctl = TestBed.inject(HttpTestingController), router = TestBed.inject(Router), api = TestBed.inject(ApiService), http = TestBed.inject(HttpClient);
    api.me.set(meFor(['orders.view']));
    await router.navigateByUrl('/orders');
    expect(router.url).toBe('/orders');
    const p = firstValueFrom(http.post('/api/orders/x', {})).catch((e) => e);
    ctl.expectOne('/api/orders/x').flush({ code: 'forbidden' }, { status: 403, statusText: 'x' });
    await p;
    ctl.expectOne('/api/me').flush(meFor([]));
    await new Promise((r) => setTimeout(r, 0));
    expect(api.denied()?.url).toBe('/orders');
    expect(location.pathname).not.toBe('/no-access');
    api.me.set(null);
    const nav = router.navigateByUrl('/orders');
    await new Promise((r) => setTimeout(r, 0));
    ctl.expectOne('/api/me').flush({}, { status: 500, statusText: 'x' });
    await nav;
    expect(router.url).toBe('/login');
  });
});

describe('Login page', () => {
  beforeEach(() => localStorage.clear());
  it('signs in and opens the products page', async () => {
    const m = await mount(Login, { token: null });
    const nav = vi.spyOn(m.router, 'navigate').mockResolvedValue(true);
    await m.type('input[name=email]', 'a@x.io');
    await m.type('input[name=password]', 'pw');
    await m.click(button(m.el, 'Sign in'));
    expect(m.text('button')).toContain('Signing in');
    const req = await m.reply('POST', '/api/auth/login', { token: 'abc' });
    expect(req.request.body).toEqual({ email: 'a@x.io', password: 'pw' });
    expect(nav).toHaveBeenCalledWith(['/']);
  });
  it('opens My account first when the password must be changed', async () => {
    const m = await mount(Login, { token: null });
    const nav = vi.spyOn(m.router, 'navigate').mockResolvedValue(true);
    await m.click(button(m.el, 'Sign in'));
    await m.reply('POST', '/api/auth/login', { token: 'abc', mustChangePassword: true });
    expect(nav).toHaveBeenCalledWith(['/account']);
  });
  it('explains wrong credentials and throttling', async () => {
    const m = await mount(Login, { token: null });
    await m.click(button(m.el, 'Sign in'));
    await m.reply('POST', '/api/auth/login', {}, 401);
    expect(m.text('[role=alert]')).toContain("don't match");
    await m.click(button(m.el, 'Sign in'));
    await m.reply('POST', '/api/auth/login', {}, 429);
    expect(m.text('[role=alert]')).toContain('Too many attempts');
  });
  it('skips the form when already signed in', async () => {
    localStorage.setItem('openshop.token', 'x');
    TestBed.configureTestingModule({ imports: [Login], providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([{ path: '**', children: [] }])] });
    const nav = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    TestBed.createComponent(Login);
    expect(nav).toHaveBeenCalledWith(['/']);
  });
});

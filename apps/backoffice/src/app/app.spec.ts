import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter, Router } from '@angular/router';
import { FEATURES, TEMPLATES, effective } from '@openshop/iam';
import matrix from '../../../api/test/access-matrix.json';
import { App } from './app';
import { appConfig } from './app.config';
import { SCREENS, routes } from './app.routes';
import { accessGuard } from './auth';
import { ApiService } from './api.service';
import { meFor } from './testing/fixtures';

function shell(me: ReturnType<typeof meFor> | null) {
  localStorage.setItem('openshop.token', 'x');
  TestBed.configureTestingModule({ imports: [App], providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([{ path: '**', children: [] }])] });
  const api = TestBed.inject(ApiService);
  api.me.set(me);
  const f = TestBed.createComponent(App);
  f.detectChanges();
  return { f, el: f.nativeElement as HTMLElement, api, http: TestBed.inject(HttpTestingController) };
}
const menu = (el: HTMLElement) => [...el.querySelectorAll('nav a'), ...el.querySelectorAll('.side-foot a[href^="/"]:not([target])')].map((a) => a.textContent!.trim());

describe('app shell', () => {
  beforeEach(() => localStorage.clear());

  it('shows the owner every menu entry and signs out (telling the server, for the activity log)', async () => {
    const { f, el, http } = shell(meFor('sudo'));
    expect(menu(el)).toEqual(['Products', 'Categories', 'Orders', 'Discounts', 'Customers', 'Insights', 'Pages', 'Activity', 'Settings', 'Team', 'My account']);
    expect(el.querySelector('.who-am-i')!.textContent).toContain('Olivia · Owner');
    const nav = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    (el.querySelector('.side-foot button') as HTMLElement).click();
    f.detectChanges();
    http.expectOne('/api/auth/logout').flush(null);
    expect(nav).toHaveBeenCalledWith(['/login']);
    expect(localStorage.getItem('openshop.token')).toBeNull();
    expect(el.querySelector('.side')).toBeNull();
  });

  it('shows each persona of the access matrix exactly the menu of the reviewed plan (v2 §2.12)', () => {
    for (const p of matrix.personas.filter((x) => !('state' in x) && !('sudo' in x && x.sudo))) {
      TestBed.resetTestingModule();
      const perms = [...effective({ sudo: false }, p.groups.map((g) => TEMPLATES.find((t) => t.id === g)!))];
      const { el } = shell(meFor(perms));
      expect(menu(el), p.id).toEqual((matrix.menus as Record<string, string[]>)[p.id]);
    }
  });

  it('waits for the permissions before showing the shell, and loads them at start', () => {
    const { el, http } = shell(null);
    expect(el.querySelector('.side')).toBeNull();
    expect(el.querySelector('main.main')).toBeNull();
    http.expectOne('/api/me');
  });

  it('keeps one router outlet while the permissions load, so a screen is never created twice', () => {
    const { f, el, api, http } = shell(null);
    const outlet = el.querySelector('router-outlet');
    http.expectOne('/api/me');
    api.me.set(meFor('sudo'));
    f.detectChanges();
    expect(el.querySelector('.side')).not.toBeNull();
    expect(el.querySelectorAll('router-outlet').length).toBe(1);
    expect(el.querySelector('router-outlet')).toBe(outlet);
  });

  it('re-checks permissions when the window gets focus', () => {
    const { http } = shell(meFor('sudo'));
    window.dispatchEvent(new Event('focus'));
    http.expectOne('/api/me').flush(meFor(['orders.view']));
  });

  it('every screen comes from the feature registry and is guarded; only login, join and the access pages are open', () => {
    const registry = FEATURES.flatMap((f) => f.routes.map((r) => r.path));
    const guarded = routes.filter((r) => r.canActivate?.includes(accessGuard));
    expect(guarded.map((r) => r.path)).toEqual(registry);
    expect(Object.keys(SCREENS).sort()).toEqual([...registry].sort());
    for (const r of guarded) { expect(r.component).toBeTruthy(); expect(r.data!['perm']).toBeTruthy(); expect(r.runGuardsAndResolvers).toBe('always'); }
    expect(routes.filter((r) => !r.canActivate).map((r) => r.path)).toEqual(['login', 'join', 'no-access', '**']);
    expect(routes.find((r) => r.path === 'discounts/new')!.data!['perm']).toBe('discounts.manage');
    expect(routes.findIndex((r) => r.path === 'discounts/new')).toBeLessThan(routes.findIndex((r) => r.path === 'discounts/:id'));
    expect(routes.findIndex((r) => r.path === 'team/groups')).toBeLessThan(routes.findIndex((r) => r.path === 'team/:id'));
    expect(appConfig.providers.length).toBe(3);
  });
});

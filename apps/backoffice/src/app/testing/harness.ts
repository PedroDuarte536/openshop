// Test helpers for backoffice components: mount with a fake HTTP backend and a router, answer requests, interact.
import { Type } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, TestRequest } from '@angular/common/http/testing';
import { provideRouter, Router, Routes } from '@angular/router';
import { authInterceptor } from '../auth';
import { ApiService, type Me } from '../api.service';
import { meFor } from './fixtures';

export interface Mounted<T> {
  fixture: ComponentFixture<T>; cmp: T; el: HTMLElement; http: HttpTestingController; router: Router;
  /** Answers the one pending request matching method + URL (exact, with query string, or a RegExp). */
  reply(method: string, url: string | RegExp, body: unknown, status?: number): Promise<TestRequest>;
  /** Answers every pending request matching the URL (e.g. lists requested by several effects). */
  replyAll(method: string, url: string | RegExp, body: unknown): Promise<number>;
  settle(): Promise<void>;
  text(selector?: string): string;
  all(selector: string): HTMLElement[];
  click(selector: string | HTMLElement): Promise<void>;
  type(selector: string, value: string): Promise<void>;
  check(selector: string, checked: boolean): Promise<void>;
  select(selector: string, value: string): Promise<void>;
}

const matcher = (method: string, url: string | RegExp) => (r: { method: string; urlWithParams: string }) =>
  r.method === method && (typeof url === 'string' ? r.urlWithParams === url : url.test(r.urlWithParams));

/**
 * Mounts a component with a fake HTTP backend. The signed-in member is the owner (all permissions) unless `me` is
 * given, e.g. `me: meFor(['orders.view'])` or `me: null` (permissions not loaded yet).
 */
export async function mount<T>(cmp: Type<T>, opts: { inputs?: Record<string, unknown>; routes?: Routes; providers?: unknown[]; token?: string | null; me?: Me | null } = {}): Promise<Mounted<T>> {
  if (opts.token !== null) localStorage.setItem('openshop.token', opts.token ?? 't0k3n');
  TestBed.configureTestingModule({
    imports: [cmp],
    providers: [provideHttpClient(withInterceptors([authInterceptor])), provideHttpClientTesting(), provideRouter(opts.routes ?? [{ path: '**', children: [] }]), ...((opts.providers ?? []) as never[])],
  });
  const http = TestBed.inject(HttpTestingController);
  TestBed.inject(ApiService).me.set(opts.me === undefined ? meFor('sudo') : opts.me);
  const router = TestBed.inject(Router);
  const fixture = TestBed.createComponent(cmp);
  for (const [k, v] of Object.entries(opts.inputs ?? {})) fixture.componentRef.setInput(k, v);
  const el = fixture.nativeElement as HTMLElement;
  const settle = async () => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };
  const find = (s: string | HTMLElement) => { const e = typeof s === 'string' ? el.querySelector<HTMLElement>(s) : s; if (!e) throw new Error(`not found: ${s}`); return e; };
  const m: Mounted<T> = {
    fixture, cmp: fixture.componentInstance, el, http, router, settle,
    async reply(method, url, body, status = 200) {
      const req = http.expectOne(matcher(method, url), `${method} ${url}`);
      if (status >= 400) req.flush(body as never, { status, statusText: 'Error' }); else req.flush(body as never);
      await settle();
      return req;
    },
    async replyAll(method, url, body) {
      const reqs = http.match(matcher(method, url));
      reqs.forEach((r) => r.flush(body as never));
      await settle();
      return reqs.length;
    },
    text: (s) => (s ? find(s).textContent ?? '' : el.textContent ?? '').replace(/\s+/g, ' ').trim(),
    all: (s) => [...el.querySelectorAll<HTMLElement>(s)],
    async click(s) { find(s).click(); await settle(); },
    async type(s, value) { const i = find(s) as HTMLInputElement; i.value = value; i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('change')); await settle(); },
    async check(s, checked) { const i = find(s) as HTMLInputElement; if (i.checked !== checked) i.click(); await settle(); },
    async select(s, value) { const i = find(s) as HTMLSelectElement; i.value = value; i.dispatchEvent(new Event('change')); await settle(); },
  };
  await settle();
  return m;
}

/** The button whose text contains `label`. */
export function button(el: HTMLElement, label: string, selector = 'button, a'): HTMLElement {
  const b = [...el.querySelectorAll<HTMLElement>(selector)].find((x) => (x.textContent ?? '').includes(label));
  if (!b) throw new Error(`no button "${label}"`);
  return b;
}

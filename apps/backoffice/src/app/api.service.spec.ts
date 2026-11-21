import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { firstValueFrom, Observable } from 'rxjs';
import { ApiService } from './api.service';

describe('ApiService', () => {
  let api: ApiService; let http: HttpTestingController;
  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    api = TestBed.inject(ApiService); http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  const call = async (o: Observable<unknown>, method: string, url: string, body?: unknown) => {
    const p = firstValueFrom(o);
    const req = http.expectOne((r) => r.method === method && r.urlWithParams === url, `${method} ${url}`);
    if (body !== undefined) expect(req.request.body).toEqual(body);
    req.flush({ ok: 1 });
    return p;
  };

  it('signs in, keeps the token, and signs out', async () => {
    const p = firstValueFrom(api.login('a@x.io', 'pw'));
    http.expectOne('/api/auth/login').flush({ token: 'abc' });
    await p;
    expect(api.token()).toBe('abc');
    expect(localStorage.getItem('openshop.token')).toBe('abc');
    api.logout();
    http.expectOne('/api/auth/logout').flush(null);
    expect(api.token()).toBeNull();
    api.logout();
    http.expectNone('/api/auth/logout');
    expect(localStorage.getItem('openshop.token')).toBeNull();
  });

  it('calls every endpoint with the right method, URL and body', async () => {
    const d = { name: 'X' } as never;
    const cases: [Observable<unknown>, string, string, unknown?][] = [
      [api.searchProducts({ q: 'mug' }), 'GET', '/api/products?q=mug'], [api.lookupProducts(['a', 'b']), 'GET', '/api/products?view=summary&facets=false&ids=a,b&limit=200'],
      [api.product('p'), 'GET', '/api/products/p'], [api.createProduct(d), 'POST', '/api/products', d], [api.updateProduct('p', d), 'PATCH', '/api/products/p', d],
      [api.deleteProduct('p', { b1: 'hide' }), 'DELETE', '/api/products/p', { bundles: { b1: 'hide' } }], [api.deleteImpact('p'), 'GET', '/api/products/p/delete-impact'],
      [api.restoreProduct('p'), 'POST', '/api/products/p/restore'], [api.bulkProducts({ ids: ['p'], action: 'hide' }), 'POST', '/api/products/bulk', { ids: ['p'], action: 'hide' }],
      [api.attributes(), 'GET', '/api/attributes'], [api.createAttribute({ label: 'Colour', type: 'text' }), 'POST', '/api/attributes', { label: 'Colour', type: 'text' }],
      [api.updateAttribute('a', { version: 1 }), 'PATCH', '/api/attributes/a', { version: 1 }], [api.deleteAttribute('a', true), 'DELETE', '/api/attributes/a?purge=true'],
      [api.categories(), 'GET', '/api/categories'], [api.createCategory({ name: 'a', slug: 'a' }), 'POST', '/api/categories'], [api.deleteCategory('c'), 'DELETE', '/api/categories/c'],
      [api.orders(), 'GET', '/api/orders'], [api.setOrderStatus('o', 'paid'), 'PATCH', '/api/orders/o', { status: 'paid' }],
      [api.pages(), 'GET', '/api/pages'], [api.page('g'), 'GET', '/api/pages/g'], [api.createPage(d), 'POST', '/api/pages'], [api.patchPage('g', { slug: 's' }), 'PATCH', '/api/pages/g'],
      [api.deletePage('g'), 'DELETE', '/api/pages/g'], [api.savePage('g', d), 'PUT', '/api/pages/g'],
      [api.customers(), 'GET', '/api/customers'], [api.customer('c'), 'GET', '/api/customers/c'], [api.createCustomer({ email: 'e', name: 'n' }), 'POST', '/api/customers'],
      [api.updateCustomer('c', { name: 'n' }), 'PATCH', '/api/customers/c'], [api.deleteCustomer('c'), 'DELETE', '/api/customers/c'],
      [api.customerLink('c', 'reset'), 'POST', '/api/customers/c/links', { purpose: 'reset' }], [api.signOutCustomer('c'), 'POST', '/api/customers/c/sign-out'],
      [api.personalCode('d', 'c', 'VIP'), 'POST', '/api/discounts/d/codes', { generate: 1, prefix: 'VIP', assignedCustomerId: 'c' }],
      [api.personalCode('d', 'c', ''), 'POST', '/api/discounts/d/codes', { generate: 1, assignedCustomerId: 'c' }],
      [api.profiles(), 'GET', '/api/discount-profiles'], [api.profile('p'), 'GET', '/api/discount-profiles/p'], [api.createProfile({ name: 'a', publicLabel: 'b' }), 'POST', '/api/discount-profiles'],
      [api.updateProfile('p', { version: 1 }), 'PATCH', '/api/discount-profiles/p'], [api.deleteProfile('p'), 'DELETE', '/api/discount-profiles/p'],
      [api.profileMembers('p'), 'GET', '/api/discount-profiles/p/members'], [api.changeMembers('p', { remove: ['c'] }), 'POST', '/api/discount-profiles/p/members'],
      [api.summary('2026-01-01', '2026-01-31'), 'GET', '/api/reports/summary?from=2026-01-01&to=2026-01-31'],
      [api.reportDays('a', 'b'), 'GET', '/api/reports/discounts?from=a&to=b&groupBy=day'], [api.reportOffers('a', 'b'), 'GET', '/api/reports/discounts?from=a&to=b&groupBy=discount'],
      [api.reportCampaigns('a', 'b'), 'GET', '/api/reports/discounts?from=a&to=b&groupBy=campaign'], [api.reportChoices('a', 'b'), 'GET', '/api/reports/choices?from=a&to=b&groupBy=code'],
      [api.reportChoiceDays('a', 'b'), 'GET', '/api/reports/choices?from=a&to=b&groupBy=day'], [api.reportSaved('a', 'b'), 'GET', '/api/reports/saved-for-later?from=a&to=b'],
      [api.discounts(), 'GET', '/api/discounts'], [api.discount('d'), 'GET', '/api/discounts/d'], [api.createDiscount(d), 'POST', '/api/discounts'],
      [api.updateDiscount('d', { version: 2 }), 'PATCH', '/api/discounts/d', { version: 2 }], [api.discountAction('d', 'pause'), 'POST', '/api/discounts/d/pause'],
      [api.deleteDiscount('d'), 'DELETE', '/api/discounts/d'], [api.codes('d', 50, 50), 'GET', '/api/discounts/d/codes?skip=50&limit=50'],
      [api.addCode('d', 'X'), 'POST', '/api/discounts/d/codes', { code: 'X' }], [api.generateCodes('d', 5, 'P'), 'POST', '/api/discounts/d/codes', { generate: 5, prefix: 'P' }],
      [api.generateCodes('d', 5, ''), 'POST', '/api/discounts/d/codes', { generate: 5 }], [api.deleteCode('d', 'A B'), 'DELETE', '/api/discounts/d/codes/A%20B'],
      [api.redemptions('d'), 'GET', '/api/discounts/d/redemptions'], [api.simulate({ items: [] }), 'POST', '/api/discounts/simulate'],
      [api.audit('discount', 'd'), 'GET', '/api/audit?entity=discount&id=d'], [api.audit('discount', 'd', 'cur'), 'GET', '/api/audit?entity=discount&id=d&before=cur'], [api.settings(), 'GET', '/api/settings'],
      [api.timezoneImpact('Europe/Lisbon'), 'GET', '/api/settings/timezone-impact?tz=Europe/Lisbon'], [api.updateSettings({ timezone: 'UTC' }), 'PATCH', '/api/settings', { timezone: 'UTC' }],
      // staff accounts
      [api.myself(), 'GET', '/api/me'], [api.signOutEverywhere(), 'POST', '/api/me/sign-out-everywhere'],
      [api.beacon({ kind: 'page_view', path: '/orders' }), 'POST', '/api/activity/beacon', { kind: 'page_view', path: '/orders' }],
      [api.inspectLink('t'), 'POST', '/api/auth/links/inspect', { token: 't' }], [api.consumeLink('t', 'pw'), 'POST', '/api/auth/links/consume', { token: 't', password: 'pw' }],
      [api.permissionCatalog(), 'GET', '/api/permissions'], [api.staff(), 'GET', '/api/staff?status=active'], [api.staff('removed'), 'GET', '/api/staff?status=removed'],
      [api.staffMember('u'), 'GET', '/api/staff/u'], [api.invite({ email: 'e', name: 'n', groupIds: [] }), 'POST', '/api/staff', { email: 'e', name: 'n', groupIds: [] }],
      [api.restoreStaff('u'), 'POST', '/api/staff/u/restore'], [api.renameStaff('u', 'N', 2), 'PATCH', '/api/staff/u', { name: 'N', version: 2 }],
      [api.setStaffGroups('u', ['g']), 'PUT', '/api/staff/u/groups', { groupIds: ['g'] }], [api.staffLink('u', 'reset'), 'POST', '/api/staff/u/links', { purpose: 'reset' }],
      [api.revokeStaffLinks('u'), 'POST', '/api/staff/u/links/revoke'], [api.staffAction('u', 'suspend'), 'POST', '/api/staff/u/suspend'], [api.removeStaff('u'), 'DELETE', '/api/staff/u'],
      [api.groups(), 'GET', '/api/staff-groups'], [api.group('g'), 'GET', '/api/staff-groups/g'], [api.createGroup({ name: 'G', description: '', permissions: [] }), 'POST', '/api/staff-groups'],
      [api.updateGroup('g', { version: 1 }), 'PATCH', '/api/staff-groups/g', { version: 1 }], [api.deleteGroup('g'), 'DELETE', '/api/staff-groups/g'],
      [api.groupMembers('g', { add: ['u'] }), 'POST', '/api/staff-groups/g/members', { add: ['u'] }],
      [api.activity({ kinds: 'sign_in', userId: '', limit: 5 }), 'GET', '/api/activity?kinds=sign_in&limit=5'], [api.activityChange('a'), 'GET', '/api/activity/changes/a'],
      [api.securitySettings(), 'GET', '/api/security-settings'], [api.updateSecuritySettings({ version: 3 }), 'PATCH', '/api/security-settings', { version: 3 }],
    ];
    for (const [o, m, u, b] of cases) await call(o, m, u, b);
  });

  it('uploads an image with its own content type', async () => {
    const f = new File([new Uint8Array([1, 2])], 'a.png', { type: 'image/png' });
    const p = firstValueFrom(api.upload(f));
    const req = http.expectOne('/api/uploads');
    expect(req.request.headers.get('Content-Type')).toBe('image/png');
    req.flush({ url: '/uploads/x.png' });
    expect(await p).toEqual({ url: '/uploads/x.png' });
  });

  it('downloads CSV from the same URL as the list, asking with the Accept header', async () => {
    const created: string[] = [];
    const clicks: string[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => { created.push('blob:1'); return 'blob:1'; });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicks.push(this.download); });
    const p = firstValueFrom(api.downloadCsv('/api/discounts/d/codes', 'codes.csv', { from: 'a' }));
    const req = http.expectOne('/api/discounts/d/codes?from=a');
    expect(req.request.headers.get('Accept')).toBe('text/csv');
    expect(req.request.responseType).toBe('blob');
    req.flush(new Blob(['code\r\nA']));
    await p;
    expect(created).toEqual(['blob:1']);
    expect(clicks).toEqual(['codes.csv']);
  });

  it('keeps the new session after a password change', async () => {
    const p = firstValueFrom(api.changePassword('old', 'new'));
    const req = http.expectOne('/api/me/password');
    expect(req.request.body).toEqual({ current: 'old', password: 'new' });
    req.flush({ token: 'fresh' });
    await p;
    expect(api.token()).toBe('fresh');
  });

  it('survives storage that throws (private mode)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(() => api.logout(false)).not.toThrow();
  });
});

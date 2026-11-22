import { TestBed } from '@angular/core/testing';
import { Component } from '@angular/core';
import { Router } from '@angular/router';
import { NoAccess, NotFound, Welcome, requirementLabel } from './access-pages';
import { Join } from './join';
import { Account } from './account';
import { ActivityTracker } from './activity-tracker';
import { Activity } from './activity/activity';
import { ActivityList, KIND_LABEL, describe as describeEvent } from './activity/list';
import { SecuritySettings } from './security-settings';
import { ApiService, type ActivityItem } from './api.service';
import { mount, button } from './testing/harness';
import { meFor } from './testing/fixtures';

describe('No access, Not found and Welcome pages', () => {
  it('without details (e.g. a reload) it still explains and offers a way out', async () => {
    const m = await mount(NoAccess, { me: meFor(['orders.view']) });
    expect(m.text('h1')).toBe("You don't have access to this page");
    expect(m.text('a.btn')).toBe('Go to Orders');
    m.http.expectNone('/api/activity/beacon');
  });
  it('says which feature, what it needs and whom to ask; reports the refusal; offers the landing page', async () => {
    const m = await mount(NoAccess, { me: meFor(['orders.view']), token: 't' });
    TestBed.inject(ApiService).denied.set({ feature: 'discounts', perm: { all: ['discounts.view', 'customers.view'] }, url: '/discounts/simulate?x=1' });
    const o = TestBed.createComponent(NoAccess);
    o.detectChanges();
    const el = o.nativeElement as HTMLElement;
    expect(el.querySelector('h1')!.textContent).toContain('Discounts');
    expect(el.textContent).toContain('“See offers and profiles; use the simulator” and “See customers and their details”');
    expect(el.textContent).toContain('Ask Olivia');
    expect(el.querySelector('a.btn')!.textContent).toContain('Go to Orders');
    const beacon = m.http.expectOne('/api/activity/beacon');
    expect(beacon.request.body).toEqual({ kind: 'page_denied', path: '/discounts/simulate?x=1', feature: 'discounts', permission: 'discounts.view + customers.view' });
    const nav = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    (el.querySelector('button') as HTMLElement).click();
    expect(nav).toHaveBeenCalledWith(['/login']);
    m.http.expectOne('/api/auth/logout');
  });
  it('labels requirements in plain language', () => {
    expect(requirementLabel('sudo')).toBe('the shop owner only');
    expect(requirementLabel('authenticated')).toBe('a signed-in account');
    expect(requirementLabel({ any: ['catalog.manage', 'pages.manage'] })).toContain(' or ');
  });
  it('shows Page not found with a way back', async () => {
    const m = await mount(NotFound);
    expect(m.text('h1')).toBe('Page not found');
    expect(m.text('a')).toBe('Go to the backoffice');
    TestBed.resetTestingModule();
    const n = await mount(NotFound, { token: null, me: null });
    localStorage.removeItem('openshop.token');
    TestBed.inject(ApiService).token.set(null);
    n.fixture.detectChanges();
    expect(n.text('a')).toBe('Sign in');
  });
  it('Welcome: explains there is no access yet, and moves on by itself once access is granted', async () => {
    vi.useFakeTimers();
    try {
      const m = await mount(Welcome, { me: meFor([]) });
      const nav = vi.spyOn(m.router, 'navigateByUrl').mockResolvedValue(true);
      expect(m.text()).toContain("hasn't given you access");
      vi.advanceTimersByTime(15_000);
      m.http.expectOne('/api/me').flush(meFor(['orders.view']));
      await m.settle();
      expect(nav).toHaveBeenCalledWith('/orders');
    } finally { vi.useRealTimers(); }
  });
});

describe('Join page (invite and reset links)', () => {
  const info = { purpose: 'invite', email: 'lena@shop.test', name: 'Lena', shopName: 'Maison Dune', expiresAt: '2026-06-18T10:00:00Z', passwordPolicy: { minLength: 12, requireClasses: 0, disallowEmail: true, blockCommon: true }, rules: ['At least 12 characters', 'Must not contain your email address', 'Must not be a commonly used password'] };
  const open = async (hash: string) => {
    history.replaceState(null, '', `/join${hash}`);
    return mount(Join, { token: null, me: null });
  };
  it('takes the token out of the address bar, shows the invitation, checks the rules live and joins', async () => {
    const m = await open('#tok-abcdefghijklmnopqrstuvwxyz');
    expect(location.hash).toBe('');
    const inspect = await m.reply('POST', '/api/auth/links/inspect', info);
    expect(inspect.request.body).toEqual({ token: 'tok-abcdefghijklmnopqrstuvwxyz' });
    expect(m.text('h2')).toBe('Join Maison Dune');
    expect(m.text()).toContain('lena@shop.test');
    await m.type('input[name=password]', 'short');
    expect(m.all('.rules li.met').length).toBe(2);
    await m.click(button(m.el, 'Join and sign in'));
    expect(m.text('[role=alert]')).toContain('at least 12');
    await m.type('input[name=password]', 'my-lena-password');
    await m.click(button(m.el, 'Join and sign in'));
    expect(m.text('[role=alert]')).toContain('email');
    await m.type('input[name=password]', 'ceramics at dawn');
    await m.type('input[name=confirm]', 'different');
    await m.click(button(m.el, 'Join and sign in'));
    expect(m.text('[role=alert]')).toBe('The two passwords are different.');
    await m.type('input[name=confirm]', 'ceramics at dawn');
    await m.click(button(m.el, 'Join and sign in'));
    await m.reply('POST', '/api/auth/links/consume', { error: 'This password is too common.' }, 400);
    expect(m.text('[role=alert]')).toBe('This password is too common.');
    await m.click(button(m.el, 'Join and sign in'));
    await m.reply('POST', '/api/auth/links/consume', {}, 429);
    expect(m.text('[role=alert]')).toContain('Too many attempts');
    const nav = vi.spyOn(m.router, 'navigate').mockResolvedValue(true);
    await m.click(button(m.el, 'Join and sign in'));
    const c = await m.reply('POST', '/api/auth/links/consume', { token: 'session', status: 'active' });
    expect(c.request.body).toEqual({ token: 'tok-abcdefghijklmnopqrstuvwxyz', password: 'ceramics at dawn' });
    expect(TestBed.inject(ApiService).token()).toBe('session');
    expect(nav).toHaveBeenCalledWith(['/']);
  });
  it('shows a reset, a suspended account, and invalid links', async () => {
    const m = await open('#reset-token-abcdefghijklmnop');
    await m.reply('POST', '/api/auth/links/inspect', { ...info, purpose: 'reset', rules: ['At least 12 characters'] });
    expect(m.text('h2')).toBe('Choose a new password');
    await m.type('input[name=password]', 'ceramics at dawn');
    await m.type('input[name=confirm]', 'ceramics at dawn');
    await m.click(button(m.el, 'Save and sign in'));
    await m.reply('POST', '/api/auth/links/consume', { token: null, status: 'suspended' });
    expect(m.text('[role=status]')).toContain('suspended');
    TestBed.resetTestingModule();
    const gone = await open('#used-token-abcdefghijklmnop');
    await gone.reply('POST', '/api/auth/links/inspect', {}, 410);
    expect(gone.text('[role=alert]')).toContain('no longer valid');
    TestBed.resetTestingModule();
    const none = await open('');
    expect(none.text('[role=alert]')).toContain('no longer valid');
  });
  it('a link that expires while the form is open', async () => {
    const m = await open('#tok-abcdefghijklmnopqrstuvwxyz');
    await m.reply('POST', '/api/auth/links/inspect', info);
    await m.type('input[name=password]', 'ceramics at dawn');
    await m.type('input[name=confirm]', 'ceramics at dawn');
    await m.click(button(m.el, 'Join and sign in'));
    await m.reply('POST', '/api/auth/links/consume', {}, 410);
    expect(m.text('[role=alert]')).toContain('no longer valid');
  });
});

describe('My account', () => {
  it('changes the password (checked against the policy), lists what I can do and what is recorded', async () => {
    const m = await mount(Account, { me: meFor(['orders.fulfil', 'insights.view']) });
    expect(m.text()).toContain('Mark orders as shipped');
    expect(m.text()).toContain('kept for 180 days');
    await m.type('input[name=current]', 'old-password-1');
    await m.type('input[name=password]', 'short');
    await m.click(button(m.el, 'Change password'));
    expect(m.text('[role=alert]')).toContain('at least 12');
    await m.type('input[name=password]', 'a new long passphrase');
    await m.type('input[name=confirm]', 'nope');
    await m.click(button(m.el, 'Change password'));
    expect(m.text('[role=alert]')).toContain('different');
    await m.type('input[name=confirm]', 'a new long passphrase');
    await m.click(button(m.el, 'Change password'));
    await m.reply('POST', '/api/me/password', { error: 'Your current password is not correct.' }, 400);
    expect(m.text('[role=alert]')).toBe('Your current password is not correct.');
    await m.click(button(m.el, 'Change password'));
    await m.reply('POST', '/api/me/password', {}, 429);
    expect(m.text('[role=alert]')).toContain('Too many attempts');
    await m.type('input[name=password]', 'a new long passphrase');
    await m.type('input[name=confirm]', 'a new long passphrase');
    await m.click(button(m.el, 'Change password'));
    await m.reply('POST', '/api/me/password', { token: 'new-session' });
    await m.reply('GET', '/api/me', meFor(['orders.fulfil']));
    expect(m.text('[role=status]')).toContain('signed out on your other devices');
    expect(TestBed.inject(ApiService).token()).toBe('new-session');
  });
  it('a forced change explains why and continues to the landing page; sign out everywhere', async () => {
    const m = await mount(Account, { me: meFor(['orders.view'], { mustChangePassword: true }) });
    const nav = vi.spyOn(m.router, 'navigateByUrl').mockResolvedValue(true);
    expect(m.text('.banner')).toContain("no longer meets the shop's password rules");
    await m.type('input[name=current]', 'old');
    await m.type('input[name=password]', 'a new long passphrase');
    await m.type('input[name=confirm]', 'a new long passphrase');
    await m.click(button(m.el, 'Change password'));
    await m.reply('POST', '/api/me/password', { token: 'n' });
    await m.reply('GET', '/api/me', meFor(['orders.view']));
    expect(nav).toHaveBeenCalledWith('/orders');
    const go = vi.spyOn(m.router, 'navigate').mockResolvedValue(true);
    await m.click(button(m.el, 'Sign out everywhere'));
    await m.reply('POST', '/api/me/sign-out-everywhere', null);
    expect(go).toHaveBeenCalledWith(['/login']);
    expect(TestBed.inject(ApiService).token()).toBeNull();
  });
  it('the owner and members without groups', async () => {
    const o = await mount(Account);
    expect(o.text()).toContain('You are the shop owner');
    TestBed.resetTestingModule();
    const n = await mount(Account, { me: meFor([]) });
    expect(n.text()).toContain('Nothing yet. Ask Olivia');
  });
});

describe('Activity tracking', () => {
  it('reports each guarded screen (pathname only, with its feature) and nothing else', async () => {
    @Component({ template: '' }) class Blank {}
    const m = await mount(Blank, { routes: [{ path: 'orders/:x', component: Blank, data: { feature: 'orders', perm: 'orders.view' } }, { path: 'login', component: Blank }] });
    TestBed.inject(ActivityTracker).start();
    TestBed.inject(ActivityTracker).start();
    await m.router.navigateByUrl('/orders/5?tab=x#frag');
    const b = m.http.expectOne('/api/activity/beacon');
    expect(b.request.body).toEqual({ kind: 'page_view', path: '/orders/5', feature: 'orders' });
    b.flush(null, { status: 500, statusText: 'x' });
    await m.router.navigateByUrl('/login');
    m.http.expectNone('/api/activity/beacon');
  });
});

const ev = (over: Partial<ActivityItem>): ActivityItem => ({ id: `e${Math.random()}`, at: '2026-06-15T10:00:00Z', kind: 'sign_in', userId: 'u1', userName: 'Pat', userStatus: 'active', ip: '1.2.3.4', ...over });

describe('Activity page', () => {
  it('describes every kind of event in plain language', () => {
    const cases: [Partial<ActivityItem>, string][] = [
      [{ kind: 'sign_in', reason: 'via_invite_link' }, 'Signed in (after joining)'],
      [{ kind: 'sign_in_failed', reason: 'suspended' }, 'Sign-in refused: account suspended'],
      [{ kind: 'sign_in_failed', reason: 'throttled', count: 4 }, 'Sign-in refused: too many attempts ×4'],
      [{ kind: 'sign_out' }, 'Signed out'],
      [{ kind: 'session_ended', reason: 'removed', method: 'GET', path: '/api/orders', count: 3 }, 'Old session refused (account removed) on GET /api/orders ×3'],
      [{ kind: 'link_created', purpose: 'invite', targetName: 'Lena' }, 'Created an invitation link for Lena'],
      [{ kind: 'link_opened', purpose: 'reset' }, 'Opened their password reset link'],
      [{ kind: 'link_used', purpose: 'invite' }, 'Used their invitation link'],
      [{ kind: 'link_revoked', purpose: 'invite', targetName: 'Lena' }, "Revoked Lena's invitation link"],
      [{ kind: 'link_invalid' }, 'An invalid or expired link was opened'],
      [{ kind: 'page_view', path: '/orders' }, 'Opened /orders'],
      [{ kind: 'page_denied', path: '/insights', permission: 'insights.view' }, 'Was refused /insights (needs See reports)'],
      [{ kind: 'api_denied', method: 'GET', path: '/api/staff', permission: 'sudo' }, 'Request refused: GET /api/staff (needs owner only)'],
      [{ kind: 'api_denied', method: 'POST', path: '/api/uploads', permission: 'catalog.manage or pages.manage' }, 'or Design and publish pages'],
      [{ kind: 'api_denied', method: 'GET', path: '/api/customers', permission: 'customers.view', count: 300 }, 'Request refused: GET /api/customers (needs See customers and their details) ×300'],
      [{ kind: 'api_unauthenticated', method: 'GET', path: '/api/orders', reason: 'no_token', count: 12 }, 'Request without a valid session (not signed in): GET /api/orders ×12'],
      [{ kind: 'change', action: 'update', entity: 'staff-group', entityId: 'abcdefghijkl' }, 'update staff-group abcdefgh'],
      [{ kind: 'change', action: 'update', entity: 'security-settings', entityId: 'security' }, 'update security-settings'],
      [{ kind: 'dropped', count: 40 }, '40 more events in this minute were not stored'],
    ];
    for (const [e, text] of cases) expect(describeEvent(ev(e))).toContain(text);
    for (const k of ['sign_in', 'sign_in_failed', 'sign_out', 'session_ended', 'link_created', 'link_opened', 'link_used', 'link_revoked', 'link_invalid', 'page_view', 'page_denied', 'api_denied', 'api_unauthenticated', 'change', 'dropped']) expect(KIND_LABEL[k], k).toBeTruthy();
    expect(KIND_LABEL['session_ended']).toBe('Refused');
  });
  it('filters by kind, person, dates, IP and text; opens a change with before and after; loads more; downloads CSV', async () => {
    const m = await mount(Activity);
    await m.reply('GET', '/api/staff?status=all', { items: [{ id: 'u1', name: 'Pat', status: 'active' }, { id: 'u2', name: 'Rex', status: 'removed' }], total: 2 });
    await m.reply('GET', '/api/activity?limit=50', { items: [ev({ kind: 'change', action: 'update', entity: 'staff-group', entityId: 'g1', auditId: 'a1' }), ev({ userId: null, userName: null, kind: 'api_unauthenticated', method: 'GET', path: '/api/orders', reason: 'no_token' })], next: 'cursor-1' });
    expect(m.all('select[name=user] option').map((o) => o.textContent)).toEqual(['Everyone', 'Pat', 'Rex (removed)']);
    expect(m.text('tbody')).toContain('Unknown');
    await m.click('tbody tr.clickable');
    await m.reply('GET', '/api/activity/changes/a1', { id: 'a1', at: 'x', userId: 'u1', action: 'update', entity: 'staff-group', entityId: 'g1', before: { permissions: ['orders.view'] }, after: { permissions: [] } });
    expect(m.text('tr.details')).toContain('orders.view');
    await m.click('tbody tr.clickable');
    expect(m.el.querySelector('tr.details')).toBeNull();
    await m.click(m.all('tbody tr.clickable')[1]);
    expect(m.text('tr.details')).toContain('not signed in');
    await m.click(button(m.el, 'Load more'));
    await m.reply('GET', '/api/activity?limit=50&before=cursor-1', { items: [ev({ kind: 'page_view', path: '/orders', feature: 'orders' })], next: null });
    expect(m.all('tbody tr.clickable').length).toBe(3);
    await m.click(button(m.el, 'Sign-ins', '.chip-toggle'));
    await m.reply('GET', '/api/activity?kinds=sign_in,sign_in_failed,sign_out,session_ended&limit=50', { items: [], next: null });
    expect(m.text()).toContain('No activity matches');
    await m.click(button(m.el, 'Denied access', '.chip-toggle'));
    await m.reply('GET', '/api/activity?kinds=sign_in,sign_in_failed,sign_out,session_ended,page_denied,api_denied,api_unauthenticated,dropped&limit=50', { items: [], next: null });
    await m.click(button(m.el, 'Denied access', '.chip-toggle'));
    await m.reply('GET', '/api/activity?kinds=sign_in,sign_in_failed,sign_out,session_ended&limit=50', { items: [], next: null });
    await m.select('select[name=user]', 'u2');
    await m.type('input[name=ip]', ' 1.2.3.4 ');
    await m.type('input[name=q]', 'orders');
    await m.type('input[name=from]', '2026-06-01');
    await m.type('input[name=to]', '2026-06-15');
    await m.click(button(m.el, 'Apply'));
    const r = m.http.expectOne((x) => x.url === '/api/activity');
    expect(r.request.params.get('userId')).toBe('u2');
    expect(r.request.params.get('ip')).toBe('1.2.3.4');
    expect(r.request.params.get('q')).toBe('orders');
    expect(Date.parse(r.request.params.get('to')!) - Date.parse(r.request.params.get('from')!)).toBe(15 * 86_400_000);
    r.flush({ items: [], next: null });
    await m.settle();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    await m.click(button(m.el, 'Download CSV'));
    const csv = m.http.expectOne((x) => x.url === '/api/activity' && x.headers.get('Accept') === 'text/csv');
    expect(csv.request.params.get('userId')).toBe('u2');
    csv.flush(new Blob(['a']));
    await m.click(button(m.el, 'Clear'));
    await m.reply('GET', '/api/activity?limit=50', { items: [], next: null });
  });
  it('starts filtered from the address (e.g. from a member page)', async () => {
    history.replaceState(null, '', '/activity');
    const m = await mount(Activity, { routes: [{ path: '**', component: Activity }] });
    m.http.match(() => true).forEach((r) => r.flush({ items: [], total: 0, next: null }));
    await m.router.navigateByUrl('/activity?userId=u9&ip=9.9.9.9');
    TestBed.resetTestingModule();
    const list = await mount(ActivityList, { inputs: { userId: 'u9', compact: true } });
    await list.reply('GET', '/api/activity?userId=u9&limit=15', { items: [ev({ userId: 'u9' })], next: null });
    expect(list.all('thead th').map((t) => t.textContent)).toEqual(['When', 'What', 'From']);
  });
});

describe('Security settings', () => {
  const view = { passwordPolicy: { staff: { minLength: 12, requireClasses: 0, disallowEmail: true, blockCommon: false }, customers: { minLength: 10, requireClasses: 0, disallowEmail: false, blockCommon: false } }, enforceStaffPolicyAtSignIn: false, activityRetentionDays: 180, version: 3, updatedAt: null, bounds: { minLength: { min: 8, max: 64 }, retention: [30, 90, 180, 365] } };
  it('edits both policies with a live tester, the sign-in enforcement and retention, and saves', async () => {
    const m = await mount(SecuritySettings);
    await m.reply('GET', '/api/security-settings', view);
    expect(m.all('.policy h4').map((h) => h.textContent)).toEqual(['Staff accounts (backoffice)', 'Customer accounts (shop)']);
    await m.type('input[name=staff-try]', 'owner-password');
    expect(m.text('[data-realm=staff] .ferr')).toContain('email');
    await m.type('input[name=customers-try]', 'long enough pw');
    expect(m.text('[data-realm=customers] .ok-msg')).toBe('Meets these rules.');
    await m.type('input[name=staff-min]', '14');
    await m.select('select[name=staff-classes]', '2: 2');
    await m.check('input[name=customers-common]', true);
    await m.check('input[name=enforce]', true);
    await m.select('select[name=retention]', '1: 90');
    expect(m.text('[data-realm=staff] .rules')).toContain('At least 14 characters');
    await m.click(button(m.el, 'Save security settings'));
    const r = await m.reply('PATCH', '/api/security-settings', { fields: [{ field: 'passwordPolicy.customers', message: 'minimum length must be 8 to 64' }] }, 400);
    expect(r.request.body).toEqual({ passwordPolicy: { staff: { minLength: 14, requireClasses: 2, disallowEmail: true, blockCommon: false }, customers: { minLength: 10, requireClasses: 0, disallowEmail: false, blockCommon: true } }, enforceStaffPolicyAtSignIn: true, activityRetentionDays: 90, version: 3 });
    expect(m.text('[role=alert]')).toContain('Check the customer policy');
    await m.click(button(m.el, 'Save security settings'));
    await m.reply('PATCH', '/api/security-settings', { error: 'The security settings were changed by someone else. Reload and try again.' }, 409);
    expect(m.text('[role=alert]')).toContain('changed by someone else');
    await m.click(button(m.el, 'Save security settings'));
    await m.reply('PATCH', '/api/security-settings', { ...view, version: 4, updatedAt: '2026-06-15T10:00:00Z' });
    expect(m.text('[role=status]')).toBe('Security settings saved.');
    expect(m.text()).toContain('Last changed');
    await m.type('input[name=staff-min]', '20');
    await m.click(button(m.el, 'Undo'));
    expect((m.el.querySelector('input[name=staff-min]') as HTMLInputElement).value).toBe('12');
  });
});

import { Members } from './members';
import { MemberPage } from './member';
import { Groups } from './groups';
import { GroupPage } from './group';
import { PermissionGrid, areaCell, statusOf } from './ui';
import { mount, button } from '../testing/harness';
import type { StaffDetail, StaffGroup, StaffMember } from '../api.service';

const member = (over: Partial<StaffMember> = {}): StaffMember => ({
  id: 'u-pat', email: 'pat@shop.test', name: 'Pat', status: 'active', sudo: false, version: 1, mustChangePassword: false,
  createdAt: '2026-06-01T10:00:00Z', activatedAt: '2026-06-01T11:00:00Z', lastLoginAt: '2026-06-10T09:00:00Z', removedAt: null,
  groups: [{ id: 'g-ful', name: 'Fulfilment' }], permissions: ['catalog.view', 'catalog.stock', 'orders.view', 'orders.fulfil'], pendingLink: null, inviteExpired: false, ...over,
});
const owner = member({ id: 'u-own', name: 'Olivia', email: 'owner@shop.test', sudo: true, groups: [], permissions: [] });
const group = (over: Partial<StaffGroup> = {}): StaffGroup => ({
  id: 'g-ful', name: 'Fulfilment', description: 'Ships orders', permissions: ['catalog.view', 'catalog.stock', 'orders.view', 'orders.fulfil'], template: 'fulfilment', version: 1,
  memberCount: 1, members: [{ id: 'u-pat', name: 'Pat', email: 'pat@shop.test', status: 'active' }], ...over,
});
const detail = (over: Partial<StaffDetail> = {}): StaffDetail => ({
  ...member(), createdByName: 'Olivia', removedByName: null, links: [{ id: 'l1', purpose: 'invite', createdAt: '2026-06-01T10:00:00Z', createdBy: 'Olivia', expiresAt: '2026-06-04T10:00:00Z', state: 'used', stateAt: '2026-06-01T11:00:00Z', revokedBy: null }],
  permissionSources: [
    { id: 'orders.view', area: 'orders', label: 'See orders', granted: true, groups: [{ id: 'g-ful', name: 'Fulfilment' }] },
    { id: 'orders.cancel', area: 'orders', label: 'Cancel and reopen orders', granted: false, groups: [] },
  ], ...over,
});
const link = { path: '/join#tok123', url: null, expiresAt: '2026-06-18T10:00:00Z', purpose: 'invite' as const };

describe('team helpers', () => {
  it('labels statuses and summarises an area', () => {
    expect(statusOf(owner).label).toBe('Owner');
    expect(statusOf(member({ status: 'invited' })).label).toBe('Invited');
    expect(statusOf(member({ status: 'invited', inviteExpired: true })).cls).toBe('bad');
    expect(statusOf(member({ status: 'suspended' })).label).toBe('Suspended');
    expect(statusOf(member({ status: 'removed' })).label).toBe('Removed');
    expect(statusOf(member()).label).toBe('Active');
    expect(areaCell(['orders.view', 'orders.fulfil'], 'orders')).toBe('Ship');
    expect(areaCell(['catalog.view'], 'catalog')).toBe('View');
    expect(areaCell([], 'insights')).toBe('—');
  });
  it('the permission grid ticks what a permission needs and unticks what depends on it', async () => {
    const m = await mount(PermissionGrid);
    await m.check('input[name="catalog.manage"]', true);
    expect(m.cmp.value()).toEqual(['catalog.view', 'catalog.stock', 'catalog.manage']);
    expect(m.text('.note-box')).toContain('Also ticked: See products and categories, Update stock levels');
    await m.check('input[name="catalog.view"]', false);
    expect(m.cmp.value()).toEqual([]);
    expect(m.text('.note-box')).toContain('Also unticked');
    await m.check('input[name="insights.view"]', true);
    expect(m.el.querySelector('.note-box')).toBeNull();
    expect(m.text()).toContain('Business-confidential figures.');
  });
});

describe('Team members', () => {
  async function setup() {
    const m = await mount(Members);
    await m.reply('GET', '/api/staff?status=active', { items: [owner, member(), member({ id: 'u-ivy', name: 'Ivy', email: 'ivy@shop.test', status: 'invited', lastLoginAt: null, pendingLink: { purpose: 'invite', expiresAt: '2026-06-18T10:00:00Z' } })], total: 3 });
    await m.reply('GET', '/api/staff-groups', [group(), group({ id: 'g-mkt', name: 'Marketing', members: [], memberCount: 0 })]);
    return m;
  }
  it('lists members with status, groups and last sign-in; filters; shows the access overview', async () => {
    const m = await setup();
    expect(m.all('tbody tr').length).toBe(3);
    expect(m.text('tbody tr:nth-child(1)')).toContain('Owner');
    expect(m.text('tbody tr:nth-child(1)')).toContain('All permissions');
    expect(m.text('tbody tr:nth-child(2)')).toContain('Fulfilment');
    expect(m.text('tbody tr:nth-child(3)')).toContain('Invited');
    expect(m.text('tbody tr:nth-child(3)')).toContain('Never');
    await m.select('select[aria-label="Filter by status"]', 'invited');
    await m.reply('GET', '/api/staff?status=active', { items: [owner, member()], total: 2 });
    await m.select('select[aria-label="Filter by group"]', 'g-ful');
    expect(m.all('tbody tr').length).toBe(0);
    await m.select('select[aria-label="Filter by status"]', '');
    await m.reply('GET', '/api/staff?status=active', { items: [owner, member()], total: 2 });
    expect(m.all('tbody tr').length).toBe(1);
    await m.select('select[aria-label="Filter by group"]', '');
    await m.check('.toolbar input[type=checkbox]', true);
    expect(m.all('.access-matrix th').map((t) => t.textContent)).toEqual(['Person', 'Catalogue', 'Orders', 'Customers', 'Discounts', 'Pages', 'Insights', 'Settings']);
    expect(m.all('.access-matrix tbody tr:nth-child(2) td').map((t) => t.textContent!.trim()).slice(1)).toEqual(['Stock', 'Ship', '—', '—', '—', '—', '—']);
    expect(m.text('.access-matrix tbody tr:nth-child(1)')).toContain('All');
    await m.type('input[type=search]', 'zzz');
    expect(m.text()).toContain('Nobody matches');
    await m.select('select[aria-label="Filter by status"]', 'removed');
    await m.reply('GET', '/api/staff?status=removed', { items: [member({ status: 'removed', removedAt: '2026-06-12T10:00:00Z' })], total: 1 });
  });
  it('invites someone and shows the one-time link once, with a warning and copy', async () => {
    const m = await setup();
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    await m.click(button(m.el, '+ Invite someone'));
    await m.click(button(m.el, 'Create invitation link'));
    expect(m.text('[role=alert]')).toBe('Enter an email and a name.');
    await m.type('input[name=email]', 'lena@shop.test');
    await m.type('input[name=name]', 'Lena');
    await m.check('.picks input', true);
    await m.click(button(m.el, 'Create invitation link'));
    await m.reply('POST', '/api/staff', { fields: [{ field: 'email', message: 'already on your team' }] }, 409);
    expect(m.text('[role=alert]')).toBe('Email: already on your team');
    await m.click(button(m.el, 'Create invitation link'));
    const req = await m.reply('POST', '/api/staff', { member: detail({ name: 'Lena' }), link });
    expect(req.request.body).toEqual({ email: 'lena@shop.test', name: 'Lena', groupIds: ['g-ful'] });
    await m.reply('GET', '/api/staff?status=active', { items: [owner], total: 1 });
    expect(m.text('.linkbox')).toContain('Send this invitation link to Lena');
    expect(m.text('.linkbox')).toContain('Anyone who opens it can create this account');
    expect((m.el.querySelector('.linkbox input') as HTMLInputElement).value).toBe(`${location.origin}/join#tok123`);
    await m.click(button(m.el, 'Copy link'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`${location.origin}/join#tok123`);
    expect(m.text('.linkbox')).toContain('Copied');
    await m.click(button(m.el, 'Close'));
    expect(m.el.querySelector('.linkbox')).toBeNull();
  });
  it('offers to restore a removed member instead of inviting again; downloads CSV', async () => {
    const m = await setup();
    await m.click(button(m.el, '+ Invite someone'));
    await m.type('input[name=email]', 'rex@shop.test');
    await m.type('input[name=name]', 'Rex');
    await m.click(button(m.el, 'Create invitation link'));
    await m.reply('POST', '/api/staff', { code: 'removed_member', userId: 'u-rex', name: 'Rex' }, 409);
    expect(m.text('.warn-box')).toContain('Rex was removed from your team earlier');
    await m.click(button(m.el, 'Restore Rex'));
    await m.reply('POST', '/api/staff/u-rex/restore', {}, 500);
    expect(m.text('[role=alert]')).toBe('Could not restore.');
    await m.click(button(m.el, 'Restore Rex'));
    await m.reply('POST', '/api/staff/u-rex/restore', { member: detail({ name: 'Rex' }), link: { ...link, url: 'https://admin.shop.test/join#tok123' } });
    await m.reply('GET', '/api/staff?status=active', { items: [owner], total: 1 });
    expect((m.el.querySelector('.linkbox input') as HTMLInputElement).value).toBe('https://admin.shop.test/join#tok123');
    await m.click(button(m.el, 'Create invitation link'));
    await m.reply('POST', '/api/staff', {}, 500);
    expect(m.text('[role=alert]')).toBe('Could not create the invitation.');
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    await m.click(button(m.el, 'Download CSV'));
    const csv = m.http.expectOne((r) => r.url === '/api/staff' && r.headers.get('Accept') === 'text/csv');
    csv.flush(new Blob(['a']));
    expect(created).toHaveBeenCalled();
  });
});

describe('Team member page', () => {
  async function setup(d = detail()) {
    const m = await mount(MemberPage, { inputs: { id: d.id } });
    await m.reply('GET', '/api/staff-groups', [group(), group({ id: 'g-mkt', name: 'Marketing', members: [], memberCount: 0 })]);
    await m.reply('GET', `/api/staff/${d.id}`, d);
    await m.reply('GET', new RegExp(`/api/activity\\?userId=${d.id}`), { items: [{ id: 'e1', at: '2026-06-10T09:00:00Z', kind: 'sign_in', userId: d.id, userName: d.name, userStatus: 'active', ip: '1.2.3.4' }], next: null });
    return m;
  }
  it('shows access, effective permissions with their sources, links and activity', async () => {
    const m = await setup();
    expect(m.text('header')).toContain('pat@shop.test');
    expect(m.text('.facts')).toContain('by Olivia');
    expect(m.text()).toContain('See orders');
    expect(m.text('table.mini tbody tr:nth-child(1)')).toContain('Fulfilment');
    expect(m.text()).toContain('Used');
    expect(m.text('app-activity-list')).toContain('Signed in');
  });
  it('changes groups, renames, creates and revokes links, suspends, reactivates and removes', async () => {
    const m = await setup();
    await m.check('.picks label:nth-child(2) input', true);
    await m.click(button(m.el, 'Save groups'));
    const g = await m.reply('PUT', '/api/staff/u-pat/groups', detail({ groups: [{ id: 'g-ful', name: 'Fulfilment' }, { id: 'g-mkt', name: 'Marketing' }] }));
    expect(g.request.body).toEqual({ groupIds: ['g-ful', 'g-mkt'] });
    expect(m.text('[role=status]')).toContain('Groups saved');
    await m.click('button[aria-label=Rename]');
    await m.type('input[name=n]', 'Patrícia');
    await m.click(button(m.el, 'Save'));
    const r = await m.reply('PATCH', '/api/staff/u-pat', detail({ name: 'Patrícia', version: 2 }));
    expect(r.request.body).toEqual({ name: 'Patrícia', version: 1 });
    await m.click(button(m.el, 'Create password reset link'));
    await m.reply('POST', '/api/staff/u-pat/links', { ...link, purpose: 'reset' });
    await m.reply('GET', '/api/staff/u-pat', detail({ name: 'Patrícia', pendingLink: { purpose: 'reset', expiresAt: '2026-06-16T10:00:00Z' } }));
    expect(m.text('.linkbox')).toContain('password reset link');
    await m.click(button(m.el, 'Revoke link'));
    await m.reply('POST', '/api/staff/u-pat/links/revoke', { revoked: 1 });
    await m.reply('GET', '/api/staff/u-pat', detail());
    expect(m.text('[role=status]')).toContain('Link revoked');
    expect(m.el.querySelector('.linkbox')).toBeNull();
    await m.click(button(m.el, 'Suspend'));
    await m.reply('POST', '/api/staff/u-pat/suspend', detail({ status: 'suspended' }));
    expect(m.text('header')).toContain('Suspended');
    await m.click(button(m.el, 'Reactivate'));
    await m.reply('POST', '/api/staff/u-pat/reactivate', {}, 409);
    expect(m.text('[role=alert]')).toBe('That did not work.');
    await m.click(button(m.el, 'Reactivate'));
    await m.reply('POST', '/api/staff/u-pat/reactivate', detail());
    await m.click(button(m.el, 'Sign out everywhere'));
    await m.reply('POST', '/api/staff/u-pat/sign-out', detail());
    expect(m.text('[role=status]')).toContain('Signed out on every device');
    await m.click(button(m.el, 'Remove Pat'));
    expect(m.text('.danger-zone')).toContain('Click to confirm');
    await m.click(button(m.el, 'Click to confirm'));
    await m.reply('DELETE', '/api/staff/u-pat', null);
    await m.reply('GET', '/api/staff/u-pat', detail({ status: 'removed', removedAt: '2026-06-15T10:00:00Z', removedByName: 'Olivia', groups: [] }));
    expect(m.text('[role=status]')).toContain('Their access ended immediately');
    expect(m.text('.facts')).toContain('Removed');
    expect(m.el.querySelector('.danger-zone')).toBeNull();
    await m.click(button(m.el, 'Restore Pat'));
    await m.reply('POST', '/api/staff/u-pat/restore', { member: detail({ status: 'invited', groups: [] }), link });
    expect(m.text('.linkbox')).toContain('invitation link');
  });
  it('invited members get invitation links and "Cancel invitation"', async () => {
    const m = await setup(detail({ status: 'invited', activatedAt: null, lastLoginAt: null, pendingLink: { purpose: 'invite', expiresAt: '2026-06-18T10:00:00Z' } }));
    expect(m.text('.facts')).toContain('Not yet');
    await m.click(button(m.el, 'Create a new invitation link'));
    await m.reply('POST', '/api/staff/u-pat/links', link);
    await m.reply('GET', '/api/staff/u-pat', detail({ status: 'invited' }));
    expect(m.text('.danger-zone')).toContain('Cancel invitation');
  });
  it('protects the owner account', async () => {
    const o = await setup(detail({ ...owner, id: 'u-own', permissionSources: [], links: [] }));
    expect(o.text()).toContain('This is the owner account');
    expect(o.text()).toContain('All permissions, plus the team');
    expect(o.el.querySelector('.danger-zone')).toBeNull();
  });
  it('goes back to the team list when the member does not exist', async () => {
    const m = await mount(MemberPage, { inputs: { id: 'nope' } });
    const nav = vi.spyOn(m.router, 'navigate').mockResolvedValue(true);
    await m.reply('GET', '/api/staff-groups', []);
    await m.reply('GET', '/api/staff/nope', {}, 404);
    expect(nav).toHaveBeenCalledWith(['/team']);
  });
});

describe('Permission groups', () => {
  it('lists groups with their access and creates one from a template', async () => {
    const m = await mount(Groups);
    const nav = vi.spyOn(m.router, 'navigate').mockResolvedValue(true);
    await m.reply('GET', '/api/staff-groups', [group()]);
    expect(m.all('.access-matrix tbody td').map((t) => t.textContent!.trim()).slice(1, 4)).toEqual(['1', 'Stock', 'Ship']);
    await m.click(button(m.el, '+ New group'));
    expect(m.all('.preset').length).toBe(9);
    await m.click(button(m.el, 'Create and edit permissions'));
    expect(m.text('[role=alert]')).toBe('Give the group a name.');
    await m.click(button(m.el, 'Finance', '.preset'));
    expect(m.text('.note-box')).toContain("Can't: Ship or cancel orders");
    expect((m.el.querySelector('input[name=name]') as HTMLInputElement).value).toBe('Finance');
    await m.click(button(m.el, 'Create and edit permissions'));
    const req = await m.reply('POST', '/api/staff-groups', group({ id: 'g-fin', name: 'Finance' }));
    expect(req.request.body.permissions).toEqual(['catalog.view', 'orders.view', 'orders.payments', 'discounts.view', 'insights.view']);
    expect(req.request.body.template).toBe('finance');
    expect(nav).toHaveBeenCalledWith(['/team/groups', 'g-fin']);
    await m.click(button(m.el, 'Empty group', '.preset'));
    await m.type('input[name=name]', 'Custom');
    await m.click(button(m.el, 'Create and edit permissions'));
    const r2 = await m.reply('POST', '/api/staff-groups', {}, 409);
    expect(r2.request.body.permissions).toEqual([]);
    expect(m.text('[role=alert]')).toBe('Could not create the group.');
  });
  it('shows an empty state', async () => {
    const m = await mount(Groups);
    await m.reply('GET', '/api/staff-groups', []);
    expect(m.text()).toContain('No groups yet');
  });
});

describe('Group editor', () => {
  async function setup(g = group()) {
    const m = await mount(GroupPage, { inputs: { id: g.id } });
    await m.reply('GET', '/api/staff?status=active', { items: [owner, member(), member({ id: 'u-max', name: 'Max', email: 'max@shop.test', groups: [] })], total: 3 });
    await m.reply('GET', `/api/staff-groups/${g.id}`, g);
    return m;
  }
  it('shows the impact before saving, asks to confirm when people are affected, and saves', async () => {
    const m = await setup();
    expect(m.text('.ed-side')).toContain('No unsaved changes');
    await m.check('input[name="orders.cancel"]', true);
    await m.check('input[name="catalog.stock"]', false);
    expect(m.text('.impact-list')).toContain('+ Cancel and reopen orders');
    expect(m.text('.impact-list')).toContain('− Update stock levels');
    expect(m.text('.ed-side')).toContain('This changes access for 1 person: Pat');
    await m.click(button(m.el, 'Save changes'));
    expect(m.text('.ed-side')).toContain('Click to confirm');
    await m.click(button(m.el, 'Click to confirm'));
    const req = await m.reply('PATCH', '/api/staff-groups/g-ful', { error: 'This group was changed by someone else. Reload it and try again.' }, 409);
    expect(req.request.body).toEqual({ name: 'Fulfilment', description: 'Ships orders', permissions: ['catalog.view', 'orders.view', 'orders.fulfil', 'orders.cancel'], version: 1 });
    expect(m.text('[role=alert]')).toContain('changed by someone else');
    await m.click(button(m.el, 'Save changes'));
    await m.click(button(m.el, 'Click to confirm'));
    await m.reply('PATCH', '/api/staff-groups/g-ful', { ...group({ permissions: ['catalog.view', 'orders.view', 'orders.fulfil', 'orders.cancel'], version: 2 }), affectedMembers: 1 });
    expect(m.text('[role=status]')).toContain('Access changed for 1 person');
    await m.check('input[name="insights.view"]', true);
    await m.click(button(m.el, 'Undo'));
    expect(m.text('.ed-side')).toContain('No unsaved changes');
  });
  it('adds and removes members, and deletes the group after confirming who loses access', async () => {
    const m = await setup();
    const nav = vi.spyOn(m.router, 'navigate').mockResolvedValue(true);
    expect(m.all('select[name=add] option').map((o) => o.textContent)).toEqual(['Max']);
    await m.click(button(m.el, 'Add'));
    const add = await m.reply('POST', '/api/staff-groups/g-ful/members', group({ memberCount: 2, members: [...group().members, { id: 'u-max', name: 'Max', email: 'max@shop.test', status: 'active' }] }));
    expect(add.request.body).toEqual({ add: ['u-max'] });
    await m.click(button(m.el, 'Remove', '.row-line button'));
    await m.reply('POST', '/api/staff-groups/g-ful/members', group());
    expect(m.text('.danger-zone')).toContain('1 person loses these permissions: Pat');
    await m.click(button(m.el, 'Delete Fulfilment'));
    await m.click(button(m.el, 'Click to confirm'));
    await m.reply('DELETE', '/api/staff-groups/g-ful', null);
    expect(nav).toHaveBeenCalledWith(['/team/groups']);
  });
  it('saves a group without members straight away', async () => {
    const m = await setup(group({ members: [], memberCount: 0 }));
    await m.type('input[name=desc]', 'New text');
    expect(m.text('.ed-side')).toContain('Nobody is in this group yet');
    await m.click(button(m.el, 'Save changes'));
    await m.reply('PATCH', '/api/staff-groups/g-ful', group({ description: 'New text', members: [], memberCount: 0, version: 2 }));
    expect(m.text('[role=status]')).toBe('Saved.');
  });
});

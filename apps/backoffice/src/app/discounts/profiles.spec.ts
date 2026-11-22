import { Profiles } from './profiles';
import { ProfilePage } from './profile';
import { mount, button } from '../testing/harness';
import { customers, profile } from '../testing/fixtures';

describe('Profiles list', () => {
  it('lists profiles and creates one', async () => {
    const m = await mount(Profiles);
    const nav = vi.spyOn(m.router, 'navigate').mockResolvedValue(true);
    await m.reply('GET', '/api/discount-profiles', [profile(), profile({ id: 'p2', name: 'VIP', status: 'paused', rules: [], memberCount: 1, activeMembers: 1 })]);
    const rows = m.all('tbody tr');
    expect(rows[0].textContent).toContain('Trade 30%: −30%');
    expect(rows[0].textContent).toContain('(1 ended)');
    expect(rows[1].textContent).toContain('No offers yet');
    expect(rows[1].textContent).toContain('Paused');
    await m.click(button(m.el, 'Create profile'));
    expect(m.text('[role=alert]')).toBe('Enter a name and a label.');
    await m.type('input[name=name]', 'Friends');
    await m.type('input[name=label]', 'Friends price');
    await m.click(button(m.el, 'Create profile'));
    const req = await m.reply('POST', '/api/discount-profiles', profile({ id: 'new' }));
    expect(req.request.body).toEqual({ name: 'Friends', publicLabel: 'Friends price' });
    expect(nav).toHaveBeenCalledWith(['/discounts/profiles', 'new']);
    await m.click(button(m.el, 'Create profile'));
    await m.reply('POST', '/api/discount-profiles', { error: 'Nope' }, 400);
    expect(m.text('[role=alert]')).toBe('Nope');
  });
  it('shows an empty state', async () => {
    const m = await mount(Profiles);
    await m.reply('GET', '/api/discount-profiles', []);
    expect(m.text()).toContain('No profiles yet');
  });
});

describe('Profile page', () => {
  async function setup() {
    const m = await mount(ProfilePage, { inputs: { id: 'pr-trade' } });
    await m.reply('GET', '/api/customers', customers);
    await m.reply('GET', '/api/discount-profiles/pr-trade', profile());
    await m.reply('GET', '/api/discount-profiles/pr-trade/members', { items: [{ customerId: 'cu-ann', email: 'ann@x.io', name: 'Ann', activated: true, validUntil: '2026-12-31T23:00:00.000Z', addedAt: '' }], total: 1 });
    return m;
  }
  it('edits the profile live and says how many customers it affects', async () => {
    const m = await setup();
    expect(m.text('header')).toContain('1 member');
    expect(m.text('section')).toContain('Trade 30%');
    await m.type('input[name=label]', 'Trade partner price');
    await m.check('input[name=active]', false);
    await m.click(button(m.el, 'Save changes'));
    const req = await m.reply('PATCH', '/api/discount-profiles/pr-trade', { ...profile({ publicLabel: 'Trade partner price', version: 2 }), affectedMembers: 1 });
    expect(req.request.body).toEqual({ name: 'Trade', publicLabel: 'Trade partner price', description: '', status: 'paused', version: 1 });
    expect(m.text('[role=status]')).toBe('Saved. This applies to 1 customer now.');
    await m.click(button(m.el, 'Save changes'));
    await m.reply('PATCH', '/api/discount-profiles/pr-trade', {}, 409);
    expect(m.text('[role=alert]')).toContain('Someone else changed this profile');
    await m.click(button(m.el, 'Save changes'));
    await m.reply('PATCH', '/api/discount-profiles/pr-trade', {}, 500);
    expect(m.text('[role=alert]')).toBe('Could not save.');
  });
  it('adds and removes members, downloads them, and deletes the profile', async () => {
    const m = await setup();
    const nav = vi.spyOn(m.router, 'navigate').mockResolvedValue(true);
    expect(m.text('tbody')).toContain('31 Dec 2026');
    await m.type('input[name=q]', 'bo@x.io');
    expect(m.text()).toContain("they have no account yet");
    await m.type('input[name=last]', '2026-12-31');
    await m.click(button(m.el, 'Add member'));
    const add = await m.reply('POST', '/api/discount-profiles/pr-trade/members', profile());
    expect(add.request.body).toEqual({ add: [{ customerId: 'cu-bo', lastDay: '2026-12-31' }] });
    await m.reply('GET', '/api/discount-profiles/pr-trade', profile());
    await m.reply('GET', '/api/discount-profiles/pr-trade/members', { items: [], total: 0 });
    m.cmp.add(); // nothing matches any more
    m.http.expectNone('/api/discount-profiles/pr-trade/members');
    m.cmp.removeMember('cu-ann');
    const rm = await m.reply('POST', '/api/discount-profiles/pr-trade/members', profile());
    expect(rm.request.body).toEqual({ remove: ['cu-ann'] });
    await m.reply('GET', '/api/discount-profiles/pr-trade', profile());
    await m.reply('GET', '/api/discount-profiles/pr-trade/members', { items: [], total: 0 });
    const dl = vi.spyOn((m.cmp as unknown as { api: { downloadCsv: (...a: unknown[]) => unknown } }).api, 'downloadCsv').mockReturnValue({ subscribe: () => undefined } as never);
    m.cmp.download();
    expect(dl).toHaveBeenCalledWith('/api/discount-profiles/pr-trade/members', 'profile-Trade-members.csv');
    await m.click(button(m.el, 'Delete profile'));
    expect(m.text('.danger-zone button')).toBe('Click to confirm');
    await m.click(button(m.el, 'Click to confirm'));
    await m.reply('DELETE', '/api/discount-profiles/pr-trade', { error: 'Remove the members first.' }, 409);
    expect(m.text('[role=alert]')).toBe('Remove the members first.');
    await m.click(button(m.el, 'Delete profile'));
    await m.click(button(m.el, 'Click to confirm'));
    await m.reply('DELETE', '/api/discount-profiles/pr-trade', null);
    expect(nav).toHaveBeenCalledWith(['/discounts/profiles']);
  });
  it('invites to add offers when the profile has none', async () => {
    const m = await mount(ProfilePage, { inputs: { id: 'pr-trade' } });
    await m.reply('GET', '/api/customers', customers);
    await m.reply('GET', '/api/discount-profiles/pr-trade', profile({ rules: [] }));
    await m.reply('GET', '/api/discount-profiles/pr-trade/members', { items: [], total: 0 });
    expect(m.text()).toContain('No offers yet. Add one');
    expect(m.el.querySelector('table')).toBeNull();
  });

  it('goes back to the list when the profile does not exist', async () => {
    const m = await mount(ProfilePage, { inputs: { id: 'nope' } });
    const nav = vi.spyOn(m.router, 'navigate').mockResolvedValue(true);
    await m.reply('GET', '/api/discount-profiles/nope', {}, 404);
    expect(nav).toHaveBeenCalledWith(['/discounts/profiles']);
  });
});

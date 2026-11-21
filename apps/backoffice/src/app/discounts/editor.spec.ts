import { DiscountEditor } from './editor';
import { mount, button, Mounted } from '../testing/harness';
import { customers, offer, page, profile, settings, categories, summaries } from '../testing/fixtures';
import type { DiscountView } from '../api.service';

type M = Mounted<DiscountEditor>;
async function openNew(inputs: Record<string, unknown> = {}, tz = 'Europe/Lisbon') {
  const m = await mount(DiscountEditor, { inputs });
  await m.reply('GET', '/api/categories', categories);
  await m.reply('GET', '/api/customers', customers);
  await m.reply('GET', '/api/discount-profiles', [profile()]);
  await m.reply('GET', '/api/settings', settings({ timezone: tz }));
  return m;
}
async function openExisting(d: DiscountView, extra: { codes?: unknown[]; total?: number } = {}) {
  const m = await mount(DiscountEditor, { inputs: { id: d.id } });
  await m.reply('GET', '/api/categories', categories);
  await m.reply('GET', '/api/customers', customers);
  await m.reply('GET', '/api/discount-profiles', [profile()]);
  await m.reply('GET', '/api/settings', settings());
  await m.reply('GET', `/api/discounts/${d.id}`, d);
  if (d.trigger === 'code') await m.reply('GET', `/api/discounts/${d.id}/codes?skip=0&limit=50`, { items: extra.codes ?? [], total: extra.total ?? (extra.codes ?? []).length });
  await m.reply('GET', `/api/discounts/${d.id}/redemptions`, { items: [{ orderId: 'o1', at: '2026-06-10T10:00:00Z', code: 'ABC', amount: 5, state: 'used', customerEmail: 'a@x.io', orderTotal: 45 }, { orderId: 'o2', at: '2026-06-11T10:00:00Z', code: null, amount: 3, state: 'released', customerEmail: 'b@x.io', orderTotal: null }], total: 2 });
  await m.reply('GET', `/api/audit?entity=discount&id=${d.id}`, { items: [{ id: 'a1', at: '2026-06-01T10:00:00Z', userId: 'u', userName: 'Max', action: 'update', entity: 'discount', entityId: d.id }], next: 'c1' });
  return m;
}
const preview = (m: M) => m.text('aside');
/** Answers the preview's product requests (it loads only the products the offer targets). */
const pool = (m: M, items = summaries) => m.replyAll('GET', /^\/api\/products\?/, page(items));
const wait = () => new Promise((r) => setTimeout(r, 300));
const rows = (m: M) => m.all('aside tbody tr').map((r) => [...r.querySelectorAll('td')].map((c) => c.textContent!.trim()).join(' '));

describe('Offer editor: new offers', () => {
  it('validates like the server, live after the first attempt', async () => {
    const m = await openNew();
    expect(m.text('h1')).toBe('New offer');
    expect(preview(m)).toContain('Complete the form to see a preview');
    await m.click(button(m.el, 'Create offer'));
    expect(m.text('.save-bar .err')).toBe('Please fix the highlighted fields.');
    expect(m.all('.ferr').map((e) => e.textContent)).toEqual(['is required', 'is required']);
    await m.type('input[name=name]', 'Winter sale');
    expect(m.all('.ferr').map((e) => e.textContent)).toEqual(['is required']);
    await m.type('input[name=label]', 'Winter');
    expect(m.all('.ferr').length).toBe(0);
    const req = (await pool(m));
    expect(req).toBe(1);
    m.http.verify();
  });

  it('previews prices with the real engine, and warns about risky values', async () => {
    const m = await openNew();
    await m.type('input[name=name]', 'Sale');
    await m.type('input[name=label]', 'Sale');
    await pool(m);
    expect(preview(m)).toContain('Matching products with only this offer applied');
    expect(rows(m)).toEqual(['Linen Mug €24.00 €21.60', 'Bud Vase €29.00 €26.10', 'Bowl €10.00 €9.00']);
    await m.type('input[name=pct]', '60');
    expect(preview(m)).toContain('More than half off');
    await m.click(button(m.el, 'Amount off'));
    await m.type('input[name=amt]', '7');
    expect(rows(m)[0]).toBe('Linen Mug €24.00 €17.00');
    await m.click(button(m.el, 'Once per order'));
    expect(preview(m)).toContain('A sample order with matching products');
    expect(rows(m)).toEqual(['Order of 3 items €63.00 €56.00']);
    await m.click(button(m.el, 'Fixed price'));
    expect((button(m.el, 'Once per order') as HTMLButtonElement).disabled).toBe(true);
    await m.type('input[name=amt]', '25');
    expect(preview(m)).toContain("2 matching products already cost €25.00 or less; their price won't change");
    await m.type('input[name=amt]', '10');
    expect(preview(m)).toContain('Some products drop to less than half their price');
    await m.click(button(m.el, '% off'));
    expect((m.el.querySelector('input[name=pct]') as HTMLInputElement).value).toBe('60');
  });

  it('targets products, categories and exclusions', async () => {
    const m = await openNew();
    await m.type('input[name=name]', 'X'); await m.type('input[name=label]', 'X');
    await pool(m);
    await m.click(button(m.el, 'Product price', 'button.preset'));
    expect(m.el.querySelector('.picker app-product-picker input')).not.toBeNull();
    expect(preview(m)).toContain('Complete the form');
    // The product search runs on the server.
    await m.type('.picker app-product-picker input', 'mug');
    await wait();
    await m.reply('GET', /^\/api\/products\?.*q=mug/, page([summaries[0]]));
    expect(m.all('.picker .pick-row').length).toBe(1);
    await m.check('.picker .pick-row input', true);
    expect(m.text('.picker > small')).toBe('1 selected');
    const byIds = await m.reply('GET', /^\/api\/products\?.*ids=p-mug/, page([summaries[0]]));
    expect(byIds.request.params.get('ids')).toBe('p-mug');
    expect(rows(m)).toEqual(['Linen Mug €24.00 €21.60']);
    await m.check('.picker .pick-row input', false);
    await m.click(button(m.el, 'Create offer'));
    expect(m.text('.ferr')).toBe('pick at least one');
    await m.click(button(m.el, 'Categories'));
    expect(m.text('.ferr')).toBe('pick at least one');
    await m.check('.picks label:nth-child(2) input', true);
    const byCat = await m.reply('GET', /^\/api\/products\?.*category=c-vases/, page([summaries[1]]));
    expect(byCat.request.params.get('status')).toBe('visible');
    expect(rows(m)).toEqual(['Bud Vase €29.00 €26.10']);
    await m.click(button(m.el, 'Shop-wide sale', 'button.preset'));
    await m.click(button(m.el, 'All products'));
    await pool(m);
    await m.type('details.more app-product-picker input', 'vase');
    await wait();
    await m.reply('GET', /^\/api\/products\?.*q=vase/, page([summaries[1]]));
    await m.check('details.more .pick-row input', true);
    expect(m.text('details.more summary')).toBe('Exclude products (1)');
    expect(rows(m).length).toBe(2);
    m.cmp.choose('shop');
    expect(m.cmp.f.target).toBe('all');
  });

  it('schedules in shop time: start now or later, end never, end of day, or an exact time', async () => {
    const m = await openNew({}, 'Europe/Lisbon');
    await m.type('input[name=name]', 'X'); await m.type('input[name=label]', 'X');
    expect(m.text('.hint-top')).toContain('Shop time: Lisbon (UTC+01:00)');
    expect(m.cmp.input().schedule).toEqual({ start: null, end: null });
    await m.check('input[name=startNow]', false);
    await m.type('input[name=start]', '2020-01-01T00:00');
    expect(preview(m)).toContain('Starts in the past: it is active as soon as you save');
    expect(m.text()).toContain('your time');
    await m.type('input[name=start]', '2099-01-01T00:00');
    expect(preview(m)).toContain('Scheduled: starts 1 Jan 2099, 00:00 (Lisbon time)');
    await m.select('select[name=endMode]', 'day');
    await m.type('input[name=endDay]', '2099-01-31');
    expect(m.cmp.input().schedule).toEqual({ start: '2099-01-01T00:00', end: '2099-02-01T00:00' });
    expect(m.text()).toContain('Runs until 23:59 on this day (Lisbon time)');
    await m.select('select[name=endMode]', 'exact');
    await m.type('input[name=end]', '2099-01-15T18:30');
    expect(m.cmp.input().schedule.end).toBe('2099-01-15T18:30');
    await m.type('input[name=end]', '2098-01-01T00:00');
    await m.click(button(m.el, 'Create offer'));
    expect(m.text('.ferr')).toBe('must be after the start');
    await m.type('input[name=start]', '2020-01-01T00:00');
    await m.type('input[name=end]', '2021-01-01T00:00');
    expect(preview(m)).toContain('this offer has already ended');
    expect(m.cmp.yourTime('nonsense')).toBe('');
  });

  it('shows no "your time" hint when the browser is in the shop time zone', async () => {
    const m = await openNew({}, Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(m.cmp.yourTime('2026-06-01T10:00')).toBe('');
  });

  it('limits, guest warning, combining, publishing paused, then creates with cents and basis points', async () => {
    const m = await openNew();
    const nav = vi.spyOn(m.router, 'navigate').mockResolvedValue(true);
    await m.click(button(m.el, 'Voucher', 'button.preset'));
    expect(m.cmp.f.trigger).toBe('code');
    expect(m.cmp.f.scope).toBe('order');
    await m.type('input[name=name]', 'Welcome'); await m.type('input[name=label]', 'Welcome 10%');
    await m.type('input[name=campaign]', ' Spring ');
    await m.type('input[name=pct]', '12.5');
    await m.type('input[name=minSub]', '40');
    await m.type('input[name=minQty]', '2');
    await m.type('input[name=total]', '100');
    await m.type('input[name=maxOrder]', '15.5');
    await m.type('input[name=pcOrders]', '1');
    await m.type('input[name=pcAmount]', '20');
    await m.type('input[name=pcFirst]', '1');
    expect(m.text('.warn-box')).toContain('Guests are recognised by the email they type');
    await m.check('input[name=comb]', true);
    await m.check('input[name=decl]', true);
    await m.type('input[name=prio]', '3');
    await m.check('input[name=pub]', false);
    expect(preview(m)).toContain('The preview assumes the minimum order conditions are met');
    expect(preview(m)).toContain('After saving, add or generate codes');
    expect(preview(m)).toContain('Paused: shoppers don’t get this offer');
    await m.click(button(m.el, 'Create offer'));
    const req = await m.reply('POST', '/api/discounts', offer({}, { id: 'new' }));
    expect(req.request.body).toEqual({
      name: 'Welcome', label: 'Welcome 10%', campaign: 'Spring', trigger: 'code', scope: 'order',
      audience: { type: 'everyone' }, access: { requiresSignIn: false }, target: { type: 'all' }, excludeProductIds: [],
      effect: { type: 'percent', bp: 1250 }, conditions: { minSubtotalCents: 4000, minQty: 2 },
      limits: { totalUses: 100, maxDiscountPerOrderCents: 1550 }, perCustomer: { maxOrders: 1, maxAmountCents: 2000, firstOrders: 1 },
      declinable: true, combinable: true, priority: 3, schedule: { start: null, end: null }, status: 'paused',
    });
    expect(nav).toHaveBeenCalledWith(['/discounts', 'new']);
  });

  it('shows server-side field errors', async () => {
    const m = await openNew();
    await m.type('input[name=name]', 'X'); await m.type('input[name=label]', 'X');
    await m.click(button(m.el, 'Create offer'));
    await m.reply('POST', '/api/discounts', { error: 'Please fix the highlighted fields.', fields: [{ field: 'target.productIds', message: 'unknown ids: p9' }, { field: 'name', message: 'taken' }] }, 400);
    expect(m.text('.save-bar .err')).toBe('Please fix the highlighted fields.');
    expect(m.text('.ferr')).toBe('taken');
    await m.click(button(m.el, 'Create offer'));
    await m.reply('POST', '/api/discounts', {}, 500);
    expect(m.text('.save-bar .err')).toBe('Could not save.');
  });

  it('client prices: chosen customers, sign-in locked, customers without accounts flagged', async () => {
    const m = await openNew({ customer: 'cu-bo' });
    expect(m.text('button.preset.on')).toContain('Client price');
    expect(m.text('.chips')).toContain('Bo');
    expect((m.el.querySelector('input[name=signin]') as HTMLInputElement).disabled).toBe(true);
    await m.type('input[name=name]', 'Bo price'); await m.type('input[name=label]', 'Your price');
    expect(preview(m)).toContain('Only for 1 chosen customer, when signed in. 1 has no account yet');
    await m.type('input[name=cq]', 'ann');
    await m.check('.picks input', true);
    expect(m.all('.chip').length).toBe(2);
    expect(preview(m)).toContain('Only for 2 chosen customers');
    await m.click(m.all('.chip button')[0]);
    expect(m.text('.chips')).toBe('Ann ✕');
    expect(m.cmp.customerName('ghost')).toBe('Unknown customer');
    expect(m.cmp.input().audience).toEqual({ type: 'customers', customerIds: ['cu-ann'] });
    expect(m.cmp.input().access).toEqual({ requiresSignIn: true });
    await m.click(button(m.el, 'Everyone'));
    expect((m.el.querySelector('input[name=signin]') as HTMLInputElement).disabled).toBe(false);
    await m.check('input[name=signin]', true);
    expect(preview(m)).toContain('Only for customers with an account, when signed in');
  });

  it('profile rules: chosen profiles, member count', async () => {
    const m = await openNew({ profile: 'pr-trade' });
    expect(m.text('button.preset.on')).toContain('Profile rule');
    await m.type('input[name=name]', 'Trade'); await m.type('input[name=label]', 'Trade');
    expect(preview(m)).toContain('For the 1 member of the chosen profile, when signed in');
    await m.check('.picks input', false);
    await m.click(button(m.el, 'Create offer'));
    expect(m.text('.ferr')).toBe('pick at least one');
    await m.click(button(m.el, 'Shop-wide sale', 'button.preset'));
    expect(m.cmp.f.audience).toBe('everyone');
    expect(m.cmp.f.requiresSignIn).toBe(false);
  });
});

describe('Offer editor: empty shop', () => {
  it('explains when there are no categories or profiles yet', async () => {
    const m = await mount(DiscountEditor);
    await m.reply('GET', '/api/categories', []);
    await m.reply('GET', '/api/customers', []);
    await m.reply('GET', '/api/discount-profiles', []);
    await m.reply('GET', '/api/settings', settings());
    await m.type('input[name=name]', 'X'); await m.type('input[name=label]', 'X');
    await pool(m, []);
    expect(preview(m)).toContain('No visible products match right now');
    await m.click(button(m.el, 'Categories'));
    expect(m.text('.picks')).toBe('No categories yet.');
    await m.click(button(m.el, 'Profiles'));
    expect(m.text()).toContain('No profiles yet. Create one.');
  });
});

describe('Offer editor: existing offers', () => {
  const voucher = () => offer({ name: 'Welcome', label: 'Welcome', trigger: 'code', scope: 'order', schedule: { start: '2026-06-01T00:00', end: '2026-07-01T00:00' }, limits: { totalUses: 10 } }, { id: 'v1', usedCount: 2, version: 3 });

  it('loads the offer, its codes, redemptions and history, and saves with the version', async () => {
    const m = await openExisting(voucher(), { codes: [{ id: 'WELCOME10', discountId: 'v1', kind: 'shared', usedCount: 2, createdAt: '2026-06-01T10:00:00Z' }, { id: 'ONE-1', discountId: 'v1', kind: 'single', usedCount: 0, createdAt: '2026-06-01T10:00:00Z' }], total: 3 });
    expect(m.text('h1')).toBe('Welcome');
    expect(m.text('header')).toContain('Used 2 times of 10');
    expect(m.cmp.f.endMode).toBe('day');
    expect(m.cmp.f.endDay).toBe('2026-06-30');
    expect(m.text()).toContain('WELCOME10');
    expect(m.text()).toContain('Single use');
    expect(m.text()).toContain('Released (cancelled)');
    expect(m.text()).toContain('update · Max');
    await m.click(button(m.el, 'Older changes'));
    await m.reply('GET', '/api/audit?entity=discount&id=v1&before=c1', { items: [{ id: 'a0', at: '2026-05-01T10:00:00Z', userId: 'system', userName: 'System', action: 'create', entity: 'discount', entityId: 'v1' }], next: null });
    expect(m.text()).toContain('create · System');
    expect([...m.el.querySelectorAll('button')].some((b) => b.textContent === 'Older changes')).toBe(false);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    await m.click(button(m.el, 'Download CSV', 'section:last-of-type button'));
    const csv = m.http.expectOne((r) => r.url === '/api/audit' && r.headers.get('Accept') === 'text/csv');
    expect(csv.request.params.get('entity')).toBe('discount');
    csv.flush(new Blob(['x']));
    await m.click(button(m.el, 'Show more'));
    await m.reply('GET', '/api/discounts/v1/codes?skip=2&limit=50', { items: [{ id: 'TWO-2', discountId: 'v1', kind: 'single', usedCount: 0, createdAt: '2026-06-01T10:00:00Z' }], total: 3 });
    expect(m.all('td.mono').map((t) => t.textContent)).toContain('TWO-2');
    await m.type('input[name=label]', 'Welcome back');
    await m.click(button(m.el, 'Save changes'));
    const req = await m.reply('PATCH', '/api/discounts/v1', { ...voucher(), label: 'Welcome back', version: 4 });
    expect(req.request.body.version).toBe(3);
    expect(req.request.body.schedule).toEqual({ start: '2026-06-01T00:00', end: '2026-07-01T00:00' });
    await m.reply('GET', '/api/discounts/v1/codes?skip=0&limit=50', { items: [], total: 0 });
    await m.reply('GET', '/api/discounts/v1/redemptions', { items: [], total: 0 });
    await m.reply('GET', '/api/audit?entity=discount&id=v1', { items: [], next: null });
    expect(m.text('[role=status]')).toBe('Saved.');
    expect(m.text()).toContain('Not used in any order yet');
    await m.click(button(m.el, 'Save changes'));
    await m.reply('PATCH', '/api/discounts/v1', {}, 409);
    expect(m.text('.save-bar .err')).toContain('Someone else changed this offer');
  });

  it('manages codes: add, refuse duplicates, generate, delete, download CSV', async () => {
    const m = await openExisting(voucher(), { codes: [{ id: 'OLD-1', discountId: 'v1', kind: 'single', usedCount: 0, createdAt: '2026-06-01T10:00:00Z' }] });
    await m.type('input[name=code]', 'summer');
    await m.click(button(m.el, 'Add', 'form button'));
    expect((await m.reply('POST', '/api/discounts/v1/codes', { created: 1, items: ['SUMMER'] })).request.body).toEqual({ code: 'summer' });
    await m.reply('GET', '/api/discounts/v1/codes?skip=0&limit=50', { items: [], total: 0 });
    expect((m.el.querySelector('input[name=code]') as HTMLInputElement).value).toBe('');
    expect(m.text()).toContain('No codes yet');
    await m.type('input[name=code]', 'WELCOME10');
    await m.click(button(m.el, 'Add', 'form button'));
    await m.reply('POST', '/api/discounts/v1/codes', { error: 'That code is already used by an offer.', fields: [{ field: 'code', message: 'already in use' }] }, 409);
    expect(m.text('.err[role=alert]')).toBe('already in use');
    await m.type('input[name=gen]', '5');
    await m.type('input[name=prefix]', 'news');
    await m.click(button(m.el, 'Generate single-use codes'));
    expect((await m.reply('POST', '/api/discounts/v1/codes', { created: 5, items: [] })).request.body).toEqual({ generate: 5, prefix: 'news' });
    await m.reply('GET', '/api/discounts/v1/codes?skip=0&limit=50', { items: [{ id: 'NEWS-1', discountId: 'v1', kind: 'single', usedCount: 0, createdAt: '' }], total: 1 });
    await m.click(button(m.el, 'Delete', 'tbody button'));
    await m.reply('DELETE', '/api/discounts/v1/codes/NEWS-1', {}, 409);
    expect(m.text('.err[role=alert]')).toBe('Could not add the code.');
    const dl = vi.spyOn((m.cmp as unknown as { api: { downloadCsv: (...a: unknown[]) => unknown } }).api, 'downloadCsv').mockReturnValue({ subscribe: () => undefined } as never);
    await m.click(button(m.el, 'Download CSV'));
    expect(dl).toHaveBeenCalledWith('/api/discounts/v1/codes', 'codes-Welcome.csv');
    m.cmp.downloadRedemptions();
    expect(dl).toHaveBeenLastCalledWith('/api/discounts/v1/redemptions', 'redemptions-Welcome.csv');
  });

  it('pauses, resumes, duplicates, archives and deletes', async () => {
    const d = offer({ name: 'Sale', schedule: { start: '2026-06-01T00:00', end: '2026-06-20T18:00' } }, { id: 's1' });
    const m = await openExisting(d);
    const nav = vi.spyOn(m.router, 'navigate').mockResolvedValue(true);
    expect(m.cmp.f.endMode).toBe('exact');
    const reload = async (x: DiscountView) => {
      await m.reply('GET', `/api/discounts/${x.id}/redemptions`, { items: [], total: 0 });
      await m.reply('GET', `/api/audit?entity=discount&id=${x.id}`, { items: [], next: null });
    };
    await m.click(button(m.el, 'Pause', 'header button'));
    await m.reply('POST', '/api/discounts/s1/pause', { ...d, status: 'paused', state: 'paused' });
    await reload(d);
    await m.click(button(m.el, 'Resume', 'header button'));
    await m.reply('POST', '/api/discounts/s1/resume', d);
    await reload(d);
    await m.click(button(m.el, 'Archive', 'header button'));
    expect(m.text('header')).toContain('Click to confirm');
    await m.click(button(m.el, 'Click to confirm', 'header button'));
    await m.reply('POST', '/api/discounts/s1/archive', { ...d, status: 'archived', state: 'archived' });
    await reload(d);
    await m.click(button(m.el, 'Duplicate', 'header button'));
    await m.reply('POST', '/api/discounts/s1/duplicate', { id: 'copy' });
    expect(nav).toHaveBeenCalledWith(['/discounts', 'copy']);
    await m.click(button(m.el, 'Delete', 'header button'));
    await m.click(button(m.el, 'Click to confirm', 'header button'));
    await m.reply('DELETE', '/api/discounts/s1', { error: 'This offer has been used in orders, so it can\'t be deleted. Archive it instead.' }, 409);
    expect(m.text('.save-bar .err')).toContain('Archive it instead');
    await m.click(button(m.el, 'Delete', 'header button'));
    await m.click(button(m.el, 'Click to confirm', 'header button'));
    await m.reply('DELETE', '/api/discounts/s1', null);
    expect(nav).toHaveBeenCalledWith(['/discounts']);
  });

  it('loads a client offer with its customers', async () => {
    const client = offer({ name: 'Ann', audience: { type: 'customers', customerIds: ['cu-ann'] } }, { id: 'c1' });
    const m = await openExisting(client);
    expect(m.text('button.preset.on')).toContain('Client price');
    expect(m.text('.chips')).toContain('Ann');
  });

  it('loads a profile offer with its profiles and products', async () => {
    const prof = offer({ name: 'Trade', audience: { type: 'profiles', profileIds: ['pr-trade'] }, target: { type: 'products', productIds: ['p-mug'] } }, { id: 'p1' });
    const m = await openExisting(prof);
    expect(m.text('button.preset.on')).toContain('Profile rule');
    expect(m.cmp.f.productIds).toEqual(['p-mug']);
    expect(m.cmp.f.profileIds).toEqual(['pr-trade']);
  });

  it('opens a product offer for a product (?product=), e.g. "Create an offer for this bundle"', async () => {
    const m = await openNew({ product: 'p-mug' });
    expect(m.text('button.preset.on')).toContain('Product price');
    expect(m.cmp.f.target).toBe('products');
    expect(m.cmp.f.productIds).toEqual(['p-mug']);
    await m.reply('GET', /^\/api\/products\?.*ids=p-mug/, page([summaries[0]]));
    expect(m.text('.picker .chips')).toContain('Linen Mug');
  });
  it('ignores a malformed ?product=', async () => {
    const m = await openNew({ product: 'bad id!' });
    expect(m.cmp.f.productIds).toEqual([]);
    expect(m.cmp.f.target).toBe('all');
  });

  it('goes back to the list when the offer does not exist', async () => {
    const m = await mount(DiscountEditor, { inputs: { id: 'ghost' } });
    const nav = vi.spyOn(m.router, 'navigate').mockResolvedValue(true);
    await m.replyAll('GET', /\/api\/(products|categories|customers|discount-profiles)$/, []);
    await m.reply('GET', '/api/settings', settings());
    await m.reply('GET', '/api/discounts/ghost', {}, 404);
    expect(nav).toHaveBeenCalledWith(['/discounts']);
  });
});

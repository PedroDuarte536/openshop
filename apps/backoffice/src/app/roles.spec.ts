// Existing screens adapt to the member's permissions: controls they can't use are hidden, and screens don't ask the
// API for data the member may not see (which would be refused and logged). Personas follow docs/iam-plan-v2.md §2.4.
import { TestBed } from '@angular/core/testing';
import { TEMPLATES } from '@openshop/iam';
import { Products } from './products/list';
import { Categories } from './categories';
import { Orders } from './orders';
import { Discounts } from './discounts/list';
import { DiscountEditor } from './discounts/editor';
import { Simulator } from './discounts/simulator';
import { Profiles } from './discounts/profiles';
import { ProfilePage } from './discounts/profile';
import { Customers } from './customers/list';
import { CustomerPage } from './customers/detail';
import { SettingsPage } from './settings';
import { mount, button } from './testing/harness';
import { categories, customerDetail, customers, facets, meFor, offer, order, page, products, profile, settings } from './testing/fixtures';

const persona = (...templates: string[]) => meFor(templates.flatMap((t) => TEMPLATES.find((x) => x.id === t)!.permissions));
const pat = persona('fulfilment'), max = persona('promotions'), suki = persona('customer-support'), finn = persona('finance'), vera = persona('read-only');

describe('Products and categories by role', () => {
  // The product list asks the search API; `list` is what it answers.
  const list = (items = products) => page(items, { total: items.length, facets: facets() });
  it('fulfilment staff only update stock', async () => {
    const m = await mount(Products, { me: pat });
    await m.reply('GET', '/api/categories', categories);
    await m.reply('GET', /^\/api\/products\?/, list());
    expect(m.text()).not.toContain('+ New product');
    expect(m.el.querySelector('a[href="/products/import"]')).toBeNull();
    expect(m.all('tbody input[type=checkbox]').length).toBe(0);
    expect(m.all('tbody button').map((b) => b.textContent!.trim())).toEqual(['Update stock', 'Update stock', 'Update stock', 'Update stock']);
    await m.click(button(m.el, 'Update stock'));
    await m.type('.stock-edit input', '7');
    await m.click(button(m.el, 'Save', '.stock-edit button'));
    const r = await m.reply('PATCH', '/api/products/p-mug', { error: 'nope' }, 403);
    expect(r.request.body).toEqual({ stock: 7 });
    await m.click(button(m.el, 'Save', '.stock-edit button'));
    await m.reply('PATCH', '/api/products/p-mug', { ...products[0], stock: 7 });
    await m.reply('GET', /^\/api\/products\?/, list());
    expect(m.el.querySelector('.stock-edit')).toBeNull();
    await m.click(button(m.el, 'Update stock'));
    await m.click('.stock-edit .ghost');
    expect(m.el.querySelector('.stock-edit')).toBeNull();
  });
  it('read-only members see the catalogue without any edit control', async () => {
    const m = await mount(Products, { me: vera });
    await m.reply('GET', '/api/categories', categories);
    await m.reply('GET', /^\/api\/products\?/, list([]));
    expect(m.text()).toContain('No products yet');
    expect(m.text()).not.toContain('+ New product');
    expect(m.el.querySelector('a[href="/products/import"]')).toBeNull();
    TestBed.resetTestingModule();
    const rows = await mount(Products, { me: vera });
    await rows.reply('GET', '/api/categories', categories);
    await rows.reply('GET', /^\/api\/products\?/, list());
    expect(rows.all('tbody button').length).toBe(0);
    expect(rows.all('tbody a.danger').length).toBe(0);
    expect(rows.all('tbody input[type=checkbox]').length).toBe(0);
    TestBed.resetTestingModule();
    const c = await mount(Categories, { me: vera });
    await c.reply('GET', '/api/categories', categories);
    await c.reply('GET', /^\/api\/products\?limit=0$/, page([], { total: 4, facets: facets() }));
    expect(c.el.querySelector('form')).toBeNull();
    expect(c.text()).not.toContain('Delete');
  });
});

describe('Order status by role', () => {
  const orders = [order({ id: 'o1', status: 'pending' }), order({ id: 'o2', status: 'cancelled', discounts: [] })];
  const options = (m: Awaited<ReturnType<typeof mount>>, i: number) => m.all(`tbody tr:nth-child(${i}) option`).map((o) => o.textContent);
  it('fulfilment can ship; finance can mark paid; support can cancel; reopening needs cancel and payments; read-only sees pills', async () => {
    const expectations: [ReturnType<typeof meFor>, (string | null)[], (string | null)[]][] = [
      [pat, ['Pending', 'Shipped'], []], [finn, ['Pending', 'Paid'], []], [suki, ['Pending', 'Cancelled'], []], [vera, [], []],
      [meFor('sudo'), ['Pending', 'Paid', 'Shipped', 'Cancelled'], ['Pending', 'Paid', 'Shipped', 'Cancelled']],
      [persona('customer-support', 'finance'), ['Pending', 'Paid', 'Cancelled'], ['Pending', 'Paid', 'Cancelled']],
    ];
    for (const [me, first, second] of expectations) {
      const m = await mount(Orders, { me });
      await m.reply('GET', '/api/orders', orders);
      expect(options(m, 1), me.permissions.join()).toEqual(first);
      expect(options(m, 2), me.permissions.join()).toEqual(second);
      if (!first.length) expect(m.text('tbody tr:nth-child(1) .static')).toBe('Pending');
      TestBed.resetTestingModule();
    }
  });
});

describe('Discounts by role', () => {
  it('the list is read-only without "Create and change offers"', async () => {
    const m = await mount(Discounts, { me: finn });
    await m.replyAll('GET', '/api/settings', settings());
    await m.replyAll('GET', '/api/products', products);
    await m.replyAll('GET', '/api/categories', categories);
    await m.replyAll('GET', '/api/discounts', [offer({ name: 'Summer' })]);
    expect(m.text('header')).not.toContain('+ New offer');
    expect(m.all('tbody .acts a').map((a) => a.textContent)).toEqual(['View']);
  });
  it('the editor is read-only for finance: no customer list, no codes, but redemptions', async () => {
    const m = await mount(DiscountEditor, { me: finn, inputs: { id: 'd-v' } });
    await m.replyAll('GET', '/api/products', products);
    await m.replyAll('GET', '/api/categories', categories);
    m.http.expectNone('/api/customers');
    await m.reply('GET', '/api/discount-profiles', [profile()]);
    await m.reply('GET', '/api/settings', settings());
    await m.reply('GET', '/api/discounts/d-v', offer({ name: 'Codes', trigger: 'code', audience: { type: 'customers', customerIds: ['cu-ann'] }, access: { requiresSignIn: true } }, { id: 'd-v' }));
    m.http.expectNone((r) => r.url.includes('/codes'));
    await m.reply('GET', '/api/discounts/d-v/redemptions', { items: [], total: 0 });
    await m.reply('GET', '/api/audit?entity=discount&id=d-v', { items: [], next: null });
    expect(m.text()).toContain('Read-only');
    expect((m.el.querySelector('fieldset.plain') as HTMLFieldSetElement).disabled).toBe(true);
    expect(m.el.querySelector('.save-bar')).toBeNull();
    expect(m.text('header')).not.toContain('Duplicate');
    expect(m.text()).toContain('Voucher codes are worth money');
    expect(m.text('.chips')).toContain('A customer');
  });
  it('promotions can edit offers and codes but not pick customers, and sees no redemptions', async () => {
    const m = await mount(DiscountEditor, { me: max, inputs: { id: 'd-v' } });
    await m.replyAll('GET', '/api/products', products);
    await m.replyAll('GET', '/api/categories', categories);
    m.http.expectNone('/api/customers');
    await m.reply('GET', '/api/discount-profiles', [profile()]);
    await m.reply('GET', '/api/settings', settings());
    await m.reply('GET', '/api/discounts/d-v', offer({ name: 'Codes', trigger: 'code' }, { id: 'd-v' }));
    await m.reply('GET', '/api/discounts/d-v/codes?skip=0&limit=50', { items: [], total: 0 });
    m.http.expectNone('/api/discounts/d-v/redemptions');
    await m.reply('GET', '/api/audit?entity=discount&id=d-v', { items: [], next: null });
    expect(m.el.querySelector('.save-bar')).not.toBeNull();
    expect((button(m.el, 'Specific customers') as HTMLButtonElement).disabled).toBe(true);
    expect((button(m.el, 'Client price', '.preset') as HTMLButtonElement).disabled).toBe(true);
    expect(m.text()).toContain('Needs “See customers and their details”');
    expect(m.text()).not.toContain('Redemptions');
  });
  it('the simulator offers a signed-in customer only with "See customers"', async () => {
    const m = await mount(Simulator, { me: max });
    await m.replyAll('GET', '/api/products', products);
    await m.reply('GET', '/api/settings', settings());
    m.http.expectNone('/api/customers');
    expect(m.el.querySelector('select[name=cust]')).toBeNull();
    TestBed.resetTestingModule();
    const v = await mount(Simulator, { me: vera });
    await v.replyAll('GET', '/api/products', products);
    await v.reply('GET', '/api/settings', settings());
    await v.reply('GET', '/api/customers', customers);
    expect(v.el.querySelector('select[name=cust]')).not.toBeNull();
  });
  it('profiles: read-only without manage; member names need "See customers"', async () => {
    const l = await mount(Profiles, { me: finn });
    await l.reply('GET', '/api/discount-profiles', [profile()]);
    expect(l.el.querySelector('form')).toBeNull();
    TestBed.resetTestingModule();
    const m = await mount(ProfilePage, { me: max, inputs: { id: 'pr-trade' } });
    m.http.expectNone('/api/customers');
    await m.reply('GET', '/api/discount-profiles/pr-trade', profile());
    m.http.expectNone('/api/discount-profiles/pr-trade/members');
    expect(m.text()).toContain('Names need “See customers and their details”');
    expect(m.el.querySelector('.save-bar')).not.toBeNull();
    TestBed.resetTestingModule();
    const v = await mount(ProfilePage, { me: vera, inputs: { id: 'pr-trade' } });
    await v.reply('GET', '/api/discount-profiles/pr-trade', profile());
    await v.reply('GET', '/api/discount-profiles/pr-trade/members', { items: [{ customerId: 'cu-ann', email: 'ann@x.io', name: 'Ann', activated: true, validUntil: null, addedAt: 'x' }], total: 1 });
    expect(v.text()).toContain('Ann');
    expect(v.el.querySelector('.save-bar')).toBeNull();
    expect(v.el.querySelector('.danger-zone')).toBeNull();
    expect(v.text('tbody')).not.toContain('Remove');
    expect(v.text()).not.toContain('Add member');
  });
});

describe('Customers by role', () => {
  it('support: account links, no deletion, no offers or codes (and no request for them)', async () => {
    const m = await mount(CustomerPage, { me: suki, inputs: { id: 'cu-ann' } });
    m.http.expectNone('/api/discounts');
    m.http.expectNone('/api/discount-profiles');
    await m.reply('GET', '/api/customers/cu-ann', customerDetail());
    expect(m.text()).toContain('Create password reset link');
    expect(m.el.querySelector('.danger-zone')).toBeNull();
    expect(m.el.querySelector('select[name=voucher]')).toBeNull();
    expect(m.el.querySelector('select[name=prof]')).toBeNull();
    expect(m.text()).not.toContain('+ New client price');
    expect(m.text('.row-line')).not.toContain('Remove');
  });
  it('read-only: no new customer, no account buttons', async () => {
    const l = await mount(Customers, { me: vera });
    await l.reply('GET', '/api/customers', customers);
    expect(l.text('header')).not.toContain('+ New customer');
    TestBed.resetTestingModule();
    const m = await mount(CustomerPage, { me: vera, inputs: { id: 'cu-ann' } });
    await m.reply('GET', '/api/discount-profiles', [profile()]);
    await m.reply('GET', '/api/discounts', []);
    await m.reply('GET', '/api/customers/cu-ann', customerDetail());
    expect(m.text()).not.toContain('Create password reset link');
  });
});

describe('Settings by role', () => {
  it('only the owner sees the Security section', async () => {
    const m = await mount(SettingsPage, { me: persona('shop-manager') });
    await m.reply('GET', '/api/settings', settings());
    expect(m.el.querySelector('app-security-settings')).toBeNull();
    m.http.expectNone('/api/security-settings');
    TestBed.resetTestingModule();
    const o = await mount(SettingsPage);
    await o.reply('GET', '/api/settings', settings());
    await o.reply('GET', '/api/security-settings', { passwordPolicy: { staff: { minLength: 12, requireClasses: 0, disallowEmail: true, blockCommon: false }, customers: { minLength: 10, requireClasses: 0, disallowEmail: false, blockCommon: false } }, enforceStaffPolicyAtSignIn: false, activityRetentionDays: 180, version: 1, updatedAt: null, bounds: { minLength: { min: 8, max: 64 }, retention: [30, 90, 180, 365] } });
    expect(o.text()).toContain('Security');
  });
});

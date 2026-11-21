import { price, type Discount } from '@openshop/pricing';
import { Simulator } from './simulator';
import { mount, button } from '../testing/harness';
import { customers, offer, page, settings, summaries } from '../testing/fixtures';

describe('Simulator', () => {
  async function setup() {
    const m = await mount(Simulator);
    await m.reply('GET', /^\/api\/products\?.*limit=1/, page([summaries[0]]));
    await m.reply('GET', '/api/settings', settings());
    await m.reply('GET', '/api/customers', customers);
    return m;
  }
  it('prices a cart for a signed-in customer at a chosen moment and explains every offer', async () => {
    const m = await setup();
    expect(m.all('.sim-row').map((r) => r.textContent!.trim())).toEqual([expect.stringContaining('Linen Mug €24.00') as unknown as string]);
    expect(m.all('select[name=cust] option').map((o) => o.textContent)).toEqual(['A guest', 'Ann (ann@x.io)']);
    // Items are added with the product search (server-side, so any catalogue size works).
    await m.type('app-product-picker input', 'vase');
    await new Promise((r) => setTimeout(r, 300));
    const search = await m.reply('GET', /^\/api\/products\?.*q=vase/, page([summaries[1]]));
    expect(search.request.params.get('status')).toBe('visible');
    await m.click('.pick-row');
    expect(m.all('.sim-row').length).toBe(2);
    expect(m.all('.sim-row')[1].textContent).toContain('Bud Vase');
    await m.click(m.all('.sim-row button')[1]);
    expect(m.all('.sim-row').length).toBe(1);
    await m.select('select[name=cust]', 'cu-ann');
    await m.type('input[name=code]', 'MARTA10');
    await m.type('input[name=at]', '2026-12-01T10:00');
    await m.select('select[name=scenario]', 'code');
    await m.click(button(m.el, 'Simulate'));
    const d = offer({ name: 'Sale', label: 'Sale' }, { id: 'd1' }) as unknown as Discount;
    const r = price({ now: Date.now(), lines: [{ productId: 'p-mug', categoryId: 'c-mugs', listCents: 2400, qty: 1, name: 'Linen Mug' }], shopper: { identityId: null, customerId: null, signedIn: false, profileIds: [] }, discounts: [d, { ...d, id: 'd2', name: 'Later', startsAt: '2099-01-01T00:00:00.000Z' }] });
    const req = await m.reply('POST', '/api/discounts/simulate', { at: '2026-12-01T10:00:00.000Z', atLocal: '2026-12-01T10:00', timezone: 'Europe/Lisbon', result: r });
    expect(req.request.body).toEqual({ items: [{ productId: 'p-mug', qty: 1 }], email: null, customerId: 'cu-ann', codes: ['MARTA10'], at: '2026-12-01T10:00', selection: { scenario: 'code' } });
    expect(m.text('aside')).toContain('Total €21.60');
    expect(m.text('aside')).toContain('1 Dec 2026, 10:00');
    expect(m.text('aside')).toContain('Applied');
    expect(m.text('aside')).toContain('Not started yet');
  });
  it('shows scenarios, save-for-later choices and errors', async () => {
    const m = await setup();
    await m.type('input[name=email]', 'a@x.io');
    await m.click(button(m.el, 'Simulate'));
    const base = { lines: [], subtotalCents: 0, discountCents: 0, totalCents: 0, applied: [{ discountId: 'x', label: 'Code', source: 'code', scope: 'order', cents: 100, pending: true, endsAt: null, code: 'X1' }], rejectedCodes: [], pending: true, quote: 'q', diagnostics: [{ discountId: 'x', name: 'X', reason: 'bogus' }],
      scenarios: [{ key: 'automatic', title: 'Automatic offers', totalCents: 900, savingsCents: 100, best: true, selected: false, appliedIds: [] }, { key: 'code', title: 'Code X1', totalCents: 950, savingsCents: 50, best: false, selected: true, appliedIds: [] }],
      choices: [{ discountId: 'b', label: 'Budget', source: 'shop', declined: false, totalIfToggled: 1000, currentTotal: 900 }] };
    const req = await m.reply('POST', '/api/discounts/simulate', { at: '', atLocal: '2026-06-15T13:00', timezone: 'UTC', result: base });
    expect(req.request.body.email).toBe('a@x.io');
    expect(m.text('aside')).toContain('(code X1) · checked at checkout');
    expect(m.text('aside')).toContain('Option “Automatic offers”: €9.00 (best)');
    expect(m.text('aside')).toContain('← selected');
    expect(m.text('aside')).toContain('Budget can be saved for later: total would be €10.00');
    expect(m.text('aside')).toContain('bogus');
    await m.click(button(m.el, 'Simulate'));
    await m.reply('POST', '/api/discounts/simulate', { fields: [{ field: 'at', message: 'must be a date' }] }, 400);
    expect(m.text('[role=alert]')).toBe('must be a date');
    await m.click(button(m.el, 'Simulate'));
    await m.reply('POST', '/api/discounts/simulate', {}, 500);
    expect(m.text('[role=alert]')).toBe('Could not simulate.');
  });
});

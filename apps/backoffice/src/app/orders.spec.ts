import { Orders } from './orders';
import { mount } from './testing/harness';
import { order } from './testing/fixtures';

describe('Orders page', () => {
  it('lists orders with what each one saved, and changes status', async () => {
    const m = await mount(Orders);
    await m.reply('GET', '/api/orders', [order(), order({ id: 'o2', total: 10, discounts: [], discountTotal: 0, subtotal: 10, lines: [{ name: 'Cup', qty: 1, price: 10 }] })]);
    expect(m.text('header')).toContain('2 orders so far');
    const rows = m.all('tbody tr');
    expect(rows[0].textContent).toContain('−€5.00 Welcome');
    expect(rows[0].textContent).toContain('WELCOME5');
    expect(rows[0].textContent).toContain('€100.00');
    expect(rows[1].textContent).toContain('—');
    await m.select('tbody tr:nth-child(1) select', 'paid');
    const req = await m.reply('PATCH', '/api/orders/o1', order({ status: 'paid' }));
    expect(req.request.body).toEqual({ status: 'paid' });
    await m.reply('GET', '/api/orders', [order({ status: 'paid' })]);
    expect(m.text('header')).toContain('1 order so far');
  });
  it('shows what was inside each bundle, for packing', async () => {
    const m = await mount(Orders);
    await m.reply('GET', '/api/orders', [order({ lines: [{ name: 'Breakfast set', qty: 2, price: 59, bundle: { components: [{ productId: 'p1', sku: 'MUG', name: 'Linen Mug', qty: 2, allocatedCents: 3000 }, { productId: 'p2', name: 'Dune Plate', qty: 1, allocatedCents: 2900 }] } }] })]);
    expect(m.text('.includes')).toBe('4 × Linen Mug MUG2 × Dune Plate');
  });

  it('explains why a status change was refused', async () => {
    const m = await mount(Orders);
    await m.reply('GET', '/api/orders', [order({ status: 'cancelled' })]);
    await m.select('tbody select', 'pending');
    await m.reply('PATCH', '/api/orders/o1', { error: "This order used offers and was cancelled, so it can't be reopened." }, 409);
    expect(m.text('[role=alert]')).toContain("can't be reopened");
    await m.reply('GET', '/api/orders', [order({ status: 'cancelled' })]);
    await m.select('tbody select', 'paid');
    await m.reply('PATCH', '/api/orders/o1', {}, 500);
    expect(m.text('[role=alert]')).toBe('Could not change the status.');
  });
  it('shows an empty state', async () => {
    const m = await mount(Orders);
    await m.reply('GET', '/api/orders', []);
    expect(m.text()).toContain('No orders yet');
  });
});

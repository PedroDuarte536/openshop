import { ProductDelete } from './delete';
import { mount, button } from '../testing/harness';
import { products } from '../testing/fixtures';

const hidden = { ...products[3], id: 'p-1', name: 'Linen Mug', active: false };
const impact = {
  bundles: [{ id: 'b1', name: 'Breakfast set', active: true, priceMode: 'sum' }, { id: 'b2', name: 'Gift set', active: false, priceMode: 'manual' }],
  variantGroup: { id: 'mugs', name: 'Linen mugs', valuesLost: [{ property: 'Colour', value: 'Sand' }] },
  offers: [{ id: 'd1', name: 'Mug deal', state: 'running' }], openOrders: 2,
};

describe('Delete product page', () => {
  it('asks for a decision per bundle, explains the effects, then deletes (softly)', async () => {
    const m = await mount(ProductDelete, { inputs: { id: 'p-1' } });
    const nav = vi.spyOn(m.router, 'navigate').mockResolvedValue(true);
    await m.reply('GET', '/api/products/p-1', hidden);
    await m.reply('GET', '/api/products/p-1/delete-impact', impact);
    expect(m.text('h1')).toBe('Delete Linen Mug?');
    expect(m.text('[role=alert]')).toContain('Choose what happens to each bundle');
    expect(m.text()).toContain('The value Sand will no longer be shown for Colour');
    expect(m.text()).toContain('Mug deal');
    expect(m.text()).toContain('2 unshipped orders contain this product');
    const del = button(m.el, 'Delete product') as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    expect(m.text('.save-bar')).toContain('Choose for 2 more bundles');
    await m.check('input[name=b_b1]', true);
    expect(m.text('.save-bar')).toContain('Choose for 1 more bundle');
    const hide = m.all('input[name=b_b2]')[1] as HTMLInputElement;
    await m.click(hide);
    expect(del.disabled).toBe(false);
    await m.click(del);
    const req = await m.reply('DELETE', '/api/products/p-1', null);
    expect(req.request.body).toEqual({ bundles: { b1: 'keep', b2: 'hide' } });
    expect(nav).toHaveBeenCalledWith(['/products']);
  });

  it('asks to hide a visible product first; reports errors; handles deleted and missing products', async () => {
    const m = await mount(ProductDelete, { inputs: { id: 'p-mug' } });
    await m.reply('GET', '/api/products/p-mug', products[0]);
    expect(m.text('.warn-box')).toContain('Hide it first');
    await m.click(button(m.el, 'Hide it from the shop'));
    expect((await m.reply('PATCH', '/api/products/p-mug', {})).request.body).toEqual({ active: false });
    await m.reply('GET', '/api/products/p-mug', { ...products[0], active: false });
    await m.reply('GET', '/api/products/p-mug/delete-impact', { bundles: [], variantGroup: null, offers: [], openOrders: 0 });
    expect(m.text()).toContain('Nothing else uses this product');
    await m.click(button(m.el, 'Delete product'));
    await m.reply('DELETE', '/api/products/p-mug', { error: 'Hide this product from the shop before deleting it.' }, 409);
    expect(m.text('[role=alert]')).toBe('Hide this product from the shop before deleting it.');
  });

  it('shows deleted products as such', async () => {
    const m = await mount(ProductDelete, { inputs: { id: 'gone' } });
    await m.reply('GET', '/api/products/gone', { ...hidden, deletedAt: '2026-01-01T00:00:00Z' });
    expect(m.text()).toContain('already deleted');
  });
  it('reports a missing product', async () => {
    const m = await mount(ProductDelete, { inputs: { id: 'missing' } });
    await m.reply('GET', '/api/products/missing', {}, 404);
    expect(m.text('[role=alert]')).toBe('This product could not be found.');
  });
});

import { ProductPicker } from './product-picker';
import { mount } from '../testing/harness';
import { page, summaries } from '../testing/fixtures';

describe('Product picker', () => {
  it('searches on the server, shows chosen products (also deleted ones) and adds all variants of a product', async () => {
    const m = await mount(ProductPicker, { inputs: { selected: ['p-old'] } });
    await m.reply('GET', /^\/api\/products\?.*ids=p-old/, page([{ ...summaries[0], id: 'p-old', name: 'Old mug', deleted: true }]));
    expect(m.text('.chip')).toContain('Old mug(deleted)');
    await m.type('input[type=search]', 'mug');
    await new Promise((r) => setTimeout(r, 300));
    const search = await m.reply('GET', /^\/api\/products\?/, page([{ ...summaries[0], variantGroupId: 'mugs' }], { total: 25 }));
    expect(search.request.params.get('q')).toBe('mug');
    expect(m.text('.pick-results')).toContain('24 more: type more of the name or SKU');
    await m.click('button[aria-label="Add all variants of Linen Mug"]');
    const group = await m.reply('GET', /^\/api\/products\?.*variantGroup=mugs/, page([summaries[0], { ...summaries[1], id: 'p-mug-2', name: 'Linen Mug Blue' }]));
    expect(group.request.params.get('limit')).toBe('100');
    expect(m.cmp.selected()).toEqual(['p-old', 'p-mug', 'p-mug-2']);
    await m.click('.chip button');
    expect(m.cmp.selected()).toEqual(['p-mug', 'p-mug-2']);
  });
});

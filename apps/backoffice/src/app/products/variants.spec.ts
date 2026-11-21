import { VariantDialog } from './variant-dialog';
import { VariantsPanel } from './variants-panel';
import { mount, button } from '../testing/harness';
import { page, summaries } from '../testing/fixtures';
import type { VariantGroupView, VariantSuggestion } from '../api.service';

const products = [{ id: 'p1', name: 'Product 1', active: true, inGroup: null }, { id: 'p2', name: 'Product 2', active: true, inGroup: null }, { id: 'p8', name: 'Product 8', active: true, inGroup: null }];
const props: VariantSuggestion['properties'] = [
  { key: 'color', label: 'Colors', type: 'text', visibility: 'public', usable: true, varies: true, values: { p1: 'White', p2: 'Black', p8: 'White' } },
  { key: 'code', label: 'Code', type: 'text', visibility: 'internal', usable: true, varies: true, values: { p1: 'A', p2: 'B', p8: 'C' } },
  { key: 'tags', label: 'Tags', type: 'multi', visibility: 'public', usable: false, varies: true, values: { p1: 'x', p2: 'y', p8: 'z' } },
  { key: 'brand', label: 'Brand', type: 'text', visibility: 'public', usable: true, varies: false, values: { p1: 'Dune', p2: 'Dune', p8: 'Dune' } },
];
const dup = { productId: 'p8', name: 'Product 8', withProductId: 'p1', withName: 'Product 1', values: 'White', message: 'Product 8 has the same Colors as Product 1 (White).' };
const group = (over: Partial<VariantGroupView> = {}): VariantGroupView => ({
  id: 'jacket', name: 'Jacket', version: 3, differentiators: [{ key: 'color', label: 'Colors', type: 'text', visibility: 'public' }, { key: 'size', label: 'Size', type: 'number', visibility: 'public' }],
  members: [
    { id: 'p1', name: 'Product 1', sku: null, price: 50, active: true, deleted: false, position: 0, available: 4, values: { color: 'White', size: '10' } },
    { id: 'p2', name: 'Product 2', sku: null, price: 50, active: false, deleted: false, position: 1, available: 0, values: { color: 'Black', size: '10' } },
  ],
  warnings: { duplicates: [], useless: ['Size'], unreachable: [] }, ...over,
});

describe('Link as variants', () => {
  it('ticks the properties that differ, previews the shop, and refuses duplicates with an alert', async () => {
    const m = await mount(VariantDialog, { inputs: { productIds: ['p1', 'p2', 'p8'] } });
    const first = await m.reply('POST', '/api/variant-groups/suggest', { products, properties: props, preview: null });
    expect(first.request.body).toEqual({ productIds: ['p1', 'p2', 'p8'] });
    const second = await m.reply('POST', '/api/variant-groups/suggest', { products, properties: props, preview: { duplicates: [dup], useless: [], unreachable: [], selector: [{ key: 'color', label: 'Colors', badges: [{ label: 'White', state: 'selected' }, { label: 'Black', state: 'link', productId: 'p2' }] }] } });
    expect(second.request.body.differentiators).toEqual([{ key: 'color' }, { key: 'code' }]);
    expect(m.text('[role=alert]')).toContain('Product 8 has the same Colors as Product 1 (White). It can\'t be added');
    expect((button(m.el, 'Link 3 products') as HTMLButtonElement).disabled).toBe(true);
    expect(m.text()).toContain('holds several values per product');
    expect(m.text('.vpreview')).toContain('ColorsWhiteBlack');
    expect(m.all('tr.dup').length).toBe(2);
    // Leave out Product 8; untick the internal Code.
    await m.click(m.all('.chip button')[2]);
    await m.reply('POST', '/api/variant-groups/suggest', { products: products.slice(0, 2), properties: props, preview: { duplicates: [], useless: [], unreachable: [], selector: [] } });
    expect(m.text('.warn-box')).toContain('Make Code public');
    expect((button(m.el, 'Link 2 products') as HTMLButtonElement).disabled).toBe(true);
    await m.check('input[name=makePublic]', true);
    expect((button(m.el, 'Link 2 products') as HTMLButtonElement).disabled).toBe(false);
    await m.type('input[name=gname]', 'Jacket');
    await m.click(button(m.el, 'Link 2 products'));
    const save = await m.reply('POST', '/api/variant-groups', { error: 'Product 2 changed at the same time. Please try again.' }, 409);
    expect(save.request.body).toEqual({ name: 'Jacket', productIds: ['p1', 'p2'], differentiators: [{ key: 'color' }, { key: 'code' }], makePublic: true });
    expect(m.text('[role=alert]')).toContain('changed at the same time');
    const saved = vi.fn(); m.cmp.saved.subscribe(saved);
    await m.click(button(m.el, 'Link 2 products'));
    await m.reply('POST', '/api/variant-groups', group());
    expect(saved).toHaveBeenCalled();
  });

  it('changes the properties of an existing group', async () => {
    const m = await mount(VariantDialog, { inputs: { groupId: 'jacket', groupVersion: 3, current: [{ key: 'color' }] } });
    const r = await m.reply('POST', '/api/variant-groups/suggest', { products, properties: props, preview: { duplicates: [], useless: [], unreachable: [], selector: [] } });
    expect(r.request.body).toEqual({ productIds: [], differentiators: [{ key: 'color' }], groupId: 'jacket' });
    expect(m.text('h2')).toBe('Properties that tell the variants apart');
    await m.click(m.all('input[type=checkbox]')[3]);
    await m.reply('POST', '/api/variant-groups/suggest', { products, properties: props, preview: { duplicates: [], useless: ['Brand'], unreachable: [{ id: 'p8', name: 'Product 8' }], selector: [] } });
    expect(m.text()).toContain('Brand has the same value on every product');
    expect(m.text()).toContain('Product 8 can\'t be reached');
    await m.click(button(m.el, 'Save properties'));
    expect((await m.reply('PATCH', '/api/variant-groups/jacket', group())).request.body).toEqual({ version: 3, differentiators: [{ key: 'color' }, { key: 'brand' }], makePublic: false });
  });
});

describe('Variants panel', () => {
  it('lists the group, reorders, removes, adds products, and adds a variant (never a duplicate)', async () => {
    const m = await mount(VariantsPanel, { inputs: { groupId: 'jacket', productId: 'p1' } });
    await m.reply('GET', '/api/variant-groups/jacket', group());
    expect(m.text('.sec-row')).toContain('Told apart by Colors, Size');
    expect(m.text('.warn-box')).toContain('Size: the same value on every visible product');
    expect(m.text('tbody tr:nth-child(1)')).toContain('(this product)');
    expect(m.text('tbody tr:nth-child(2)')).toContain('hidden');
    await m.click('button[aria-label="Move Product 2 up"]');
    expect((await m.reply('PATCH', '/api/variant-groups/jacket', group({ version: 4 }))).request.body).toEqual({ version: 3, order: ['p2', 'p1'] });
    await m.click('button[aria-label="Remove Product 2 from the group"]');
    expect((await m.reply('PATCH', '/api/variant-groups/jacket', { error: 'This variant group was changed by someone else.' }, 409)).request.body).toEqual({ version: 4, remove: ['p2'] });
    expect(m.text('[role=alert]')).toContain('changed by someone else');
    await m.reply('GET', '/api/variant-groups/jacket', group());
    await m.type('app-product-picker input', 'vase'); await new Promise((r) => setTimeout(r, 300));
    await m.reply('GET', /^\/api\/products\?.*q=vase/, page([summaries[1]]));
    await m.click('.pick-row');
    expect((await m.reply('PATCH', '/api/variant-groups/jacket', group())).request.body).toEqual({ version: 3, add: ['p-vase'] });
    // Add a variant: starts with this product's values, which already exist.
    await m.click(button(m.el, '+ Add a variant'));
    expect(m.text('[role=alert]')).toContain('Product 1 already has these values');
    expect((button(m.el, 'Create variant') as HTMLButtonElement).disabled).toBe(true);
    await m.type('input[aria-label=Size]', '40');
    expect(m.el.querySelector('[role=alert]')).toBeNull();
    await m.click(button(m.el, 'Create variant'));
    const add = await m.reply('POST', '/api/variant-groups/jacket/variants', { id: 'p9', name: 'Product 1 (copy)' });
    expect(add.request.body).toEqual({ fromProductId: 'p1', values: { color: 'White', size: '40' }, name: 'Product 1 (copy)' });
    await m.reply('GET', '/api/variant-groups/jacket', group());
    expect(m.text('[role=status]')).toContain('Product 1 (copy) was created (hidden until you show it)');
    await m.click(button(m.el, 'Dissolve group'));
    await m.click(button(m.el, 'Click to confirm'));
    await m.reply('DELETE', '/api/variant-groups/jacket', null);
  });
});

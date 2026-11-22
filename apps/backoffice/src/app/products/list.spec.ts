import { Products } from './list';
import { mount, button, Mounted } from '../testing/harness';
import { categories, facets, page, products, summaries } from '../testing/fixtures';
import type { AttributeDef, Product } from '../api.service';

type M = Mounted<Products>;
const wait = () => new Promise((r) => setTimeout(r, 300));
const colour: AttributeDef = { id: 'colour', key: 'colour', label: 'Colour', type: 'choice', options: [{ value: 'blue', label: 'Blue' }, { value: 'sand', label: 'Sand' }], visibility: 'public', filterable: true, searchable: true, showOnProduct: true, position: 0, version: 1 };
const bundle: Product = {
  id: 'b-set', name: 'Breakfast set', price: 44, active: true, stock: 0, type: 'bundle', categoryId: null, images: [],
  bundle: { components: [{ productId: 'p-mug', qty: 1 }, { productId: 'p-vase', qty: 1 }], priceMode: 'manual', offerScope: 'targeted', showOnComponents: true },
  extras: { available: 3, limitedBy: { id: 'p-vase', name: 'Bud Vase' }, componentsTotal: 53, containsDeleted: false },
};

const withColour = () => facets({ attributes: [{ key: 'colour', label: 'Colour', type: 'choice', unit: null, values: [{ value: 'blue', label: 'Blue', count: 2 }, { value: 'sand', label: 'Sand', count: 1 }] }], status: { visible: 3, hidden: 1, deleted: 2 } });
/** The list asks the search API; `list` is what it answers. */
async function setup(list: Product[] = products) {
  const m = await mount(Products, { routes: [{ path: '**', children: [] }] });
  await m.reply('GET', '/api/categories', categories);
  await m.reply('GET', /^\/api\/products\?/, page(list, { total: list.length, facets: withColour() }));
  return m;
}
async function answer(m: M, list: Product[] = products, extra: Record<string, unknown> = {}) {
  const reqs = m.http.match((r) => r.method === 'GET' && r.urlWithParams.startsWith('/api/products?'));
  const last = reqs.at(-1)!;
  reqs.forEach((r) => r.flush(page(list, { facets: withColour(), ...extra })));
  await m.settle();
  return last.request.params;
}

describe('Products list', () => {
  it('shows the search results with stock, visibility, bundle information and counts per filter', async () => {
    const m = await setup([...products, bundle]);
    expect(m.text('header')).toContain('5 products in your catalogue');
    const rows = m.all('tbody tr');
    expect(rows[1].textContent).toContain('3 left');
    expect(rows[2].textContent).toContain('Out of stock');
    expect(rows[3].textContent).toContain('Hidden');
    expect(rows[4].textContent).toContain('Bundle');
    expect(rows[4].textContent).toContain('83% of €53.00');
    expect(rows[4].textContent).toContain('limited by Bud Vase');
    expect(m.text('.facets')).toContain('Visible 3');
    expect(m.text('.facets')).toContain('Blue 2');
    expect(m.text('.discreet')).toBe('Deleted products (2)');
    // Visible products can only be hidden; hidden ones can be shown or deleted (on a confirmation page).
    expect(rows[0].textContent).toContain('Hide');
    expect(rows[0].textContent).not.toContain('Delete');
    expect(rows[3].querySelector('a.danger')!.getAttribute('href')).toBe('/products/p-hidden/delete');
  });

  it('searches on the server (debounced), filters, sorts and pages; the view lives in the URL', async () => {
    const m = await setup();
    await m.type('input[type=search]', 'linen');
    await wait();
    expect((await answer(m)).get('q')).toBe('linen');
    await m.check('.facets input[type=checkbox]', true);
    expect((await answer(m)).get('status')).toBe('visible');
    const blue = m.all('.facets label').find((l) => l.textContent!.includes('Blue'))!.querySelector('input')!;
    await m.click(blue);
    const p = await answer(m, products, { total: 120 });
    expect(p.get('f.colour')).toBe('blue');
    expect(p.get('skip')).toBe('0');
    expect(m.text('.pager')).toContain('1–50 of 120');
    await m.click(button(m.el, 'Next →'));
    expect((await answer(m, products, { total: 120 })).get('skip')).toBe('50');
    await m.select('select[aria-label=Sort]', 'price');
    const sorted = await answer(m);
    expect(sorted.get('sort')).toBe('price');
    expect(sorted.get('skip')).toBe('0'); // changing the sort goes back to page 1
    expect(m.router.url).toContain('f.colour=blue');
    await m.click(button(m.el, 'Clear filters'));
    expect((await answer(m)).keys().filter((k) => !['limit', 'skip'].includes(k))).toEqual([]);
  });

  it('hides, shows, restores from the deleted view, and runs bulk actions', async () => {
    const m = await setup();
    await m.click(button(m.all('tbody tr')[0], 'Hide'));
    expect((await m.reply('PATCH', '/api/products/p-mug', {})).request.body).toEqual({ active: false });
    await answer(m);
    await m.click(button(m.all('tbody tr')[3], 'Show'));
    expect((await m.reply('PATCH', '/api/products/p-hidden', {})).request.body).toEqual({ active: true });
    await answer(m);
    // bulk
    await m.check('tbody tr:nth-child(1) input', true);
    await m.check('tbody tr:nth-child(2) input', true);
    expect(m.text('.bulkbar')).toContain('2 selected');
    await m.click(button(m.el, 'Hide', '.bulkbar button'));
    const bulk = await m.reply('POST', '/api/products/bulk', { changed: 2, failed: [] });
    expect(bulk.request.body).toEqual({ ids: ['p-mug', 'p-vase'], action: 'hide' });
    await answer(m);
    expect(m.text('[role=status]')).toBe('2 products updated.');
    await m.check('thead input', true);
    await m.select('.bulkbar select', 'c-vases');
    expect((await m.reply('POST', '/api/products/bulk', { changed: 4, failed: [{ id: 'x', error: 'e' }] })).request.body).toEqual({ ids: ['p-mug', 'p-vase', 'p-bowl', 'p-hidden'], action: 'category', categoryId: 'c-vases' });
    await answer(m);
    expect(m.text('[role=status]')).toContain('1 could not be changed');
    // the discreet "Deleted products" view, with restore
    await m.click(button(m.el, 'Deleted products'));
    expect((await answer(m, [{ ...products[3], deletedAt: '2026-06-01T00:00:00Z' }])).get('status')).toBe('deleted');
    expect(m.text('h1')).toBe('Deleted products');
    await m.click(button(m.el, 'Restore'));
    await m.reply('POST', '/api/products/p-hidden/restore', { product: products[3], notice: null });
    await answer(m);
    expect(m.text('[role=status]')).toContain('Hidden was restored. It is hidden until you show it in the shop.');
    await m.click(button(m.el, '← Back to products'));
    const reqs = m.http.match((r) => r.urlWithParams.startsWith('/api/products?'));
    reqs.forEach((r) => r.flush(page([], { facets: facets() })));
    await m.settle();
    expect(m.text('.empty-state')).toContain('Add your first product');
  });

  it('exports what the list shows (or the selection) as CSV or JSON', async () => {
    const m = await setup(products);
    const spy = vi.spyOn(m.cmp['api'], 'exportProducts').mockReturnValue({ subscribe: () => ({}) } as never);
    m.cmp.exportAs('json');
    expect(spy).toHaveBeenLastCalledWith({ status: 'visible,hidden,deleted' }, 'json');
    await m.type('input[type=search]', 'mug'); await wait(); await answer(m);
    m.cmp.exportAs('csv', ';');
    expect(spy).toHaveBeenLastCalledWith({ q: 'mug', delimiter: ';' }, 'csv');
    await m.check('tbody tr:nth-child(1) input', true);
    m.cmp.exportAs('json');
    expect(spy).toHaveBeenLastCalledWith({ ids: 'p-mug' }, 'json');
  });
});

describe('Product editor', () => {
  async function openNew() {
    const m = await setup([]);
    await m.click(button(m.el, '+ New product'));
    await m.reply('GET', '/api/attributes', [colour]);
    return m;
  }

  it('creates a product with a SKU, properties and photos', async () => {
    const m = await openNew();
    expect(m.text('.drawer-h')).toContain('New product');
    await m.type('input[name=name]', 'Cup');
    await m.type('input[name=price]', '12.5');
    await m.type('input[name=stock]', '3.7');
    await m.type('input[name=sku]', ' CUP-1 ');
    await m.select('select[name=cat]', '1: c-mugs');
    await m.select('select[aria-label=Colour]', '2: sand');
    await m.type('textarea[name=desc]', 'Nice');
    const file = m.el.querySelector('input[type=file]') as HTMLInputElement;
    Object.defineProperty(file, 'files', { value: [new File(['a'], 'a.png', { type: 'image/png' }), new File(['b'], 'b.gif', { type: 'image/gif' })], configurable: true });
    file.dispatchEvent(new Event('change')); await m.settle();
    const ups = m.http.match('/api/uploads');
    ups[0].flush({ url: '/uploads/1.png' });
    ups[1].flush({ error: 'unsupported or corrupt image' }, { status: 400, statusText: 'x' });
    await m.settle();
    expect(m.all('.photo').length).toBe(1);
    expect(m.text('[role=alert]')).toBe('unsupported or corrupt image');
    await m.click(button(m.el, 'Create product'));
    const req = await m.reply('POST', '/api/products', { id: 'new' });
    expect(req.request.body).toEqual({ name: 'Cup', sku: 'CUP-1', categoryId: 'c-mugs', description: 'Nice', images: ['/uploads/1.png'], active: true, type: 'simple', attributes: { colour: 'sand' }, price: 12.5, stock: 4 });
    await answer(m);
    expect(m.el.querySelector('.drawer')).toBeNull();
  });

  it('creates a bundle: products from the search, price as the sum, manual price with %, reset', async () => {
    const m = await openNew();
    await m.click(button(m.el, 'Bundle', '.seg button'));
    await m.type('input[name=name]', 'Breakfast set');
    const add = async (q: string, i: number) => {
      await m.type('.bundle-box app-product-picker input', q); await wait();
      const r = await m.reply('GET', new RegExp(`^/api/products\\?.*q=${q}`), page([summaries[i]]));
      expect(r.request.params.get('type')).toBe('simple');
      await m.click('.bundle-box .pick-row');
    };
    await add('mug', 0); await add('vase', 1);
    expect(m.all('.bundle-box tbody tr').length).toBe(2);
    await m.type('input[aria-label="Quantity of Linen Mug"]', '2');
    expect((m.el.querySelector('input[name=bprice]') as HTMLInputElement).value).toBe('77');
    expect(m.text('.bundle-box')).toContain('Sum of products');
    expect(m.text('.bundle-box')).toContain('Available now: 3 (limited by Bud Vase)');
    await m.type('input[name=bprice]', '65');
    expect(m.text('.note-box')).toContain('Original price €77.00 · your price €65.00 = 84% of it (−16%)');
    await m.type('input[name=bprice]', '90');
    expect(m.text('.warn-box')).toContain('costs more than buying its products separately');
    await m.type('input[name=bprice]', '30');
    expect(m.text('.warn-box')).toContain('less than half');
    await m.click(button(m.el, 'Reset to sum'));
    expect(m.text('.bundle-box')).toContain('Sum of products');
    await m.check('input[name=offerScope]', true);
    await m.click(button(m.el, 'Create bundle'));
    const req = await m.reply('POST', '/api/products', { id: 'b' });
    expect(req.request.body).toMatchObject({ name: 'Breakfast set', type: 'bundle', bundle: { components: [{ productId: 'p-mug', qty: 2 }, { productId: 'p-vase', qty: 1 }], priceMode: 'sum', offerScope: 'all', showOnComponents: true } });
    expect(req.request.body.price).toBeUndefined();
    await answer(m);
  });

  it('edits a bundle (components looked up), links to a new offer, and shows server errors as alerts', async () => {
    const m = await setup([bundle]);
    await m.click(button(m.all('tbody tr')[0], 'Edit'));
    await m.reply('GET', '/api/attributes', []);
    await m.reply('GET', '/api/products/b-set', { ...bundle, version: 3 });
    await m.reply('GET', /^\/api\/products\?.*ids=p-mug,p-vase/, page([summaries[0], { ...summaries[1], deleted: true }]));
    expect(m.text('.bundle-box')).toContain('deleted');
    expect(m.text('.note-box')).toContain('Original price €53.00 · your price €44.00 = 83%');
    expect(m.el.querySelector('a[href^="/discounts/new"]')!.getAttribute('href')).toBe('/discounts/new?product=b-set');
    await m.click(button(m.el, 'Save changes'));
    const r = await m.reply('PATCH', '/api/products/b-set', { error: 'Product 8 has the same Colour as Product 1 (Blue).', code: 'variant_duplicate' }, 409);
    expect(r.request.body.version).toBe(3);
    expect(m.text('[role=alert]')).toBe('Product 8 has the same Colour as Product 1 (Blue).');
    await m.click(button(m.el, 'Save changes'));
    await m.reply('PATCH', '/api/products/b-set', { fields: [{ field: 'bundle.components', message: 'a bundle needs at least 2 different products' }] }, 400);
    expect(m.text('[role=alert]')).toBe('bundle.components: a bundle needs at least 2 different products');
    await m.click(button(m.el, 'Cancel'));
    expect(m.el.querySelector('.drawer')).toBeNull();
    expect(m.cmp.art(products[0])).toContain('gradient');
  });
});

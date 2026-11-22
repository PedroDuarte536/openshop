import { ProductImport } from './import';
import { mount, button } from '../testing/harness';
import type { ImportJob } from '../api.service';

const opts = { mode: 'upsert', missing: 'leave', empty: 'leave', stock: 'set', newVisible: false, createCategories: false, createProperties: true, addChoiceValues: true, stopOnError: false, remoteImages: 'download' } as const;
const job = (over: Partial<ImportJob> = {}): ImportJob => ({
  id: 'j1', status: 'uploaded', format: 'csv', filename: 'products.csv', rowCount: 3, columns: ['sku', 'Name *', 'Colour'],
  mapping: { sku: 'sku', 'Name *': 'name', Colour: 'new:Colour' }, newProperties: { Colour: { label: 'Colour', type: 'text' } }, preset: null, options: { ...opts },
  csv: { delimiter: ';', decimal: ',', encoding: 'utf-8' }, createdAt: '2026-06-15T10:00:00Z', updatedAt: '2026-06-15T10:00:00Z',
  sample: [{ sku: 'A', 'Name *': 'Mug', Colour: 'Blue' }, { sku: 'B', 'Name *': 'Bowl', Colour: 'Sand' }],
  targets: { fields: [{ value: 'sku', label: 'SKU' }, { value: 'name', label: 'Name' }], properties: [{ value: 'attr:size', label: 'Size', type: 'choice' }] },
  presets: [{ key: 'prestashop', name: 'PrestaShop 1.7 / 8 products CSV' }], ...over,
});
const preview = { create: 1, update: 1, unchanged: 0, errors: 1, deletedMatches: 1, undecided: 1, warnings: ['price set to 0'], newProperties: [{ key: 'colour', label: 'Colour', type: 'choice', public: false, locked: false, publicInFile: false, values: 2 }, { key: 'size', label: 'Size', type: 'text', public: true, locked: true, publicInFile: false, values: 2 }], newOptions: { size: ['XL'] }, newCategories: ['Mugs'], toHide: 0, catalogueSize: 10, at: 'T1' };

describe('Import products', () => {
  it('uploads, maps columns (with new properties), previews, decides about deleted products, applies and reports', async () => {
    const m = await mount(ProductImport);
    await m.reply('GET', '/api/catalogue/imports', [job({ id: 'old', status: 'done', filename: 'last.csv' })]);
    await m.reply('GET', '/api/catalogue/limits', { importMaxMb: 25, importMaxRows: 50000, uploadMaxMb: 5 });
    expect(m.text('.card')).toContain('Up to 25 MB and 50,000 products');
    expect(m.text('table')).toContain('last.csv');
    expect(m.text('table')).toContain('Applied');
    // upload
    const input = m.el.querySelector('input[type=file]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new File(['sku;Name *\nA;Mug'], 'products.csv', { type: 'text/csv' })], configurable: true });
    input.dispatchEvent(new Event('change')); await m.settle();
    const up = await m.reply('POST', '/api/catalogue/imports?filename=products.csv', job());
    expect(up.request.headers.get('Content-Type')).toBe('text/csv');
    await m.reply('GET', '/api/catalogue/imports/j1', job());
    // mapping
    expect(m.text('.sec-row')).toContain('products.csv · 3 products');
    expect(m.text('.sec-row')).toContain('semicolons, decimal ",", utf-8');
    expect(m.text('.map tbody tr:nth-child(2)')).toContain('Mug · Bowl');
    expect(m.cmp.newTarget('attr:Material')).toBe('new:Material');
    expect(m.cmp.newTarget('Colour')).toBe('new:Colour');
    await m.select('select[aria-label="Type of Colour"]', 'choice');
    await m.select('select[aria-label="Column Name *"]', 'name');
    await m.check('input[name=createCategories]', true);
    await m.click(button(m.el, 'Preview'));
    const put = await m.reply('PUT', '/api/catalogue/imports/j1', job());
    expect(put.request.body).toEqual({ mapping: { sku: 'sku', 'Name *': 'name', Colour: 'new:Colour' }, options: { ...opts, createCategories: true }, newProperties: { Colour: { type: 'choice' } } });
    await m.reply('POST', '/api/catalogue/imports/j1/preview', job({ status: 'previewed', preview }));
    // preview: the deleted-products tab first, because a decision is needed
    const rowsReq = await m.reply('GET', /^\/api\/catalogue\/imports\/j1\/rows\?/, { items: [{ row: 3, action: 'create', state: 'pending', message: null, productId: null, name: 'Old mug', sku: 'OLD', errors: [], warnings: [], diff: null, deletedMatch: { productId: 'p9', name: 'Old mug', deletedAt: '2026-01-02T00:00:00Z', decision: null } }], total: 1 });
    expect(rowsReq.request.params.get('action')).toBe('deleted');
    expect(m.text('.kpis')).toContain('1 to decide');
    expect(m.text()).toContain('price set to 0');
    expect(m.text('.newprops')).toContain('Colour');
    expect(m.text('.newprops')).toContain('One choice');
    expect(m.text('.newprops')).toContain('Public: tells variants apart');
    expect((m.el.querySelector('input[aria-label="Public in the shop: Colour"]') as HTMLInputElement).checked).toBe(false);
    expect(m.text()).toContain('New values: size: XL');
    expect(m.text()).toContain('New categories: Mugs');
    expect((button(m.el, 'Apply import') as HTMLButtonElement).disabled).toBe(true);
    expect(m.text('.hint.right')).toContain('Choose what to do with 1 row');
    await m.click(button(m.el, 'Restore and update'));
    const dec = await m.reply('POST', '/api/catalogue/imports/j1/decisions', job({ status: 'previewed', preview: { ...preview, undecided: 0, at: 'T2' } }));
    expect(dec.request.body).toEqual({ decisions: { '3': 'restore' } });
    await m.reply('GET', /^\/api\/catalogue\/imports\/j1\/rows\?/, { items: [], total: 0 });
    // making a new property public: saved, then previewed again
    await m.check('input[aria-label="Public in the shop: Colour"]', true);
    const pub = await m.reply('PUT', '/api/catalogue/imports/j1', job());
    expect(pub.request.body).toEqual({ publish: ['colour'] });
    const np = preview.newProperties.map((x) => (x.key === 'colour' ? { ...x, public: true } : x));
    await m.reply('POST', '/api/catalogue/imports/j1/preview', job({ status: 'previewed', preview: { ...preview, undecided: 0, at: 'T2', newProperties: np } }));
    expect((m.el.querySelector('input[aria-label="Public in the shop: Colour"]') as HTMLInputElement).checked).toBe(true);
    await m.reply('GET', /^\/api\/catalogue\/imports\/j1\/rows\?/, { items: [], total: 0 });
    // the changed tab shows the diff
    await m.click(button(m.el, 'Changed', 'button[role=tab]'));
    await m.reply('GET', /^\/api\/catalogue\/imports\/j1\/rows\?action=update/, { items: [{ row: 1, action: 'update', state: 'pending', message: null, productId: 'p1', name: 'Mug', sku: 'A', errors: [], warnings: [], diff: { price: [10, 12], categoryId: [null, 'c1'], attributes: [{ size: 'm', colour: 'blue' }, { size: 'l', colour: 'blue', finish: 'matte' }] }, deletedMatch: null }], total: 1 });
    expect(m.text('.rows')).toContain('price 10 → 12');
    expect(m.text('.rows')).toContain('category — → c1');
    expect(m.text('.rows')).toContain('Size m → l');
    expect(m.text('.rows')).toContain('finish — → matte');
    expect(m.text('.rows')).not.toContain('colour');
    // apply with the latest preview; progress; done
    await m.click(button(m.el, 'Apply import'));
    const c = await m.reply('POST', '/api/catalogue/imports/j1/commit', job({ status: 'committing', progress: { done: 0, total: 3 } }));
    expect(c.request.body).toEqual({ previewAt: 'T2' });
    expect(m.text('h3')).toContain('Applying the import');
    await new Promise((r) => setTimeout(r, 1100));
    await m.reply('GET', '/api/catalogue/imports/j1', job({ status: 'done', result: { created: 1, updated: 1, unchanged: 0, restored: 1, hidden: 0, conflicts: 1, failed: 1, skipped: 0 } }));
    expect(m.text('h3')).toContain('Import finished');
    expect(m.text('.kpis')).toContain('Created1');
    expect(m.text('.warn-box')).toContain('1 product was changed or sold since your preview');
    const dl = vi.spyOn(m.cmp['api'], 'importReport').mockReturnValue({ subscribe: () => ({}) } as never);
    await m.click(button(m.el, 'Download report'));
    expect(dl).toHaveBeenCalledWith('j1');
    await m.click(button(m.el, 'Import another file'));
    await m.reply('GET', '/api/catalogue/imports', []);
    expect(m.text('.drop')).toContain('Choose a CSV or JSON file');
  });

  it('shows file problems, confirms hiding many products, resumes interrupted imports, cancels', async () => {
    const m = await mount(ProductImport);
    await m.reply('GET', '/api/catalogue/imports', [job({ id: 'int', status: 'interrupted', preview: { ...preview, undecided: 0, errors: 0, deletedMatches: 0, toHide: 8 } })]);
    const input = m.el.querySelector('input[type=file]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'bad.json', { type: '' })], configurable: true });
    input.dispatchEvent(new Event('change')); await m.settle();
    const bad = await m.reply('POST', '/api/catalogue/imports?filename=bad.json', { error: 'The JSON file can\'t be read (it isn\'t valid JSON).' }, 400);
    expect(bad.request.headers.get('Content-Type')).toBe('application/json');
    expect(m.text('[role=alert]')).toContain("isn't valid JSON");
    await m.click(button(m.el, 'Resume'));
    await m.reply('GET', '/api/catalogue/imports/int', job({ id: 'int', status: 'interrupted', preview: { ...preview, undecided: 0, errors: 0, deletedMatches: 0, toHide: 8 } }));
    await m.reply('GET', /^\/api\/catalogue\/imports\/int\/rows\?/, { items: [], total: 0 });
    expect(m.text()).toContain('8 products not in the file will be hidden');
    expect(m.text('.hint.right')).toContain('Confirm hiding');
    await m.check('input[name=confirmHide]', true);
    await m.click(button(m.el, 'Apply import'));
    expect((await m.reply('POST', '/api/catalogue/imports/int/commit', { error: 'Another import is running. Please wait until it finishes.' }, 409)).request.body).toEqual({ previewAt: 'T1', confirmHide: true });
    expect(m.text('[role=alert]')).toContain('Another import is running');
    await m.click(button(m.el, 'Change columns'));
    await m.click(button(m.el, 'Cancel import'));
    await m.reply('POST', '/api/catalogue/imports/int/cancel', { ok: true });
    await m.reply('GET', '/api/catalogue/imports', []);
    expect(m.text('.drop')).toContain('Choose a CSV or JSON file');
  });
});

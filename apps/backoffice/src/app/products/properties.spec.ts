import { Properties } from './properties';
import { mount, button } from '../testing/harness';
import type { AttributeDef } from '../api.service';

const colour: AttributeDef = { id: 'colour', key: 'colour', label: 'Colour', type: 'choice', options: [{ value: 'blue', label: 'Blue', swatch: '#1f4fff' }, { value: 'sand', label: 'Sand' }], visibility: 'public', filterable: true, searchable: true, showOnProduct: true, position: 0, version: 2, usedBy: 3, variantGroups: ['Linen mugs'] };
const supplier: AttributeDef = { id: 'supplier', key: 'supplier', label: 'Supplier', type: 'text', visibility: 'internal', filterable: false, searchable: false, showOnProduct: false, position: 1, version: 1, usedBy: 0, origin: { importJobId: 'j1' } };

describe('Properties', () => {
  it('lists properties with their use, creates one with ordered values and swatches', async () => {
    const m = await mount(Properties);
    await m.reply('GET', '/api/attributes', [colour, supplier]);
    const rows = m.all('tbody tr');
    expect(rows[0].textContent).toContain('tells variants apart in Linen mugs');
    expect(rows[0].textContent).toContain('shown · filter · search');
    expect(rows[1].textContent).toContain('Internal');
    expect(rows[1].textContent).toContain('created by an import');
    await m.click(button(m.el, '+ New property'));
    await m.type('input[name=label]', 'Size');
    await m.type('input[data-opt="0"]', 'Small');
    await m.click(button(m.el, '+ Add value'));
    await m.type('input[data-opt="1"]', 'Large');
    await m.type('input[data-swatch="1"]', '#000');
    await m.click(button(m.el, '+ Add value'));
    await m.click(m.all('.opt-row')[1].querySelectorAll('button')[0] as HTMLElement); // move "Large" up
    await m.click(button(m.el, 'Create property'));
    const req = await m.reply('POST', '/api/attributes', {});
    expect(req.request.body).toEqual({ label: 'Size', type: 'choice', options: [{ label: 'Large', swatch: '#000' }, { label: 'Small', swatch: null }], visibility: 'public', filterable: true, searchable: true, showOnProduct: true });
    await m.reply('GET', '/api/attributes', [colour]);
  });

  it('edits with the version, shows field errors, deletes with purge when values exist', async () => {
    const m = await mount(Properties);
    await m.reply('GET', '/api/attributes', [colour]);
    await m.click(button(m.el, 'Edit'));
    expect((m.el.querySelector('input[name=pub]') as HTMLInputElement).disabled).toBe(true);
    await m.type('input[name=label]', 'Color');
    await m.click(button(m.el, 'Save changes'));
    const r = await m.reply('PATCH', '/api/attributes/colour', { fields: [{ field: 'options', message: 'still used by products: Sand' }] }, 400);
    expect(r.request.body.version).toBe(2);
    expect(m.text('[role=alert]')).toBe('options: still used by products: Sand');
    await m.click(button(m.el, 'Cancel'));
    await m.click(button(m.el, 'Delete'));
    await m.click(button(m.el, 'Clear 3 values and delete'));
    await m.reply('DELETE', '/api/attributes/colour?purge=true', { error: 'This property tells variants apart in Linen mugs.' }, 409);
    expect(m.text('[role=alert]')).toContain('tells variants apart');
  });
});

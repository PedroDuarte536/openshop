import { Discounts } from './list';
import { mount, button } from '../testing/harness';
import { categories, offer, page, settings, summaries } from '../testing/fixtures';

async function setup(unconfirmed = false) {
  const m = await mount(Discounts);
  await m.reply('GET', '/api/discounts', [
    offer({ name: 'Winter', label: 'Winter sale', campaign: 'Winter', target: { type: 'categories', categoryIds: ['c-mugs'] } }, { id: 'w' }),
    offer({ name: 'Code', trigger: 'code', scope: 'order', status: 'paused' }, { id: 'c', codeCount: 1 }),
    offer({ name: 'Old', status: 'archived' }, { id: 'a' }),
    offer({ name: 'Mug price', target: { type: 'products', productIds: ['p-mug'] }, effect: { type: 'fixedPrice', cents: 1900 }, limits: { totalUses: 5 } }, { id: 'p', usedCount: 2 }),
  ]);
  // Names only for the products that offers name.
  await m.reply('GET', /^\/api\/products\?.*ids=p-mug/, page(summaries.slice(0, 1)));
  await m.reply('GET', '/api/categories', categories);
  await m.reply('GET', '/api/settings', settings({ timezoneConfirmed: !unconfirmed }));
  return m;
}

describe('Discounts list', () => {
  it('lists offers (archived hidden), with kind, target, effect, state and uses', async () => {
    const m = await setup(true);
    expect(m.text('.banner')).toContain('Europe/Lisbon');
    expect(m.text('header')).toContain('(Lisbon)');
    const rows = m.all('tbody tr');
    expect(rows.length).toBe(3);
    expect(rows[0].textContent).toContain('Category');
    expect(rows[0].textContent).toContain('Category: Mugs');
    expect(rows[0].textContent).toContain('Shoppers see “Winter sale” · Winter');
    expect(rows[1].textContent).toContain('Paused');
    expect(rows[1].textContent).toContain('1 code');
    expect(rows[2].textContent).toContain('€19.00 each');
    expect(rows[2].textContent).toContain('2 / 5');
    expect(m.text('[role=tablist]')).toContain('All offers 3');
  });
  it('filters by tab, status and search', async () => {
    const m = await setup();
    expect(m.el.querySelector('.banner')).toBeNull();
    await m.click(button(m.el, 'Vouchers', 'button[role=tab]'));
    expect(m.all('tbody tr').length).toBe(1);
    await m.click(button(m.el, 'Automatic', 'button[role=tab]'));
    expect(m.all('tbody tr').length).toBe(2);
    await m.click(button(m.el, 'All offers', 'button[role=tab]'));
    await m.select('select[aria-label="Filter by status"]', 'archived');
    expect(m.all('tbody tr').length).toBe(1);
    expect(m.text('tbody')).toContain('Old');
    await m.select('select[aria-label="Filter by status"]', '');
    await m.type('input[type=search]', 'winter');
    expect(m.all('tbody tr').length).toBe(1);
    await m.type('input[type=search]', 'zzz');
    expect(m.text()).toContain('No offers match');
  });
  it('pauses, resumes, restores and duplicates', async () => {
    const m = await setup();
    const nav = vi.spyOn(m.router, 'navigate').mockResolvedValue(true);
    await m.click(button(m.all('tbody tr')[0], 'Pause'));
    await m.reply('POST', '/api/discounts/w/pause', {});
    await m.reply('GET', '/api/discounts', [offer({ name: 'Paused', status: 'paused' }, { id: 'w' }), offer({ name: 'Arch', status: 'archived' }, { id: 'a' })]);
    await m.click(button(m.all('tbody tr')[0], 'Resume'));
    await m.reply('POST', '/api/discounts/w/resume', {}, 500);
    expect(m.text('[role=alert]')).toBe('Could not update the offer.');
    await m.select('select[aria-label="Filter by status"]', 'archived');
    await m.click(button(m.all('tbody tr')[0], 'Restore'));
    await m.reply('POST', '/api/discounts/a/resume', {});
    await m.reply('GET', '/api/discounts', []);
    expect(m.text()).toContain('Create your first offer');
    m.cmp.duplicate(offer({}, { id: 'x' }));
    await m.reply('POST', '/api/discounts/x/duplicate', { id: 'copy' });
    expect(nav).toHaveBeenCalledWith(['/discounts', 'copy']);
  });
});

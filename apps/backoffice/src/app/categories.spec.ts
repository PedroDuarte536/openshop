import { Categories } from './categories';
import { mount, button } from './testing/harness';
import { categories, facets, page } from './testing/fixtures';

describe('Categories page', () => {
  it('lists categories with product counts, suggests addresses, adds and deletes', async () => {
    const m = await mount(Categories);
    await m.reply('GET', '/api/categories', categories);
    // Product counts come from the search's category counts.
    const counts = await m.reply('GET', /^\/api\/products\?limit=0$/, page([], { total: 4, facets: facets() }));
    expect(counts.request.params.get('limit')).toBe('0');
    const rows = m.all('tbody tr');
    expect(rows[0].textContent).toContain('/shop/category/mugs');
    expect(rows[0].querySelectorAll('td')[2].textContent).toBe('1');
    await m.type('input[name=name]', 'Tea Pots & More');
    expect((m.el.querySelector('input[name=slug]') as HTMLInputElement).value).toBe('tea-pots-more');
    await m.type('input[name=name]', 'Tea Pots');
    expect((m.el.querySelector('input[name=slug]') as HTMLInputElement).value).toBe('tea-pots');
    await m.click(button(m.el, 'Add category'));
    await m.reply('POST', '/api/categories', {}, 409);
    expect(m.text('[role=alert]')).toContain('already used by another category');
    await m.click(button(m.el, 'Add category'));
    await m.reply('POST', '/api/categories', { error: 'body/slug must match pattern' }, 400);
    expect(m.text('[role=alert]')).toBe('body/slug must match pattern');
    await m.click(button(m.el, 'Add category'));
    const req = await m.reply('POST', '/api/categories', { id: 'c-new' });
    expect(req.request.body).toEqual({ name: 'Tea Pots', slug: 'tea-pots' });
    await m.reply('GET', '/api/categories', categories);
    expect((m.el.querySelector('input[name=name]') as HTMLInputElement).value).toBe('');
    // a slug edited by hand is kept
    await m.type('input[name=slug]', 'custom');
    await m.type('input[name=name]', 'Other');
    expect((m.el.querySelector('input[name=slug]') as HTMLInputElement).value).toBe('custom');
    await m.click(button(m.all('tbody tr')[1], 'Delete'));
    await m.click(button(m.all('tbody tr')[1], 'Click to confirm'));
    await m.reply('DELETE', '/api/categories/c-vases', null);
    await m.reply('GET', '/api/categories', []);
    expect(m.text()).toContain('No categories yet');
  });
});

import { newSection, newWidget, type Node } from '@openshop/renderer';
import { Builder } from './builder';
import { mount, button, Mounted } from '../testing/harness';
import { categories, page as pageOf, summaries } from '../testing/fixtures';

type Host = {
  select(id: string | null): void; hover(id: string | null): void; edit(id: string, path: string, v: string): void;
  drop(e: unknown): void; action(name: string, id: string): void; key(k: { key: string; mod: boolean; shift: boolean }): boolean;
};
const host = () => (window as unknown as { osBuilderHost: Host }).osBuilderHost;

function pageDoc() {
  const s = newSection([12]);
  const h = newWidget('heading'), t = newWidget('text');
  s.children![0].children = [h, t];
  return { s, h, t, nodes: [s] as Node[] };
}

async function setup(page: { slug: string; system?: string | null; nodes?: Node[] } = { slug: 'about' }) {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    cb: (e: { contentRect: { width: number; height: number } }[]) => void;
    constructor(cb: (e: { contentRect: { width: number; height: number } }[]) => void) { this.cb = cb; }
    observe() { this.cb([{ contentRect: { width: 900, height: 700 } }]); }
    disconnect() {}
  };
  const m = await mount(Builder, { inputs: { id: 'pg1' } });
  const d = pageDoc();
  await m.replyAll('GET', '/api/categories', categories);
  await m.reply('GET', '/api/pages/pg1', { id: 'pg1', title: 'About', theme: {}, nodes: page.nodes ?? d.nodes, slug: page.slug, system: page.system ?? null });
  await m.reply('GET', /^\/api\/products\?.*status=visible/, pageOf(summaries.filter((p) => p.active)));
  return { m, store: m.cmp.store, ...d };
}

describe('page builder', () => {
  afterEach(() => { delete (window as { osBuilderHost?: unknown }).osBuilderHost; });

  it('loads the page and exposes the canvas host API (select, edit, drop, actions)', async () => {
    const { m, store, s, h, t } = await setup();
    expect((m.el.querySelector('input.title') as HTMLInputElement).value).toBe('About');
    expect((m.el.querySelector('.addr input') as HTMLInputElement).value).toBe('about');
    expect(m.text('.status')).toBe('Up to date');
    host().select(h.id);
    host().hover(h.id);
    expect(store.selectedId()).toBe(h.id);
    host().edit(h.id, 'text', 'Typed on the canvas');
    expect((store.find(h.id)!.props as { text: string }).text).toBe('Typed on the canvas');
    host().drop({ kind: 'widget', move: null, item: { type: 'button' }, targetId: t.id, pos: 'after' });
    expect(store.parentOf(t.id)!.children!.map((n) => n.type)).toEqual(['heading', 'text', 'button']);
    host().drop({ kind: 'section', move: null, item: { templateKey: 'faq' }, targetId: null, pos: 'end' });
    expect(store.doc().nodes.length).toBe(2);
    host().drop({ kind: 'section', move: null, item: { templateKey: 'nope' }, targetId: null, pos: 'end' });
    host().drop({ kind: 'widget', move: null, item: null, targetId: null, pos: 'end' });
    expect(store.doc().nodes.length).toBe(2);
    host().drop({ kind: 'widget', move: h.id, item: null, targetId: t.id, pos: 'after' });
    expect(store.parentOf(t.id)!.children!.map((n) => n.id).indexOf(h.id)).toBe(1);
    host().action('parent', h.id);
    expect(store.selectedId()).toBe(s.children![0].id);
    host().action('parent', s.id);
    host().action('up', h.id);
    host().action('down', h.id);
    host().action('duplicate', h.id);
    expect(store.parentOf(h.id)!.children!.length).toBe(4);
    host().action('delete', h.id);
    expect(store.find(h.id)).toBeNull();
    await m.settle();
    expect(m.text('.status')).toBe('Unpublished changes');
  });

  it('keyboard: undo, redo, save, duplicate, delete, escape', async () => {
    const { m, store, h } = await setup();
    store.setProp(h.id, 'text', 'A');
    expect(host().key({ key: 'z', mod: true, shift: false })).toBe(true);
    expect((store.find(h.id)!.props as { text: string }).text).toBe('A headline worth reading');
    host().key({ key: 'Z', mod: true, shift: true });
    expect((store.find(h.id)!.props as { text: string }).text).toBe('A');
    host().key({ key: 'z', mod: true, shift: false });
    host().key({ key: 'y', mod: true, shift: false });
    expect((store.find(h.id)!.props as { text: string }).text).toBe('A');
    store.select(h.id);
    host().key({ key: 'd', mod: true, shift: false });
    expect(store.doc().nodes[0].children![0].children!.length).toBe(3);
    host().key({ key: 'Delete', mod: false, shift: false });
    expect(store.doc().nodes[0].children![0].children!.length).toBe(2);
    store.preview.set(true);
    host().key({ key: 'Escape', mod: false, shift: false });
    expect(store.preview()).toBe(false);
    store.select(h.id);
    host().key({ key: 'Escape', mod: false, shift: false });
    expect(store.selectedId()).toBeNull();
    expect(host().key({ key: 'x', mod: false, shift: false })).toBe(false);
    host().key({ key: 's', mod: true, shift: false });
    await m.reply('PUT', '/api/pages/pg1', {});
    // window shortcuts: ignored while typing, except save
    const input = m.el.querySelector('input.title') as HTMLInputElement;
    const typing = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true });
    input.dispatchEvent(typing);
    const save = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(save);
    expect(save.defaultPrevented).toBe(true);
    await m.reply('PUT', '/api/pages/pg1', {});
    const undo = new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(undo);
    expect(undo.defaultPrevented).toBe(true);
    const other = new KeyboardEvent('keydown', { key: 'q', bubbles: true, cancelable: true });
    document.body.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
  });

  it('publishes, shows the live link, explains address conflicts, and needs an address', async () => {
    const { m, store } = await setup();
    await m.type('input.title', 'About us');
    expect(store.doc().title).toBe('About us');
    await m.type('.addr input', 'Our Story!');
    expect((m.el.querySelector('.addr input') as HTMLInputElement).value).toBe('our-story-');
    await m.click(button(m.el, 'Publish'));
    expect(m.text('.publish')).toBe('Publishing…');
    m.cmp.save(); // a second click while publishing does nothing
    const req = await m.reply('PUT', '/api/pages/pg1', {});
    expect(req.request.body).toMatchObject({ slug: 'our-story-', title: 'About us' });
    expect(m.text('.status')).toBe('Published');
    expect(m.el.querySelector('a.live')!.getAttribute('href')).toBe('/s/our-story-');
    m.cmp.onSlug('our-story-');
    expect(store.dirty()).toBe(false);
    await m.click(button(m.el, 'Publish'));
    await m.reply('PUT', '/api/pages/pg1', {}, 409);
    expect(m.text('.status')).toBe('That address is already used by another page');
    await m.click(button(m.el, 'Publish'));
    await m.reply('PUT', '/api/pages/pg1', {}, 500);
    expect(m.text('.status')).toBe('Could not publish');
    await m.type('.addr input', '');
    await m.click(button(m.el, 'Publish'));
    expect(m.text('.status')).toBe('Give the page an address first');
    m.http.expectNone('/api/pages/pg1');
  });

  it('essential pages keep their fixed address', async () => {
    const { m } = await setup({ slug: 'system-product', system: 'product' });
    expect(m.text('.sys')).toContain('Product page');
    expect(m.el.querySelector('.addr input')).toBeNull();
  });

  it('offers the new catalogue widgets on essential pages designed before them', async () => {
    const { m, store } = await setup({ slug: 'system-product', system: 'product' });
    expect(m.text('.newfeat')).toContain('New for this page: variant choices, bundle contents, product details, "As seen in these bundles"');
    expect(store.dirty()).toBe(false);
    await m.click(button(m.el, 'Add them', '.newfeat button'));
    expect(store.dirty()).toBe(true);
    expect(m.el.querySelector('.newfeat')).toBeNull();
  });

  it('renders the page into the canvas frame, in edit and preview mode, and switches devices', async () => {
    const { m, store, h } = await setup();
    const frame = m.el.querySelector('iframe') as HTMLIFrameElement;
    const doc = frame.contentDocument!;
    doc.body.innerHTML = '<style id="os-css"></style><div id="os-head"></div><main id="os-root"></main>';
    const calls: string[] = [];
    (frame.contentWindow as unknown as { osEditor: unknown }).osEditor = { setMode: (x: string) => calls.push(`mode:${x}`), setSelected: (x: string | null) => calls.push(`sel:${x}`) };
    m.cmp.onLoad();
    store.select(h.id);
    await m.settle();
    expect(doc.getElementById('os-root')!.innerHTML).toContain('A headline worth reading');
    expect(doc.getElementById('os-css')!.textContent).toContain('.os-section');
    expect(doc.getElementById('os-head')!.innerHTML).toContain('fonts.googleapis.com');
    expect(calls).toContain(`sel:${h.id}`);
    await m.click(m.el.querySelector('button[aria-label=Preview]') as HTMLElement);
    expect(doc.body.classList.contains('os-editor')).toBe(false);
    expect(calls).toContain('mode:preview');
    await m.click(m.el.querySelector('button[aria-label=Preview]') as HTMLElement);
    store.replaceAll({}, []);
    await m.settle();
    expect(doc.getElementById('os-root')!.innerHTML).toContain('Your page is empty');
    await m.click(m.el.querySelector('button[aria-label=Mobile]') as HTMLElement);
    expect(frame.style.width).toBe('390px');
    expect(m.text('.chrome small')).toBe('390px');
    await m.click(m.el.querySelector('button[aria-label=Undo]') as HTMLElement);
    expect(store.doc().nodes.length).toBe(1);
    await m.click(m.el.querySelector('button[aria-label=Redo]') as HTMLElement);
    expect(store.doc().nodes.length).toBe(0);
  });

  it('fills product grids on the canvas from the live catalogue (visible products, category, limit)', async () => {
    const s = newSection([12]);
    s.children![0].children = [{ ...newWidget('productGrid'), props: { categoryId: 'c-mugs', limit: 4, cols: 4 } }, { ...newWidget('productGrid'), props: { limit: 2, cols: 2 } }];
    const { m } = await setup({ slug: 'shop', nodes: [s] });
    const frame = m.el.querySelector('iframe') as HTMLIFrameElement;
    frame.contentDocument!.body.innerHTML = '<style id="os-css"></style><div id="os-head"></div><main id="os-root"></main>';
    m.cmp.onLoad();
    m.cmp.store.setTitle('Shop');
    await m.settle();
    const grids = [...frame.contentDocument!.querySelectorAll('.os-pg')].map((g) => [...g.querySelectorAll('.os-pc-n')].map((n) => n.textContent));
    expect(grids).toEqual([['Linen Mug'], ['Linen Mug', 'Bud Vase']]);
  });

  it('deselects on a backdrop click, guards unsaved changes, and cleans up', async () => {
    const { m, store, h } = await setup();
    store.select(h.id);
    const wrap = m.el.querySelector('.stage-wrap') as HTMLElement;
    m.cmp.onBackdrop({ target: m.el.querySelector('.stage') } as unknown as MouseEvent);
    expect(store.selectedId()).toBe(h.id);
    wrap.click();
    expect(store.selectedId()).toBeNull();
    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    store.setTitle('Changed');
    const dirty = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
    m.fixture.destroy();
    expect((window as { osBuilderHost?: unknown }).osBuilderHost).toBeUndefined();
  });
});

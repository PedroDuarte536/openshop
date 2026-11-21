import { newSection, newWidget, type Node } from '@openshop/renderer';
import { BuilderStore, kindOf, snippet } from './store';

/** A page with one section of two columns; the first column holds a heading and a text. */
function page() {
  const s = newSection([6, 6]);
  const h = newWidget('heading'), t = newWidget('text');
  s.children![0].children = [h, t];
  const store = new BuilderStore();
  store.load({ title: 'Home', nodes: [s] });
  return { store, s, c1: s.children![0], c2: s.children![1], h, t };
}
const ids = (ns: Node[]): string[] => ns.flatMap((n) => [n.id, ...ids(n.children ?? [])]);

describe('BuilderStore', () => {
  afterEach(() => vi.useRealTimers());

  it('offers the catalogue widgets an older essential page lacks, and adds them only when asked', () => {
    const s = newSection([12]);
    const grid = newWidget('productGrid'); grid.props['source'] = 'results';
    s.children![0].children = [newWidget('dynamicTitle'), grid];
    const store = new BuilderStore();
    store.load({ title: 'Search', nodes: [s] });
    expect(store.missingCatalogueWidgets('search')).toEqual(['searchFilters', 'resultsBar']);
    expect(store.missingCatalogueWidgets(null)).toEqual([]);
    expect(store.dirty()).toBe(false);
    store.addCatalogueWidgets('search');
    const col = store.doc().nodes[0].children![0].children!;
    expect(col.map((n) => n.type)).toEqual(['dynamicTitle', 'searchFilters', 'resultsBar', 'productGrid']);
    expect(col[3].props['paginate']).toBe(true);
    expect(store.missingCatalogueWidgets('search')).toEqual([]);
    store.undo();
    expect(store.missingCatalogueWidgets('search').length).toBe(2);
    // Product page without an add-to-cart button: the widgets go in a new section at the end.
    const p = new BuilderStore();
    p.load({ title: 'Product', nodes: [newSection([12])] });
    p.addCatalogueWidgets('product');
    expect(p.doc().nodes.at(-1)!.children![0].children!.map((n) => n.type)).toEqual(['productVariants', 'bundleContents', 'productSpecs', 'productBundles']);
    const q = new BuilderStore();
    const sec = newSection([12]); const atc = newWidget('addToCart'); sec.children![0].children = [newWidget('productTitle'), atc];
    q.load({ title: 'Product', nodes: [sec] });
    q.addCatalogueWidgets('product');
    expect(q.doc().nodes[0].children![0].children!.map((n) => n.type)).toEqual(['productTitle', 'addToCart', 'productVariants', 'bundleContents', 'productSpecs', 'productBundles']);
    q.addCatalogueWidgets('product');
    expect(q.doc().nodes[0].children![0].children!.length).toBe(6);
  });

  it('loads a page clean: nothing selected, nothing to undo, not dirty', () => {
    const { store, h } = page();
    expect(store.dirty()).toBe(false);
    expect(store.canUndo()).toBe(false);
    expect(store.selected()).toBeNull();
    expect(store.path()).toEqual([]);
    store.select(h.id);
    expect(store.selected()!.id).toBe(h.id);
    expect(store.path().map((n) => n.type)).toEqual(['section', 'column', 'heading']);
    store.select('ghost');
    expect(store.path()).toEqual([]);
    expect(kindOf('section')).toBe('section');
    expect(kindOf('column')).toBe('column');
    expect(kindOf('text')).toBe('widget');
  });

  it('adds widgets where the user clicked: into a column, after a widget, into a section, or a new section', () => {
    const { store, c2, h, s } = page();
    store.select(c2.id); store.addWidget('button');
    expect(store.find(c2.id)!.children!.map((n) => n.type)).toEqual(['button']);
    store.select(h.id); store.addWidget('image');
    expect(store.parentOf(store.selectedId()!)!.children!.map((n) => n.type)).toEqual(['heading', 'image', 'text']);
    store.select(s.id); store.addWidget('divider');
    expect(store.find(s.children![0].id)!.children!.map((n) => n.type)).toEqual(['heading', 'image', 'text', 'divider']);
    store.select(null); store.addWidget('spacer');
    expect(store.doc().nodes.length).toBe(2);
    expect(store.selected()!.type).toBe('spacer');
    expect(store.dirty()).toBe(true);
  });

  it('inserts sections, templates and columns, and refuses invalid drops', () => {
    const { store, s, c1, h } = page();
    store.addSectionTemplate({ spans: [4, 4, 4] });
    expect(store.doc().nodes[1].children!.length).toBe(3);
    store.addSectionTemplate({ build: () => newSection([12]) });
    expect(store.doc().nodes.length).toBe(3);
    const preset = newSection([12]);
    store.insertNew('section', preset, s.id, 'before');
    expect(store.doc().nodes[0].id).toBe(preset.id);
    store.insertNew('widget', { type: 'stat' }, h.id, 'before');
    expect(store.find(c1.id)!.children![0].type).toBe('stat');
    store.insertNew('widget', { type: 'faq' }, c1.id, 'inside');
    expect(store.find(c1.id)!.children!.at(-1)!.type).toBe('faq');
    store.insertNew('widget', { type: 'gallery' }, s.id, 'after');
    expect(store.doc().nodes[2].children![0].children![0].type).toBe('gallery');
    const before = JSON.stringify(store.doc());
    store.insertNew('column' as never, {}, null, 'end');
    store.insertNew('widget', { type: 'text' }, 'ghost', 'after');
    expect(JSON.stringify(store.doc())).toBe(before);
  });

  it('moves nodes (and cleans up emptied sections), and refuses moving into itself', () => {
    const { store, s, c1, c2, h, t } = page();
    store.move(h.id, c2.id, 'inside');
    expect(store.find(c2.id)!.children!.map((n) => n.id)).toEqual([h.id]);
    expect(store.selectedId()).toBe(h.id);
    store.move(h.id, t.id, 'after');
    expect(store.find(c1.id)!.children!.map((n) => n.id)).toEqual([t.id, h.id]);
    store.move(h.id, h.id, 'after');
    const before = JSON.stringify(store.doc());
    store.move(s.id, h.id, 'before');
    expect(JSON.stringify(store.doc())).toBe(before);
    store.move('ghost', null, 'end');
    expect(JSON.stringify(store.doc())).toBe(before);
    // a column can only be dropped next to another column
    store.move(c2.id, h.id, 'after');
    expect(JSON.stringify(store.doc())).toBe(before);
    store.addSectionTemplate({ spans: [12] });
    const other = store.doc().nodes[1];
    store.move(c2.id, other.children![0].id, 'before');
    expect(store.find(other.id)!.children!.length).toBe(2);
    // a widget moved out leaves its (empty) column in place, ready for new content
    store.select(null);
    store.addWidget('spacer');
    const lonely = store.selectedId()!;
    const sections = store.doc().nodes.length;
    store.move(lonely, c1.id, 'inside');
    expect(store.doc().nodes.length).toBe(sections);
    // moving a section's only column elsewhere removes the section, which would be empty
    const last = store.doc().nodes.at(-1)!;
    store.move(last.children![0].id, c1.id, 'after');
    expect(store.doc().nodes.length).toBe(sections - 1);
    expect(store.find(last.id)).toBeNull();
  });

  it('reorders, duplicates with new ids, and removes (rebalancing column widths)', () => {
    const { store, s, c1, c2, h, t } = page();
    store.moveBy(t.id, -1);
    expect(store.find(c1.id)!.children!.map((n) => n.id)).toEqual([t.id, h.id]);
    const before = JSON.stringify(store.doc());
    store.moveBy(t.id, -1);
    store.moveBy('ghost', 1);
    expect(JSON.stringify(store.doc())).toBe(before);
    store.duplicate(h.id);
    const copy = store.selected()!;
    expect(copy.id).not.toBe(h.id);
    expect(copy.props).toEqual(store.find(h.id)!.props);
    store.duplicate('ghost');
    store.select(c2.id);
    store.remove(c2.id);
    expect(store.find(s.id)!.children!.map((c) => c.style.span)).toEqual([12]);
    expect(store.selectedId()).toBeNull();
    store.remove(c1.id);
    expect(store.doc().nodes).toEqual([]);
    store.remove('ghost');
  });

  it('undoes and redoes, merging quick edits of the same field into one step', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
    const { store, h } = page();
    store.setProp(h.id, 'text', 'H');
    vi.advanceTimersByTime(100);
    store.setProp(h.id, 'text', 'He');
    vi.advanceTimersByTime(100);
    store.setProp(h.id, 'text', 'Hello');
    expect(store.canUndo()).toBe(true);
    store.undo();
    expect((store.find(h.id)!.props as { text: string }).text).toBe('A headline worth reading');
    expect(store.canUndo()).toBe(false);
    expect(store.canRedo()).toBe(true);
    store.redo();
    expect((store.find(h.id)!.props as { text: string }).text).toBe('Hello');
    vi.advanceTimersByTime(2000);
    store.setProp(h.id, 'text', 'Later');
    store.undo();
    expect((store.find(h.id)!.props as { text: string }).text).toBe('Hello');
    // undoing past a node's creation clears the selection
    store.addWidget('button');
    store.undo();
    expect(store.selectedId()).toBeNull();
    store.redo();
    store.select(store.doc().nodes.at(-1)!.id);
    store.undo();
    expect(store.selectedId()).toBeNull();
    store.redo();
    store.select(store.doc().nodes.at(-1)!.id);
    store.undo(); store.redo(); store.undo();
    store.undo(); store.undo(); store.undo();
    store.redo(); store.redo();
    store.markSaved();
    expect(store.dirty()).toBe(false);
    // a change that changes nothing isn't recorded
    const steps = store.canUndo();
    store.setProp(h.id, 'text', (store.find(h.id)!.props as { text: string }).text);
    expect(store.canUndo()).toBe(steps);
  });

  it('edits props, list items and nested paths; invalid documents never enter', () => {
    const { store, c1 } = page();
    store.insertNew('widget', { type: 'faq' }, c1.id, 'inside');
    const faq = store.selected()!;
    store.addItem(faq.id, 'items', { q: 'New?', a: 'Yes.' });
    expect((store.find(faq.id)!.props as { items: unknown[] }).items.length).toBe(3);
    store.setProp(faq.id, 'items.2.q', 'Changed?');
    expect((store.find(faq.id)!.props as { items: { q: string }[] }).items[2].q).toBe('Changed?');
    store.setProp(faq.id, 'nothing.here.x', 1);
    store.removeItem(faq.id, 'items', 0);
    expect((store.find(faq.id)!.props as { items: unknown[] }).items.length).toBe(2);
    store.setProp('ghost', 'text', 'x');
    store.addItem('ghost', 'items', {});
    store.removeItem('ghost', 'items', 0);
    store.setTitle('New title');
    expect(store.doc().title).toBe('New title');
    store.setTheme({ primary: '#FF0000' });
    expect(store.doc().theme.primary).toBe('#FF0000');
    const before = JSON.stringify(store.doc());
    // sections can't be put inside columns: the normaliser refuses, so nothing changes
    store.addItem(c1.id, 'children' as never, newSection([12]));
    expect(JSON.stringify(store.doc())).toBe(before);
    store.replaceAll({ primary: '#00FF00' }, [newSection([12])]);
    expect(store.doc().nodes.length).toBe(1);
    expect(store.doc().theme.primary).toBe('#00FF00');
  });

  it('styles per device: tablet/mobile override desktop, undefined removes, empty overrides disappear', () => {
    const { store, h } = page();
    store.setStyle(h.id, 'desktop', { size: 40 });
    store.setStyle(h.id, 'tablet', { size: 30 });
    store.setStyle(h.id, 'mobile', { size: 20, align: 'center' });
    const n = () => store.find(h.id)!;
    expect(store.styleAt(n(), 'desktop', 'size')).toEqual({ value: 40, own: true });
    expect(store.styleAt(n(), 'tablet', 'size')).toEqual({ value: 30, own: true });
    expect(store.styleAt(n(), 'mobile', 'size')).toEqual({ value: 20, own: true });
    expect(store.styleAt(n(), 'mobile', 'weight')).toEqual({ value: undefined, own: false });
    store.setStyle(h.id, 'mobile', { size: undefined, align: undefined });
    expect(n().responsive!.mobile).toBeUndefined();
    expect(store.styleAt(n(), 'mobile', 'size')).toEqual({ value: 30, own: false });
    store.resetStyle(h.id, 'tablet');
    expect(n().responsive).toBeUndefined();
    store.setStyle(h.id, 'tablet', { gap: 10 });
    store.resetStyle(h.id, 'desktop');
    expect(n().style).toEqual({});
    store.resetStyle(h.id, 'mobile');
    store.setStyle('ghost', 'desktop', { size: 1 });
    store.resetStyle('ghost', 'desktop');
    store.toggleHide(h.id, 'mobile');
    expect(n().hide).toEqual(['mobile']);
    store.toggleHide(h.id, 'mobile');
    expect(n().hide).toBeUndefined();
    store.toggleHide('ghost', 'mobile');
  });

  it('changes a section layout, keeping content of removed columns', () => {
    const { store, s, h, t } = page();
    store.setLayout(s.id, [4, 4, 4]);
    expect(store.find(s.id)!.children!.map((c) => c.style.span)).toEqual([4, 4, 4]);
    store.setLayout(s.id, [12]);
    expect(store.find(s.id)!.children!.length).toBe(1);
    expect(ids(store.find(s.id)!.children!)).toEqual(expect.arrayContaining([h.id, t.id]));
    store.setLayout(h.id, [6, 6]);
    store.setLayout('ghost', [12]);
  });

  it('summarises widgets for the layers list', () => {
    expect(snippet(newWidget('heading'))).toBe('A headline worth reading');
    expect(snippet(newWidget('iconBox'))).toBe('One clear sentence about it.');
    expect(snippet(newWidget('testimonial'))).toBe("I didn't expect to love it t");
    expect(snippet(newWidget('spacer'))).toBe('');
    expect(snippet({ ...newWidget('stat'), props: { value: 42 } })).toBe('');
  });
});

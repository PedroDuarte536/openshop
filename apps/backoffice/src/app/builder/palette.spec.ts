import { newSection, newWidget } from '@openshop/renderer';
import { Palette } from './palette';
import { BuilderStore } from './store';
import { mount, button } from '../testing/harness';

const drag = (el: HTMLElement) => {
  const data: Record<string, string> = {};
  const e = new Event('dragstart') as DragEvent;
  Object.defineProperty(e, 'dataTransfer', { value: { setData: (k: string, v: string) => { data[k] = v; }, effectAllowed: '' } });
  el.dispatchEvent(e);
  return data;
};

describe('builder palette', () => {
  async function setup() {
    const m = await mount(Palette, { providers: [BuilderStore] });
    const store = (m.cmp as Palette).store;
    store.load({ title: 'P', nodes: [] });
    await m.settle();
    return { m, store };
  }
  it('adds widgets and rows by click, and drags them with their data', async () => {
    const { m, store } = await setup();
    expect(m.all('.tile').length).toBe(27);
    await m.click(button(m.el, 'Heading', '.tile'));
    expect(store.doc().nodes.length).toBe(1);
    await m.click(button(m.el, 'Offers', '.tile.shop'));
    expect(store.selected()!.type).toBe('productOffers');
    expect(drag(m.all('.tile')[0])).toEqual({ 'application/x-os-widget': '{"type":"heading"}' });
    await m.click(m.all('.row')[1]);
    expect(store.doc().nodes.at(-1)!.children!.length).toBe(2);
    expect(drag(m.all('.row')[1])).toEqual({ 'application/x-os-section': '{"spans":[6,6]}' });
  });
  it('adds ready-made sections and fits their previews', async () => {
    const { m, store } = await setup();
    await m.click(button(m.el, 'Sections', 'nav button'));
    expect(m.all('.thumb').length).toBeGreaterThan(5);
    await m.click(m.all('.thumb')[0]);
    expect(store.doc().nodes.length).toBe(1);
    expect(drag(m.all('.thumb')[1])['application/x-os-section']).toContain('templateKey');
    const wrap = document.createElement('div');
    const frame = { contentDocument: { documentElement: { scrollHeight: 400 } }, parentElement: wrap };
    (m.cmp as Palette).fit({ target: frame } as unknown as Event);
    expect(wrap.style.height).toBe('84px');
    (m.cmp as Palette).fit({ target: { contentDocument: null, parentElement: wrap } } as unknown as Event);
    expect((m.cmp as Palette).svg('star')).toBe((m.cmp as Palette).svg('star'));
  });
  it('lists layers, selects, reorders, duplicates and deletes', async () => {
    const { m, store } = await setup();
    await m.click(button(m.el, 'Layers', 'nav button'));
    expect(m.text()).toContain('Nothing here yet');
    const a = newSection([12]), b = newSection([12]);
    a.children![0].children = [newWidget('heading')];
    b.children![0].children = [newWidget('text')];
    b.hide = ['mobile'];
    store.load({ title: 'P', nodes: [a, b] });
    await m.settle();
    expect(m.all('.lyr').length).toBe(6);
    expect(m.text('.tree')).toContain('hidden');
    expect(m.text('.tree')).toContain('A headline worth reading');
    await m.click(m.all('.lyr')[3]);
    expect(store.selectedId()).toBe(b.id);
    await m.click(m.all('.lyr')[3].querySelector('button[title="Move up"]') as HTMLElement);
    expect(store.doc().nodes[0].id).toBe(b.id);
    await m.click(m.all('.lyr')[0].querySelector('button[title="Move down"]') as HTMLElement);
    expect(store.doc().nodes[1].id).toBe(b.id);
    await m.click(m.all('.lyr')[0].querySelector('button[title="Duplicate"]') as HTMLElement);
    expect(store.doc().nodes.length).toBe(3);
    await m.click(m.all('.lyr')[0].querySelector('button[title="Delete"]') as HTMLElement);
    expect(store.doc().nodes.length).toBe(2);
  });
});

import { Injectable, computed, signal } from '@angular/core';
import { DEFAULT_THEME, cloneWithNewIds, newSection, newWidget, normTheme, normalizeDoc, uid } from '@openshop/renderer';
import type { Device, Node, NodeType, PageDoc, Style, Theme, WidgetType } from '@openshop/renderer';

export type Doc = PageDoc & { theme: Theme };
export type Pos = 'before' | 'after' | 'inside' | 'end';
export type Kind = 'widget' | 'section' | 'column';
export const kindOf = (t: NodeType): Kind => (t === 'section' ? 'section' : t === 'column' ? 'column' : 'widget');

export const NAMES: Record<NodeType, string> = {
  section: 'Section', column: 'Column', heading: 'Heading', text: 'Text', image: 'Image', button: 'Button', spacer: 'Spacer', divider: 'Divider',
  iconBox: 'Icon box', stat: 'Stat', testimonial: 'Testimonial', faq: 'FAQ', gallery: 'Gallery', productGrid: 'Products',
  productTitle: 'Product name', productPrice: 'Price', productDescription: 'Description', productGallery: 'Product photos', addToCart: 'Add to cart',
  searchBox: 'Search box', dynamicTitle: 'Page title', categoryNav: 'Categories',
};

interface Loc { list: Node[]; index: number; parent: Node | null }
function locate(nodes: Node[], id: string, parent: Node | null = null): Loc | null {
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].id === id) return { list: nodes, index: i, parent };
    const kids = nodes[i].children;
    if (kids) { const r = locate(kids, id, nodes[i]); if (r) return r; }
  }
  return null;
}
const contains = (n: Node, id: string): boolean => n.id === id || !!n.children?.some((c) => contains(c, id));
const equalShare = (count: number) => Math.max(1, Math.min(12, Math.floor(12 / Math.max(count, 1))));

function setPath(obj: any, path: string, value: unknown) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) { cur = cur[keys[i]]; if (cur == null) return; }
  cur[keys[keys.length - 1]] = value;
}

@Injectable()
export class BuilderStore {
  doc = signal<Doc>({ title: '', theme: DEFAULT_THEME, nodes: [] });
  selectedId = signal<string | null>(null);
  device = signal<Device>('desktop');
  preview = signal(false);
  dirty = signal(false);
  canUndo = signal(false);
  canRedo = signal(false);

  private past: string[] = [];
  private future: string[] = [];
  private lastKey = '';
  private lastAt = 0;

  selected = computed(() => { const id = this.selectedId(); return id ? this.find(id) : null; });
  /** Ancestors of the selected node, outermost first, including the node itself. */
  path = computed(() => {
    const id = this.selectedId(); if (!id) return [] as Node[];
    const walk = (ns: Node[], trail: Node[]): Node[] | null => {
      for (const n of ns) { const t = [...trail, n]; if (n.id === id) return t; const r = n.children && walk(n.children, t); if (r) return r; }
      return null;
    };
    return walk(this.doc().nodes, []) ?? [];
  });

  load(d: { title: string; theme?: Partial<Theme>; nodes: Node[] }) {
    this.doc.set({ title: d.title, theme: normTheme(d.theme), nodes: d.nodes });
    this.past = []; this.future = []; this.selectedId.set(null); this.dirty.set(false); this.syncFlags();
  }
  markSaved() { this.dirty.set(false); }

  find(id: string): Node | null { const l = locate(this.doc().nodes, id); return l ? l.list[l.index] : null; }
  parentOf(id: string): Node | null { return locate(this.doc().nodes, id)?.parent ?? null; }
  private syncFlags() { this.canUndo.set(this.past.length > 0); this.canRedo.set(this.future.length > 0); }

  private commit(fn: (d: Doc) => void, key = '') {
    const cur = this.doc();
    const before = JSON.stringify(cur);
    let draft = structuredClone(cur) as Doc;
    fn(draft);
    // Every change goes through the renderer's normaliser: defaults are filled in and invalid states can't enter the document.
    try { const n = normalizeDoc(draft); draft = { ...n, title: draft.title, theme: n.theme! } as Doc; } catch { return; }
    if (JSON.stringify(draft) === before) return;
    const now = Date.now();
    if (!(key && key === this.lastKey && now - this.lastAt < 900)) { this.past.push(before); if (this.past.length > 120) this.past.shift(); }
    this.lastKey = key; this.lastAt = now; this.future = [];
    this.doc.set(draft); this.dirty.set(true); this.syncFlags();
    const sel = this.selectedId(); if (sel && !this.find(sel)) this.selectedId.set(null);
  }

  undo() {
    const prev = this.past.pop(); if (!prev) return;
    this.future.push(JSON.stringify(this.doc())); this.doc.set(JSON.parse(prev)); this.lastKey = '';
    this.dirty.set(true); this.syncFlags();
    const sel = this.selectedId(); if (sel && !this.find(sel)) this.selectedId.set(null);
  }
  redo() {
    const next = this.future.pop(); if (!next) return;
    this.past.push(JSON.stringify(this.doc())); this.doc.set(JSON.parse(next)); this.lastKey = '';
    this.dirty.set(true); this.syncFlags();
    const sel = this.selectedId(); if (sel && !this.find(sel)) this.selectedId.set(null);
  }

  select(id: string | null) { this.selectedId.set(id); }

  // ---- placement ----
  private sectionOf(nodes: Node[], id: string): Loc | null {
    for (let i = 0; i < nodes.length; i++) if (contains(nodes[i], id)) return { list: nodes, index: i, parent: null };
    return null;
  }

  /** Puts `node` where the user dropped it. Returns the id that should end up selected, or null if the drop was invalid. */
  private put(d: Doc, node: Node, targetId: string | null, pos: Pos): string | null {
    const kind = kindOf(node.type);
    const wrap = (n: Node): Node => {
      if (kindOf(n.type) !== 'widget') return n;
      const s = newSection([12]); s.children![0].children = [n]; return s;
    };
    if (kind === 'section' || kind === 'widget') {
      // widgets dropped at section level (or nowhere) get their own new section
      if (!targetId) { d.nodes.push(wrap(node)); return node.id; }
      const t = locate(d.nodes, targetId); if (!t) return null;
      const tn = t.list[t.index];
      if (kind === 'widget' && tn.type !== 'section' && tn.type !== 'column') {
        t.list.splice(pos === 'before' ? t.index : t.index + 1, 0, node); return node.id;
      }
      if (kind === 'widget' && tn.type === 'column') { (tn.children ??= []).push(node); return node.id; }
      const s = this.sectionOf(d.nodes, targetId)!;
      d.nodes.splice(pos === 'before' ? s.index : s.index + 1, 0, wrap(node)); return node.id;
    }
    // column
    if (!targetId) return null;
    const t = locate(d.nodes, targetId); if (!t || t.list[t.index].type !== 'column') return null;
    t.list.splice(pos === 'before' ? t.index : t.index + 1, 0, node); return node.id;
  }

  private cleanup(d: Doc) {
    d.nodes = d.nodes.filter((s) => (s.children?.length ?? 0) > 0);
  }

  insertNew(kind: Kind, item: any, targetId: string | null, pos: Pos) {
    let node: Node;
    if (kind === 'widget') node = newWidget(item.type as WidgetType);
    else if (kind === 'section') node = item.build ? item.build() : item.spans ? newSection(item.spans) : item;
    else return;
    let selectId: string | null = null;
    this.commit((d) => { selectId = this.put(d, node, targetId, pos); });
    if (selectId) this.selectedId.set(node.id);
  }

  /** Adds a widget to the selected column (or the last column on the page); used by click-to-add. */
  addWidget(type: WidgetType) {
    const sel = this.selected();
    let target: string | null = null, pos: Pos = 'end';
    if (sel?.type === 'column') { target = sel.id; pos = 'inside'; }
    else if (sel && sel.type !== 'section') { target = sel.id; pos = 'after'; }
    else if (sel?.type === 'section') { target = sel.children?.[0]?.id ?? null; pos = 'inside'; }
    this.insertNew('widget', { type }, target, pos);
  }
  addSectionTemplate(item: any) { this.insertNew('section', item, null, 'end'); }

  move(id: string, targetId: string | null, pos: Pos) {
    if (id === targetId) return;
    let ok = false;
    this.commit((d) => {
      const src = locate(d.nodes, id); if (!src) return;
      const node = src.list[src.index];
      if (targetId && contains(node, targetId)) return;
      src.list.splice(src.index, 1);
      const res = this.put(d, node, targetId, pos);
      if (!res) { src.list.splice(src.index, 0, node); return; }
      this.cleanup(d); ok = true;
    });
    if (ok) this.selectedId.set(id);
  }

  moveBy(id: string, delta: -1 | 1) {
    this.commit((d) => {
      const l = locate(d.nodes, id); if (!l) return;
      const j = l.index + delta; if (j < 0 || j >= l.list.length) return;
      [l.list[l.index], l.list[j]] = [l.list[j], l.list[l.index]];
    });
  }

  remove(id: string) {
    this.commit((d) => {
      const l = locate(d.nodes, id); if (!l) return;
      l.list.splice(l.index, 1);
      if (l.parent?.type === 'section' && l.parent.children!.length) { const share = equalShare(l.parent.children!.length); l.parent.children!.forEach((c) => (c.style = { ...c.style, span: share })); }
      this.cleanup(d);
    });
  }

  duplicate(id: string) {
    let copyId: string | null = null;
    this.commit((d) => {
      const l = locate(d.nodes, id); if (!l) return;
      const copy = cloneWithNewIds(l.list[l.index]);
      l.list.splice(l.index + 1, 0, copy); copyId = copy.id;
    });
    if (copyId) this.selectedId.set(copyId);
  }

  // ---- editing ----
  setProp(id: string, path: string, value: unknown) {
    this.commit((d) => { const n = this.findIn(d, id); if (n) setPath(n.props, path, value); }, `prop:${id}:${path}`);
  }
  addItem(id: string, key: string, item: unknown) {
    this.commit((d) => { const n = this.findIn(d, id); if (n) ((n.props[key] as unknown[]) ??= []).push(item); });
  }
  removeItem(id: string, key: string, index: number) {
    this.commit((d) => { const n = this.findIn(d, id); if (n) (n.props[key] as unknown[]).splice(index, 1); });
  }
  private findIn(d: Doc, id: string): Node | null { const l = locate(d.nodes, id); return l ? l.list[l.index] : null; }

  /** Writes style values at one device. `undefined` removes the override, so the value falls back to the wider device. */
  setStyle(id: string, device: Device, patch: Record<string, unknown>) {
    const key = `style:${id}:${device}:${Object.keys(patch).join(',')}`;
    this.commit((d) => {
      const n = this.findIn(d, id); if (!n) return;
      const target: Record<string, unknown> = device === 'desktop' ? (n.style as Record<string, unknown>) : (((n.responsive ??= {}) as Record<string, Style>)[device] ??= {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete target[k]; else target[k] = v; }
      if (n.responsive) {
        for (const dev of ['tablet', 'mobile'] as const) if (n.responsive[dev] && !Object.keys(n.responsive[dev]!).length) delete n.responsive[dev];
        if (!Object.keys(n.responsive).length) delete n.responsive;
      }
    }, key);
  }
  resetStyle(id: string, device: Device) {
    this.commit((d) => {
      const n = this.findIn(d, id); if (!n) return;
      if (device === 'desktop') n.style = {}; else if (n.responsive) { delete n.responsive[device]; if (!Object.keys(n.responsive).length) delete n.responsive; }
    });
  }
  toggleHide(id: string, device: Device) {
    this.commit((d) => {
      const n = this.findIn(d, id); if (!n) return;
      const set = new Set(n.hide ?? []); set.has(device) ? set.delete(device) : set.add(device);
      n.hide = (['desktop', 'tablet', 'mobile'] as Device[]).filter((x) => set.has(x));
      if (!n.hide.length) delete n.hide;
    });
  }

  /** Changes how many columns a section has. Content of removed columns moves into the last remaining one. */
  setLayout(sectionId: string, spans: number[]) {
    this.commit((d) => {
      const s = this.findIn(d, sectionId); if (!s || s.type !== 'section') return;
      const cols = s.children ?? [];
      const next: Node[] = spans.map((span, i) => {
        const existing = cols[i];
        return existing ? { ...existing, style: { ...existing.style, span } } : { id: uid(), type: 'column', props: {}, style: { span }, children: [] };
      });
      for (const extra of cols.slice(spans.length)) next[next.length - 1].children = [...(next[next.length - 1].children ?? []), ...(extra.children ?? [])];
      s.children = next;
    });
  }

  setTitle(title: string) { this.commit((d) => { d.title = title; }, 'title'); }
  setTheme(patch: Partial<Theme>) { this.commit((d) => { d.theme = { ...d.theme, ...patch }; }, `theme:${Object.keys(patch).join(',')}`); }
  replaceAll(theme: Partial<Theme>, nodes: Node[]) { this.commit((d) => { d.theme = normTheme(theme); d.nodes = nodes; }); this.selectedId.set(null); }

  /** Value of a style key as seen at `device`, plus whether this device sets it itself. */
  styleAt(n: Node, device: Device, key: keyof Style): { value: unknown; own: boolean } {
    const chain: (Style | undefined)[] = [n.style, device !== 'desktop' ? n.responsive?.tablet : undefined, device === 'mobile' ? n.responsive?.mobile : undefined];
    let value: unknown, own = false;
    chain.forEach((s, i) => { if (s && key in s) { value = (s as Record<string, unknown>)[key]; own = (device === 'desktop' && i === 0) || (device === 'tablet' && i === 1) || (device === 'mobile' && i === 2); } });
    return { value, own };
  }
}

export const snippet = (n: Node): string => {
  const p = n.props as Record<string, any>;
  const raw = p['text'] ?? p['title'] ?? p['label'] ?? p['quote'] ?? p['value'] ?? '';
  return typeof raw === 'string' ? raw.slice(0, 28) : '';
};

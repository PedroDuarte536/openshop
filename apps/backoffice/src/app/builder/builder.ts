import { Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild, computed, effect, inject, input, signal, untracked, ViewEncapsulation } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DomSanitizer } from '@angular/platform-browser';
import { SECTION_TEMPLATES, renderParts } from '@openshop/renderer';
import type { Device, Node, ProductCard } from '@openshop/renderer';
import { ApiService, Product, Category } from '../api.service';
import { BuilderStore } from './store';
import { Palette } from './palette';
import { Inspector } from './inspector';

const WIDTH: Record<Device, number> = { desktop: 1280, tablet: 820, mobile: 390 };
const SKELETON = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style id="os-css"></style></head><body class="os os-editor"><div id="os-head"></div><main id="os-root"></main><script src="/builder-frame.js"></script></body></html>`;
const BLANK = `<div class="os-blank" data-blank="1"><b>Your page is empty</b><br>Drag a widget or a section here, or open the Sections tab for ready-made starting points.</div>`;

declare global { interface Window { osBuilderHost?: unknown } }

@Component({
  selector: 'app-builder',
  imports: [RouterLink, Palette, Inspector],
  providers: [BuilderStore],
  encapsulation: ViewEncapsulation.None,
  styleUrl: './builder.css',
  template: `
    <div class="bld" [class.preview]="store.preview()">
      <header class="bar">
        <a class="back" routerLink="/pages" title="Back to pages">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m15 6-6 6 6 6"/></svg>
        </a>
        <div class="logo"><i></i><b>OpenShop</b></div>
        <input class="title" [value]="doc().title" (input)="store.setTitle($any($event.target).value)" aria-label="Page title" placeholder="Page title">
        <div class="devices" role="group" aria-label="Preview size">
          @for (d of deviceBtns; track d.v) {
            <button [class.on]="store.device() === d.v" (click)="store.device.set(d.v)" [title]="d.label + ' (' + d.w + 'px)'" [attr.aria-label]="d.label" [innerHTML]="d.icon"></button>
          }
        </div>
        <div class="acts">
          <button class="ib" [disabled]="!store.canUndo()" (click)="store.undo()" title="Undo (Ctrl+Z)" aria-label="Undo">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>
          </button>
          <button class="ib" [disabled]="!store.canRedo()" (click)="store.redo()" title="Redo (Ctrl+Shift+Z)" aria-label="Redo">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/></svg>
          </button>
          <button class="ib" [class.on]="store.preview()" (click)="store.preview.set(!store.preview())" title="Preview without editing tools" aria-label="Preview">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
          <span class="status" [class.warn]="status() === 'error'">{{ statusText() }}</span>
          @if (!systemLabel() && slug() && !store.dirty() && status() === 'saved') { <a class="live" [href]="'/s/' + slug()" target="_blank" rel="noopener">View live page</a> }
          <button class="publish" (click)="save()" [disabled]="status() === 'saving'">{{ status() === 'saving' ? 'Publishing…' : 'Publish' }}</button>
        </div>
      </header>

      <aside class="left"><os-palette /></aside>

      <section class="stage-wrap" #wrap (click)="onBackdrop($event)">
        <div class="stage" [style.width.px]="stageW()">
          <div class="chrome"><span></span><span></span><span></span>
            @if (systemLabel()) { <em class="sys" title="This page has a fixed address">{{ systemLabel() }}</em> }
            @else { <label class="addr" title="The web address of this page"><b>/s/</b><input [value]="slug()" (input)="onSlug($any($event.target).value)" spellcheck="false" aria-label="Page address"></label> }
            <small>{{ WIDTH[store.device()] }}px</small></div>
          <div class="vp" [style.height.px]="vpH()">
            <iframe #frame title="Page canvas" [style.width.px]="WIDTH[store.device()]" [style.height.px]="vpH() / scale()" [style.transform]="'scale(' + scale() + ')'" (load)="onLoad()"></iframe>
          </div>
        </div>
      </section>

      <aside class="right"><os-inspector /></aside>
    </div>
  `,
})
export class Builder implements OnInit, OnDestroy {
  id = input.required<string>();
  store = inject(BuilderStore);
  private api = inject(ApiService);
  private san = inject(DomSanitizer);
  @ViewChild('frame', { static: true }) frame!: ElementRef<HTMLIFrameElement>;
  @ViewChild('wrap', { static: true }) wrap!: ElementRef<HTMLElement>;

  WIDTH = WIDTH;
  doc = this.store.doc;
  slug = signal('');
  system = signal<string | null>(null);
  errorMsg = signal('');
  cats = signal<Category[]>([]);
  systemLabel = computed(() => ({ product: 'Product page · every product', category: 'Category page · every category', search: 'Search page · every search' } as Record<string, string>)[this.system() ?? ''] ?? '');
  status = signal<'idle' | 'saving' | 'saved' | 'error'>('idle');
  products = signal<Product[]>([]);
  ready = signal(false);
  avail = signal({ w: 900, h: 600 });
  private trust = (h: string) => this.san.bypassSecurityTrustHtml(h);
  deviceBtns = [
    { v: 'desktop' as Device, label: 'Desktop', w: 1280, icon: this.trust('<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>') },
    { v: 'tablet' as Device, label: 'Tablet', w: 820, icon: this.trust('<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M11 18h2"/></svg>') },
    { v: 'mobile' as Device, label: 'Mobile', w: 390, icon: this.trust('<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/></svg>') },
  ];

  scale = computed(() => Math.min(1, (this.avail().w - 64) / WIDTH[this.store.device()]));
  stageW = computed(() => Math.round(WIDTH[this.store.device()] * this.scale()));
  vpH = computed(() => Math.max(300, this.avail().h - 40 - 56));
  statusText = computed(() => ({ idle: this.store.dirty() ? 'Unpublished changes' : 'Up to date', saving: 'Publishing…', saved: this.store.dirty() ? 'Unpublished changes' : 'Published', error: this.errorMsg() || 'Could not publish' })[this.status()]);

  private lastHead = '';
  private lastBody = '';
  private lastCss = '';
  private resize?: ResizeObserver;

  /** Resolves product grids against the live catalogue, just like the published page does. */
  private resolver = computed(() => {
    const all = this.products();
    return (n: Node): ProductCard[] => {
      const p = n.props as { categoryId?: string; limit?: number };
      return all.filter((x) => x.active && (!p.categoryId || x.categoryId === p.categoryId)).slice(0, p.limit ?? 4)
        .map((x) => ({ id: x.id, name: x.name, price: x.price, image: x.images?.[0], href: `/shop/product/${x.id}` }));
    };
  });
  private parts = computed(() => {
    const preview = this.store.preview();
    const catalogue = this.products().length > 0;
    try { return renderParts(this.store.doc(), { editor: !preview, products: catalogue ? this.resolver() : undefined, context: this.cats().length ? { categories: this.cats().map((c) => ({ name: c.name, slug: c.slug })) } : undefined }); } catch { return null; }
  });

  constructor() {
    window.osBuilderHost = {
      select: (id: string | null) => this.store.select(id),
      hover: (_id: string | null) => {},
      edit: (id: string, path: string, v: string) => this.store.setProp(id, path, v),
      drop: (e: any) => this.onDrop(e),
      action: (name: string, id: string) => this.onAction(name, id),
      key: (k: { key: string; mod: boolean; shift: boolean }) => this.onKey(k),
    };
    effect(() => {
      const parts = this.parts(); const ready = this.ready(); const sel = this.store.selectedId(); const preview = this.store.preview();
      if (!ready) return;
      untracked(() => this.apply(parts, sel, preview));
    });
    window.addEventListener('beforeunload', this.beforeUnload);
  }

  ngOnInit() {
    this.frame.nativeElement.srcdoc = SKELETON;
    this.api.categories().subscribe({ next: (c) => this.cats.set(c), error: () => {} });
    this.api.page(this.id()).subscribe((p) => { this.slug.set(p.slug); this.system.set(p.system ?? null); this.store.load({ title: p.title, theme: p.theme, nodes: p.nodes ?? [] }); });
    this.api.products().subscribe({ next: (p) => this.products.set(p), error: () => {} });
    this.resize = new ResizeObserver(([e]) => this.avail.set({ w: e.contentRect.width, h: e.contentRect.height }));
    this.resize.observe(this.wrap.nativeElement);
  }
  ngOnDestroy() { this.resize?.disconnect(); delete window.osBuilderHost; window.removeEventListener('beforeunload', this.beforeUnload); }
  private beforeUnload = (e: BeforeUnloadEvent) => { if (this.store.dirty()) e.preventDefault(); };

  onLoad() { this.ready.set(true); this.lastBody = this.lastHead = this.lastCss = ''; }

  private apply(parts: ReturnType<typeof renderParts> | null, sel: string | null, preview: boolean) {
    const win = this.frame.nativeElement.contentWindow as (Window & { osEditor?: any }) | null;
    const d = win?.document;
    if (!win || !d || !d.getElementById('os-root')) return;
    if (parts) {
      if (parts.css !== this.lastCss) { d.getElementById('os-css')!.textContent = parts.css; this.lastCss = parts.css; }
      if (parts.head !== this.lastHead) { d.getElementById('os-head')!.innerHTML = parts.head; this.lastHead = parts.head; }
      const body = parts.body || (preview ? '' : BLANK);
      if (body !== this.lastBody) { d.getElementById('os-root')!.innerHTML = body; this.lastBody = body; }
    }
    d.body.classList.toggle('os-editor', !preview);
    win.osEditor?.setMode(preview ? 'preview' : 'edit');
    win.osEditor?.setSelected(preview ? null : sel);
  }

  // ---- host API used by the canvas ----
  private onDrop(e: { kind: 'widget' | 'section' | 'column'; move: string | null; item: any; targetId: string | null; pos: any }) {
    if (e.move) { this.store.move(e.move, e.targetId, e.pos); return; }
    let item = e.item;
    if (e.kind === 'section' && item?.templateKey) { const t = SECTION_TEMPLATES.find((x) => x.key === item.templateKey); if (!t) return; item = { build: () => t.build() }; }
    if (!item) return;
    this.store.insertNew(e.kind, item, e.targetId, e.pos);
  }
  private onAction(name: string, id: string) {
    const s = this.store;
    if (name === 'parent') { const p = s.parentOf(id); if (p) s.select(p.id); }
    else if (name === 'up') s.moveBy(id, -1); else if (name === 'down') s.moveBy(id, 1);
    else if (name === 'duplicate') s.duplicate(id); else if (name === 'delete') s.remove(id);
  }
  private onKey(k: { key: string; mod: boolean; shift: boolean }): boolean {
    const s = this.store, key = k.key.toLowerCase();
    if (k.mod && key === 'z') { k.shift ? s.redo() : s.undo(); return true; }
    if (k.mod && key === 'y') { s.redo(); return true; }
    if (k.mod && key === 's') { this.save(); return true; }
    const sel = s.selectedId();
    if (k.mod && key === 'd' && sel) { s.duplicate(sel); return true; }
    if ((k.key === 'Delete' || k.key === 'Backspace') && sel) { s.remove(sel); return true; }
    if (k.key === 'Escape') { if (s.preview()) s.preview.set(false); else s.select(null); return true; }
    return false;
  }

  @HostListener('window:keydown', ['$event'])
  onWindowKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); this.save(); }
      return;
    }
    if (this.onKey({ key: e.key, mod: e.ctrlKey || e.metaKey, shift: e.shiftKey })) e.preventDefault();
  }

  onSlug(v: string) {
    const clean = v.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+/, '').slice(0, 80);
    if (clean === this.slug()) return;
    this.slug.set(clean); this.store.dirty.set(true); this.status.set('idle'); this.errorMsg.set('');
  }

  onBackdrop(e: MouseEvent) { if ((e.target as HTMLElement).classList.contains('stage-wrap')) this.store.select(null); }

  save() {
    if (this.status() === 'saving') return;
    const d = this.store.doc();
    if (!this.systemLabel() && !this.slug()) { this.status.set('error'); this.errorMsg.set('Give the page an address first'); return; }
    this.status.set('saving'); this.errorMsg.set('');
    this.api.savePage(this.id(), { slug: this.slug(), title: d.title, theme: d.theme, nodes: d.nodes }).subscribe({
      next: () => { this.store.markSaved(); this.status.set('saved'); },
      error: (e) => { this.status.set('error'); this.errorMsg.set(e.status === 409 ? 'That address is already used by another page' : ''); },
    });
  }
}

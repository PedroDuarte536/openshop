import { Component, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { LAYOUTS, SECTION_TEMPLATES, WIDGETS, iconSvg, renderPage } from '@openshop/renderer';
import type { Node, WidgetType } from '@openshop/renderer';
import { BuilderStore, NAMES, snippet } from './store';

@Component({
  selector: 'os-palette',
  imports: [NgTemplateOutlet],
  template: `
    <nav class="ptabs">
      <button [class.on]="tab() === 'add'" (click)="tab.set('add')">Add</button>
      <button [class.on]="tab() === 'sections'" (click)="tab.set('sections')">Sections</button>
      <button [class.on]="tab() === 'layers'" (click)="tab.set('layers')">Layers</button>
    </nav>
    <div class="pbody">
      @switch (tab()) {
        @case ('add') {
          <section class="grp">
            <h4>Widgets <small>drag onto the page</small></h4>
            <div class="tiles">
              @for (w of basic; track w.type) {
                <button class="tile" draggable="true" (dragstart)="dragWidget($event, w.type)" (click)="store.addWidget(w.type)" [title]="w.hint">
                  <span class="ti" [innerHTML]="svg(w.icon)"></span>
                  <b>{{ w.label }}</b>
                  <small>{{ w.hint }}</small>
                </button>
              }
            </div>
          </section>
          <section class="grp">
            <h4>Shop widgets <small>fill with real data</small></h4>
            <div class="tiles">
              @for (w of shop; track w.type) {
                <button class="tile shop" draggable="true" (dragstart)="dragWidget($event, w.type)" (click)="store.addWidget(w.type)" [title]="w.hint">
                  <span class="ti" [innerHTML]="svg(w.icon)"></span>
                  <b>{{ w.label }}</b>
                  <small>{{ w.hint }}</small>
                </button>
              }
            </div>
          </section>
          <section class="grp">
            <h4>Rows <small>pick a column layout</small></h4>
            <div class="rows">
              @for (l of layouts; track l.label) {
                <button class="row" draggable="true" (dragstart)="dragSection($event, { spans: l.spans })" (click)="store.addSectionTemplate({ spans: l.spans })" [title]="l.label">
                  @for (s of l.spans; track $index) { <i [style.flex]="s"></i> }
                </button>
              }
            </div>
          </section>
        }
        @case ('sections') {
          <p class="note tiny">Ready-made sections in your current colours and fonts. Drag one into the page, or click to add it at the end.</p>
          <div class="thumbs">
            @for (t of thumbs(); track t.key) {
              <div class="thumb" draggable="true" (dragstart)="dragSection($event, { templateKey: t.key })" (click)="addTemplate(t.key)">
                <div class="thumb-vp"><iframe tabindex="-1" scrolling="no" [srcdoc]="t.html" title="" (load)="fit($event)"></iframe></div>
                <div class="thumb-n">{{ t.name }}</div>
              </div>
            }
          </div>
        }
        @case ('layers') {
          @if (!store.doc().nodes.length) { <p class="note">Nothing here yet. Add a section from the other tabs.</p> }
          <ul class="tree">
            <ng-container [ngTemplateOutlet]="nodeTpl" [ngTemplateOutletContext]="{ list: store.doc().nodes, depth: 0 }" />
          </ul>
          <ng-template #nodeTpl let-list="list" let-depth="depth">
            @for (n of list; track n.id) {
              <li>
                <div class="lyr" [class.on]="store.selectedId() === n.id" [style.padding-left.px]="10 + depth * 14" (click)="store.select(n.id)">
                  <span class="lk" [class.sec]="n.type === 'section'" [class.col]="n.type === 'column'">{{ nm(n) }}</span>
                  <em>{{ snip(n) }}</em>
                  @if (n.hide?.length) { <span class="hid" title="Hidden on some screens">hidden</span> }
                  <span class="lact">
                    <button (click)="act($event, 'up', n)" title="Move up">↑</button>
                    <button (click)="act($event, 'down', n)" title="Move down">↓</button>
                    <button (click)="act($event, 'duplicate', n)" title="Duplicate">⧉</button>
                    <button (click)="act($event, 'delete', n)" title="Delete">✕</button>
                  </span>
                </div>
                @if (n.children?.length) { <ul><ng-container [ngTemplateOutlet]="nodeTpl" [ngTemplateOutletContext]="{ list: n.children, depth: depth + 1 }" /></ul> }
              </li>
            }
          </ng-template>
        }
      }
    </div>
  `,
})
export class Palette {
  store = inject(BuilderStore);
  private san = inject(DomSanitizer);
  tab = signal<'add' | 'sections' | 'layers'>('add');
  basic = WIDGETS.filter((w) => w.group === 'basic'); shop = WIDGETS.filter((w) => w.group === 'shop'); layouts = LAYOUTS; snip = snippet;
  nm(n: Node) { return NAMES[n.type]; }
  private cache = new Map<string, SafeHtml>();
  /** Live previews rendered by the real renderer, so thumbnails always match what ships. */
  private theme = computed(() => this.store.doc().theme, { equal: (a, b) => JSON.stringify(a) === JSON.stringify(b) });
  thumbs = computed(() => {
    const theme = this.theme();
    return SECTION_TEMPLATES.map((t) => ({ key: t.key, name: t.name, html: this.san.bypassSecurityTrustHtml(renderPage({ title: t.name, theme, nodes: [t.build()] })) }));
  });
  svg(k: string): SafeHtml { let s = this.cache.get(k); if (!s) { s = this.san.bypassSecurityTrustHtml(iconSvg(k as any)); this.cache.set(k, s); } return s; }

  dragWidget(e: DragEvent, type: WidgetType) {
    e.dataTransfer!.effectAllowed = 'copyMove';
    e.dataTransfer!.setData('application/x-os-widget', JSON.stringify({ type }));
  }
  dragSection(e: DragEvent, item: object) {
    e.dataTransfer!.effectAllowed = 'copyMove';
    e.dataTransfer!.setData('application/x-os-section', JSON.stringify(item));
  }
  /** Crops each preview to its real content height so short sections don't sit in a tall empty box. */
  fit(e: Event) {
    const f = e.target as HTMLIFrameElement;
    const h = f.contentDocument?.documentElement.scrollHeight;
    if (h && f.parentElement) f.parentElement.style.height = Math.min(190, Math.max(44, Math.round(h * 0.209))) + 'px';
  }
  addTemplate(key: string) { const t = SECTION_TEMPLATES.find((x) => x.key === key)!; this.store.addSectionTemplate({ build: () => t.build() }); }
  act(e: Event, what: string, n: Node) {
    e.stopPropagation();
    if (what === 'up') this.store.moveBy(n.id, -1); else if (what === 'down') this.store.moveBy(n.id, 1);
    else if (what === 'duplicate') this.store.duplicate(n.id); else this.store.remove(n.id);
  }
}

import { Component, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { ART, FONTS, THEMES, PAGE_TEMPLATES, LAYOUTS, buildDoc, iconSvg } from '@openshop/renderer';
import type { Background, Device, IconKey, Node, Style } from '@openshop/renderer';
import { ApiService, Category } from '../api.service';
import { BuilderStore, NAMES } from './store';
import { OsColor, OsSeg, OsSlider, OsSwitch } from './controls';
import { ARTS, ICONS, NOTES, PROP_FIELDS, Field } from './schema';

const SIZE_TYPES = ['heading', 'text', 'button', 'iconBox', 'stat', 'testimonial', 'faq'];
const WEIGHT_TYPES = ['heading', 'text', 'button', 'iconBox', 'stat'];
const DEVICES: { v: Device; label: string }[] = [{ v: 'desktop', label: 'Desktop' }, { v: 'tablet', label: 'Tablet' }, { v: 'mobile', label: 'Mobile' }];

@Component({
  selector: 'os-inspector',
  template: `
  @if (!sel()) {
    <div class="ins-h"><div class="ins-title">Page design</div><p class="ins-sub">Colours, type and shape for the whole page. Select anything on the canvas to edit it.</p></div>
    <div class="ins-b">
      <section class="grp">
        <h4>Starting points</h4>
        <div class="presets">
          @for (t of themeList; track t.key) {
            <button class="preset" [class.on]="false" (click)="store.setTheme(t.theme)" [title]="t.label">
              <span class="sw3"><i [style.background]="t.theme.primary"></i><i [style.background]="t.theme.accent"></i><i [style.background]="t.theme.surface"></i></span>
              <b>{{ t.label }}</b>
            </button>
          }
        </div>
      </section>
      <section class="grp">
        <h4>Colours</h4>
        <os-color label="Primary" [value]="theme().primary" [clearable]="false" [theme]="theme()" (change)="setThemeColor('primary', $event)" />
        <os-color label="Accent" [value]="theme().accent" [clearable]="false" [theme]="theme()" (change)="setThemeColor('accent', $event)" />
        <os-color label="Text" [value]="theme().text" [clearable]="false" [theme]="theme()" (change)="setThemeColor('text', $event)" />
        <os-color label="Background" [value]="theme().bg" [clearable]="false" [theme]="theme()" (change)="setThemeColor('bg', $event)" />
        <os-color label="Surface" [value]="theme().surface" [clearable]="false" [theme]="theme()" (change)="setThemeColor('surface', $event)" />
      </section>
      <section class="grp">
        <h4>Typography</h4>
        <div class="fonts">
          @for (f of fontList; track f.key) {
            <button class="font" [class.on]="theme().font === f.key" (click)="store.setTheme({ font: f.key })">
              <span class="aa" [style.font-family]="f.head">Aa</span>
              <span class="fn"><b>{{ f.label }}</b><small [style.font-family]="f.body">{{ f.sample }}</small></span>
            </button>
          }
        </div>
        <os-slider label="Corner roundness" [value]="theme().radius" [min]="0" [max]="32" (change)="store.setTheme({ radius: $event ?? 12 })" />
        <label class="field"><span>Currency symbol</span><input class="inp" maxlength="3" [value]="theme().currency" (input)="store.setTheme({ currency: $any($event.target).value })"></label>
      </section>
      <section class="grp">
        <h4>Replace with a template</h4>
        <div class="tpls">
          @for (t of pageTemplates; track t.key) {
            <button class="tpl" (click)="applyTemplate(t.key)" [class.armed]="armed() === t.key"><b>{{ t.name }}</b><small>{{ armed() === t.key ? 'Click again to replace everything' : t.blurb }}</small></button>
          }
        </div>
      </section>
    </div>
  } @else {
    @let n = sel()!;
    <div class="ins-h">
      <div class="crumbs">
        @for (p of store.path(); track p.id; let last = $last) {
          <button [class.on]="last" (click)="store.select(p.id)">{{ names[p.type] }}</button>@if (!last) { <span>/</span> }
        }
      </div>
      <div class="tabs2">
        <button [class.on]="tab() === 'content'" (click)="tab.set('content')">Content</button>
        <button [class.on]="tab() === 'style'" (click)="tab.set('style')">Style</button>
      </div>
    </div>
    <div class="ins-b">
      @if (tab() === 'content') {
        @if (n.type === 'section') {
          <section class="grp">
            <h4>Columns</h4>
            <div class="layouts">
              @for (l of layouts; track l.label) {
                <button class="lay" [class.on]="sameLayout(n, l.spans)" (click)="store.setLayout(n.id, l.spans)" [title]="l.label">
                  @for (s of l.spans; track $index) { <i [style.flex]="s"></i> }
                </button>
              }
            </div>
            <os-seg label="Content width" [value]="$any(n.props)['width']" [options]="[{ v: 'boxed', label: 'Boxed' }, { v: 'full', label: 'Edge to edge' }]" [resettable]="false" (change)="store.setProp(n.id, 'width', $event)" />
          </section>
        } @else if (n.type === 'column') {
          <p class="note">Drag widgets from the left into this column, or click one to add it here.</p>
        } @else if (fields().length === 0 && !note()) {
          <p class="note">Nothing to edit here. Use the Style tab for size and spacing.</p>
        }
        @if (note()) { <p class="note shopnote">{{ note() }}</p> }
        @for (f of fields(); track f.key) { <ng-container [ngTemplateOutlet]="fieldTpl" [ngTemplateOutletContext]="{ f: f, base: '', node: n }" /> }
      } @else {
        <div class="devbanner">
          <span>Styling for</span>
          <div class="seg sm">
            @for (d of devices; track d.v) { <button [class.on]="store.device() === d.v" (click)="store.device.set(d.v)">{{ d.label }}</button> }
          </div>
        </div>
        @if (store.device() !== 'desktop') {
          <p class="note tiny">Changes here only affect {{ store.device() }} screens and narrower. Anything you don't change is inherited from the wider screen.
            @if (hasOverrides(n)) { <button class="link" (click)="store.resetStyle(n.id, store.device())">Reset all {{ store.device() }} changes</button> }
          </p>
        }

        <section class="grp">
          <h4>Layout</h4>
          @if (n.type === 'column') {
            <os-slider label="Width (of 12)" [value]="num(n, 'span')" [min]="1" [max]="12" unit="/12" [own]="own(n, 'span')" (change)="set(n, { span: $event })" />
            <os-seg label="Stack" [value]="str(n, 'dir')" [own]="own(n, 'dir')" [options]="[{ v: 'col', label: 'Vertical' }, { v: 'row', label: 'Side by side' }]" (change)="set(n, { dir: $event })" />
          }
          @if (n.type === 'section' || n.type === 'column') {
            <os-seg label="Vertical alignment" [value]="str(n, 'valign')" [own]="own(n, 'valign')" [options]="[{ v: 'top', label: 'Top' }, { v: 'center', label: 'Middle' }, { v: 'bottom', label: 'Bottom' }]" (change)="set(n, { valign: $event })" />
            <os-slider label="Gap" [value]="num(n, 'gap')" [min]="0" [max]="120" [own]="own(n, 'gap')" (change)="set(n, { gap: $event })" />
          }
          @if (n.type === 'section') {
            <os-slider label="Content width" [value]="num(n, 'maxW')" [min]="320" [max]="1600" [step]="10" [placeholder]="1160" [own]="own(n, 'maxW')" (change)="set(n, { maxW: $event })" />
          } @else if (n.type !== 'column' && n.type !== 'spacer' && n.type !== 'divider') {
            <os-slider label="Max width" [value]="num(n, 'maxW')" [min]="120" [max]="1200" [step]="10" [own]="own(n, 'maxW')" (change)="set(n, { maxW: $event })" />
          }
          @if (n.type !== 'divider') {
            <os-slider [label]="n.type === 'spacer' ? 'Height' : 'Min height'" [value]="num(n, 'minH')" [min]="0" [max]="900" [step]="4" [own]="own(n, 'minH')" (change)="set(n, { minH: $event })" />
          }
        </section>

        <section class="grp">
          <h4>Spacing</h4>
          <div class="pad4">
            <os-slider label="Top" [value]="num(n, 'padT')" [max]="240" [own]="own(n, 'padT')" (change)="set(n, { padT: $event })" />
            <os-slider label="Bottom" [value]="num(n, 'padB')" [max]="240" [own]="own(n, 'padB')" (change)="set(n, { padB: $event })" />
            @if (n.type === 'section' || n.type === 'column') {
              <os-slider label="Left" [value]="num(n, 'padL')" [max]="240" [own]="own(n, 'padL')" (change)="set(n, { padL: $event })" />
              <os-slider label="Right" [value]="num(n, 'padR')" [max]="240" [own]="own(n, 'padR')" (change)="set(n, { padR: $event })" />
            }
          </div>
          @if (n.type !== 'section') {
            <os-slider label="Space above" [value]="num(n, 'marT')" [max]="200" [own]="own(n, 'marT')" (change)="set(n, { marT: $event })" />
            <os-slider label="Space below" [value]="num(n, 'marB')" [max]="200" [own]="own(n, 'marB')" (change)="set(n, { marB: $event })" />
          }
        </section>

        <section class="grp">
          <h4>Text</h4>
          <os-seg label="Alignment" [value]="str(n, 'align')" [own]="own(n, 'align')" [options]="[{ v: 'left', label: 'Left' }, { v: 'center', label: 'Center' }, { v: 'right', label: 'Right' }]" (change)="set(n, { align: $event })" />
          @if (sizeTypes.includes(n.type)) { <os-slider label="Size" [value]="num(n, 'size')" [min]="10" [max]="160" [own]="own(n, 'size')" (change)="set(n, { size: $event })" /> }
          @if (weightTypes.includes(n.type)) {
            <os-seg label="Weight" [value]="num(n, 'weight')" [own]="own(n, 'weight')" [options]="[{ v: 400, label: 'Regular' }, { v: 500, label: 'Medium' }, { v: 700, label: 'Bold' }, { v: 800, label: 'Black' }]" (change)="set(n, { weight: $event })" />
          }
          <os-color label="Colour" [value]="str(n, 'color')" [own]="own(n, 'color')" [theme]="theme()" (change)="set(n, { color: $event })" />
        </section>

        <section class="grp">
          <h4>Background</h4>
          @let bg = bgOf(n);
          <os-seg [value]="bg?.kind" [own]="own(n, 'bg')" [resettable]="false"
            [options]="[{ v: 'none', label: 'None' }, { v: 'color', label: 'Colour' }, { v: 'gradient', label: 'Gradient' }, { v: 'preset', label: 'Artwork' }, { v: 'image', label: 'Photo' }]"
            (change)="setBgKind(n, $event)" />
          @switch (bg?.kind) {
            @case ('color') { <os-color label="Colour" [value]="bg?.color" [clearable]="false" [theme]="theme()" (change)="setBg(n, { color: $event })" /> }
            @case ('gradient') {
              <os-color label="From" [value]="bg?.from" [clearable]="false" [theme]="theme()" (change)="setBg(n, { from: $event })" />
              <os-color label="To" [value]="bg?.to" [clearable]="false" [theme]="theme()" (change)="setBg(n, { to: $event })" />
              <os-slider label="Angle" [value]="bg?.angle" [min]="0" [max]="360" unit="°" (change)="setBg(n, { angle: $event ?? 135 })" />
            }
            @case ('preset') {
              <div class="arts">
                @for (a of arts; track a.key) { <button class="art" [class.on]="bg?.preset === a.key" [style.background]="a.css" [title]="a.label" (click)="setBg(n, { preset: a.key })"></button> }
              </div>
            }
            @case ('image') {
              <ng-container [ngTemplateOutlet]="uploadTpl" [ngTemplateOutletContext]="{ value: bg?.image, set: bgImageSetter(n) }" />
              <os-slider label="Dark overlay" [value]="bg?.overlay" [min]="0" [max]="0.9" [step]="0.05" unit="" (change)="setBg(n, { overlay: $event ?? 0.35 })" />
            }
          }
        </section>

        <section class="grp">
          <h4>Shape and depth</h4>
          <os-slider label="Corner radius" [value]="num(n, 'radius')" [min]="0" [max]="80" [own]="own(n, 'radius')" (change)="set(n, { radius: $event })" />
          <os-seg label="Shadow" [value]="num(n, 'shadow')" [own]="own(n, 'shadow')" [options]="[{ v: 0, label: 'None' }, { v: 1, label: 'Soft' }, { v: 2, label: 'Lifted' }, { v: 3, label: 'Floating' }]" (change)="set(n, { shadow: $event })" />
        </section>

        <section class="grp">
          <h4>Motion and visibility</h4>
          <os-seg label="Appears with" [value]="str(n, 'anim')" [options]="[{ v: 'none', label: 'Nothing' }, { v: 'rise', label: 'Rise' }, { v: 'fade', label: 'Fade' }, { v: 'zoom', label: 'Zoom' }, { v: 'slide', label: 'Slide' }]" (change)="store.setStyle(n.id, 'desktop', { anim: $event })" />
          <p class="note tiny">Plays as the visitor scrolls. Browsers without support just show the content.</p>
          <div class="hides">
            @for (d of devices; track d.v) { <os-switch [label]="'Hide on ' + d.label.toLowerCase()" [value]="!!n.hide?.includes(d.v)" (change)="store.toggleHide(n.id, d.v)" /> }
          </div>
        </section>
      }
    </div>
  }

  <ng-template #fieldTpl let-f="f" let-node="node" let-base="base">
    @switch (f.kind) {
      @case ('text') { <label class="field"><span>{{ f.label }}</span><input class="inp" [value]="prop(node, base + f.key) ?? ''" (input)="setProp(node, base + f.key, $any($event.target).value)">@if (f.hint) { <small>{{ f.hint }}</small> }</label> }
      @case ('url') { <label class="field"><span>{{ f.label }}</span><input class="inp" placeholder="/shop or https://..." [value]="prop(node, base + f.key) ?? ''" (input)="setProp(node, base + f.key, $any($event.target).value)"></label> }
      @case ('textarea') { <label class="field"><span>{{ f.label }}</span><textarea class="inp" rows="4" [value]="prop(node, base + f.key) ?? ''" (input)="setProp(node, base + f.key, $any($event.target).value)"></textarea></label> }
      @case ('seg') { <os-seg [label]="f.label" [value]="prop(node, base + f.key) ?? ''" [options]="f.options" [resettable]="false" (change)="setProp(node, base + f.key, $event)" /> }
      @case ('select') {
        <label class="field"><span>{{ f.label }}</span>
          <select class="inp" (change)="setProp(node, base + f.key, $any($event.target).value)">
            @for (o of f.options; track o.v) { <option [value]="o.v" [selected]="o.v === prop(node, base + f.key)">{{ o.label }}</option> }
          </select>
        </label>
      }
      @case ('toggle') { <os-switch [label]="f.label" [value]="!!prop(node, base + f.key)" (change)="setProp(node, base + f.key, $event)" /> }
      @case ('number') { <os-slider [label]="f.label" [value]="prop(node, base + f.key) ?? ''" [min]="f.min ?? 0" [max]="f.max ?? 100" unit="" (change)="setProp(node, base + f.key, $event ?? f.min)" /> }
      @case ('icon') {
        <div class="field"><span>{{ f.label }}</span>
          <div class="icons">
            @for (i of icons; track i) { <button class="ico" [class.on]="prop(node, base + f.key) === i" [title]="i" [innerHTML]="svg(i)" (click)="setProp(node, base + f.key, i)"></button> }
          </div>
        </div>
      }
      @case ('image') {
        <div class="field"><span>{{ f.label }}</span>
          <ng-container [ngTemplateOutlet]="uploadTpl" [ngTemplateOutletContext]="{ value: prop(node, base + 'src'), set: propSetter(node, base + 'src') }" />
          <div class="arts">
            <button class="art none" [class.on]="!prop(node, base + 'art')" (click)="setProp(node, base + 'art', '')" title="No artwork">∅</button>
            @for (a of arts; track a.key) { <button class="art" [class.on]="prop(node, base + 'art') === a.key" [style.background]="a.css" [title]="a.label" (click)="setProp(node, base + 'art', a.key)"></button> }
          </div>
          <small>A photo wins over artwork. Remove the photo to use artwork.</small>
        </div>
      }
      @case ('category') {
        <label class="field"><span>{{ f.label }}</span>
          <select class="inp" (change)="setProp(node, base + f.key, $any($event.target).value)">
            <option value="" [selected]="!prop(node, base + f.key)">All products</option>
            @for (c of categories(); track c.id) { <option [value]="c.id" [selected]="c.id === prop(node, base + f.key)">{{ c.name }}</option> }
          </select>
          <small>Shows live products from your catalogue.</small>
        </label>
      }
      @case ('items') {
        <div class="field"><span>{{ f.label }}</span>
          @for (it of items(node, f.key); track $index; let i = $index) {
            <div class="item">
              <div class="item-h"><b>{{ i + 1 }}</b><button class="x" (click)="store.removeItem(node.id, f.key, i)" title="Remove">Remove</button></div>
              @for (sf of f.itemFields; track sf.key) {
                @if (sf.kind === 'image') {
                  <ng-container [ngTemplateOutlet]="uploadTpl" [ngTemplateOutletContext]="{ value: prop(node, f.key + '.' + i + '.src'), set: propSetter(node, f.key + '.' + i + '.src') }" />
                  <div class="arts sm">
                    @for (a of arts; track a.key) { <button class="art" [class.on]="prop(node, f.key + '.' + i + '.art') === a.key" [style.background]="a.css" (click)="setProp(node, f.key + '.' + i + '.art', a.key)"></button> }
                  </div>
                } @else {
                  <ng-container [ngTemplateOutlet]="fieldTpl" [ngTemplateOutletContext]="{ f: sf, base: f.key + '.' + i + '.', node: node }" />
                }
              }
            </div>
          }
          <button class="add" (click)="store.addItem(node.id, f.key, f.itemDefault)">+ {{ f.addLabel }}</button>
        </div>
      }
    }
  </ng-template>

  <ng-template #uploadTpl let-value="value" let-set="set">
    <div class="upl">
      @if (value) { <img [src]="value" alt=""> } @else { <span class="ph">No photo</span> }
      <div class="upl-b">
        <label class="btn2">Upload<input type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif" (change)="upload($event, set)"></label>
        @if (value) { <button class="btn2" (click)="set('')">Remove</button> }
      </div>
    </div>
    @if (uploadError()) { <small class="err">{{ uploadError() }}</small> }
  </ng-template>
  `,
  imports: [OsSlider, OsSeg, OsSwitch, OsColor, NgTemplateOutlet],
})
export class Inspector {
  store = inject(BuilderStore);
  private api = inject(ApiService);
  private san = inject(DomSanitizer);
  names = NAMES; devices = DEVICES; layouts = LAYOUTS; icons = ICONS; sizeTypes = SIZE_TYPES; weightTypes = WEIGHT_TYPES;
  pageTemplates = PAGE_TEMPLATES;
  themeList = Object.entries(THEMES).map(([key, v]) => ({ key, ...v }));
  fontList = (Object.keys(FONTS) as (keyof typeof FONTS)[]).map((key) => ({ key, ...FONTS[key], sample: { editorial: 'Warm and bookish', grotesk: 'Friendly and sharp', poster: 'Loud and modern', classic: 'Quiet and refined' }[key] }));
  arts = ARTS.map((key) => ({ key, ...ART[key] }));
  tab = signal<'content' | 'style'>('content');
  armed = signal('');
  categories = signal<Category[]>([]);
  uploadError = signal('');
  sel = this.store.selected;
  theme = computed(() => this.store.doc().theme);
  note = computed(() => { const n = this.sel(); return n ? NOTES[n.type] ?? '' : ''; });
  fields = computed<Field[]>(() => { const n = this.sel(); return n ? PROP_FIELDS[n.type] : []; });
  private icoCache = new Map<string, SafeHtml>();

  constructor() { this.api.categories().subscribe({ next: (c) => this.categories.set(c), error: () => {} }); }

  svg(k: string): SafeHtml { let s = this.icoCache.get(k); if (!s) { s = this.san.bypassSecurityTrustHtml(iconSvg(k as IconKey)); this.icoCache.set(k, s); } return s; }

  // ---- props ----
  prop(n: Node, path: string): any { return path.split('.').reduce((o: any, k) => (o == null ? undefined : o[k]), n.props); }
  setProp(n: Node, path: string, v: unknown) { this.store.setProp(n.id, path, v); }
  propSetter(n: Node, path: string) { return (v: unknown) => this.store.setProp(n.id, path, v); }
  items(n: Node, key: string): unknown[] { return (n.props[key] as unknown[]) ?? []; }
  sameLayout(n: Node, spans: number[]) { const c = n.children ?? []; return c.length === spans.length && c.every((x, i) => (x.style.span ?? 0) === spans[i]); }

  // ---- styles (device aware) ----
  num(n: Node, k: keyof Style): number | undefined { return this.store.styleAt(n, this.store.device(), k).value as number | undefined; }
  str(n: Node, k: keyof Style): string | undefined { return this.store.styleAt(n, this.store.device(), k).value as string | undefined; }
  own(n: Node, k: keyof Style): boolean { return this.store.device() !== 'desktop' && this.store.styleAt(n, this.store.device(), k).own; }
  set(n: Node, patch: Record<string, unknown>) { this.store.setStyle(n.id, this.store.device(), patch); }
  hasOverrides(n: Node) { const r = n.responsive?.[this.store.device() as 'tablet' | 'mobile']; return !!r && Object.keys(r).length > 0; }

  bgOf(n: Node): Background | undefined { return this.store.styleAt(n, this.store.device(), 'bg').value as Background | undefined; }
  setBgKind(n: Node, kind: Background['kind']) {
    const t = this.theme();
    const base: Record<Background['kind'], Background> = {
      none: { kind: 'none' }, color: { kind: 'color', color: 'var(--surface)' }, gradient: { kind: 'gradient', from: t.primary, to: t.accent, angle: 135 },
      preset: { kind: 'preset', preset: 'aurora' }, image: { kind: 'image', image: '', overlay: 0.35 },
    };
    this.set(n, { bg: kind === 'none' && this.store.device() === 'desktop' ? undefined : base[kind] });
  }
  setBg(n: Node, patch: Partial<Background>) { this.set(n, { bg: { ...(this.bgOf(n) ?? { kind: 'none' }), ...patch } }); }
  bgImageSetter(n: Node) { return (v: string) => this.setBg(n, { image: v }); }

  setThemeColor(k: 'primary' | 'accent' | 'text' | 'bg' | 'surface', v: string | undefined) { if (v && /^#[0-9a-f]{6}$/i.test(v)) this.store.setTheme({ [k]: v }); }

  applyTemplate(key: string) {
    if (this.armed() !== key) { this.armed.set(key); setTimeout(() => this.armed.set(''), 3500); return; }
    const t = PAGE_TEMPLATES.find((x) => x.key === key)!;
    const d = buildDoc(t, this.store.doc().title);
    this.store.replaceAll(d.theme ?? {}, d.nodes); this.armed.set('');
  }

  upload(e: Event, set: (v: string) => void) {
    const input = e.target as HTMLInputElement; const file = input.files?.[0]; if (!file) return;
    this.uploadError.set('');
    this.api.upload(file).subscribe({ next: (r) => set(r.url), error: (err) => this.uploadError.set(err.error?.error ?? 'Upload failed') });
    input.value = '';
  }
}

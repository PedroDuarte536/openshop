import { Component, computed, inject, OnDestroy, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService, CatalogueLimits, ImportJob, ImportOptions, ImportRowView, NewPropertyType } from '../api.service';
import { UI } from '../config';

type Step = 'upload' | 'map' | 'preview' | 'applying' | 'done';
type Tab = 'create' | 'update' | 'error' | 'deleted' | 'unchanged';
const TAB_LABEL: Record<Tab, string> = { create: 'New', update: 'Changed', error: 'Problems', deleted: 'Deleted products', unchanged: 'Unchanged' };
const FIELD_NAMES: Record<string, string> = { categoryId: 'category', active: 'visible', variantGroupId: 'variant group', variantPosition: 'variant position' };

/**
 * Import products from a CSV or JSON file: upload -> match columns -> preview (nothing changes yet) -> apply.
 * Import never deletes products. Rows matching deleted products wait for the owner's decision.
 */
@Component({
  selector: 'app-product-import',
  imports: [FormsModule, RouterLink],
  template: `
    <a class="back-link" routerLink="/products">← Products</a>
    <header class="page-h"><div><h1>Import products</h1><p>From a spreadsheet (CSV) or an OpenShop backup (JSON). Nothing changes until you apply the import, and an import never deletes products.</p></div></header>
    <ol class="steps" aria-label="Steps">
      @for (s of stepList; track s.key) { <li [class.on]="step() === s.key" [class.done]="stepIndex(s.key) < stepIndex(step())">{{ s.label }}</li> }
    </ol>
    @if (error()) { <div class="alert" role="alert">{{ error() }}</div> }

    @switch (step()) {
      @case ('upload') {
        <section class="card pad">
          <label class="drop" [class.busy]="busy()">
            <input type="file" accept=".csv,.txt,.json,text/csv,application/json" (change)="choose($event)" [disabled]="busy()">
            <b>{{ busy() ? 'Reading the file…' : 'Choose a CSV or JSON file' }}</b>
            <small>Up to {{ limits().importMaxMb }} MB and {{ limits().importMaxRows.toLocaleString('en') }} products. Comma, semicolon or tab separated; UTF-8 or Excel (Windows) text. PrestaShop product exports are recognised.</small>
          </label>
          <p class="hint">Tip: <a routerLink="/products">export your catalogue</a> to get a file with the right columns, edit it, and import it back.</p>
        </section>
        @if (recent().length) {
          <section class="card block">
            <table class="tbl"><thead><tr><th>Recent imports</th><th>Status</th><th class="num">Rows</th><th></th></tr></thead>
              <tbody>@for (j of recent(); track j.id) {
                <tr><td><div class="cell-main">{{ j.filename }}</div><div class="cell-sub">{{ j.createdAt.slice(0, 16).replace('T', ' ') }}</div></td>
                  <td><span class="pill" [class.ok]="j.status === 'done'" [class.bad]="j.status === 'failed'" [class.warn]="j.status === 'interrupted'">{{ statusLabel(j.status) }}</span></td>
                  <td class="num">{{ j.rowCount }}</td>
                  <td><div class="acts">@if (j.status !== 'cancelled') { <button class="btn sm" (click)="open(j.id)">{{ j.status === 'done' ? 'Report' : j.status === 'interrupted' ? 'Resume' : 'Continue' }}</button> }</div></td></tr>
              }</tbody></table>
          </section>
        }
      }

      @case ('map') {
        @if (job(); as j) {
          <section class="card pad">
            <div class="sec-row"><h3>{{ j.filename }} · {{ j.rowCount }} {{ j.rowCount === 1 ? 'product' : 'products' }}</h3>
              @if (j.csv) { <small>{{ j.csv.delimiter === ';' ? 'semicolons' : j.csv.delimiter === ',' ? 'commas' : 'tabs' }}, decimal "{{ j.csv.decimal }}", {{ j.csv.encoding }}</small> }</div>
            @if (j.format === 'csv') {
              @if (j.presets?.length) {
                <label class="fld narrow-l"><span>File from</span>
                  <select class="inp" [ngModel]="j.preset ?? ''" (ngModelChange)="setPreset($event)" name="preset">
                    <option value="">Any spreadsheet</option>@for (p of j.presets!; track p.key) { <option [value]="p.key">{{ p.name }}</option> }
                  </select></label>
              }
              <table class="tbl mini map">
                <thead><tr><th>Column in your file</th><th>Examples</th><th>Goes to</th></tr></thead>
                <tbody>
                  @for (col of j.columns; track col) {
                    <tr>
                      <td class="cell-main">{{ col }}</td>
                      <td class="cell-sub ex">{{ examples(col) }}</td>
                      <td>
                        <select class="inp sm" [attr.aria-label]="'Column ' + col" [ngModel]="mapping[col]" (ngModelChange)="mapping[col] = $event">
                          <option value="ignore">Don't import</option>
                          <optgroup label="Product">@for (f of j.targets?.fields ?? []; track f.value) { <option [value]="f.value">{{ f.label }}</option> }</optgroup>
                          @if (j.targets?.properties?.length) { <optgroup label="Properties">@for (p of j.targets!.properties; track p.value) { <option [value]="p.value">{{ p.label }}</option> }</optgroup> }
                          <option [value]="newTarget(col)">New property "{{ newTarget(col).slice(4) }}"</option>
                        </select>
                        @if (mapping[col]?.startsWith('new:')) {
                          <select class="inp sm" [attr.aria-label]="'Type of ' + col" [ngModel]="newType(mapping[col])" (ngModelChange)="setNewType(mapping[col], $event)">
                            <option value="text">Text</option><option value="choice">One choice</option><option value="number">Number</option><option value="boolean">Yes / no</option>
                          </select>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            } @else { <p class="hint-top">An OpenShop catalogue (JSON): columns are matched automatically. Categories, properties and variant groups in the file are created when missing.</p> }
          </section>
          <section class="card pad block">
            <h3>Options</h3>
            <div class="fgrid">
              <label class="fld"><span>What to do</span><select class="inp" name="mode" [(ngModel)]="options.mode">
                <option value="upsert">Create new products and update existing ones</option><option value="update">Only update existing products</option><option value="create">Only create new products</option></select>
                <small>Existing products are found by their OpenShop id, then by SKU.</small></label>
              <label class="fld"><span>Products not in the file</span><select class="inp" name="missing" [(ngModel)]="options.missing">
                <option value="leave">Leave them as they are</option><option value="hide">Hide them from the shop</option></select>
                <small>An import never deletes products.</small></label>
              <label class="fld"><span>Empty cells</span><select class="inp" name="empty" [(ngModel)]="options.empty">
                <option value="leave">Leave the value unchanged</option><option value="clear">Clear the value</option></select></label>
              <label class="fld"><span>Stock</span><select class="inp" name="stock" [(ngModel)]="options.stock">
                <option value="set">Set stock from the file</option><option value="skip">Don't change stock</option></select></label>
              <label class="fld"><span>Photos from other websites (https://)</span><select class="inp" name="remoteImages" [(ngModel)]="options.remoteImages">
                <option value="download">Download a copy into the shop</option><option value="link">Keep them as links</option></select>
                <small>A copy keeps working if the other site changes, and visitors' browsers don't contact it.</small></label>
            </div>
            <label class="chk"><input type="checkbox" name="newVisible" [(ngModel)]="options.newVisible"> New products are visible in the shop (turn off to add them hidden; a "visible" column decides per product)</label>
            <label class="chk"><input type="checkbox" name="createCategories" [(ngModel)]="options.createCategories"> Create categories that don't exist yet</label>
            <label class="chk"><input type="checkbox" name="createProperties" [(ngModel)]="options.createProperties"> Create new properties (internal unless you tick them in the preview)</label>
            <label class="chk"><input type="checkbox" name="addChoiceValues" [(ngModel)]="options.addChoiceValues"> Add new values to choice properties (e.g. a new colour)</label>
            <label class="chk"><input type="checkbox" name="stopOnError" [(ngModel)]="options.stopOnError"> Don't apply anything if a row has a problem</label>
          </section>
          <div class="save-bar"><button class="btn" (click)="cancel()">Cancel import</button><button class="btn primary" [disabled]="busy()" (click)="runPreview()">{{ busy() ? 'Checking…' : 'Preview' }}</button></div>
        }
      }

      @case ('preview') {
        @if (job(); as j) {
          @if (j.preview; as pv) {
            <section class="kpis">
              <div class="kpi"><small>New</small><b>{{ pv.create }}</b></div>
              <div class="kpi"><small>Changed</small><b>{{ pv.update }}</b></div>
              <div class="kpi"><small>Unchanged</small><b>{{ pv.unchanged }}</b></div>
              <div class="kpi"><small>Problems</small><b [class.bad]="pv.errors > 0">{{ pv.errors }}</b><span class="muted">not imported</span></div>
              @if (pv.deletedMatches) { <div class="kpi"><small>Match deleted products</small><b>{{ pv.deletedMatches }}</b>@if (pv.undecided) { <span class="down">{{ pv.undecided }} to decide</span> }</div> }
            </section>
            @for (w of pv.warnings; track w) { <p class="warn-box">{{ w }}</p> }
            @if (pv.newProperties.length) {
              <section class="card pad block newprops" aria-labelledby="np-h">
                <h3 id="np-h">New properties</h3>
                <p class="hint-top">New properties are internal: only you see them. Tick the ones shoppers should see.@if (j.format === 'json') { A ticked property that was public in the file comes back with its settings from the file (filter, search, product page). }</p>
                <table class="tbl mini">
                  <thead><tr><th>Property</th><th>Type</th><th class="num">Products</th>@if (j.format === 'json') { <th>In the file</th> }<th>In the shop</th></tr></thead>
                  <tbody>
                    @for (p of pv.newProperties; track p.key) {
                      <tr>
                        <td>{{ p.label }}</td><td>{{ typeLabel(p.type) }}</td><td class="num">{{ p.values ?? 0 }}</td>
                        @if (j.format === 'json') { <td>{{ p.publicInFile ? 'Public' : 'Internal' }}</td> }
                        <td>@if (p.locked) { <span class="pill">Public: tells variants apart</span> }
                          @else { <label class="chk"><input type="checkbox" [checked]="p.public" [disabled]="busy()" (change)="setPublic(p.key, $any($event.target).checked)" [attr.aria-label]="'Public in the shop: ' + p.label"> Public</label> }</td>
                      </tr>
                    }
                  </tbody>
                </table>
                @if (publicInFileCount() > 0) { <p><button type="button" class="btn sm" [disabled]="busy()" (click)="publishAsInFile()">Make public what was public in the file ({{ publicInFileCount() }})</button></p> }
              </section>
            }
            @if (newOptionsText(); as t) { <p class="note-box">New values: {{ t }}</p> }
            @if (pv.newCategories.length) { <p class="note-box">New categories: {{ pv.newCategories.join(', ') }}</p> }
            @if (pv.toHide) { <p class="warn-box">{{ pv.toHide }} {{ pv.toHide === 1 ? 'product' : 'products' }} not in the file will be hidden.
              @if (pv.toHide > pv.catalogueSize / 2) { <label class="chk"><input type="checkbox" name="confirmHide" [(ngModel)]="confirmHide"> Yes, hide {{ pv.toHide }} of my {{ pv.catalogueSize }} products</label> }</p> }

            <div class="tabs" role="tablist">
              @for (t of tabs; track t) { <button role="tab" [attr.aria-selected]="tab() === t" [class.on]="tab() === t" (click)="setTab(t)">{{ tabLabel[t] }} <small>{{ count(t) }}</small></button> }
            </div>
            @if (tab() === 'deleted' && pv.undecided) {
              <div class="toolbar"><span class="hint-top">For all rows that match deleted products:</span>
                <button class="btn sm" (click)="decideAll('restore')">Restore them</button><button class="btn sm" (click)="decideAll('new')">Create new products</button><button class="btn sm" (click)="decideAll('skip')">Skip them</button></div>
            }
            <div class="card">
              @if (rows().length) {
                <table class="tbl mini rows">
                  <thead><tr><th class="num">Row</th><th>Product</th><th>{{ tab() === 'error' ? 'Problems' : tab() === 'deleted' ? 'Deleted product' : 'Details' }}</th></tr></thead>
                  <tbody>
                    @for (r of rows(); track r.row) {
                      <tr>
                        <td class="num">{{ r.row }}</td>
                        <td><div class="cell-main">{{ r.name ?? '—' }}</div>@if (r.sku) { <div class="cell-sub mono">{{ r.sku }}</div> }</td>
                        <td>
                          @for (e of r.errors; track $index) { <div class="ferr">{{ e.column ? e.column + ': ' : '' }}{{ e.message }}</div> }
                          @if (r.diff) { @for (d of diffList(r); track d.k) { <div class="diff"><b>{{ d.k }}</b>{{ ' ' }}<s class="was">{{ d.before }}</s>{{ ' → ' + d.after }}</div> } }
                          @for (w of r.warnings; track w) { <div class="cell-sub">⚠ {{ w }}</div> }
                          @if (r.deletedMatch; as dm) {
                            <div>Deleted product <b>{{ dm.name }}</b> (deleted {{ dm.deletedAt.slice(0, 10) }})</div>
                            <div class="seg small" role="group" [attr.aria-label]="'Row ' + r.row">
                              <button type="button" [class.on]="dm.decision === 'restore'" (click)="decide(r.row, 'restore')">Restore and update</button>
                              <button type="button" [class.on]="dm.decision === 'new'" (click)="decide(r.row, 'new')">Create a new product</button>
                              <button type="button" [class.on]="dm.decision === 'skip'" (click)="decide(r.row, 'skip')">Skip</button>
                            </div>
                          }
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
                @if (rowsTotal() > rows().length) { <p class="hint pad">Showing {{ rows().length }} of {{ rowsTotal() }}. Download the report for all rows.</p> }
              } @else { <div class="empty-state">Nothing here.</div> }
            </div>
            <div class="save-bar">
              <button class="btn" (click)="report()">Download report (CSV)</button>
              <button class="btn" (click)="back()">← Change columns or options</button>
              <button class="btn primary" [disabled]="!canApply()" (click)="apply()">Apply import</button>
            </div>
            @if (blocker(); as b) { <p class="hint right">{{ b }}</p> }
          }
        }
      }

      @case ('applying') {
        <section class="card pad"><h3>Applying the import…</h3>
          <div class="progress" role="progressbar" [attr.aria-valuenow]="pct()" aria-valuemin="0" aria-valuemax="100"><i [style.width.%]="pct()"></i></div>
          <p class="hint">{{ job()?.progress?.done ?? 0 }} of {{ job()?.progress?.total ?? job()?.rowCount }} rows. You can leave this page: the import continues.</p></section>
      }

      @case ('done') {
        @if (job(); as j) {
          <section class="card pad">
            @if (j.status === 'failed') { <div class="alert" role="alert">The import stopped: {{ j.error }}</div> }
            @else {
              <h3>Import finished</h3>
              @if (j.result; as r) {
                <section class="kpis small">
                  <div class="kpi"><small>Created</small><b>{{ r.created }}</b></div><div class="kpi"><small>Updated</small><b>{{ r.updated }}</b></div>
                  <div class="kpi"><small>Restored</small><b>{{ r.restored }}</b></div><div class="kpi"><small>Hidden</small><b>{{ r.hidden }}</b></div>
                  <div class="kpi"><small>Not imported</small><b>{{ r.failed + r.conflicts }}</b></div><div class="kpi"><small>Unchanged / skipped</small><b>{{ r.unchanged + r.skipped }}</b></div>
                </section>
                @if (r.conflicts) { <p class="warn-box">{{ r.conflicts }} {{ r.conflicts === 1 ? 'product was' : 'products were' }} changed or sold since your preview and {{ r.conflicts === 1 ? 'was' : 'were' }} not overwritten. Import the file again to apply {{ r.conflicts === 1 ? 'it' : 'them' }}.</p> }
              }
            }
            <p class="acts-h mt"><a class="btn primary" routerLink="/products">View products</a><button class="btn" (click)="report()">Download report (CSV)</button><button class="btn" (click)="restart()">Import another file</button></p>
          </section>
        }
      }
    }`,
})
export class ProductImport implements OnDestroy {
  private api = inject(ApiService);
  stepList: { key: Step; label: string }[] = [{ key: 'upload', label: 'File' }, { key: 'map', label: 'Columns' }, { key: 'preview', label: 'Preview' }, { key: 'done', label: 'Done' }];
  tabs: Tab[] = ['create', 'update', 'error', 'deleted', 'unchanged'];
  tabLabel = TAB_LABEL;
  step = signal<Step>('upload');
  job = signal<ImportJob | null>(null);
  recent = signal<ImportJob[]>([]);
  /** As configured on the server (the defaults until it answers). */
  limits = signal<CatalogueLimits>({ importMaxMb: 10, importMaxRows: 20000, uploadMaxMb: 5 });
  busy = signal(false); error = signal('');
  tab = signal<Tab>('create');
  rows = signal<ImportRowView[]>([]); rowsTotal = signal(0);
  mapping: Record<string, string> = {};
  newTypes: Record<string, NewPropertyType> = {};
  options: ImportOptions = { mode: 'upsert', missing: 'leave', empty: 'leave', stock: 'set', newVisible: true, createCategories: false, createProperties: true, addChoiceValues: true, stopOnError: false, remoteImages: 'download' };
  confirmHide = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  pct = computed(() => { const p = this.job()?.progress; return p && p.total ? Math.round((p.done / p.total) * 100) : 0; });

  constructor() {
    this.api.imports().subscribe((j) => this.recent.set(j));
    this.api.catalogueLimits().subscribe({ next: (l) => this.limits.set(l), error: () => undefined });
  }
  ngOnDestroy() { clearInterval(this.timer); }

  stepIndex(s: Step) { return ['upload', 'map', 'preview', 'applying', 'done'].indexOf(s); }
  statusLabel(s: string) { return ({ uploaded: 'Not previewed', previewed: 'Previewed', committing: 'Applying', done: 'Applied', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted' } as Record<string, string>)[s] ?? s; }
  private fail = (fallback: string) => (e: { error?: { error?: string; fields?: { field: string; message: string }[] } }) => {
    this.busy.set(false);
    const f = e.error?.fields;
    this.error.set(f?.length ? f.map((x) => `${x.field}: ${x.message}`).join(' · ') : e.error?.error ?? fallback);
  };

  choose(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.busy.set(true); this.error.set('');
    this.api.uploadImport(file).subscribe({ next: (j) => { input.value = ''; this.open(j.id); }, error: this.fail('The file could not be read.') });
  }

  open(id: string) {
    this.busy.set(true); this.error.set('');
    this.api.importJob(id).subscribe({
      next: (j) => {
        this.busy.set(false);
        this.load(j);
        if (j.status === 'done' || j.status === 'failed') this.step.set('done');
        else if (j.status === 'committing') this.watch();
        else if (j.status === 'previewed' || j.status === 'interrupted') { this.step.set('preview'); this.setTab(this.firstTab(j)); }
        else this.step.set('map');
      },
      error: this.fail('The import could not be opened.'),
    });
  }

  private load(j: ImportJob) {
    this.job.set(j);
    this.mapping = { ...j.mapping };
    this.newTypes = Object.fromEntries(Object.entries(j.newProperties ?? {}).map(([k, v]) => [k, v.type]));
    this.options = { remoteImages: 'download', ...j.options };
  }
  private firstTab(j: ImportJob): Tab {
    const pv = j.preview;
    return pv?.undecided ? 'deleted' : pv?.errors ? 'error' : pv?.create ? 'create' : pv?.update ? 'update' : 'unchanged';
  }

  examples(col: string) {
    return (this.job()?.sample ?? []).map((r) => String(r[col] ?? '')).filter(Boolean).slice(0, 3).map((v) => (v.length > 30 ? v.slice(0, 30) + '…' : v)).join(' · ');
  }
  /** The "new property" choice for a column: the server's suggestion, or the column name without "attr:". */
  newTarget(col: string) { const cur = this.mapping[col]; return cur?.startsWith('new:') ? cur : `new:${col.replace(/^attr:/i, '').trim()}`; }
  newType(target: string): NewPropertyType { return this.newTypes[target.slice(4)] ?? 'text'; }
  setNewType(target: string, t: NewPropertyType) { this.newTypes[target.slice(4)] = t; }
  setPreset(key: string) {
    const j = this.job();
    if (!j) return;
    this.api.configureImport(j.id, { preset: key || null }).subscribe({ next: (u) => this.open(u.id), error: this.fail('Could not change the file type.') });
  }

  runPreview() {
    const j = this.job();
    if (!j) return;
    this.busy.set(true); this.error.set('');
    const newProperties = Object.fromEntries(Object.values(this.mapping).filter((t) => t.startsWith('new:')).map((t) => [t.slice(4), { type: this.newTypes[t.slice(4)] ?? 'text' }]));
    const body = j.format === 'csv' ? { mapping: this.mapping, options: this.options, newProperties } : { options: this.options };
    this.api.configureImport(j.id, body).subscribe({
      next: () => this.api.previewImport(j.id).subscribe({
        next: (p) => { this.busy.set(false); this.job.set({ ...j, ...p }); this.step.set('preview'); this.setTab(this.firstTab(p)); },
        error: this.fail('The preview could not be made.'),
      }),
      error: this.fail('Please check the columns.'),
    });
  }

  count(t: Tab) {
    const pv = this.job()?.preview;
    if (!pv) return 0;
    return t === 'create' ? pv.create : t === 'update' ? pv.update : t === 'error' ? pv.errors : t === 'deleted' ? pv.deletedMatches : pv.unchanged;
  }
  setTab(t: Tab) {
    this.tab.set(t);
    const j = this.job();
    if (!j) return;
    this.api.importRows(j.id, { action: t, limit: String(UI.importPreviewRows) }).subscribe((r) => { this.rows.set(r.items); this.rowsTotal.set(r.total); });
  }
  diffList(r: ImportRowView) {
    const fmt = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? '(details)' : String(v));
    const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
    const propLabel = (key: string) => this.job()?.targets?.properties.find((p) => p.value === 'attr:' + key)?.label ?? this.job()?.preview?.newProperties.find((p) => p.key === key)?.label ?? key;
    return Object.entries(r.diff ?? {}).flatMap(([k, [b, a]]) => {
      // Properties: one line per property that changes, e.g. "Glaze finish — → satin".
      if (k === 'attributes' && (isObj(b) || isObj(a))) {
        const before = isObj(b) ? b : {}, after = isObj(a) ? a : {};
        return [...new Set([...Object.keys(before), ...Object.keys(after)])]
          .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
          .map((key) => ({ k: propLabel(key), before: fmt(before[key]), after: fmt(after[key]) }));
      }
      return [{ k: FIELD_NAMES[k] ?? k, before: fmt(b), after: fmt(a) }];
    });
  }
  newOptionsText() {
    const o = this.job()?.preview?.newOptions ?? {};
    return Object.entries(o).map(([k, v]) => `${k}: ${v.join(', ')}`).join(' · ');
  }

  typeLabel(t: string) { return ({ text: 'Text', choice: 'One choice', multi: 'Several choices', number: 'Number', boolean: 'Yes / no' } as Record<string, string>)[t] ?? t; }
  /** New properties that were public in the backup and aren't public yet. */
  publicInFileCount() { return (this.job()?.preview?.newProperties ?? []).filter((p) => p.publicInFile && !p.public).length; }
  setPublic(key: string, on: boolean) {
    const now = new Set((this.job()?.preview?.newProperties ?? []).filter((p) => p.public && !p.locked).map((p) => p.key));
    if (on) now.add(key); else now.delete(key);
    this.republish([...now]);
  }
  publishAsInFile() {
    this.republish((this.job()?.preview?.newProperties ?? []).filter((p) => !p.locked && (p.public || p.publicInFile)).map((p) => p.key));
  }
  /** The choice changes what the import creates, so the preview is made again (the commit must use it). */
  private republish(publish: string[]) {
    const j = this.job();
    if (!j) return;
    this.busy.set(true); this.error.set('');
    this.api.configureImport(j.id, { publish }).subscribe({
      next: () => this.api.previewImport(j.id).subscribe({
        next: (p) => { this.busy.set(false); this.job.set({ ...j, ...p }); this.setTab(this.tab()); },
        error: this.fail('The preview could not be made.'),
      }),
      error: this.fail('Could not save the choice.'),
    });
  }

  decide(row: number, d: 'restore' | 'new' | 'skip') { this.sendDecisions({ [String(row)]: d }); }
  decideAll(d: 'restore' | 'new' | 'skip') { this.sendDecisions({ all: d }); }
  private sendDecisions(decisions: Record<string, 'restore' | 'new' | 'skip'>) {
    const j = this.job();
    if (!j) return;
    this.api.decideImport(j.id, decisions).subscribe({ next: (p) => { this.job.set({ ...j, ...p }); this.setTab(this.tab()); }, error: this.fail('Could not save the choice.') });
  }

  blocker(): string {
    const pv = this.job()?.preview;
    if (!pv) return '';
    if (pv.undecided) return `Choose what to do with ${pv.undecided} ${pv.undecided === 1 ? 'row' : 'rows'} that match deleted products.`;
    if (this.options.stopOnError && pv.errors) return 'Some rows have problems and "don\'t apply anything if a row has a problem" is on.';
    if (pv.toHide > pv.catalogueSize / 2 && !this.confirmHide) return 'Confirm hiding the products that aren\'t in the file.';
    if (!pv.create && !pv.update && !pv.toHide) return 'Nothing to change.';
    return '';
  }
  canApply() { return !this.blocker(); }

  apply() {
    const j = this.job();
    if (!j?.preview) return;
    this.error.set('');
    this.api.commitImport(j.id, j.preview.at, this.confirmHide).subscribe({ next: (u) => { this.job.set({ ...j, ...u }); this.watch(); }, error: this.fail('The import could not be applied.') });
  }
  private watch() {
    this.step.set('applying');
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      const j = this.job();
      if (!j) return;
      this.api.importJob(j.id).subscribe((u) => {
        this.job.set(u);
        if (u.status !== 'committing') { clearInterval(this.timer); this.step.set('done'); }
      });
    }, UI.importPollMs);
  }
  report() { const j = this.job(); if (j) this.api.importReport(j.id).subscribe({ error: () => this.error.set('The report could not be downloaded.') }); }
  back() { this.step.set('map'); }
  cancel() {
    const j = this.job();
    if (!j) return;
    this.api.cancelImport(j.id).subscribe({ next: () => this.restart(), error: this.fail('Could not cancel.') });
  }
  restart() {
    this.job.set(null); this.step.set('upload'); this.rows.set([]); this.error.set(''); this.confirmHide = false;
    this.api.imports().subscribe((j) => this.recent.set(j));
  }
}

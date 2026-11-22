import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService, AttributeDef, AttributeType } from '../api.service';
import { UI } from '../config';

interface Opt { value?: string; label: string; swatch: string }
interface Form {
  label: string; key: string; type: AttributeType; unit: string; options: Opt[];
  visibility: 'public' | 'internal'; filterable: boolean; searchable: boolean; showOnProduct: boolean;
}
const TYPE_LABEL: Record<AttributeType, string> = { text: 'Text', choice: 'One choice', multi: 'Several choices', number: 'Number', boolean: 'Yes / no' };
const blank = (): Form => ({ label: '', key: '', type: 'choice', unit: '', options: [{ label: '', swatch: '' }], visibility: 'public', filterable: true, searchable: true, showOnProduct: true });

/** Product properties: defined once ("Colour", "Capacity"), filled in per product, optionally shown, filtered and searched. */
@Component({
  selector: 'app-properties',
  imports: [FormsModule, RouterLink],
  template: `
    <a class="back-link" routerLink="/products">← Products</a>
    <header class="page-h">
      <div><h1>Properties</h1><p>Describe products (colour, material, size…). Shoppers can filter by them; variants are told apart by them.</p></div>
      <button class="btn primary" (click)="openNew()">+ New property</button>
    </header>
    <div class="card">
      @if (items().length) {
        <table class="tbl">
          <thead><tr><th>Property</th><th>Type</th><th>In the shop</th><th class="num">Products</th><th></th></tr></thead>
          <tbody>
            @for (a of items(); track a.id) {
              <tr>
                <td><div class="cell-main">{{ a.label }}</div><div class="cell-sub"><span class="mono">{{ a.key }}</span>@if (a.origin) { · created by an import }@if (a.variantGroups?.length) { · tells variants apart in {{ a.variantGroups!.join(', ') }} }</div></td>
                <td>{{ typeLabel[a.type] }}@if (a.unit) { ({{ a.unit }}) }@if (a.options?.length) { <div class="cell-sub">{{ optionsText(a) }}</div> }</td>
                <td>@if (a.visibility === 'internal') { <span class="pill">Internal</span> } @else {
                  <span class="pill ok">Public</span> <div class="cell-sub">{{ flags(a) }}</div> }</td>
                <td class="num">{{ a.usedBy ?? 0 }}</td>
                <td><div class="acts"><button class="btn sm" (click)="edit(a)">Edit</button>
                  <button class="btn sm danger" [class.armed]="armed() === a.id" (click)="remove(a)">{{ armed() === a.id ? (a.usedBy ? 'Clear ' + a.usedBy + ' values and delete' : 'Click to confirm') : 'Delete' }}</button></div></td>
              </tr>
            }
          </tbody>
        </table>
      } @else if (!loading()) {
        <div class="empty-state"><b>No properties yet</b>Add colour, size, material… then fill them in on your products, or import them from a file.<br><br><button class="btn primary" (click)="openNew()">+ New property</button></div>
      }
    </div>
    @if (error()) { <p class="err" role="alert">{{ error() }}</p> }

    @if (open()) {
      <div class="drawer-back" (click)="open.set(false)"></div>
      <form class="drawer" (ngSubmit)="save()" role="dialog" aria-modal="true" [attr.aria-label]="editing() ? 'Edit property' : 'New property'">
        <div class="drawer-h"><h2>{{ editing() ? 'Edit property' : 'New property' }}</h2><button type="button" class="btn ghost sm" (click)="open.set(false)" aria-label="Close">✕</button></div>
        <div class="drawer-b">
          <label class="fld req"><span>Name</span><input class="inp" name="label" [(ngModel)]="f.label" required placeholder="e.g. Colour"></label>
          @if (!editing()) { <label class="fld"><span>Key</span><input class="inp mono" name="key" [(ngModel)]="f.key" placeholder="made from the name" maxlength="32"><small>Used in import files (attr:key) and shop filter addresses. Can't be changed later.</small></label> }
          <div class="fld"><span class="lbl">Type</span>
            <div class="seg">@for (t of types; track t) { <button type="button" [class.on]="f.type === t" (click)="f.type = t" [disabled]="!!editing() && (editing()!.usedBy ?? 0) > 0 && editing()!.type !== t">{{ typeLabel[t] }}</button> }</div>
            @if (editing() && (editing()!.usedBy ?? 0) > 0) { <small>The type can't change while products have a value.</small> }
          </div>
          @if (f.type === 'number') { <label class="fld narrow"><span>Unit</span><input class="inp" name="unit" [(ngModel)]="f.unit" maxlength="12" placeholder="e.g. ml"></label> }
          @if (f.type === 'choice' || f.type === 'multi') {
            <div class="fld"><span class="lbl">Values (in the order shoppers see them)</span>
              @for (o of f.options; track $index; let i = $index) {
                <div class="opt-row">
                  <input class="inp" [name]="'o' + i" [attr.data-opt]="i" [(ngModel)]="o.label" placeholder="e.g. Blue" aria-label="Value">
                  <input class="inp swatch" [name]="'s' + i" [attr.data-swatch]="i" [(ngModel)]="o.swatch" placeholder="#1f6feb" aria-label="Colour (optional)" maxlength="9">
                  @if (o.swatch) { <i class="sw-dot" [style.background]="o.swatch"></i> }
                  <button type="button" class="btn sm ghost" (click)="move(i, -1)" [disabled]="i === 0" aria-label="Move up">↑</button>
                  <button type="button" class="btn sm ghost" (click)="move(i, 1)" [disabled]="i === f.options.length - 1" aria-label="Move down">↓</button>
                  <button type="button" class="btn sm ghost" (click)="f.options.splice(i, 1)" aria-label="Remove value">✕</button>
                </div>
              }
              <button type="button" class="btn sm" (click)="f.options.push({ label: '', swatch: '' })">+ Add value</button>
              <small>The colour is optional: it shows as a swatch in filters and variant choices.</small>
            </div>
          }
          <label class="sw"><span><b>Public</b><small>Off: internal, only in the backoffice (never shown, filtered or searched in the shop)</small></span><input type="checkbox" name="pub" [ngModel]="f.visibility === 'public'" (ngModelChange)="f.visibility = $event ? 'public' : 'internal'" [disabled]="!!editing()?.variantGroups?.length"><i></i></label>
          @if (f.visibility === 'public') {
            <label class="sw"><span><b>Shown on the product page</b><small>In the "Details" widget</small></span><input type="checkbox" name="show" [(ngModel)]="f.showOnProduct"><i></i></label>
            <label class="sw"><span><b>Shoppers can filter by it</b><small>On category and search pages</small></span><input type="checkbox" name="filter" [(ngModel)]="f.filterable"><i></i></label>
            <label class="sw"><span><b>Found by the shop search</b></span><input type="checkbox" name="search" [(ngModel)]="f.searchable"><i></i></label>
          }
          @if (formError()) { <p class="err" role="alert">{{ formError() }}</p> }
        </div>
        <div class="drawer-f"><button type="button" class="btn" (click)="open.set(false)">Cancel</button><button class="btn primary" [disabled]="saving()">{{ saving() ? 'Saving…' : editing() ? 'Save changes' : 'Create property' }}</button></div>
      </form>
    }`,
})
export class Properties {
  private api = inject(ApiService);
  items = signal<AttributeDef[]>([]);
  loading = signal(true); saving = signal(false); error = signal(''); formError = signal(''); armed = signal('');
  open = signal(false); editing = signal<AttributeDef | null>(null);
  f: Form = blank();
  types: AttributeType[] = ['choice', 'multi', 'text', 'number', 'boolean'];
  typeLabel = TYPE_LABEL;

  constructor() { this.load(); }
  load() { this.api.attributes().subscribe({ next: (a) => { this.items.set(a); this.loading.set(false); }, error: () => { this.loading.set(false); this.error.set('Properties could not be loaded.'); } }); }
  optionsText(a: AttributeDef) { const o = a.options ?? []; return o.slice(0, 6).map((x) => x.label).join(', ') + (o.length > 6 ? ` and ${o.length - 6} more` : ''); }
  flags(a: AttributeDef) { return [a.showOnProduct && 'shown', a.filterable && 'filter', a.searchable && 'search'].filter(Boolean).join(' · ') || 'not shown'; }
  openNew() { this.editing.set(null); this.f = blank(); this.formError.set(''); this.open.set(true); }
  edit(a: AttributeDef) {
    this.editing.set(a); this.formError.set('');
    this.f = { label: a.label, key: a.key, type: a.type, unit: a.unit ?? '', options: (a.options ?? []).map((o) => ({ value: o.value, label: o.label, swatch: o.swatch ?? '' })), visibility: a.visibility, filterable: a.filterable, searchable: a.searchable, showOnProduct: a.showOnProduct };
    this.open.set(true);
  }
  move(i: number, d: number) { const o = this.f.options; [o[i], o[i + d]] = [o[i + d], o[i]]; }
  save() {
    const f = this.f, cur = this.editing();
    const options = f.type === 'choice' || f.type === 'multi' ? f.options.filter((o) => o.label.trim()).map((o) => ({ ...(o.value ? { value: o.value } : {}), label: o.label.trim(), swatch: o.swatch.trim() || null })) : undefined;
    const body = { label: f.label, type: f.type, ...(f.type === 'number' ? { unit: f.unit.trim() || null } : {}), ...(options ? { options } : {}), visibility: f.visibility, filterable: f.filterable, searchable: f.searchable, showOnProduct: f.showOnProduct };
    this.saving.set(true); this.formError.set('');
    (cur ? this.api.updateAttribute(cur.id, { ...body, version: cur.version }) : this.api.createAttribute({ ...body, ...(f.key.trim() ? { key: f.key.trim() } : {}) })).subscribe({
      next: () => { this.saving.set(false); this.open.set(false); this.load(); },
      error: (e) => { this.saving.set(false); const fl = (e.error?.fields ?? []) as { field: string; message: string }[]; this.formError.set(fl.length ? fl.map((x) => `${x.field}: ${x.message}`).join(' · ') : e.error?.error ?? 'Could not save.'); },
    });
  }
  remove(a: AttributeDef) {
    if (this.armed() !== a.id) { this.armed.set(a.id); setTimeout(() => { if (this.armed() === a.id) this.armed.set(''); }, UI.confirmMs); return; }
    this.api.deleteAttribute(a.id, (a.usedBy ?? 0) > 0).subscribe({ next: () => { this.armed.set(''); this.load(); }, error: (e) => { this.armed.set(''); this.error.set(e.error?.error ?? 'Could not delete.'); } });
  }
}

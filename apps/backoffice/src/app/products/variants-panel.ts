import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, ProductSummary, VariantGroupView } from '../api.service';
import { ProductPicker } from '../shared/product-picker';
import { VariantDialog } from './variant-dialog';
import { UI } from '../config';

const norm = (s: string) => s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

/** The variant group of the product being edited: its products and their values, with the actions on the group. */
@Component({
  selector: 'app-variants-panel',
  imports: [FormsModule, ProductPicker, VariantDialog],
  template: `
    @if (group(); as g) {
      <div class="sec-row"><b>{{ g.name }}</b><small>Told apart by {{ diffLabels() }}</small></div>
      @for (d of g.warnings.duplicates; track d) { <div class="alert" role="alert">{{ d }}</div> }
      @if (g.warnings.useless.length) { <p class="warn-box">{{ g.warnings.useless.join(', ') }}: the same value on every visible product.</p> }
      @if (g.warnings.unreachable.length) { <p class="warn-box">{{ unreachableText() }} can't be reached from the other variants by changing one property.</p> }
      <table class="tbl mini var-table">
        <thead><tr><th>Product</th>@for (d of g.differentiators; track d.key) { <th>{{ d.label }}</th> }<th class="num">Price</th><th class="num">Stock</th><th></th></tr></thead>
        <tbody>
          @for (m of g.members; track m.id; let i = $index) {
            <tr [class.me]="m.id === productId()">
              <td>{{ m.name }}@if (m.id === productId()) { <small> (this product)</small> }@if (m.deleted) { <span class="pill bad">deleted</span> } @else if (!m.active) { <span class="pill">hidden</span> }</td>
              @for (d of g.differentiators; track d.key) { <td>{{ m.values[d.key] }}</td> }
              <td class="num">€{{ m.price.toFixed(2) }}</td><td class="num">{{ m.available }}</td>
              <td><div class="acts">
                <button type="button" class="btn sm ghost" [disabled]="i === 0" (click)="move(i, -1)" [attr.aria-label]="'Move ' + m.name + ' up'">↑</button>
                <button type="button" class="btn sm ghost" [disabled]="i === g.members.length - 1" (click)="move(i, 1)" [attr.aria-label]="'Move ' + m.name + ' down'">↓</button>
                @if (m.id !== productId()) { <button type="button" class="btn sm" (click)="open.emit(m.id)">Edit</button> }
                <button type="button" class="btn sm ghost" (click)="remove(m.id)" [attr.aria-label]="'Remove ' + m.name + ' from the group'">Remove</button>
              </div></td>
            </tr>
          }
        </tbody>
      </table>
      <div class="var-actions">
        <app-product-picker [single]="true" placeholder="Add a product to this group" [params]="{ type: 'simple' }" [exclude]="memberIds()" (picked)="add($event)" />
        <div class="acts-h">
          <button type="button" class="btn sm" (click)="startVariant()">+ Add a variant</button>
          <button type="button" class="btn sm" (click)="editing.set(true)">Change properties</button>
          <button type="button" class="btn sm danger" [class.armed]="armed()" (click)="dissolve()">{{ armed() ? 'Click to confirm' : 'Dissolve group' }}</button>
        </div>
      </div>
      @if (draft(); as dr) {
        <fieldset class="props" aria-label="New variant">
          <legend>New variant (a hidden copy of this product)</legend>
          <label class="fld"><span>Name</span><input class="inp" name="vname" [(ngModel)]="dr.name"></label>
          <div class="fgrid">@for (d of g.differentiators; track d.key) {
            <label class="fld"><span>{{ d.label }}</span><input class="inp" [attr.aria-label]="d.label" [ngModel]="dr.values[d.key]" (ngModelChange)="setValue(d.key, $event)"></label>
          }</div>
          @if (clash(); as c) { <div class="alert" role="alert">{{ c }} already has these values. Change at least one.</div> }
          <div class="acts-h"><button type="button" class="btn sm" (click)="draft.set(null)">Cancel</button><button type="button" class="btn sm primary" [disabled]="!!clash() || busy()" (click)="createVariant()">Create variant</button></div>
        </fieldset>
      }
      @if (message()) { <p class="ok-msg" role="status">{{ message() }}</p> }
      @if (error()) { <div class="alert" role="alert">{{ error() }}</div> }
      @if (editing()) {
        <app-variant-dialog [groupId]="g.id" [groupVersion]="g.version" [current]="g.differentiators" (closed)="editing.set(false)" (saved)="onSaved($event)" />
      }
    } @else if (error()) { <div class="alert" role="alert">{{ error() }}</div> } @else { <p class="hint">Loading the variants…</p> }`,
})
export class VariantsPanel {
  private api = inject(ApiService);
  groupId = input.required<string>();
  productId = input<string | null>(null);
  open = output<string>();
  changed = output<void>();
  group = signal<VariantGroupView | null>(null);
  draft = signal<{ name: string; values: Record<string, string> } | null>(null);
  editing = signal(false); busy = signal(false); armed = signal(false);
  error = signal(''); message = signal('');
  memberIds = computed(() => this.group()?.members.map((m) => m.id) ?? []);
  diffLabels = computed(() => this.group()?.differentiators.map((d) => d.label).join(', ') ?? '');
  unreachableText = computed(() => this.group()?.warnings.unreachable.map((u) => u.name).join(', ') ?? '');
  /** The member that already has the draft's values (the server checks too). */
  clash = computed(() => {
    const g = this.group(), d = this.draft();
    if (!g || !d) return '';
    const key = g.differentiators.map((x) => norm(d.values[x.key] ?? '') || '-').join('|');
    return g.members.find((m) => !m.deleted && g.differentiators.map((x) => norm(m.values[x.key] ?? '-')).join('|') === key)?.name ?? '';
  });

  constructor() { effect(() => { const id = this.groupId(); untracked(() => this.load(id)); }); }

  load(id = this.groupId()) {
    this.api.variantGroup(id).subscribe({ next: (g) => this.group.set(g), error: (e) => this.error.set(e.error?.error ?? 'The variant group could not be loaded.') });
  }
  private patch(body: { add?: string[]; remove?: string[]; order?: string[] }, done: string) {
    const g = this.group();
    if (!g) return;
    this.error.set(''); this.message.set('');
    this.api.updateVariantGroup(g.id, { version: g.version, ...body }).subscribe({
      next: (u) => { this.group.set(u); this.message.set(done); this.changed.emit(); },
      error: (e) => { this.error.set(e.error?.error ?? 'Could not change the group.'); this.load(); },
    });
  }
  move(i: number, d: -1 | 1) {
    const ids = [...this.memberIds()];
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    this.patch({ order: ids }, 'Order saved.');
  }
  remove(id: string) { this.patch({ remove: [id] }, 'Removed from the group.'); }
  add(p: ProductSummary) { this.patch({ add: [p.id] }, `${p.name} added.`); }
  startVariant() {
    const g = this.group(), me = g?.members.find((m) => m.id === this.productId()) ?? g?.members[0];
    if (!g || !me) return;
    this.draft.set({ name: `${me.name} (copy)`, values: Object.fromEntries(g.differentiators.map((d) => [d.key, me.values[d.key] === '-' ? '' : me.values[d.key]])) });
  }
  setValue(key: string, v: string) { const d = this.draft(); if (d) this.draft.set({ ...d, values: { ...d.values, [key]: v } }); }
  createVariant() {
    const g = this.group(), d = this.draft();
    if (!g || !d) return;
    this.busy.set(true); this.error.set('');
    this.api.addVariant(g.id, { fromProductId: this.productId() ?? g.members[0].id, values: Object.fromEntries(Object.entries(d.values).map(([k, v]) => [k, v.trim() || null])), name: d.name }).subscribe({
      next: (p) => { this.busy.set(false); this.draft.set(null); this.message.set(`${p.name} was created (hidden until you show it).`); this.load(); this.changed.emit(); },
      error: (e) => { this.busy.set(false); this.error.set(e.error?.error ?? 'Could not create the variant.'); },
    });
  }
  onSaved(g: VariantGroupView) { this.editing.set(false); this.group.set(g); this.message.set('Properties saved.'); this.changed.emit(); }
  dissolve() {
    const g = this.group();
    if (!g) return;
    if (!this.armed()) { this.armed.set(true); setTimeout(() => this.armed.set(false), UI.confirmMs); return; }
    this.api.dissolveVariantGroup(g.id).subscribe({ next: () => { this.group.set(null); this.changed.emit(); }, error: (e) => this.error.set(e.error?.error ?? 'Could not dissolve the group.') });
  }
}

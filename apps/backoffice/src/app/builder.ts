import { Component, computed, inject, input, signal } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';
import { renderPage, type Block } from '@openshop/renderer';
import { ApiService } from './api.service';

type Simple = Exclude<Block, { type: 'columns' | 'products' }>;

@Component({
  selector: 'app-builder',
  imports: [FormsModule],
  template: `
    <h2>Page builder: {{ title() }}</h2>
    <div class="builder">
      <section>
        <div class="row">
          <button (click)="add('heading')">+ Heading</button>
          <button (click)="add('text')">+ Text</button>
          <button (click)="add('image')">+ Image</button>
          <button (click)="add('button')">+ Button</button>
        </div>
        @for (b of blocks(); track $index) {
          <div class="blk">
            <strong>{{ b.type }}</strong>
            @switch (b.type) {
              @case ('heading') { <input [ngModel]="$any(b).text" (ngModelChange)="patch($index, { text: $event })"> }
              @case ('text') { <textarea [ngModel]="$any(b).text" (ngModelChange)="patch($index, { text: $event })"></textarea> }
              @case ('image') {
                <input placeholder="src" [ngModel]="$any(b).src" (ngModelChange)="patch($index, { src: $event })">
                <input placeholder="alt" [ngModel]="$any(b).alt" (ngModelChange)="patch($index, { alt: $event })">
              }
              @case ('button') {
                <input placeholder="label" [ngModel]="$any(b).label" (ngModelChange)="patch($index, { label: $event })">
                <input placeholder="href" [ngModel]="$any(b).href" (ngModelChange)="patch($index, { href: $event })">
              }
            }
            <span class="row">
              <button (click)="move($index, -1)">↑</button><button (click)="move($index, 1)">↓</button><button (click)="remove($index)">✕</button>
            </span>
          </div>
        }
        <button (click)="save()">Save &amp; publish</button>
        <span>{{ status() }}</span>
      </section>
      <iframe sandbox title="preview" [srcdoc]="preview()"></iframe>
    </div>`,
})
export class Builder {
  id = input.required<string>();
  private api = inject(ApiService);
  private san = inject(DomSanitizer);
  title = signal(''); slug = signal('');
  blocks = signal<Block[]>([]);
  status = signal('');
  preview = computed(() => this.san.bypassSecurityTrustHtml(renderPage({ title: this.title(), blocks: this.blocks() })) as unknown as string);

  ngOnInit() {
    this.api.page(this.id()).subscribe((p) => { this.title.set(p.title); this.slug.set(p.slug); this.blocks.set(p.blocks); });
  }
  add(type: Simple['type']) {
    const b: Record<Simple['type'], Block> = {
      heading: { type: 'heading', text: 'Heading' }, text: { type: 'text', text: 'Text' },
      image: { type: 'image', src: '', alt: '' }, button: { type: 'button', label: 'Click', href: '#' },
    };
    this.blocks.update((l) => [...l, b[type]]);
  }
  patch(i: number, p: Partial<Simple>) { this.blocks.update((l) => l.map((b, j) => (j === i ? ({ ...b, ...p } as Block) : b))); }
  remove(i: number) { this.blocks.update((l) => l.filter((_, j) => j !== i)); }
  move(i: number, d: number) {
    this.blocks.update((l) => { const n = [...l], j = i + d; if (j < 0 || j >= n.length) return n; [n[i], n[j]] = [n[j], n[i]]; return n; });
  }
  save() {
    this.status.set('Saving...');
    this.api.savePage(this.id(), { slug: this.slug(), title: this.title(), blocks: this.blocks() }).subscribe({
      next: () => this.status.set(`Published at /s/${this.slug()}`),
      error: (e) => this.status.set(e.error?.error ?? 'Save failed'),
    });
  }
}

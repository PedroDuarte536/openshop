import { Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { PAGE_TEMPLATES, buildDoc, renderPage } from '@openshop/renderer';
import { ApiService, PageSummary } from './api.service';

const ESSENTIAL: Record<string, { name: string; text: string }> = {
  product: { name: 'Product page', text: 'Shown for every product. Arrange the photos, name, price and add-to-cart button once.' },
  category: { name: 'Category page', text: 'Lists the products in a category, and the whole shop. Includes search and category links.' },
  search: { name: 'Search results', text: 'What visitors see after they search your shop.' },
};

@Component({
  selector: 'app-pages',
  imports: [FormsModule, RouterLink],
  template: `
    <header class="page-h">
      <div><h1>Pages</h1><p>Design how your shop looks, and choose where each page lives</p></div>
      <button class="btn primary" (click)="creating.set(!creating())">{{ creating() ? 'Close' : '+ New page' }}</button>
    </header>

    @if (creating()) {
      <section class="newpage">
        <h3>Start from a template</h3>
        <div class="tgrid">
          @for (t of templates(); track t.key) {
            <button type="button" class="tcard" [class.on]="tpl() === t.key" (click)="tpl.set(t.key)">
              <span class="pvp"><iframe tabindex="-1" scrolling="no" [srcdoc]="t.html" title=""></iframe></span>
              <b>{{ t.name }}</b><small>{{ t.blurb }}</small>
            </button>
          }
        </div>
        <form (ngSubmit)="add()" class="nform">
          <label class="fld req"><span>Page title</span><input class="inp" name="title" [(ngModel)]="title" (ngModelChange)="autoSlug()" placeholder="e.g. About us" required></label>
          <label class="fld req"><span>Address</span><div class="affix"><b style="font-size:12px">/s/</b><input class="inp" style="padding-left:38px" name="slug" [(ngModel)]="slug" pattern="[a-z0-9\\-]+" placeholder="about-us" required></div></label>
          <button class="btn primary">Create and open builder</button>
        </form>
        <p class="hint">Name the address <b>home</b> to make this page your front page.</p>
        @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
      </section>
    }

    <div class="sec-h"><h3>Essential pages</h3><span>Every shop needs these. Design each one once and it's used for all products, categories and searches.</span></div>
    <div class="pgrid">
      @for (p of essential(); track p.id) {
        <article class="pcard">
          <a class="pvp" [routerLink]="['/pages', p.id]" [attr.aria-label]="'Edit ' + meta(p).name">
            @if (thumbs()[p.id]) { <iframe tabindex="-1" scrolling="no" [srcdoc]="thumbs()[p.id]" title=""></iframe> }
          </a>
          <div class="pbody">
            <div class="ptitle"><b>{{ meta(p).name }}</b><span class="pill info">Fixed address</span></div>
            <p class="pdesc">{{ meta(p).text }}</p>
            <div class="pact"><a class="btn sm primary" [routerLink]="['/pages', p.id]">Edit design</a></div>
          </div>
        </article>
      }
    </div>

    <div class="sec-h"><h3>Your pages</h3><span>Pages like your front page, about page or landing pages.</span></div>
    <div class="pgrid">
      @for (p of custom(); track p.id) {
        <article class="pcard">
          <a class="pvp" [routerLink]="['/pages', p.id]" [attr.aria-label]="'Edit ' + p.title"><iframe tabindex="-1" scrolling="no" [src]="live(p.slug)" title=""></iframe></a>
          <div class="pbody">
            <div class="ptitle"><b>{{ p.title }}</b>@if (p.slug === 'home') { <span class="pill ok">Front page</span> }</div>
            @if (editingId() === p.id) {
              <div class="addr"><span>/s/</span>
                <input #slugInput [ngModel]="editSlug()" (ngModelChange)="onEditSlug($event)" (keydown.enter)="saveSlug(p)" (keydown.escape)="cancelEdit()" aria-label="Page address" spellcheck="false">
                <button class="btn sm primary" (click)="saveSlug(p)">Save</button><button class="btn sm ghost" (click)="cancelEdit()">Cancel</button>
              </div>
            } @else {
              <div class="addr"><span>/s/</span><b class="url">{{ p.slug }}</b><button class="btn sm ghost" (click)="startEdit(p)">Change address</button></div>
            }
            @if (rowError()[p.id]) { <p class="err" role="alert" style="margin:0">{{ rowError()[p.id] }}</p> }
            <div class="pact">
              <a class="btn sm primary" [routerLink]="['/pages', p.id]">Edit design</a>
              <a class="btn sm" [href]="'/s/' + p.slug" target="_blank" rel="noopener">View</a>
              @if (p.slug !== 'home') { <button class="btn sm" (click)="makeFront(p)">Make front page</button> }
              <button class="btn sm danger" [class.armed]="armed() === p.id" (click)="remove(p)">{{ armed() === p.id ? 'Click to confirm' : 'Delete' }}</button>
            </div>
          </div>
        </article>
      } @empty { <p class="hint">No pages yet. Create your first one with the button above.</p> }
    </div>`,
})
export class Pages {
  private api = inject(ApiService);
  private router = inject(Router);
  private san = inject(DomSanitizer);
  slugInput = viewChild<ElementRef<HTMLInputElement>>('slugInput');
  items = signal<PageSummary[]>([]);
  thumbs = signal<Record<string, SafeHtml>>({});
  rowError = signal<Record<string, string>>({});
  error = signal(''); creating = signal(false); armed = signal('');
  editingId = signal<string | null>(null); editSlug = signal('');
  tpl = signal('ceramics'); slug = ''; title = ''; private lastTitle = '';
  essential = computed(() => (['product', 'category', 'search'] as const).map((k) => this.items().find((p) => p.system === k)).filter((p): p is PageSummary => !!p));
  custom = computed(() => this.items().filter((p) => !p.system));
  templates = computed(() => PAGE_TEMPLATES.map((t) => ({ key: t.key, name: t.name, blurb: t.blurb, html: this.san.bypassSecurityTrustHtml(renderPage(buildDoc(t, t.name))) })));

  constructor() {
    this.load(true);
    effect(() => { this.slugInput()?.nativeElement.focus(); });
  }
  load(first = false) {
    this.api.pages().subscribe((p) => {
      this.items.set(p);
      if (first && !p.some((x) => !x.system)) this.creating.set(true);
      for (const sp of p.filter((x) => x.system)) {
        if (this.thumbs()[sp.id]) continue;
        this.api.page(sp.id).subscribe((full) => this.thumbs.update((t) => ({ ...t, [sp.id]: this.san.bypassSecurityTrustHtml(renderPage({ title: full.title, theme: full.theme, nodes: full.nodes ?? [] }, { sample: true })) })));
      }
    });
  }
  meta(p: PageSummary) { return ESSENTIAL[p.system!]; }
  live(slug: string) { return this.san.bypassSecurityTrustResourceUrl('/s/' + slug); }
  private clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+/, '').slice(0, 80);
  private slugify = (s: string) => this.clean(s.trim()).replace(/-+$/, '');

  autoSlug() { if (!this.slug || this.slug === this.slugify(this.lastTitle)) this.slug = this.slugify(this.title); this.lastTitle = this.title; }
  add() {
    const t = PAGE_TEMPLATES.find((x) => x.key === this.tpl())!;
    const d = buildDoc(t, this.title);
    this.api.createPage({ slug: this.slug, title: this.title, theme: d.theme, nodes: d.nodes }).subscribe({
      next: (p) => this.router.navigate(['/pages', p.id]),
      error: (e) => this.error.set(e.status === 409 ? 'That address is already used by another page.' : e.error?.error ?? 'Could not create the page.'),
    });
  }

  private setRowError(id: string, msg: string) { this.rowError.update((r) => ({ ...r, [id]: msg })); }
  startEdit(p: PageSummary) { this.setRowError(p.id, ''); this.editSlug.set(p.slug); this.editingId.set(p.id); }
  cancelEdit() { this.editingId.set(null); }
  onEditSlug(v: string) { this.editSlug.set(this.clean(v)); }
  saveSlug(p: PageSummary) {
    const slug = this.editSlug().replace(/-+$/, '');
    if (!slug) { this.setRowError(p.id, 'Type an address first.'); return; }
    if (slug === p.slug) { this.cancelEdit(); return; }
    this.patch(p, slug);
  }
  makeFront(p: PageSummary) { this.patch(p, 'home'); }
  private patch(p: PageSummary, slug: string) {
    this.api.patchPage(p.id, { slug }).subscribe({
      next: () => { this.cancelEdit(); this.setRowError(p.id, ''); this.load(); },
      error: (e) => this.setRowError(p.id, e.status === 409
        ? (slug === 'home' ? 'Another page is already the front page. Change its address first.' : 'That address is already used by another page.')
        : e.error?.error ?? 'Could not change the address.'),
    });
  }
  remove(p: PageSummary) {
    if (this.armed() !== p.id) { this.armed.set(p.id); setTimeout(() => { if (this.armed() === p.id) this.armed.set(''); }, 3500); return; }
    this.api.deletePage(p.id).subscribe(() => { this.armed.set(''); this.load(); });
  }
}

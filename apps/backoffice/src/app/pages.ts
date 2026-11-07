import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { DomSanitizer } from '@angular/platform-browser';
import { PAGE_TEMPLATES, buildDoc, renderPage } from '@openshop/renderer';
import { ApiService, PageSummary } from './api.service';

@Component({
  selector: 'app-pages',
  imports: [FormsModule, RouterLink],
  template: `
    <header class="ph"><h2>Pages</h2><button class="primary" (click)="creating.set(!creating())">{{ creating() ? 'Close' : 'New page' }}</button></header>

    @if (creating()) {
      <section class="newpage">
        <h3>Start from a template</h3>
        <div class="tgrid">
          @for (t of templates(); track t.key) {
            <button class="tcard" [class.on]="tpl() === t.key" (click)="tpl.set(t.key)">
              <span class="tvp"><iframe tabindex="-1" scrolling="no" [srcdoc]="t.html" title=""></iframe></span>
              <b>{{ t.name }}</b><small>{{ t.blurb }}</small>
            </button>
          }
        </div>
        <form (ngSubmit)="add()" class="nform">
          <label>Title<input name="title" [(ngModel)]="title" (ngModelChange)="autoSlug()" placeholder="Home" required></label>
          <label>Address<span class="pre">/s/</span><input name="slug" [(ngModel)]="slug" placeholder="home" pattern="[a-z0-9\\-]+" required></label>
          <button class="primary">Create and open builder</button>
        </form>
        <p class="hint">Use the address <b>home</b> to make this your site's front page.</p>
        @if (error()) { <p class="err">{{ error() }}</p> }
      </section>
    }

    <div class="pgrid">
      @for (p of items(); track p.id) {
        <a class="pcard" [routerLink]="['/pages', p.id]">
          <span class="pvp"><iframe tabindex="-1" scrolling="no" [src]="live(p.slug)" title=""></iframe></span>
          <b>{{ p.title }}</b><small>/s/{{ p.slug }}</small>
        </a>
      } @empty { @if (!creating()) { <p class="empty">No pages yet. Create your first page from a template.</p> } }
    </div>`,
})
export class Pages {
  private api = inject(ApiService);
  private router = inject(Router);
  private san = inject(DomSanitizer);
  items = signal<PageSummary[]>([]);
  error = signal('');
  creating = signal(false);
  tpl = signal('ceramics');
  slug = ''; title = '';
  templates = computed(() => PAGE_TEMPLATES.map((t) => ({ key: t.key, name: t.name, blurb: t.blurb, html: this.san.bypassSecurityTrustHtml(renderPage(buildDoc(t, t.name))) })));
  constructor() { this.api.pages().subscribe((p) => { this.items.set(p); this.creating.set(p.length === 0); }); }
  live(slug: string) { return this.san.bypassSecurityTrustResourceUrl('/s/' + slug); }
  autoSlug() { if (!this.slug || this.slug === this.slugify(this.lastTitle)) this.slug = this.slugify(this.title); this.lastTitle = this.title; }
  private lastTitle = '';
  private slugify = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  add() {
    const t = PAGE_TEMPLATES.find((x) => x.key === this.tpl())!;
    const d = buildDoc(t, this.title);
    this.api.createPage({ slug: this.slug, title: this.title, theme: d.theme, nodes: d.nodes }).subscribe({
      next: (p) => this.router.navigate(['/pages', p.id]),
      error: (e) => this.error.set(e.error?.error ?? 'Failed to create page'),
    });
  }
}

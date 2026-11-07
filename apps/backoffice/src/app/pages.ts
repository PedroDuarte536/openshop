import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ApiService, PageSummary } from './api.service';

@Component({
  selector: 'app-pages',
  imports: [FormsModule, RouterLink],
  template: `
    <h2>Pages</h2>
    <form (ngSubmit)="add()" class="row">
      <input name="slug" [(ngModel)]="slug" placeholder="slug (a-z, 0-9, -)" pattern="[a-z0-9-]+" required>
      <input name="title" [(ngModel)]="title" placeholder="Title" required>
      <button>Create</button>
    </form>
    @if (error()) { <p class="err">{{ error() }}</p> }
    <ul>
      @for (p of items(); track p.id) {
        <li><a [routerLink]="['/pages', p.id]">{{ p.title }}</a> <small>/s/{{ p.slug }}</small></li>
      } @empty { <li>No pages yet.</li> }
    </ul>`,
})
export class Pages {
  private api = inject(ApiService);
  private router = inject(Router);
  items = signal<PageSummary[]>([]);
  error = signal('');
  slug = ''; title = '';
  constructor() { this.api.pages().subscribe((p) => this.items.set(p)); }
  add() {
    this.api.createPage({ slug: this.slug, title: this.title, blocks: [] }).subscribe({
      next: (p) => this.router.navigate(['/pages', p.id]),
      error: (e) => this.error.set(e.error?.error ?? 'Failed to create page'),
    });
  }
}

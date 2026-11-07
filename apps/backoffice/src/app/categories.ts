import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, Category } from './api.service';

@Component({
  selector: 'app-categories',
  imports: [FormsModule],
  template: `
    <h2>Categories</h2>
    <form (ngSubmit)="add()" class="row">
      <input name="name" [(ngModel)]="name" placeholder="Name" required>
      <input name="slug" [(ngModel)]="slug" placeholder="slug" pattern="[a-z0-9-]+" required>
      <button>Add</button>
    </form>
    @if (error()) { <p class="err">{{ error() }}</p> }
    <ul>@for (c of items(); track c.id) { <li>{{ c.name }} <small>{{ c.slug }}</small> <button (click)="remove(c)">Delete</button></li> } @empty { <li>None yet.</li> }</ul>`,
})
export class Categories {
  private api = inject(ApiService);
  items = signal<Category[]>([]); error = signal(''); name = ''; slug = '';
  constructor() { this.load(); }
  load() { this.api.categories().subscribe((c) => this.items.set(c)); }
  add() { this.api.createCategory({ name: this.name, slug: this.slug }).subscribe({ next: () => { this.name = this.slug = ''; this.error.set(''); this.load(); }, error: (e) => this.error.set(e.error?.error ?? 'Failed') }); }
  remove(c: Category) { this.api.deleteCategory(c.id).subscribe(() => this.load()); }
}

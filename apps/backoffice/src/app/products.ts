import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, Product } from './api.service';

@Component({
  selector: 'app-products',
  imports: [FormsModule],
  template: `
    <h2>Products</h2>
    <form (ngSubmit)="add()" class="row">
      <input name="name" [(ngModel)]="name" placeholder="Name" required>
      <input name="price" type="number" step="0.01" min="0" [(ngModel)]="price" placeholder="Price" required>
      <button>Add</button>
    </form>
    <table>
      <tr><th>Name</th><th>Price</th><th>Active</th><th></th></tr>
      @for (p of items(); track p.id) {
        <tr>
          <td>{{ p.name }}</td><td>{{ p.price.toFixed(2) }}</td>
          <td><input type="checkbox" [checked]="p.active" (change)="toggle(p)"></td>
          <td><button (click)="remove(p)">Delete</button></td>
        </tr>
      } @empty { <tr><td colspan="4">No products yet.</td></tr> }
    </table>`,
})
export class Products {
  private api = inject(ApiService);
  items = signal<Product[]>([]);
  name = ''; price = 0;
  constructor() { this.load(); }
  load() { this.api.products().subscribe((p) => this.items.set(p)); }
  add() { this.api.createProduct({ name: this.name, price: this.price, active: true }).subscribe(() => { this.name = ''; this.price = 0; this.load(); }); }
  toggle(p: Product) { this.api.updateProduct(p.id, { active: !p.active }).subscribe(() => this.load()); }
  remove(p: Product) { this.api.deleteProduct(p.id).subscribe(() => this.load()); }
}

import { Routes } from '@angular/router';
import { Products } from './products';
import { Pages } from './pages';
import { Builder } from './builder';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'products' },
  { path: 'products', component: Products },
  { path: 'pages', component: Pages },
  { path: 'pages/:id', component: Builder },
];

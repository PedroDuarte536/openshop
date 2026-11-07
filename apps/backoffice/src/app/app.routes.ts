import { Routes } from '@angular/router';
import { Products } from './products';
import { Categories } from './categories';
import { Orders } from './orders';
import { Pages } from './pages';
import { Builder } from './builder';
import { Login, authGuard } from './auth';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'products' },
  { path: 'login', component: Login },
  { path: 'products', component: Products, canActivate: [authGuard] },
  { path: 'categories', component: Categories, canActivate: [authGuard] },
  { path: 'orders', component: Orders, canActivate: [authGuard] },
  { path: 'pages', component: Pages, canActivate: [authGuard] },
  { path: 'pages/:id', component: Builder, canActivate: [authGuard] },
];

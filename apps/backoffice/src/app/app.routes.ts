import { Type } from '@angular/core';
import { Routes } from '@angular/router';
import { FEATURES } from '@openshop/iam';
import { Products } from './products/list';
import { ProductDelete } from './products/delete';
import { Properties } from './products/properties';
import { ProductImport } from './products/import';
import { Categories } from './categories';
import { Orders } from './orders';
import { Pages } from './pages';
import { Builder } from './builder/builder';
import { Login, accessGuard, homeGuard, signedInGuard } from './auth';
import { Discounts } from './discounts/list';
import { DiscountEditor } from './discounts/editor';
import { Simulator } from './discounts/simulator';
import { SettingsPage } from './settings';
import { Profiles } from './discounts/profiles';
import { ProfilePage } from './discounts/profile';
import { Customers } from './customers/list';
import { CustomerPage } from './customers/detail';
import { Insights } from './insights/insights';
import { Members } from './team/members';
import { MemberPage } from './team/member';
import { Groups } from './team/groups';
import { GroupPage } from './team/group';
import { Activity } from './activity/activity';
import { Account } from './account';
import { Join } from './join';
import { NoAccess, NotFound, Welcome } from './access-pages';

/** The screen for each path of the feature registry (packages/iam features.ts). */
export const SCREENS: Record<string, Type<unknown>> = {
  products: Products, 'products/properties': Properties, 'products/import': ProductImport, 'products/:id/delete': ProductDelete, categories: Categories, orders: Orders,
  discounts: Discounts, 'discounts/new': DiscountEditor, 'discounts/simulate': Simulator, 'discounts/profiles': Profiles, 'discounts/profiles/:id': ProfilePage, 'discounts/:id': DiscountEditor,
  customers: Customers, 'customers/:id': CustomerPage, insights: Insights, pages: Pages, 'pages/:id': Builder,
  activity: Activity, settings: SettingsPage, team: Members, 'team/groups': Groups, 'team/groups/:id': GroupPage, 'team/:id': MemberPage, account: Account,
};

// Every screen comes from the registry, so the menu, the guards and the landing page can't disagree. Guards run again
// on every navigation ("always"), so a permission change shows the No access page on the current screen too.
export const routes: Routes = [
  { path: '', pathMatch: 'full', canActivate: [homeGuard], children: [] },
  { path: 'login', component: Login },
  { path: 'join', component: Join },
  { path: 'no-access', component: NoAccess },
  { path: 'welcome', component: Welcome, canActivate: [signedInGuard] },
  ...FEATURES.flatMap((f) => f.routes.map((r) => ({
    path: r.path, component: SCREENS[r.path], canActivate: [accessGuard], runGuardsAndResolvers: 'always' as const, data: { feature: f.id, perm: r.perm },
  }))),
  { path: '**', component: NotFound },
];

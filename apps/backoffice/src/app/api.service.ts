import { Injectable, Injector, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router, type ActivatedRouteSnapshot } from '@angular/router';
import { Observable, finalize, of, shareReplay, tap } from 'rxjs';
import { FEATURES, satisfies, type GroupTemplate, type PasswordPolicy, type PermissionDef, type Requirement } from '@openshop/iam';
import type { Node, Theme } from '@openshop/renderer';
import type { Discount, DiscountData, DiscountState, PricingResult } from '@openshop/pricing';
import { UI } from './config';

export type AttrValue = string | number | boolean | string[];
export interface BundleSpec { components: { productId: string; qty: number }[]; priceMode: 'sum' | 'manual'; offerScope: 'targeted' | 'all'; showOnComponents: boolean }
export interface ProductExtras {
  available: number; limitedBy?: { id: string; name: string } | null; componentsTotal?: number | null; containsDeleted?: boolean;
  variantGroup?: { id: string; name: string } | null;
}
export interface Product {
  id: string; name: string; price: number; active: boolean; stock: number; categoryId?: string | null; description?: string; images?: string[];
  sku?: string | null; type?: 'simple' | 'bundle'; attributes?: Record<string, AttrValue>; bundle?: BundleSpec | null;
  variantGroupId?: string | null; variantPosition?: number; deletedAt?: string | null; version?: number; updatedAt?: string; extras?: ProductExtras;
}
/** The short form used by pickers and lookups. */
export interface ProductSummary { id: string; name: string; sku: string | null; price: number; active: boolean; deleted: boolean; type: 'simple' | 'bundle'; categoryId: string | null; image: string | null; available: number; variantGroupId: string | null }
export interface FacetValue { value: string; label: string; count: number; swatch?: string | null }
export interface Facets {
  categories: { id: string | null; slug: string | null; name: string; count: number }[];
  price: { min: number; max: number } | null;
  stock: { in: number; low: number; out: number };
  status: { visible: number; hidden: number; deleted: number };
  types: { simple: number; bundle: number };
  variants?: number;
  missing: { image: number; sku: number; category: number; description: number };
  attributes: { key: string; label: string; type: AttributeType; unit: string | null; values: FacetValue[]; range?: { min: number; max: number } }[];
}
export interface ProductPage<T = Product> { items: T[]; total: number; facets?: Facets; corrected?: string | null }
export type AttributeType = 'text' | 'choice' | 'multi' | 'number' | 'boolean';
export interface AttributeOption { value: string; label: string; position?: number; swatch?: string | null }
export interface AttributeDef {
  id: string; key: string; label: string; type: AttributeType; unit?: string | null; options?: AttributeOption[];
  visibility: 'public' | 'internal'; filterable: boolean; searchable: boolean; showOnProduct: boolean; position: number; version: number;
  usedBy?: number; variantGroups?: string[]; origin?: { importJobId: string } | null;
}
export type AttributeInput = Partial<Omit<AttributeDef, 'id' | 'version' | 'usedBy' | 'variantGroups' | 'origin' | 'options'>> & { label: string; type: AttributeType; options?: { value?: string; label: string; swatch?: string | null }[] };
export interface ImportOptions {
  mode: 'upsert' | 'update' | 'create'; missing: 'leave' | 'hide'; empty: 'leave' | 'clear'; stock: 'set' | 'skip';
  newVisible: boolean; createCategories: boolean; createProperties: boolean; addChoiceValues: boolean; stopOnError: boolean;
  /** https:// photos: download a copy (default) or keep links. */
  remoteImages?: 'download' | 'link';
}
export type NewPropertyType = 'text' | 'choice' | 'number' | 'boolean';
export interface ImportPreview {
  create: number; update: number; unchanged: number; errors: number; deletedMatches: number; undecided: number; warnings: string[];
  newProperties: { key: string; label: string; type: string; public: boolean; locked: boolean; publicInFile: boolean; values?: number }[]; newOptions: Record<string, string[]>; newCategories: string[];
  toHide: number; catalogueSize: number; at: string;
}
/** Limits configured on the server, shown in hints. */
export interface CatalogueLimits { importMaxMb: number; importMaxRows: number; uploadMaxMb: number }

export interface ImportJob {
  id: string; status: 'uploaded' | 'previewed' | 'committing' | 'done' | 'failed' | 'cancelled' | 'interrupted';
  format: 'csv' | 'json'; filename: string; rowCount: number; columns: string[]; mapping: Record<string, string>;
  newProperties: Record<string, { label: string; type: NewPropertyType }>; preset: string | null; options: ImportOptions;
  csv?: { delimiter: string; decimal: string; encoding: string };
  preview?: ImportPreview; progress?: { done: number; total: number };
  result?: { created: number; updated: number; unchanged: number; restored: number; hidden: number; conflicts: number; failed: number; skipped: number };
  error?: string | null; createdAt: string; updatedAt: string;
  sample?: Record<string, unknown>[];
  targets?: { fields: { value: string; label: string }[]; properties: { value: string; label: string; type: string }[] };
  presets?: { key: string; name: string }[];
}
export interface ImportRowView {
  row: number; action: 'create' | 'update' | 'unchanged' | 'error' | null; state: string; message: string | null; productId: string | null;
  name: string | null; sku: string | null; errors: { column: string; message: string }[]; warnings: string[];
  diff: Record<string, [unknown, unknown]> | null; deletedMatch: { productId: string; name: string; deletedAt: string; decision: 'restore' | 'new' | 'skip' | null } | null;
}
export interface Differentiator { key: string; order?: 'products' | 'sorted' }
export interface VariantBadge { label: string; state: 'selected' | 'link' | 'disabled'; productId?: string; soldOut?: boolean; swatch?: string | null }
export interface VariantConflict { productId: string; name: string; withProductId: string; withName: string; values: string; message: string }
export interface VariantGroupView {
  id: string; name: string; version: number;
  differentiators: (Differentiator & { label: string; type: AttributeType; visibility: 'public' | 'internal' })[];
  members: { id: string; name: string; sku: string | null; price: number; active: boolean; deleted: boolean; position: number | null; available: number; values: Record<string, string> }[];
  warnings: { duplicates: string[]; useless: string[]; unreachable: { id: string; name: string }[] };
}
export interface VariantSuggestion {
  products: { id: string; name: string; active: boolean; inGroup: string | null }[];
  properties: { key: string; label: string; type: AttributeType; visibility: 'public' | 'internal'; usable: boolean; varies: boolean; values: Record<string, string> }[];
  preview: { duplicates: VariantConflict[]; useless: string[]; unreachable: { id: string; name: string }[]; selector: { key: string; label: string; badges: VariantBadge[] }[] } | null;
}
export interface DeleteImpact {
  bundles: { id: string; name: string; active: boolean; priceMode: 'sum' | 'manual' }[];
  variantGroup: { id: string; name: string; valuesLost: { property: string; value: string }[] } | null;
  offers: { id: string; name: string; state: DiscountState }[];
  openOrders: number;
}
export interface Category { id: string; name: string; slug: string }
export interface OrderLine {
  name: string; qty: number; price: number; listPrice?: number; lineTotal?: number; discounts?: { discountId: string; label: string; amount: number }[]; sku?: string;
  /** Bundles: what was inside when sold. */
  bundle?: { components: { productId: string; sku?: string; name: string; qty: number; allocatedCents: number }[] };
}
export interface Order {
  id: string; total: number; status: string; createdAt: string; customer: { name: string; email: string; address: string }; lines: OrderLine[];
  subtotal?: number; discountTotal?: number; discounts?: { discountId: string; label: string; source: string; code?: string; amount: number }[];
}
export interface Customer { id: string; email: string; name: string; address: string; activated: boolean; activatedAt?: string | null; createdAt?: string; profiles?: { id: string; name: string }[] }
export interface CustomerDetail extends Customer {
  pendingLink: { purpose: 'activate' | 'reset'; expiresAt: string } | null;
  profiles: { id: string; name: string; publicLabel: string; status: string; validUntil: string | null }[];
  personalOffers: { id: string; name: string; state: DiscountState; effect: string }[];
  codes: { code: string; discountId: string; offer: string; kind: string; usedCount: number }[];
  usage: { discountId: string; offer: string; orders: number; amount: number }[];
  identityOrders: number;
  orders: { id: string; createdAt: string; status: string; total: number; discountTotal: number }[];
}
export interface AccountLink { path: string; url: string | null; expiresAt: string }
export interface Profile {
  id: string; name: string; publicLabel: string; description: string; status: 'active' | 'paused'; version: number;
  memberCount: number; activeMembers: number; rules: { id: string; name: string; label: string; state: DiscountState; effect: string }[]; affectedMembers?: number;
}
export interface ProfileMember { customerId: string; email: string; name: string; activated: boolean; validUntil: string | null; addedAt: string }
export interface Totals { orders: number; ordersWithDiscount: number; revenue: number; grossRevenue: number; discountCost: number; avgDiscount: number; avgOrderValue: number; discountShare: number }
export interface ChoiceStats { shown: number; ordered: number; notOrdered: number; tookBest: number; choseCodePayingMore: number; choseAutomaticPayingMore: number; lessFavourable: number; lessFavourableRate: number; codeChosen: number; extraPaid: number; avgExtraWhenLessFavourable: number }
export interface Summary extends Totals { from: string; to: string; timezone: string; previous: Totals; choices: ChoiceStats; savedForLater: { orders: number; extraPaid: number } }
export interface DayRow { day: string; orders: number; ordersWithDiscount: number; revenue: number; discountCost: number }
export interface OfferRow { discountId: string; name: string; label: string; campaign: string | null; trigger: string; orders: number; discountCost: number; revenue: number; avgOrderValue: number }
export interface CampaignRow { campaign: string; orders: number; discountCost: number; revenue: number; avgOrderValue: number }
export interface ChoiceRow extends ChoiceStats { discountId: string; name: string; label: string; campaign: string | null; code: string }
export interface ChoiceDay extends ChoiceStats { day: string }
export interface SavedRow { discountId: string; name: string; orders: number; extraPaid: number }
/** A shop search that found nothing: how often, on how many days, and what the same words find today. */
export interface SearchMissRow { q: string; count: number; days: number; lastAt: string; findsNow: number }
export type DiscountView = Discount & { state: DiscountState; codeCount?: number; createdAt?: string; updatedAt?: string; version: number };
/** What the API accepts: the offer definition without the derived instants. */
export type DiscountInput = Omit<DiscountData, 'startsAt' | 'endsAt' | 'schedule'> & { schedule: { start: string | null; end: string | null } };
export interface Page<T> { items: T[]; total: number }
export interface VoucherCode { id: string; discountId: string; kind: 'shared' | 'single'; usedCount: number; createdAt: string }
export interface Redemption { orderId: string; at: string; code: string | null; amount: number; state: 'used' | 'released'; customerEmail: string | null; orderTotal: number | null }
export interface Display { showOriginalPrice: boolean; showBadge: boolean; showAlternatives: boolean }
export interface Settings { timezone: string; timezoneConfirmed: boolean; display: Display; serverTimezone: string; offset: string; nowLocal: string }
export interface ZoneChange { id: string; name: string; startsAt: string; endsAt: string | null; newStartsAt: string; newEndsAt: string | null }
export interface SimulateInput { items: { productId: string; qty: number }[]; email?: string | null; customerId?: string | null; codes?: string[]; at?: string | null; selection?: { scenario?: string | null; declined?: string[] } }
export interface SimulateResult { at: string; atLocal: string; timezone: string; result: PricingResult }
export interface AuditEntry { id: string; at: string; userId: string; userName?: string | null; action: string; entity: string; entityId: string }
export type SystemKey = 'product' | 'category' | 'search';
export interface PageSummary { id: string; slug: string; title: string; theme?: Theme; nodes?: Node[]; system?: SystemKey | null }
export interface PageInput { slug: string; title: string; theme?: Partial<Theme>; nodes: Node[] }
export type ProductInput = Partial<Omit<Product, 'id' | 'extras' | 'deletedAt' | 'variantGroupId' | 'variantPosition' | 'updatedAt'>>;

// ---- staff accounts (IAM) ----
export interface Me {
  id: string; email: string; name: string; sudo: boolean; permissions: string[]; mustChangePassword: boolean;
  owner: { name: string }; passwordPolicy: PasswordPolicy; passwordRules: string[]; activityRetentionDays: number;
}
export type StaffStatus = 'invited' | 'active' | 'suspended' | 'removed';
export interface StaffMember {
  id: string; email: string; name: string; status: StaffStatus; sudo: boolean; version: number; mustChangePassword: boolean;
  createdAt: string | null; activatedAt: string | null; lastLoginAt: string | null; removedAt: string | null;
  groups: { id: string; name: string }[]; permissions: string[]; pendingLink: { purpose: 'invite' | 'reset'; expiresAt: string } | null; inviteExpired: boolean;
}
export interface StaffLinkInfo { id: string; purpose: 'invite' | 'reset'; createdAt: string; createdBy: string; expiresAt: string; state: 'pending' | 'used' | 'revoked' | 'expired'; stateAt: string | null; revokedBy: string | null }
export interface StaffDetail extends StaffMember {
  createdByName: string | null; removedByName: string | null;
  permissionSources: { id: string; area: string; label: string; granted: boolean; groups: { id: string; name: string }[] }[];
  links: StaffLinkInfo[];
}
export interface NewLink { path: string; url: string | null; expiresAt: string; purpose: 'invite' | 'reset' }
export interface StaffGroup {
  id: string; name: string; description: string; permissions: string[]; template: string | null; version: number; updatedAt?: string;
  memberCount: number; members: { id: string; name: string; email: string; status: StaffStatus }[]; affectedMembers?: number; warning?: string;
}
export interface PermissionCatalog { areas: { id: string; label: string }[]; permissions: PermissionDef[]; templates: GroupTemplate[]; sudoOnly: string[] }
export type ActivityKind = 'sign_in' | 'sign_in_failed' | 'sign_out' | 'session_ended' | 'link_created' | 'link_opened' | 'link_used' | 'link_revoked' | 'link_invalid'
  | 'page_view' | 'page_denied' | 'api_denied' | 'api_unauthenticated' | 'change' | 'dropped';
export interface ActivityItem {
  id: string; at: string; kind: ActivityKind; userId: string | null; userName: string | null; userStatus: StaffStatus | null;
  targetUserId?: string | null; targetName?: string | null; ip?: string | null; userAgent?: string | null; path?: string | null; method?: string | null;
  feature?: string | null; permission?: string | null; reason?: string | null; purpose?: string | null; action?: string | null; entity?: string | null;
  entityId?: string | null; auditId?: string | null; count?: number;
}
export interface ActivityQuery { kinds?: string; userId?: string; ip?: string; from?: string; to?: string; q?: string; before?: string; limit?: number }
export interface SecuritySettingsView {
  passwordPolicy: { staff: PasswordPolicy; customers: PasswordPolicy }; enforceStaffPolicyAtSignIn: boolean; activityRetentionDays: number;
  version: number; updatedAt: string | null; bounds: { minLength: { min: number; max: number }; retention: number[] };
}
export interface LinkInfo { purpose: 'invite' | 'reset'; email: string; name: string; shopName: string; expiresAt: string; passwordPolicy: PasswordPolicy; rules: string[] }
export interface FullAuditEntry extends AuditEntry { before?: unknown; after?: unknown }
/** Where the guard sent the user, for the No access page. */
export interface Denied { feature: string | null; perm: Requirement; url: string }

const KEY = 'openshop.token';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);
  private injector = inject(Injector);
  token = signal<string | null>(read());
  /** The signed-in staff member and their permissions (from /api/me). The server checks every request; this is for the UI. */
  me = signal<Me | null>(null);
  denied = signal<Denied | null>(null);
  private principal = computed(() => { const m = this.me(); return m ? { sudo: m.sudo, perms: new Set(m.permissions) } : null; });
  private loading: Observable<Me> | null = null;

  login = (email: string, password: string) =>
    this.http.post<{ token: string; mustChangePassword?: boolean }>('/api/auth/login', { email, password }).pipe(tap((r) => { this.setToken(r.token); this.me.set(null); }));
  setToken(t: string | null) { this.token.set(t); write(t); }
  /** Signs out: tells the server (for the activity log) and forgets the session. */
  logout(tellServer = true) {
    if (tellServer && this.token()) this.http.post('/api/auth/logout', {}).subscribe({ error: () => undefined });
    this.setToken(null); this.me.set(null); this.loading = null;
  }
  can(req: Requirement) { return satisfies(this.principal(), req); }
  /** The current user, loaded once per session (and again by refreshMe). */
  ensureMe(): Observable<Me> {
    const m = this.me();
    if (m) return of(m);
    this.loading ??= this.http.get<Me>('/api/me').pipe(tap((x) => this.me.set(x)), finalize(() => { this.loading = null; }), shareReplay(1));
    return this.loading;
  }
  /** Reloads permissions; if the current screen is no longer allowed, its guard runs again and shows No access. */
  refreshMe() {
    if (!this.token()) return;
    this.http.get<Me>('/api/me').subscribe({
      next: (m) => {
        this.me.set(m);
        const router = this.injector.get(Router);
        let r: ActivatedRouteSnapshot | null = router.routerState.snapshot.root;
        while (r?.firstChild) r = r.firstChild;
        const perm = r?.data?.['perm'] as Requirement | undefined;
        if (perm && !this.can(perm)) router.navigateByUrl(router.url, { onSameUrlNavigation: 'reload' });
      },
      error: () => undefined,
    });
  }
  /** The first screen this user may open (menu order), or the "No access yet" page. */
  landing(): string {
    const f = [...FEATURES.filter((x) => x.menu === 'main'), ...FEATURES.filter((x) => x.menu === 'foot' && x.id !== 'account')].find((x) => this.can(x.perm));
    return f ? `/${f.path}` : '/welcome';
  }

  // staff: self
  myself = () => this.http.get<Me>('/api/me');
  changePassword = (current: string, password: string) => this.http.post<{ token: string }>('/api/me/password', { current, password }).pipe(tap((r) => this.setToken(r.token)));
  signOutEverywhere = () => this.http.post<void>('/api/me/sign-out-everywhere', {});
  beacon = (b: { kind: 'page_view' | 'page_denied'; path: string; feature?: string | null; permission?: string | null }) => this.http.post<void>('/api/activity/beacon', b);
  inspectLink = (token: string) => this.http.post<LinkInfo>('/api/auth/links/inspect', { token });
  consumeLink = (token: string, password: string) => this.http.post<{ token: string | null; status: StaffStatus }>('/api/auth/links/consume', { token, password });
  // staff: owner only
  permissionCatalog = () => this.http.get<PermissionCatalog>('/api/permissions');
  staff = (status: 'active' | 'removed' | 'all' = 'active') => this.http.get<Page<StaffMember>>('/api/staff', { params: { status } });
  staffMember = (id: string) => this.http.get<StaffDetail>(`/api/staff/${id}`);
  invite = (b: { email: string; name: string; groupIds: string[] }) => this.http.post<{ member: StaffDetail; link: NewLink }>('/api/staff', b);
  restoreStaff = (id: string) => this.http.post<{ member: StaffDetail; link: NewLink }>(`/api/staff/${id}/restore`, {});
  renameStaff = (id: string, name: string, version: number) => this.http.patch<StaffDetail>(`/api/staff/${id}`, { name, version });
  setStaffGroups = (id: string, groupIds: string[]) => this.http.put<StaffDetail>(`/api/staff/${id}/groups`, { groupIds });
  staffLink = (id: string, purpose: 'invite' | 'reset') => this.http.post<NewLink>(`/api/staff/${id}/links`, { purpose });
  revokeStaffLinks = (id: string) => this.http.post<{ revoked: number }>(`/api/staff/${id}/links/revoke`, {});
  staffAction = (id: string, action: 'suspend' | 'reactivate' | 'sign-out') => this.http.post<StaffDetail>(`/api/staff/${id}/${action}`, {});
  removeStaff = (id: string) => this.http.delete<void>(`/api/staff/${id}`);
  groups = () => this.http.get<StaffGroup[]>('/api/staff-groups');
  group = (id: string) => this.http.get<StaffGroup>(`/api/staff-groups/${id}`);
  createGroup = (b: { name: string; description: string; permissions: string[]; template?: string | null }) => this.http.post<StaffGroup>('/api/staff-groups', b);
  updateGroup = (id: string, b: { name?: string; description?: string; permissions?: string[]; version: number }) => this.http.patch<StaffGroup>(`/api/staff-groups/${id}`, b);
  deleteGroup = (id: string) => this.http.delete<void>(`/api/staff-groups/${id}`);
  groupMembers = (id: string, b: { add?: string[]; remove?: string[] }) => this.http.post<StaffGroup & { added: number; removed: number }>(`/api/staff-groups/${id}/members`, b);
  activity = (q: ActivityQuery) => this.http.get<{ items: ActivityItem[]; next: string | null }>('/api/activity', { params: clean(q) });
  activityChange = (auditId: string) => this.http.get<FullAuditEntry>(`/api/activity/changes/${auditId}`);
  securitySettings = () => this.http.get<SecuritySettingsView>('/api/security-settings');
  updateSecuritySettings = (b: { passwordPolicy?: { staff?: PasswordPolicy; customers?: PasswordPolicy }; enforceStaffPolicyAtSignIn?: boolean; activityRetentionDays?: number; version: number }) =>
    this.http.patch<SecuritySettingsView>('/api/security-settings', b);

  /** The product search: text, filters (f.<key> for properties), sort and paging; with counts per filter value. */
  searchProducts = (params: Record<string, string>) => this.http.get<ProductPage>('/api/products', { params });
  /** Short product rows for pickers and lookups (by `ids`, or a search). */
  productSummaries = (params: Record<string, string>) => this.http.get<ProductPage<ProductSummary>>('/api/products', { params: { view: 'summary', facets: 'false', ...params } });
  lookupProducts = (ids: string[]) => this.productSummaries({ ids: ids.join(','), limit: '200' });
  product = (id: string) => this.http.get<Product>(`/api/products/${id}`);
  createProduct = (p: ProductInput) => this.http.post<Product>('/api/products', p);
  updateProduct = (id: string, p: ProductInput & { version?: number }) => this.http.patch<Product>(`/api/products/${id}`, p);
  /** Products are never removed: this deletes (softly) a hidden product, with a decision for each bundle containing it. */
  deleteProduct = (id: string, bundles: Record<string, 'keep' | 'hide'> = {}) => this.http.delete<void>(`/api/products/${id}`, { body: { bundles } });
  deleteImpact = (id: string) => this.http.get<DeleteImpact>(`/api/products/${id}/delete-impact`);
  restoreProduct = (id: string) => this.http.post<{ product: Product; notice: string | null }>(`/api/products/${id}/restore`, {});
  bulkProducts = (body: { ids: string[]; action: 'show' | 'hide' | 'category'; categoryId?: string | null }) => this.http.post<{ changed: number; failed: { id: string; error: string }[] }>('/api/products/bulk', body);
  /** Export of the current search: CSV (spreadsheets) or the full JSON catalogue, by the Accept header. */
  exportProducts(params: Record<string, string>, format: 'csv' | 'json') {
    const date = new Date().toISOString().slice(0, 10);
    return format === 'csv'
      ? this.downloadCsv('/api/products', `products-${date}.csv`, params)
      : this.download('/api/products', `catalogue-${date}.json`, 'application/vnd.openshop.catalogue+json', params);
  }

  // variant groups
  variantGroup = (id: string) => this.http.get<VariantGroupView>(`/api/variant-groups/${id}`);
  suggestVariants = (body: { productIds: string[]; differentiators?: Differentiator[]; groupId?: string }) => this.http.post<VariantSuggestion>('/api/variant-groups/suggest', body);
  createVariantGroup = (body: { name?: string; productIds: string[]; differentiators: Differentiator[]; makePublic?: boolean }) => this.http.post<VariantGroupView>('/api/variant-groups', body);
  updateVariantGroup = (id: string, body: { version: number; name?: string; differentiators?: Differentiator[]; add?: string[]; remove?: string[]; order?: string[]; makePublic?: boolean }) =>
    this.http.patch<VariantGroupView>(`/api/variant-groups/${id}`, body);
  addVariant = (id: string, body: { fromProductId: string; values: Record<string, string | number | boolean | null>; name?: string }) => this.http.post<Product>(`/api/variant-groups/${id}/variants`, body);
  dissolveVariantGroup = (id: string) => this.http.delete<void>(`/api/variant-groups/${id}`);

  // import
  imports = () => this.http.get<ImportJob[]>('/api/catalogue/imports');
  catalogueLimits = () => this.http.get<CatalogueLimits>('/api/catalogue/limits');
  uploadImport = (file: File) => this.http.post<ImportJob>('/api/catalogue/imports', file, {
    headers: { 'Content-Type': file.type && file.type !== 'application/octet-stream' ? file.type : /\.json$/i.test(file.name) ? 'application/json' : 'text/csv' },
    params: { filename: file.name },
  });
  importJob = (id: string) => this.http.get<ImportJob>(`/api/catalogue/imports/${id}`);
  configureImport = (id: string, body: { mapping?: Record<string, string>; options?: Partial<ImportOptions>; newProperties?: Record<string, { type: NewPropertyType }>; preset?: string | null; publish?: string[] }) =>
    this.http.put<ImportJob>(`/api/catalogue/imports/${id}`, body);
  previewImport = (id: string) => this.http.post<ImportJob>(`/api/catalogue/imports/${id}/preview`, {});
  importRows = (id: string, params: Record<string, string>) => this.http.get<Page<ImportRowView>>(`/api/catalogue/imports/${id}/rows`, { params });
  decideImport = (id: string, decisions: Record<string, 'restore' | 'new' | 'skip'>) => this.http.post<ImportJob>(`/api/catalogue/imports/${id}/decisions`, { decisions });
  commitImport = (id: string, previewAt: string, confirmHide = false) => this.http.post<ImportJob>(`/api/catalogue/imports/${id}/commit`, { previewAt, ...(confirmHide ? { confirmHide } : {}) });
  cancelImport = (id: string) => this.http.post<{ ok: boolean }>(`/api/catalogue/imports/${id}/cancel`, {});
  importReport = (id: string) => this.downloadCsv(`/api/catalogue/imports/${id}/rows`, `import-report-${id.slice(0, 8)}.csv`);

  // product properties
  attributes = () => this.http.get<AttributeDef[]>('/api/attributes');
  createAttribute = (a: AttributeInput) => this.http.post<AttributeDef>('/api/attributes', a);
  updateAttribute = (id: string, a: Partial<AttributeInput> & { version: number }) => this.http.patch<AttributeDef>(`/api/attributes/${id}`, a);
  deleteAttribute = (id: string, purge = false) => this.http.delete<void>(`/api/attributes/${id}`, { params: purge ? { purge: 'true' } : {} });
  upload = (file: File) => this.http.post<{ url: string }>('/api/uploads', file, { headers: { 'Content-Type': file.type } });
  categories = () => this.http.get<Category[]>('/api/categories');
  createCategory = (c: { name: string; slug: string }) => this.http.post<Category>('/api/categories', c);
  deleteCategory = (id: string) => this.http.delete<void>(`/api/categories/${id}`);
  orders = () => this.http.get<Order[]>('/api/orders');
  setOrderStatus = (id: string, status: string) => this.http.patch<Order>(`/api/orders/${id}`, { status });
  pages = () => this.http.get<PageSummary[]>('/api/pages');
  page = (id: string) => this.http.get<PageSummary>(`/api/pages/${id}`);
  createPage = (p: PageInput) => this.http.post<PageSummary>('/api/pages', p);
  patchPage = (id: string, p: { slug?: string; title?: string }) => this.http.patch<PageSummary>(`/api/pages/${id}`, p);
  deletePage = (id: string) => this.http.delete<void>(`/api/pages/${id}`);
  savePage = (id: string, p: PageInput) => this.http.put<PageSummary>(`/api/pages/${id}`, p);
  customers = () => this.http.get<Customer[]>('/api/customers');
  customer = (id: string) => this.http.get<CustomerDetail>(`/api/customers/${id}`);
  createCustomer = (c: { email: string; name: string; address?: string }) => this.http.post<Customer>('/api/customers', c);
  updateCustomer = (id: string, c: { name?: string; address?: string }) => this.http.patch<Customer>(`/api/customers/${id}`, c);
  deleteCustomer = (id: string) => this.http.delete<void>(`/api/customers/${id}`);
  customerLink = (id: string, purpose: 'activate' | 'reset') => this.http.post<AccountLink>(`/api/customers/${id}/links`, { purpose });
  signOutCustomer = (id: string) => this.http.post<Customer>(`/api/customers/${id}/sign-out`, {});
  personalCode = (discountId: string, customerId: string, prefix: string) => this.http.post<{ created: number; items: string[] }>(`/api/discounts/${discountId}/codes`, { generate: 1, ...(prefix ? { prefix } : {}), assignedCustomerId: customerId });

  // profiles
  profiles = () => this.http.get<Profile[]>('/api/discount-profiles');
  profile = (id: string) => this.http.get<Profile>(`/api/discount-profiles/${id}`);
  createProfile = (p: { name: string; publicLabel: string; description?: string }) => this.http.post<Profile>('/api/discount-profiles', p);
  updateProfile = (id: string, p: { name?: string; publicLabel?: string; description?: string; status?: string; version: number }) => this.http.patch<Profile>(`/api/discount-profiles/${id}`, p);
  deleteProfile = (id: string) => this.http.delete<void>(`/api/discount-profiles/${id}`);
  profileMembers = (id: string) => this.http.get<Page<ProfileMember>>(`/api/discount-profiles/${id}/members`);
  changeMembers = (id: string, body: { add?: { customerId: string; lastDay?: string | null }[]; remove?: string[] }) => this.http.post<Profile & { added: number; removed: number }>(`/api/discount-profiles/${id}/members`, body);

  // insights
  private period = (from: string, to: string, extra: Record<string, string> = {}) => ({ params: { from, to, ...extra } });
  summary = (from: string, to: string) => this.http.get<Summary>('/api/reports/summary', this.period(from, to));
  reportDays = (from: string, to: string) => this.http.get<Page<DayRow>>('/api/reports/discounts', this.period(from, to, { groupBy: 'day' }));
  reportOffers = (from: string, to: string) => this.http.get<Page<OfferRow>>('/api/reports/discounts', this.period(from, to, { groupBy: 'discount' }));
  reportCampaigns = (from: string, to: string) => this.http.get<Page<CampaignRow>>('/api/reports/discounts', this.period(from, to, { groupBy: 'campaign' }));
  reportChoices = (from: string, to: string) => this.http.get<Page<ChoiceRow>>('/api/reports/choices', this.period(from, to, { groupBy: 'code' }));
  reportChoiceDays = (from: string, to: string) => this.http.get<Page<ChoiceDay>>('/api/reports/choices', this.period(from, to, { groupBy: 'day' }));
  reportSaved = (from: string, to: string) => this.http.get<Page<SavedRow>>('/api/reports/saved-for-later', this.period(from, to));
  reportSearchMisses = (from: string, to: string) => this.http.get<Page<SearchMissRow>>('/api/reports/search-misses', this.period(from, to));

  // discounts
  discounts = () => this.http.get<DiscountView[]>('/api/discounts');
  discount = (id: string) => this.http.get<DiscountView>(`/api/discounts/${id}`);
  createDiscount = (d: DiscountInput) => this.http.post<DiscountView>('/api/discounts', d);
  updateDiscount = (id: string, d: Partial<DiscountInput> & { version: number }) => this.http.patch<DiscountView>(`/api/discounts/${id}`, d);
  discountAction = (id: string, action: 'pause' | 'resume' | 'archive' | 'duplicate') => this.http.post<DiscountView>(`/api/discounts/${id}/${action}`, {});
  deleteDiscount = (id: string) => this.http.delete<void>(`/api/discounts/${id}`);
  codes = (id: string, skip = 0, limit = 50) => this.http.get<Page<VoucherCode>>(`/api/discounts/${id}/codes`, { params: { skip, limit } });
  addCode = (id: string, code: string) => this.http.post<{ created: number; items: string[] }>(`/api/discounts/${id}/codes`, { code });
  generateCodes = (id: string, generate: number, prefix: string) => this.http.post<{ created: number; items: string[] }>(`/api/discounts/${id}/codes`, prefix ? { generate, prefix } : { generate });
  deleteCode = (id: string, code: string) => this.http.delete<void>(`/api/discounts/${id}/codes/${encodeURIComponent(code)}`);
  redemptions = (id: string) => this.http.get<Page<Redemption>>(`/api/discounts/${id}/redemptions`);
  simulate = (body: SimulateInput) => this.http.post<SimulateResult>('/api/discounts/simulate', body);
  /** A record's history, newest first, one page at a time (`before` = the `next` cursor of the previous page). */
  audit = (entity: string, id: string, before?: string | null) => this.http.get<{ items: AuditEntry[]; next: string | null }>('/api/audit', { params: { entity, id, ...(before ? { before } : {}) } });
  /** Same URL as the JSON list; the Accept header asks for CSV. Returned as a file download. */
  downloadCsv(url: string, filename: string, params: Record<string, string> = {}) { return this.download(url, filename, 'text/csv', params); }
  /** Downloads a representation of `url` chosen by the Accept header (the token goes in the header, never the URL). */
  download(url: string, filename: string, accept: string, params: Record<string, string> = {}) {
    return this.http.get(url, { headers: { Accept: accept }, responseType: 'blob', params }).pipe(tap((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), UI.downloadUrlMs);
    }));
  }

  // settings
  settings = () => this.http.get<Settings>('/api/settings');
  timezoneImpact = (tz: string) => this.http.get<{ timezone: string; offset: string; changes: ZoneChange[] }>('/api/settings/timezone-impact', { params: { tz } });
  updateSettings = (s: { timezone?: string; display?: Partial<Display> }) => this.http.patch<Settings>('/api/settings', s);
}

const clean = (q: object) => Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined && v !== null && v !== '')) as Record<string, string>;
function read() { try { return localStorage.getItem(KEY); } catch { return null; } }
function write(v: string | null) { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch { /* storage unavailable */ } }

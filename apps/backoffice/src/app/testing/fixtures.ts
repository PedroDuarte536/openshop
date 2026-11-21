// Realistic test data for backoffice specs. Offers are built with the real validator from @openshop/pricing.
import { discountState, normalizeDiscount } from '@openshop/pricing';
import { DEFAULT_STAFF_POLICY, PERMISSION_IDS, closure, policyRules } from '@openshop/iam';
import type { Category, Customer, CustomerDetail, DiscountView, Facets, Me, Order, Product, ProductSummary, Profile, Settings, Summary } from '../api.service';

/** The signed-in member: the owner ('sudo') or a member with these permissions (closed under their requirements). */
export function meFor(perms: 'sudo' | string[], over: Partial<Me> = {}): Me {
  const sudo = perms === 'sudo';
  return {
    id: sudo ? 'u-owner' : 'u-member', email: sudo ? 'owner@shop.test' : 'member@shop.test', name: sudo ? 'Olivia' : 'Pat', sudo,
    permissions: sudo ? [...PERMISSION_IDS] : [...closure(perms)], mustChangePassword: false, owner: { name: 'Olivia' },
    passwordPolicy: DEFAULT_STAFF_POLICY, passwordRules: policyRules(DEFAULT_STAFF_POLICY), activityRetentionDays: 180, ...over,
  };
}

export const NOW = Date.parse('2026-06-15T12:00:00Z');

let seq = 0;
export function offer(raw: Record<string, unknown> = {}, extra: Partial<DiscountView> = {}): DiscountView {
  const data = normalizeDiscount({ name: 'Offer', label: 'Offer', effect: { type: 'percent', bp: 1000 }, schedule: { start: '2026-06-01T00:00' }, ...raw }, { timezone: 'UTC', now: NOW });
  const d = { id: extra.id ?? `d${++seq}`, usedCount: 0, version: 1, ...data, ...extra } as DiscountView;
  return { ...d, state: extra.state ?? discountState(d, Date.now()) };
}

export const settings = (over: Partial<Settings> = {}): Settings => ({
  timezone: 'Europe/Lisbon', timezoneConfirmed: true, display: { showOriginalPrice: true, showBadge: true, showAlternatives: true },
  serverTimezone: 'UTC', offset: 'UTC+01:00', nowLocal: '2026-06-15T13:00', ...over,
});

export const categories: Category[] = [{ id: 'c-mugs', name: 'Mugs', slug: 'mugs' }, { id: 'c-vases', name: 'Vases', slug: 'vases' }];
export const products: Product[] = [
  { id: 'p-mug', name: 'Linen Mug', price: 24, active: true, stock: 10, categoryId: 'c-mugs', images: [] },
  { id: 'p-vase', name: 'Bud Vase', price: 29, active: true, stock: 3, categoryId: 'c-vases', images: ['/uploads/a.png'] },
  { id: 'p-bowl', name: 'Bowl', price: 10, active: true, stock: 0, categoryId: null, images: [] },
  { id: 'p-hidden', name: 'Hidden', price: 5, active: false, stock: 5, categoryId: null, images: [] },
];
/** The same products in the short form used by pickers and lookups. */
export const summaries: ProductSummary[] = products.map((p) => ({
  id: p.id, name: p.name, sku: null, price: p.price, active: p.active, deleted: false, type: 'simple', categoryId: p.categoryId ?? null,
  image: p.images?.[0] ?? null, available: p.stock, variantGroupId: null,
}));
/** A search response page. */
export const page = <T>(items: T[], extra: Record<string, unknown> = {}) => ({ items, total: items.length, ...extra });
export const facets = (over: Partial<Facets> = {}): Facets => ({
  categories: [{ id: 'c-mugs', slug: 'mugs', name: 'Mugs', count: 1 }, { id: 'c-vases', slug: 'vases', name: 'Vases', count: 1 }, { id: null, slug: null, name: 'No category', count: 2 }],
  price: { min: 5, max: 29 }, stock: { in: 2, low: 1, out: 1 }, status: { visible: 3, hidden: 1, deleted: 0 }, types: { simple: 4, bundle: 0 }, variants: 0,
  missing: { image: 3, sku: 4, category: 2, description: 4 }, attributes: [], ...over,
});
export const customers: Customer[] = [
  { id: 'cu-ann', email: 'ann@x.io', name: 'Ann', address: '1 Road', activated: true, profiles: [{ id: 'pr-trade', name: 'Trade' }] },
  { id: 'cu-bo', email: 'bo@x.io', name: 'Bo', address: '', activated: false, profiles: [] },
];
export const profile = (over: Partial<Profile> = {}): Profile => ({
  id: 'pr-trade', name: 'Trade', publicLabel: 'Trade price', description: '', status: 'active', version: 1, memberCount: 2, activeMembers: 1,
  rules: [{ id: 'd-r', name: 'Trade 30%', label: 'Trade', state: 'running', effect: '−30%' }], ...over,
});
export const customerDetail = (over: Partial<CustomerDetail> = {}): CustomerDetail => ({
  ...customers[0], pendingLink: null, profiles: [{ id: 'pr-trade', name: 'Trade', publicLabel: 'Trade price', status: 'active', validUntil: null }],
  personalOffers: [{ id: 'd-p', name: 'Ann 15%', state: 'running', effect: '−15%' }], codes: [{ code: 'ANN-1', discountId: 'd-v', offer: 'Welcome back', kind: 'single', usedCount: 0 }],
  usage: [{ discountId: 'd-b', offer: 'Budget', orders: 2, amount: 7.5 }], identityOrders: 3,
  orders: [{ id: 'o1', createdAt: '2026-06-01T10:00:00Z', status: 'paid', total: 40, discountTotal: 5 }, { id: 'o2', createdAt: '2026-06-02T10:00:00Z', status: 'pending', total: 10, discountTotal: 0 }],
  activatedAt: '2026-05-01T10:00:00Z', ...over,
});
export const order = (over: Partial<Order> = {}): Order => ({
  id: 'o1', total: 95, status: 'pending', createdAt: '2026-06-15T10:00:00Z', customer: { name: 'Ann', email: 'ann@x.io', address: '1 Road' },
  lines: [{ name: 'Mug', qty: 2, price: 50, lineTotal: 95, discounts: [{ discountId: 'd1', label: 'Welcome', amount: 5 }] }],
  subtotal: 100, discountTotal: 5, discounts: [{ discountId: 'd1', label: 'Welcome', source: 'code', code: 'WELCOME5', amount: 5 }], ...over,
});
const totals = { orders: 10, ordersWithDiscount: 6, revenue: 900, grossRevenue: 1000, discountCost: 100, avgDiscount: 16.67, avgOrderValue: 90, discountShare: 10 };
export const summary = (over: Partial<Summary> = {}): Summary => ({
  from: '2026-05-17', to: '2026-06-15', timezone: 'Europe/Lisbon', ...totals, previous: { ...totals, revenue: 1000, orders: 8, avgOrderValue: 100 },
  choices: { shown: 5, ordered: 4, notOrdered: 1, tookBest: 1, choseCodePayingMore: 3, choseAutomaticPayingMore: 0, lessFavourable: 3, lessFavourableRate: 75, codeChosen: 3, extraPaid: 15, avgExtraWhenLessFavourable: 5 },
  savedForLater: { orders: 2, extraPaid: 20 }, ...over,
});

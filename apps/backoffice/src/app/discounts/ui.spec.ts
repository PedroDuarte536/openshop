import { city, effectText, fmtLocal, kindLabel, presetOf, scheduleText, targetText, usesText } from './ui';
import type { Category, DiscountView, Product } from '../api.service';

const base = { trigger: 'automatic', audience: { type: 'everyone' }, target: { type: 'all' }, excludeProductIds: [] } as unknown as DiscountView;
const products = [{ id: 'p1', name: 'Mug' }, { id: 'p2', name: 'Bowl' }, { id: 'p3', name: 'Vase' }] as Product[];
const categories = [{ id: 'c1', name: 'Mugs' }] as Category[];

describe('discount list helpers', () => {
  it('maps offers to preset cards and list badges', () => {
    expect(presetOf({ ...base, trigger: 'code' })).toBe('voucher');
    expect(presetOf({ ...base, audience: { type: 'customers', customerIds: ['x'] } })).toBe('client');
    expect(presetOf({ ...base, audience: { type: 'profiles', profileIds: ['x'] } })).toBe('profile');
    expect(presetOf({ ...base, target: { type: 'products', productIds: ['p1'] } })).toBe('product');
    expect(presetOf(base)).toBe('shop');
    expect(kindLabel({ ...base, target: { type: 'categories', categoryIds: ['c1'] } })).toBe('Category');
    expect(kindLabel(base)).toBe('Shop-wide');
    expect(kindLabel({ ...base, trigger: 'code' })).toBe('Voucher');
  });

  it('formats shop-time dates and schedules', () => {
    expect(fmtLocal('2026-12-01T00:00')).toBe('1 Dec 2026, 00:00');
    expect(fmtLocal('nonsense')).toBe('');
    expect(fmtLocal(null)).toBe('');
    expect(scheduleText({ schedule: { start: '2026-12-01T00:00', end: null } })).toBe('From 1 Dec 2026, 00:00, no end date');
    expect(scheduleText({ schedule: { start: '2026-12-01T00:00', end: '2027-01-01T00:00' } })).toBe('From 1 Dec 2026, 00:00, until 1 Jan 2027, 00:00');
    expect(city('America/New_York')).toBe('New York');
  });

  it('summarises targets, effects and uses', () => {
    expect(targetText(base, products, categories)).toBe('All products');
    expect(targetText({ ...base, excludeProductIds: ['p1'] }, products, categories)).toBe('All products (except 1)');
    expect(targetText({ ...base, target: { type: 'products', productIds: ['p1', 'p2', 'p3', 'gone'] } }, products, categories)).toBe('Mug, Bowl +2 more');
    expect(targetText({ ...base, target: { type: 'categories', categoryIds: ['c1', 'gone'] } }, products, categories)).toBe('Category: Mug, deleted item'.replace('Mug', 'Mugs'));
    expect(effectText({ effect: { type: 'percent', bp: 2000 }, scope: 'line' })).toBe('−20%');
    expect(usesText({ usedCount: 3, limits: { totalUses: 10, maxDiscountPerOrderCents: null } })).toBe('3 / 10');
    expect(usesText({ usedCount: 3, limits: { totalUses: null, maxDiscountPerOrderCents: null } })).toBe('3');
  });
});

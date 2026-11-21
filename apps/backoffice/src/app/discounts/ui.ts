import { describeEffect, type DiscountState } from '@openshop/pricing';
import type { Category, DiscountView } from '../api.service';

/** Which preset card an offer corresponds to (for badges and the editor). */
export type Preset = 'shop' | 'product' | 'client' | 'voucher' | 'profile';
export const PRESETS: { key: Preset; title: string; blurb: string; available: boolean }[] = [
  { key: 'shop', title: 'Shop-wide sale', blurb: 'A discount on everything, or on whole categories.', available: true },
  { key: 'product', title: 'Product price', blurb: 'A special price or discount for chosen products.', available: true },
  { key: 'voucher', title: 'Voucher', blurb: 'Customers type a code at checkout. One shared code or many single-use codes.', available: true },
  { key: 'client', title: 'Client price', blurb: 'A price or discount for chosen customers, when they are signed in.', available: true },
  { key: 'profile', title: 'Profile rule', blurb: 'An offer for every member of a profile, e.g. trade buyers.', available: true },
];
export function presetOf(d: Pick<DiscountView, 'trigger' | 'audience' | 'target'>): Preset {
  if (d.trigger === 'code') return 'voucher';
  if (d.audience.type === 'customers') return 'client';
  if (d.audience.type === 'profiles') return 'profile';
  return d.target.type === 'products' ? 'product' : 'shop';
}
export const presetLabel = (p: Preset) => ({ shop: 'Shop-wide', product: 'Product', client: 'Client', voucher: 'Voucher', profile: 'Profile' })[p];
/** Badge for lists: like the preset, but says "Category" for category offers. */
export const kindLabel = (d: Pick<DiscountView, 'trigger' | 'audience' | 'target'>) => {
  const p = presetOf(d);
  return p === 'shop' && d.target.type === 'categories' ? 'Category' : presetLabel(p);
};

export const STATE_LABEL: Record<DiscountState, string> = { running: 'Running', scheduled: 'Scheduled', paused: 'Paused', ended: 'Ended', 'used-up': 'Used up', archived: 'Archived' };
export const STATE_CLASS: Record<DiscountState, string> = { running: 'ok', scheduled: 'info', paused: 'warn', ended: '', 'used-up': 'bad', archived: '' };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-12-01T00:00" (shop time) -> "1 Dec 2026, 00:00". */
export function fmtLocal(local: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})$/.exec(local ?? '');
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}, ${m[4]}` : '';
}
export const city = (tz: string) => tz.split('/').pop()!.replace(/_/g, ' ');

export function scheduleText(d: Pick<DiscountView, 'schedule'>): string {
  const end = d.schedule.end ? `until ${fmtLocal(d.schedule.end)}` : 'no end date';
  return `From ${fmtLocal(d.schedule.start)}, ${end}`;
}

export function targetText(d: Pick<DiscountView, 'target' | 'excludeProductIds'>, products: { id: string; name: string }[], categories: Category[]): string {
  const names = (ids: string[], list: { id: string; name: string }[]) => {
    const n = ids.map((id) => list.find((x) => x.id === id)?.name ?? 'deleted item');
    return n.length <= 2 ? n.join(', ') : `${n.slice(0, 2).join(', ')} +${n.length - 2} more`;
  };
  const t = d.target;
  const base = t.type === 'all' ? 'All products' : t.type === 'products' ? names(t.productIds, products) : `Category: ${names(t.categoryIds, categories)}`;
  return d.excludeProductIds.length ? `${base} (except ${d.excludeProductIds.length})` : base;
}

export const effectText = (d: Pick<DiscountView, 'effect' | 'scope'>) => describeEffect(d, '€');
export const usesText = (d: Pick<DiscountView, 'usedCount' | 'limits'>) => (d.limits.totalUses != null ? `${d.usedCount} / ${d.limits.totalUses}` : String(d.usedCount));

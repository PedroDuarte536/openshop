import { DuplicateKeyError } from "@openshop/db";
import { isValidTimeZone, rezone } from "@openshop/pricing";
import type { Db, DiscountDoc, DisplaySettings, ShopSettings } from "./types.ts";
import { CONFIG } from "./config.ts";

export const DEFAULT_DISPLAY: DisplaySettings = { showOriginalPrice: true, showBadge: true, showAlternatives: true };

export function serverTimezone(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isValidTimeZone(tz) ? tz : "UTC";
}

// Settings are read on most requests, so keep them in memory briefly (other instances pick changes up within 30s).
const cache = new WeakMap<Db, { at: number; value: ShopSettings }>();
const TTL = CONFIG.caches.settingsMs;

/** The single "shop" settings document, created on first use with the server's time zone (unconfirmed). */
export async function getSettings(db: Db): Promise<ShopSettings> {
  const hit = cache.get(db);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  let s = await db.settings.get("shop");
  if (!s) {
    try { s = await db.settings.insert({ id: "shop", timezone: serverTimezone(), timezoneConfirmed: false, display: { ...DEFAULT_DISPLAY } }); }
    catch (e) { if (!(e instanceof DuplicateKeyError)) throw e; s = (await db.settings.get("shop"))!; }
  }
  const value: ShopSettings = { ...s, timezone: isValidTimeZone(s.timezone) ? s.timezone : "UTC", display: { ...DEFAULT_DISPLAY, ...(s.display ?? {}) } };
  cache.set(db, { at: Date.now(), value });
  return value;
}
export const forgetSettings = (db: Db) => { cache.delete(db); };

export interface ZoneChange { id: string; name: string; startsAt: string; endsAt: string | null; newStartsAt: string; newEndsAt: string | null }

/**
 * What a time-zone change does to offers, keeping their wall-clock meaning:
 * - not started yet: start and end move; already started: only the end moves; already ended or archived: untouched.
 */
export function zoneChanges(discounts: DiscountDoc[], timezone: string, now: number): ZoneChange[] {
  const out: ZoneChange[] = [];
  for (const d of discounts) {
    if (d.status === "archived") continue;
    if (d.endsAt && Date.parse(d.endsAt) <= now) continue;
    const next = rezone(d, timezone);
    const started = Date.parse(d.startsAt) <= now;
    const newStartsAt = started ? d.startsAt : next.startsAt;
    let newEndsAt = next.endsAt;
    // An end that would move into the past (or before the start) ends the offer now rather than corrupting it.
    if (newEndsAt && Date.parse(newEndsAt) <= Date.parse(newStartsAt)) newEndsAt = new Date(Math.max(now, Date.parse(newStartsAt) + 60_000)).toISOString();
    if (newStartsAt !== d.startsAt || newEndsAt !== d.endsAt) out.push({ id: d.id, name: d.name, startsAt: d.startsAt, endsAt: d.endsAt, newStartsAt, newEndsAt });
  }
  return out;
}

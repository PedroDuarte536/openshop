// Shop-local wall-clock time <-> UTC instants, using only Intl (no dependencies).
// Offers are entered as "YYYY-MM-DDTHH:mm" in the shop's time zone and stored as UTC instants, so an offer
// that ends at midnight in Lisbon ends at that same instant for every visitor in the world.

export const LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const MIN = 60_000, DAY = 86_400_000;

const formats = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    formats.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try { fmt(tz); return true; } catch { return false; }
}

interface Parts { y: number; m: number; d: number; h: number; mi: number; s: number }
function partsAt(ms: number, tz: string): Parts {
  const o: Record<string, string> = {};
  for (const p of fmt(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second };
}

/** Minutes to add to UTC to get local time at instant `ms` (Lisbon summer: 60). */
export function offsetMinutes(ms: number, tz: string): number {
  const p = partsAt(ms, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / MIN);
}

/** Parses "YYYY-MM-DDTHH:mm" (years 2000-2100). Returns null if malformed or not a real date. */
export function parseLocal(s: unknown): { y: number; m: number; d: number; h: number; mi: number } | null {
  if (typeof s !== "string") return null;
  const r = LOCAL_PATTERN.exec(s);
  if (!r) return null;
  const [y, m, d, h, mi] = r.slice(1).map(Number);
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || h > 23 || mi > 59) return null;
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return { y, m, d, h, mi };
}

/**
 * The UTC instant (ms) of a wall-clock time in `tz`.
 * - Repeated hour (clocks go back): the first occurrence.
 * - Skipped hour (clocks go forward): the first valid instant after it, i.e. the moment of the change.
 */
export function zonedToInstant(local: string, tz: string): number {
  const p = parseLocal(local);
  if (!p) throw new Error(`Invalid local date-time: ${String(local)}`);
  const t = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi);
  const before = offsetMinutes(t - DAY, tz), after = offsetMinutes(t + DAY, tz);
  const valid = [...new Set([before, after])].map((o) => t - o * MIN).filter((c) => offsetMinutes(c, tz) * MIN === t - c);
  if (valid.length) return Math.min(...valid);
  // In a gap: binary search (minute precision) for the transition between the two offsets.
  let lo = t - Math.max(before, after) * MIN, hi = t - Math.min(before, after) * MIN;
  if (lo > hi) [lo, hi] = [hi, lo];
  while (hi - lo > MIN) {
    const mid = Math.floor((lo + hi) / 2 / MIN) * MIN;
    if (offsetMinutes(mid, tz) === after) hi = mid; else lo = mid;
  }
  return hi;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** "YYYY-MM-DDTHH:mm" wall-clock time in `tz` at instant `ms` (seconds dropped). */
export function instantToLocal(ms: number, tz: string): string {
  const p = partsAt(ms, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
}

/** "UTC+01:00" style label for the offset in force at `ms`. */
export function offsetLabel(ms: number, tz: string): string {
  const o = offsetMinutes(ms, tz), a = Math.abs(o);
  return `UTC${o < 0 ? "-" : "+"}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** Adds whole days to a local date-time string (used for "last day" -> exclusive end at next midnight). */
export function addLocalDays(local: string, days: number): string {
  const p = parseLocal(local);
  if (!p) throw new Error(`Invalid local date-time: ${String(local)}`);
  const d = new Date(Date.UTC(p.y, p.m - 1, p.d + days, p.h, p.mi));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

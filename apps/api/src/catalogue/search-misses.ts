// "Searches with no results" (plan P6): shop searches whose words matched nothing, counted per day, so the owner
// sees what shoppers look for and don't find (a missing product, another word for it, a typo we don't catch).
// Privacy: only the search text is kept, lower-cased and trimmed, never who searched, their IP or their cart. Text
// that looks like personal data (an email address, a long number such as a phone or card number) is not kept.
// Rows are kept for a limited time, and the number of different texts per day is capped (a bot can't fill the
// database); each visitor can add only a few a minute.
import { DuplicateKeyError, type Doc } from "@openshop/db";
import { instantToLocal } from "@openshop/pricing";
import type { Db } from "../types.ts";
import { getSettings } from "../settings.ts";
import { RateLimiter } from "../limiter.ts";
import { CONFIG } from "../config.ts";

/** id = `${day}|${q}`. */
export interface SearchMiss extends Doc { day: string; q: string; count: number; firstAt: string; lastAt: string }

const M = CONFIG.search.misses;
const perVisitor = new RateLimiter(M.perVisitorBurst, M.perVisitorPerSecond);
let cleanedOn = "";

/** The text to keep for a search, or null when it shouldn't be kept. */
export function missText(q: string): string | null {
  const t = q.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().toLowerCase().slice(0, M.maxLength);
  if ([...t].length < 2) return null;
  if (/@/.test(t) || /\d{6,}/.test(t.replace(/[\s.\-/()+]/g, ""))) return null;
  return t;
}

/** Counts one search that found nothing. Never throws (a report must not break the shop). */
export async function recordSearchMiss(db: Db, q: string, visitor: string, now = Date.now()): Promise<void> {
  try {
    const t = missText(q);
    if (!t || !perVisitor.take(visitor, now)) return;
    const { timezone } = await getSettings(db);
    const day = instantToLocal(now, timezone).slice(0, 10);
    const at = new Date(now).toISOString();
    const id = `${day}|${t}`;
    if (await db.searchMisses.updateWhere(id, {}, { inc: { count: 1 }, set: { lastAt: at } })) return;
    if ((await db.searchMisses.count({ day })) >= M.maxTextsPerDay) return;
    try { await db.searchMisses.insert({ id, day, q: t, count: 1, firstAt: at, lastAt: at }); }
    catch (e) { if (e instanceof DuplicateKeyError) await db.searchMisses.updateWhere(id, {}, { inc: { count: 1 }, set: { lastAt: at } }); else throw e; }
    if (cleanedOn !== day) {
      cleanedOn = day;
      const cutoff = instantToLocal(now - M.retentionDays * 24 * 3600 * 1000, timezone).slice(0, 10);
      for (const old of await db.searchMisses.find({ day: { $lt: cutoff } })) await db.searchMisses.delete(old.id);
    }
  } catch (e) { console.warn("OpenShop: a search without results could not be counted", e); }
}

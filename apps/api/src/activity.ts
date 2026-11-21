import { createHash, randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { DuplicateKeyError, type Filter } from "@openshop/db";
import type { ActivityEvent, ActivityKind, Db } from "./types.ts";

// The activity log: sign-ins, link use, backoffice page views, changes and denied access, in one collection.
// Ids are `${ISO time}~${random}`, so the primary key is the time index (newest first, cursor paging) in both adapters.

export const ACTIVITY_KINDS: ActivityKind[] = ["sign_in", "sign_in_failed", "sign_out", "session_ended", "link_created", "link_opened", "link_used", "link_revoked", "link_invalid", "page_view", "page_denied", "api_denied", "api_unauthenticated", "change", "dropped"];
export const activityId = (at: string) => `${at}~${randomBytes(5).toString("hex")}`;
const clip = (s: unknown, n = 200) => (typeof s === "string" ? s.slice(0, n) : null);

type Fields = Omit<ActivityEvent, "id" | "at" | "kind" | "userId"> & { userId?: string | null };

/** Where a request came from, for the log. User-controlled values are truncated. */
export const origin = (req?: FastifyRequest) => (req ? { ip: req.ip, userAgent: clip(req.headers["user-agent"]) } : {});

/** Appends an event. Never throws into the caller: losing a log line must not fail a sign-in or a change. */
export async function recordActivity(db: Db, kind: ActivityKind, fields: Fields, req?: FastifyRequest, now = new Date()): Promise<void> {
  const at = now.toISOString();
  try { await db.activity.insert({ id: activityId(at), at, kind, userId: null, ...origin(req), ...fields }); }
  catch (e) { console.error("activity log write failed", e); }
}

/**
 * Repeated events (401s, 403s, throttled sign-ins): one row per minute and key, counted atomically with
 * a deterministic id, so a scanner can't flood the log. Above `ceiling` new rows per minute (per process), the rest
 * only increments a single "dropped" row.
 */
export function createAggregator(db: Db, ceiling = 1000) {
  let minute = "", created = 0;
  return async function aggregate(kind: ActivityKind, fields: Fields, req?: FastifyRequest, now = new Date()): Promise<void> {
    const m = now.toISOString().slice(0, 16) + ":00.000Z";
    if (m !== minute) { minute = m; created = 0; }
    const o = origin(req);
    const key = createHash("sha256").update(JSON.stringify([kind, o.ip ?? "", fields.method ?? "", fields.path ?? "", fields.reason ?? "", fields.permission ?? "", fields.userId ?? ""])).digest("hex").slice(0, 16);
    const bump = async (id: string, doc: Omit<ActivityEvent, "id">) => {
      try {
        if (await db.activity.updateWhere(id, {}, { inc: { count: 1 } })) return true;
        await db.activity.insert({ id, ...doc, count: 1 });
        return true;
      } catch (e) {
        if (e instanceof DuplicateKeyError) { await db.activity.updateWhere(id, {}, { inc: { count: 1 } }); return true; }
        console.error("activity log write failed", e); return false;
      }
    };
    const id = `${m}~${key}`;
    if (created >= ceiling && !(await db.activity.get(id))) { await bump(`${m}~dropped`, { at: m, kind: "dropped", userId: null }); return; }
    if (!(await db.activity.get(id))) created++;
    await bump(id, { at: m, kind, userId: null, ...o, ...fields });
  };
}

export interface ActivityQuery { kinds?: ActivityKind[]; userId?: string; ip?: string; from?: string; to?: string; q?: string; before?: string; limit?: number }

/**
 * Newest first. Filters on kind, person and IP go to the store; the text search is applied while paging through
 * batches, so a page still holds `limit` matches when there are enough (at most `scanMax` rows are read per call).
 */
export async function queryActivity(db: Db, q: ActivityQuery, scanMax = 20_000): Promise<{ items: ActivityEvent[]; next: string | null }> {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 10_000);
  const base: Filter = {};
  if (q.kinds?.length) base.kind = { $in: q.kinds };
  if (q.userId) base.userId = q.userId;
  if (q.ip) base.ip = q.ip;
  const needle = (q.q ?? "").trim().toLowerCase();
  const match = (e: ActivityEvent) => !needle || [e.kind, e.path, e.reason, e.permission, e.action, e.entity, e.entityId, e.ip, e.userAgent, e.feature].some((v) => typeof v === "string" && v.toLowerCase().includes(needle));
  let upper = q.before && (!q.to || q.before < q.to) ? q.before : q.to ?? null;
  const items: ActivityEvent[] = [];
  let scanned = 0, next: string | null = null;
  for (;;) {
    const idf: Record<string, string> = {};
    if (upper) idf.$lt = upper;
    if (q.from) idf.$gte = q.from;
    const batch = await db.activity.find({ ...base, ...(Object.keys(idf).length ? { id: idf } : {}) }, { sort: { id: -1 }, limit: 500 });
    for (const e of batch) {
      scanned++;
      if (match(e)) items.push(e);
      if (items.length === limit) return { items, next: e.id };
    }
    if (batch.length < 500) return { items, next: null };
    upper = batch[batch.length - 1].id;
    if (scanned >= scanMax) { next = upper; return { items, next }; }
  }
}

/** Deletes events older than the retention period. */
export async function pruneActivity(db: Db, retentionDays: number, now = Date.now()): Promise<number> {
  return db.activity.deleteWhere({ id: { $lt: new Date(now - retentionDays * 86_400_000).toISOString() } });
}

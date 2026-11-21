import { activityId } from "./activity.ts";
import type { Db } from "./types.ts";

/**
 * Append-only record of who changed what. Values are stored as given (offers, settings, codes); callers pass
 * projections for sensitive records (never password or token hashes). Every entry also appears in the activity log
 * as a "change" event that points back here (full before/after stays in the audit log, which is never pruned).
 */
export async function audit(db: Db, userId: string, action: string, entity: string, entityId: string, before?: unknown, after?: unknown) {
  const at = new Date().toISOString();
  const row = await db.audit.insert({ at, userId, action, entity, entityId, ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) });
  try { await db.activity.insert({ id: activityId(at), at, kind: "change", userId, action, entity, entityId, auditId: row.id }); }
  catch (e) { console.error("activity log write failed", e); }
}

export interface AuditQuery { entity?: string; entityId?: string; action?: string; userId?: string; from?: string; to?: string; before?: string | null; limit?: number }
type AuditRow = Awaited<ReturnType<Db["audit"]["find"]>>[number];

/** Cursor for paging: time and id of the last entry shown (audit ids are random, so time alone isn't unique). */
export const auditCursor = (e: { at: string; id: string }) => Buffer.from(`${e.at}|${e.id}`).toString("base64url");
function parseCursor(c?: string | null): { at: string; id: string } | null {
  if (!c) return null;
  const [at, id] = Buffer.from(c, "base64url").toString().split("|");
  return at && id && !Number.isNaN(Date.parse(at)) ? { at, id } : null;
}

/**
 * The audit log, newest first, one page at a time (filters: record, action, person, time range). Ordered by time,
 * then id, so paging is exact even when entries share a timestamp, and unaffected by entries added meanwhile.
 */
export async function queryAudit(db: Db, q: AuditQuery): Promise<{ items: AuditRow[]; next: string | null }> {
  const limit = Math.min(Math.max(Math.trunc(q.limit ?? 50), 1), 10_000);
  const base: Record<string, string | Record<string, string>> = {};
  if (q.entity) base.entity = q.entity;
  if (q.entityId) base.entityId = q.entityId;
  if (q.action) base.action = q.action;
  if (q.userId) base.userId = q.userId;
  const range: Record<string, string> = {};
  if (q.from) range.$gte = q.from;
  if (q.to) range.$lt = q.to;
  const cur = parseCursor(q.before);
  const sort = { at: -1, id: -1 } as const;
  let items: AuditRow[] = [];
  if (cur) {
    // Same instant as the cursor, smaller id; then everything strictly older.
    if ((!q.from || cur.at >= q.from) && (!q.to || cur.at < q.to)) items = await db.audit.find({ ...base, at: cur.at, id: { $lt: cur.id } }, { sort, limit: limit + 1 });
    if (items.length <= limit) items = items.concat(await db.audit.find({ ...base, at: { ...range, $lt: q.to && q.to < cur.at ? q.to : cur.at } }, { sort, limit: limit + 1 - items.length }));
  } else items = await db.audit.find({ ...base, ...(Object.keys(range).length ? { at: range } : {}) }, { sort, limit: limit + 1 });
  const page = items.slice(0, limit);
  return { items: page, next: items.length > limit ? auditCursor(page[page.length - 1]) : null };
}

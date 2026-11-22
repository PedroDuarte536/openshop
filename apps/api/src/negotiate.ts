import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Picks the best of `offered` media types for the request's Accept header (q-values, type/* and * / *).
 * No Accept header means the first offered type. Returns null when nothing acceptable is offered (-> 406).
 */
export function negotiate(accept: string | undefined, offered: string[]): string | null {
  if (!accept || !accept.trim()) return offered[0];
  const ranges = accept.split(",").map((part, i) => {
    const [range, ...params] = part.trim().split(";").map((s) => s.trim());
    const qp = params.find((p) => p.startsWith("q="));
    const q = qp ? Number(qp.slice(2)) : 1;
    return { range: range.toLowerCase(), q: Number.isFinite(q) ? q : 0, i };
  }).filter((r) => r.range);
  let best: { type: string; q: number; spec: number; i: number } | null = null;
  offered.forEach((type, oi) => {
    const [t] = type.split("/");
    for (const r of ranges) {
      const spec = r.range === type ? 3 : r.range === `${t}/*` ? 2 : r.range === "*/*" ? 1 : 0;
      if (!spec || r.q <= 0) continue;
      const cand = { type, q: r.q, spec, i: oi };
      if (!best || cand.q > best.q || (cand.q === best.q && cand.spec > best.spec) || (cand.q === best.q && cand.spec === best.spec && cand.i < best.i)) best = cand;
    }
  });
  // An explicit q=0 for the winning type wins over a wildcard.
  const chosen = best as { type: string } | null;
  if (chosen && ranges.some((r) => r.range === chosen.type && r.q <= 0)) return null;
  return chosen ? chosen.type : null;
}

/** Neutralises spreadsheet formulas and quotes per RFC 4180. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const csvRow = (cells: unknown[]) => cells.map(csvCell).join(",") + "\r\n";

export const LIST_TYPES = ["application/json", "text/csv"];

/**
 * Sends a list resource as JSON ({ items, total }) or CSV, chosen by the Accept header. Same URL, same filters.
 * `columns` maps CSV headers to item fields.
 */
export function sendList<T>(req: FastifyRequest, reply: FastifyReply, opts: { items: T[]; total: number; filename: string; columns: [string, (item: T) => unknown][] }) {
  reply.header("vary", "Accept");
  const type = negotiate(req.headers.accept, LIST_TYPES);
  if (!type) return reply.code(406).send({ error: "not acceptable", accepts: LIST_TYPES });
  if (type === "text/csv") {
    const body = "\uFEFF" + csvRow(opts.columns.map(([h]) => h)) + opts.items.map((it) => csvRow(opts.columns.map(([, f]) => f(it)))).join("");
    return reply.type("text/csv; charset=utf-8").header("content-disposition", `attachment; filename="${opts.filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`).send(body);
  }
  return reply.type("application/json; charset=utf-8").send({ items: opts.items, total: opts.total });
}

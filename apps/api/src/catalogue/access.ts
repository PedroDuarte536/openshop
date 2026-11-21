import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Requirement } from "@openshop/iam";

/**
 * The staff permissions of the catalogue admin routes. The catalogue modules register their routes on a plain
 * `admin` scope; this wrapper gives each route the `config.perm` that the authorizer requires (default deny):
 *   reads (products, search, exports, properties, variant groups, import jobs) -> catalog.view
 *   every change (create, edit, delete, restore, bulk, properties, variants, imports) -> catalog.manage
 * Stock-only edits of one product (PATCH /api/products/:id with only `stock`) need just catalog.stock, so the
 * route accepts either permission and the body decides (see `stockOnly`).
 */
export type Allow = (req: FastifyRequest, reply: FastifyReply, requirement: Requirement) => Promise<boolean>;

const METHODS = new Set(["get", "post", "put", "patch", "delete"]);
export const stockOnly = (body: unknown) => !!body && typeof body === "object" && Object.keys(body as object).length > 0 && Object.keys(body as object).every((k) => k === "stock");

export function permissioned(admin: FastifyInstance, allow: Allow): FastifyInstance {
  return new Proxy(admin, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && METHODS.has(prop)) {
        return (url: string, ...rest: unknown[]) => {
          const read = prop === "get";
          const stockPatch = prop === "patch" && url === "/api/products/:id";
          const perm: Requirement = read ? "catalog.view" : stockPatch ? { any: ["catalog.stock", "catalog.manage"] } : "catalog.manage";
          const handler = rest.pop();
          const opts = ((rest[0] as Record<string, unknown> | undefined) ?? {}) as { config?: Record<string, unknown>; preHandler?: unknown };
          const withPerm = { ...opts, config: { ...(opts.config ?? {}), perm } } as Record<string, unknown>;
          if (stockPatch) {
            const before = opts.preHandler;
            withPerm.preHandler = [
              ...(Array.isArray(before) ? before : before ? [before] : []),
              async (req: FastifyRequest, reply: FastifyReply) => { if (!stockOnly(req.body) && !(await allow(req, reply, "catalog.manage"))) return reply; },
            ];
          }
          return (Reflect.get(target, prop, receiver) as (...a: unknown[]) => unknown).call(target, url, withPerm, handler);
        };
      }
      // Child scopes (e.g. the raw-body import upload) get the same wrapper.
      if (prop === "register") {
        return (plugin: (child: FastifyInstance, o: unknown) => Promise<void> | void, o?: unknown) =>
          (target as unknown as { register: (...a: unknown[]) => unknown }).register(async (child: FastifyInstance, popts: unknown) => plugin(permissioned(child, allow), popts), o);
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

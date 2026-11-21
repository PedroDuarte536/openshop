import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from "fastify";
import { effective, requirementIds, satisfies, type Requirement } from "@openshop/iam";
import { checkToken } from "./auth.ts";
import type { createAggregator } from "./activity.ts";
import type { Db, User } from "./types.ts";

declare module "fastify" {
  interface FastifyContextConfig { perm?: Requirement }
  interface FastifyRequest { staff?: StaffContext }
}

/** The signed-in staff member for this request. Resolved on every request (never cached), so changes apply at once. */
export interface StaffContext { id: string; name: string; email: string; sudo: boolean; perms: Set<string>; mustChangePassword: boolean }

export async function loadStaff(db: Db, user: User): Promise<StaffContext> {
  let perms: Set<string>;
  if (user.sudo) perms = effective(user, []);
  else {
    const memberships = await db.staffMemberships.find({ userId: user.id });
    const groups = memberships.length ? await db.staffGroups.find({ id: { $in: memberships.map((m) => m.groupId) } }) : [];
    perms = effective(user, groups);
  }
  return { id: user.id, name: user.name, email: user.email, sudo: user.sudo, perms, mustChangePassword: !!user.mustChangePassword };
}

/** Routes a member who must change their password can still use. */
const DURING_PASSWORD_CHANGE = (url: string) => url.startsWith("/api/me") || url === "/api/auth/logout" || url === "/api/activity/beacon";

export interface AdminRoute { method: string; url: string; perm: Requirement }

export function createAuthorizer(db: Db, secret: string, aggregate: ReturnType<typeof createAggregator>) {
  const routeOf = (req: FastifyRequest) => req.routeOptions.url ?? req.url.split("?")[0];

  async function forbid(req: FastifyRequest, reply: FastifyReply, req_: Requirement) {
    const ids = requirementIds(req_);
    // Counted per minute and member, route and missing permission (like 401s), so repeated refusals can't flood the log.
    await aggregate("api_denied", { userId: req.staff?.id ?? null, path: routeOf(req), method: req.method, permission: ids.join(typeof req_ === "object" && "any" in req_ ? " or " : " + ") }, req);
    return reply.code(403).send({ error: "You don't have permission to do this.", code: "forbidden", permission: ids });
  }

  /** onRequest for the admin scope: a valid admin token of an active user with the current session version, then the route's permission. */
  async function authenticate(req: FastifyRequest, reply: FastifyReply) {
    // Everything behind a staff session is private: never kept by a browser or a shared cache.
    reply.header("cache-control", "no-store");
    const h = req.headers.authorization ?? "";
    const refuse = async (kind: "api_unauthenticated" | "session_ended", reason: string, userId: string | null = null) => {
      await aggregate(kind, { path: routeOf(req), method: req.method, reason, userId }, req);
      return reply.code(401).send({ error: "unauthorized" });
    };
    if (!h.startsWith("Bearer ")) return refuse("api_unauthenticated", "no_token");
    const t = checkToken(h.slice(7), secret, "admin");
    if ("reason" in t) return refuse("api_unauthenticated", t.reason);
    const user = await db.users.get(t.claims.sub);
    if (!user) return refuse("api_unauthenticated", "bad_token");
    if (user.status !== "active") return refuse("session_ended", user.status, user.id);
    if (t.claims.sv !== (user.sessionVersion ?? 0)) return refuse("session_ended", "session_ended", user.id);
    req.staff = await loadStaff(db, user);
    const url = routeOf(req);
    if (req.staff.mustChangePassword && !DURING_PASSWORD_CHANGE(url)) {
      return reply.code(403).send({ error: "Choose a new password first.", code: "password_change_required" });
    }
    const perm = req.routeOptions.config?.perm;
    if (!perm) return reply.code(403).send({ error: "forbidden", code: "forbidden" }); // unreachable: the boot check refuses such routes
    if (!satisfies(req.staff, perm)) return forbid(req, reply, perm);
  }

  /** For rules that depend on the request body. Sends the 403 (and logs it) when not allowed. */
  async function allow(req: FastifyRequest, reply: FastifyReply, requirement: Requirement): Promise<boolean> {
    if (satisfies(req.staff, requirement)) return true;
    await forbid(req, reply, requirement);
    return false;
  }

  /**
   * Default deny, checked at start-up: every route registered in the admin scope must declare `config.perm`,
   * otherwise the server refuses to start. The list is kept for the route-coverage tests.
   */
  function guardScope(scope: FastifyInstance, registry: AdminRoute[]) {
    scope.addHook("onRoute", (opts: RouteOptions) => {
      const perm = (opts.config as { perm?: Requirement } | undefined)?.perm;
      if (!perm) throw new Error(`Admin route ${String(opts.method)} ${opts.url} declares no permission (config.perm)`);
      for (const m of [opts.method].flat()) if (m !== "HEAD") registry.push({ method: m, url: opts.url!, perm });
    });
    scope.addHook("onRequest", authenticate);
  }

  return { authenticate, allow, guardScope };
}
export type Authorizer = ReturnType<typeof createAuthorizer>;

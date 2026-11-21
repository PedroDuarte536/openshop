import { PERMISSION_IDS, permission, type PermissionId } from "./catalog.ts";

/**
 * What a route, a screen or an action needs:
 * - a permission id; `{ all }` / `{ any }` of permission ids;
 * - "authenticated": any active staff member; "sudo": the owner only.
 */
export type Requirement = PermissionId | "authenticated" | "sudo" | { all: PermissionId[] } | { any: PermissionId[] };

/** Adds everything the given permissions require, transitively. Unknown ids throw. */
export function closure(ids: Iterable<string>): Set<PermissionId> {
  const out = new Set<PermissionId>();
  const visit = (id: string) => {
    const p = permission(id);
    if (!p) throw new Error(`Unknown permission: ${id}`);
    if (out.has(p.id as PermissionId)) return;
    out.add(p.id as PermissionId);
    p.requires.forEach(visit);
  };
  for (const id of ids) visit(id);
  return out;
}

/** Sorted, closed, de-duplicated: the form groups are stored in. */
export const normalizePermissions = (ids: Iterable<string>): PermissionId[] => { const c = closure(ids); return PERMISSION_IDS.filter((id) => c.has(id)); };

export interface Principal { sudo: boolean; perms: ReadonlySet<string> }

/** Effective permissions: every permission for the owner; otherwise the closure of the union of the groups. */
export function effective(user: { sudo: boolean }, groups: { permissions: string[] }[]): Set<PermissionId> {
  if (user.sudo) return new Set(PERMISSION_IDS);
  return closure(groups.flatMap((g) => g.permissions.filter((p) => permission(p))));
}

export function satisfies(who: Principal | null | undefined, req: Requirement): boolean {
  if (!who) return false;
  if (who.sudo) return true;
  if (req === "authenticated") return true;
  if (req === "sudo") return false;
  if (typeof req === "string") return who.perms.has(req);
  if ("all" in req) return req.all.every((p) => who.perms.has(p));
  return req.any.some((p) => who.perms.has(p));
}

/** The permission ids named by a requirement (for "this needs…" messages). */
export function requirementIds(req: Requirement): string[] {
  if (typeof req === "string") return [req];
  return "all" in req ? req.all : req.any;
}

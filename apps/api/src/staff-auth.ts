import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { PASSWORD_MAX, PERMISSION_IDS, policyRules, type PasswordIssue } from "@openshop/iam";
import { hashPassword, normalizeStaffEmail, staffToken, verifyPassword } from "./auth.ts";
import { FailureLimiter } from "./limiter.ts";
import { recordActivity, type createAggregator } from "./activity.ts";
import { getSecurity, passwordIssues } from "./security.ts";
import { strictValidator } from "./strict.ts";
import { audit } from "./audit.ts";
import type { Staff } from "./staff.ts";
import type { Db } from "./types.ts";

const strict = { validatorCompiler: strictValidator };
const noStore = (reply: FastifyReply) => reply.header("cache-control", "no-store");
const policyError = (reply: FastifyReply, issues: PasswordIssue[]) =>
  reply.code(400).send({ error: issues.map((i) => i.message).join(" "), code: "password_policy", issues });

interface Deps { db: Db; staff: Staff; secret: string; aggregate: ReturnType<typeof createAggregator> }

/** The public staff routes take JSON only (never a cross-site HTML form). */
const jsonOnly = { onRequest: async (req: FastifyRequest, reply: FastifyReply) => {
  if (!/^application\/json\s*(;|$)/i.test(req.headers["content-type"] ?? "")) return reply.code(415).send({ error: "Send JSON (application/json).", code: "unsupported_media_type" });
} };

/** Public: sign-in and the one-time invite/reset links. */
export function registerStaffAuth(app: FastifyInstance, { db, staff, secret, aggregate }: Deps) {
  // Blocking is per address, and per address + account: one address can't spray many accounts or hammer one. The
  // per-account limit alone is much higher: it slows guessing spread over many addresses, but a handful of failures
  // from elsewhere can't lock the owner (or anyone) out of their own account.
  const perSource = new FailureLimiter(10, 10 * 60_000);
  const perAccount = new FailureLimiter(100, 10 * 60_000);
  const linkTries = new FailureLimiter(30, 10 * 60_000);
  // A real scrypt hash to verify against when there is no usable one, so timing doesn't reveal which accounts exist.
  const dummyHash = hashPassword(randomBytes(16).toString("hex"));

  app.post("/api/auth/login", {
    ...jsonOnly,
    schema: { body: { type: "object", required: ["email", "password"], additionalProperties: false, properties: { email: { type: "string", maxLength: 254 }, password: { type: "string", maxLength: PASSWORD_MAX } } } },
  }, async (req, reply) => {
    noStore(reply);
    const { email: raw, password } = req.body as { email: string; password: string };
    const email = normalizeStaffEmail(raw);
    const source = [`ip:${req.ip}`, `pair:${email}|${req.ip}`], account = [`account:${email}`];
    const [u] = email ? await db.users.find({ email }, { limit: 1 }) : [];
    if (perSource.blocked(source) || perAccount.blocked(account)) {
      await aggregate("sign_in_failed", { reason: "throttled", userId: u?.id ?? null }, req);
      return reply.code(429).send({ error: "too many attempts" });
    }
    const ok = await verifyPassword(password, u?.passwordHash ?? (await dummyHash));
    const reason = !u ? "unknown_account" : u.status !== "active" ? u.status : !ok ? "bad_password" : null;
    if (reason) {
      perSource.fail(source); perAccount.fail(account);
      // The typed email is never stored for unknown accounts (people sometimes type their password there).
      await recordActivity(db, "sign_in_failed", { userId: u?.id ?? null, reason }, req);
      return reply.code(401).send({ error: "invalid credentials" });
    }
    perSource.clear([`pair:${email}|${req.ip}`]);
    const sec = await getSecurity(db);
    const mustChange = sec.enforceStaffPolicyAtSignIn && (await passwordIssues(db, "staff", password, u!.email)).length > 0;
    const updated = (await db.users.updateWhere(u!.id, {}, { set: { lastLoginAt: new Date().toISOString(), ...(mustChange ? { mustChangePassword: true } : {}) } }))!;
    await recordActivity(db, "sign_in", { userId: u!.id, ...(mustChange ? { reason: "password_change_required" } : {}) }, req);
    return { token: staffToken(updated, secret), mustChangePassword: !!updated.mustChangePassword };
  });

  const tokenBody = { type: "object", additionalProperties: false, required: ["token"], properties: { token: { type: "string", maxLength: 200 } } } as const;
  const invalidLink = async (req: FastifyRequest, reply: FastifyReply) => {
    linkTries.fail([`ip:${req.ip}`]);
    await recordActivity(db, "link_invalid", {}, req);
    return reply.code(410).send({ error: "This link is no longer valid. Ask the shop owner for a new one.", code: "link_invalid" });
  };

  app.post("/api/auth/links/inspect", { ...jsonOnly, schema: { body: tokenBody }, ...strict }, async (req, reply) => {
    noStore(reply).header("referrer-policy", "no-referrer");
    if (linkTries.blocked([`ip:${req.ip}`])) return reply.code(429).send({ error: "too many attempts" });
    const link = await staff.findLink((req.body as { token: string }).token);
    const user = link ? await db.users.get(link.userId) : null;
    if (!link || !user || user.status === "removed") return invalidLink(req, reply);
    await recordActivity(db, "link_opened", { userId: user.id, targetUserId: user.id, purpose: link.purpose }, req);
    const [home] = await db.pages.find({ slug: "home" }, { limit: 1 });
    const { passwordPolicy } = await getSecurity(db);
    return { purpose: link.purpose, email: user.email, name: user.name, shopName: home?.title || "OpenShop", expiresAt: link.expiresAt, passwordPolicy: passwordPolicy.staff, rules: policyRules(passwordPolicy.staff) };
  });

  app.post("/api/auth/links/consume", {
    ...jsonOnly,
    schema: { body: { type: "object", additionalProperties: false, required: ["token", "password"], properties: { token: { type: "string", maxLength: 200 }, password: { type: "string", maxLength: PASSWORD_MAX } } } }, ...strict,
  }, async (req, reply) => {
    noStore(reply).header("referrer-policy", "no-referrer");
    if (linkTries.blocked([`ip:${req.ip}`])) return reply.code(429).send({ error: "too many attempts" });
    const { token, password } = req.body as { token: string; password: string };
    const link = await staff.findLink(token);
    const user = link ? await db.users.get(link.userId) : null;
    if (!link || !user || user.status === "removed") return invalidLink(req, reply);
    const issues = await passwordIssues(db, "staff", password, user.email);
    if (issues.length) return policyError(reply, issues);
    const updated = await staff.consume(link, password);
    if (!updated) return invalidLink(req, reply);
    await recordActivity(db, "link_used", { userId: updated.id, targetUserId: updated.id, purpose: link.purpose }, req);
    if (updated.status !== "active") return { token: null, status: updated.status };
    await db.users.updateWhere(updated.id, {}, { set: { lastLoginAt: new Date().toISOString() } });
    await recordActivity(db, "sign_in", { userId: updated.id, reason: `via_${link.purpose}_link` }, req);
    return { token: staffToken(updated, secret), status: updated.status };
  });
}

/** Signed-in staff (any permissions): who am I, my password, my sessions, sign-out, page-view beacons. */
export function registerStaffSelf(admin: FastifyInstance, { db, secret }: Deps) {
  const wrongCurrent = new FailureLimiter(5, 10 * 60_000);
  const beacons = new Map<string, { n: number; reset: number }>();
  const me = (req: FastifyRequest) => req.staff!;
  const auth = { config: { perm: "authenticated" as const } };

  admin.get("/api/me", auth, async (req, reply) => {
    noStore(reply);
    const s = me(req);
    const [owner] = await db.users.find({ sudo: true }, { limit: 1 });
    const sec = await getSecurity(db);
    return {
      id: s.id, email: s.email, name: s.name, sudo: s.sudo, permissions: PERMISSION_IDS.filter((p) => s.perms.has(p)), mustChangePassword: s.mustChangePassword,
      owner: { name: owner?.name ?? "the shop owner" }, passwordPolicy: sec.passwordPolicy.staff, passwordRules: policyRules(sec.passwordPolicy.staff), activityRetentionDays: sec.activityRetentionDays,
    };
  });

  admin.post("/api/me/password", {
    ...auth, ...strict,
    schema: { body: { type: "object", additionalProperties: false, required: ["current", "password"], properties: { current: { type: "string", maxLength: PASSWORD_MAX }, password: { type: "string", maxLength: PASSWORD_MAX } } } },
  }, async (req, reply) => {
    noStore(reply);
    const { current, password } = req.body as { current: string; password: string };
    const user = (await db.users.get(me(req).id))!;
    const key = [`user:${user.id}`];
    if (wrongCurrent.blocked(key)) return reply.code(429).send({ error: "Too many attempts. Please wait a few minutes." });
    if (!user.passwordHash || !(await verifyPassword(current, user.passwordHash))) {
      wrongCurrent.fail(key);
      return reply.code(400).send({ error: "Your current password is not correct.", code: "wrong_password", fields: [{ field: "current", message: "not correct" }] });
    }
    const issues = await passwordIssues(db, "staff", password, user.email);
    if (issues.length) return policyError(reply, issues);
    if (current === password) return reply.code(400).send({ error: "Choose a password different from your current one.", code: "same_password" });
    const updated = (await db.users.updateWhere(user.id, {}, { set: { passwordHash: await hashPassword(password), mustChangePassword: false }, inc: { sessionVersion: 1 } }))!;
    await audit(db, user.id, "password-change", "staff", user.id);
    return { token: staffToken(updated, secret) };
  });

  admin.post("/api/me/sign-out-everywhere", auth, async (req, reply) => {
    await db.users.updateWhere(me(req).id, {}, { inc: { sessionVersion: 1 } });
    await audit(db, me(req).id, "sign-out-everywhere", "staff", me(req).id);
    return reply.code(204).send();
  });

  admin.post("/api/auth/logout", auth, async (req, reply) => {
    await recordActivity(db, "sign_out", { userId: me(req).id }, req);
    return reply.code(204).send();
  });

  // Page views and "no access" pages, reported by the backoffice (the server doesn't see SPA navigation). The user is
  // taken from the token, never from the body; the path is reduced to a pathname. Informational, not evidence.
  admin.post("/api/activity/beacon", {
    ...auth, ...strict,
    schema: { body: { type: "object", additionalProperties: false, required: ["kind", "path"], properties: { kind: { type: "string", enum: ["page_view", "page_denied"] }, path: { type: "string", maxLength: 400 }, feature: { type: ["string", "null"], maxLength: 40 }, permission: { type: ["string", "null"], maxLength: 200 } } } },
  }, async (req, reply) => {
    const s = me(req), now = Date.now();
    const b = beacons.get(s.id);
    if (b && b.reset > now && b.n >= 120) return reply.code(429).send({ error: "too many" });
    beacons.set(s.id, b && b.reset > now ? { n: b.n + 1, reset: b.reset } : { n: 1, reset: now + 60_000 });
    const body = req.body as { kind: "page_view" | "page_denied"; path: string; feature?: string | null; permission?: string | null };
    const path = ("/" + body.path.split(/[?#]/)[0].replace(/^\/+/, "")).slice(0, 200);
    await recordActivity(db, body.kind, { userId: s.id, path, feature: body.feature ?? null, permission: body.permission ?? null }, req);
    return reply.code(204).send();
  });
}

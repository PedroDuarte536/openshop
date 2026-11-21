import type { FastifyInstance, FastifyReply } from "fastify";
import { esc } from "@openshop/renderer";
import { verifyPassword } from "./auth.ts";
import { FailureLimiter } from "./limiter.ts";
import { PASSWORD_MAX, policyRules, type PasswordPolicy } from "@openshop/iam";
import type { Accounts } from "./accounts.ts";
import { getSecurity, passwordIssues } from "./security.ts";
import { html, page } from "./storefront.ts";
import type { Db } from "./types.ts";
import { CONFIG } from "./config.ts";

// Storefront account pages (server-rendered forms). Accounts are created by the shop owner: there is no sign-up and
// no email. The customer opens the one-time link the owner shared, sets a password, and is signed in.

/** Only local shop paths, so "next" can't send anyone to another site. */
const safeNext = (v: unknown) => (typeof v === "string" && /^\/shop(\/[A-Za-z0-9/_-]*)?$/.test(v) ? v : "/shop/account");

export function registerAccountPages(app: FastifyInstance, { db, accounts }: { db: Db; accounts: Accounts }) {
  const logins = new FailureLimiter(CONFIG.accounts.loginMaxFailures, CONFIG.accounts.loginWindowMs);
  // Account pages are personal, and link tokens must not leak through the Referer header.
  const personal = (reply: FastifyReply) => reply.header("cache-control", "private, no-store").header("referrer-policy", "no-referrer");

  const loginForm = (next: string, message = "") => page("Sign in", `<h1>Sign in</h1>`
    + (message ? `<p class="os-msg os-msg--bad" role="alert">${esc(message)}</p>` : "")
    + `<form method="post" action="/shop/account/login" class="os-stack"><input type="hidden" name="next" value="${esc(next)}">`
    + `<input name="email" type="email" placeholder="Email" autocomplete="username" required><input name="password" type="password" placeholder="Password" autocomplete="current-password" required><button>Sign in</button></form>`
    + `<p class="os-msg">Customer accounts are created by the shop. If you received a link to set your password, open it first.</p>`);

  app.get<{ Querystring: { next?: string } }>("/shop/account", async (req, reply) => {
    personal(reply);
    const account = await accounts.account(req);
    if (!account) return html(reply, loginForm(safeNext(req.query.next)));
    const c = account.customer;
    return html(reply, page("Your account", `<h1>Hello, ${esc(c.name)}</h1><p class="os-msg">Signed in as ${esc(c.email)}. <a href="/shop/cart">Go to your cart</a></p>`
      + `<h2>Your offers</h2><div id="os-account-offers" class="os-account-offers" aria-live="polite"><p class="os-msg">Loading your offers…</p></div>`
      + `<noscript><p class="os-msg">Turn on JavaScript to see your offers. They are applied in your cart either way.</p></noscript>`
      + `<div class="os-codeform"><form method="post" action="/shop/account/logout"><button>Sign out</button></form>`
      + `<form method="post" action="/shop/account/logout-everywhere"><button class="os-linkbtn">Sign out on all devices</button></form></div>`));
  });

  app.post<{ Body: { email?: string; password?: string; next?: string } }>("/shop/account/login", async (req, reply) => {
    personal(reply);
    const email = String(req.body?.email ?? "").trim().toLowerCase().slice(0, 254), password = String(req.body?.password ?? "").slice(0, 200);
    const next = safeNext(req.body?.next);
    const keys = [`ip:${req.ip}`, `email:${email}`];
    if (logins.blocked(keys)) return html(reply, loginForm(next, "Too many attempts. Please wait a few minutes and try again."), 429);
    const [c] = email ? await db.customers.find({ email }, { limit: 1 }) : [];
    const activated = !!(c?.passwordHash && c.activatedAt);
    // Always verify a real hash, so the response time doesn't reveal which emails have accounts.
    const ok = await verifyPassword(password, activated ? c!.passwordHash! : await accounts.dummyHash);
    if (!activated || !ok) {
      logins.fail(keys);
      return html(reply, loginForm(next, "That email and password don't match."), 401);
    }
    logins.clear([`email:${email}`]);
    accounts.signIn(reply, c!);
    return reply.redirect(next, 303);
  });

  app.post("/shop/account/logout", async (_req, reply) => {
    personal(reply);
    accounts.signOut(reply);
    return reply.redirect("/shop", 303);
  });

  app.post("/shop/account/logout-everywhere", async (req, reply) => {
    personal(reply);
    const account = await accounts.account(req);
    if (account) await db.customers.updateWhere(account.customer.id, {}, { inc: { sessionVersion: 1 } });
    accounts.signOut(reply);
    return reply.redirect("/shop", 303);
  });

  // One-time links from the owner: /shop/account/activate/<token> and /shop/account/reset/<token>.
  const expired = () => page("Link not valid", `<h1>This link is no longer valid</h1><p>It has expired or was already used. Please ask the shop for a new link.</p>`);
  // The rules come from the customer password policy (Settings → Security in the backoffice).
  const setForm = (email: string, policy: PasswordPolicy, message = "") => page("Set your password", `<h1>Set your password</h1><p class="os-msg">For ${esc(email)}.</p>`
    + `<ul class="os-msg">${policyRules(policy).map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`
    + (message ? `<p class="os-msg os-msg--bad" role="alert">${esc(message)}</p>` : "")
    + `<form method="post" class="os-stack"><input name="password" type="password" placeholder="New password" minlength="${policy.minLength}" maxlength="${PASSWORD_MAX}" autocomplete="new-password" required>`
    + `<input name="confirm" type="password" placeholder="Repeat the password" minlength="${policy.minLength}" maxlength="${PASSWORD_MAX}" autocomplete="new-password" required><button>Save and sign in</button></form>`);
  const customerPolicy = async () => (await getSecurity(db)).passwordPolicy.customers;

  app.get<{ Params: { purpose: string; token: string } }>("/shop/account/:purpose/:token", async (req, reply) => {
    personal(reply);
    const { purpose, token } = req.params;
    if (purpose !== "activate" && purpose !== "reset") return html(reply, expired(), 404);
    const link = await accounts.findLink(token, purpose);
    const c = link ? await db.customers.get(link.customerId) : null;
    if (!link || !c) return html(reply, expired(), 410);
    return html(reply, setForm(c.email, await customerPolicy()));
  });

  app.post<{ Params: { purpose: string; token: string }; Body: { password?: string; confirm?: string } }>("/shop/account/:purpose/:token", async (req, reply) => {
    personal(reply);
    const { purpose, token } = req.params;
    if (purpose !== "activate" && purpose !== "reset") return html(reply, expired(), 404);
    const link = await accounts.findLink(token, purpose);
    const c = link ? await db.customers.get(link.customerId) : null;
    if (!link || !c) return html(reply, expired(), 410);
    const password = String(req.body?.password ?? ""), confirm = String(req.body?.confirm ?? "");
    const issues = await passwordIssues(db, "customers", password, c.email);
    if (issues.length) return html(reply, setForm(c.email, await customerPolicy(), issues.map((i) => i.message).join(" ")), 400);
    if (password !== confirm) return html(reply, setForm(c.email, await customerPolicy(), "The two passwords are different."), 400);
    const updated = await accounts.setPassword(link, password);
    if (!updated) return html(reply, expired(), 410);
    accounts.signIn(reply, updated);
    return reply.redirect("/shop/account", 303);
  });
}

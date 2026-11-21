import { createHash } from "node:crypto";

/**
 * Identity for per-customer limits: the email, trimmed and lower-cased, with any "+tag" removed from the local part
 * (same mailbox, so the same person for limits). Guests and (future) accounts with the same email share one identity.
 */
export function normalizeEmail(email: string): string {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 1) return e;
  return e.slice(0, at).replace(/\+.*$/, "") + e.slice(at);
}

/**
 * Document id for an identity. KNOWN LIMITATION (deferred to the security review): this is an unkeyed SHA-256, so
 * it keeps emails out of ids and logs but is not a secret (a known email can be hashed and looked up). The plan's
 * keyed variant needs a key persisted in the database, because AUTH_SECRET may be random per restart.
 */
export const identityId = (email: string): string => createHash("sha256").update(normalizeEmail(email)).digest("hex");

// Password rules for staff and customer accounts. Editable by the owner within fixed bounds, so the policy screen can
// never switch protection off. No forced expiry: current guidance (NIST SP 800-63B) advises against it.

export interface PasswordPolicy {
  /** Characters (Unicode code points). */
  minLength: number;
  /** How many of: lower-case, upper-case, digit, symbol. */
  requireClasses: 0 | 1 | 2 | 3 | 4;
  /** The password may not contain the account's email (or the part before the @). */
  disallowEmail: boolean;
  /** Refuse passwords from the common-password list (checked on the server). */
  blockCommon: boolean;
}

export const PASSWORD_MAX = 200;
export const MIN_LENGTH_BOUNDS = { min: 8, max: 64 } as const;
export const DEFAULT_STAFF_POLICY: PasswordPolicy = { minLength: 12, requireClasses: 0, disallowEmail: true, blockCommon: false };
/** Today's customer behaviour: at least 10 characters, nothing else. */
export const DEFAULT_CUSTOMER_POLICY: PasswordPolicy = { minLength: 10, requireClasses: 0, disallowEmail: false, blockCommon: false };

export type PasswordIssueCode = "too_short" | "too_long" | "classes" | "contains_email" | "common";
export interface PasswordIssue { code: PasswordIssueCode; message: string }

const CLASSES: [string, RegExp][] = [["a lower-case letter", /\p{Ll}/u], ["an upper-case letter", /\p{Lu}/u], ["a digit", /\p{Nd}/u], ["a symbol", /[^\p{L}\p{Nd}]/u]];

/** Errors for an out-of-bounds policy (empty when valid). */
export function policyErrors(p: PasswordPolicy): string[] {
  const e: string[] = [];
  if (!Number.isInteger(p.minLength) || p.minLength < MIN_LENGTH_BOUNDS.min || p.minLength > MIN_LENGTH_BOUNDS.max) e.push(`minimum length must be ${MIN_LENGTH_BOUNDS.min} to ${MIN_LENGTH_BOUNDS.max}`);
  if (![0, 1, 2, 3, 4].includes(p.requireClasses)) e.push("character types must be 0 to 4");
  if (typeof p.disallowEmail !== "boolean" || typeof p.blockCommon !== "boolean") e.push("switches must be true or false");
  return e;
}

/** The rules in plain language, for forms and hints. */
export function policyRules(p: PasswordPolicy): string[] {
  const r = [`At least ${p.minLength} characters`];
  if (p.requireClasses) r.push(`At least ${p.requireClasses} of: lower-case letter, upper-case letter, digit, symbol`);
  if (p.disallowEmail) r.push("Must not contain your email address");
  if (p.blockCommon) r.push("Must not be a commonly used password");
  return r;
}

/**
 * Unmet rules (empty = accepted). `isCommon` is only given on the server (the list isn't shipped to browsers), so the
 * backoffice's live hints skip that rule and the server reports it.
 */
export function checkPassword(pw: string, p: PasswordPolicy, opts: { email?: string; isCommon?: (pw: string) => boolean } = {}): PasswordIssue[] {
  const out: PasswordIssue[] = [];
  const len = [...pw].length;
  if (len < p.minLength) out.push({ code: "too_short", message: `Use at least ${p.minLength} characters.` });
  if (len > PASSWORD_MAX) out.push({ code: "too_long", message: `Use at most ${PASSWORD_MAX} characters.` });
  if (p.requireClasses) {
    const have = CLASSES.filter(([, re]) => re.test(pw)).length;
    if (have < p.requireClasses) out.push({ code: "classes", message: `Use at least ${p.requireClasses} of: lower-case letter, upper-case letter, digit, symbol.` });
  }
  if (p.disallowEmail && opts.email) {
    const e = opts.email.trim().toLowerCase(), local = e.split("@")[0], low = pw.toLowerCase();
    if (low.includes(e) || (local.length >= 3 && low.includes(local))) out.push({ code: "contains_email", message: "Don't use your email address in your password." });
  }
  if (p.blockCommon && opts.isCommon?.(pw)) out.push({ code: "common", message: "This password is too common. Choose something less predictable." });
  return out;
}

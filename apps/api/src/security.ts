import { DuplicateKeyError } from "@openshop/db";
import { checkPassword, DEFAULT_CUSTOMER_POLICY, DEFAULT_STAFF_POLICY, type PasswordIssue } from "@openshop/iam";
import { isCommonPassword } from "@openshop/iam/common-passwords";
import type { Db, SecuritySettings } from "./types.ts";

export const RETENTION_CHOICES = [30, 90, 180, 365] as const;

/**
 * The single "security" settings document (password policies, activity retention). Read uncached: it is only needed
 * when a password is set, at sign-in and by the pruner, and a change must apply on every instance at once.
 */
export async function getSecurity(db: Db): Promise<SecuritySettings> {
  const s = await db.security.get("security");
  if (s) return { ...s, passwordPolicy: { staff: { ...DEFAULT_STAFF_POLICY, ...s.passwordPolicy?.staff }, customers: { ...DEFAULT_CUSTOMER_POLICY, ...s.passwordPolicy?.customers } } };
  try {
    return await db.security.insert({
      id: "security", passwordPolicy: { staff: { ...DEFAULT_STAFF_POLICY }, customers: { ...DEFAULT_CUSTOMER_POLICY } },
      enforceStaffPolicyAtSignIn: false, activityRetentionDays: 180, version: 1, updatedAt: null, updatedBy: null,
    });
  } catch (e) { if (!(e instanceof DuplicateKeyError)) throw e; return getSecurity(db); }
}

/** Unmet rules of the current policy for this realm (empty = accepted). Includes the server-only common-password list. */
export async function passwordIssues(db: Db, realm: "staff" | "customers", password: string, email: string): Promise<PasswordIssue[]> {
  const { passwordPolicy } = await getSecurity(db);
  return checkPassword(password, passwordPolicy[realm], { email, isCommon: isCommonPassword });
}

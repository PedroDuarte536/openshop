// Voucher codes: what shoppers type, and what the shop generates.

/** 31 characters: no 0/O, 1/I/L, so codes survive being read aloud or copied by hand. */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_PATTERN = /^[A-Z0-9-]{4,32}$/;
export const PREFIX_PATTERN = /^[A-Z0-9]{1,12}$/;

/** Trims, upper-cases and removes spaces. Returns null for anything that can't be a code. */
export function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 64) return null;
  const c = raw.trim().toUpperCase().replace(/\s+/g, "");
  return CODE_PATTERN.test(c) ? c : null;
}

/**
 * A random code like `PREFIX-AB3DE-FG7HJ`: 10 characters from a 31-letter alphabet (~49.5 bits),
 * from the platform CSPRNG with rejection sampling (no modulo bias).
 */
export function generateCode(prefix = "", length = 10): string {
  const out: string[] = [];
  const bytes = new Uint8Array(length * 2);
  while (out.length < length) {
    globalThis.crypto.getRandomValues(bytes);
    for (const b of bytes) if (b < 248 && out.length < length) out.push(CODE_ALPHABET[b % 31]);
  }
  const body = `${out.slice(0, Math.ceil(length / 2)).join("")}-${out.slice(Math.ceil(length / 2)).join("")}`;
  return prefix ? `${prefix}-${body}` : body;
}

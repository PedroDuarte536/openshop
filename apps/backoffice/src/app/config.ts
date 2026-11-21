// Backoffice timings and sizes in one place. Limits enforced by the server live in apps/api/src/config.ts; the
// values here only shape the screens (and stay within the server's limits).
export const UI = {
  /** Products per page in the product list (the server allows up to 200). */
  productPageSize: 50,
  /** Results shown by a product picker while typing. */
  pickerResults: 20,
  /** Rows loaded per tab in the import preview. */
  importPreviewRows: 200,
  /** Wait after the last keystroke before searching. */
  searchDebounceMs: 250,
  /** A destructive button stays "Click to confirm" this long. */
  confirmMs: 3500,
  /** How often a running import is checked. */
  importPollMs: 1000,
  /** A downloaded file's temporary link is released after this long. */
  downloadUrlMs: 1000,
  /** Stock at or below this shows "N left" (same as the server's "low stock" filter). */
  lowStock: 3,
} as const;

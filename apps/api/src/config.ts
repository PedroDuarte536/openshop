// Every tunable number of the API in one place.
//
// - Values read with `env(...)` can be changed when the server starts, with an environment variable. They are
//   validated (whole numbers within the bounds given here); a wrong value stops the server with a clear message,
//   rather than running with a surprising limit.
// - The other values are product rules and security limits: they change here, in code, with a review.
// Libraries keep their own documented limits: packages/pricing (LIMITS in model.ts) and packages/renderer
// (MAX_NODES and prop bounds in model.ts), because the backoffice uses them too.

const KB = 1024, MB = 1024 * KB;
const SECOND = 1000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

export class ConfigError extends Error {
  constructor(message: string) { super(message); this.name = "ConfigError"; }
}

/** A whole number from the environment, within [min, max]; `fallback` when unset. */
export function envInt(vars: Record<string, string | undefined>, name: string, fallback: number, min: number, max: number): number {
  const raw = vars[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new ConfigError(`${name} must be a whole number (got "${raw}")`);
  const n = Number(raw.trim());
  if (n < min || n > max) throw new ConfigError(`${name} must be between ${min} and ${max} (got ${n})`);
  return n;
}

export function loadConfig(vars: Record<string, string | undefined> = process.env) {
  const env = (name: string, fallback: number, min: number, max: number) => envInt(vars, name, fallback, min, max);
  return {
    http: {
      /** JSON request bodies (everything except uploads and imports). [env HTTP_BODY_LIMIT_KB] */
      bodyLimitBytes: env("HTTP_BODY_LIMIT_KB", 1024, 64, 10 * 1024) * KB,
      /** Storefront HTML forms (cart, checkout, account). */
      formBodyLimitBytes: 64 * KB,
    },
    uploads: {
      /** Largest image upload (also the largest image file an import may copy). [env UPLOAD_MAX_MB] */
      maxImageBytes: env("UPLOAD_MAX_MB", 5, 1, 50) * MB,
      /** Uploads never change (random names), so browsers may keep them for a year. */
      cacheMaxAgeSeconds: 365 * 24 * 3600,
      /** Random bytes in an upload's file name (32 hex characters: unguessable, never reused). */
      nameBytes: 16,
    },
    auth: {
      /** How long a backoffice sign-in lasts. [env ADMIN_SESSION_HOURS] */
      adminSessionSeconds: env("ADMIN_SESSION_HOURS", 8, 1, 24 * 7) * 3600,
      /** Backoffice sign-in throttling: failures per IP within the window. */
      loginMaxFailures: 10, loginWindowMs: MINUTE,
    },
    accounts: {
      /** How long a customer stays signed in. [env CUSTOMER_SESSION_DAYS] */
      sessionSeconds: env("CUSTOMER_SESSION_DAYS", 30, 1, 365) * 24 * 3600,
      /** How long an activation or password-reset link works. [env ACCOUNT_LINK_HOURS] */
      linkTtlMs: env("ACCOUNT_LINK_HOURS", 72, 1, 24 * 30) * HOUR,
      passwordMinLength: 10,
      /** Customer sign-in throttling. */
      loginMaxFailures: 10, loginWindowMs: 10 * MINUTE,
    },
    discounts: {
      /** Wrong discount codes per IP and cart before a pause (codes can't be guessed). */
      codeMaxFailures: 10, codeWindowMs: 10 * MINUTE,
      /** Codes list and redemptions: page sizes, and the most rows a CSV download holds. */
      listPageSize: 100, listMaxPageSize: 500, csvMaxRows: 100_000,
    },
    caches: {
      /** Shop settings, active offers and each visitor's prices are kept this long (other servers catch up within it). */
      settingsMs: 30 * SECOND, offersMs: 30 * SECOND, visitorPricesMs: 30 * SECOND,
      /** Visitor contexts (signed-in customer, cart code…) whose prices are kept at once. */
      visitorPriceContexts: 500,
      /** Throttles forget old keys beyond this many. */
      limiterMaxKeys: 50_000,
    },
    search: {
      /**
       * Suggestions while typing: shortest and longest text, how many products and categories, and their own rate
       * limit per visitor (IP), higher than searches because typing sends several requests.
       */
      suggest: { minQueryLength: 2, maxQueryLength: 100, products: 6, categories: 3, rateBurst: 120, ratePerSecond: 5 },
      /**
       * "Searches with no results": the longest text kept, how many different texts a day, how long they are kept,
       * and how many a visitor can add (a burst, then one every 10 seconds).
       */
      misses: { maxLength: 100, maxTextsPerDay: 2000, retentionDays: 90, perVisitorBurst: 10, perVisitorPerSecond: 0.1, reportRows: 500 },
      /** Shop searches per visitor (IP): a burst, then this many per second. [env SEARCH_RATE_BURST, SEARCH_RATE_PER_SECOND] */
      rateBurst: env("SEARCH_RATE_BURST", 60, 1, 10_000), ratePerSecond: env("SEARCH_RATE_PER_SECOND", 2, 1, 1000),
      /** How often a server checks whether another changed the catalogue, and the longest an index is used. */
      versionCheckMs: SECOND, maxIndexAgeMs: MINUTE,
      /** From this many products, shop searches use the previous index while a new one builds. [env SEARCH_BACKGROUND_REBUILD_FROM] */
      backgroundRebuildFrom: env("SEARCH_BACKGROUND_REBUILD_FROM", 5000, 0, 10_000_000),
      /** Stock at or below this (and above 0) is "low" in the backoffice. */
      lowStock: 3,
      maxQueryWords: 10, shopMaxQueryLength: 100, adminMaxQueryLength: 200,
      /** Prefix search: most dictionary words one typed prefix may expand to. */
      maxPrefixExpansion: 300,
      /** Typo tolerance (plan §2.5.4). */
      fuzzy: { minWordLength: 5, maxCandidates: 5, maxCorrectedWords: 3, maxDictionaryWords: 200_000 },
      shopPageSize: 24, shopMaxPageSize: 48, shopMaxPage: 200,
      adminPageSize: 50, adminMaxPageSize: 200, pickerPageSize: 20, maxLookupIds: 500,
      maxFilterKeys: 20, maxFilterValues: 50, maxCategoryFilters: 50, shopMaxCategoryFilters: 20,
    },
    export: { maxRows: 100_000, chunkSize: 500 },
    import: {
      /** Largest import file. [env IMPORT_MAX_MB] */
      maxBytes: env("IMPORT_MAX_MB", 10, 1, 100) * MB,
      /** Most products in one file. [env IMPORT_MAX_ROWS] */
      maxRows: env("IMPORT_MAX_ROWS", 20_000, 1, 200_000),
      maxColumns: 200, maxCellLength: 10_000, maxLineLength: 100_000,
      /** Rows applied between progress updates (and pauses that keep the server responsive). */
      batchSize: 200,
      /** Import jobs and their rows are kept this long. [env IMPORT_RETENTION_DAYS] */
      retentionMs: env("IMPORT_RETENTION_DAYS", 30, 1, 365) * DAY,
      /** One import at a time: a lock that a crashed import gives up after this long. */
      lockTtlMs: 10 * MINUTE,
      /** Images copied from the server folder: most different files and total size per import. */
      maxMediaFiles: 2000, maxMediaBytes: 500 * MB, maxMediaPathLength: 1024,
      /**
       * https:// images named in a file (C7): the time allowed for one image (all redirects included), the most
       * redirects followed, how many downloads run at once, and how long a preview's checks are remembered.
       */
      remote: { timeoutMs: 10 * SECOND, maxRedirects: 3, concurrency: 4, probeCacheMs: 15 * MINUTE },
      /** Preview warnings: a price change above this share, more new visible products than this. */
      priceJumpWarning: 0.5, manyVisibleWarning: 20,
    },
    catalogue: {
      maxPriceCents: 100_000_000, maxStock: 1_000_000,
      maxNameLength: 200, maxDescriptionLength: 5000, maxImages: 10, maxAttributesPerProduct: 100,
      maxProperties: 200, maxOptionsPerProperty: 500, maxTextValueLength: 200, maxMultiValues: 20,
      bundle: { minComponents: 2, maxComponents: 20, maxQty: 99 },
      variants: { maxDifferentiators: 5, maxMembers: 100 },
    },
    orders: { maxLines: 50, maxQty: 99 },
    insights: { maxDays: 366 },
  };
}

export type Config = ReturnType<typeof loadConfig>;

/** The configuration of this server process (read once, at start-up). */
export const CONFIG: Config = loadConfig();

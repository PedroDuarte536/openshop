import type { Doc } from "@openshop/db";

export interface ImportOptions {
  /** upsert: create and update; update: only existing products; create: only new products. */
  mode: "upsert" | "update" | "create";
  /** Products not in the file: leave them, or hide them. Import never deletes. */
  missing: "leave" | "hide";
  /** An empty cell: leave the field as it is, or clear it (optional fields only). */
  empty: "leave" | "clear";
  stock: "set" | "skip";
  /** New products are visible when this is on (the default, as in the product editor); a `visible` column decides per product. */
  newVisible: boolean;
  createCategories: boolean;
  /** Create properties for unknown `attr:` columns and columns mapped to "new property". */
  createProperties: boolean;
  /** Add unknown values of choice properties as new options. */
  addChoiceValues: boolean;
  stopOnError: boolean;
  /** https:// images: download a copy into the shop (default), or keep them as links to the other site. */
  remoteImages?: "download" | "link";
}

export interface FieldProblem { column: string; message: string }

/** What a row will do, decided by the preview. */
export interface RowPlan {
  action: "create" | "update" | "unchanged" | "error";
  productId?: string;
  /** A new product keeps the id it has in the file (a backup restored into another shop keeps its links). */
  newId?: string;
  /** The product is deleted in the file: created, then moved to Deleted products at the end of the import. */
  createDeleted?: boolean;
  /** The matched product's current name (rows that update it may not have a name column). */
  name?: string;
  baseVersion?: number | null;
  baseStock?: number;
  /** Fields to set (already validated). */
  set?: Record<string, unknown>;
  /** Field -> [before, after], for the diff shown in the preview. */
  diff?: Record<string, [unknown, unknown]>;
  errors?: FieldProblem[];
  warnings?: string[];
  /** The row matches a deleted product: the owner must choose what to do. */
  deletedMatch?: { productId: string; name: string; deletedAt: string; decision: "restore" | "new" | "skip" | null };
  /** Variant group handle and differentiator keys from the row. */
  variant?: { group: string | null; by: string[] | null; position: number | null; changed?: boolean };
  /** Bundle components as given (SKU or id) and resolved later. */
  bundleRefs?: { ref: string; qty: number }[];
  /** Media to copy at commit: source -> resolved absolute path (server paths) or /uploads url. */
  media?: { source: string; kind: "uploads" | "server" | "url" | "remote"; resolved?: string }[];
}

export interface ImportJob extends Doc {
  status: "uploaded" | "previewed" | "committing" | "done" | "failed" | "cancelled" | "interrupted";
  format: "csv" | "json";
  filename: string; sha256: string; bytes: number; rowCount: number;
  /** Column names in file order (CSV headers, or the keys found in JSON products). */
  columns: string[];
  csv?: { delimiter: "," | ";" | "\t"; decimal: "." | ","; encoding: "utf-8" | "windows-1252" };
  /** File column -> target field ("name", "price", "attr:colour", "new:Temperature", "ignore"...). */
  mapping: Record<string, string>;
  /** Type chosen for each new property (from "new:<label>" targets). */
  newProperties: Record<string, { label: string; type: "text" | "choice" | "number" | "boolean" }>;
  preset: string | null;
  options: ImportOptions;
  /** Keys of new properties the owner chose to make public in the shop (the preview's "Public in the shop" boxes). */
  publish?: string[];
  preview?: {
    create: number; update: number; unchanged: number; errors: number; deletedMatches: number; undecided: number; warnings: string[];
    /**
     * Properties the import creates. `public`: the final choice (locked ones tell variants apart and must be public;
     * the others are internal unless the owner ticked them, C25 and Q-2). `publicInFile` and `fileSettings` come from
     * an OpenShop backup.
     */
    newProperties: {
      key: string; label: string; type: "text" | "choice" | "multi" | "number" | "boolean"; public: boolean; locked: boolean; publicInFile: boolean; values?: number;
      options?: string[]; optionDefs?: { value?: string; label: string; swatch?: string }[]; unit?: string;
      fileSettings?: { public: boolean; filterable: boolean; searchable: boolean; showOnProduct: boolean };
    }[];
    newOptions: Record<string, string[]>;
    newCategories: string[];
    /** Products that "hide missing products" would hide (counted at preview time). */
    toHide: number; catalogueSize: number;
    at: string;
  };
  /** From a JSON catalogue file: definitions to create when missing. */
  catalogue?: { categories: { slug: string; name: string }[]; attributes: Record<string, unknown>[]; variantGroups: { id: string; name: string; differentiators: { key: string; order: "products" | "sorted" }[] }[] } | null;
  progress?: { done: number; total: number };
  result?: { created: number; updated: number; unchanged: number; restored: number; hidden: number; conflicts: number; failed: number; skipped: number };
  error?: string | null;
  createdBy: string; createdAt: string; updatedAt: string; committedAt?: string | null; expiresAt: string;
}

export interface ImportRow extends Doc {
  jobId: string; rowNo: number;
  /** The row as read from the file: column -> text (CSV) or the raw JSON product. */
  raw: Record<string, unknown>;
  plan?: RowPlan;
  state: "pending" | "applied" | "conflict" | "failed" | "skipped";
  message?: string | null;
}

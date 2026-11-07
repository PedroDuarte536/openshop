/** Every stored document has a string id. */
export type Doc = { id: string } & Record<string, unknown>;

export type Scalar = string | number | boolean | null;

/** Mongo-style operators, kept to a subset every adapter can implement. */
export type Operators = {
  $eq?: Scalar;
  $ne?: Scalar;
  $gt?: number | string;
  $gte?: number | string;
  $lt?: number | string;
  $lte?: number | string;
  $in?: Scalar[];
};

/** Field -> literal (equality) or operators. Top-level fields only for now; dotted paths allowed. */
export type Filter = Record<string, Scalar | Operators>;

export interface FindOptions {
  sort?: Record<string, 1 | -1>;
  limit?: number;
  skip?: number;
}

export interface Collection<T extends Doc = Doc> {
  insert(doc: Omit<T, "id"> & { id?: string }): Promise<T>;
  get(id: string): Promise<T | null>;
  find(filter?: Filter, opts?: FindOptions): Promise<T[]>;
  count(filter?: Filter): Promise<number>;
  /** Shallow-merges `patch` into the document. Returns the updated doc, or null if missing. */
  update(id: string, patch: Partial<Omit<T, "id">>): Promise<T | null>;
  delete(id: string): Promise<boolean>;
}

/** The only thing the rest of the platform may depend on. */
export interface DataStore {
  collection<T extends Doc = Doc>(name: string): Collection<T>;
  close(): Promise<void>;
}

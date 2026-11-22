import type { Collection, DataStore, Doc } from "@openshop/db";
import type { Node, Theme } from "@openshop/renderer";
import type { Discount } from "@openshop/pricing";
import type { ImportJob, ImportRow } from "./catalogue/import/types.ts";
import type { SearchMiss } from "./catalogue/search-misses.ts";
export type { ImportJob, ImportRow };
import type { PasswordPolicy } from "@openshop/iam";

/** A property value: text, a choice option value, several option values, a number, or yes/no. */
export type AttrValue = string | number | boolean | string[];
/** A bundle sells several products as one. Its stock is derived from the components (never stored). */
export interface BundleSpec {
  components: { productId: string; qty: number }[];
  /** "sum": the price is the components' total, kept up to date; "manual": the owner's price. */
  priceMode: "sum" | "manual";
  /** "targeted": only offers that name this bundle apply; "all": shop-wide and category offers apply too. */
  offerScope: "targeted" | "all";
  /** List this bundle on its components' product pages ("As seen in these bundles"). */
  showOnComponents: boolean;
}
export interface Product extends Doc {
  name: string; price: number; active: boolean; stock: number; categoryId?: string | null; description?: string; images?: string[];
  sku?: string | null;
  /** Set when an import moved this product's SKU to a new product. */
  formerSku?: string | null;
  type?: "simple" | "bundle";
  attributes?: Record<string, AttrValue>;
  bundle?: BundleSpec | null;
  variantGroupId?: string | null; variantPosition?: number;
  /** Soft delete: products are never removed. A deleted product is always hidden (active: false). */
  deletedAt?: string | null; deletedBy?: string | null;
  version?: number; createdAt?: string; updatedAt?: string; updatedBy?: string;
}
export type AttributeType = "text" | "choice" | "multi" | "number" | "boolean";
export interface AttributeOption { value: string; label: string; position: number; swatch?: string | null }
/** A product property ("Colour", "Capacity"). `key` is immutable and used in product.attributes and in URLs. */
export interface AttributeDef extends Doc {
  key: string; label: string; type: AttributeType; unit?: string | null; options?: AttributeOption[];
  visibility: "public" | "internal"; filterable: boolean; searchable: boolean; showOnProduct: boolean; position: number;
  origin?: { importJobId: string } | null;
  version: number; createdAt: string; updatedAt: string;
}
/** Products linked as variants of each other. id = the handle. Values are always read from the member products. */
export interface VariantGroup extends Doc {
  name: string; differentiators: { key: string; order: "products" | "sorted" }[];
  version: number; createdAt: string; updatedAt: string; updatedBy: string;
}
/** id = normalised SKU, so the primary key keeps SKUs unique. */
export interface ProductSku extends Doc { productId: string }
export interface MetaDoc extends Doc { version: number }
/** id = a lock name; `expiresAt` lets a crashed holder's lock be taken over. */
export interface LockDoc extends Doc { holder: string; expiresAt: string }
/** id = SHA-256 of an imported image's bytes, so the same file is stored once. */
export interface MediaHash extends Doc { url: string; createdAt: string }
export interface Category extends Doc { name: string; slug: string }
export interface Page extends Doc { slug: string; title: string; theme: Theme; nodes: Node[]; html: string; system?: "product" | "category" | "search" | null; rendererVersion?: number }

/** `price` is the catalogue (list) unit price. Orders placed before discounts existed only have `price`. */
export interface OrderLine {
  productId: string; name: string; price: number; qty: number; sku?: string;
  /** Bundles: what the bundle contained when it was sold, with each component's share of the line price. */
  bundle?: { components: { productId: string; sku?: string; name: string; qty: number; allocatedCents: number }[] };
  listPrice?: number; lineTotal?: number; discounts?: { discountId: string; label: string; amount: number }[];
}
export interface OrderDiscount { discountId: string; label: string; source: string; code?: string; amount: number }
/** The choice the shopper had between a non-combinable code and the automatic offers, and what they picked. */
export interface OrderChoice {
  discountId: string; code: string; options: { automatic: number; code: number }; best: "automatic" | "code"; selected: "automatic" | "code";
  /** How much more the shopper paid than the best option (0 when they took the best). */
  extra: number;
}
export interface Order extends Doc {
  lines: OrderLine[]; total: number; status: "pending" | "paid" | "shipped" | "cancelled";
  customer: { name: string; email: string; address: string }; createdAt: string;
  subtotal?: number; discountTotal?: number; discounts?: OrderDiscount[]; identityId?: string; customerId?: string | null; pricingVersion?: number;
  choice?: OrderChoice;
  /** Limited offers the shopper kept for later, and how much more they paid because of it. */
  savedForLater?: { discountId: string; label: string; extra: number }[];
}
export interface Customer extends Doc {
  email: string; name: string; address: string;
  /** Set once the customer has activated an account through an owner-generated link. */
  passwordHash?: string; activatedAt?: string | null;
  /** Bumped to sign out every session (password change, "sign out everywhere"). */
  sessionVersion?: number;
  createdAt?: string;
}
/** Owner-generated one-time link to set a password (no email server). Only the hash of the token is stored. */
export interface AccountLink extends Doc { customerId: string; purpose: "activate" | "reset"; tokenHash: string; expiresAt: string; usedAt: string | null; createdAt: string; createdBy: string }
/** A group of customers with its own offers (offers whose audience is this profile). Editing it applies to every member. */
export interface DiscountProfile extends Doc { name: string; publicLabel: string; description: string; status: "active" | "paused"; createdAt: string; updatedAt: string; version: number }
/** id = `${profileId}:${customerId}`. `validUntil` is an exclusive instant (null = no end). */
export interface ProfileMember extends Doc { profileId: string; customerId: string; validUntil: string | null; addedAt: string; addedBy: string }
/**
 * A shopper was shown a choice between a non-combinable code and the automatic offers.
 * id = `${cartId}:${discountId}` (or `order:${orderId}:${discountId}` for API orders). Outcome fields are set when an
 * order is placed. Holds no personal data.
 */
export interface ChoiceEvent extends Doc {
  cartId: string | null; discountId: string; code: string; shownAt: string;
  best: "automatic" | "code"; automaticCents: number; codeCents: number;
  orderId?: string; orderedAt?: string; selected?: "automatic" | "code"; extraCents?: number;
}
export interface CartSelection { scenario: string | null; declined: string[] }
export interface Cart extends Doc { items: { productId: string; qty: number }[]; codes?: string[]; selection?: CartSelection }
/** A backoffice user (staff member). Exactly one user is the owner (`sudo`); no API can change who that is. */
export type StaffStatus = "invited" | "active" | "suspended" | "removed";
export interface User extends Doc {
  email: string; name: string;
  /** null while invited, and after removal. */
  passwordHash: string | null;
  status: StaffStatus;
  sudo: boolean;
  /** In every token as `sv`; incremented to end all of the user's sessions. */
  sessionVersion: number;
  version: number;
  /** Set at sign-in when "enforce the policy at next sign-in" finds a password that doesn't meet it. */
  mustChangePassword?: boolean;
  createdAt: string; createdBy: string | null;
  activatedAt: string | null; lastLoginAt: string | null;
  /** Soft delete: the record and its history are kept. */
  removedAt?: string | null; removedBy?: string | null;
}
/** A permission group. `permissions` is stored closed under `requires`. */
export interface StaffGroup extends Doc { name: string; description: string; permissions: string[]; template: string | null; createdAt: string; updatedAt: string; createdBy: string; version: number }
/** id = `${groupId}:${userId}`, so membership is unique and add/remove are idempotent. */
export interface StaffMembership extends Doc { groupId: string; userId: string; addedAt: string; addedBy: string }
/** Owner-generated one-time link (invite or password reset). Only the token's hash is stored. */
export interface StaffLink extends Doc {
  userId: string; purpose: "invite" | "reset"; tokenHash: string;
  expiresAt: string; usedAt: string | null; createdAt: string; createdBy: string;
  revokedAt: string | null; revokedBy: string | null;
}
/** id = normalised email. Reserves the email for one user (the DataStore only has unique primary keys). Kept after removal. */
export interface StaffEmail extends Doc { userId: string }
export interface SecuritySettings extends Doc {
  passwordPolicy: { staff: PasswordPolicy; customers: PasswordPolicy };
  enforceStaffPolicyAtSignIn: boolean;
  activityRetentionDays: 30 | 90 | 180 | 365;
  version: number; updatedAt: string | null; updatedBy: string | null;
}
export type ActivityKind =
  | "sign_in" | "sign_in_failed" | "sign_out" | "session_ended"
  | "link_created" | "link_opened" | "link_used" | "link_revoked" | "link_invalid"
  | "page_view" | "page_denied" | "api_denied" | "api_unauthenticated" | "change" | "dropped";
/** id = `${ISO time}~${random}`: the primary key is the time index. Built from explicit fields only (never whole documents). */
export interface ActivityEvent extends Doc {
  at: string; kind: ActivityKind; userId: string | null;
  ip?: string | null; userAgent?: string | null;
  /** Backoffice path (page views) or API route pattern (401/403). */
  path?: string | null; method?: string | null; feature?: string | null;
  permission?: string | null; reason?: string | null;
  targetUserId?: string | null; purpose?: string | null;
  action?: string | null; entity?: string | null; entityId?: string | null; auditId?: string | null;
  /** Aggregated events: how many times in this minute. */
  count?: number;
}

export interface DisplaySettings { showOriginalPrice: boolean; showBadge: boolean; showAlternatives: boolean }
export interface ShopSettings extends Doc {
  timezone: string;
  /** False until an owner has confirmed the time zone (the backoffice shows a banner until then). */
  timezoneConfirmed: boolean;
  display: DisplaySettings;
  migrations?: Record<string, string>;
  updatedAt?: string; updatedBy?: string;
}
export type DiscountDoc = Discount & Doc;
/** id = the normalised code, so the primary key keeps codes unique across all offers. */
export interface VoucherCode extends Doc { discountId: string; kind: "shared" | "single"; usedCount: number; assignedCustomerId: string | null; createdAt: string }
/** id = hash of the normalised email. Counts non-cancelled orders (for "first N orders"). */
export interface Identity extends Doc { orders: number }
/** id = `${discountId}:${identityId}`. Per-customer usage of one offer. */
export interface DiscountUsage extends Doc { discountId: string; identityId: string; orders: number; amountCents: number }
/** id = `${discountId}:${orderId}`. */
export interface Redemption extends Doc {
  discountId: string; code: string | null; orderId: string; identityId: string; customerId: string | null;
  amountCents: number; state: "used" | "released"; at: string; releasedAt?: string;
}
export interface AuditEntry extends Doc { at: string; userId: string; action: string; entity: string; entityId: string; before?: unknown; after?: unknown }

export interface Db {
  products: Collection<Product>; categories: Collection<Category>; pages: Collection<Page>;
  orders: Collection<Order>; customers: Collection<Customer>; carts: Collection<Cart>; users: Collection<User>;
  settings: Collection<ShopSettings>; discounts: Collection<DiscountDoc>; voucherCodes: Collection<VoucherCode>;
  identities: Collection<Identity>; discountUsage: Collection<DiscountUsage>; redemptions: Collection<Redemption>; audit: Collection<AuditEntry>;
  accountLinks: Collection<AccountLink>; profiles: Collection<DiscountProfile>; profileMembers: Collection<ProfileMember>; choiceEvents: Collection<ChoiceEvent>;
  attributes: Collection<AttributeDef>; variantGroups: Collection<VariantGroup>; productSkus: Collection<ProductSku>; meta: Collection<MetaDoc>;
  locks: Collection<LockDoc>; importJobs: Collection<ImportJob>; importRows: Collection<ImportRow>; mediaHashes: Collection<MediaHash>;
  searchMisses: Collection<SearchMiss>;
  staffGroups: Collection<StaffGroup>; staffMemberships: Collection<StaffMembership>; staffLinks: Collection<StaffLink>; staffEmails: Collection<StaffEmail>;
  security: Collection<SecuritySettings>; activity: Collection<ActivityEvent>;
}
export const openDb = (s: DataStore): Db => ({
  products: s.collection("products"), categories: s.collection("categories"), pages: s.collection("pages"),
  orders: s.collection("orders"), customers: s.collection("customers"), carts: s.collection("carts"), users: s.collection("users"),
  settings: s.collection("settings"), discounts: s.collection("discounts"), voucherCodes: s.collection("voucher_codes"),
  identities: s.collection("identities"), discountUsage: s.collection("discount_usage"), redemptions: s.collection("redemptions"), audit: s.collection("audit_log"),
  accountLinks: s.collection("account_links"), profiles: s.collection("discount_profiles"), profileMembers: s.collection("profile_members"), choiceEvents: s.collection("choice_events"),
  attributes: s.collection("attributes"), variantGroups: s.collection("variant_groups"), productSkus: s.collection("product_skus"), meta: s.collection("meta"),
  locks: s.collection("locks"), importJobs: s.collection("import_jobs"), importRows: s.collection("import_rows"), mediaHashes: s.collection("media_hashes"),
  searchMisses: s.collection("search_misses"),
  staffGroups: s.collection("staff_groups"), staffMemberships: s.collection("staff_memberships"), staffLinks: s.collection("staff_links"), staffEmails: s.collection("staff_emails"),
  security: s.collection("security_settings"), activity: s.collection("activity"),
});

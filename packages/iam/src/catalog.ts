// The fixed list of backoffice permissions. Ids are stable: never rename one (groups store them). A permission added
// in a later release is off in every existing group; the owner (sudo) has every permission automatically.

export const AREAS = ["catalog", "orders", "customers", "discounts", "pages", "insights", "settings"] as const;
export type Area = (typeof AREAS)[number];
export const AREA_LABELS: Record<Area, string> = {
  catalog: "Catalogue", orders: "Orders", customers: "Customers", discounts: "Discounts", pages: "Pages", insights: "Insights", settings: "Settings",
};

export interface PermissionDef {
  id: string; area: Area; label: string; description: string;
  /** Permissions this one needs; added automatically (closure). */
  requires: string[];
  /** "view" permissions only read; the others change something. */
  kind: "view" | "change";
  /** Shown as a warning in the group editor. */
  sensitive?: string;
}

export const PERMISSIONS = [
  { id: "catalog.view", area: "catalog", kind: "view", label: "See products and categories", description: "Product list and details, categories.", requires: [] },
  { id: "catalog.stock", area: "catalog", kind: "change", label: "Update stock levels", description: "Change the stock of a product, and nothing else about it.", requires: ["catalog.view"] },
  { id: "catalog.manage", area: "catalog", kind: "change", label: "Add, edit and delete products and categories", description: "Prices, texts, photos, active flag, categories, image uploads. Changes re-render shop pages.", requires: ["catalog.view", "catalog.stock"] },
  { id: "orders.view", area: "orders", kind: "view", label: "See orders", description: "Every order with its lines and totals.", requires: [], sensitive: "Shows customer names, emails and addresses." },
  { id: "orders.fulfil", area: "orders", kind: "change", label: "Mark orders as shipped", description: "Set an order's status to Shipped.", requires: ["orders.view"] },
  { id: "orders.payments", area: "orders", kind: "change", label: "Mark orders as paid or back to pending", description: "Set an order's status to Paid or Pending.", requires: ["orders.view"] },
  { id: "orders.cancel", area: "orders", kind: "change", label: "Cancel and reopen orders", description: "Cancel an order (gives back the discounts it used) or reopen a cancelled one.", requires: ["orders.view"] },
  { id: "customers.view", area: "customers", kind: "view", label: "See customers and their details", description: "Customer list and details: orders, profiles, personal codes, use of offers.", requires: [], sensitive: "Personal data (names, emails, addresses)." },
  { id: "customers.manage", area: "customers", kind: "change", label: "Create and edit customers", description: "Add customers and change their name and address.", requires: ["customers.view"] },
  { id: "customers.delete", area: "customers", kind: "change", label: "Delete customers", description: "Erase a customer's personal data. Cannot be undone; unassigns their codes and may archive offers made only for them.", requires: ["customers.view"] },
  { id: "customers.accounts", area: "customers", kind: "change", label: "Customer account links and sign-out", description: "Create activation and password reset links for customer accounts; sign customers out everywhere.", requires: ["customers.view"], sensitive: "A reset link lets whoever holds it take over that customer's account." },
  { id: "discounts.view", area: "discounts", kind: "view", label: "See offers and profiles; use the simulator", description: "Offers, discount profiles, offer history and the price simulator.", requires: ["catalog.view"] },
  { id: "discounts.manage", area: "discounts", kind: "change", label: "Create and change offers and profiles", description: "Create, edit, pause, resume, archive, duplicate and delete offers; create, edit and delete profiles.", requires: ["discounts.view"] },
  { id: "discounts.codes", area: "discounts", kind: "change", label: "See, generate, export and delete voucher codes", description: "Voucher code lists and CSV export, generating and deleting codes.", requires: ["discounts.view"], sensitive: "Voucher codes are worth money." },
  { id: "pages.manage", area: "pages", kind: "change", label: "Design and publish pages", description: "The page builder: create, edit, publish, rename and delete pages.", requires: ["catalog.view"], sensitive: "Saving publishes to the live shop. Give it to people you trust." },
  { id: "insights.view", area: "insights", kind: "view", label: "See reports", description: "Revenue, discount cost and shopper choices, with CSV downloads.", requires: [], sensitive: "Business-confidential figures." },
  { id: "settings.manage", area: "settings", kind: "change", label: "Change shop time zone and display", description: "Shop time zone (moves every offer's times) and how discounts are shown.", requires: [] },
] as const satisfies readonly PermissionDef[];

export type PermissionId = (typeof PERMISSIONS)[number]["id"];
export const PERMISSION_IDS: PermissionId[] = PERMISSIONS.map((p) => p.id);
const BY_ID = new Map<string, PermissionDef>(PERMISSIONS.map((p) => [p.id, p]));
export const permission = (id: string): PermissionDef | undefined => BY_ID.get(id);
export const isPermissionId = (id: string): id is PermissionId => BY_ID.has(id);

/** Functions only the owner (sudo) can use. Not grantable. */
export const SUDO_FUNCTIONS = ["Team and invitations", "Permission groups", "Activity log", "Security settings (password policies, activity retention)"];

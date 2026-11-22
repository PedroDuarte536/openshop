import type { Requirement } from "./resolve.ts";

// The backoffice feature registry: one list drives the menu, the route guards and the landing page, so they can't
// disagree. Paths are Angular route paths (no leading slash).

export interface FeatureRoute { path: string; perm: Requirement }
export interface Feature {
  id: string; label: string;
  /** Where the menu entry points. */
  path: string;
  menu: "main" | "foot" | null;
  /** Needed for the menu entry and the feature's entry screen. */
  perm: Requirement;
  /** Sub-pages; each can need more than the entry screen. */
  routes: FeatureRoute[];
}

export const FEATURES: Feature[] = [
  { id: "products", label: "Products", path: "products", menu: "main", perm: "catalog.view", routes: [
    { path: "products", perm: "catalog.view" }, { path: "products/properties", perm: "catalog.view" },
    { path: "products/import", perm: "catalog.manage" }, { path: "products/:id/delete", perm: "catalog.manage" },
  ] },
  { id: "categories", label: "Categories", path: "categories", menu: "main", perm: "catalog.view", routes: [{ path: "categories", perm: "catalog.view" }] },
  { id: "orders", label: "Orders", path: "orders", menu: "main", perm: "orders.view", routes: [{ path: "orders", perm: "orders.view" }] },
  {
    id: "discounts", label: "Discounts", path: "discounts", menu: "main", perm: "discounts.view", routes: [
      { path: "discounts", perm: "discounts.view" }, { path: "discounts/new", perm: "discounts.manage" }, { path: "discounts/simulate", perm: "discounts.view" },
      { path: "discounts/profiles", perm: "discounts.view" }, { path: "discounts/profiles/:id", perm: "discounts.view" }, { path: "discounts/:id", perm: "discounts.view" },
    ],
  },
  { id: "customers", label: "Customers", path: "customers", menu: "main", perm: "customers.view", routes: [{ path: "customers", perm: "customers.view" }, { path: "customers/:id", perm: "customers.view" }] },
  { id: "insights", label: "Insights", path: "insights", menu: "main", perm: "insights.view", routes: [{ path: "insights", perm: "insights.view" }] },
  { id: "pages", label: "Pages", path: "pages", menu: "main", perm: "pages.manage", routes: [{ path: "pages", perm: "pages.manage" }, { path: "pages/:id", perm: "pages.manage" }] },
  { id: "activity", label: "Activity", path: "activity", menu: "main", perm: "sudo", routes: [{ path: "activity", perm: "sudo" }] },
  { id: "settings", label: "Settings", path: "settings", menu: "foot", perm: "settings.manage", routes: [{ path: "settings", perm: "settings.manage" }] },
  {
    id: "team", label: "Team", path: "team", menu: "foot", perm: "sudo", routes: [
      { path: "team", perm: "sudo" }, { path: "team/groups", perm: "sudo" }, { path: "team/groups/:id", perm: "sudo" }, { path: "team/:id", perm: "sudo" },
    ],
  },
  { id: "account", label: "My account", path: "account", menu: "foot", perm: "authenticated", routes: [{ path: "account", perm: "authenticated" }] },
];

export const feature = (id: string) => FEATURES.find((f) => f.id === id);

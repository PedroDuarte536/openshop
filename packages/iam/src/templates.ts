import { PERMISSION_IDS, type PermissionId } from "./catalog.ts";
import { normalizePermissions } from "./resolve.ts";

export interface GroupTemplate { id: string; name: string; person: string; description: string; permissions: PermissionId[]; cannot: string }

// Starting points for "New group". Choosing one creates a normal, editable group; nothing is created automatically.
export const TEMPLATES: GroupTemplate[] = ([
  { id: "shop-manager", name: "Shop manager", person: "Trusted right hand, business partner", description: "Runs the shop day to day.", permissions: [...PERMISSION_IDS], cannot: "Team, groups, activity log and security settings (owner only)." },
  { id: "fulfilment", name: "Fulfilment", person: "Packer, warehouse", description: "Ships orders and keeps stock right.", permissions: ["catalog.view", "catalog.stock", "orders.view", "orders.fulfil"], cannot: "Change prices or products, mark orders paid, cancel orders, see customers or reports." },
  { id: "catalogue-editor", name: "Catalogue editor", person: "Merchandiser", description: "Maintains products, prices, photos and categories.", permissions: ["catalog.view", "catalog.stock", "catalog.manage"], cannot: "See orders, customers, offers or reports; edit pages." },
  { id: "content-editor", name: "Content editor", person: "Web designer, often a freelancer", description: "Designs and publishes pages.", permissions: ["pages.manage", "catalog.view"], cannot: "Change products, see orders or customers, offers or reports." },
  { id: "promotions", name: "Promotions", person: "Marketing", description: "Runs offers and voucher codes, reads reports.", permissions: ["catalog.view", "discounts.view", "discounts.manage", "discounts.codes", "insights.view"], cannot: "See customers (so no client prices or personal codes), see orders or redemptions, change products." },
  { id: "customer-support", name: "Customer support", person: "Support agent", description: "Looks after customers and their accounts; cancels orders on request.", permissions: ["customers.view", "customers.manage", "customers.accounts", "orders.view", "orders.cancel"], cannot: "Delete customers, mark orders paid or shipped, offers, reports." },
  { id: "finance", name: "Finance", person: "Accountant, bookkeeper", description: "Marks orders paid; reads orders, offers and reports.", permissions: ["orders.view", "orders.payments", "insights.view", "discounts.view", "catalog.view"], cannot: "Ship or cancel orders, change anything else, see customer details." },
  { id: "read-only", name: "Read-only", person: "Advisor, investor, auditor", description: "Sees everything except pages and settings, changes nothing.", permissions: ["catalog.view", "orders.view", "customers.view", "discounts.view", "insights.view"], cannot: "Change anything. Includes customer personal data." },
] satisfies GroupTemplate[]).map((t) => ({ ...t, permissions: normalizePermissions(t.permissions) }));

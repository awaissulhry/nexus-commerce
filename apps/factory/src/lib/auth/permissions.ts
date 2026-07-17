/**
 * F1 — the Factory OS permission registry. EVERY permission the system knows
 * about is defined here and nowhere else; adding a permission anywhere else
 * is a bug. Three layers (S-series pattern, docs/factory/F0-ARCHITECTURE.md):
 *   pages.*        — nav render + navigation
 *   <module>.<action> — server-enforced actions
 *   financials.*   — field-level visibility grains (response stripping)
 * OWNER is implicit-all (empty list; resolver short-circuits).
 */

export const PAGES = {
  inbox: "pages.inbox",
  quotes: "pages.quotes",
  orders: "pages.orders",
  production: "pages.production",
  materials: "pages.materials",
  products: "pages.products",
  contacts: "pages.contacts",
  shipping: "pages.shipping",
  financials: "pages.financials",
  analytics: "pages.analytics",
  settings: "pages.settings",
  chat: "pages.chat", // FC1: Owner-approved 12th page (FS-FC proposal); nav entry lands in FC2
} as const;

export const FEATURES = {
  inboxSend: "inbox.send",
  inboxAssign: "inbox.assign",
  inboxViewsManage: "inbox.views.manage", // EPI3: create/edit/reorder views + rules. Consumption rides pages.inbox.
  quotesCreate: "quotes.create",
  quotesSend: "quotes.send",
  quotesConvert: "quotes.convert",
  ordersEdit: "orders.edit",
  ordersCancel: "orders.cancel",
  workordersAdvance: "workorders.advance",
  workordersAssign: "workorders.assign",
  materialsAdjust: "materials.adjust",
  materialsReceive: "materials.receive",
  materialsConsume: "materials.consume",
  productsManage: "products.manage",
  materialsManage: "materials.manage", // FP2: catalog CRUD — distinct from materials.adjust (stock, FP7). WORKER gets neither.
  contactsManage: "contacts.manage",
  pricelistsManage: "pricelists.manage",
  labelsPurchase: "labels.purchase",
  labelsVoid: "labels.void",
  invoicesManage: "invoices.manage", // FP9: create/send/mark-paid invoices. OWNER only; the whole page is worker-invisible (FD13).
  paymentsRecord: "payments.record",
  importsRun: "imports.run",
  exportsRun: "exports.run",
  commentsCreate: "comments.create",
  searchRun: "search.run",
  settingsManage: "settings.manage", // FP11: stage pipeline / pricing defaults / VAT (config writes). OWNER.
  integrationsManage: "settings.integrations.manage",
  usersManage: "users.manage",
  rolesManage: "roles.manage",
  auditView: "audit.view",
  chatPost: "chat.post", // FC1: post/edit/delete own messages + react in member spaces
  chatSpacesCreate: "chat.spaces.create", // FC1: create CUSTOM spaces (Owner-only default, substrate Q4)
  chatSpacesManage: "chat.spaces.manage", // FC1: add/remove members (space MANAGERs pass the service guardrail)
} as const;

export const FIELDS = {
  financialsView: "financials.view", // master — expands to all grains
  costsView: "financials.costs.view",
  marginsView: "financials.margins.view",
  pricesView: "financials.prices.view",
  suppliersView: "financials.suppliers.view",
} as const;

export const FINANCIAL_SUBGRAINS = [
  FIELDS.costsView,
  FIELDS.marginsView,
  FIELDS.pricesView,
  FIELDS.suppliersView,
] as const;

export const ALL_PERMISSIONS: string[] = [
  ...Object.values(PAGES),
  ...Object.values(FEATURES),
  ...Object.values(FIELDS),
];

const ALL_SET = new Set(ALL_PERMISSIONS);
export const isValidPermission = (p: string): boolean => ALL_SET.has(p);

/** Master financial grant implies every sub-grain. */
export function expandPermissions(stored: string[]): Set<string> {
  const out = new Set(stored);
  if (out.has(FIELDS.financialsView)) for (const g of FINANCIAL_SUBGRAINS) out.add(g);
  return out;
}

export type SystemRoleKey = "OWNER" | "WORKER";

export type SystemRoleDef = {
  key: SystemRoleKey;
  name: string;
  description: string;
  permissions: string[]; // OWNER: empty = implicit-all
};

export const OWNER_ROLE_KEY: SystemRoleKey = "OWNER";

export const SYSTEM_ROLES: Record<SystemRoleKey, SystemRoleDef> = {
  OWNER: {
    key: "OWNER",
    name: "Owner",
    description: "Implicit access to everything. Cannot be demoted below one remaining owner.",
    permissions: [],
  },
  WORKER: {
    key: "WORKER",
    name: "Worker",
    description:
      "Shop floor: production tasks and material consumption. Zero financial visibility — nav lacks Quotes/Products/Financials by construction (FD9).",
    permissions: [
      PAGES.production,
      PAGES.materials,
      PAGES.chat, // FC1 — explicit per spec (substrate Q4): Workers chat in their order spaces
      FEATURES.workordersAdvance,
      FEATURES.materialsConsume,
      FEATURES.commentsCreate,
      FEATURES.searchRun,
      FEATURES.chatPost, // FC1 — write in own order-spaces: yes; create/manage spaces: no
    ],
  },
};

export type PermissionCatalogGroup = {
  module: string;
  label: string;
  layer: "page" | "feature" | "field";
  items: { key: string; label: string }[];
};

const humanize = (key: string): string =>
  key
    .split(".")
    .slice(1)
    .join(" — ")
    .replace(/([a-z])([A-Z])/g, "$1 $2");

/** Grouped registry for the (FP11) role-matrix UI. */
export function permissionCatalog(): PermissionCatalogGroup[] {
  return [
    {
      module: "pages",
      label: "Pages",
      layer: "page",
      items: Object.values(PAGES).map((key) => ({ key, label: humanize(key) })),
    },
    {
      module: "features",
      label: "Actions",
      layer: "feature",
      items: Object.values(FEATURES).map((key) => ({ key, label: key })),
    },
    {
      module: "financials",
      label: "Financial visibility",
      layer: "field",
      items: Object.values(FIELDS).map((key) => ({ key, label: humanize(key) })),
    },
  ];
}

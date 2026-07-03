/**
 * Nexus Commerce — permission registry (single source of truth).
 *
 * Security workstream Phase S2. EVERY permission the system knows about
 * is defined here and nowhere else — API middleware, the route→permission
 * manifest, role seeds, the web `<Can>`/usePermission guards, and the
 * admin matrix UI all import from this file. Adding a permission anywhere
 * else is a bug.
 *
 * Three layers (docs/security/S0-PERMISSION-REGISTRY.md):
 *   1. pages.*            — can the user see a page / does its nav link render
 *   2. <module>.<action>  — can the user perform an action (server-enforced)
 *   3. financials.*       — field-level: strip restricted money fields
 *
 * Deny by default: a permission absent from a role's set is denied. OWNER
 * is implicit-all — the resolver short-circuits before ever reading its set.
 */

// ── Layer 1: page access ───────────────────────────────────────────
export const PAGES = {
  dashboard: 'pages.dashboard',
  products: 'pages.products',
  listings: 'pages.listings',
  orders: 'pages.orders',
  fulfillment: 'pages.fulfillment',
  repricing: 'pages.repricing',
  pricing: 'pages.pricing',
  insights: 'pages.insights',
  analytics: 'pages.analytics',
  marketing: 'pages.marketing',
  advertising: 'pages.advertising',
  reviews: 'pages.reviews',
  customers: 'pages.customers',
  financials: 'pages.financials',
  bulkOperations: 'pages.bulkOperations',
  syncLogs: 'pages.syncLogs',
  performance: 'pages.performance',
  settings: 'pages.settings',
  settingsIntegrations: 'pages.settings.integrations',
  settingsDeveloper: 'pages.settings.developer',
  settingsCompliance: 'pages.settings.compliance',
  teamAccess: 'pages.teamAccess',
  admin: 'pages.admin',
  internal: 'pages.internal',
} as const

// ── Layer 2: feature actions ───────────────────────────────────────
export const FEATURES = {
  // Products / catalog
  productsView: 'products.view',
  productsCreate: 'products.create',
  productsEdit: 'products.edit',
  productsDelete: 'products.delete',
  productsPriceEdit: 'products.price.edit',
  productsPublish: 'products.publish',
  productsImport: 'products.import',
  productsExport: 'products.export',
  productsImagesEdit: 'products.images.edit',
  productsTranslationsEdit: 'products.translations.edit',
  pimManage: 'pim.manage',
  productsBulkRun: 'products.bulk.run',
  // Listings / channels
  listingsView: 'listings.view',
  listingsEdit: 'listings.edit',
  listingsPublish: 'listings.publish',
  listingsRecover: 'listings.recover',
  listingsFlatfileEdit: 'listings.flatfile.edit',
  channelsConnect: 'channels.connect',
  channelsDisconnect: 'channels.disconnect',
  channelsSync: 'channels.sync',
  // Orders
  ordersView: 'orders.view',
  ordersEdit: 'orders.edit',
  ordersFulfill: 'orders.fulfill',
  ordersRefund: 'orders.refund',
  ordersCancel: 'orders.cancel',
  ordersExport: 'orders.export',
  ordersRoutingManage: 'orders.routing.manage',
  reviewsView: 'reviews.view',
  reviewsManage: 'reviews.manage',
  // Fulfillment / inventory
  inventoryView: 'inventory.view',
  inventoryAdjust: 'inventory.adjust',
  stockTransfer: 'stock.transfer',
  stockCount: 'stock.count',
  lotsManage: 'lots.manage',
  inboundManage: 'inbound.manage',
  outboundManage: 'outbound.manage',
  returnsView: 'returns.view',
  returnsProcess: 'returns.process',
  suppliersView: 'suppliers.view',
  suppliersManage: 'suppliers.manage',
  poView: 'po.view',
  poCreate: 'po.create',
  poApprove: 'po.approve',
  poReceive: 'po.receive',
  replenishmentView: 'replenishment.view',
  replenishmentRun: 'replenishment.run',
  carriersManage: 'carriers.manage',
  fnskuGenerate: 'fnsku.generate',
  fulfillmentExport: 'fulfillment.export',
  // Pricing / repricing
  pricingView: 'pricing.view',
  pricingEdit: 'pricing.edit',
  pricingRulesManage: 'pricing.rules.manage',
  repricingView: 'repricing.view',
  repricingRulesManage: 'repricing.rules.manage',
  pricingTiersManage: 'pricing.tiers.manage',
  pricingCostsEdit: 'pricing.costs.edit',
  // Advertising
  adsView: 'ads.view',
  adsCampaignsManage: 'ads.campaigns.manage',
  adsBudgetsEdit: 'ads.budgets.edit',
  adsBidsEdit: 'ads.bids.edit',
  adsAutomationManage: 'ads.automation.manage',
  adsConnect: 'ads.connect',
  adsExport: 'ads.export',
  // Marketing / content
  marketingView: 'marketing.view',
  marketingContentEdit: 'marketing.content.edit',
  marketingCampaignsManage: 'marketing.campaigns.manage',
  marketingAutomationManage: 'marketing.automation.manage',
  marketingPublish: 'marketing.publish',
  assetsManage: 'assets.manage',
  aplusManage: 'aplus.manage',
  brandManage: 'brand.manage',
  // Analytics / insights
  analyticsView: 'analytics.view',
  insightsView: 'insights.view',
  forecastView: 'forecast.view',
  reportsRun: 'reports.run',
  reportsExport: 'reports.export',
  // Customers
  customersView: 'customers.view',
  customersEdit: 'customers.edit',
  customersSegmentsManage: 'customers.segments.manage',
  customersExport: 'customers.export',
  // Settings / connections
  settingsView: 'settings.view',
  settingsWorkspaceEdit: 'settings.workspace.edit',
  settingsNotificationsEdit: 'settings.notifications.edit',
  settingsIntegrationsManage: 'settings.integrations.manage',
  settingsApikeysManage: 'settings.apikeys.manage',
  settingsWebhooksManage: 'settings.webhooks.manage',
  settingsPrivacyManage: 'settings.privacy.manage',
  settingsSecurityManage: 'settings.security.manage',
  // Admin / ops
  adminView: 'admin.view',
  adminRepair: 'admin.repair',
  adminPurge: 'admin.purge',
  adminRestore: 'admin.restore',
  syncManage: 'sync.manage',
  jobsManage: 'jobs.manage',
  bulkRollback: 'bulk.rollback',
  // AI / agents
  aiView: 'ai.view',
  aiRun: 'ai.run',
  aiUsageView: 'ai.usage.view',
  // Users / roles / audit (team access — S4 console)
  usersManage: 'users.manage',
  rolesManage: 'roles.manage',
  invitationsManage: 'invitations.manage',
  auditView: 'audit.view',
  sessionsManage: 'sessions.manage',
} as const

// ── Layer 3: field visibility (financials) ─────────────────────────
export const FIELDS = {
  financialsView: 'financials.view', // master switch — all restricted money
  financialsCostsView: 'financials.costs.view',
  financialsMarginsView: 'financials.margins.view',
  financialsFeesView: 'financials.fees.view',
  financialsPayoutsView: 'financials.payouts.view',
  financialsAdspendView: 'financials.adspend.view',
  financialsRevenueView: 'financials.revenue.view',
  financialsSuppliersView: 'financials.suppliers.view',
} as const

/** Every finer financial grain implied by the master `financials.view`. */
export const FINANCIAL_SUBGRAINS: string[] = [
  FIELDS.financialsCostsView,
  FIELDS.financialsMarginsView,
  FIELDS.financialsFeesView,
  FIELDS.financialsPayoutsView,
  FIELDS.financialsAdspendView,
  FIELDS.financialsRevenueView,
  FIELDS.financialsSuppliersView,
]

// ── The flat set of every valid permission ─────────────────────────
export const ALL_PERMISSIONS: string[] = [
  ...Object.values(PAGES),
  ...Object.values(FEATURES),
  ...Object.values(FIELDS),
]

const ALL_PERMISSIONS_SET = new Set(ALL_PERMISSIONS)
export function isValidPermission(p: string): boolean {
  return ALL_PERMISSIONS_SET.has(p)
}

// ── System roles ───────────────────────────────────────────────────
export type SystemRoleKey =
  | 'OWNER'
  | 'ADMIN'
  | 'OPS_MANAGER'
  | 'FULFILLMENT'
  | 'FINANCE'
  | 'VIEWER'

export interface SystemRoleDef {
  key: SystemRoleKey
  name: string
  description: string
  /** Empty for OWNER (implicit-all). */
  permissions: string[]
  requireMfa: boolean
}

const P = PAGES
const F = FEATURES

// OPS_MANAGER — full operational control; no financial fields (except ad
// spend so campaigns are usable), no settings, no user management.
const OPS_MANAGER_PERMS: string[] = [
  P.dashboard, P.products, P.listings, P.orders, P.fulfillment, P.repricing,
  P.pricing, P.insights, P.analytics, P.marketing, P.advertising, P.reviews,
  P.customers, P.bulkOperations, P.syncLogs, P.performance,
  F.productsView, F.productsCreate, F.productsEdit, F.productsDelete,
  F.productsPriceEdit, F.productsPublish, F.productsImport, F.productsExport,
  F.productsImagesEdit, F.productsTranslationsEdit, F.pimManage, F.productsBulkRun,
  F.listingsView, F.listingsEdit, F.listingsPublish, F.listingsRecover,
  F.listingsFlatfileEdit, F.channelsSync,
  F.ordersView, F.ordersEdit, F.ordersFulfill, F.ordersRefund, F.ordersCancel,
  F.ordersExport, F.ordersRoutingManage, F.reviewsView, F.reviewsManage,
  F.inventoryView, F.inventoryAdjust, F.stockTransfer, F.stockCount, F.lotsManage,
  F.inboundManage, F.outboundManage, F.returnsView, F.returnsProcess,
  F.suppliersView, F.suppliersManage, F.poView, F.poCreate, F.poApprove,
  F.poReceive, F.replenishmentView, F.replenishmentRun, F.carriersManage,
  F.fnskuGenerate, F.fulfillmentExport,
  F.pricingView, F.pricingEdit, F.pricingRulesManage, F.repricingView,
  F.repricingRulesManage,
  // NOTE: pricing.tiers.manage is intentionally excluded — B2B tier prices
  // are restricted financial data and OPS_MANAGER holds no financials.
  F.adsView, F.adsCampaignsManage, F.adsBudgetsEdit, F.adsBidsEdit, F.adsExport,
  F.marketingView, F.marketingContentEdit, F.marketingCampaignsManage,
  F.marketingAutomationManage, F.marketingPublish, F.assetsManage, F.aplusManage,
  F.brandManage,
  F.analyticsView, F.insightsView, F.forecastView, F.reportsRun, F.reportsExport,
  F.customersView, F.customersEdit, F.customersSegmentsManage, F.customersExport,
  F.syncManage, F.jobsManage, F.aiView, F.aiRun,
  // Ad spend only (so ad screens work); NOT the financials master switch.
  FIELDS.financialsAdspendView,
]

// FULFILLMENT — view + fulfil orders only; no prices/financials beyond
// what fulfilment strictly requires.
const FULFILLMENT_PERMS: string[] = [
  P.dashboard, P.orders, P.fulfillment, P.products, P.listings, P.syncLogs, P.performance,
  F.productsView, F.listingsView,
  F.ordersView, F.ordersFulfill, F.ordersExport,
  F.inventoryView, F.inventoryAdjust, F.stockTransfer, F.stockCount, F.lotsManage,
  F.inboundManage, F.outboundManage, F.returnsView, F.returnsProcess,
  F.poView, F.poCreate, F.poReceive, F.replenishmentView, F.carriersManage,
  F.fnskuGenerate, F.fulfillmentExport, F.suppliersView,
]

// FINANCE — financial pages + fields + reports; read-only on operational data.
const FINANCE_PERMS: string[] = [
  P.dashboard, P.financials, P.insights, P.analytics, P.pricing, P.orders,
  P.fulfillment, P.marketing, P.advertising, P.customers, P.syncLogs,
  P.performance, P.settingsCompliance,
  F.productsView, F.listingsView, F.ordersView, F.inventoryView, F.returnsView,
  F.suppliersView, F.poView, F.pricingView, F.repricingView, F.adsView,
  F.marketingView, F.customersView, F.analyticsView, F.insightsView,
  F.forecastView, F.reportsRun, F.reportsExport, F.auditView, F.aiUsageView,
  // All money.
  FIELDS.financialsView,
]

// VIEWER — read-only operational access; no financial fields.
const VIEWER_PERMS: string[] = [
  P.dashboard, P.products, P.listings, P.orders, P.fulfillment, P.marketing,
  P.reviews, P.customers, P.insights, P.analytics, P.syncLogs, P.performance,
  F.productsView, F.listingsView, F.ordersView, F.inventoryView, F.returnsView,
  F.poView, F.pricingView, F.repricingView, F.adsView, F.marketingView,
  F.reviewsView, F.customersView, F.analyticsView, F.insightsView, F.forecastView,
]

export const SYSTEM_ROLES: Record<SystemRoleKey, SystemRoleDef> = {
  OWNER: {
    key: 'OWNER',
    name: 'Owner',
    description:
      'Full, implicit access to everything. System-protected — cannot be deleted or demoted, and only an Owner can grant Owner.',
    permissions: [], // implicit-all; never read by the resolver
    requireMfa: false, // S5 flips on
  },
  ADMIN: {
    key: 'ADMIN',
    name: 'Admin',
    description:
      'Everything except granting Owner or deleting/demoting Owners. Full settings + user management.',
    permissions: [...ALL_PERMISSIONS], // all; OWNER-only ops blocked in the service layer
    requireMfa: false,
  },
  OPS_MANAGER: {
    key: 'OPS_MANAGER',
    name: 'Operations Manager',
    description:
      'Full operational control over orders, inventory, listings, products, marketing. No financial fields (except ad spend), no settings, no user management.',
    permissions: OPS_MANAGER_PERMS,
    requireMfa: false,
  },
  FULFILLMENT: {
    key: 'FULFILLMENT',
    name: 'Fulfillment',
    description: 'View and fulfil orders and inventory. No prices/financials beyond fulfilment needs.',
    permissions: FULFILLMENT_PERMS,
    requireMfa: false,
  },
  FINANCE: {
    key: 'FINANCE',
    name: 'Finance',
    description: 'Financial pages, fields and reports. Read-only on operational data.',
    permissions: FINANCE_PERMS,
    requireMfa: false,
  },
  VIEWER: {
    key: 'VIEWER',
    name: 'Viewer',
    description: 'Read-only operational access. No financial fields.',
    permissions: VIEWER_PERMS,
    requireMfa: false,
  },
}

/**
 * Expand a role's stored permission set to the effective set actually
 * checked at runtime: the master `financials.view` implies every finer
 * financial grain. OWNER (empty set + isImplicitAll) is handled by the
 * resolver, not here.
 */
export function expandPermissions(stored: string[]): Set<string> {
  const set = new Set(stored)
  if (set.has(FIELDS.financialsView)) {
    for (const g of FINANCIAL_SUBGRAINS) set.add(g)
  }
  return set
}

export const OWNER_ROLE_KEY: SystemRoleKey = 'OWNER'

// ── Permission catalog (for the S4 role-matrix UI) ─────────────────
export interface PermissionCatalogItem {
  key: string
  label: string
}
export interface PermissionCatalogGroup {
  module: string
  label: string
  layer: 'page' | 'feature' | 'field'
  items: PermissionCatalogItem[]
}

const MODULE_LABELS: Record<string, string> = {
  pages: 'Pages',
  products: 'Products & catalog',
  pim: 'Products & catalog',
  listings: 'Listings & channels',
  channels: 'Listings & channels',
  orders: 'Orders',
  reviews: 'Reviews',
  inventory: 'Fulfillment & inventory',
  stock: 'Fulfillment & inventory',
  lots: 'Fulfillment & inventory',
  inbound: 'Fulfillment & inventory',
  outbound: 'Fulfillment & inventory',
  returns: 'Fulfillment & inventory',
  suppliers: 'Fulfillment & inventory',
  po: 'Fulfillment & inventory',
  replenishment: 'Fulfillment & inventory',
  carriers: 'Fulfillment & inventory',
  fnsku: 'Fulfillment & inventory',
  fulfillment: 'Fulfillment & inventory',
  pricing: 'Pricing',
  repricing: 'Pricing',
  ads: 'Advertising',
  marketing: 'Marketing & content',
  assets: 'Marketing & content',
  aplus: 'Marketing & content',
  brand: 'Marketing & content',
  analytics: 'Analytics & insights',
  insights: 'Analytics & insights',
  forecast: 'Analytics & insights',
  reports: 'Analytics & insights',
  customers: 'Customers',
  settings: 'Settings',
  admin: 'Admin & ops',
  sync: 'Admin & ops',
  jobs: 'Admin & ops',
  bulk: 'Admin & ops',
  ai: 'AI & agents',
  users: 'Team & access',
  roles: 'Team & access',
  invitations: 'Team & access',
  audit: 'Team & access',
  sessions: 'Team & access',
  financials: 'Financial fields',
}

function humanize(key: string): string {
  // "products.price.edit" → "Price edit"; "pages.orders" → "Orders"
  const parts = key.split('.')
  const tail = key.startsWith('pages.') ? parts.slice(1) : parts.slice(1)
  const words = (tail.length ? tail : parts).join(' ').replace(/\./g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Grouped permission catalog for the role-editor matrix. */
export function permissionCatalog(): PermissionCatalogGroup[] {
  const groups = new Map<string, PermissionCatalogGroup>()
  const push = (module: string, layer: PermissionCatalogGroup['layer'], key: string) => {
    const label = MODULE_LABELS[module] ?? module
    const id = `${layer}:${label}`
    if (!groups.has(id)) groups.set(id, { module, label, layer, items: [] })
    groups.get(id)!.items.push({ key, label: humanize(key) })
  }
  for (const p of Object.values(PAGES)) push('pages', 'page', p)
  for (const p of Object.values(FEATURES)) push(p.split('.')[0], 'feature', p)
  for (const p of Object.values(FIELDS)) push('financials', 'field', p)
  // Order: pages first, then features (alpha by label), then fields.
  return [...groups.values()].sort((a, b) => {
    const order = { page: 0, feature: 1, field: 2 }
    if (order[a.layer] !== order[b.layer]) return order[a.layer] - order[b.layer]
    return a.label.localeCompare(b.label)
  })
}

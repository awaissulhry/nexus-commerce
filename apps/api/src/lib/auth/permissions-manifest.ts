/**
 * Phase S2 (RBAC engine) — route → permission manifest.
 *
 * The single declaration of what permission every API route requires.
 * Rather than editing a `preHandler` onto 2,028 handlers across 149 files
 * (huge diff, touches the untouchable flat-file routes), one global hook
 * matches each request's ROUTE PATTERN (request.routeOptions.url, not the
 * concrete URL) against these ordered rules — first match wins.
 *
 * `PUBLIC` = intentionally unauthenticated (health, webhooks verified by
 * signature, OAuth callbacks, the auth entry points). `null` = UNMAPPED →
 * deny-by-default (403) and a CI test (rbac-coverage) fails the build, so
 * a new route is invisible until someone maps it here.
 *
 * Read vs write is the method class by default; known read-shaped POSTs
 * (search / bulk-fetch / preview / validate / estimate / generate) are
 * overridden to the module's view/read permission. Mapping CORRECTNESS is
 * further proven by the permission-matrix tests; this file's contract is
 * COMPLETENESS (no route unmapped) + sane defaults.
 */

import { PAGES as PG, FEATURES as F } from '@nexus/shared/permissions'

export const PUBLIC = 'PUBLIC' as const
export type RoutePermission = string | typeof PUBLIC | null

const READ = new Set(['GET', 'HEAD', 'OPTIONS'])
const isRead = (m: string) => READ.has(m.toUpperCase())

type Matcher = (method: string, path: string) => boolean

// Helpers -----------------------------------------------------------
const pfx = (p: string): Matcher => (_m, path) => path.startsWith(p)
const has = (s: string): Matcher => (_m, path) => path.includes(s)

// A rule needs the method to pick read vs write, so RW entries carry both.
interface RwRule {
  when: Matcher
  read: RoutePermission
  write: RoutePermission
}
type Entry = { fixed: RoutePermission; when: Matcher } | (RwRule & { fixed?: undefined })

const P = (perm: RoutePermission, when: Matcher): Entry => ({ fixed: perm, when })
const RW = (readPerm: RoutePermission, writePerm: RoutePermission, when: Matcher): Entry => ({
  read: readPerm,
  write: writePerm,
  when,
})

const ENTRIES: Entry[] = [
  // ── PUBLIC: health / infra ──────────────────────────────────────
  P(PUBLIC, (_m, p) => p === '/api/health' || p === '/admin/health' || p === '/health'),
  P(PUBLIC, pfx('/api/monitoring')),
  P(PUBLIC, pfx('/monitoring')),

  // ── PUBLIC: webhook receivers (signature-verified, not session) ──
  P(PUBLIC, pfx('/webhooks/')),
  P(PUBLIC, pfx('/api/webhooks/')),
  P(PUBLIC, has('/_webhooks/')),
  P(PUBLIC, pfx('/api/assets/_webhooks/')),

  // ── PUBLIC: OAuth callbacks (browser redirect / partner-initiated)
  P(PUBLIC, (m, p) => p.startsWith('/api/amazon-ads/auth/')),
  P(PUBLIC, (m, p) => p === '/api/ebay/auth/callback'),

  // ── Auth surface ────────────────────────────────────────────────
  // Entry points anyone must reach unauthenticated:
  P(PUBLIC, (_m, p) =>
    p === '/api/auth/csrf' ||
    p === '/api/auth/login' ||
    p === '/api/auth/logout' ||
    p === '/api/auth/me' ||
    p === '/api/auth/password/reset-request' ||
    p === '/api/auth/password/reset' ||
    p === '/api/auth/invitations/accept' ||
    p === '/api/auth/invitations/accept/preview'),
  // Owner-gated auth admin (also guarded in S1 by requireOwner):
  P(F.usersManage, (_m, p) => p === '/api/auth/logout-all'),
  RW(F.invitationsManage, F.invitationsManage, pfx('/api/auth/invitations')),
  // Self-service 2FA (S5): any authenticated user manages their own — the
  // handler operates on req.authUser, so pages.dashboard = "signed in".
  P(PG.dashboard, pfx('/api/auth/2fa')),

  // ── Team & Access (S4 console) ──────────────────────────────────
  RW(F.usersManage, F.usersManage, pfx('/api/team/users')),
  RW(F.rolesManage, F.rolesManage, pfx('/api/team/roles')),
  P(F.auditView, pfx('/api/audit-log')),
  P(F.auditView, (_m, p) => p === '/api/events'),
  P(F.sessionsManage, pfx('/api/team/sessions')),

  // ── Settings / connections ──────────────────────────────────────
  RW(F.settingsApikeysManage, F.settingsApikeysManage, pfx('/api/settings/api-keys')),
  RW(F.settingsWebhooksManage, F.settingsWebhooksManage, pfx('/api/settings/webhooks')),
  RW(F.settingsPrivacyManage, F.settingsPrivacyManage, pfx('/api/settings/privacy')),
  RW(F.settingsSecurityManage, F.settingsSecurityManage, pfx('/api/settings/2fa')),
  RW(F.settingsSecurityManage, F.settingsSecurityManage, pfx('/api/settings/sessions')),
  RW(F.settingsView, F.settingsSecurityManage, pfx('/api/settings/login-history')),
  RW(F.settingsView, F.settingsNotificationsEdit, pfx('/api/settings/notifications')),
  RW(F.settingsView, F.settingsWorkspaceEdit, pfx('/api/settings/profile')),
  RW(F.settingsView, F.settingsWorkspaceEdit, pfx('/api/settings')),
  RW(F.settingsView, F.settingsWorkspaceEdit, pfx('/api/brand-settings')),
  RW(F.settingsIntegrationsManage, F.settingsIntegrationsManage, pfx('/api/connections')),
  RW(F.settingsIntegrationsManage, F.settingsIntegrationsManage, (_m, p) => p.includes('/setup') && p.startsWith('/api/shopify')),

  // ── Channel connect/disconnect (OAuth-adjacent, session-gated) ──
  RW(F.channelsConnect, F.channelsConnect, pfx('/api/ebay/auth')),
  RW(F.adsConnect, F.adsConnect, pfx('/api/amazon-ads/auth')), // (callback already PUBLIC above)

  // ── S2 coverage: public token endpoints (server-side) ──────────
  P(PUBLIC, pfx('/api/po/ack/')),
  P(PUBLIC, pfx('/api/po/approve/')),
  P(PUBLIC, pfx('/api/r/')),
  P(PUBLIC, (_m, p) => p.startsWith('/api/api/public/')),
  P(PUBLIC, (_m, p) => p === '/api/email/unsubscribe'),

  // ── S2 coverage: nav rail counts (any authenticated user) ──────
  P(PG.dashboard, (_m, p) => p === '/api/sidebar/counts'),

  // ── S2 coverage: AI / agents ───────────────────────────────────
  P(F.aiUsageView, pfx('/api/ai/usage')),
  RW(F.aiView, F.aiRun, pfx('/api/ai/')),
  RW(F.aiView, F.aiRun, pfx('/api/agent/')),
  RW(F.adminView, F.jobsManage, pfx('/api/cockpit/')),

  // ── S2 coverage: listings under /api/listings ──────────────────
  P(F.listingsPublish, (m, p) => pfx('/api/listings')(m, p) && (has('/bulk-action')(m, p) || has('/cascade')(m, p))),
  RW(F.listingsView, F.listingsEdit, pfx('/api/listings')),
  P(F.marketingPublish, pfx('/api/image-publish-jobs')),

  // ── S2 coverage: catalog / PIM sub-resources ───────────────────
  RW(F.pimManage, F.pimManage, pfx('/api/attribute-groups')),
  RW(F.pimManage, F.pimManage, pfx('/api/attribute-options')),
  RW(F.pimManage, F.pimManage, pfx('/api/family-attributes')),
  RW(F.pimManage, F.pimManage, pfx('/api/workflow-stages')),
  RW(F.pimManage, F.pimManage, pfx('/api/workflow-comments')),
  RW(F.productsEdit, F.productsEdit, pfx('/api/tags')),
  RW(F.productsView, F.productsEdit, pfx('/api/saved-views')),
  RW(F.productsView, F.productsEdit, pfx('/api/bundles')),
  RW(F.productsView, F.productsBulkRun, pfx('/api/bulk-ops')),

  // ── S2 coverage: B2B customer pricing (restricted money) ───────
  RW(F.pricingTiersManage, F.pricingTiersManage, pfx('/api/customer-groups')),
  RW(F.pricingTiersManage, F.pricingTiersManage, pfx('/api/tier-prices')),

  // ── S2 coverage: DAM / brand sub-resources ─────────────────────
  RW(F.assetsManage, F.assetsManage, pfx('/api/asset-')),
  RW(F.aplusManage, F.aplusManage, pfx('/api/aplus-modules')),
  RW(F.brandManage, F.brandManage, pfx('/api/brand-watermarks')),

  // ── S2 coverage: FBA inbound v2 (actual path /api/fba/inbound) ──
  RW(F.inboundManage, F.inboundManage, pfx('/api/fba/inbound')),

  // ── S2 coverage: email suppressions (GDPR) ─────────────────────
  RW(F.settingsPrivacyManage, F.settingsPrivacyManage, pfx('/api/email/suppressions')),

  // ── S2 coverage: internal service-to-service ───────────────────
  // NOTE: called by the bidding-engine microservice, not humans — it has
  // no session. Before NEXUS_RBAC_MODE=enforce this must move to API-key
  // (requireApiKeyScope) service auth, else the microservice 403s. Tracked
  // as an S2 follow-up; mapped (not PUBLIC) so it isn't silently open.
  RW(F.adsAutomationManage, F.adsAutomationManage, pfx('/api/internal/bidding')),

  // ── Advertising ─────────────────────────────────────────────────
  P(F.adsView, (m, p) => isRead(m) && pfx('/api/advertising')(m, p)),
  P(F.adsAutomationManage, has('/autopilot')),
  P(F.adsAutomationManage, has('/automation')),
  P(F.adsBudgetsEdit, has('/budget')),
  P(F.adsBidsEdit, (m, p) => has('/bid')(m, p) && p.startsWith('/api/advertising')),
  RW(F.adsView, F.adsCampaignsManage, pfx('/api/advertising')),
  RW(F.adsView, F.adsCampaignsManage, pfx('/api/amazon-ads')),
  RW(F.adsView, F.adsCampaignsManage, pfx('/api/ebay-ads')),

  // ── Pricing / repricing ─────────────────────────────────────────
  RW(F.pricingTiersManage, F.pricingTiersManage, pfx('/api/tier-pricing')),
  RW(F.pricingTiersManage, F.pricingTiersManage, pfx('/api/ebay-volume-pricing')),
  RW(F.pricingCostsEdit, F.pricingCostsEdit, pfx('/api/product-costs')),
  RW(F.repricingView, F.repricingRulesManage, pfx('/api/repricing-rules')),
  RW(F.repricingView, F.repricingRulesManage, pfx('/api/repricing')),
  RW(F.pricingView, F.pricingRulesManage, pfx('/api/pricing-rules')),
  RW(F.pricingView, F.pricingEdit, pfx('/api/pricing')),

  // ── Orders + reviews ────────────────────────────────────────────
  P(F.ordersExport, (m, p) => p.startsWith('/api/orders') && has('/export')(m, p)),
  P(F.ordersExport, (_m, p) => p.startsWith('/api/corrispettivi')),
  P(F.ordersRefund, (m, p) => p.startsWith('/api/orders') && has('/refund')(m, p)),
  P(F.ordersCancel, (m, p) => p.startsWith('/api/orders') && has('/cancel')(m, p)),
  P(F.ordersRoutingManage, pfx('/api/orders-routing')),
  P(F.ordersRoutingManage, pfx('/api/orders/routing')),
  RW(F.ordersView, F.ordersEdit, pfx('/api/orders')),
  RW(F.ordersView, F.ordersEdit, pfx('/api/ebay/orders')),
  RW(F.reviewsView, F.reviewsManage, pfx('/api/reviews')),
  RW(F.reviewsView, F.reviewsManage, pfx('/api/orders-reviews')),
  RW(F.reviewsView, F.reviewsManage, pfx('/api/review-')),

  // ── Fulfillment / inventory ─────────────────────────────────────
  P(F.fulfillmentExport, (m, p) => p.startsWith('/api/fulfillment') && has('/export')(m, p)),
  RW(F.returnsView, F.returnsProcess, pfx('/api/fulfillment/returns')),
  RW(F.returnsView, F.returnsProcess, pfx('/api/returns')),
  RW(F.poView, F.poCreate, pfx('/api/fulfillment/purchase-orders')),
  P(F.poApprove, (m, p) => p.startsWith('/api/fulfillment/purchase-orders') && has('/approve')(m, p)),
  P(F.poReceive, (m, p) => p.startsWith('/api/fulfillment/purchase-orders') && has('/receiv')(m, p)),
  RW(F.suppliersView, F.suppliersManage, pfx('/api/fulfillment/suppliers')),
  RW(F.suppliersView, F.suppliersManage, pfx('/api/fulfillment/development')),
  RW(F.replenishmentView, F.replenishmentRun, pfx('/api/fulfillment/replenishment')),
  RW(F.carriersManage, F.carriersManage, pfx('/api/fulfillment/carriers')),
  RW(F.carriersManage, F.carriersManage, pfx('/api/fulfillment/routing')),
  RW(F.fnskuGenerate, F.fnskuGenerate, pfx('/api/fulfillment/fnsku')),
  RW(F.inboundManage, F.inboundManage, pfx('/api/fulfillment/inbound')),
  RW(F.outboundManage, F.outboundManage, pfx('/api/fulfillment/outbound')),
  RW(F.outboundManage, F.outboundManage, pfx('/api/fulfillment/shipments')),
  RW(F.inventoryView, F.inventoryAdjust, pfx('/api/fulfillment/stock')),
  RW(F.inventoryView, F.inventoryAdjust, pfx('/api/stock')),
  RW(F.inventoryView, F.inventoryAdjust, pfx('/api/inventory')),
  RW(F.inventoryView, F.inventoryAdjust, pfx('/api/inbound')),
  RW(F.inventoryView, F.inventoryAdjust, pfx('/api/fba-inbound-v2')),
  RW(F.inventoryView, F.inventoryAdjust, pfx('/api/reconciliation')),
  RW(F.inventoryView, F.inventoryAdjust, pfx('/api/fulfillment')),

  // ── Marketing / content / DAM ───────────────────────────────────
  RW(F.assetsManage, F.assetsManage, pfx('/api/assets')),
  RW(F.aplusManage, F.aplusManage, pfx('/api/aplus-content')),
  RW(F.brandManage, F.brandManage, pfx('/api/brand-story')),
  RW(F.brandManage, F.brandManage, pfx('/api/brand-stories')),
  RW(F.brandManage, F.brandManage, pfx('/api/brand-kit')),
  RW(F.brandManage, F.brandManage, pfx('/api/brand-brain')),
  P(F.marketingAutomationManage, pfx('/api/marketing-automation')),
  P(F.marketingAutomationManage, (_m, p) => p.startsWith('/api/marketing/os') && has('/action')(_m, p)),
  RW(F.marketingView, F.marketingCampaignsManage, pfx('/api/marketing-os')),
  RW(F.marketingView, F.marketingCampaignsManage, pfx('/api/marketing/os')),
  RW(F.marketingView, F.marketingPublish, pfx('/api/channel-publish')),
  RW(F.marketingView, F.marketingPublish, pfx('/api/bulk-image-publish')),
  RW(F.marketingView, F.marketingPublish, pfx('/api/scheduled-image-publishes')),
  RW(F.marketingView, F.marketingContentEdit, pfx('/api/marketing')),

  // ── Analytics / insights / dashboard ────────────────────────────
  P(F.reportsExport, (m, p) => has('/export')(m, p) && (p.startsWith('/api/insights') || p.startsWith('/api/dashboard') || p.startsWith('/api/analytics'))),
  RW(F.insightsView, F.reportsRun, pfx('/api/insights')),
  RW(F.analyticsView, F.reportsRun, pfx('/api/analytics')),
  RW(F.analyticsView, F.reportsRun, pfx('/api/dashboard')),
  RW(F.forecastView, F.reportsRun, pfx('/api/forecast')),
  RW(F.insightsView, F.reportsRun, pfx('/api/amazon-reports')),
  RW(F.insightsView, F.reportsRun, pfx('/api/amazon/economics')),
  RW(F.insightsView, F.reportsRun, pfx('/api/amazon-economics')),

  // ── Customers ───────────────────────────────────────────────────
  P(F.customersExport, (m, p) => p.startsWith('/api/customers') && has('/export')(m, p)),
  RW(F.customersView, F.customersSegmentsManage, pfx('/api/customer-segments')),
  RW(F.customersView, F.customersSegmentsManage, pfx('/api/customers/segments')),
  RW(F.customersView, F.customersEdit, pfx('/api/customers')),

  // ── Listings / channels ─────────────────────────────────────────
  P(F.listingsFlatfileEdit, pfx('/api/amazon/flat-file')),
  P(F.listingsFlatfileEdit, pfx('/api/ebay/flat-file')),
  // FF2.8b: import-history routes (preview/apply/list/report) use products.import,
  // not listingsFlatfileEdit. Must appear BEFORE the /api/flat-file catch-all.
  P(F.productsImport, pfx('/api/flat-file/import')),
  P(F.productsImport, pfx('/api/flat-file/imports')),
  P(F.listingsFlatfileEdit, pfx('/api/flat-file')),
  RW(F.listingsView, F.listingsPublish, pfx('/api/listing-wizard')),
  RW(F.listingsView, F.listingsPublish, pfx('/api/wizard-templates')),
  RW(F.listingsView, F.listingsRecover, pfx('/api/listing-recovery')),
  RW(F.listingsView, F.listingsEdit, pfx('/api/listing-')),
  RW(F.listingsView, F.listingsEdit, pfx('/api/gtin-exemption')),
  RW(F.listingsView, F.listingsEdit, pfx('/api/feed-transform')),
  RW(F.listingsView, F.listingsEdit, pfx('/api/feed-export')),
  RW(F.listingsView, F.listingsEdit, pfx('/api/images/')),
  RW(F.listingsView, F.channelsSync, pfx('/api/amazon')),
  RW(F.listingsView, F.channelsSync, pfx('/api/ebay')),
  RW(F.listingsView, F.channelsSync, pfx('/listings')),
  RW(F.listingsView, F.channelsSync, pfx('/marketplaces')),
  RW(F.listingsView, F.channelsSync, pfx('/api/marketplaces')),
  RW(F.listingsView, F.channelsSync, pfx('/shopify')),
  RW(F.listingsView, F.channelsSync, pfx('/woocommerce')),
  RW(F.listingsView, F.channelsSync, pfx('/etsy')),
  RW(F.listingsView, F.channelsSync, pfx('/ebay')),

  // ── Products / catalog / PIM ────────────────────────────────────
  P(F.productsView, (m, p) => has('/bulk-fetch')(m, p) || has('/search')(m, p)),
  P(F.productsImport, pfx('/api/import-wizard')),
  P(F.productsImport, pfx('/api/scheduled-imports')),
  P(F.productsExport, pfx('/api/export-wizard')),
  P(F.productsExport, pfx('/api/scheduled-exports')),
  P(F.productsExport, pfx('/api/export-jobs')),
  P(F.productsImagesEdit, has('/images')),
  P(F.productsTranslationsEdit, pfx('/api/product-translations')),
  P(F.productsPriceEdit, (m, p) => p.startsWith('/api/products') && has('/price')(m, p)),
  RW(F.pimManage, F.pimManage, pfx('/api/pim')),
  RW(F.pimManage, F.pimManage, pfx('/api/families')),
  RW(F.pimManage, F.pimManage, pfx('/api/attributes')),
  RW(F.pimManage, F.pimManage, pfx('/api/workflows')),
  RW(F.pimManage, F.pimManage, pfx('/api/product-workflow')),
  RW(F.pimManage, F.pimManage, pfx('/api/workflow-assignments')),
  RW(F.pimManage, F.pimManage, pfx('/api/categories')),
  RW(F.pimManage, F.pimManage, pfx('/api/pim-categories')),
  RW(F.pimManage, F.pimManage, pfx('/api/value-map')),
  RW(F.pimManage, F.pimManage, pfx('/api/mapping-propagation')),
  RW(F.pimManage, F.pimManage, pfx('/api/field-links')),
  RW(F.productsView, F.productsEdit, pfx('/api/catalog')),
  RW(F.productsView, F.productsEdit, pfx('/api/matrix')),
  RW(F.productsView, F.productsEdit, pfx('/api/catalog-matrix')),
  RW(F.productsView, F.productsEdit, pfx('/api/products')),

  // ── AI / agents ─────────────────────────────────────────────────
  RW(F.aiUsageView, F.aiRun, pfx('/api/ai-usage')),
  RW(F.aiView, F.aiRun, pfx('/api/agents')),
  RW(F.aiView, F.aiRun, pfx('/api/products-ai')),
  RW(F.pimManage, F.pimManage, pfx('/api/terminology')),
  RW(F.aiView, F.aiRun, pfx('/ai')),

  // ── Bulk operations ─────────────────────────────────────────────
  P(F.bulkRollback, has('/rollback')),
  RW(F.productsView, F.productsBulkRun, pfx('/api/bulk-operations')),
  RW(F.productsView, F.productsBulkRun, pfx('/api/bulk-action-templates')),
  RW(F.productsView, F.productsBulkRun, pfx('/api/scheduled-bulk-actions')),
  RW(F.productsView, F.productsBulkRun, pfx('/api/bulk-automation')),
  RW(F.productsView, F.productsBulkRun, pfx('/api/import-jobs')),

  // ── Sync / observability / notifications ────────────────────────
  RW(F.adminView, F.syncManage, pfx('/api/sync-logs')),
  RW(F.adminView, F.syncManage, pfx('/api/sync')),
  RW(F.adminView, F.syncManage, pfx('/api/outbound')),
  RW(F.adminView, F.jobsManage, pfx('/api/job-monitor')),
  RW(F.adminView, F.jobsManage, pfx('/api/control-tower')),
  RW(F.adminView, F.jobsManage, pfx('/api/push-')),
  RW(F.adminView, F.jobsManage, pfx('/api/outbound-latency')),
  RW(F.adminView, F.jobsManage, pfx('/api/inventory-sync-diagnostics')),
  RW(F.adminView, F.syncManage, pfx('/api/inbox')),
  RW(F.adminView, F.settingsNotificationsEdit, pfx('/api/notifications')),
  RW(F.adminView, F.settingsNotificationsEdit, pfx('/api/saved-view-alerts')),
  RW(F.adminView, F.jobsManage, pfx('/api/cockpit-telemetry')),

  // ── Admin / ops (destructive) ───────────────────────────────────
  P(F.adminPurge, has('/purge')),
  P(F.adminRestore, has('/restore')),
  P(F.adminRestore, has('/bulk-restore')),
  P(F.adminRepair, has('/repair')),
  P(F.adminRepair, has('/backfill')),
  P(F.adminRepair, has('/cleanup')),
  P(F.adminRepair, has('/rebuild')),
  RW(F.adminView, F.adminRepair, pfx('/api/admin')),
  RW(F.adminView, F.adminRepair, pfx('/admin')),
]

/**
 * Resolve the permission a route requires. Returns a permission string,
 * `PUBLIC`, or `null` (unmapped → deny + CI failure).
 */
export function permissionForRoute(method: string, routePattern: string): RoutePermission {
  for (const e of ENTRIES) {
    if (!e.when(method, routePattern)) continue
    if ('fixed' in e && e.fixed !== undefined) return e.fixed
    return isRead(method) ? (e as RwRule).read : (e as RwRule).write
  }
  return null
}

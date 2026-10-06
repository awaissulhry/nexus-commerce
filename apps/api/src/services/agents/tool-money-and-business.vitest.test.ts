/**
 * MCP.2 — every agent tool, run for real, against a real PostgreSQL with the
 * production schema and the business-isolation policies (PGlite). No mocked
 * tool, no mocked query.
 *
 * Two promises the one door (call-tool.ts) makes to the in-app assistant and
 * to the MCP endpoint, proven on real rows:
 *
 *   MONEY — a person who may act but may not see money gets the same answer as
 *   a money-cleared person, minus exactly the money: no restricted key, and no
 *   value that sat under one. A revenue-only grant reveals revenue and nothing
 *   else.
 *
 *   BUSINESS — a tool run for business A never returns a row of business B,
 *   not when handed B's ids and not when it lists or searches.
 *
 * Every registered tool is covered: a new tool fails the coverage test until
 * it is given arguments here (or is listed as an AI draft, whose output is
 * text the model wrote).
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { RESTRICTED_FIELDS } from '../../lib/auth/financial-fields.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Pick<Awaited<ReturnType<typeof formulaDatabase>>, 'client' | 'close' | 'db'>
// MCP.10 — wrapped as db.ts wraps it: inside a transaction, `prisma.x` is that transaction's client. The
// product bulk writer (behind the bulk tools' dry run) opens one and queries through `prisma` inside it;
// on the raw client those queries waited for the pool's only connection, which the transaction held.
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return {
    default: new Proxy({}, {
      get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property),
    }),
  }
})

// 08 S13 — Amazon's FBA inbound API is outside: its options (with Amazon's fees, money) come from this stand-in.
vi.mock('../../clients/amazon-fba-inbound-v2.client.js', () => ({
  listPackingOptions: vi.fn(async () => ({ packingOptions: [{ packingOptionId: 'TEST-PACK-1', status: 'OFFERED', packingGroups: ['g1'], packingFeatures: [], fees: [{ type: 'FBA_PREP', value: { amount: 4141.41, currencyCode: 'EUR' } }] }] })),
  listPlacementOptions: vi.fn(async () => ({ placementOptions: [] })),
  listTransportationOptions: vi.fn(async () => ({ transportationOptions: [] })),
  createInboundPlan: vi.fn(), getInboundOperation: vi.fn(), confirmPackingOption: vi.fn(), confirmPlacementOption: vi.fn(), confirmTransportationOptions: vi.fn(), getShipmentLabels: vi.fn(),
}))
// The live channel reads never leave this machine: channel logins are sealed with the production key, and a test must
// never reach a marketplace. The Shopify scope of the sheet is not configured here (no Shopify market), so it refuses.
vi.mock('../live-read/index.js', () => ({
  readLiveListing: async () => ({ readAt: '2026-10-01T00:00:00.000Z', source: 'ebay-trading-item', destination: {}, revision: null, content: {}, variations: null, errors: [], raw: null, cached: false }),
  publicLiveRead: (read: Record<string, unknown>) => { const { raw: _raw, ...rest } = read; return rest },
}))

import { callTool, ToolAccessError, type ToolPrincipal, type UserPrincipal } from './call-tool.js'
import { listTools } from './tool-registry.js'
import type { AgentTool, ToolResult } from './tool-types.js'

const A = LEGACY_WORKSPACE_ID
const B = 'mcp_money_business_bravo'
/** Written into every business-B row a tool could return. It must never come back for A. */
const B_MARK = 'BRAVO'

interface Seeded {
  productId: string; orderId: string; approvalId: string; changeId: string; automationRuleId: string; replenishmentRuleId: string; pausedRuleId: string
  shipmentId: string; draftProductId: string; aliasId: string; campaignId: string
  publicationId: string; familyId: string; variantId: string; variantDraftId: string
  /** P4 — a channel account and the trace of one channel call. */
  connectionId: string; traceId: string
  /** P7 — an alert rule and its event, a filed image, a workflow stage the product can move to. */
  ruleId: string; alertEventId: string; assetId: string; stageId: string; themeId: string
  /** P8 — an attribute, a product family and a category to rename (integration: `familyId` is L6's parent product). */
  attributeId: string; productFamilyId: string; categoryId: string
  /** 07 O6 — a customer and a review of the product. */
  customerId: string; reviewId: string
  /** 07 O8 — an order with no shipment yet, a draft shipment, and one with a Sendcloud label. */
  freeOrderId: string; draftShipmentId: string; parcelShipmentId: string
  /** 07 O11 — a Shopify order whose buyer may be e-mailed. */
  messageOrderId: string
  /** 07 O12 — a REQUESTED return of the paid order; a shipped order with a line to return; an inspected return. */
  returnId: string; returnableOrderId: string; returnableLineId: string; inspectedReturnId: string
  /** 07 O13 — an Amazon order delivered 10 days ago (a review may be asked for). */
  reviewableOrderId: string
  /** 07 O17 — an eBay account, inactive until sync-orders-now runs (ENV_AND_ROWS below), so no other tool reaches it. */
  syncAccountId: string
  /** 08 S6–S13 — two stock locations (codes), a count, a pricing rule (integration: `ruleId` is P7's alert rule), a
   *  promotion, a scheduled change, a supplier, a PO, an inbound shipment (integration: `shipmentId` is 07's), an eBay
   *  listing and an FBA plan. */
  location: string; second: string; countId: string; pricingRuleId: string; promotionId: string; scheduledId: string
  supplierId: string; purchaseOrderId: string; inboundShipmentId: string; listingId: string; planId: string
  /** L7–L11 — an unused product to bin, a Matrix operation to revert, a photo nothing uses. */
  unusedId: string; matrixOpId: string; photoId: string
  /** Integration (I9 × P4): an eBay listing (of its own product) that names no account. */
  noAccountListingId: string
  /** T4 — an eBay Priority campaign with an ad group, a keyword (its bid is money) and the keyword's fees. */
  ebayCampaignId: string
  /** P9 — the product's SKU (an import names rows by SKU) and a finished bulk price job to undo. */
  sku: string; bulkJobId: string
}
const seeded: Record<string, Seeded> = {}

const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace(business(workspaceId), work)

function principal(workspaceId: string, permissions: string[]): UserPrincipal {
  return {
    kind: 'user',
    userId: 'u-money',
    label: 'Money test',
    permissions: { isOwner: false, permissions: new Set(permissions) },
    workspace: business(workspaceId),
    via: 'app',
  }
}

const EVERY_ACTION = Object.values(FEATURES)
/** Can do everything, sees every money field. */
const cleared = (workspaceId: string) => principal(workspaceId, [...EVERY_ACTION, ...Object.values(FIELDS)])
/** Can do everything, sees no money field. */
const operator = (workspaceId: string) => principal(workspaceId, EVERY_ACTION)

/** Output is AI-written text: nothing structured to filter, and it calls a model. */
/**
 * T11 — tools that read a marketplace live (a Shopify store, a listing on its channel). This seed has no store and no
 * channel login can be opened here, so they answer in words instead of reading; their own tests stand the channel in
 * (channel-content.tools.vitest.test.ts). They still run below: no money key, and never a row of the other business.
 */
const LIVE_READS = new Set(['shopify-content', 'set-shopify-content', 'listing-live-content'])

const AI_DRAFTS = new Set([
  'draft-alt-text',
  'draft-listing-content',
  'draft-seo',
  'translate-content',
  'draft-customer-message',
])

/**
 * L5/L6 — tools whose dry run needs what this suite does not seed (a live channel, a channel category schema), so here
 * they answer with a refusal. They are not held to "reads the seeded rows"; their answer is still compared for money
 * and for the other business. Each is run for real in its own suite.
 */
const REFUSED_WITHOUT_A_CHANNEL: Record<string, string> = {
  'publish-listing': 'the studio review of a new Etsy listing (no Etsy listing here), refused while Etsy publishing is off on this server (publish-listing.tools test)',
  'set-listing-fields': 'its writer checks an attribute against the channel category schema, which is not seeded here (listing-create.tools test)',
  'close-listing': 'a close needs a channel\'s own state (eBay\'s out-of-stock option, an Amazon offer, the Etsy gate) (listing-close.tools test)',
  'reopen-listing': 'a reopen needs a closed listing and its channel (listing-close.tools test)',
  'end-listing': 'an End needs a live eBay or Shopify listing on its account (listing-lifecycle.tools test)',
  'relist-listing': 'a Relist needs an Ended eBay or Shopify listing on its account (listing-lifecycle.tools test)',
  'delete-listing': 'a Delete needs a listing on its account and the channel\'s gate (listing-lifecycle.tools test)',
  'add-photo-from-url': 'it fetches a web link and stores the file (Cloudinary), neither of which this suite has (photos-link.tools test)',
}

/**
 * I9 — tools whose preview must read the channel first (link-channel-id verifies an Item ID on eBay). The seeded listing
 * names no account, so they refuse before any read: still checked for leaks and money, not for having read rows.
 */
const NEEDS_CHANNEL = new Set(['link-channel-id'])

/** Arguments per tool, for the business whose rows it should read. */
const ARGS: Record<string, (ids: Seeded) => Record<string, unknown>> = {
  'product-snapshot': (ids) => ({ productId: ids.productId }),
  'product-search': () => ({ query: 'MONEY' }),
  'order-search': () => ({}),
  'order-detail': (ids) => ({ orderId: ids.orderId }),
  'stock-levels': (ids) => ({ productId: ids.productId }),
  'price-status': (ids) => ({ productId: ids.productId }),
  'listing-health': (ids) => ({ productId: ids.productId }),
  'product-analytics': (ids) => ({ productId: ids.productId, days: 30 }),
  'channel-stock-drift': () => ({}),
  'replenishment-forecast': (ids) => ({ productId: ids.productId }),
  'insights-metric': () => ({ days: 30 }),
  'detect-anomalies': () => ({}),
  'set-price': (ids) => ({ productId: ids.productId, price: 25 }),
  // L5 — its dry run is the studio review: aimed at Etsy for a product with no Etsy listing (a create), refused here because Etsy publishing is off.
  'publish-listing': (ids) => ({ productId: ids.productId, channel: 'ETSY', marketplace: 'GLOBAL' }),
  // 07 O11 — an e-mail goes only to a Shopify, Etsy or own-shop buyer (an eBay buyer is refused).
  'send-customer-message': (ids) => ({ orderId: ids.messageOrderId, message: 'Your parcel ships today.' }),
  'apply-content': (ids) => ({ productId: ids.productId, title: 'A better title' }),
  'create-negative-keyword': () => ({ externalCampaignId: 'none', keywordText: 'free', matchType: 'NEGATIVE_EXACT' }),
  'graduate-keyword': () => ({ query: 'jacket', sourceExternalCampaignId: 'none', destExternalCampaignId: 'none' }),
  'set-target-bid': () => ({ targetId: 'none', proposedBidCents: 55 }),
  'approval-status': (ids) => ({ approvalId: ids.approvalId }),
  'listing-issues': (ids) => ({ productId: ids.productId }),
  'channel-price-stock': (ids) => ({ productId: ids.productId }),
  'out-of-sync-listings': (ids) => ({ productId: ids.productId }),
  // MCP.10 — previews only here: a queued bulk change shows its prices and values, never a cost.
  'bulk-price-change': (ids) => ({ products: [ids.productId], operation: 'percent', value: 10 }),
  'bulk-attribute-change': (ids) => ({ products: [ids.productId], attributes: { lining_note: 'Quilted' } }),
  // C2 — each product to its own price (the undo of a bulk price change), and undo itself (its dry run reads a change).
  'set-master-prices': (ids) => ({ prices: [{ product: ids.productId, price: 25 }] }),
  'undo-change': (ids) => ({ changeId: ids.changeId }),
  // C8 — what Claude did: the seeded request came over a Claude connection, so its preview (with a cost) is listed.
  'claude-activity': () => ({}),
  // R6 — the automations, and one ads rule with a money cap.
  'list-automations': () => ({}),
  'automation-detail': (ids) => ({ automation: 'A1', rowId: ids.automationRuleId }),
  'automation-activity': (ids) => ({ automation: 'A1', rowId: ids.automationRuleId }),
  // R8 — a replenishment rule's preview: its own area's view and the shared money filter (an ads preview needs
  // financials.adspend.view outright; automation-preview.vitest.test.ts holds that).
  'preview-automation': (ids) => ({ automation: 'N6', rowId: ids.replenishmentRuleId }),
  // 07 O5 — the fulfilment reads (rates: Sendcloud is not connected here, so no carrier is asked).
  'shipping-queue': () => ({}),
  'shipment-detail': (ids) => ({ shipmentId: ids.shipmentId }),
  'shipping-rates': (ids) => ({ shipmentId: ids.shipmentId }),
  // 07 O6 — the after-sale reads.
  'return-search': () => ({}),
  'customer-lookup': () => ({}),
  'review-search': (ids) => ({ productId: ids.productId }),
  'order-report': () => ({ kind: 'orders' }),
  'privacy-requests': () => ({}),
  // 08 S3 — stock reads (stock-levels above).
  'stock-search': () => ({ query: 'MONEY' }),
  'stock-locations': () => ({}),
  'stock-movements': (ids) => ({ productId: ids.productId }),
  'stock-reservations': () => ({}),
  'cycle-counts': () => ({}),
  'shared-stock': () => ({ sku: 'ALPHA-MONEY' }),
  'fba-inventory': (ids) => ({ productId: ids.productId }),
  // 08 S4 — supply reads.
  'supplier-search': () => ({}),
  'purchase-orders': () => ({}),
  'inbound-shipments': () => ({}),
  'product-costs': (ids) => ({ productId: ids.productId }),
  // 08 S5 — pricing reads (price-status above).
  'pricing-rules': () => ({}),
  'price-promotions': () => ({}),
  'scheduled-price-changes': (ids) => ({ productId: ids.productId }),
  'price-explain': (ids) => ({ productId: ids.productId, channel: 'EBAY', marketplace: 'IT' }),
  'replenishment-suggestions': () => ({}),
  // MCP full control T3 — the content reads: the family's text per row, and its translation status.
  'product-content': (ids) => ({ product: ids.productId }),
  'translation-status': (ids) => ({ products: [ids.productId], languages: ['it', 'de'] }),
  // T4 — the glossary and brand voice (no business argument: the business is the caller's).
  'content-guidelines': () => ({ market: 'IT' }),
  // T9 — the recorded readiness that is not ready.
  'content-gaps': () => ({}),
  // T5 — the shared text in one language (a preview here: it shows text, never a cost).
  'set-content': (ids) => ({ product: ids.productId, language: 'it', title: 'A better title', englishMeaning: { title: 'A better title' } }),
  // T7 — one listing's own text, on the listing the seed puts on eBay IT.
  // T8 — several products' text in one approval (one here).
  'bulk-content-change': (ids) => ({ language: 'it', items: [{ product: ids.productId, title: 'A better title', englishMeaning: { title: 'A better title' } }] }),
  // T11 — content read from the channel itself (no Shopify store or channel login here: they answer in words).
  'shopify-content': (ids) => ({ product: ids.productId }),
  'set-shopify-content': (ids) => ({ product: ids.productId, fields: { vendor: 'A vendor' } }),
  'listing-live-content': (ids) => ({ product: ids.productId, channel: 'EBAY', market: 'IT' }),
  // Phase 3 T3 — a category the business loaded on eBay IT (seeded per business): read from Nexus, no eBay call.
  'ebay-categories': () => ({ market: 'IT', categoryId: '177104' }),
  'set-listing-content': (ids) => ({ product: ids.productId, coordinate: { channel: 'EBAY', market: 'IT' }, language: 'it', pin: { title: 'A better title' }, englishMeaning: { title: 'A better title' } }),
  // I2 — the identity checks of the business the call runs in.
  'identity-audit': () => ({}),
  'identity-issues': () => ({}),
  // I10 — identity fixes (previews only here). set-listing-sku needs the listing-SKU column, added in beforeAll.
  'set-product-sku': (ids) => ({ productId: ids.draftProductId, sku: 'MONEY-RENAMED-SKU' }),
  'set-gtin': (ids) => ({ productId: ids.productId, code: '4006381333931' }),
  'set-brand': (ids) => ({ brands: [{ product: ids.productId, brand: 'Money Brand' }] }),
  'set-listing-sku': (ids) => ({ extraListingId: ids.aliasId, sku: 'MONEY-ALIAS-SKU' }),
  // I11 — mark the draft product as a parent; merge the draft product (it holds nothing) into the product.
  'fix-parent': (ids) => ({ action: 'promote', productId: ids.draftProductId }),
  'merge-duplicate-products': (ids) => ({ duplicateId: ids.draftProductId, keeperId: ids.productId }),
  // I3 — one family's ids, and what an id is (here: a Nexus product id).
  'product-identity': (ids) => ({ productId: ids.productId }),
  'find-by-id': (ids) => ({ query: ids.productId }),
  // A2 — the ad reads, aimed at the seeded campaign where they take one (business B's reads as not found from A).
  // A10 — undo of an ad change set (it needs money: refused for a person without it).
  'undo-ad-change': () => ({ changeSetId: 'none' }),
  // A6 — campaign budget and placements (they need money: refused for a person without it).
  'set-campaign-budget': (ids) => ({ campaignId: ids.campaignId, dailyBudgetCents: 2500 }),
  'set-placement-multipliers': (ids) => ({ campaignId: ids.campaignId, topOfSearchPct: 30 }),
  // A7 — a selection moved by a percent (it needs money: refused for a person without it).
  'bulk-ad-bid-change': (ids) => ({ campaignId: ids.campaignId, percent: 10 }),
  // A8 — the no-pause stop shows counts only (no money needed); a restore lists the bids it puts back (money needed).
  'suppress-campaign': (ids) => ({ campaignId: ids.campaignId }),
  'restore-campaign': (ids) => ({ campaignId: ids.campaignId }),
  // A12 — the live-write allowlist (no money in it).
  'set-campaign-live-writes': (ids) => ({ campaignId: ids.campaignId, enabled: true }),
  // AA-W2-12 — a real pause and an enable name the budgets that stop or start spending (they need money).
  'pause-ads': (ids) => ({ campaignIds: [ids.campaignId] }),
  'enable-ads': (ids) => ({ campaignIds: [ids.campaignId] }),
  // AA-W2-13 — an archive names the budgets that stop for good (it needs money).
  'archive-ads': (ids) => ({ campaignIds: [ids.campaignId] }),
  // W3-3 — stock-aware bids: the read shows units and days (no money); the two changes list bids (they need money).
  'ad-stock-risk': (ids) => ({ campaignIds: [ids.campaignId], show: 'all' }),
  'lower-ad-bids-for-stock': (ids) => ({ campaignIds: [ids.campaignId] }),
  'restore-ad-bids-after-stock': (ids) => ({ campaignIds: [ids.campaignId] }),
  'set-campaign-target-acos': (ids) => ({ campaignIds: [ids.campaignId], targetAcosPct: 25 }),
  // Ads autonomy W1-2 — the strategy for the seeded campaign's market: its targets, bids and caps are money.
  'ads-strategy': (ids) => ({ market: 'IT', campaignId: ids.campaignId }),
  // Ads playbook PB-2 — the seeded product's playbook in IT: its daily budget and base bid are money, and so are the
  // strategy's numbers shown beside it.
  'ads-playbook': (ids) => ({ market: 'IT', productId: ids.productId }),
  // Ads playbook PB-3 — a product row's change: its budget and bids are money (a person without them is refused).
  'set-ads-playbook': (ids) => ({ channel: 'AMAZON', kind: 'playbook', market: 'IT', level: 'product', productId: ids.productId, values: { nameToken: 'TESTTOKEN' } }),
  // Ads autonomy W1-3 — needs financials.adspend.view (targets, bids and caps are ad-spend money): a person without
  // money is refused outright. The seeded market strategy's highest bid lowered: a preview, nothing written.
  'set-ads-strategy': () => ({ channel: 'AMAZON', market: 'IT', level: 'market', values: { maxBidCents: 4242 } }),
  // A14/A15 — the eBay ad changes (they need money: refused for a person without it).
  'set-ebay-ad-rates': () => ({ ebayCampaignId: 'none', rates: [{ ebayItemId: '110000000001', ratePct: 5 }] }),
  'promote-ebay-listings': () => ({ ebayCampaignId: 'none', ads: [{ ebayItemId: '110000000001' }] }),
  'set-ebay-campaign-budget': () => ({ ebayCampaignId: 'none', dailyBudgetCents: 1500 }),
  'ebay-keywords-change': () => ({ ebayCampaignId: 'none', keywordBids: [{ ebayKeywordId: 'none', bidCents: 40 }] }),
  'create-ebay-campaign': () => ({ market: 'EBAY_IT', name: 'Money launch' }),
  // PB-5a — a build's campaigns name budgets and bids (it needs money: refused for a person without it); the seeded
  // product has no playbook row, so the answer is a refusal either way.
  'apply-ads-playbook': (ids) => ({ op: 'build', market: 'IT', productId: ids.productId }),
  // A11 — a new campaign's plan names a budget and bids (it needs money: refused for a person without it).
  'create-ad-campaign': (ids) => ({ market: 'IT', name: 'Money launch', skus: [ids.productId], dailyBudgetCents: 1500, defaultBidCents: 50, keywords: [{ text: 'jacket', matchType: 'EXACT' }] }),
  // Ads autonomy W4-1 — a run report states each market's spend and sales (it needs money: refused for a person
  // without it); the run history shows them under the money keys only.
  'report-ads-run': () => ({ op: 'finish', markets: [{ market: 'IT', lines: ['Money test run'] }] }),
  'ads-manager-runs': () => ({ days: 7 }),
  'ads-overview': () => ({}),
  'ad-campaigns': () => ({}),
  'ad-targets': (ids) => ({ campaignId: ids.campaignId, status: 'all' }),
  'ad-search-terms': (ids) => ({ campaignId: ids.campaignId }),
  'ad-changes': (ids) => ({ campaignId: ids.campaignId }),
  'ad-recommendations': (ids) => ({ campaignId: ids.campaignId }),
  // T4 — an eBay campaign's keywords: bids and fees are money.
  'ebay-ad-details': (ids) => ({ view: 'keywords', campaignId: ids.ebayCampaignId }),
  // L2 — listing reads: where each listing lives, its stock and price per market, its photo plan.
  'listing-coordinates': (ids) => ({ productId: ids.productId }),
  'listing-matrix': (ids) => ({ productId: ids.productId }),
  'media-plan': (ids) => ({ productId: ids.productId }),
  // L3 — the studio's review on Etsy (no channel read: Etsy is read only while sending to Etsy is on) and a publication's stored result.
  'publish-review': (ids) => ({ productId: ids.productId, channel: 'ETSY', market: 'GLOBAL' }),
  'publication-status': (ids) => ({ publicationId: ids.publicationId }),
  // L6 — drafts on the Etsy shop, an untouched draft removed, a family's listing leaving one variation out.
  'create-draft-listings': (ids) => ({ productId: ids.productId, channel: 'ETSY', market: 'GLOBAL' }),
  'remove-draft-listings': (ids) => ({ listingIds: [ids.variantDraftId] }),
  'set-listing-fields': (ids) => ({ productId: ids.variantId, channel: 'ETSY', market: 'GLOBAL', values: { attr_materials: ['cotton'] } }),
  // MCP full control P4 — the business, its accounts (one by id), their health (one trace) and its team.
  'business-overview': () => ({}),
  'channel-connections': (ids) => ({ connectionId: ids.connectionId }),
  'channel-health': (ids) => ({ traceId: ids.traceId }),
  'team-access': () => ({}),
  // MCP full control P6 — the summary report, the alerts inbox, one product's audit trail, the queue, AI usage.
  'insights-report': () => ({ report: 'summary' }),
  'alerts-inbox': () => ({}),
  'audit-trail': (ids) => ({ entityId: ids.productId }),
  'sync-activity': () => ({ kind: 'queue' }),
  'ai-usage': () => ({}),
  // MCP full control P7 — previews of the organizing changes.
  'set-product-tags': (ids) => ({ productId: ids.productId, tags: ['MONEY tag'] }),
  'move-workflow-stage': (ids) => ({ productId: ids.productId, stageId: ids.stageId }),
  'save-view': () => ({ name: 'MONEY view 2' }),
  'set-alert-rule': (ids) => ({ ruleId: ids.ruleId, threshold: 150 }),
  'acknowledge-alerts': (ids) => ({ alertEventIds: [ids.alertEventId], action: 'acknowledge' }),
  'organize-image-library': (ids) => ({ assetIds: [ids.assetId], folderId: null }),
  // MCP full control P8 — previews of the structure changes.
  'save-channel-mapping': () => ({ channel: 'EBAY', market: 'IT', rules: [{ fieldKey: 'title', rule: { source: 'sku' } }] }),
  'save-listing-template': (ids) => ({ themeId: ids.themeId, name: 'Renamed' }),
  // MCP full control P10 — one brand field (the preview shows the legal identity).
  'set-business-settings': () => ({ websiteUrl: 'https://example.test/money' }),
  // 09 §4, P-3 — catalog rows; the product's cost is a money column.
  'export-rows': () => ({ entity: 'products' }),
  // P9 — an import's preview (one product renamed), and the undo of a bulk price job.
  'import-catalog': (ids) => ({ text: `SKU,Name\n${ids.sku},MONEY renamed`, mapping: { skuColumn: 'SKU', market: 'IT', mode: 'update', bindings: [{ source: 'Name', entity: 'Products', field: 'name' }] } }),
  'rollback-bulk-operation': (ids) => ({ jobId: ids.bulkJobId }),
  'save-attribute': (ids) => ({ kind: 'attribute', attributeId: ids.attributeId, label: 'MONEY attribute 2' }),
  'save-product-family': (ids) => ({ familyId: ids.productFamilyId, label: 'MONEY family 2' }),
  'save-category': (ids) => ({ categoryId: ids.categoryId, name: 'MONEY category 2' }),
  // MCP full control P5 — the attributes, the mapping rules, the image library, saved views and import history.
  'catalog-structure': () => ({ kind: 'attributes' }),
  'channel-mappings': () => ({}),
  'image-library': () => ({}),
  'saved-views': () => ({}),
  'job-history': () => ({ kind: 'import' }),
  // C7 — confirm-change's own dry run only checks its shape (Claude's door checks everything else).
  'confirm-change': (ids) => ({ approvalId: ids.approvalId, planHash: 'f'.repeat(64), code: '000000' }),
  // C6 — a plan's own dry run only checks its shape (the gate dry-runs each step as the caller).
  'submit-change-plan': (ids) => ({ title: 'Money plan', steps: [{ tool: 'set-price', args: { productId: ids.productId, price: 25 } }] }),
  // R9 — a rule save needs financials.adspend.view: a person without money is refused outright.
  'save-ad-rule': (ids) => ({ kind: 'amazon-ads', ruleId: ids.automationRuleId, name: 'Renamed rule' }),
  // R10 — level moves of the ads rule (OBSERVE): up to PROPOSE, down to OFF.
  'turn-up-automation': (ids) => ({ automation: 'A1', rowId: ids.automationRuleId, level: 'PROPOSE' }),
  'turn-down-automation': (ids) => ({ automation: 'A1', rowId: ids.automationRuleId, level: 'OFF' }),
  // R11 — needs financials.adspend.view: a person without money is refused outright.
  'decide-automation-suggestions': (ids) => ({ kind: 'amazon-ads', decisions: [{ suggestionId: ids.automationRuleId, decide: 'dismiss' }] }),
  // Ads autonomy W3-1 — need financials.adspend.view: a person without money is refused outright.
  'apply-ad-recommendations': (ids) => ({ recommendationIds: [`budget:${ids.campaignId}`], why: 'money test apply' }),
  'mute-ad-recommendations': (ids) => ({ recommendationIds: [`budget:${ids.campaignId}`], op: 'unmute', why: 'money test unmute' }),
  // R12 — stop the restock rule; resume the one switched off.
  'stop-automation': (ids) => ({ area: 'rules', domain: 'replenishment', ruleIds: [ids.replenishmentRuleId], reason: 'money test stop' }),
  'resume-automation': (ids) => ({ area: 'rules', domain: 'replenishment', ruleIds: [ids.pausedRuleId] }),
  // R13 — needs financials.adspend.view: a person without money is refused outright.
  'set-ad-guardrail': () => ({ kind: 'protected-term', op: 'set', term: 'money test term' }),
  // Ads autonomy W3-2 — needs financials.adspend.view (the bids and budgets it names): a person without money is refused outright.
  'cancel-queued-ad-write': (ids) => ({ changeSetId: ids.approvalId, why: 'money test cancel' }),
  // R14 — needs financials.adspend.view: a person without money is refused outright.
  'tune-ad-engine': () => ({ setting: 'breaker', breaker: { maxActionsPerHour: 100 } }),
  // R15 — a run now, previewed (no model call): no money in it.
  'steer-fleet': () => ({ action: 'run-now', charterKey: 'amazon-bid-tuner' }),
  // R17 — a new repricing rule, previewed: its range and what it would pick; no money field.
  'save-price-rule': (ids) => ({ productId: ids.productId, channel: 'EBAY', marketplace: 'IT', minPrice: 10, maxPrice: 20, strategy: 'match_buy_box' }),
  // R18 — a new replenishment rule, previewed: its value cap is money (financials.adspend.view, as the automation reads).
  'save-ops-rule': () => ({ domain: 'replenishment', name: 'Money test rule', trigger: 'cron_tick', conditions: [{ field: 'product.sku', op: 'eq', value: 'TEST-SKU-1' }], actions: [{ type: 'notify' }], maxExecutionsPerDay: 5, maxValueCentsEur: 100 }),
  // 07 O7 — the order desk's changes (previews only here).
  'update-order': (ids) => ({ orderId: ids.orderId, note: 'Money test note' }),
  'update-customer': (ids) => ({ customerId: ids.customerId, note: 'Money test note' }),
  'triage-reviews': (ids) => ({ reviews: [{ reviewId: ids.reviewId, status: 'IN_PROGRESS' }] }),
  // 07 O8 — shipments and labels (previews only; no carrier is connected here).
  'create-shipments': (ids) => ({ orderIds: [ids.freeOrderId] }),
  'update-shipment': (ids) => ({ shipments: [{ shipmentId: ids.draftShipmentId, action: 'hold' }] }),
  'buy-shipping-label': (ids) => ({ shipmentIds: [ids.draftShipmentId] }),
  'void-shipping-label': (ids) => ({ shipmentIds: [ids.parcelShipmentId] }),
  // 07 O9 — confirm a labelled shipment (preview only).
  'confirm-shipment': (ids) => ({ shipments: [{ shipmentId: ids.parcelShipmentId }] }),
  // 07 O10 — previews only here.
  'cancel-order': (ids) => ({ orderId: ids.freeOrderId, reason: 'Money test cancel' }),
  // 07 O12 — returns and refunds (previews only here; the eBay refund is not sent).
  'create-return': (ids) => ({ orderId: ids.returnableOrderId, items: [{ orderItemId: ids.returnableLineId, quantity: 1 }] }),
  'update-return': (ids) => ({ returns: [{ returnId: ids.returnId, action: 'authorize' }] }),
  'dispose-return-items': (ids) => ({ returns: [{ returnId: ids.inspectedReturnId, action: 'restock' }] }),
  'issue-refund': (ids) => ({ returnId: ids.returnId, amount: 10 }),
  // 07 O13 — previews only (an eBay reply needs eBay replies on: ENV below).
  'request-review': (ids) => ({ orderId: ids.reviewableOrderId }),
  'reply-to-review': (ids) => ({ reviewId: ids.reviewId, body: 'Thank you for your feedback' }),
  // 07 O14 — preview only (the company identity is seeded below).
  'issue-fiscal-document': (ids) => ({ orderIds: [ids.returnableOrderId] }),
  // 07 O17 — previews only (the pickup carrier is MANUAL; the account is switched on for its runs only).
  'schedule-pickup': () => ({ carrier: 'MANUAL', date: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10) }),
  'sync-orders-now': (ids) => ({ channel: 'EBAY', accountId: ids.syncAccountId }),
  // 08 S6 — stock changes (dry runs only here).
  'set-stock': (ids) => ({ items: [{ productId: ids.productId, location: ids.location, quantity: 9 }] }),
  'transfer-stock': (ids) => ({ items: [{ productId: ids.productId, fromLocation: ids.location, toLocation: ids.second, quantity: 1 }] }),
  'stock-count': (ids) => ({ action: 'record', countId: ids.countId, items: [{ productId: ids.productId, counted: 5 }] }),
  'reconcile-stock-count': (ids) => ({ countId: ids.countId }),
  'reserve-stock': (ids) => ({ action: 'reserve', productId: ids.productId, location: ids.location, quantity: 1 }),
  'set-stock-location': (ids) => ({ action: 'rename', location: ids.location, name: 'Renamed warehouse' }),
  // 08 S12 — pricing records (dry runs only here).
  'set-pricing-rule': (ids) => ({ action: 'update', ruleId: ids.pricingRuleId, priority: 3 }),
  'set-promotion': (ids) => ({ action: 'end', promotionId: ids.promotionId }),
  'schedule-price-change': (ids) => ({ action: 'cancel', productId: ids.productId, scheduledChangeId: ids.scheduledId }),
  // 08 S8 — business A borrows from a lender that has A's SKU (seeded below).
  'set-stock-source': (ids) => ({ productIds: [ids.productId], to: 'pool', lender: 'Money lender' }),
  // 08 S7 — Sync Control (dry runs only here): pause the seeded eBay listing's sync; pause eBay IT pushes.
  'bulk-listing-stock': (ids) => ({ action: 'PAUSE', listingIds: [ids.listingId] }),
  'set-stock-policy': () => ({ channel: 'EBAY', marketplace: 'IT', pushesPaused: true }),
  // 08 S11 — prices (dry runs only here): a floor on the product, the eBay listing 5 % up, its price sent again.
  'set-price-bounds': (ids) => ({ items: [{ productId: ids.productId, minPrice: 1 }] }),
  'bulk-listing-price-change': (ids) => ({ listingIds: [ids.listingId], mode: 'percent', value: 5 }),
  'resend-prices': (ids) => ({ listingIds: [ids.listingId] }),
  // 08 S9 — suppliers and purchase orders (dry runs only here; upsert-supplier needs supplier money to be judged).
  'upsert-supplier': (ids) => ({ supplierId: ids.supplierId, leadTimeDays: 30 }),
  'draft-purchase-order': (ids) => ({ supplierId: ids.supplierId, lines: [{ productId: ids.productId, quantity: 3 }] }),
  'advance-purchase-order': (ids) => ({ purchaseOrderId: ids.purchaseOrderId, transition: 'submit-for-review' }),
  'cancel-purchase-order': (ids) => ({ purchaseOrderId: ids.purchaseOrderId, reason: 'Money test' }),
  'email-supplier': (ids) => ({ supplierId: ids.supplierId, purchaseOrderId: ids.purchaseOrderId, message: 'Please confirm the delivery date.' }),
  // 08 S10 — receiving, inbound shipments, costs, replenishment (dry runs only here).
  'receive-stock': (ids) => ({ shipmentId: ids.inboundShipmentId, lines: [{ productId: ids.productId, quantity: 2 }] }),
  'update-inbound-shipment': (ids) => ({ shipmentId: ids.inboundShipmentId, notes: 'Money note' }),
  'set-product-costs': (ids) => ({ costs: [{ productId: ids.productId, costPrice: 4300 }] }),
  'replenishment-action': (ids) => ({ productIds: [ids.productId] }),
  // 08 S13 — an eBay markdown, tier prices, an FBA plan and its options (dry runs and a mocked Amazon read).
  'set-ebay-price-promotion': (ids) => ({ listingIds: [ids.listingId], discountValue: 10 }),
  'set-tier-prices': (ids) => ({ productId: ids.productId, tiers: [{ minQty: 10, price: 17 }] }),
  'plan-fba-shipment': (ids) => ({ marketplace: 'IT', lines: [{ productId: ids.productId, quantity: 2 }], sourceAddress: { name: 'Money sender', addressLine1: 'Via Test 1', city: 'Testville', stateOrProvinceCode: 'TS', postalCode: '00000', countryCode: 'IT' } }),
  'fba-shipment-options': (ids) => ({ planId: ids.planId }),
  // I8 — the seeded listing names no account: nothing is read from a channel here.
  'channel-identity-check': (ids) => ({ productId: ids.productId }),
  // I9 — unlink previews here; link verifies on the channel first, which this seed cannot reach (see NEEDS_CHANNEL).
  'unlink-channel-id': (ids) => ({ listingId: ids.listingId }),
  // Integration (I9 × P4): the eBay IT listing is on the business's account (round 1), so link names the one without.
  'link-channel-id': (ids) => ({ listingId: ids.noAccountListingId, externalId: '510000000001' }),
  // L7 — a new product (it names no row), a new size of the seeded family, an unused product to the recycle bin.
  'create-product': () => ({ sku: 'MONEY-NEW-PRODUCT', name: 'A new jacket', basePrice: 25 }),
  'create-variations': (ids) => ({ productId: ids.familyId, axisValues: { Size: ['L'] }, skuPattern: '{parent}-{Size.code}' }),
  'discard-new-products': (ids) => ({ productIds: [ids.unusedId] }),
  // L8 — the family's Etsy drafts in the Matrix: resume their stock sync, set a price; revert a stored Matrix operation.
  'set-listing-stock': (ids) => ({ productId: ids.familyId, action: 'resume-sync', targets: [{ rowId: ids.variantId, coordinateKey: 'ETSY:GLOBAL' }] }),
  'set-listing-price': (ids) => ({ productId: ids.familyId, action: 'set-price', price: 31, targets: [{ rowId: ids.variantId, coordinateKey: 'ETSY:GLOBAL' }] }),
  'revert-listing-change': (ids) => ({ productId: ids.productId, operationId: ids.matrixOpId }),
  // L9 — the seeded live eBay listing (its account's out-of-stock option cannot be read here: refused).
  'close-listing': (ids) => ({ listingIds: [ids.listingId] }),
  'reopen-listing': (ids) => ({ listingIds: [ids.listingId] }),
  // Phase 3 (T1) — the same listing (it names no account here: refused before any engine read).
  'end-listing': (ids) => ({ listingIds: [ids.listingId], confirmSku: 'MONEY-FAMILY' }),
  'relist-listing': (ids) => ({ listingIds: [ids.listingId], confirmSku: 'MONEY-FAMILY' }),
  'delete-listing': (ids) => ({ listingIds: [ids.listingId], confirmSku: 'MONEY-FAMILY' }),
  // L10 — the product's photo plan (seeded on the media plan): one gallery, no picture axis.
  'arrange-photos': (ids) => ({ productId: ids.productId, address: { layer: 'SHARED' }, ops: [{ op: 'axis', axis: null }] }),
  // L11 — a photo from a link (refused here: no web, no photo store), and the seeded unused photo removed.
  'add-photo-from-url': (ids) => ({ productId: ids.productId, url: 'https://photos.example.test/money.png' }),
  'remove-unused-photo': (ids) => ({ productId: ids.productId, photoId: ids.photoId }),
}

/** A switch a tool's preview reads, set for that tool's runs only (07 O13: an eBay reply is refused while replies are off). */
const ENV: Record<string, Record<string, string>> = { 'reply-to-review': { NEXUS_EBAY_REAL_API: 'true' } }
/** 07 O17 — rows a tool's preview needs live only for its own runs (an active account would reach other tools). */
const ROWS: Record<string, { on: () => Promise<unknown>; off: () => Promise<unknown> }> = {
  'sync-orders-now': {
    on: () => inside(A, () => database.client.channelConnection.update({ where: { id: seeded[A].syncAccountId }, data: { isActive: true } })),
    off: () => inside(A, () => database.client.channelConnection.update({ where: { id: seeded[A].syncAccountId }, data: { isActive: false } })),
  },
}
async function withEnv<T>(toolName: string, work: () => Promise<T>): Promise<T> {
  const env = ENV[toolName] ?? {}
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
  Object.assign(process.env, env)
  await ROWS[toolName]?.on()
  try {
    return await work()
  } finally {
    await ROWS[toolName]?.off()
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function seedBusiness(workspaceId: string, mark: string): Promise<Seeded> {
  return inside(workspaceId, async () => {
    const db = database.client
    // MCP.10 — the market the listing below is on: the bulk writer builds its attribute rules from it.
    await db.marketplace.create({
      data: {
        channel: 'EBAY', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: 'EBAY_IT',
        // MCP full control P5 — one mapping rule, so channel-mappings has one to show.
        schemaMapping: { version: 1, fields: { title: { source: 'name', notes: `${mark} title rule` } } },
      } as never,
    })
    // Phase 3 T3 — the business's loaded details of one eBay IT category (what "Load eBay fields" stores): ebay-categories
    // reads them without calling eBay, and business A must never read B's.
    await db.categorySchema.create({
      data: {
        channel: 'EBAY', marketplace: 'IT', productType: '177104', schemaVersion: `${mark}-ebay-177104`, expiresAt: new Date(Date.now() + 86_400_000),
        schemaDefinition: { aspects: [{ id: 'aspect_Brand', label: `${mark} Marca`, localizedName: `${mark} Marca`, englishName: 'Brand', options: [`${mark} brand`], enumMode: 'open', required: true, cardinality: 'SINGLE' }], conditions: [{ value: 'NEW', label: 'Nuovo' }] },
      },
    })
    // L3 — an Etsy shop and its market, so publish-review reviews a destination without reading a channel.
    await db.marketplace.create({
      data: { channel: 'ETSY', code: 'GLOBAL', name: 'Etsy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } as never,
    })
    const etsy = await db.channelConnection.create({ data: { channelType: 'ETSY', isActive: true, accountLabel: `${mark} Etsy shop`, externalAccountId: `${mark}-ETSY-SHOP` } })
    // L6 — a family with its untouched Etsy drafts (what remove-draft-listings and set-listing-fields act on).
    const family = await db.product.create({ data: { sku: `${mark}-FAMILY`, name: `${mark} family`, basePrice: '30.00', isParent: true, variationAxes: ['Size'] } as never })
    const variant = await db.product.create({ data: { sku: `${mark}-FAMILY-M`, name: `${mark} family M`, basePrice: '30.00', parentId: family.id, variantAttributes: { Size: 'M' } } as never })
    const draft = (productId: string) => db.channelListing.create({ data: { productId, channel: 'ETSY', marketplace: 'GLOBAL', channelMarket: 'ETSY_GLOBAL', region: 'GLOBAL',
      channelConnectionId: etsy.id, listingStatus: 'DRAFT', isPublished: false, syncPaused: true } as never })
    await draft(family.id)
    const variantDraft = await draft(variant.id)
    // L7 — a product nobody used yet (discard-new-products moves it to the recycle bin).
    const unused = await db.product.create({ data: { sku: `${mark}-UNUSED`, name: `${mark} unused`, basePrice: '5.00' } })
    const product = await db.product.create({
      data: {
        sku: `${mark}-MONEY-SKU`,
        name: `${mark} MONEY jacket`,
        basePrice: '19.90',
        costPrice: '4242.42',
        totalStock: 7,
        // MCP.10 — a saved attribute, so bulk-attribute-change has one it may set.
        categoryAttributes: { lining_note: `${mark} mesh` },
      },
    })
    const order = await db.order.create({
      data: {
        channel: 'EBAY',
        channelOrderId: `${mark}-ORDER-1`,
        marketplace: 'IT',
        currencyCode: 'EUR',
        totalPrice: '3000.03',
        customerName: `${mark} Buyer`,
        customerEmail: `${mark.toLowerCase()}.buyer@example.test`,
        shippingAddress: { city: 'Milano' },
        purchaseDate: new Date(),
        items: { create: [{ sku: product.sku, productId: product.id, quantity: 3, price: '1000.01' }] },
      },
    })
    await db.order.create({
      data: {
        channel: 'AMAZON',
        channelOrderId: `${mark}-ORDER-2`,
        marketplace: 'DE',
        currencyCode: 'EUR',
        totalPrice: '7.77',
        customerName: `${mark} Second`,
        customerEmail: `${mark.toLowerCase()}.second@example.test`,
        shippingAddress: { city: 'Berlin' },
        purchaseDate: new Date(),
      },
    })
    const listing = await db.channelListing.create({
      data: {
        productId: product.id,
        channelMarket: 'EBAY_IT',
        channel: 'EBAY',
        region: 'IT',
        marketplace: 'IT',
        title: `${mark} listing`,
        price: '21.50',
        quantity: 5,
        listingStatus: 'ACTIVE',
        externalListingId: `${mark}-ITEM-1`,
      },
    })
    // MCP.9 — what the cross-channel tools read: an open channel issue and a read-back that found a difference.
    await db.listingIssue.create({
      data: {
        listingId: listing.id,
        code: 'CODE-1',
        severity: 'ERROR',
        message: `${mark} brand is required`,
        attributeNames: ['brand'],
        categories: [],
        fingerprint: 'CODE-1::brand',
      },
    })
    const checkedAt = new Date().toISOString()
    await db.channelDrift.create({
      data: {
        channelListingId: listing.id,
        channel: 'EBAY',
        marketplace: 'IT',
        driftCount: 1,
        driftedFields: [{ field: 'quantity', ours: 5, theirs: 4, source: 'ebay-trading-getitem', checkedAt }],
        lastCheckedAt: new Date(checkedAt),
        checkedBySource: { 'ebay-trading-getitem': { at: checkedAt, outcome: 'compared', differing: 1 } },
      },
    })
    await db.channelStockEvent.create({
      data: {
        channel: 'EBAY',
        channelEventId: `${mark}-EVT-1`,
        sku: product.sku,
        productId: product.id,
        channelReportedQty: 4,
        localQtyAtObservation: 7,
        drift: -3,
      },
    })
    await db.replenishmentRecommendation.create({
      data: {
        productId: product.id,
        sku: product.sku,
        velocity: '0.5',
        velocitySource: 'test',
        leadTimeDays: 10,
        leadTimeSource: 'test',
        safetyDays: 3,
        totalAvailable: 7,
        inboundWithinLeadTime: 0,
        effectiveStock: 7,
        reorderPoint: 9,
        reorderQuantity: 20,
        urgency: 'HIGH',
        needsReorder: true,
      },
    })
    const rule = await db.alertRule.create({
      data: { name: `${mark} queue rule`, metric: 'queueDepth', operator: 'gt', threshold: 100, notificationChannels: [] },
    })
    const alertEvent = await db.alertEvent.create({ data: { ruleId: rule.id, value: 250 } })
    // A queued change whose stored preview carries money the reader may not see — asked for over a Claude connection
    // (C8: claude-activity lists it, through the reader's money filter).
    const run = await db.agentRun.create({ data: { agentKey: 'claude', trigger: 'manual', status: 'done', via: 'claude', oauthGrantId: `grant-${mark}` } })
    const approval = await db.agentApproval.create({
      data: {
        agentRunId: run.id,
        toolName: 'apply-content',
        riskTier: 'medium',
        args: { productId: product.id, title: `${mark} title` },
        preview: { action: 'apply-content', changes: { title: { from: product.name, to: `${mark} title` } }, costPrice: '4242.42' },
        status: 'pending',
      },
    })
    // C2 — a change that ran (19.90 is what it wrote and what is stored), so undo-change has one it may undo.
    const change = await db.agentChange.create({
      data: {
        approvalId: approval.id,
        toolName: 'set-price',
        via: 'app',
        reversibility: 'full',
        before: { productId: product.id, sku: product.sku, price: 18 },
        after: { productId: product.id, price: 19.9 },
      },
    })
    // R6 — an ads rule with a per-run money cap: the automation tools show it to a money-cleared person only.
    const automationRule = await db.automationRule.create({
      data: { domain: 'advertising', name: `${mark} MONEY rule`, trigger: 'SCHEDULE', enabled: true, autonomyLevel: 'OBSERVE', maxValueCentsEur: 4343, actions: [{ type: 'log_only' }] },
    })
    const replenishmentRule = await db.automationRule.create({
      data: { domain: 'replenishment', name: `${mark} MONEY restock rule`, trigger: 'recommendation_generated', enabled: true, actions: [{ type: 'log_only' }] },
    })
    // 07 O6 — a customer with a total spend (revenue), a return and a review.
    const customer = await db.customer.create({
      data: { id: `${mark.toLowerCase()}-customer`, email: `${mark.toLowerCase()}.buyer@example.test`, name: `${mark} Buyer`, totalOrders: 1, totalSpentCents: 300003n, lastOrderAt: new Date() } as never,
    })
    const ret = await db.return.create({ data: { orderId: order.id, channel: 'EBAY', marketplace: 'IT', rmaNumber: `${mark}-RMA-1`, refundCents: 1000 } as never })
    const review = await db.review.create({
      data: { channel: 'EBAY', marketplace: 'IT', externalReviewId: `${mark}-REVIEW-1`, productId: product.id, sku: product.sku, rating: 4, body: `${mark} fits well`, authorName: `${mark} Reviewer`, postedAt: new Date() } as never,
    })
    // 07 O5 — a shipment with a label cost (a cost the operator may not see).
    const shipment = await db.shipment.create({
      data: { orderId: order.id, carrierCode: 'MANUAL', status: 'LABEL_PRINTED', trackingNumber: `${mark}-TRACK-1`, costCents: 4343 } as never,
    })
    // I10 — a product not live anywhere (its SKU may be renamed) and an extra listing (its SKU may be recorded).
    const draftProduct = await db.product.create({ data: { sku: `${mark}-MONEY-DRAFT`, name: `${mark} draft jacket`, basePrice: '9.90' } })
    const alias = await db.productListingAlias.create({ data: { productId: product.id, channel: 'EBAY', marketplace: 'IT', label: `${mark} second listing`, position: 2 } })
    // A2 — an Amazon campaign with a target, a day of spend, a wasteful search term and a bid change: the ad reads
    // have money to strip, and business B's campaign carries its mark.
    const campaign = await db.campaign.create({
      data: { name: `${mark} MONEY campaign`, type: 'SP', marketplace: 'IT', externalCampaignId: `${mark}-CMP`, dailyBudget: '31.41', startDate: new Date() } as never,
    })
    const adGroup = await db.adGroup.create({ data: { campaignId: campaign.id, name: `${mark} ad group`, externalAdGroupId: `${mark}-AG` } })
    // Ads autonomy W1-2 — the product is advertised in that ad group, and the market and the product have a strategy whose
    // target, bids and caps are money (ads-strategy hides them from a person without ad-spend money).
    await db.adProductAd.create({ data: { adGroupId: adGroup.id, productId: product.id, asin: `${mark}-ASIN-1` } })
    await db.adsStrategy.create({ data: { market: 'IT', level: 'MARKET', label: `${mark} strategy (IT)`, targetKind: 'ACOS', targetPct: 37, maxBidCents: 8181, monthlySpendCapCents: 727272, maxChangePct: 20, updatedBy: 'user:u-money' } })
    await db.adsStrategy.create({ data: { market: 'IT', level: 'PRODUCT', scopeId: product.id, label: `${mark} product strategy (IT)`, minBidCents: 1919, harvestMinOrders: 2, harvestMinClicks: 4, harvestMaxAcosPct: 63, harvestWindowDays: 60, updatedBy: 'user:u-money' } })
    // Ads playbook PB-2 — the product's playbook row: its daily budget and base bid are money (ads-playbook hides them).
    await db.adsPlaybook.create({ data: { market: 'IT', level: 'PRODUCT', scopeId: product.id, label: `${mark} playbook (IT)`, enrolled: true, dailyBudgetCents: 646464, baseBidCents: 5353, updatedBy: 'user:u-money' } })
    const target = await db.adTarget.create({ data: { adGroupId: adGroup.id, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `${mark} jacket`, bidCents: 4747 } })
    const yesterday = new Date(Date.now() - 86_400_000)
    await db.amazonAdsDailyPerformance.create({
      data: { profileId: 'P1', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: yesterday, entityType: 'CAMPAIGN', entityId: `${mark}-CMP`, localEntityId: campaign.id, impressions: 321, clicks: 17, costMicros: 73_730_000n, currencyCode: 'EUR', sales7dCents: 9191, orders7d: 1, reportedAt: new Date() } as never,
    })
    await db.amazonAdsSearchTerm.create({
      data: { profileId: 'P1', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: yesterday, campaignId: `${mark}-CMP`, adGroupId: `${mark}-AG`, query: `${mark.toLowerCase()} cheap jacket`, impressions: 222, clicks: 19, costMicros: 26_260_000n, currencyCode: 'EUR', orders7d: 0, sales7dCents: 0 },
    })
    await db.campaignBidHistory.create({
      data: { entityType: 'AD_TARGET', entityId: target.id, campaignId: campaign.id, field: 'bid', oldValue: '4646', newValue: '4747', changedBy: 'user:u-money', reason: `${mark} raised to 47.47` },
    })
    // L10 — the product is on the media plan (its Shared layer): arrange-photos edits it.
    await db.productMediaPlan.create({ data: { productId: product.id, layer: 'SHARED', plan: { version: 1, sets: {} } } })
    // L11 — a photo nothing uses (remove-unused-photo may remove it).
    const photo = await db.productImage.create({ data: { productId: product.id, url: `https://images.example.test/${mark}/side.jpg`, alt: `${mark} side`, type: 'ALT' } })
    // L8 — a Matrix operation that can still be reverted (revert-listing-change reads it).
    const matrixOp = await db.bulkOperation.create({ data: { userId: null, status: 'COMPLETED', productCount: 1, changeCount: 0, expiresAt: new Date(Date.now() + 3600_000),
      changes: { kind: 'studio-matrix-verb', verb: 'set-buffer', productId: product.id, before: [], changes: [], outcomes: [], phase: 'apply' } } })
    // L3 — a publication with its stored result (publication-status reads it without asking the channel).
    const publication = await db.bulkOperation.create({
      data: {
        userId: null, status: 'ACCEPTED', productCount: 1, changeCount: 1,
        changes: {
          kind: 'studio-publication', productId: product.id, scope: { channel: 'EBAY', marketplace: 'IT', accountId: 'none' },
          result: { id: 'stored', status: 'ACCEPTED', message: `${mark} accepted`, results: [{ sku: product.sku, status: 'ACCEPTED', message: 'Accepted' }] },
        },
      },
    })
    // MCP full control P4 — a channel account with an event, a channel call with a trace, the brand and a role.
    const connection = await db.channelConnection.create({
      data: { channelType: 'EBAY', managedBy: 'oauth', isActive: true, accountLabel: `${mark} eBay account`, authStatus: 'connected', externalAccountId: `${mark}-SELLER` },
    })
    // Integration (P4 × T7): with an eBay account in the business, the product sheet puts the eBay IT listing on that
    // account, so T7's set-listing-content previews only a listing that is on it (see the integration report).
    await db.channelListing.updateMany({ where: { productId: product.id, channel: 'EBAY', marketplace: 'IT' }, data: { channelConnectionId: connection.id } })
    // Integration (I9 × P4): a product of its own with an eBay IT listing that names no account — what link-channel-id
    // refuses before any channel read (the main product's eBay IT listing is on the business's account above).
    const linkProduct = await db.product.create({ data: { sku: `${mark}-LINK-ONLY`, name: `${mark} link jacket`, basePrice: '9.90' } })
    const noAccountListing = await db.channelListing.create({
      data: { productId: linkProduct.id, channelMarket: 'EBAY_IT', channel: 'EBAY', region: 'IT', marketplace: 'IT', title: `${mark} link listing`, price: '9.90', quantity: 1, listingStatus: 'ACTIVE' },
    })
    await db.connectionEvent.create({ data: { connectionId: connection.id, channelKey: 'ebay', type: 'heartbeat.ok', detail: { note: `${mark} heartbeat` } } })
    // T4 — an eBay Priority campaign on that account: an ad group, a keyword with its bid, and the keyword's fees.
    const ebayCampaign = await db.ebayCampaign.create({
      data: { channelConnectionId: connection.id, marketplace: 'EBAY_IT', externalCampaignId: `${mark}-EBAY-CMP`, name: `${mark} eBay campaign`, fundingStrategy: 'COST_PER_CLICK', fundingModel: 'COST_PER_CLICK', status: 'RUNNING', startDate: new Date(), budgetCurrency: 'EUR' } as never,
    })
    const ebayAdGroup = await db.ebayAdGroup.create({ data: { campaignId: ebayCampaign.id, externalAdGroupId: `${mark}-EBAY-AG`, name: `${mark} eBay ad group`, status: 'ACTIVE', defaultBidCents: 3939 } })
    await db.ebayKeyword.create({ data: { campaignId: ebayCampaign.id, adGroupId: ebayAdGroup.id, externalKeywordId: `${mark}-EBAY-KW`, text: `${mark.toLowerCase()} race jacket`, matchType: 'EXACT', bidCents: 4848, status: 'ACTIVE' } })
    await db.ebayAdsDailyPerformance.create({
      data: { marketplace: 'EBAY_IT', fundingModel: 'COST_PER_CLICK', entityType: 'KEYWORD', entityId: `${mark}-EBAY-KW`, date: yesterday, impressions: 222, clicks: 11, adFeesCents: 5252, salesCents: 6363, soldQty: 1, currency: 'EUR', reportedAt: new Date() },
    })
    const traceId = `${mark}-TRACE-1`
    await db.outboundApiCallLog.create({ data: { channel: 'EBAY', operation: `${mark}-getItem`, success: true, latencyMs: 90, traceId } })
    // Integration (P4 + 07 O14): one company row — the name P4 reads and the identity an invoice needs (invented).
    await db.brandSettings.create({ data: { companyName: `${mark} company`, piva: 'IT00000000000', addressLines: ['Via Test 1', '00100 Testborgo'] } as never })
    await db.role.create({ data: { workspaceId, key: `business_${randomUUID()}`, name: `${mark} role`, permissions: [FEATURES.productsView] } })
    // MCP full control P6 — an audit row with money inside its before/after, a queued change, an AI call.
    await db.auditLog.create({
      data: { entityType: 'Product', entityId: product.id, action: 'update', ip: '10.0.0.9', userId: 'u-money',
        before: { name: `${mark} old name`, costPrice: '4242.42' }, after: { name: `${mark} MONEY jacket`, costPrice: '4343.43' } },
    })
    await db.outboundSyncQueue.create({ data: { productId: product.id, targetChannel: 'EBAY', syncType: 'PRICE_UPDATE', syncStatus: 'FAILED', retryCount: 1, payload: { price: 19.9 } } })
    await db.aiUsageLog.create({ data: { provider: 'anthropic', model: 'test-model', feature: `${mark}-feature`, inputTokens: 10, outputTokens: 5, costUSD: '1.2345' } })
    // MCP full control P5 — an attribute, a filed and tagged image, a saved view and an import of the person's.
    const group = await db.attributeGroup.create({ data: { code: `${mark.toLowerCase()}_group`, label: `${mark} group` } })
    const attribute = await db.customAttribute.create({ data: { code: `${mark.toLowerCase()}_attribute`, label: `${mark} attribute`, groupId: group.id, type: 'text' } })
    const folder = await db.assetFolder.create({ data: { name: `${mark} folder` } })
    const tag = await db.tag.create({ data: { name: `${mark} tag` } })
    const asset = await db.digitalAsset.create({ data: { label: `${mark} photo`, sizeBytes: 100, mimeType: 'image/jpeg', storageId: `${mark}-storage`, url: `https://example.test/${mark}.jpg`, folderId: folder.id } })
    await db.assetTag.create({ data: { assetId: asset.id, tagId: tag.id } })
    await db.savedView.create({ data: { userId: 'u-money', surface: 'products', name: `${mark} view`, filters: { search: product.sku } } })
    await db.importJob.create({ data: { jobName: `${mark} import`, fileKind: 'csv', targetEntity: 'product', createdBy: 'u-money' } })
    // MCP full control P7 — a workflow the product is on (draftStage), with a stage to move it to (review).
    const workflow = await db.productWorkflow.create({ data: { code: `${mark.toLowerCase()}_flow`, label: `${mark} flow` } })
    const draftStage = await db.workflowStage.create({ data: { workflowId: workflow.id, code: 'draft', label: `${mark} draft`, sortOrder: 0, isInitial: true } })
    const reviewStage = await db.workflowStage.create({ data: { workflowId: workflow.id, code: 'review', label: `${mark} review`, sortOrder: 1 } })
    await db.product.update({ where: { id: product.id }, data: { workflowStageId: draftStage.id } })
    // MCP full control P8 — an eBay description theme.
    const theme = await db.ebayDescriptionTheme.create({ data: { name: `${mark} theme`, html: '<div>{{description}}</div>' } })
    // MCP full control P8 — a product family and a category (with its closure row) to rename.
    const productFamily = await db.productFamily.create({ data: { code: `${mark.toLowerCase()}_family`, label: `${mark} family` } })
    const category = await db.category.create({ data: { slug: `${mark.toLowerCase()}-category`, name: { en: { name: `${mark} category` }, it: {} } } })
    await db.categoryClosure.create({ data: { ancestorId: category.id, descendantId: category.id, depth: 0 } })
    const pausedRule = await db.automationRule.create({
      data: { domain: 'replenishment', name: `${mark} MONEY paused rule`, trigger: 'recommendation_generated', enabled: false, actions: [{ type: 'log_only' }] },
    })
    // 07 O8 — what the shipping tools act on.
    const shippable = (n: number) => db.order.create({
      data: {
        channel: 'EBAY', channelOrderId: `${mark}-ORDER-SHIP-${n}`, marketplace: 'IT', currencyCode: 'EUR', totalPrice: '0.00', status: 'PROCESSING',
        customerName: `${mark} Buyer`, customerEmail: `${mark.toLowerCase()}.ship@example.test`, fulfillmentMethod: 'MFN',
        shippingAddress: { AddressLine1: 'Via Test 1', City: 'Milano', PostalCode: '20100', CountryCode: 'IT' }, purchaseDate: new Date(),
      } as never,
    })
    const freeOrder = await shippable(1)
    const messageOrder = await db.order.create({
      data: {
        channel: 'SHOPIFY', channelOrderId: `${mark}-ORDER-MSG`, marketplace: 'IT', currencyCode: 'EUR', totalPrice: '0.00', status: 'PROCESSING',
        customerName: `${mark} Buyer`, customerEmail: `${mark.toLowerCase()}.msg@example.test`, shippingAddress: { city: 'Milano' }, purchaseDate: new Date(),
      } as never,
    })
    // 07 O12 — a shipped order (no money: the revenue checks above stay as they are) and an inspected return of it.
    const returnable = await db.order.create({
      data: {
        channel: 'EBAY', channelOrderId: `${mark}-ORDER-RET`, marketplace: 'IT', currencyCode: 'EUR', totalPrice: '0.00', status: 'DELIVERED', fulfillmentMethod: 'MFN',
        customerName: `${mark} Buyer`, customerEmail: `${mark.toLowerCase()}.ret@example.test`, shippingAddress: { city: 'Milano' }, purchaseDate: new Date(),
        items: { create: [{ sku: `${mark}-RET-SKU`, quantity: 2, price: '0.00' }] },
      } as never,
      include: { items: true },
    })
    const inspected = await db.return.create({
      data: { orderId: returnable.id, channel: 'EBAY', marketplace: 'IT', rmaNumber: `${mark}-RMA-2`, status: 'INSPECTING', items: { create: [{ sku: `${mark}-RET-SKU`, quantity: 1, conditionGrade: 'GOOD' }] } } as never,
    })
    // 07 O17 — a MANUAL carrier (pickups) and an eBay account kept inactive (sync-orders-now switches it on for its runs).
    await db.carrier.create({ data: { code: 'MANUAL', name: 'Manual', isActive: true } as never })
    // Integration (O17 × P4): its own seller id — P4's active account is `${mark}-SELLER`, and one active account per seller.
    const syncAccount = await db.channelConnection.create({ data: { channelType: 'EBAY', isActive: false, externalAccountId: `${mark}-SYNC-SELLER` } as never })
    // 07 O13 — an Amazon order delivered 10 days ago (no money: the revenue checks stay as they are).
    const reviewable = await db.order.create({
      data: {
        channel: 'AMAZON', channelOrderId: `${mark}-ORDER-REV`, marketplace: 'IT', currencyCode: 'EUR', totalPrice: '0.00', status: 'DELIVERED', fulfillmentMethod: 'MFN',
        customerName: `${mark} Buyer`, customerEmail: `${mark.toLowerCase()}.rev@example.test`, shippingAddress: { city: 'Milano' }, purchaseDate: new Date(),
        deliveredAt: new Date(Date.now() - 10 * 86_400_000),
      } as never,
    })
    const draftShipment = await db.shipment.create({ data: { orderId: (await shippable(2)).id, carrierCode: 'SENDCLOUD', status: 'DRAFT' } as never })
    const labelled = await db.shipment.create({ data: { orderId: (await shippable(3)).id, carrierCode: 'SENDCLOUD', status: 'LABEL_PRINTED', sendcloudParcelId: `${mark}-PARCEL`, trackingNumber: `${mark}-TRACK-2` } as never })
    // 08 S6 — stock the stock changes act on: two own warehouses, a level, and a count with a counted item.
    const warehouse = await db.stockLocation.create({ data: { type: 'WAREHOUSE', code: `${mark}-WH`, name: `${mark} warehouse` } })
    const second = await db.stockLocation.create({ data: { type: 'WAREHOUSE', code: `${mark}-WH2`, name: `${mark} second warehouse` } })
    await db.stockLevel.create({ data: { productId: product.id, locationId: warehouse.id, quantity: 7, reserved: 0, available: 7 } })
    const count = await db.cycleCount.create({
      data: { locationId: warehouse.id, status: 'IN_PROGRESS', items: { create: [{ productId: product.id, sku: product.sku, expectedQuantity: 7, countedQuantity: 6, status: 'COUNTED' }] } },
    })
    // 08 S12 — a pricing rule, a running promotion and a scheduled price change.
    const pricingRule = await db.pricingRule.create({ data: { name: `${mark} rule`, type: 'MATCH_LOW', priority: 1, parameters: {} } })
    const promotion = await db.retailEvent.create({ data: { name: `${mark} sale`, startDate: new Date(Date.now() - 86_400_000), endDate: new Date(Date.now() + 86_400_000), expectedLift: '1', prepLeadTimeDays: 1 } })
    const scheduled = await db.scheduledProductChange.create({ data: { productId: product.id, kind: 'PRICE', payload: { basePrice: 21 }, scheduledFor: new Date(Date.now() + 86_400_000), status: 'PENDING' } })
    // 08 S9 — a supplier of the product (its price is money) and a DRAFT purchase order of it.
    const supplier = await db.supplier.create({
      data: { name: `${mark} supplier`, email: `${mark.toLowerCase()}.supplier@example.test`, products: { create: [{ productId: product.id, costCents: 3131, moq: 1 }] } },
    })
    const purchaseOrder = await db.purchaseOrder.create({
      data: {
        poNumber: `${mark}-PO-1`, supplierId: supplier.id, status: 'DRAFT', totalCents: 6262, currencyCode: 'EUR',
        items: { create: [{ productId: product.id, sku: product.sku, quantityOrdered: 2, unitCostCents: 3131, lineOrder: 0 }] },
      },
    })
    // 08 S10 — an arrived shipment of the PO into a warehouse of its own (where a receive lands).
    const receiving = await db.warehouse.create({ data: { code: `${mark}-W`, name: `${mark} receiving warehouse` } })
    await db.stockLocation.create({ data: { type: 'WAREHOUSE', code: `${mark}-RECV`, name: `${mark} receiving`, warehouseId: receiving.id } })
    const inboundShipment = await db.inboundShipment.create({
      data: {
        type: 'SUPPLIER', status: 'ARRIVED', reference: `${mark}-RECEIPT`, warehouseId: receiving.id, purchaseOrderId: purchaseOrder.id, shippingCostCents: 4545,
        items: { create: [{ productId: product.id, sku: product.sku, quantityExpected: 5, unitCostCents: 3131, purchaseOrderItemId: (await db.purchaseOrderItem.findFirstOrThrow({ where: { purchaseOrderId: purchaseOrder.id } })).id }] },
      },
    })
    // 08 S13 — the Amazon market an FBA plan goes to, and a plan created at Amazon (its options are read, mocked above).
    await db.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: 'TEST-MKT-IT' } as never })
    const fbaPlan = await db.fbaInboundPlanV2.create({ data: { name: `${mark} FBA plan`, planId: `${mark}-PLAN-1`, status: 'ACTIVE', currentStep: 'LIST_PACKING' } })
    // MCP full control P9 — a finished bulk price job (19.90 is what it wrote and what is stored), so its undo previews.
    const bulkJob = await db.bulkActionJob.create({
      data: { jobName: `${mark} price rise`, actionType: 'PRICING_UPDATE', targetProductIds: [product.id], targetVariationIds: [], actionPayload: {}, status: 'COMPLETED', totalItems: 1, completedAt: new Date('2026-09-30T08:00:00Z') },
    })
    await db.bulkActionItem.create({ data: { jobId: bulkJob.id, productId: product.id, status: 'SUCCEEDED', beforeState: { basePrice: 18 }, afterState: { basePrice: 19.9 } } })
    return {
      pausedRuleId: pausedRule.id,
      productId: product.id, orderId: order.id, approvalId: approval.id, changeId: change.id,
      automationRuleId: automationRule.id, replenishmentRuleId: replenishmentRule.id, shipmentId: shipment.id,
      draftProductId: draftProduct.id, aliasId: alias.id, campaignId: campaign.id,
      publicationId: publication.id, familyId: family.id, variantId: variant.id, variantDraftId: variantDraft.id,
      connectionId: connection.id, traceId,
      ruleId: rule.id, alertEventId: alertEvent.id, assetId: asset.id, stageId: reviewStage.id, themeId: theme.id,
      attributeId: attribute.id, productFamilyId: productFamily.id, categoryId: category.id,
      customerId: customer.id, reviewId: review.id,
      freeOrderId: freeOrder.id, draftShipmentId: draftShipment.id, parcelShipmentId: labelled.id, messageOrderId: messageOrder.id,
      returnId: ret.id, returnableOrderId: returnable.id, returnableLineId: (returnable as unknown as { items: Array<{ id: string }> }).items[0].id, inspectedReturnId: inspected.id,
      reviewableOrderId: reviewable.id,
      syncAccountId: syncAccount.id,
      location: warehouse.code, second: second.code, countId: count.id, pricingRuleId: pricingRule.id, promotionId: promotion.id,
      scheduledId: scheduled.id, supplierId: supplier.id, purchaseOrderId: purchaseOrder.id, inboundShipmentId: inboundShipment.id,
      listingId: listing.id, planId: fbaPlan.id,
      unusedId: unused.id, matrixOpId: matrixOp.id, photoId: photo.id, noAccountListingId: noAccountListing.id,
      ebayCampaignId: ebayCampaign.id,
      sku: product.sku, bulkJobId: bulkJob.id,
    }
  })
}

async function run(who: ToolPrincipal, tool: string, args: Record<string, unknown>) {
  try {
    const call = await callTool(who, tool, args)
    return { raw: call.raw, visible: call.visible, refused: null as ToolAccessError | null }
  } catch (error) {
    if (error instanceof ToolAccessError) return { raw: null, visible: null, refused: error }
    throw error
  }
}

/** Every key anywhere in a value, and every primitive that sits under a money key. */
function walk(value: unknown, restricted: (key: string) => boolean) {
  const keys = new Set<string>()
  const money: string[] = []
  const visit = (v: unknown, underMoney: boolean) => {
    if (v == null) return
    if (typeof v !== 'object' || (v as object).constructor?.name === 'Decimal') {
      if (underMoney) money.push(String(v))
      return
    }
    if (v instanceof Date) return
    for (const [key, child] of Object.entries(v)) {
      keys.add(key)
      visit(child, underMoney || restricted(key))
    }
  }
  visit(value, false)
  return { keys, money }
}

const restrictedFor = (tool: AgentTool) => (key: string) =>
  Object.prototype.hasOwnProperty.call(RESTRICTED_FIELDS, key) ||
  Object.prototype.hasOwnProperty.call(tool.restrictedFields ?? {}, key)

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  const owner = await database.client.userProfile.create({
    data: { email: `${randomUUID()}@example.test`, status: 'active' },
  })
  await database.client.workspace.create({
    data: { id: B, name: 'Bravo money business', createdByUserId: owner.id, creationKey: randomUUID() },
  })
  // I10 — the listing-SKU column, as the eBay import by SKU's migration adds it, so set-listing-sku can preview here.
  await database.db.query(`ALTER TABLE "ProductListingAlias" ADD COLUMN IF NOT EXISTS "sku" TEXT`)
  seeded[A] = await seedBusiness(A, 'ALPHA')
  seeded[B] = await seedBusiness(B, B_MARK)
  // 08 S8 — a third business lends A its warehouse, and holds A's SKU: A may switch that product to the shared stock.
  const LENDER = 'mcp_money_lender'
  let grantId = ''
  await database.client.workspace.create({ data: { id: LENDER, name: 'Money lender', createdByUserId: owner.id, creationKey: randomUUID() } })
  // The database lets an owner of the lender who also owns the borrower offer and accept (stock-pool guards).
  const ownerRole = await database.client.role.create({ data: { key: 'OWNER', name: 'Owner', isSystem: true, permissions: [] } })
  for (const workspaceId of [LENDER, A]) {
    const membership = await database.client.workspaceMembership.create({ data: { workspaceId, userId: owner.id, status: 'active' } })
    await database.client.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: ownerRole.id } })
  }
  const asOwner = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: owner.id, membershipId: null, roleKeys: ['OWNER'] }, work)
  await asOwner(LENDER, async () => {
    const db = database.client
    const warehouse = await db.stockLocation.create({ data: { type: 'WAREHOUSE', code: 'LENDER-WH', name: 'Lender warehouse' } })
    const twin = await db.product.create({ data: { sku: 'ALPHA-MONEY-SKU', name: 'Lent jacket', basePrice: '19.90', totalStock: 5 } })
    await db.stockLevel.create({ data: { productId: twin.id, locationId: warehouse.id, quantity: 5, reserved: 0, available: 5 } })
    grantId = (await (await import('../stock-pool/pool-grants.service.js')).offerGrant({ borrowerWorkspaceId: A, locationIds: [warehouse.id] })).id
  })
  // A grant starts pending; the borrower accepts it.
  await asOwner(A, async () => (await import('../stock-pool/pool-grants.service.js')).borrowerDecision(grantId, 'accept', { expectedVersion: 1 }))
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('MCP.2 — coverage', () => {
  it('every registered tool is exercised here or is an AI draft', () => {
    const missing = listTools()
      .map((tool) => tool.name)
      .filter((name) => !ARGS[name] && !AI_DRAFTS.has(name))
    expect(missing).toEqual([])
  })
})

describe('MCP.2 — money a person may not see never comes back', () => {
  // C7 — confirm-change is Claude's door only and returns its own arguments: no stored money to filter. W4-1 —
  // report-ads-run is Claude's door only too; it needs the ad-spend money permission (ads-manager.tools.vitest.test.ts).
  const tools = () => listTools().filter((tool) => !AI_DRAFTS.has(tool.name) && tool.name !== 'confirm-change' && tool.name !== 'report-ads-run')

  it('the money-cleared run really reads the seeded money (positive control)', async () => {
    const analytics = await run(cleared(A), 'product-analytics', ARGS['product-analytics'](seeded[A]))
    expect(analytics.visible?.data).toMatchObject({ unitsSold: 3, revenueByCurrency: { EUR: 3000.03 } })
    const insights = await run(cleared(A), 'insights-metric', ARGS['insights-metric'](seeded[A]))
    expect(insights.visible?.data).toMatchObject({ revenueByCurrency: { EUR: 3007.8 } })
  })

  it('for every tool: the same answer minus exactly the money', async () => {
    const problems: string[] = []
    for (const tool of tools()) {
      const args = ARGS[tool.name](seeded[A])
      const full = await withEnv(tool.name, () => run(cleared(A), tool.name, args))
      const partial = await withEnv(tool.name, () => run(operator(A), tool.name, args))
      if (full.refused) {
        problems.push(`${tool.name}: refused a fully cleared person (${full.refused.message})`)
        continue
      }
      const needsMoney = tool.requires.some((permission) => permission.startsWith('financials.'))
      // A tool that returned nothing proves nothing: each one must read the seeded rows. The ads
      // tools need ads data this seed does not have; they are covered by the refusal below.
      if (!needsMoney && !LIVE_READS.has(tool.name) && !full.raw?.ok && !REFUSED_WITHOUT_A_CHANNEL[tool.name] && !NEEDS_CHANNEL.has(tool.name)) problems.push(`${tool.name}: read nothing (${full.raw?.error})`)
      if (needsMoney) {
        // A tool that cannot be judged without money refuses the person outright.
        if (partial.refused?.code !== 'forbidden') problems.push(`${tool.name}: ran for a person without money`)
        continue
      }
      if (partial.refused) {
        problems.push(`${tool.name}: refused (${partial.refused.message})`)
        continue
      }
      const restricted = restrictedFor(tool)
      const seen = walk(partial.visible, restricted)
      const leakedKeys = [...seen.keys].filter(restricted)
      if (leakedKeys.length) problems.push(`${tool.name}: returned ${leakedKeys.join(', ')}`)
      const text = JSON.stringify(partial.visible)
      const leakedValues = walk(full.visible, restricted).money.filter((v) => v.length >= 4 && text.includes(v))
      if (leakedValues.length) problems.push(`${tool.name}: returned money value ${leakedValues.join(', ')}`)
      // Nothing else changed: the partial answer is the full one with money keys removed.
      const stripped = JSON.parse(
        JSON.stringify(full.visible, (key, value) => (key && restricted(key) ? undefined : value)),
      )
      if (JSON.stringify(stripped) !== text) problems.push(`${tool.name}: differs beyond the money`)
    }
    expect(problems).toEqual([])
  })

  it('a revenue grant reveals revenue, and only revenue', async () => {
    const revenueOnly = principal(A, [...EVERY_ACTION, FIELDS.financialsRevenueView])
    const out = await run(revenueOnly, 'product-analytics', ARGS['product-analytics'](seeded[A]))
    expect(out.visible?.data).toMatchObject({ revenueByCurrency: { EUR: 3000.03 } })
    const operatorOut = await run(operator(A), 'product-analytics', ARGS['product-analytics'](seeded[A]))
    expect(operatorOut.visible?.data).not.toHaveProperty('revenueByCurrency')
    expect(operatorOut.visible?.data).toMatchObject({ unitsSold: 3 })
  })
})

describe('MCP.2 — a tool reads only the business it runs in', () => {
  it('the other business’s rows are real and findable from inside it (positive control)', async () => {
    const out = await run(operator(B), 'product-search', ARGS['product-search'](seeded[B]))
    expect(JSON.stringify(out.visible)).toContain(B_MARK)
  })

  it('for every tool: business A never returns a row of business B', async () => {
    const leaks: string[] = []
    for (const tool of listTools().filter((t) => !AI_DRAFTS.has(t.name))) {
      // Handed its own ids, and handed business B's ids.
      for (const ids of [seeded[A], seeded[B]]) {
        const out = await run(cleared(A), tool.name, ARGS[tool.name](ids))
        const result: ToolResult | null = out.raw
        if (JSON.stringify(result ?? {}).includes(B_MARK)) leaks.push(`${tool.name} (${ids === seeded[B] ? "B's ids" : 'own ids'})`)
      }
    }
    expect(leaks).toEqual([])
  })

  it('business B’s ids are simply not found from business A', async () => {
    const out = await run(cleared(A), 'order-detail', ARGS['order-detail'](seeded[B]))
    expect(out.raw).toEqual({ ok: false, error: 'Order not found' })
  })
})

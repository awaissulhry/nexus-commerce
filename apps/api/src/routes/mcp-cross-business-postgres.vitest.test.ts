/**
 * MCP.8 — Claude's connection for one business never reaches another, proven on a REAL PostgreSQL: the throwaway
 * PostgreSQL 17 of scripts/run-real-postgres-tests.mjs with the production schema and row-level policies, the app
 * connected as the restricted runtime login (NOBYPASSRLS), so the database holds the line as it does in production.
 * The /mcp route runs in a Fastify app with the API's own global hooks, next to the Approvals, Connected apps and
 * Team & Access routes; tokens come from the real OAuth server functions; Claude's side is the MCP SDK client.
 *
 * Two businesses, A and B. One person belongs to BOTH (the hard case: their membership in B is real, only the
 * token says A); another belongs to B only. Every B row a tool can read carries a canary string.
 *
 *   1. every tool A's token is offered, handed B's ids: not found, empty or refused — and the same arguments run
 *      inside B DO reach B's rows, so the refusal is the business boundary and not a bad argument; every change
 *      tool answers "not found" and queues nothing, and no row of B changes
 *   2. naming B by header or query: 400, and nothing ran
 *   3. the person removed from A: the very next call is 401
 *   4. the person's role in A loses products.price.edit: set-price leaves the next tools/list and is refused
 *   5. a revoked connection: 401 on the next call; B's admin can neither see nor end A's connection
 *   6. no B canary in any answer given outside B, in any log line, or in any AgentRun / AgentApproval row
 *      written outside B; every run is filed under its connection's business
 *   7. an approval queued in A is "not found" to a B-only connection and to a B session in the Approvals routes
 *   8. a tool policy one business sets (a tool turned off) never applies in the other, cache included
 *   9. C4 — each business's own MCP URL takes only that business's token; three SKUs both businesses sell resolve,
 *      at A's URL, to A's rows alone (a read, a change by id, a bulk change by SKU), and B is unchanged
 *  10. C5 — a trust level (auto) and a Pause one business sets never apply in the other; C8 — nor its activity list
 *  11. a channel account one business shares with the other is named to that business, by its owner, and to no one
 *      once the share is revoked (MCP full control P4)
 *
 * Business profiles are ON for the whole file, as production runs: with them off there is one business and
 * nothing to keep apart. The runner leaves NEXUS_WORKSPACES_ENABLED unset (vitest.setup.ts then sets 0), so the
 * file pins it, like the other real-PostgreSQL suites. The tests run in order: 4 and 3 take the person's access
 * away, and 6 reads what every test before it wrote.
 *
 * A tool added tomorrow is covered on the day: the loop takes the tools from tools/list and builds each one's
 * arguments from its own input schema. A tool it cannot build, or whose arguments reach nothing even inside B,
 * fails by name until it gets an entry in B_VALUES, B_FORMS or EXTRA.
 */
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import compress from '@fastify/compress'
import cookie from '@fastify/cookie'
import { generateSecret, generateSync } from 'otplib'
import { z } from 'zod'
import { ALL_PERMISSIONS, FEATURES } from '@nexus/shared/permissions'
import { concurrentDatabase, concurrentDatabaseUrl } from '../test-support/concurrent-database.js'
import { withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => Reflect.get(database.client, key) }) }))
// T11 — a live channel read never leaves this machine (no channel login opens here, and no test may reach a marketplace).
vi.mock('../services/live-read/index.js', () => ({
  readLiveListing: async () => { throw new Error('No live channel read in this suite.') },
  publicLiveRead: (read: Record<string, unknown>) => read,
}))

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { csrfCookieName, sessionCookieName } from '../lib/auth/cookies.js'
import { financialFilterHook } from '../lib/auth/field-filter.js'
import { rbacHook } from '../lib/auth/rbac-hook.js'
import { createSession } from '../lib/auth/session.js'
import { __stepUpTest } from '../lib/auth/step-up.js'
import { generateToken } from '../lib/auth/tokens.js'
import { workspaceHook } from '../lib/workspace-hook.js'
import { offeredOn } from '../services/agents/call-tool.js'
import { listTools } from '../services/agents/tool-registry.js'
import type { AgentTool } from '../services/agents/tool-types.js'
import { __toolRateTest } from '../services/agents/tool-rate.js'
import { __mcpRateTest } from '../services/mcp/mcp-rate.js'
import { registerClient } from '../services/oauth/oauth-clients.js'
import { consent, exchangeCode } from '../services/oauth/oauth-server.js'
import { logger } from '../utils/logger.js'
import agentFleetApprovalRoutes from './agent-fleet-approvals.routes.js'
import agentFleetRoutes from './agent-fleet.routes.js'
import agentRoutes from './agents.routes.js'
import claudeControlRoutes from './claude-control.routes.js'
import mcpRoutes from './mcp.routes.js'
import oauthGrantsRoutes from './oauth-grants.routes.js'
import workspacesRoutes from './workspaces.routes.js'

const RUN = randomBytes(6).toString('hex')
const A = `mcp8_alpha_${RUN}`
const B = `mcp8_bravo_${RUN}`
/** In every B row a tool could return. Upper case: the scans compare upper-cased text (emails are lower case). */
const B_CANARY = `CANARY-B-${RUN.toUpperCase()}`
const A_CANARY = `CANARY-A-${RUN.toUpperCase()}`
const API = 'https://api.example.test'
const WEB = 'https://web.example.test'
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback'
const CSRF = 'mcp8-csrf'
const FAILED = 'could not run this tool'

// ── Two businesses, seeded alike ──────────────────────────────────────────────────────────────────────

interface Seeded {
  sku: string
  market: string
  productId: string
  orderId: string
  listingId: string
  approvalId: string
  /** B only: an approval the B session may reject, the control of test 7. */
  spareApprovalId: string
  targetId: string
  campaignId: string
  adGroupId: string
  externalCampaignId: string
  externalAdGroupId: string
  /** A13 — the business's eBay campaign (on its own eBay account). */
  ebayCampaignId: string
  /** A14 — an ad group of that campaign, and the eBay item id of the business's eBay listing. */
  ebayAdGroupId: string
  ebayItemId: string
  /** A10 — a recorded ad write and the change set it belongs to (what undo-ad-change puts back). */
  actionLogId: string
  changeSetId: string
  /** W3-2 — an ad write still waiting in its grace window (what cancel-queued-ad-write cancels). */
  outboundQueueId: string
  /** PB-5a — a playbook build of the business's campaign (what archive-ads buildRunId and ads-playbook view build name). */
  buildRunId: string
  /** Every value that names one of the business's rows. None may reach the other business. */
  keys: string[]
  /** The AgentRun and AgentApproval rows written before the suite. */
  agentRows: string[]
  /** C2 — a change that ran (what undo-change reads). */
  changeId: string
  /** R6–R8 — an ads rule, the row the automation tools open by `rowId`. */
  automationRuleId: string
  /** 07 O5 — a shipment of a shipped order. */
  shipmentId: string
  /** 07 O6 — a customer record. */
  customerId: string
  /** 08 S3 — a stock count (what cycle-counts reads by id). */
  countId: string
  /** 08 S6 — two own warehouses (by code) and a hold. */
  warehouseCode: string
  secondWarehouseCode: string
  holdId: string
  /** 08 S12 — a pricing rule, a sale event and a scheduled price change (integration: `ruleId` is P7's alert rule;
   *  set-pricing-rule gets this one through EXTRA). */
  pricingRuleId: string
  promotionId: string
  scheduledChangeId: string
  /** 08 S4 — a supplier, a purchase order and an inbound shipment. */
  supplierId: string
  purchaseOrderId: string
  /** 08 S4 — the inbound shipment (integration: `shipmentId` is 07's outbound shipment; inbound-shipments gets this one through EXTRA). */
  inboundShipmentId: string
  /** Section 03 + L2 — the business's own eBay account, the one its listing is on (set-listing-content names a listing
   *  by its account; the Matrix lists a market only on a connected channel). Integration: one account for 03, L2 and A13. */
  accountId: string
  /** I10 — an extra listing (what set-listing-sku names). */
  aliasId: string
  /** I11 — a parent product (what fix-parent attaches to, and what a merge keeps). */
  parentProductId: string
  /** L3 — a publication with its stored result (what publication-status reads). */
  publicationId: string
  /** P4 — the business's own channel account, and the trace of one channel call. */
  connectionId: string
  traceId: string
  /** P5 — an image folder and tag, a saved view, an import job. */
  folderId: string
  tagId: string
  savedViewId: string
  jobId: string
  /** P7 — an alert rule, its event, a notification, an unfiled image, the workflow stage the product can move to. */
  ruleId: string
  alertEventId: string
  notificationId: string
  assetId: string
  stageId: string
  /** P8 — an older mapping revision, a description theme, a listing preset. */
  restoreRevisionId: string
  themeId: string
  presetId: string
  /** P8 — an attribute with an option in a group; a family and a parent family; a category and a top category. */
  attributeId: string
  optionId: string
  groupId: string
  familyId: string
  parentFamilyId: string
  categoryId: string
  parentCategoryId: string
  /** R11 — a suggestion of that rule. */
  suggestionId: string
  /** R14 — a budget pool, the row tune-ad-engine tunes by `subjectId` (W4-7: and set-budget-pool by `poolId`). */
  budgetPoolId: string
  /** W4-7 — a budget schedule of its campaign, the row set-budget-schedule changes by `scheduleId`. */
  budgetScheduleId: string
  /** R15 — a fleet assignment, what steer-fleet runs or cancels by `assignmentId`. */
  assignmentId: string
  /** R17 — a repricing rule of the business's product, what save-price-rule edits by `priceRuleId`. */
  priceRuleId: string
  /** R18 — a listing rule, what save-ops-rule edits by `opsRuleId` (its first domain). */
  opsRuleId: string
  /** 07 O6 — a review of the product. */
  reviewId: string
  /** 07 O7 — a note on the order and one on the customer. */
  orderNoteId: string
  customerNoteId: string
  /** 07 O8 — the return, and a shipping warehouse (Warehouse; 08's `warehouse` is a stock location). */
  returnId: string
  warehouseId: string
  /** 07 O12 — the order's line (what create-return names). */
  orderItemId: string
  /** 07 O14 — a POSTED refund of the return (what issue-fiscal-document credits). */
  refundId: string
  /** 08 S13 — an FBA inbound plan (not created at Amazon: no live read is ever made). */
  planId: string
  /** L8 — a Matrix operation that can still be reverted (what revert-listing-change reads). */
  matrixOpId: string
  /** L11 — a photo of the product nothing uses (what remove-unused-photo removes). */
  photoId: string
  /** P9 — a column mapping the person saved for catalog imports (import-catalog's savedMappingId). */
  sourcePresetId: string
  /** W4-1 — a daily Claude ads run that started and has not reported its end (report-ads-run finishes it). */
  adsRunId: string
}
const seeded = {} as Record<'a' | 'b', Seeded>
/** Phase 3 T3 — the eBay category id each business has loaded (its details name the business's canary). */
const MCP8_EBAY_CATEGORY = '177104'
const inside = <T>(workspaceId: string, work: () => Promise<T>) =>
  withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)

async function seedBusiness(workspaceId: string, mark: 'ALPHA' | 'BRAVO', canary: string): Promise<Seeded> {
  const db = database.client
  const sku = `${mark}-${RUN.toUpperCase()}`
  // Not a real marketplace code: a value only this business's rows carry, so a market in an answer is traceable.
  const market = `Z${mark[0]}${RUN.slice(0, 6).toUpperCase()}`
  return inside(workspaceId, async () => {
    // The market this business sells on, as a Marketplace row: the product writer checks a change against it.
    await db.marketplace.create({
      data: {
        channel: 'EBAY', code: market, name: `eBay ${market}`, region: 'EU', currency: 'EUR', language: 'it', languages: ['it'], marketplaceId: `TEST_EBAY_${market}`,
        // P5 — one mapping rule, what channel-mappings shows for this market.
        schemaMapping: { version: 1, fields: { title: { source: 'name', notes: `${canary}-MAPPING` } } },
      },
    })
    // Phase 3 T3 — the business's loaded details of one eBay category on its market (what "Load eBay fields" stores),
    // named with the canary: ebay-categories reads them from the cache, never from eBay.
    await db.categorySchema.create({
      data: {
        channel: 'EBAY', marketplace: market, productType: MCP8_EBAY_CATEGORY, schemaVersion: `${mark}-${RUN}`, expiresAt: new Date(Date.now() + 86_400_000),
        schemaDefinition: { aspects: [{ id: 'aspect_Lining', label: `${canary}-ASPECT`, localizedName: `${canary}-ASPECT`, options: [], required: true }], conditions: [{ value: 'NEW', label: 'New' }] },
      },
    })
    // O3 — the business's identity for buyers (Settings → Company): a buyer-facing tool refuses a business without one.
    await db.brandSettings.create({
      data: { companyName: `${canary}-COMPANY`, contactEmail: `${mark.toLowerCase()}-shop@example.test`, addressLines: ['Via Test 1', '00000 Testville'] },
    })
    // L2 — the business's own eBay account, named with the canary: no answer outside the business may name it.
    // One active account per channel and seller across the database: each business has its own seller id.
    const account = await db.channelConnection.create({
      data: { channelType: 'EBAY', managedBy: 'oauth', isActive: true, accountLabel: `${canary}-ACCOUNT`, authStatus: 'connected', externalAccountId: `${mark}-SELLER-${RUN}` },
    })
    // A11 — and on Amazon, with a spend ceiling: create-ad-campaign plans a campaign only in a market that has one.
    await db.marketplace.create({
      data: { channel: 'AMAZON', code: market, name: `Amazon ${market}`, region: 'EU', currency: 'EUR', language: 'it', languages: ['it'], marketplaceId: `TEST_AMAZON_${market}` },
    })
    await db.adSpendCeiling.create({ data: { grain: 'MARKET', scopeId: market, label: `the ${market} market`, dailyCapCents: 5000 } })
    const product = await db.product.create({
      data: {
        sku,
        name: `${canary}-PRODUCT`,
        brand: `${canary}-BRAND`,
        description: `${canary}-DESCRIPTION`,
        bulletPoints: [`${canary}-BULLET`],
        keywords: [`${canary}-KEYWORD`],
        categoryAttributes: { lining_note: `${canary}-LINING` },
        basePrice: '19.90',
        costPrice: '4.20',
        totalStock: 7,
      },
    })
    const order = await db.order.create({
      data: {
        channel: 'EBAY',
        channelOrderId: `${mark}-ORDER-${RUN}`,
        marketplace: market,
        currencyCode: 'EUR',
        totalPrice: '20.00',
        customerName: `${canary}-BUYER`,
        customerEmail: `${canary.toLowerCase()}-buyer@example.test`,
        shippingAddress: { city: `${canary}-CITY` },
        purchaseDate: new Date(),
        items: { create: [{ sku, productId: product.id, quantity: 2, price: '10.00' }] },
      },
      include: { items: true },
    })
    // 07 O5 — a shipped order and its shipment, with a tracking event (the fulfilment reads).
    const shippedOrder = await db.order.create({
      data: {
        channel: 'EBAY',
        channelOrderId: `${mark}-SHIPPED-${RUN}`,
        marketplace: market,
        status: 'SHIPPED',
        currencyCode: 'EUR',
        totalPrice: '5.00',
        customerName: `${canary}-SHIP-BUYER`,
        customerEmail: `${canary.toLowerCase()}-ship@example.test`,
        shippingAddress: { city: `${canary}-CITY` },
        purchaseDate: new Date(),
      },
    })
    const shipment = await db.shipment.create({
      data: { orderId: shippedOrder.id, carrierCode: 'MANUAL', status: 'SHIPPED', trackingNumber: `${mark}-TRACK-${RUN}` },
    })
    await db.trackingEvent.create({
      data: { shipmentId: shipment.id, occurredAt: new Date(), code: 'IN_TRANSIT', description: `${canary}-TRACKING`, source: 'MANUAL' },
    })
    // 07 O6 — the after-sale reads: a customer, a return of the order, a review of the product.
    const customer = await db.customer.create({
      data: { id: `${mark.toLowerCase()}-customer-${RUN}`, email: `${canary.toLowerCase()}-customer@example.test`, name: `${canary}-CUSTOMER`, totalOrders: 1, lastOrderAt: new Date() },
    })
    const ret = await db.return.create({
      data: { orderId: order.id, channel: 'EBAY', marketplace: market, rmaNumber: `${mark}-RMA-${RUN}`, reason: `${canary}-RETURN-REASON` },
    })
    const refund = await db.refund.create({ data: { returnId: ret.id, amountCents: 500, channel: 'EBAY', channelStatus: 'POSTED' } })
    // 07 O8 — a shipping warehouse (Warehouse); 08's `warehouse` below is a stock location.
    const shipWarehouse = await db.warehouse.create({ data: { code: `${mark}-WH-${RUN}`, name: `${canary}-WAREHOUSE` } })
    const orderNote = await db.orderNote.create({ data: { orderId: order.id, body: `${canary}-ORDER-NOTE` } })
    const customerNote = await db.customerNote.create({ data: { customerId: customer.id, body: `${canary}-CUSTOMER-NOTE` } })
    const productReview = await db.review.create({
      data: {
        channel: 'EBAY', marketplace: market, externalReviewId: `${mark}-REVIEW-${RUN}`, productId: product.id, sku, rating: 2,
        body: `${canary}-REVIEW-BODY`, authorName: `${canary}-REVIEWER`, postedAt: new Date(),
      },
    })
    // Section 03 — the listing is on the business's eBay account (`account`, seeded above for L2): a coordinate names it.
    const listing = await db.channelListing.create({
      data: {
        productId: product.id,
        channelConnectionId: account.id,
        channelMarket: 'EBAY_IT',
        channel: 'EBAY',
        region: 'IT',
        marketplace: market,
        title: `${canary}-LISTING-TITLE`,
        price: '21.50',
        quantity: 5,
        listingStatus: 'ACTIVE',
        isPublished: true,
        externalListingId: `${mark}-ITEM-${RUN}`,
      },
    })
    await db.listingIssue.create({
      data: {
        listingId: listing.id,
        code: 'CODE-1',
        severity: 'ERROR',
        message: `${canary}-ISSUE-MESSAGE`,
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
        marketplace: market,
        driftCount: 2,
        driftedFields: [
          { field: 'quantity', ours: 5, theirs: 4, source: 'ebay-trading-getitem', checkedAt },
          { field: 'title', ours: `${canary}-DRIFT-OURS`, theirs: `${canary}-DRIFT-THEIRS`, source: 'ebay-trading-getitem', checkedAt },
        ],
        lastCheckedAt: new Date(checkedAt),
        checkedBySource: { 'ebay-trading-getitem': { at: checkedAt, outcome: 'compared', differing: 2 } },
      },
    })
    await db.channelStockEvent.create({
      data: { channel: 'EBAY', channelEventId: `${mark}-EVT-${RUN}`, sku, productId: product.id, channelReportedQty: 4, localQtyAtObservation: 7, drift: -3 },
    })
    await db.replenishmentRecommendation.create({
      data: {
        productId: product.id,
        sku,
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
      data: { name: `${canary}-ALERT-RULE`, metric: 'queueDepth', operator: 'gt', threshold: 100, notificationChannels: [] },
    })
    const alertEvent = await db.alertEvent.create({ data: { ruleId: rule.id, value: 250 } })
    // A2 — the campaign sells in the business's own (traceable) market, so a market filter aims at it too.
    const campaign = await db.campaign.create({
      data: { name: `${canary}-CAMPAIGN`, type: 'SP', dailyBudget: '10.00', startDate: new Date(), marketplace: market, externalCampaignId: `${mark}-CMP-${RUN}` },
    })
    const adGroup = await db.adGroup.create({
      data: { campaignId: campaign.id, name: `${canary}-ADGROUP`, externalAdGroupId: `${mark}-AG-${RUN}` },
    })
    const target = await db.adTarget.create({
      data: { adGroupId: adGroup.id, kind: 'KEYWORD', expressionType: 'BROAD', expressionValue: `${canary}-TARGET`, isNegative: false, bidCents: 40 },
    })
    // R6–R8 — an ads rule: what the automation tools (list, detail, activity, preview) read and name.
    const automationRule = await db.automationRule.create({
      data: { domain: 'advertising', name: `${canary}-AUTOMATION-RULE`, trigger: 'SCHEDULE', enabled: true, autonomyLevel: 'OBSERVE', actions: [{ type: 'log_only' }] },
    })
    // MCP full control T4 — the business's writing rules on its market: a glossary row and a brand voice.
    await db.terminologyPreference.create({
      data: { brand: null, marketplace: market, language: 'it', preferred: `${canary}-PREFERRED`, avoid: [`${canary}-AVOID`], context: `${canary}-CONTEXT` },
    })
    await db.brandVoice.create({ data: { marketplace: market, body: `${canary}-VOICE`, notes: `${canary}-VOICE-MEMO` } })
    // T9 — the readiness Nexus recorded for the listing's coordinate: a required field missing.
    await db.readinessIndex.create({
      data: {
        productId: product.id, channel: 'EBAY', market, accountId: null, aliasId: null, coordinateKey: JSON.stringify(['EBAY', market, null, null]),
        language: 'it', label: `eBay · ${market}`, pct: 0, state: 'blocked', requiredFilled: 0, requiredTotal: 1, computedAt: new Date(),
        missing: [{ productId: product.id, field: 'lining_note', label: `${canary}-REQUIRED-FIELD`, reason: 'Required and empty', requiredEmpty: true }],
      },
    })
    // A2 — what the ad reads read: a day of spend, a wasteful search term, a bid change and a rule's pending suggestion.
    const yesterday = new Date(Date.now() - 86_400_000)
    await db.amazonAdsDailyPerformance.create({
      data: {
        profileId: `P-${mark}`, marketplace: market, adProduct: 'SPONSORED_PRODUCTS', date: yesterday, entityType: 'CAMPAIGN',
        entityId: campaign.externalCampaignId!, localEntityId: campaign.id, impressions: 100, clicks: 9, costMicros: 15_000_000n,
        currencyCode: 'EUR', sales7dCents: 4000, orders7d: 1, reportedAt: new Date(),
      },
    })
    await db.amazonAdsSearchTerm.create({
      data: {
        profileId: `P-${mark}`, marketplace: market, adProduct: 'SPONSORED_PRODUCTS', date: yesterday, campaignId: campaign.externalCampaignId!,
        adGroupId: adGroup.externalAdGroupId!, query: `${canary.toLowerCase()}-term`, impressions: 300, clicks: 20, costMicros: 20_000_000n,
        currencyCode: 'EUR', orders7d: 0, sales7dCents: 0,
      },
    })
    await db.campaignBidHistory.create({
      data: { entityType: 'AD_TARGET', entityId: target.id, campaignId: campaign.id, field: 'bid', oldValue: '35', newValue: '40', changedBy: 'user:mcp8', reason: `${canary}-WHY` },
    })
    const changeSetId = `${mark}-SET-${RUN}`
    const actionLog = await db.advertisingActionLog.create({
      data: {
        executionId: changeSetId, userId: 'user:mcp8', actionType: 'AD_BID_UPDATE', entityType: 'AD_TARGET', entityId: target.id,
        payloadBefore: { bidCents: 35, status: 'ENABLED' }, payloadAfter: { bidCents: 40, status: 'ENABLED' }, amazonResponseStatus: 'PENDING',
      },
    })
    // W3-2 — a bid write Nexus queued and has not sent (its window is a day long here, so it stays cancellable).
    const queuedWrite = await db.outboundSyncQueue.create({
      data: {
        targetChannel: 'AMAZON', targetRegion: market, syncStatus: 'PENDING', syncType: 'AD_BID_UPDATE', holdUntil: new Date(Date.now() + 86_400_000),
        payload: { entityType: 'AD_TARGET', entityId: target.id, marketplace: market, fieldChanges: [{ field: 'bid', oldValue: '40', newValue: '45' }], actor: 'user:mcp8' },
      },
    })
    await db.adMutation.create({
      data: { entityType: 'AD_TARGET', entityId: target.id, marketplace: market, field: 'bid', previousValue: '40', intendedValue: '45', actor: 'user:mcp8', holdUntil: queuedWrite.holdUntil, outboundQueueId: queuedWrite.id, idempotencyKey: `${queuedWrite.id}:bid` },
    })
    // PB-5a — a playbook build that made the business's campaign.
    const buildRun = await db.adBlueprintApplication.create({
      data: { productToken: `${canary}-TOKEN`, marketplace: market, status: 'APPLIED', plan: {}, playbookId: `${mark}-PLAYBOOK-${RUN}`, createdCampaignIds: [campaign.id] },
    })
    await db.adsRuleSuggestion.create({
      data: {
        ruleId: `rule-${mark}-${RUN}`, ruleName: `${canary}-RULE`, entityType: 'CAMPAIGN', entityId: campaign.id, entityName: `${canary}-CAMPAIGN`,
        marketplace: market, proposedAction: { type: 'bid_down', value: 30 }, proposedKey: 'bid_down:30',
      },
    })
    // A13 — an eBay Promoted Listings campaign on the business's own eBay account, with a day of fees.
    // Integration: the business's one eBay account (seeded above for L2) — a second active account with the same seller id
    // would break the database-wide one-active-account key.
    const ebayAccount = account
    const ebayCampaign = await db.ebayCampaign.create({
      data: {
        channelConnectionId: ebayAccount.id, marketplace: market, externalCampaignId: `${mark}-EBAY-CMP-${RUN}`, name: `${canary}-EBAY-CAMPAIGN`,
        fundingStrategy: 'COST_PER_SALE', fundingModel: 'COST_PER_SALE', status: 'RUNNING', startDate: new Date(),
      },
    })
    // A14 — one of its ad groups (the eBay keyword tools name it).
    const ebayAdGroup = await db.ebayAdGroup.create({
      data: { campaignId: ebayCampaign.id, externalAdGroupId: `${mark}-EBAY-AG-${RUN}`, name: `${canary}-EBAY-ADGROUP`, status: 'ACTIVE' },
    })
    await db.ebayAdsDailyPerformance.create({
      data: {
        marketplace: market, fundingModel: 'COST_PER_SALE', entityType: 'CAMPAIGN', entityId: ebayCampaign.externalCampaignId, date: yesterday,
        impressions: 120, clicks: 6, adFeesCents: 300, salesCents: 5000, soldQty: 1, currency: 'EUR', reportedAt: new Date(),
      },
    })
    // R11 — a suggestion of that rule: what decide-automation-suggestions decides.
    const suggestion = await db.adsRuleSuggestion.create({
      data: { ruleId: automationRule.id, ruleName: `${canary}-AUTOMATION-RULE`, entityType: 'CAMPAIGN', entityId: campaign.id, entityName: `${canary}-SUGGESTION`, proposedAction: { type: 'bid_down', percent: 5 }, proposedKey: `${mark}-SUGGESTION` },
    })
    // Ads autonomy W3-1 — a muted recommendation of its campaign: what mute-ad-recommendations unmutes.
    await db.adsSuggestionMute.create({ data: { scope: 'recommendations', entityType: 'RECOMMENDATION', entityId: `budget:${campaign.id}`, entityName: `${canary}-MUTED-RECOMMENDATION`, createdBy: 'user:mcp8' } })
    // R14 — a budget pool: what tune-ad-engine tunes.
    const budgetPool = await db.budgetPool.create({ data: { name: `${canary}-BUDGET-POOL`, totalDailyBudgetCents: 5000 } })
    // W4-7 — a budget schedule of its campaign, switched off: what set-budget-schedule changes.
    const budgetSchedule = await db.budgetSchedule.create({
      data: { name: `${canary}-BUDGET-SCHEDULE`, kind: 'BUDGET', type: 'campaign-budget', enabled: false, campaigns: [{ id: campaign.id, name: `${canary}-CAMPAIGN`, dailyBudget: 20 }], windows: [{ day: 1, start: '08:00', end: '12:00', adj: 'decPct', value: 10 }] },
    })
    // R15 — an assignment of a fleet worker: what steer-fleet runs or cancels.
    const assignment = await db.agentAssignment.create({ data: { charterKey: 'amazon-bid-tuner', title: `${canary}-ASSIGNMENT` } })
    // R17 — a repricing rule on the business's own market: what save-price-rule edits.
    const priceRule = await db.repricingRule.create({ data: { productId: product.id, channel: 'EBAY', marketplace: market, minPrice: 10, maxPrice: 20, strategy: 'manual', enabled: false } })
    // R18 — a listing rule: what save-ops-rule edits.
    const opsRule = await db.automationRule.create({ data: { domain: 'listings', name: `${canary}-OPS-RULE`, trigger: 'inventory_low', conditions: [{ field: 'inventory.available', op: 'lt', value: 3 }], actions: [{ type: 'notify' }], maxExecutionsPerDay: 5 } })
    // The eBay change log and a rule's pending proposal (ad-changes / ad-recommendations with channel ebay).
    await db.campaignAction.create({
      data: { channel: 'EBAY', entityType: 'CAMPAIGN', entityId: ebayCampaign.externalCampaignId, actionType: 'set_ad_rate', userId: 'user:mcp8', payloadBefore: { bidPercentage: 5 }, payloadAfter: { bidPercentage: 6, _mode: 'sandbox' }, channelResponseStatus: 'SUCCESS' },
    })
    await db.ebayAdsProposal.create({
      data: { kind: 'adjust_ad_rate', entityRef: { campaignId: ebayCampaign.id, externalCampaignId: ebayCampaign.externalCampaignId, campaignName: `${canary}-EBAY-CAMPAIGN`, marketplace: market }, proposedAction: { field: 'bidPercentage', from: 6, to: 5 }, proposedKey: `adjust_ad_rate:${ebayCampaign.id}:${RUN}` },
    })
    const run = await db.agentRun.create({ data: { agentKey: 'manual-action', trigger: 'manual', status: 'done', input: { note: `${canary}-RUN` } } })
    // W4-1 — the business's daily Claude ads run, started (report-ads-run's record; ads-manager-runs lists it).
    const adsRun = await db.agentRun.create({
      data: { agentKey: 'claude-ads-manager', trigger: 'schedule', status: 'running', input: { v: 1, note: `${canary}-ADS-RUN`, start: { mode: 'ask', markets: [{ market, strategyVersion: null }] } } },
    })
    const approval = (note: string) =>
      db.agentApproval.create({
        data: {
          agentRunId: run.id,
          toolName: 'apply-content',
          riskTier: 'medium',
          args: { productId: product.id, title: `${canary}-${note}-TITLE` },
          preview: { action: 'apply-content', changes: { title: { from: product.name, to: `${canary}-${note}-TITLE` } } },
          reason: `${canary}-${note}-NOTE`,
          status: 'pending',
        },
      })
    const first = await approval('APPROVAL')
    const spare = await approval('SPARE')
    // C2 — a set-price that ran: 19.90 is what it wrote and what is stored, so undo-change may undo it (in B only).
    const change = await db.agentChange.create({
      data: {
        approvalId: first.id,
        toolName: 'set-price',
        via: 'claude',
        reversibility: 'full',
        before: { productId: product.id, sku, price: 18 },
        after: { productId: product.id, price: 19.9 },
      },
    })
    // 08 S3 — stock the stock reads find: an own warehouse and the FBA mirror (names carry the canary), a level at
    // each, a movement, a hold and a count.
    const warehouse = await db.stockLocation.create({ data: { type: 'WAREHOUSE', code: `${mark}-WH-${RUN}`, name: `${canary}-WAREHOUSE` } })
    const fba = await db.stockLocation.create({ data: { type: 'AMAZON_FBA', code: `${mark}-FBA-${RUN}`, name: `${canary}-FBA` } })
    const secondWarehouse = await db.stockLocation.create({ data: { type: 'WAREHOUSE', code: `${mark}-WH2-${RUN}`, name: `${canary}-SECOND-WAREHOUSE` } })
    const level = await db.stockLevel.create({ data: { productId: product.id, locationId: warehouse.id, quantity: 7, reserved: 1, available: 6 } })
    await db.stockLevel.create({ data: { productId: product.id, locationId: fba.id, quantity: 3, reserved: 0, available: 3 } })
    const movement = await db.stockMovement.create({
      data: { productId: product.id, locationId: warehouse.id, change: 7, balanceAfter: 7, reason: 'MANUAL_ADJUSTMENT', notes: `${canary}-MOVEMENT` },
    })
    const hold = await db.stockReservation.create({
      data: { stockLevelId: level.id, quantity: 1, reason: 'MANUAL_HOLD', expiresAt: new Date(Date.now() + 86_400_000) },
    })
    const count = await db.cycleCount.create({
      data: { locationId: warehouse.id, status: 'IN_PROGRESS', notes: `${canary}-COUNT`, items: { create: [{ productId: product.id, sku, expectedQuantity: 7 }] } },
    })
    // 08 S4 — a supplier of the product, a purchase order and its inbound shipment (names carry the canary).
    const supplier = await db.supplier.create({
      // 08 S9 — an e-mail address on file, so email-supplier reaches B's supplier from inside B (the control).
      data: { name: `${canary}-SUPPLIER`, email: `${mark.toLowerCase()}-supplier@example.test`, leadTimeDays: 20, products: { create: [{ productId: product.id, costCents: 420, moq: 5 }] } },
    })
    const purchaseOrder = await db.purchaseOrder.create({
      data: {
        poNumber: `${mark}-PO-${RUN}`, supplierId: supplier.id, status: 'SUBMITTED', totalCents: 2100, currencyCode: 'EUR', notes: `${canary}-PO-NOTE`,
        items: { create: [{ productId: product.id, sku, quantityOrdered: 5, unitCostCents: 420, lineOrder: 0 }] },
      },
    })
    const inboundShipment = await db.inboundShipment.create({
      data: {
        type: 'SUPPLIER', status: 'IN_TRANSIT', reference: `${canary}-INBOUND`, purchaseOrderId: purchaseOrder.id, currencyCode: 'EUR',
        items: { create: [{ productId: product.id, sku, quantityExpected: 5, quantityReceived: 0 }] },
      },
    })
    // 08 S5 — a pricing rule on the product, a running sale event and a scheduled master price change.
    // Integration (08 + L2): price-explain names the business's one eBay account (`account`, seeded above).
    const pricingRule = await db.pricingRule.create({
      data: { name: `${canary}-PRICING-RULE`, type: 'MATCH_LOW', priority: 1, parameters: {}, products: { create: [{ productId: product.id }] } },
    })
    const saleEvent = await db.retailEvent.create({
      data: { name: `${canary}-SALE-EVENT`, startDate: new Date(Date.now() - 86_400_000), endDate: new Date(Date.now() + 86_400_000), expectedLift: '1.1', prepLeadTimeDays: 3 },
    })
    const scheduled = await db.scheduledProductChange.create({
      data: { productId: product.id, kind: 'PRICE', payload: { basePrice: 21.9 }, scheduledFor: new Date(Date.now() + 86_400_000), status: 'PENDING' },
    })
    const alias = await db.productListingAlias.create({ data: { productId: product.id, channel: 'EBAY', marketplace: market, label: `${canary}-ALIAS`, position: 2 } })
    const parent = await db.product.create({ data: { sku: `${mark}-PARENT-${RUN.toUpperCase()}`, name: `${canary}-PARENT`, basePrice: '19.90', isParent: true } })
    // L3 — a studio publication of the product, settled: its result is stored, so reading it asks no channel.
    const publication = await db.bulkOperation.create({
      data: {
        userId: null, status: 'ACCEPTED', productCount: 1, changeCount: 1,
        changes: {
          kind: 'studio-publication', productId: product.id, scope: { channel: 'EBAY', marketplace: market, accountId: account.id },
          result: { id: 'stored', status: 'ACCEPTED', message: `${canary}-PUBLICATION`, results: [{ sku, status: 'ACCEPTED', message: 'Accepted' }] },
        },
      },
    })
    // MCP full control P4 — what the business reads show: the brand, a channel account with one event, a channel
    // call with a trace, and a role of the business's own.
    // (Integration: the brand is the one O3 seeds above — one BrandSettings row per business.)
    // Integration: the business's one eBay account (seeded above for L2, section 03 and A13) — a second active account with
    // the same seller id would break the database-wide one-active-account key.
    const connection = account
    await db.connectionEvent.create({ data: { connectionId: connection.id, channelKey: 'ebay', type: 'heartbeat.ok', detail: { note: `${canary}-EVENT` } } })
    const traceId = `${mark}-TRACE-${RUN}`
    await db.outboundApiCallLog.create({ data: { channel: 'EBAY', operation: `${canary}-OPERATION`, success: true, latencyMs: 90, traceId } })
    await db.role.create({ data: { workspaceId, key: `business_${randomUUID()}`, name: `${canary}-ROLE`, description: 'test', permissions: [] } })
    // MCP full control P6 — an audit row of the product, a failed queued change, an AI call (the summary report and the
    // alerts inbox read the order and the alert event above).
    await db.auditLog.create({ data: { entityType: 'Product', entityId: product.id, action: 'update', before: { name: 'old' }, after: { name: `${canary}-AUDIT` } } })
    await db.outboundSyncQueue.create({ data: { productId: product.id, targetChannel: 'EBAY', syncType: 'PRICE_UPDATE', syncStatus: 'FAILED', retryCount: 1, payload: {} } })
    await db.aiUsageLog.create({ data: { provider: 'anthropic', model: 'test-model', feature: `${canary}-FEATURE`, inputTokens: 10, outputTokens: 5 } })
    // MCP full control P5 — an attribute; a filed, tagged image; the person's saved view (it finds the product) and import.
    const group = await db.attributeGroup.create({ data: { code: `mcp8_${mark.toLowerCase()}`, label: `${canary}-GROUP` } })
    const attribute = await db.customAttribute.create({ data: { code: `mcp8_${mark.toLowerCase()}_note`, label: `${canary}-ATTRIBUTE`, groupId: group.id, type: 'text' } })
    const folder = await db.assetFolder.create({ data: { name: `${canary}-FOLDER` } })
    const tag = await db.tag.create({ data: { name: `${canary}-TAG` } })
    const asset = await db.digitalAsset.create({ data: { label: `${canary}-ASSET`, sizeBytes: 100, mimeType: 'image/jpeg', storageId: `${mark}-STORAGE-${RUN}`, url: `https://example.test/${mark}-${RUN}.jpg`, folderId: folder.id } })
    await db.assetTag.create({ data: { assetId: asset.id, tagId: tag.id } })
    const view = await db.savedView.create({ data: { userId: people.both, surface: 'products', name: `${canary}-VIEW`, filters: { search: sku } } })
    const job = await db.importJob.create({ data: { jobName: `${canary}-IMPORT`, fileKind: 'csv', targetEntity: 'product', createdBy: people.both } })
    // MCP full control P7 — the person's notification, an unfiled untagged image, the product on a workflow's first
    // stage with a second stage to move to.
    const notification = await db.notification.create({ data: { userId: people.both, type: 'info', title: `${canary}-NOTIFICATION` } })
    const looseAsset = await db.digitalAsset.create({ data: { label: `${canary}-LOOSE-ASSET`, sizeBytes: 100, mimeType: 'image/jpeg', storageId: `${mark}-LOOSE-${RUN}`, url: `https://example.test/${mark}-loose-${RUN}.jpg` } })
    const workflow = await db.productWorkflow.create({ data: { code: `mcp8_${mark.toLowerCase()}`, label: `${canary}-WORKFLOW` } })
    const draft = await db.workflowStage.create({ data: { workflowId: workflow.id, code: 'draft', label: `${canary}-DRAFT`, sortOrder: 0, isInitial: true } })
    const reviewStage = await db.workflowStage.create({ data: { workflowId: workflow.id, code: 'review', label: `${canary}-REVIEW`, sortOrder: 1 } })
    await db.product.update({ where: { id: product.id }, data: { workflowStageId: draft.id } })
    // MCP full control P8 — an older revision of the market's mapping (different from today's), a description theme
    // and a listing preset of the business's own.
    const revision = await db.mappingRevision.create({ data: { channel: 'EBAY', code: market, version: 1, snapshot: { version: 1, fields: { title: { source: 'name', notes: `${canary}-REVISION` } }, lastSyncedAt: null, schemaSnapshotVersion: null } } })
    const theme = await db.ebayDescriptionTheme.create({ data: { name: `${canary}-THEME`, html: '<div>{{description}}</div>' } })
    const preset = await db.wizardTemplate.create({ data: { name: `${canary}-PRESET`, channels: [] } })
    // P8 — an option of the attribute; a family and a parent family; a category and a top category to move it under.
    const option = await db.attributeOption.create({ data: { attributeId: attribute.id, code: 'mcp8_option', label: `${canary}-OPTION` } })
    const parentFamily = await db.productFamily.create({ data: { code: `mcp8_${mark.toLowerCase()}_parent`, label: `${canary}-PARENT-FAMILY` } })
    const family = await db.productFamily.create({ data: { code: `mcp8_${mark.toLowerCase()}_family`, label: `${canary}-FAMILY` } })
    const parentCategory = await db.category.create({ data: { slug: `mcp8-${mark.toLowerCase()}-top`, name: { en: { name: `${canary}-TOP-CATEGORY` }, it: {} } } })
    const category = await db.category.create({ data: { slug: `mcp8-${mark.toLowerCase()}`, name: { en: { name: `${canary}-CATEGORY` }, it: {} } } })
    for (const id of [parentCategory.id, category.id]) await db.categoryClosure.create({ data: { ancestorId: id, descendantId: id, depth: 0 } })
    // 08 S13 — an FBA inbound plan still being created (no Amazon plan id), named with the canary.
    const fbaPlan = await db.fbaInboundPlanV2.create({ data: { name: `${canary}-FBA-PLAN`, status: 'CREATING', currentStep: 'CREATE' } })
    const matrixOp = await db.bulkOperation.create({
      data: { userId: null, status: 'COMPLETED', productCount: 1, changeCount: 0, expiresAt: new Date(Date.now() + 3600_000),
        changes: { kind: 'studio-matrix-verb', verb: 'set-buffer', productId: product.id, before: [], changes: [], outcomes: [], phase: 'apply' } },
    })
    const photo = await db.productImage.create({ data: { productId: product.id, url: `https://images.example.test/${canary.toLowerCase()}/side.jpg`, alt: `${canary}-PHOTO`, type: 'ALT' } })
    // P9 — the person's saved import mapping: a file's Name column onto the product name.
    const sourcePreset = await db.scheduledImport.create({
      data: { name: `${canary}-SOURCE-MAPPING`, source: 'upload', sourceUrl: '', targetEntity: 'catalog-source-v1', enabled: false, createdBy: people.both,
        columnMapping: { kind: 'catalog-source-v1', skuColumn: 'SKU', market: 'GLOBAL', mode: 'update', policy: { shared: 'replace', overrides: 'replace' }, bindings: [{ source: 'Name', entity: 'Products', field: 'name', format: 'text' }] } },
    })
    return {
      sku,
      market,
      aliasId: alias.id,
      parentProductId: parent.id,
      productId: product.id,
      orderId: order.id,
      listingId: listing.id,
      approvalId: first.id,
      spareApprovalId: spare.id,
      targetId: target.id,
      campaignId: campaign.id,
      adGroupId: adGroup.id,
      externalCampaignId: campaign.externalCampaignId!,
      externalAdGroupId: adGroup.externalAdGroupId!,
      ebayCampaignId: ebayCampaign.id,
      ebayAdGroupId: ebayAdGroup.id,
      ebayItemId: listing.externalListingId!,
      actionLogId: actionLog.id,
      changeSetId,
      outboundQueueId: queuedWrite.id,
      buildRunId: buildRun.id,
      keys: [
        sku, market, product.id, order.id, order.channelOrderId, listing.id, listing.externalListingId!, first.id, spare.id,
        run.id, rule.id, campaign.id, campaign.externalCampaignId!, adGroup.id, adGroup.externalAdGroupId!, target.id,
        change.id, automationRule.id, shippedOrder.id, shippedOrder.channelOrderId, shipment.id, shipment.trackingNumber!,
        customer.id, ret.id, ret.rmaNumber!,
        warehouse.id, warehouse.code, fba.id, fba.code, level.id, movement.id, hold.id, count.id,
        supplier.id, purchaseOrder.id, purchaseOrder.poNumber, inboundShipment.id, pricingRule.id, saleEvent.id, scheduled.id,
        account.id, account.externalAccountId!, publication.id,
        alias.id, parent.id, parent.sku,
        ebayAccount.id, ebayCampaign.id, ebayCampaign.externalCampaignId, actionLog.id, changeSetId,
        connection.id, traceId, folder.id, tag.id, view.id, job.id,
        alertEvent.id, notification.id, looseAsset.id, workflow.id, draft.id, reviewStage.id, revision.id, theme.id, preset.id,
        attribute.id, option.id, group.id, family.id, parentFamily.id, category.id, parentCategory.id,
        change.id, automationRule.id, suggestion.id, budgetPool.id, assignment.id, priceRule.id, opsRule.id,
        productReview.id, orderNote.id, customerNote.id, shipWarehouse.id, order.items[0].id, refund.id,
        secondWarehouse.id, secondWarehouse.code, fbaPlan.id,
        ebayAdGroup.id, ebayAdGroup.externalAdGroupId,
        matrixOp.id, photo.id,
        sourcePreset.id,
        adsRun.id,
        queuedWrite.id, buildRun.id,
      ],
      agentRows: [run.id, first.id, spare.id, adsRun.id],
      changeId: change.id,
      automationRuleId: automationRule.id,
      shipmentId: shipment.id,
      customerId: customer.id,
      countId: count.id,
      warehouseCode: warehouse.code,
      secondWarehouseCode: secondWarehouse.code,
      holdId: hold.id,
      pricingRuleId: pricingRule.id,
      promotionId: saleEvent.id,
      scheduledChangeId: scheduled.id,
      supplierId: supplier.id,
      purchaseOrderId: purchaseOrder.id,
      inboundShipmentId: inboundShipment.id,
      accountId: account.id,
      publicationId: publication.id,
      connectionId: connection.id,
      traceId,
      folderId: folder.id,
      tagId: tag.id,
      savedViewId: view.id,
      jobId: job.id,
      ruleId: rule.id,
      alertEventId: alertEvent.id,
      notificationId: notification.id,
      assetId: looseAsset.id,
      stageId: reviewStage.id,
      restoreRevisionId: revision.id,
      themeId: theme.id,
      presetId: preset.id,
      attributeId: attribute.id,
      optionId: option.id,
      groupId: group.id,
      familyId: family.id,
      parentFamilyId: parentFamily.id,
      categoryId: category.id,
      parentCategoryId: parentCategory.id,
      suggestionId: suggestion.id,
      budgetPoolId: budgetPool.id,
      budgetScheduleId: budgetSchedule.id,
      assignmentId: assignment.id,
      priceRuleId: priceRule.id,
      opsRuleId: opsRule.id,
      reviewId: productReview.id,
      orderNoteId: orderNote.id,
      customerNoteId: customerNote.id,
      returnId: ret.id,
      warehouseId: shipWarehouse.id,
      orderItemId: order.items[0].id,
      refundId: refund.id,
      planId: fbaPlan.id,
      matrixOpId: matrixOp.id,
      photoId: photo.id,
      sourcePresetId: sourcePreset.id,
      adsRunId: adsRun.id,
    }
  })
}

/**
 * 07 O6 — a buyer's privacy request (an eBay deletion notice matched to the business's eBay order), inserted as the
 * database owner: only the ingress may write one, and its guards ask for an OAuth eBay connection, the buyer's eBay
 * user name on the order and a retained verified notice.
 * Integration (O6 × L2/P4 × S5): the order is on the business's one eBay account (seeded for L2), marked production,
 * instead of a second active eBay account — with two, price-explain cannot tell which account a price is for.
 */
async function seedPrivacyRequest(workspaceId: string, orderId: string, connection: string) {
  const sql = (text: string, params: unknown[]) => database.pool.query(text, params)
  await sql(`UPDATE "ChannelConnection" SET "connectionMetadata"='{"environment":"production"}'::jsonb WHERE id=$1 AND "workspaceId"=$2`, [connection, workspaceId])
  await sql(`UPDATE "Order" SET "channelConnectionId"=$2, "ebayMetadata"='{"buyer":{"username":"test-user"}}'::jsonb WHERE id=$1`, [orderId, connection])
  const notice = randomUUID()
  await sql(`INSERT INTO "EbayNoticeQuarantine" (id,environment,"signatureOk","externalId",topic,"payloadEnc","payloadKeyId","payloadDigest",reason)
    VALUES ($1,'production',true,$1,'MARKETPLACE_ACCOUNT_DELETION','v1:synthetic','env',$2,'account_deletion_review_required')`, [notice, createHash('sha256').update(notice).digest('hex')])
  await sql(`INSERT INTO "ErasureRequest" (id,"workspaceId","quarantineId","evidenceOrderId",channel,environment,"matchBasis",status)
    VALUES ($1,$2,$3,$4,'EBAY','production','username','REVIEW_REQUIRED')`, [randomUUID(), workspaceId, notice, orderId])
  return { connectionId: connection, seller: `seller-${connection}` }
}

// ── Arguments for any tool, from its own input schema ─────────────────────────────────────────────────

/**
 * What an argument of this name means in business B. Ids first; then where B's rows are (channel, market, a
 * search), because a filter on them must not reach B either. A plural name gets a one-item list: `skus` of
 * `sku`, and a list named after a row (`orders`, `listings`) of that row's id.
 */
const B_VALUES: Record<string, () => unknown> = {
  productId: () => seeded.b.productId,
  orderId: () => seeded.b.orderId,
  listingId: () => seeded.b.listingId,
  channelListingId: () => seeded.b.listingId,
  approvalId: () => seeded.b.approvalId,
  // Section 03 — set-listing-content's coordinate names the listing's account.
  accountId: () => seeded.b.accountId,
  changeId: () => seeded.b.changeId,
  // C8 — claude-activity's connection filter: B's own Claude connection (its calls in B are the control's rows).
  connectionId: () => tokens.bOwn.grantId,
  // R6–R8 — the automation tools open one of an automation's rows by `rowId` (A1, the ads rules, by default).
  rowId: () => seeded.b.automationRuleId,
  // 07 O5 — the fulfilment reads (shipment-detail, shipping-rates: an outbound shipment).
  shipmentId: () => seeded.b.shipmentId,
  // 07 O6 — the after-sale reads.
  customerId: () => seeded.b.customerId,
  // 08 S3 — cycle-counts reads one count by id.
  countId: () => seeded.b.countId,
  // 08 S4 — the supply reads take one supplier, PO or inbound shipment by id (inbound-shipments: see EXTRA).
  supplierId: () => seeded.b.supplierId,
  purchaseOrderId: () => seeded.b.purchaseOrderId,
  // I10 — set-listing-sku names an extra listing.
  extraListingId: () => seeded.b.aliasId,
  // I9 — link-channel-id names the channel id to link: B's own Item ID.
  externalId: () => `BRAVO-ITEM-${RUN}`,
  // I11 — fix-parent attaches to a parent; merge-duplicate-products names the duplicate and the product kept.
  parentId: () => seeded.b.parentProductId,
  duplicateId: () => seeded.b.productId,
  keeperId: () => seeded.b.parentProductId,
  // L3 — publication-status names a publication (publish-review names the account above).
  publicationId: () => seeded.b.publicationId,
  // P4 — the calls of one change (channel-connections' `connectionId` is a channel account: see EXTRA).
  traceId: () => seeded.b.traceId,
  // P6 — the audit trail of one record (B's product).
  entityId: () => seeded.b.productId,
  // P5 — an image folder and tag (tagIds), a saved view (also product-search's), an import job.
  folderId: () => seeded.b.folderId,
  tagId: () => seeded.b.tagId,
  savedViewId: () => seeded.b.savedViewId,
  jobId: () => seeded.b.jobId,
  // P7 — an alert rule, its event, the person's notification, an unfiled image (assetIds), the next workflow stage.
  ruleId: () => seeded.b.ruleId,
  alertEventId: () => seeded.b.alertEventId,
  notificationId: () => seeded.b.notificationId,
  assetId: () => seeded.b.assetId,
  stageId: () => seeded.b.stageId,
  // P8 — an older mapping revision to restore, a description theme, a listing preset.
  restoreRevisionId: () => seeded.b.restoreRevisionId,
  themeId: () => seeded.b.themeId,
  presetId: () => seeded.b.presetId,
  // P8 — an attribute, its option and group; a family and its new parent; a category and the one to move it under.
  attributeId: () => seeded.b.attributeId,
  optionId: () => seeded.b.optionId,
  groupId: () => seeded.b.groupId,
  familyId: () => seeded.b.familyId,
  parentFamilyId: () => seeded.b.parentFamilyId,
  categoryId: () => seeded.b.categoryId,
  parentCategoryId: () => seeded.b.parentCategoryId,
  // R11 — decide-automation-suggestions decides suggestions by id.
  suggestionId: () => seeded.b.suggestionId,
  // Ads autonomy W3-1 — apply-ad-recommendations carries recommendations out by id: B's rule suggestion is one.
  recommendationId: () => `rule:${seeded.b.suggestionId}`,
  // R13 — set-ad-guardrail binds a scope: a campaign (its first grain) by id.
  scopeId: () => seeded.b.campaignId,
  // R14 — tune-ad-engine names the row it tunes by `subjectId` (its first setting, a budget pool).
  subjectId: () => seeded.b.budgetPoolId,
  // W4-7 — set-budget-pool names a pool, set-budget-schedule a budget schedule.
  poolId: () => seeded.b.budgetPoolId,
  scheduleId: () => seeded.b.budgetScheduleId,
  // R15 — steer-fleet runs (its first action) or cancels an assignment by id.
  assignmentId: () => seeded.b.assignmentId,
  // R17 — save-price-rule edits a repricing rule by id (with B's product, channel and market, as the builder names them).
  priceRuleId: () => seeded.b.priceRuleId,
  // R18 — save-ops-rule edits an operations rule by id (its first domain, listings).
  opsRuleId: () => seeded.b.opsRuleId,
  // 07 O7 — triage-reviews names each review.
  reviewId: () => seeded.b.reviewId,
  removeNoteId: () => seeded.b.orderNoteId,
  removeCustomerNoteId: () => seeded.b.customerNoteId,
  // 07 O8 — shipments and labels.
  returnId: () => seeded.b.returnId,
  warehouseId: () => seeded.b.warehouseId,
  // 07 O12 — create-return names the order's lines.
  orderItemId: () => seeded.b.orderItemId,
  // 07 O14 — issue-fiscal-document names refunds.
  refundId: () => seeded.b.refundId,
  // 08 S6 — the stock tools name locations by code (a transfer: from one warehouse to the other) and a hold by id.
  location: () => seeded.b.warehouseCode,
  fromLocation: () => seeded.b.warehouseCode,
  toLocation: () => seeded.b.secondWarehouseCode,
  reservationId: () => seeded.b.holdId,
  promotionId: () => seeded.b.promotionId,
  scheduledChangeId: () => seeded.b.scheduledChangeId,
  // 08 S13 — fba-shipment-options reads one FBA inbound plan by id.
  planId: () => seeded.b.planId,
  // L8 — Matrix targets (a row and its coordinate; named here, else `targets` would read as ad target ids) and a Matrix operation.
  // Integration (R6 + L8): `rowId` stays the automation row; the Matrix tools get their targets through EXTRA.
  targets: () => [{ rowId: seeded.b.productId, coordinateKey: `EBAY:${seeded.b.market}` }],
  coordinateKey: () => `EBAY:${seeded.b.market}`,
  operationId: () => seeded.b.matrixOpId,
  // L11 — a photo of B's product.
  photoId: () => seeded.b.photoId,
  // P9 — import-catalog's saved column mapping; rollback-bulk-operation's jobId is B's import job (above).
  savedMappingId: () => seeded.b.sourcePresetId,
  // W4-1 — report-ads-run names the run it reports (finish, fail, withdraw).
  runId: () => seeded.b.adsRunId,
  // C2 — set-master-prices names each product by `product` (an id or a SKU).
  product: () => seeded.b.productId,
  targetId: () => seeded.b.targetId,
  campaignId: () => seeded.b.campaignId,
  adGroupId: () => seeded.b.adGroupId,
  externalCampaignId: () => seeded.b.externalCampaignId,
  sourceExternalCampaignId: () => seeded.b.externalCampaignId,
  destExternalCampaignId: () => seeded.b.externalCampaignId,
  // A5 — graduate-keyword may name the ad group it adds the keyword to.
  destExternalAdGroupId: () => seeded.b.externalAdGroupId,
  externalAdGroupId: () => seeded.b.externalAdGroupId,
  sourceExternalAdGroupId: () => seeded.b.externalAdGroupId,
  // PB-5a — archive-ads names a playbook build's campaigns by its run; ads-playbook view build reads one run.
  buildRunId: () => seeded.b.buildRunId,
  applicationId: () => seeded.b.buildRunId,
  // A10 — undo-ad-change names a recorded ad write, or its change set.
  actionLogId: () => seeded.b.actionLogId,
  changeSetId: () => seeded.b.changeSetId,
  // W3-2 — cancel-queued-ad-write names a queued ad write.
  outboundQueueId: () => seeded.b.outboundQueueId,
  // A14 — the eBay change tools name the eBay campaign, one of its ad groups and an eBay item id.
  ebayCampaignId: () => seeded.b.ebayCampaignId,
  ebayAdGroupId: () => seeded.b.ebayAdGroupId,
  ebayItemId: () => seeded.b.ebayItemId,
  sku: () => seeded.b.sku,
  channel: () => 'EBAY',
  market: () => seeded.b.market,
  marketplace: () => seeded.b.market,
  query: () => seeded.b.sku,
}

/**
 * An argument that names B's rows in more than one form. Each form is probed on its own: a product list takes
 * Nexus ids or SKUs (the bulk tools resolve either), and neither may reach B from A.
 */
const B_FORMS: Record<string, () => Array<{ form: string; value: unknown }>> = {
  products: () => [
    { form: 'ids', value: [seeded.b.productId] },
    { form: 'SKUs', value: [seeded.b.sku] },
  ],
  // 07 O7 — triage-reviews names each review with its own triage.
  reviews: () => [{ form: 'triage items', value: [{ reviewId: seeded.b.reviewId, status: 'IN_PROGRESS' }] }],
  // 07 O8/O9 — update-shipment names each shipment with what to do (confirm-shipment reads only the id: zod drops the rest).
  shipments: () => [{ form: 'shipment steps', value: [{ shipmentId: seeded.b.shipmentId, action: 'hold' }] }],
  // 07 O12 — update-return names each return with its step (dispose-return-items takes its own steps: EXTRA).
  returns: () => [{ form: 'return steps', value: [{ returnId: seeded.b.returnId, action: 'authorize' }] }],
}

/**
 * What a schema cannot say: without it the tool does nothing, even in B. apply-content needs a change to show;
 * bulk-attribute-change may set only an attribute the product's family has or the product already holds.
 */
const EXTRA: Record<string, Record<string, unknown> | (() => Record<string, unknown>)> = {
  // Phase 3 T3 — one eBay category of B's own market, loaded in B only: from A the market is not A's (refused before any
  // read), inside B its details come from B's cache. Neither side calls eBay. `query` is left out (B_VALUES names a
  // product search's words): with it the call would be an eBay search, which no test may send.
  get 'ebay-categories'() { return { market: seeded.b.market, categoryId: MCP8_EBAY_CATEGORY, query: undefined } },
  // L7 — a new product of its own: a SKU no business has (a create names no row to aim at B).
  'create-product': { sku: `MCP8-NEW-${RUN}` },
  // L8 — the value the first action (pin-quantity, set-price) needs.
  // Integration (R6 + L8): the targets whole, so a target's `rowId` is B's product, not the automation row B_VALUES names.
  'set-listing-stock': { quantity: 1, get targets() { return [{ rowId: seeded.b.productId, coordinateKey: `EBAY:${seeded.b.market}` }] } },
  'set-listing-price': { price: 10, get targets() { return [{ rowId: seeded.b.productId, coordinateKey: `EBAY:${seeded.b.market}` }] } },
  // L11 — a link (the schema asks for a web address; nothing is fetched: no photo store here, or the host does not resolve).
  'add-photo-from-url': { url: 'https://photos.example.test/mcp8.png' },
  'apply-content': { title: 'MCP.8 probe title' },
  'bulk-attribute-change': { attributes: { lining_note: 'MCP.8 probe' } },
  // Integration (07 O5 + 08 S4): `shipmentId` names an outbound shipment for shipment-detail and shipping-rates, and an
  // inbound shipment here. A getter, so B's id is read when the probe is built (after seeding).
  'inbound-shipments': { get shipmentId() { return seeded.b.inboundShipmentId } },
  // Section 03 — a language and the English meaning of the text set.
  'set-content': { language: 'it', title: 'MCP.8 probe title', englishMeaning: { title: 'MCP.8 probe title' } },
  'set-listing-content': { language: 'it', pin: { title: 'MCP.8 probe title' }, englishMeaning: { title: 'MCP.8 probe title' } },
  // Read when a probe is built (the seed has run): one item naming B's product, with a text to set.
  get 'bulk-content-change'() {
    return { language: 'it', items: [{ product: seeded.b.productId, title: 'MCP.8 probe title', englishMeaning: { title: 'MCP.8 probe title' } }] }
  },
  // I10 — a new SKU: renaming B's product to its own SKU reads nothing the caller did not send.
  'set-product-sku': { sku: 'MCP8-PROBE-RENAMED' },
  // A6 — a placement change names at least one placement.
  'set-placement-multipliers': { topOfSearchPct: 50 },
  // P10 — one setting to change; the preview shows the business's legal identity.
  'set-business-settings': { websiteUrl: 'https://example.test/mcp8' },
  // P8 — a new name, so the probe is a change (the preview names the theme).
  'save-listing-template': { name: 'MCP8 probe name' },
  'save-attribute': { label: 'MCP8 probe label' },
  'save-product-family': { label: 'MCP8 probe family' },
  'save-category': { name: 'MCP8 probe category' },
  // Integration (C8 + P4): `connectionId` names a Claude connection for claude-activity (B_VALUES) and a channel
  // account here. A getter, so B's id is read when the probe is built (after seeding).
  'channel-connections': { get connectionId() { return seeded.b.connectionId } },
  // C7 — a confirmation is refused unless every check passes; shaped to parse (a hash, a code) so the id is what is probed.
  'confirm-change': { planHash: 'f'.repeat(64), code: '000000' },
  // C6 — a plan whose one step names B's product: from A every step is dry-run in A, so it is not found and nothing is
  // stored; from B it is queued (control). Read when the probes are built, after B is seeded.
  get 'submit-change-plan'() {
    return { title: 'MCP.8 probe plan', steps: [{ tool: 'set-price', args: { productId: seeded.b.productId, price: 25 } }] }
  },
  // R14 — a setting with nothing to change is refused even in B: give the pool a value to change.
  'tune-ad-engine': { budgetPool: { maxShiftPerRebalancePct: 5 } },
  // R17 — an edit with nothing to change is refused even in B: give the rule a note.
  'save-price-rule': { notes: 'MCP.8 probe' },
  // R18 — an edit with nothing to change is refused even in B: give the rule a description.
  'save-ops-rule': { description: 'MCP.8 probe' },
  // Integration (P7 + R9): `ruleId` names an alert rule for set-alert-rule (B_VALUES) and an ads automation rule here.
  'save-ad-rule': { get ruleId() { return seeded.b.automationRuleId } },
  // Integration (P7 + R12): stop-automation and resume-automation name ads automation rules (`ruleIds`).
  'stop-automation': { get ruleIds() { return [seeded.b.automationRuleId] } },
  'resume-automation': { get ruleIds() { return [seeded.b.automationRuleId] } },
  // 08 S7 — a policy change names what it changes, for every market of B's account (a policy's market is a 2–4 letter
  // code or *, which this suite's market code is not).
  'set-stock-policy': { marketplace: '*', pushesPaused: true },
  // 08 S11 — a floor for B's product (each item names a floor or a ceiling); B's listing 5 % up (mode and value, not the
  // per-listing prices the schema would also build).
  'set-price-bounds': () => ({ items: [{ productId: seeded.b.productId, minPrice: 1 }] }),
  'bulk-listing-price-change': { mode: 'percent', value: 5, prices: undefined },
  // Integration (P7 + 08 S12): set-pricing-rule's `ruleId` is a pricing rule.
  'set-pricing-rule': { get ruleId() { return seeded.b.pricingRuleId } },
  // Integration (07 O5 + 08 S10/S13): `shipmentId` is an inbound shipment for the receiving and FBA tools.
  'receive-stock': { get shipmentId() { return seeded.b.inboundShipmentId } },
  'update-inbound-shipment': { get shipmentId() { return seeded.b.inboundShipmentId } },
  'plan-fba-shipment': { get shipmentId() { return seeded.b.inboundShipmentId } },
  // 07 O7 — an update names at least one change.
  'update-order': { note: 'MCP.8 probe note' },
  'update-customer': { note: 'MCP.8 probe note' },
  // 07 O12 — its steps are restock or scrap (B_FORMS.returns is update-return's); read after the seeding.
  'dispose-return-items': () => ({ returns: [{ returnId: seeded.b.returnId, action: 'restock' }] }),
  // 07 O17 — a pickup day (a date the schema cannot make up).
  'schedule-pickup': () => ({ date: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10) }),
  // A7 — a selection (the campaign, ad group and market the loop names) moves by a percent.
  'bulk-ad-bid-change': { percent: 10 },
  // T5 — the campaigns are named one way: by id (the loop also names B's market, and the tool refuses both at once,
  // before any read), with a target to set.
  'set-campaign-target-acos': { market: undefined, targetAcosPct: 25 },
  // End, Relist and Delete take the family SKU the person typed: B's product is its own family. A getter, so B's SKU is
  // read when the probe is built (after seeding).
  'end-listing': { get confirmSku() { return seeded.b.sku } },
  'relist-listing': { get confirmSku() { return seeded.b.sku } },
  'delete-listing': { get confirmSku() { return seeded.b.sku } },
  // Ads autonomy W3-1 — unmute the recommendation of B's campaign that B muted (its label is B's).
  'mute-ad-recommendations': () => ({ recommendationIds: [`budget:${seeded.b.campaignId}`], op: 'unmute' }),
  // W3-1 — undo-ad-change names a recorded write (and its set); `changeId` (one step of a plan's set) is left out: the
  // loop's changeId is another request's change.
  'undo-ad-change': { changeId: undefined },
  // The loop's campaignId is the Amazon campaign: read the Amazon log and recommendations (1b aims the eBay ones).
  'ad-changes': { channel: 'amazon' },
  'ad-recommendations': { channel: 'amazon' },
  // Ads autonomy W1-2 — the strategy is read for ONE scope: the loop's campaign (in its own market, B's traceable one; the
  // answer names the campaign). The channel is Amazon's (the loop's is eBay); the other scopes are left out.
  'ads-strategy': { channel: undefined, productId: undefined, sku: undefined, categoryId: undefined, adGroupId: undefined },
  // Ads autonomy W1-3 — a change of ONE strategy row: B's product's, in B's own Amazon market (the loop's channel is
  // eBay's). One scope only (the loop would also name a SKU and a category), and a value to change; no lists.
  'set-ads-strategy': {
    channel: 'AMAZON', level: 'product', sku: undefined, categoryId: undefined, values: { goalNote: 'MCP.8 probe' },
    protectedTerms: undefined, restoreCampaignTargets: undefined, clearCampaignTargets: undefined, expectVersion: undefined, reason: undefined,
  },
  // Ads playbook PB-2 — the playbook is read for ONE scope: the loop's product (its answer names the product). The channel
  // is Amazon's (the loop's is eBay); a template, a category and a capture's selectors are left out.
  'ads-playbook': {
    channel: undefined, sku: undefined, categoryId: undefined, templateId: undefined, campaignIds: undefined, portfolioId: undefined,
    namePrefix: undefined, productToken: undefined, competitorTokens: undefined,
  },
  // Ads playbook PB-3 — a change of the loop's product's playbook row in IT (from A: "Product not found"). The template
  // fields, the capture's selectors and the values are left out; the channel is Amazon's.
  'set-ads-playbook': {
    channel: 'AMAZON', kind: 'playbook', op: undefined, market: 'IT', level: 'product', templateId: undefined, name: undefined, status: undefined,
    doc: undefined, sections: undefined, categoryId: undefined, sku: undefined, values: undefined, recompute: undefined, campaignIds: undefined,
    portfolioId: undefined, namePrefix: undefined, productToken: undefined, competitorTokens: undefined, expectVersion: undefined, reason: undefined,
  },
  // W4-1 — the end of B's started run (start takes no runId; the loop names one).
  'report-ads-run': { op: 'finish' },
  // W4-2 — the business's own expected report time (a time the schema cannot make up).
  'set-ads-report-time': { time: '08:30', timeZone: 'Europe/Rome' },
  // T4 — the eBay ad details open an eBay campaign (the loop's campaignId and adGroupId are Amazon's).
  'ebay-ad-details': { get campaignId() { return seeded.b.ebayCampaignId }, adGroupId: undefined },
  // W3-2 — a cancel names the queued write alone (the loop's changeSetId is a recorded write's, which waits for nothing).
  'cancel-queued-ad-write': { changeSetId: undefined },
  // PB-5a — one product's playbook, named by its id (its answer then names the product's SKU, which was not sent).
  'apply-ads-playbook': { sku: undefined },
  // B-3 — a one-off SP Super Wizard set: Standard, one category keyword, its bids under its budget; no portfolio.
  'build-sp-wizard-campaigns': { structure: 'standard', keywords: { category: ['probe jacket'] }, dailyBudgetCents: 1500, defaultBidCents: 50, portfolioId: undefined },
  // A11 — a new campaign targets keywords (or ASINs); its bids fit under its budget.
  'create-ad-campaign': { keywords: [{ text: 'probe jacket', matchType: 'EXACT' }], dailyBudgetCents: 1500, defaultBidCents: 50 },
  // B-1 — a copy reads its source campaign in the market it runs in (B's own); no portfolio (the loop would name an id).
  'replicate-ad-structure': { get sourceMarket() { return seeded.b.market }, portfolioId: undefined },
  // P9 — a file naming B's product by its SKU (built once B is seeded); the saved mapping maps its Name column.
  'import-catalog': () => ({ text: `SKU,Name\n${seeded.b.sku},MCP8 probe name` }),
  // W4-7 — the single form of set-campaign-budget names its budget (the list form is the other way to name it).
  'set-campaign-budget': { dailyBudgetCents: 1500 },
  // W4-7 — a market's plan reaches B through the limits of B's campaign (the plan itself names no row); this month, no
  // plan values (the builder's calendar would not add up).
  'set-monthly-ad-budget': () => ({ month: undefined, monthlyBudgetCents: undefined, autoPacing: undefined, stopOverSpend: undefined, calendar: undefined, campaignLimits: [{ campaignId: seeded.b.campaignId, minCents: null, maxCents: 4000 }] }),
  // W4-7 — B's schedule renamed (no campaigns, windows or dates of the builder's).
  'set-budget-schedule': { op: 'update', name: 'MCP8 probe schedule', type: undefined, campaignIds: undefined, windows: undefined, timezone: undefined, startDate: undefined, endDate: undefined, excludeDates: undefined, enabled: undefined },
  // W4-7 — B's pool given a description (no values, campaigns or currency of the builder's).
  'set-budget-pool': { op: 'update', description: 'MCP8 probe pool', name: undefined, currency: undefined, totalDailyBudgetCents: undefined, strategy: undefined, coolDownMinutes: undefined, maxShiftPerRebalancePct: undefined, add: undefined, remove: undefined },
  // W4-7 — every market: a pool with no campaigns is in none, and B's is one.
  'ad-budgets': { market: undefined },
}
const extraOf = (name: string) => {
  const extra = EXTRA[name]
  return typeof extra === 'function' ? extra() : extra
}

/**
 * A tool whose answer inside B is a REFUSAL that could only come from finding B's row (confirm-change: the approval is
 * there, but this connection may not confirm, or did not ask for it) — from A the same call is "not found".
 */
const REACHED_BY_REFUSAL: Record<string, RegExp> = {
  'confirm-change': /may not confirm changes|Only the person who asked/,
}

/**
 * MCP full control P10 — change tools that act on the business itself and name no row (its settings). From A they can
 * only ask for a change OF A: it waits for a person in A, shows nothing of B, and changes nothing in B.
 */
const BUSINESS_WIDE = new Set(['set-business-settings'])

/** T11 — the tools that read a marketplace live: probed from A only (see the control). */
const LIVE_READS = new Set(['shopify-content', 'set-shopify-content', 'listing-live-content'])
/**
 * L7 — tools that create from nothing: they name no row of either business, so there is nothing of B to reach (no
 * control inside B), and from A the creation is legitimate (it queues A's own approval). They are held to "no trace of
 * B" like every tool.
 */
const CREATES = new Set([
  'create-product',
  // W4-2 — the business's own expected report time names no row either: from A it is A's own setting, waiting in A.
  'set-ads-report-time',
])

/** An argument named like an id. One with no B_VALUES entry fails the build: the loop would probe nothing. */
const ID_NAME = /(^id$|Id$|Ids$|^skus?$)/
/** P10 — names that look like ids but name no row: a company's tax number. */
const NOT_ROW_IDS = new Set(['taxId'])
const OMIT = Symbol('omit')

interface ZodNode {
  _zod: { def: { type: string; [key: string]: any }; bag: Record<string, unknown> }
  safeParse(value: unknown): { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }
}

/** The schema that decides the value: through optional, default and the like; a preprocess by what it yields. */
function unwrap(node: ZodNode): ZodNode {
  let current = node
  for (;;) {
    const def = current._zod.def
    if (['optional', 'default', 'prefault', 'nullable', 'nonoptional', 'readonly', 'catch'].includes(def.type)) current = def.innerType
    else if (def.type === 'pipe') current = def.out._zod.def.type === 'transform' ? def.in : def.out
    else return current
  }
}

function bValue(name: string): unknown {
  if (B_FORMS[name]) return B_FORMS[name]()[0].value
  if (B_VALUES[name]) return B_VALUES[name]()
  const one = name.endsWith('s') ? name.slice(0, -1) : ''
  const entry = one ? (B_VALUES[one] ?? B_VALUES[`${one}Id`]) : undefined
  return entry ? [entry()] : undefined
}

/** One argument: B's value by its name; otherwise left out when optional, else a plain valid value. */
function argument(node: ZodNode, name: string, path: string, gaps: string[]): unknown {
  const known = bValue(name)
  // P8 — a plural name is a list of ids only when its items are text: `options` or `attributes` listing whole rows
  // (objects) is not B's optionId or attributeId, and is built like any other argument. Integration (P8 × 03): nor is
  // a record named `attributes` (set-content's attribute code → value), so it too is built like any other argument.
  const inner = unwrap(node)._zod.def
  const rows = (inner.type === 'array' && unwrap(inner.element)._zod.def.type === 'object') || inner.type === 'record'
  if (known !== undefined && !rows) {
    const list = inner.type === 'array'
    return list === Array.isArray(known) ? known : list ? [known] : (known as unknown[])[0]
  }
  if (ID_NAME.test(name) && !NOT_ROW_IDS.has(name)) {
    gaps.push(`${path}: an id with no business-B value — seed the row and name it in B_VALUES`)
    return OMIT
  }
  if (node.safeParse(undefined).success) return OMIT
  return plainValue(node, path, gaps)
}

function plainValue(node: ZodNode, path: string, gaps: string[]): unknown {
  const inner = unwrap(node)
  const def = inner._zod.def
  const bag = inner._zod.bag as { minimum?: number; maximum?: number; exclusiveMinimum?: number }
  switch (def.type) {
    case 'object': {
      const out: Record<string, unknown> = {}
      for (const [name, child] of Object.entries(def.shape as Record<string, ZodNode>)) {
        const value = argument(child, name, `${path}.${name}`, gaps)
        if (value !== OMIT) out[name] = value
      }
      return out
    }
    case 'array': {
      const item = plainValue(def.element, `${path}[]`, gaps)
      return item === OMIT ? OMIT : [item]
    }
    case 'string':
      return 'mcp8 probe'.padEnd(bag.minimum ?? 0, 'x').slice(0, bag.maximum ?? undefined)
    case 'number': {
      const low = bag.minimum ?? (bag.exclusiveMinimum != null ? bag.exclusiveMinimum + 1 : 0)
      return Math.min(Math.max(100, low), bag.maximum ?? Number.MAX_SAFE_INTEGER)
    }
    case 'boolean':
      return false
    case 'enum':
      return Object.values(def.entries as Record<string, unknown>)[0]
    case 'literal':
      return (def.values as unknown[])[0]
    case 'union':
      for (const option of def.options as ZodNode[]) {
        const value = plainValue(option, path, [])
        if (value !== OMIT && option.safeParse(value).success) return value
      }
      break
    case 'record': {
      const key = 'mcp8_probe'
      if (!(def.keyType as ZodNode).safeParse(key).success) break
      const value = plainValue(def.valueType, `${path}.${key}`, gaps)
      return value === OMIT ? OMIT : { [key]: value }
    }
  }
  gaps.push(`${path}: no plain value for a ${def.type} — give the tool an entry in EXTRA`)
  return OMIT
}

interface Probe {
  label: string
  args: Record<string, unknown>
}

/** A tool's arguments aimed at business B (one probe per form of a B_FORMS argument), or why they cannot be built. */
function probeArgs(tool: AgentTool): { probes: Probe[] } | { gaps: string[] } {
  const gaps: string[] = []
  const input = tool.input as unknown as ZodNode
  // An argument EXTRA gives whole (a plan's steps, whose args no schema can describe) is not built from the schema.
  const extra = extraOf(tool.name) ?? {}
  const given = Object.keys(extra)
  const shape = given.length ? (tool.input.omit(Object.fromEntries(given.map((key) => [key, true])) as never) as unknown as ZodNode) : input
  const built = plainValue(shape, tool.name, gaps)
  if (gaps.length) return { gaps }
  const args = { ...(built as Record<string, unknown>), ...extra }
  const probes: Probe[] = [{ label: tool.name, args }]
  for (const key of Object.keys(args).filter((name) => B_FORMS[name])) {
    for (const { form, value } of B_FORMS[key]().slice(1)) probes.push({ label: `${tool.name} (${key} as ${form})`, args: { ...args, [key]: value } })
  }
  for (const probe of probes) {
    const parsed = input.safeParse(probe.args)
    if (!parsed.success) {
      return { gaps: [`${probe.label}: its built arguments do not parse (${parsed.error!.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}) — give it an entry in EXTRA`] }
    }
  }
  return { probes }
}

/** Every string the caller itself sent: an answer may repeat those. */
/** Ads autonomy W3-1 — a recommendation id names its row after its prefix (`rule:<suggestionId>`): the caller sent that id. */
const RECOMMENDATION_ID = /^(?:bid|budget|retail|rule):(.+)$/

function sentStrings(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    into.add(value)
    const row = RECOMMENDATION_ID.exec(value)?.[1]
    if (row) into.add(row)
  } else if (Array.isArray(value)) value.forEach((item) => sentStrings(item, into))
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => sentStrings(item, into))
  return into
}

/** What of a business an answer shows: its canary, or a key of its rows the caller did not send. */
function traces(text: string, of: Seeded, canary: string, args: unknown = {}): string[] {
  const sent = sentStrings(args)
  const found = of.keys.filter((key) => !sent.has(key) && text.includes(key))
  return text.toUpperCase().includes(canary) ? [canary, ...found] : found
}

// ── Claude's side, and a record of every answer ───────────────────────────────────────────────────────

/**
 * Who got an answer. 'B-control' answers are B reading its own rows (the controls), the only ones that may show
 * B's canary. 'B-only' is the person who belongs to B alone. 'A' is everything given to business A.
 */
type Tag = 'A' | 'B-control' | 'B-only'
/** Each answer with what its caller sent (a path, a body): an answer may repeat those, as `traces` allows. */
const answers: Array<{ tag: Tag; text: Promise<string>; sent: unknown }> = []
const logLines: string[] = []

let app: FastifyInstance
let url: string
let secret: string
const people = { owner: '', both: '', bOnly: '' }
const roles = { owner: '', a: '', b: '' }
const sessions = { owner: '', both: '', bOnly: '' }
const clients: Record<string, string> = {}
const tokens = {} as Record<'a' | 'aSecond' | 'bOwn' | 'bOnly', { access: string; grantId: string }>

/** fetch that keeps a copy of every answer for the scans of test 6. */
const recordingFetch = (tag: Tag) => async (input: string | URL, init?: RequestInit) => {
  const response = await fetch(input, init)
  answers.push({ tag, text: response.clone().text().catch(() => ''), sent: sentBody(init?.body) })
  return response
}

/** A JSON request body as its values (the MCP client sends JSON-RPC as a string). */
function sentBody(body: unknown): unknown {
  if (typeof body !== 'string') return body ?? {}
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

async function withClaude<T>(token: string, tag: Tag, work: (client: Client) => Promise<T>): Promise<T> {
  return withClaudeAt(url, token, tag, work)
}

/** C4 — Claude at another MCP URL (one business's own). */
async function withClaudeAt<T>(target: string, token: string, tag: Tag, work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'nexus-mcp8', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(target), { authProvider: { token: async () => token }, fetch: recordingFetch(tag) }))
  try {
    return await work(client)
  } finally {
    await client.close()
  }
}

type CallResult = { isError?: boolean; content: Array<{ type: string; text?: string }> }
const textOf = (result: unknown) => ((result as CallResult).content ?? []).map((block) => block.text ?? '').join('')
/** C3 — a refusal is `{ business, error }`: its sentence. */
const errorOf = (result: unknown) => {
  try {
    return String((JSON.parse(textOf(result)) as { error?: unknown }).error ?? textOf(result))
  } catch {
    return textOf(result)
  }
}
/** C3 — every change over MCP names its connection's business: a check, never a selector. */
const NAMES: Record<string, string> = { [A]: 'Alpha business', [B]: 'Bravo business' }
const named = (tool: Pick<AgentTool, 'readOnly'>, args: Record<string, unknown>, workspaceId: string) =>
  tool.readOnly ? args : { ...args, business: NAMES[workspaceId] }

/** How a tools/call ended, as Claude reads it. */
function outcomeOf(result: unknown): 'refused' | 'queued' | 'preview' | 'answered' | 'crashed' {
  const text = textOf(result)
  if ((result as CallResult).isError) return text.includes(FAILED) ? 'crashed' : 'refused'
  try {
    const status = (JSON.parse(text) as { status?: unknown })?.status
    if (status === 'waiting_for_approval') return 'queued'
    if (status === 'preview_only') return 'preview'
  } catch {
    // plain text: an answer
  }
  return 'answered'
}

const listRequest = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
const callRequest = (name: string, args: Record<string, unknown>) => ({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })

/** A raw JSON-RPC POST to /mcp, for the answers the SDK client turns into exceptions. */
async function post(tag: Tag, body: unknown, init: { token: string; headers?: Record<string, string>; query?: string }) {
  return postTo(url, tag, body, init.token, init)
}

/** C4 — the same, at any MCP URL. */
async function postTo(target: string, tag: Tag, body: unknown, token: string, init: { headers?: Record<string, string>; query?: string } = {}) {
  const response = await fetch(`${target}${init.query ?? ''}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, ...init.headers },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  answers.push({ tag, text: Promise.resolve(text), sent: body })
  return { status: response.status, header: (name: string) => response.headers.get(name), text }
}

/** The JSON-RPC message in an answer, sent as JSON or as one server-sent event. */
function rpcOf(text: string): { result?: { tools?: Array<{ name: string }> } & Partial<CallResult>; error?: { message: string } } {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) return JSON.parse(trimmed)
  const data = trimmed.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).filter(Boolean)
  return JSON.parse(data.at(-1) ?? '{}')
}

/** A request from the web app: a signed-in person, their session cookie and CSRF pair, and a business when named. */
async function inApp(tag: Tag, method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, session: string, business?: string, payload?: unknown) {
  const response = await app.inject({
    method,
    url: path,
    headers: {
      cookie: `${sessionCookieName()}=${session}; ${csrfCookieName()}=${CSRF}`,
      'x-nexus-csrf': CSRF,
      ...(business ? { 'x-nexus-workspace-id': business } : {}),
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    payload: payload === undefined ? undefined : JSON.stringify(payload),
  })
  answers.push({ tag, text: Promise.resolve(response.body), sent: { path, payload } })
  return response
}

// ── The owner's view of the database (BYPASSRLS): what really happened ───────────────────────────────

const rowsOf = async <T,>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
const counts = async () =>
  (await rowsOf<{ runs: number; approvals: number }>('SELECT (SELECT count(*) FROM "AgentRun")::int AS runs, (SELECT count(*) FROM "AgentApproval")::int AS approvals'))[0]

let digestSql = ''
/** Every row of one business, in every table that has a business column: a count and a hash per table. */
async function digest(workspaceId: string): Promise<Record<string, string>> {
  if (!digestSql) {
    const tables = await rowsOf<{ name: string }>(`
      SELECT c.table_name AS name FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND c.column_name = 'workspaceId' AND t.table_type = 'BASE TABLE' ORDER BY 1`)
    digestSql = tables
      .map(({ name }) => `SELECT '${name}' AS t, count(*)::int AS n, md5(coalesce(string_agg(r::text, '|' ORDER BY r::text), '')) AS h FROM "${name}" r WHERE r."workspaceId" = $1`)
      .join(' UNION ALL ')
  }
  const rows = await rowsOf<{ t: string; n: number; h: string }>(digestSql, [workspaceId])
  return Object.fromEntries(rows.map((row) => [row.t, `${row.n}:${row.h}`]))
}

// ── Connecting Claude, as a person does ───────────────────────────────────────────────────────────────

/**
 * Approve in the browser with a fresh 2FA code and swap the code, as Claude would. C4: `resource` = the MCP URL.
 * C5: the app asks for nexus.run too; the person grants `scopes` (read and write unless named).
 */
async function connect(userId: string, appName: string, workspaceId: string, resource = `${API}/mcp`, scopes = ['nexus.read', 'nexus.write']) {
  const verifier = generateToken(32)
  const { redirectTo } = await consent({
    userId,
    params: {
      response_type: 'code',
      client_id: clients[appName],
      redirect_uri: CALLBACK,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state: 's',
      scope: 'nexus.read nexus.write nexus.run',
      resource,
    },
    decision: 'approve',
    workspaceId,
    scopes,
    code: generateSync({ secret }),
  })
  __stepUpTest.reset() // the next consent in the same 30 s window may reuse the code
  const issued = await exchangeCode({
    grant_type: 'authorization_code',
    code: new URL(redirectTo).searchParams.get('code') ?? undefined,
    code_verifier: verifier,
    client_id: clients[appName],
    redirect_uri: CALLBACK,
  })
  const grant = await database.client.oAuthGrant.findFirst({ where: { userId, workspaceId, client: { clientId: clients[appName] } } })
  return { access: issued.access_token, grantId: grant!.id }
}

/** Every log line, whatever writes it; each still reaches the terminal. */
function captureLogs() {
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[method].bind(console)
    vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => {
      logLines.push(parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part) ?? String(part))).join(' '))
      original(...parts)
    })
  }
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (...args: unknown[]) => boolean
    vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      logLines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'))
      return write(chunk, ...rest)
    }) as never)
  }
}

// Each test makes dozens of HTTP calls and database reads; a busy machine or CI runner needs more than the default.
describe.skipIf(!concurrentDatabaseUrl())('MCP.8 — a Claude connection for one business never reaches another (real PostgreSQL)', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    captureLogs()
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_MCP_ENABLED', '1')
    vi.stubEnv('NEXUS_MCP_WORKSPACES', '')
    vi.stubEnv('NEXUS_MCP_RESOURCE', '')
    vi.stubEnv('NEXUS_OAUTH_ISSUER', WEB)
    vi.stubEnv('NEXUS_OAUTH_API_ORIGIN', API)
    vi.stubEnv('NEXUS_RBAC_MODE', 'enforce')
    vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
    // This file counts what ran, not how often: the per-minute limits have their own suite.
    vi.stubEnv('NEXUS_MCP_RATE_PER_GRANT', '100000')
    vi.stubEnv('NEXUS_MCP_RATE_PER_BUSINESS', '100000')
    database = await concurrentDatabase()
    const db = database.client
    secret = generateSecret()

    const person = (name: string) =>
      db.userProfile.create({
        data: { email: `mcp8-${name}-${RUN}@example.test`, status: 'active', displayName: `MCP8 ${name}`, twoFactorEnabledAt: new Date(), twoFactorSecret: secret },
      })
    people.owner = (await person('owner')).id
    people.both = (await person('both')).id
    people.bOnly = (await person('bravo')).id
    for (const [id, name] of [[A, NAMES[A]], [B, NAMES[B]]] as const) {
      await db.workspace.create({ data: { id, name, createdByUserId: people.owner, creationKey: randomUUID() } })
    }
    roles.owner = (await db.role.create({ data: { key: 'OWNER', name: 'Owner', isSystem: true, permissions: [] } })).id
    // Custom roles holding every permission: a refusal below can only be the business, never a missing permission.
    const everything = (workspaceId: string) =>
      db.role.create({ data: { workspaceId, key: `business_${randomUUID()}`, name: 'MCP8 everything', description: 'test', permissions: ALL_PERMISSIONS } })
    roles.a = (await everything(A)).id
    roles.b = (await everything(B)).id
    for (const [workspaceId, userId, roleId] of [
      [A, people.owner, roles.owner],
      [A, people.both, roles.a],
      [B, people.both, roles.b],
      [B, people.bOnly, roles.b],
    ] as const) {
      await db.workspaceMembership.create({ data: { workspaceId, userId, status: 'active', roles: { create: [{ roleId }] } } })
    }

    seeded.a = await seedBusiness(A, 'ALPHA', A_CANARY)
    seeded.b = await seedBusiness(B, 'BRAVO', B_CANARY)
    await seedPrivacyRequest(A, seeded.a.orderId, seeded.a.accountId)
    await seedPrivacyRequest(B, seeded.b.orderId, seeded.b.accountId)
    // 07 O17 — a MANUAL carrier per business (schedule-pickup).
    for (const workspaceId of [A, B]) await inside(workspaceId, () => database.client.carrier.create({ data: { code: 'MANUAL', name: 'Manual', isActive: true } as never }))

    for (const name of ['Claude', 'Claude Code']) {
      clients[name] = String((await registerClient({ client_name: name, redirect_uris: [CALLBACK] })).client_id)
    }
    tokens.a = await connect(people.both, 'Claude', A)
    tokens.aSecond = await connect(people.both, 'Claude Code', A)
    tokens.bOwn = await connect(people.both, 'Claude', B)
    tokens.bOnly = await connect(people.bOnly, 'Claude', B)
    for (const who of ['owner', 'both', 'bOnly'] as const) {
      sessions[who] = (await createSession({ userId: people[who], mfaSatisfied: true })).rawToken
    }

    // The API's own global plumbing, in index.ts order, and the routes a person answers Claude's requests in.
    app = Fastify()
    await app.register(compress, { global: true, threshold: 1024, encodings: ['gzip', 'deflate'] })
    await app.register(cookie)
    app.addHook('preHandler', workspaceHook)
    app.addHook('preHandler', rbacHook)
    app.addHook('preSerialization', financialFilterHook)
    await app.register(workspacesRoutes, { prefix: '/api' })
    await app.register(oauthGrantsRoutes, { prefix: '/api' })
    await app.register(mcpRoutes)
    await app.register(agentRoutes, { prefix: '/api' })
    await app.register(agentFleetRoutes, { prefix: '/api' })
    await app.register(agentFleetApprovalRoutes, { prefix: '/api' })
    await app.register(claudeControlRoutes, { prefix: '/api' })
    await app.listen({ port: 0, host: '127.0.0.1' })
    url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`
  }, 240_000)

  beforeEach(() => {
    __toolRateTest.reset()
    __mcpRateTest.reset()
  })

  afterAll(async () => {
    await app?.close()
    await database?.close()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  }, 120_000)

  describe("1 — every tool Claude is offered, handed business B's ids", () => {
    const offered: AgentTool[] = []
    /** By label: a tool, or one form of it (a product list by ids, then by SKUs). */
    const probes = new Map<string, { tool: AgentTool; args: Record<string, unknown> }>()

    it('the person in both businesses is offered every MCP tool, so the loop below covers the registry', async () => {
      const { tools } = await withClaude(tokens.a.access, 'A', (client) => client.listTools())
      const everyMcpTool = listTools().filter((tool) => offeredOn(tool, 'mcp'))
      expect(tools.map((tool) => tool.name).sort()).toEqual(everyMcpTool.map((tool) => tool.name).sort())
      offered.push(...everyMcpTool)
      // The token reads its own business (control): A's product, and nothing of B.
      const own = await withClaude(tokens.a.access, 'A', (client) => client.callTool({ name: 'product-search', arguments: {} }))
      expect(textOf(own)).toContain(seeded.a.sku)
      expect(traces(textOf(own), seeded.b, B_CANARY)).toEqual([])
    })

    it("each tool's arguments come from its own input schema; a tool the loop cannot aim at B fails by name", () => {
      const gaps: string[] = []
      for (const tool of offered) {
        const built = probeArgs(tool)
        if ('gaps' in built) gaps.push(...built.gaps)
        else for (const probe of built.probes) probes.set(probe.label, { tool, args: probe.args })
      }
      expect(gaps, gaps.join('\n')).toEqual([])
      expect(Object.keys(EXTRA).filter((name) => !offered.some((tool) => tool.name === name))).toEqual([])
      expect(offered.filter((tool) => ![...probes.values()].some((probe) => probe.tool === tool)).map((tool) => tool.name)).toEqual([])
    })

    it('the builder aims the shapes a new tool may use (lists of ids, lists of rows) at B, and names what it cannot', () => {
      const future = (input: z.ZodObject) => probeArgs({ name: 'future-tool', input } as unknown as AgentTool)
      const upper = (value: unknown) => (typeof value === 'string' ? value.toUpperCase() : value)
      expect(future(z.object({ productIds: z.array(z.string().min(1)).min(1), orders: z.array(z.string()).optional(), price: z.coerce.number().positive(), note: z.string().optional() })))
        .toEqual({ probes: [{ label: 'future-tool', args: { productIds: [seeded.b.productId], orders: [seeded.b.orderId], price: 100 } }] })
      expect(future(z.object({
        items: z.array(z.object({ sku: z.string(), quantity: z.coerce.number().int().min(0).max(50) })).min(1),
        channel: z.preprocess(upper, z.enum(['AMAZON', 'EBAY'])).optional(),
      }))).toEqual({ probes: [{ label: 'future-tool', args: { items: [{ sku: seeded.b.sku, quantity: 50 }], channel: 'EBAY' } }] })
      // A product list is probed by ids and again by SKUs; a record gets one plain entry.
      expect(future(z.object({ products: z.array(z.string()).min(1), change: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), z.string()) }))).toEqual({
        probes: [
          { label: 'future-tool', args: { products: [seeded.b.productId], change: { mcp8_probe: 'mcp8 probe' } } },
          { label: 'future-tool (products as SKUs)', args: { products: [seeded.b.sku], change: { mcp8_probe: 'mcp8 probe' } } },
        ],
      })
      // (warehouseId has a B value since 07 O8 and supplierId since 08 S4; integration: an id no tool takes has none.)
      expect(future(z.object({ futureRowId: z.string().optional() }))).toEqual({
        gaps: ['future-tool.futureRowId: an id with no business-B value — seed the row and name it in B_VALUES'],
      })
    })

    it("control: the same person, connected to B, reaches B's rows with exactly these arguments", async () => {
      const missed: string[] = []
      await withClaude(tokens.bOwn.access, 'B-control', async (client) => {
        for (const [label, { tool, args }] of probes) {
          // T11 — a tool that reads the channel live (a Shopify store, a listing on eBay) has nothing to read here: no store
          // or channel login exists in this suite. From A it is still probed below (B's product is not found first).
          if (LIVE_READS.has(tool.name)) continue
          if (CREATES.has(tool.name)) continue
          const result = await client.callTool({ name: tool.name, arguments: named(tool, args, B) })
          const text = textOf(result)
          const reached = traces(text, seeded.b, B_CANARY, args).length > 0 || !!REACHED_BY_REFUSAL[tool.name]?.test(text)
          if (outcomeOf(result) === 'crashed' || !reached) {
            missed.push(`${label} ${JSON.stringify(args)} → ${text.slice(0, 160)}`)
          }
        }
      })
      // A tool here reads nothing even inside B: "not found" from A would prove nothing. Give it B_VALUES, B_FORMS or EXTRA.
      expect(missed, missed.join('\n')).toEqual([])
    })

    it('from A: B is not found, the list is empty or the call is refused — never a row of B; a change is refused as not found and nothing is queued', async () => {
      const before = await digest(B)
      // The digest sees B's rows (control): the seeded products (the product and, I11, a parent), order and approvals.
      expect(before.Product).toMatch(/^2:/)
      expect(before.AgentApproval).not.toMatch(/^0:/)
      const approvalsInA = async () =>
        (await rowsOf<{ n: number }>('SELECT count(*)::int AS n FROM "AgentApproval" WHERE "workspaceId" = $1', [A]))[0].n
      const queuedBefore = await approvalsInA()
      const problems: string[] = []
      const changeTools = new Set<string>()
      let queuedInA = 0
      let queuedCreates = 0
      await withClaude(tokens.a.access, 'A', async (client) => {
        for (const [label, { tool, args }] of probes) {
          // A's own name: the change passes the business check and is then refused by the tool, as not found.
          const result = await client.callTool({ name: tool.name, arguments: named(tool, args, A) })
          const outcome = outcomeOf(result)
          if (outcome === 'crashed') problems.push(`${label}: failed instead of answering`)
          const seen = traces(JSON.stringify(result), seeded.b, B_CANARY, args)
          if (seen.length) problems.push(`${label}: ${seen.join(', ')}`)
          // A change aimed at a row A does not have is refused by the tool itself, before anything waits for a person;
          // a business-wide change (BUSINESS_WIDE) can only be a change of A.
          if (!tool.readOnly) {
            changeTools.add(tool.name)
            if (BUSINESS_WIDE.has(tool.name)) {
              if (outcome === 'queued') queuedInA += 1
              else problems.push(`${label}: ${outcome}, not a change of A waiting in A: ${textOf(result).slice(0, 120)}`)
            } else if (CREATES.has(tool.name)) {
              // A new product of A's own: it waits for a person in A, and names nothing of B.
              if (outcome === 'queued') queuedCreates += 1
              else problems.push(`${label}: ${outcome}, not queued: ${textOf(result).slice(0, 120)}`)
            } else if (outcome !== 'refused' || !/not found/i.test(textOf(result))) problems.push(`${label}: ${outcome}, not "not found": ${textOf(result).slice(0, 120)}`)
          }
        }
      })
      expect(problems).toEqual([])
      expect(changeTools.size).toBe(offered.filter((tool) => !tool.readOnly).length)
      expect(changeTools.size).toBeGreaterThan(0)
      // Only the business-wide changes and the creations wait, each a change of A's own.
      expect(queuedInA).toBe([...BUSINESS_WIDE].filter((name) => changeTools.has(name)).length)
      expect(await approvalsInA()).toBe(queuedBefore + queuedInA + queuedCreates)
      expect(await digest(B)).toEqual(before)
    })

    it('identity (I2, I3, I5): an Item ID both businesses hold — A sees no duplicate, finds only its own family, and is told B holds it only because its person is a member of B', async () => {
      // One eBay Item ID: on one family in A, on two families in B. Inside B the check finds B's duplicate (control);
      // A's check, run as the restricted runtime login, counts A's family only and never names B's.
      const item = `IDN-ITEM-${RUN}`
      const skus = { a: `ALPHA-IDN-${RUN.toUpperCase()}`, b1: `BRAVO-IDN1-${RUN.toUpperCase()}`, b2: `BRAVO-IDN2-${RUN.toUpperCase()}` }
      const family = async (workspaceId: string, sku: string, market: string) => {
        const product = await database.client.product.create({ data: { sku, name: sku, basePrice: '9.90' } })
        await database.client.channelListing.create({
          data: { productId: product.id, channelMarket: 'EBAY_IT', channel: 'EBAY', region: 'IT', marketplace: market, listingStatus: 'ACTIVE', externalListingId: item },
        })
        return product.id
      }
      const ids = {
        a: await inside(A, () => family(A, skus.a, seeded.a.market)),
        b1: await inside(B, () => family(B, skus.b1, seeded.b.market)),
        b2: await inside(B, () => family(B, skus.b2, seeded.b.market)),
      }
      const duplicates = (text: string) => (JSON.parse(text).findings as Array<{ check: string; examples: Array<{ details?: { externalId?: string; families?: string[] } }> }>)
        .filter((line) => line.check === 'channel-id-on-two-families')
        .flatMap((line) => line.examples.filter((example) => example.details?.externalId === item).map((example) => example.details?.families))
      const audit = { name: 'identity-audit', arguments: { checks: ['channel-id-on-two-families'], examples: 5 } }
      const inB = await withClaude(tokens.bOwn.access, 'B-control', (client) => client.callTool(audit))
      expect(duplicates(textOf(inB))).toEqual([[skus.b1, skus.b2].sort()])
      const inA = await withClaude(tokens.a.access, 'A', async (client) => ({
        audit: textOf(await client.callTool(audit)),
        issues: textOf(await client.callTool({ name: 'identity-issues', arguments: { checks: ['channel-id-on-two-families'], limit: 100 } })),
      }))
      expect(duplicates(inA.audit)).toEqual([])
      // I3 — find-by-id names A's family only; B's product is not found by product-identity from A (control: in B it is).
      const found = (text: string) => (JSON.parse(text).matches as Array<{ matchedAs: string; productId?: string }>)
        .map((match) => `${match.matchedAs} ${match.productId}`)
      const lookup = { name: 'find-by-id', arguments: { query: item } }
      const fromA = await withClaude(tokens.a.access, 'A', async (client) => ({
        find: textOf(await client.callTool(lookup)),
        family: await client.callTool({ name: 'product-identity', arguments: { productId: ids.b1 } }),
      }))
      expect(found(fromA.find)).toEqual([`eBay Item ID ${ids.a}`])
      // I5 — and that B holds it too: named, because the person behind A's token is a member of B.
      expect(JSON.parse(fromA.find).elsewhere).toEqual([{ channel: 'EBAY', heldBy: NAMES[B], listings: 2 }])
      expect(fromA.family.isError).toBe(true)
      expect(errorOf(fromA.family)).toBe('Product not found')
      const fromB = await withClaude(tokens.bOwn.access, 'B-control', async (client) => ({
        find: textOf(await client.callTool(lookup)),
        family: textOf(await client.callTool({ name: 'product-identity', arguments: { productId: ids.b1 } })),
      }))
      expect(found(fromB.find).sort()).toEqual([`eBay Item ID ${ids.b1}`, `eBay Item ID ${ids.b2}`].sort())
      expect(JSON.parse(fromB.family).family).toMatchObject({ rootProductId: ids.b1, rootSku: skus.b1 })
      // I5 — check #2 asks the cross-business function: the person behind A's token is also a member of B, so B is named
      // to them; B's B-only person is no member of A, so A stays "another business".
      const elsewhere = (text: string) => (JSON.parse(text).findings as Array<{ examples: Array<{ details?: { externalId?: string; heldBy?: string[] } }> }>)
        .flatMap((line) => line.examples.filter((example) => example.details?.externalId === item).map((example) => example.details?.heldBy))
      const crossAudit = { name: 'identity-audit', arguments: { checks: ['channel-id-in-another-business'], examples: 5 } }
      expect(elsewhere(textOf(await withClaude(tokens.a.access, 'A', (client) => client.callTool(crossAudit))))).toEqual([[NAMES[B]]])
      expect(elsewhere(textOf(await withClaude(tokens.bOnly.access, 'B-only', (client) => client.callTool(crossAudit))))).toEqual([['another business']])
      for (const text of [inA.audit, inA.issues, fromA.find, textOf(fromA.family)]) {
        for (const leaked of [skus.b1, skus.b2, ids.b1, ids.b2, B_CANARY]) {
          // product-identity was handed B's id: it may repeat what it was sent, nothing more.
          if (text === textOf(fromA.family) && leaked === ids.b1) continue
          expect(text).not.toContain(leaked)
        }
      }
    })
  })

  describe('1b — the ad reads (MCP full control A2, A13, T4)', () => {
    /** Each read aimed at one of business B's ad rows by its id. */
    const aimed = (): Array<[string, Record<string, unknown>]> => [
      ['ad-changes', { channel: 'ebay', campaignId: seeded.b.ebayCampaignId }],
      ['ad-recommendations', { channel: 'ebay', campaignId: seeded.b.ebayCampaignId }],
      ['ebay-ad-details', { campaignId: seeded.b.ebayCampaignId }],
      ['ad-targets', { campaignId: seeded.b.campaignId }],
      ['ad-targets', { adGroupId: seeded.b.adGroupId }],
      ['ad-search-terms', { campaignId: seeded.b.campaignId }],
      ['ad-changes', { campaignId: seeded.b.campaignId }],
      ['ad-changes', { targetId: seeded.b.targetId }],
      ['ad-recommendations', { campaignId: seeded.b.campaignId }],
    ]

    it("business B's campaign, ad group and target ids read as not found from A, and B's Amazon and eBay lists never show in A; inside B they read (control)", async () => {
      const missed: string[] = []
      await withClaude(tokens.bOwn.access, 'B-control', async (client) => {
        const lists: Array<[string, Record<string, unknown>]> = [
          ['ad-campaigns', {}], ['ads-overview', {}], ['ad-campaigns', { channel: 'ebay' }], ['ads-overview', { channel: 'ebay' }],
        ]
        for (const [name, args] of [...aimed(), ...lists]) {
          const result = await client.callTool({ name, arguments: args })
          if (outcomeOf(result) !== 'answered' || traces(textOf(result), seeded.b, B_CANARY, args).length === 0) missed.push(`${name} ${JSON.stringify(args)} → ${textOf(result).slice(0, 160)}`)
        }
      })
      expect(missed).toEqual([])

      const problems: string[] = []
      await withClaude(tokens.a.access, 'A', async (client) => {
        for (const [name, args] of aimed()) {
          const result = await client.callTool({ name, arguments: args })
          if (outcomeOf(result) !== 'refused' || !/not found/i.test(errorOf(result))) problems.push(`${name} ${JSON.stringify(args)}: ${outcomeOf(result)} ${textOf(result).slice(0, 120)}`)
          const seen = traces(JSON.stringify(result), seeded.b, B_CANARY, args)
          if (seen.length) problems.push(`${name}: ${seen.join(', ')}`)
        }
        const lists: Array<[string, Record<string, unknown>, string | null]> = [
          ['ad-campaigns', {}, seeded.a.campaignId], ['ads-overview', {}, seeded.a.campaignId], ['ad-targets', {}, seeded.a.campaignId],
          ['ad-search-terms', {}, null], ['ad-changes', {}, null], ['ad-recommendations', {}, null],
          // A13 — eBay: A's own eBay campaign is listed (control), B's never.
          ['ad-campaigns', { channel: 'ebay' }, seeded.a.ebayCampaignId], ['ads-overview', { channel: 'ebay' }, seeded.a.ebayCampaignId],
          ['ad-changes', { channel: 'ebay' }, null], ['ad-recommendations', { channel: 'ebay' }, seeded.a.ebayCampaignId],
          // T4 — the eBay ad details open A's own live campaigns (control), never B's.
          ['ebay-ad-details', {}, seeded.a.ebayCampaignId],
        ]
        for (const [name, args, own] of lists) {
          const result = await client.callTool({ name, arguments: args })
          const text = textOf(result)
          if (outcomeOf(result) !== 'answered') problems.push(`${name} ${JSON.stringify(args)}: ${outcomeOf(result)} ${text.slice(0, 120)}`)
          const seen = traces(JSON.stringify(result), seeded.b, B_CANARY)
          if (seen.length) problems.push(`${name} ${JSON.stringify(args)}: ${seen.join(', ')}`)
          // Control: A's own lists do read A's ad rows.
          if (own && !text.includes(own)) problems.push(`${name} ${JSON.stringify(args)}: A's own campaign is missing`)
        }
      })
      expect(problems).toEqual([])
    })
  })

  describe('2 — only the token names the business', () => {
    it('token A with B in the header, the query or both is refused with 400, and nothing runs', async () => {
      const before = await counts()
      for (const request of [listRequest, callRequest('product-snapshot', { productId: seeded.b.productId })]) {
        for (const naming of [
          { headers: { 'x-nexus-workspace-id': B } },
          { query: `?workspaceId=${B}` },
          { headers: { 'x-nexus-workspace-id': B }, query: `?workspaceId=${B}` },
        ]) {
          const answer = await post('A', request, { token: tokens.a.access, ...naming })
          expect(answer.status).toBe(400)
          expect(rpcOf(answer.text).error?.message).toBe('The business comes from your Nexus connection. Do not name one.')
        }
      }
      expect(await counts()).toEqual(before)
    })
  })

  describe('5 — ending a connection', () => {
    it("B's admin can neither see nor end A's connection, not as admin and not as a person", async () => {
      const listed = await inApp('B-only', 'GET', '/api/connected-apps', sessions.bOnly, B)
      expect(listed.statusCode).toBe(200)
      const ids = (listed.json() as { grants: Array<{ id: string }> }).grants.map((grant) => grant.id)
      expect(ids).toEqual(expect.arrayContaining([tokens.bOwn.grantId, tokens.bOnly.grantId])) // control: B's own
      expect(ids).not.toContain(tokens.a.grantId)
      expect(ids).not.toContain(tokens.aSecond.grantId)
      const asAdmin = await inApp('B-only', 'POST', `/api/connected-apps/${tokens.aSecond.grantId}/revoke`, sessions.bOnly, B, {})
      expect(asAdmin.statusCode).toBe(404)
      const asPerson = await inApp('B-only', 'POST', `/api/settings/connected-apps/${tokens.aSecond.grantId}/revoke`, sessions.bOnly, undefined, {})
      expect(asPerson.statusCode).toBe(404)
      expect((await post('A', listRequest, { token: tokens.aSecond.access })).status).toBe(200)
    })

    it('the person ends it in Connected apps: the next call is 401, and their other connection still works', async () => {
      const ended = await inApp('A', 'POST', `/api/settings/connected-apps/${tokens.aSecond.grantId}/revoke`, sessions.both, undefined, {})
      expect(ended.statusCode).toBe(200)
      const before = await counts()
      for (const request of [listRequest, callRequest('product-search', {})]) {
        const answer = await post('A', request, { token: tokens.aSecond.access })
        expect(answer.status).toBe(401)
        expect(answer.header('www-authenticate')).toContain('error="invalid_token"')
      }
      expect(await counts()).toEqual(before)
      expect((await post('A', listRequest, { token: tokens.a.access })).status).toBe(200)
    })
  })

  describe('7 — an approval queued in A stays in A', () => {
    /** Two requests from Claude in A: one waiting (set aside by A), one approved and parked in its undo window. */
    const inA = { waiting: '', parked: '' }

    it('Claude queues two changes in A; a person in A sets one aside and approves the other', async () => {
      for (const [slot, price] of [['waiting', 25], ['parked', 26]] as const) {
        const result = await withClaude(tokens.a.access, 'A', (client) =>
          client.callTool({ name: 'set-price', arguments: { productId: seeded.a.productId, price, business: NAMES[A] } }),
        )
        expect(outcomeOf(result)).toBe('queued')
        inA[slot] = JSON.parse(textOf(result)).approvalId
        seeded.a.keys.push(inA[slot])
      }
      // States a write from B would visibly change: a snooze to clear, a parked approve to undo or hold.
      const until = new Date(Date.now() + 3600_000).toISOString()
      expect((await inApp('A', 'POST', `/api/agent/fleet/approvals/${inA.waiting}/snooze`, sessions.both, A, { until })).statusCode).toBe(200)
      const approved = await inApp('A', 'POST', `/api/agent/fleet/approvals/${inA.parked}/decide`, sessions.both, A, { decision: 'approve' })
      expect(approved.json()).toMatchObject({ ok: true, status: 'scheduled' })
    })

    it('a B-only connection: approval-status says not found (and reads its own business’s approval: control)', async () => {
      await withClaude(tokens.bOnly.access, 'B-only', async (client) => {
        for (const approvalId of [inA.waiting, inA.parked]) {
          const other = await client.callTool({ name: 'approval-status', arguments: { approvalId } })
          expect(other.isError).toBe(true)
          expect(errorOf(other)).toBe('Approval not found')
        }
      })
      const own = await withClaude(tokens.bOnly.access, 'B-control', (client) =>
        client.callTool({ name: 'approval-status', arguments: { approvalId: seeded.b.approvalId } }),
      )
      expect(JSON.parse(textOf(own))).toMatchObject({ approvalId: seeded.b.approvalId, status: 'pending' })
    })

    it('a B session cannot see, read, decide, edit, hold, undo, run or set them aside in the Approvals routes; A is unchanged', async () => {
      const before = await digest(A)
      const rowsBefore = await rowsOf('SELECT * FROM "AgentApproval" WHERE id = ANY($1::text[]) ORDER BY id', [[inA.waiting, inA.parked]])

      // The lists a person reads Claude's requests in (Settings › AI, and the Approvals page's "outside the fleet").
      // Integration: with every part's change tools, the control above queues more requests in B than one page holds
      // (50 newest / 100 oldest), so the seeded one can be off the page. The control is then: a non-empty list, every
      // row B's own; and when the page is not full, the seeded request is on it.
      for (const [path, page] of [['/api/agent/approvals?status=pending', 50], ['/api/agent/fleet/approvals/outside', 100]] as const) {
        const list = await inApp('B-control', 'GET', path, sessions.bOnly, B)
        expect(list.statusCode).toBe(200)
        const ids = (list.json() as { approvals: Array<{ id: string }> }).approvals.map((approval) => approval.id)
        expect(ids.length).toBeGreaterThan(0) // control: B's own queue is there
        expect(await rowsOf('SELECT DISTINCT "workspaceId" FROM "AgentApproval" WHERE id = ANY($1::text[])', [ids])).toEqual([{ workspaceId: B }])
        if (ids.length < page) expect(ids).toContain(seeded.b.approvalId)
        expect(ids).not.toContain(inA.waiting)
        expect(ids).not.toContain(inA.parked)
      }

      // Every action on one approval, and what a request nobody in B can see gets from each.
      const until = new Date(Date.now() + 1800_000).toISOString()
      const actions: Array<[string, unknown, number, Record<string, unknown>]> = [
        ['approvals/:id/approve', {}, 404, { error: 'approval not found' }],
        ['approvals/:id/reject', { reason: 'MCP.8' }, 404, { error: 'approval not found' }],
        ['fleet/approvals/:id/decide', { decision: 'approve' }, 409, { error: 'approval not found' }],
        ['fleet/approvals/:id/decide', { decision: 'reject', reason: 'MCP.8' }, 409, { error: 'approval not found' }],
        ['fleet/approvals/:id/amend', { args: { price: 1 } }, 404, { error: 'approval not found' }],
        ['fleet/approvals/:id/hold', {}, 404, { error: 'approval not found' }],
        ['fleet/approvals/:id/undo', {}, 409, { error: 'nothing to undo' }],
        ['fleet/approvals/:id/commit', {}, 409, { error: 'approval not found' }],
        ['fleet/approvals/:id/snooze', { until }, 404, { error: 'approval not found' }],
        ['fleet/approvals/:id/unsnooze', {}, 404, { error: 'approval not found' }],
        ['fleet/approvals/:id/recheck', {}, 200, { stale: true, why: 'the request no longer exists' }],
      ]
      for (const id of [inA.waiting, inA.parked]) {
        for (const [action, payload, status, body] of actions) {
          const path = `/api/agent/${action.replace(':id', id)}`
          const answer = await inApp('B-only', 'POST', path, sessions.bOnly, B, payload)
          expect({ action, status: answer.statusCode, body: answer.json() }).toMatchObject({ action, status, body })
        }
        const read = await inApp('B-only', 'POST', '/api/agent/tools/approval-status/invoke', sessions.bOnly, B, { approvalId: id })
        expect(read.json()).toMatchObject({ ok: false, error: 'Approval not found' })
      }
      // Both at once, as the bulk bar sends them: nothing to preview, nothing decided.
      const ids = [inA.waiting, inA.parked]
      const preview = await inApp('B-only', 'POST', '/api/agent/fleet/approvals/bulk-preview', sessions.bOnly, B, { ids, decision: 'approve' })
      expect(preview.json()).toMatchObject({ count: 0 })
      for (const payload of [{ ids, decision: 'approve' }, { ids, decision: 'reject', reason: 'MCP.8' }]) {
        const bulk = await inApp('B-only', 'POST', '/api/agent/fleet/approvals/bulk-decide', sessions.bOnly, B, payload)
        expect({ decision: payload.decision, done: (bulk.json() as { done?: number }).done }).toEqual({ decision: payload.decision, done: 0 })
        // Each id comes back as B sent it, with the words an id no business has gets: nothing says A holds it.
        const nobodys = await inApp('B-only', 'POST', '/api/agent/fleet/approvals/bulk-decide', sessions.bOnly, B, { ...payload, ids: [`mcp8-no-such-${RUN}`] })
        const why = (nobodys.json() as { skipped: Array<{ why: string }> }).skipped[0].why
        expect(why).toMatch(/cannot find/)
        expect((bulk.json() as { skipped?: unknown }).skipped).toEqual(ids.map((id) => ({ id, why })))
      }

      expect(await rowsOf('SELECT * FROM "AgentApproval" WHERE id = ANY($1::text[]) ORDER BY id', [[inA.waiting, inA.parked]])).toEqual(rowsBefore)
      expect(await digest(A)).toEqual(before)

      // Control: the same session and route decide an approval of its own business.
      const own = await inApp('B-control', 'POST', `/api/agent/approvals/${seeded.b.spareApprovalId}/reject`, sessions.bOnly, B, { reason: 'MCP.8 control' })
      expect(own.statusCode).toBe(200)
      expect(own.json()).toMatchObject({ ok: true, status: 'rejected' })
    })
  })

  describe('8 — a tool policy belongs to one business', () => {
    it("a tool turned off in one business is refused there at once and still runs in the other within the cache's minute; both ways", async () => {
      const setPolicy = (tag: Tag, session: string, business: string, name: string, enabled: boolean) =>
        inApp(tag, 'PUT', `/api/agent/tools/${name}`, session, business, { enabled })
      const call = (token: string, tag: Tag, name: string) => withClaude(token, tag, (client) => client.callTool({ name, arguments: {} }))
      const b = { id: B, session: sessions.bOnly, sessionTag: 'B-only' as Tag, token: tokens.bOwn.access, tag: 'B-control' as Tag, sees: seeded.b.market }
      const a = { id: A, session: sessions.both, sessionTag: 'A' as Tag, token: tokens.a.access, tag: 'A' as Tag, sees: seeded.a.sku }
      for (const [off, on, name] of [[b, a, 'product-search'], [a, b, 'order-search']] as const) {
        // An admin turns it off in Settings, which empties that business's policy cache; the refused call refills it.
        expect((await setPolicy(off.sessionTag, off.session, off.id, name, false)).statusCode).toBe(200)
        expect({ name, in: off.id, answer: errorOf(await call(off.token, off.tag, name)) }).toEqual({ name, in: off.id, answer: `tool ${name} is disabled` })
        // Straight after, well inside the 60 s the cache keeps a policy: the other business still runs it.
        const ran = await call(on.token, on.tag, name)
        expect({ name, in: on.id, outcome: outcomeOf(ran) }).toEqual({ name, in: on.id, outcome: 'answered' })
        expect(textOf(ran)).toContain(on.sees)
        expect((await setPolicy(off.sessionTag, off.session, off.id, name, true)).statusCode).toBe(200)
      }
    })
  })

  describe('9 — one URL per business (C4), and the same SKU in both businesses', () => {
    /** Three SKUs both businesses sell (shared stock by SKU): each business has its own product rows for them. */
    const shared = [1, 2, 3].map((n) => `SHARED-${RUN.toUpperCase()}-${n}`)
    const sharedIds = { a: [] as string[], b: [] as string[] }
    const own = {} as Record<'a' | 'b', { access: string; grantId: string }>
    const at = (workspaceId: string) => url.replace(/\/mcp$/, `/mcp/w/${workspaceId}`)
    const call = (token: string, tag: Tag, workspaceId: string, name: string, args: Record<string, unknown>) =>
      withClaudeAt(at(workspaceId), token, tag, (client) => client.callTool({ name, arguments: args }))

    it('both businesses get the same three SKUs; the person connects Claude to each at that business’s own URL', async () => {
      for (const [key, workspaceId, canary] of [['a', A, A_CANARY], ['b', B, B_CANARY]] as const) {
        await inside(workspaceId, async () => {
          for (const sku of shared) {
            const product = await database.client.product.create({
              data: { sku, name: `${canary}-SHARED-${sku}`, basePrice: key === 'a' ? '30.00' : '40.00', totalStock: 3 },
            })
            sharedIds[key].push(product.id)
            seeded[key].keys.push(product.id)
          }
        })
      }
      clients['Claude per business'] = String((await registerClient({ client_name: 'Claude per business', redirect_uris: [CALLBACK] })).client_id)
      own.a = await connect(people.both, 'Claude per business', A, `${API}/mcp/w/${A}`)
      own.b = await connect(people.both, 'Claude per business', B, `${API}/mcp/w/${B}`)
      // Control: B's URL reads B's rows for the shared SKUs.
      const inB = await call(own.b.access, 'B-control', B, 'product-search', { query: shared[0].slice(0, -2) })
      expect(textOf(inB)).toContain(sharedIds.b[0])
    })

    it('a token for one business’s URL is refused at the other’s and at the plain URL, and nothing runs', async () => {
      const before = await counts()
      for (const [token, target] of [[own.a.access, at(B)], [own.b.access, at(A)], [own.a.access, url], [tokens.a.access, at(A)]] as const) {
        const answer = await postTo(target, 'A', listRequest, token)
        expect({ target, status: answer.status }).toEqual({ target, status: 401 })
        expect(answer.header('www-authenticate')).toContain('error="invalid_token"')
      }
      expect(await counts()).toEqual(before)
    })

    it('at A’s URL the shared SKUs are A’s rows only: a read, a change by id, a bulk change by SKU; naming B is refused; B is unchanged', async () => {
      const beforeB = await digest(B)
      const queuedInA = async () => (await rowsOf<{ n: number }>('SELECT count(*)::int AS n FROM "AgentApproval" WHERE "workspaceId" = $1', [A]))[0].n
      const start = await queuedInA()

      const search = JSON.parse(textOf(await call(own.a.access, 'A', A, 'product-search', { query: shared[0].slice(0, -2) })))
      expect(search.business).toEqual({ id: A, name: NAMES[A] })
      expect(search.products.map((p: { id: string }) => p.id).sort()).toEqual([...sharedIds.a].sort())

      // B's row of a shared SKU, by its id, from A's URL: not found, nothing queued.
      const other = await call(own.a.access, 'A', A, 'set-price', { productId: sharedIds.b[0], price: 31, business: NAMES[A] })
      expect(outcomeOf(other)).toBe('refused')
      expect(errorOf(other)).toMatch(/not found/i)
      expect(await queuedInA()).toBe(start)

      // The same SKU's A row: queued in A, for A's product.
      const mine = JSON.parse(textOf(await call(own.a.access, 'A', A, 'set-price', { productId: sharedIds.a[0], price: 31, business: NAMES[A] })))
      expect(mine).toMatchObject({ business: { id: A, name: NAMES[A] }, status: 'waiting_for_approval' })
      seeded.a.keys.push(mine.approvalId)
      const [row] = await rowsOf<{ workspaceId: string; args: { productId: string } }>('SELECT "workspaceId", args FROM "AgentApproval" WHERE id = $1', [mine.approvalId])
      expect(row).toMatchObject({ workspaceId: A, args: { productId: sharedIds.a[0] } })

      // A bulk change by SKU resolves each SKU in A alone: A's master prices are 30, B's 40.
      const bulk = JSON.parse(textOf(await call(own.a.access, 'A', A, 'bulk-price-change', { products: shared, operation: 'percent', value: 5, business: NAMES[A] })))
      expect(bulk.status).toBe('waiting_for_approval')
      seeded.a.keys.push(bulk.approvalId)
      expect(bulk.preview.totals).toMatchObject({ products: 3, changing: 3 })
      expect(Object.values(bulk.preview.changes as Record<string, { from: number; to: number }>)).toEqual(shared.map(() => ({ from: 30, to: 31.5 })))

      // The right connection with the other business's name: refused, nothing queued.
      const named = await call(own.a.access, 'A', A, 'set-price', { productId: sharedIds.a[1], price: 32, business: NAMES[B] })
      expect(errorOf(named)).toBe(`This connection works in ${NAMES[A]}; you named ${NAMES[B]}. Nothing was queued.`)

      expect(await queuedInA()).toBe(start + 2)
      expect(await digest(B)).toEqual(beforeB)
    })
  })

  describe('10 — a trust level or a Pause one business sets never applies in the other (C5)', () => {
    const run = {} as Record<'a' | 'b', { access: string; grantId: string }>
    const RUN_SCOPES = ['nexus.read', 'nexus.write', 'nexus.run']
    const setPrice = (token: string, tag: Tag, productId: string, workspaceId: string) =>
      withClaude(token, tag, (client) => client.callTool({ name: 'set-price', arguments: { productId, price: 20.5, business: NAMES[workspaceId] } }))

    it('B lets Claude run set-price by rule: from B a small change is scheduled by the rule; from A it waits for a person', async () => {
      clients['Claude run'] = String((await registerClient({ client_name: 'Claude run', redirect_uris: [CALLBACK] })).client_id)
      run.a = await connect(people.both, 'Claude run', A, `${API}/mcp`, RUN_SCOPES)
      run.b = await connect(people.both, 'Claude run', B, `${API}/mcp`, RUN_SCOPES)
      __stepUpTest.reset()
      const saved = await inApp('B-only', 'PUT', '/api/claude/trust/set-price', sessions.bOnly, B, { level: 'auto', code: generateSync({ secret }) })
      expect(saved.statusCode, saved.body).toBe(200)

      const inB = JSON.parse(textOf(await setPrice(run.b.access, 'B-control', seeded.b.productId, B)))
      expect(inB).toMatchObject({ business: { id: B }, status: 'runs_by_rule' })
      const [row] = await rowsOf<{ workspaceId: string; status: string; decisionVia: string }>('SELECT "workspaceId", status, "decisionVia" FROM "AgentApproval" WHERE id = $1', [inB.approvalId])
      expect(row).toEqual({ workspaceId: B, status: 'scheduled', decisionVia: 'auto' })
      seeded.b.keys.push(inB.approvalId)

      const inA = JSON.parse(textOf(await setPrice(run.a.access, 'A', seeded.a.productId, A)))
      expect(inA).toMatchObject({ business: { id: A }, status: 'waiting_for_approval' })
      expect(inA).not.toHaveProperty('trust')
      seeded.a.keys.push(inA.approvalId)
      const rulesA = await inApp('A', 'GET', '/api/claude/trust', sessions.both, A)
      expect((rulesA.json() as { tools: Array<{ name: string; level: string }> }).tools.find((tool) => tool.name === 'set-price')).toMatchObject({ level: 'ask' })
    })

    it("B's Pause hands B's rule-run back to a person at once and leaves A as it was", async () => {
      const queuedInA = await rowsOf('SELECT id, status, "decisionVia" FROM "AgentApproval" WHERE "workspaceId" = $1 ORDER BY id', [A])
      const paused = await inApp('B-only', 'POST', '/api/claude/pause', sessions.bOnly, B, { reason: 'MCP.8 C5 check' })
      expect(paused.statusCode, paused.body).toBe(200)
      expect(paused.json()).toMatchObject({ ok: true, handedBack: 1 })
      const inB = await inApp('B-control', 'GET', '/api/claude/trust', sessions.bOnly, B)
      expect((inB.json() as { autonomy: unknown }).autonomy).toMatchObject({ paused: true, reason: 'MCP.8 C5 check' })
      const inA = await inApp('A', 'GET', '/api/claude/trust', sessions.both, A)
      expect((inA.json() as { autonomy: unknown }).autonomy).toMatchObject({ paused: false })
      expect(await rowsOf('SELECT id, status, "decisionVia" FROM "AgentApproval" WHERE "workspaceId" = $1 ORDER BY id', [A])).toEqual(queuedInA)
      // A session of A cannot lift B's pause either: it is not B's to touch from A.
      __stepUpTest.reset()
      expect((await inApp('A', 'POST', '/api/claude/resume', sessions.both, A, { code: generateSync({ secret }) })).json()).toMatchObject({ ok: true, paused: false })
      expect(((await inApp('B-control', 'GET', '/api/claude/trust', sessions.bOnly, B)).json() as { autonomy: unknown }).autonomy).toMatchObject({ paused: true })
    })

    it("C8 — each business's activity list holds its own Claude calls only", async () => {
      type Page = { rows: Array<{ runId: string; connection: { id: string | null } }> }
      const list = async (tag: Tag, session: string, workspaceId: string) => {
        const answer = await inApp(tag, 'GET', '/api/claude/activity?limit=100', session, workspaceId)
        expect(answer.statusCode, answer.body).toBe(200)
        return (answer.json() as Page).rows
      }
      const inB = await list('B-control', sessions.bOnly, B)
      const inA = await list('A', sessions.both, A)
      expect(inB.length).toBeGreaterThan(0)
      expect(inA.length).toBeGreaterThan(0)
      const grantsOf = async (workspaceId: string) =>
        new Set((await rowsOf<{ id: string }>('SELECT id FROM "OAuthGrant" WHERE "workspaceId" = $1', [workspaceId])).map((row) => row.id))
      const [aGrants, bGrants] = [await grantsOf(A), await grantsOf(B)]
      expect(inB.filter((row) => !bGrants.has(row.connection.id ?? ''))).toEqual([])
      expect(inA.filter((row) => !aGrants.has(row.connection.id ?? ''))).toEqual([])
      const [runsInB] = await rowsOf<{ n: number }>(`SELECT count(*)::int AS n FROM "AgentRun" WHERE "workspaceId" = $1 AND via = 'claude'`, [B])
      expect(inB).toHaveLength(Math.min(100, runsInB.n))

      // Undo on the activity page: A's change is not found from a B session, and nothing in A moves.
      const beforeA = await digest(A)
      const fromB = await inApp('B-only', 'POST', `/api/claude/changes/${seeded.a.changeId}/undo`, sessions.bOnly, B, {})
      expect(fromB.statusCode).toBe(404)
      expect(await digest(A)).toEqual(beforeA)
      // Control: the same session reaches B's own change — test 1's probe from B already asked for its undo.
      const own = await inApp('B-control', 'POST', `/api/claude/changes/${seeded.b.changeId}/undo`, sessions.bOnly, B, {})
      expect(own.statusCode, own.body).toBe(409)
      expect((own.json() as { error: string }).error).toContain('An undo of this change is already waiting')
    })
  })

  describe('11 — a shared account is named only to its members (MCP full control P4)', () => {
    it("B shares an account with A: A's Claude sees it by its owner's name, B sees it shared out; revoked, A no longer sees it", async () => {
      const db = database.client
      // No canary: a shared account is MEANT to be seen by the business it is shared with.
      const label = `MCP8 shared account ${RUN}`
      const shared = await inside(B, () =>
        db.channelConnection.create({ data: { channelType: 'SHOPIFY', managedBy: 'oauth', isActive: true, accountLabel: label, authStatus: 'connected', externalAccountId: `SHARED-${RUN}` } }),
      )
      const share = (revokedAt: Date | null) =>
        inside(B, () =>
          db.channelAccountGrant.upsert({
            where: { connectionId_workspaceId: { connectionId: shared.id, workspaceId: A } },
            create: { connectionId: shared.id, workspaceId: A, ownerWorkspaceId: B, grantedByUserId: people.owner, mode: 'read', marketplaces: [] },
            update: { revokedAt },
          }),
        )
      type Listed = { business: { id: string }; accounts: Array<{ id: string; label: string; ownedHere: boolean; sharedBy?: string; sharedWithBusinesses?: number }> }
      const accounts = async (token: string, tag: Tag) =>
        JSON.parse(textOf(await withClaude(token, tag, (client) => client.callTool({ name: 'channel-connections', arguments: {} })))) as Listed
      // Before the share: A does not see it (it is B's own account), B does.
      expect((await accounts(tokens.a.access, 'A')).accounts.map((row) => row.id)).not.toContain(shared.id)
      await share(null)
      try {
        const inA = await accounts(tokens.a.access, 'A')
        expect(inA.business.id).toBe(A)
        expect(inA.accounts.find((row) => row.id === shared.id)).toMatchObject({ label, ownedHere: false, sharedBy: NAMES[B] })
        // Only that one: B's own account stays B's.
        expect(inA.accounts.map((row) => row.id)).not.toContain(seeded.b.connectionId)
        const inB = await accounts(tokens.bOnly.access, 'B-control')
        expect(inB.accounts.find((row) => row.id === shared.id)).toMatchObject({ ownedHere: true, sharedWithBusinesses: 1 })
        await share(new Date())
        expect((await accounts(tokens.a.access, 'A')).accounts.map((row) => row.id)).not.toContain(shared.id)
      } finally {
        await share(new Date())
      }
    })
  })

  describe('4 — a permission taken away holds from the next call', () => {
    it("the person's role in A loses products.price.edit: set-price leaves tools/list and is refused, nothing is queued, B is unaffected", async () => {
      const [role] = await rowsOf<{ version: number; name: string }>('SELECT version, name FROM "Role" WHERE id = $1', [roles.a])
      const saved = await inApp('A', 'PATCH', `/api/workspaces/${A}/roles/${roles.a}`, sessions.owner, undefined, {
        name: role.name,
        description: 'test',
        permissions: ALL_PERMISSIONS.filter((permission) => permission !== FEATURES.productsPriceEdit),
        version: role.version,
      })
      expect(saved.statusCode, saved.body).toBe(200)

      const before = await counts()
      const listed = rpcOf((await post('A', listRequest, { token: tokens.a.access })).text).result?.tools?.map((tool) => tool.name) ?? []
      expect(listed).toContain('product-search')
      expect(listed).not.toContain('set-price')
      const call = rpcOf((await post('A', callRequest('set-price', { productId: seeded.a.productId, price: 30, business: NAMES[A] }), { token: tokens.a.access })).text)
      const refusal = call.error?.message ?? (call.result?.isError ? textOf(call.result) : '')
      expect(refusal).toContain('set-price')
      expect(await counts()).toEqual(before)

      // The same person's role in B is its own: B still offers set-price.
      const inB = rpcOf((await post('B-control', listRequest, { token: tokens.bOwn.access })).text).result?.tools?.map((tool) => tool.name)
      expect(inB).toContain('set-price')
    })
  })

  describe('3 — leaving a business ends Claude’s access to it at once', () => {
    it('an owner removes the person from A in Team & Access: the very next call is 401 and nothing runs; their B connection still works', async () => {
      expect((await post('A', listRequest, { token: tokens.a.access })).status).toBe(200)
      const [member] = await rowsOf<{ id: string; version: number }>(
        'SELECT id, version FROM "WorkspaceMembership" WHERE "workspaceId" = $1 AND "userId" = $2',
        [A, people.both],
      )
      const removed = await inApp('A', 'PATCH', `/api/workspaces/${A}/members/${member.id}`, sessions.owner, undefined, {
        roleIds: [roles.a],
        status: 'revoked',
        version: member.version,
      })
      expect(removed.statusCode, removed.body).toBe(200)

      const before = await counts()
      for (const request of [listRequest, callRequest('product-search', {})]) {
        const answer = await post('A', request, { token: tokens.a.access })
        expect(answer.status).toBe(401)
        expect(answer.header('www-authenticate')).toContain('error="invalid_token"')
      }
      expect(await counts()).toEqual(before)
      expect((await post('B-control', listRequest, { token: tokens.bOwn.access })).status).toBe(200)
    })
  })

  describe('6 — no trace of B outside B', () => {
    it('no B canary in any answer given outside B; nothing of A in any answer given to B', async () => {
      const all = await Promise.all(answers.map(async ({ tag, text, sent }) => ({ tag, text: await text, sent })))
      // Control: the scan finds a canary where one belongs (B reading its own rows through /mcp).
      expect(all.some(({ tag, text }) => tag === 'B-control' && text.toUpperCase().includes(B_CANARY))).toBe(true)
      expect(all.filter(({ tag }) => tag === 'A').length).toBeGreaterThan(40)
      const outsideB = all.filter(({ tag, text }) => tag !== 'B-control' && text.toUpperCase().includes(B_CANARY))
      expect(outsideB.map(({ tag, text }) => `${tag}: ${text.slice(0, 200)}`)).toEqual([])
      // An id B sent itself may come back with "not found" (bulk-decide names each request it skipped, #329): the same
      // answer as for an id no business has, so it tells B nothing. Anything else of A, or A's canary, is a trace.
      const toB = all.filter(({ tag, text, sent }) => tag !== 'A' && traces(text, seeded.a, A_CANARY, sent).length > 0)
      expect(toB.map(({ tag, text, sent }) => `${tag}: ${traces(text, seeded.a, A_CANARY, sent).join(', ')}`)).toEqual([])
    })

    it('no B canary in any log line written during the suite', () => {
      const marker = `MCP8-LOG-${RUN}`
      logger.warn('[mcp8] log capture check', { marker })
      expect(logLines.some((line) => line.includes(marker))).toBe(true) // control: the logger's lines are caught
      expect(logLines.filter((line) => line.toUpperCase().includes(B_CANARY))).toEqual([])
    })

    it('no B canary in any AgentRun or AgentApproval written outside B; every run is filed under its connection’s business', async () => {
      const before = [...seeded.a.agentRows, ...seeded.b.agentRows]
      const rows = await rowsOf<{ t: string; workspaceId: string | null; via: string | null; grantWorkspace: string | null; oauthGrantId: string | null; row: string }>(
        `SELECT 'AgentRun' AS t, r."workspaceId", r.via, r."oauthGrantId", g."workspaceId" AS "grantWorkspace", to_jsonb(r)::text AS row
           FROM "AgentRun" r LEFT JOIN "OAuthGrant" g ON g.id = r."oauthGrantId" WHERE NOT (r.id = ANY($1::text[]))
         UNION ALL
         SELECT 'AgentApproval', a."workspaceId", NULL, NULL, NULL, to_jsonb(a)::text FROM "AgentApproval" a WHERE NOT (a.id = ANY($1::text[]))`,
        [before],
      )
      const inA = rows.filter((row) => row.workspaceId === A)
      expect(inA.filter((row) => row.t === 'AgentRun').length).toBeGreaterThanOrEqual(listTools().filter((tool) => offeredOn(tool, 'mcp')).length)
      const outsideB = rows.filter((row) => row.workspaceId !== B)
      expect(outsideB.filter((row) => row.row.toUpperCase().includes(B_CANARY)).map((row) => `${row.t} ${row.row.slice(0, 200)}`)).toEqual([])
      // Claude's runs: each under its connection's business. The only runs from the app door here are B's Undo clicks
      // on the activity page (test 10): filed in B.
      const misfiled = rows.filter((row) => row.t === 'AgentRun' && row.via !== 'app' && (!row.oauthGrantId || row.grantWorkspace !== row.workspaceId))
      expect(misfiled.map((row) => row.row.slice(0, 200))).toEqual([])
      const fromApp = rows.filter((row) => row.t === 'AgentRun' && row.via === 'app')
      expect(fromApp.length).toBe(2)
      expect(fromApp.filter((row) => row.workspaceId !== B || row.oauthGrantId)).toEqual([])
    })
  })
})

/**
 * MCP full control L9 — close-listing and reopen-listing, run through the one door (call-tool.ts) on
 * `listing-close.service.ts` and the doors it calls (SCT.6 offer close, the Matrix door, the Etsy state writer), against a
 * real PostgreSQL with the production schema and business-isolation policies (PGlite). Amazon's API, eBay's out-of-stock
 * option and Etsy's writer are faked: no channel is called.
 *
 * Proven here: Amazon closes and reopens one market's offer, never FBA; eBay hides at 0 only with the out-of-stock option
 * ON and follows the stock again on reopen; Etsy goes inactive only while Etsy publishing is live; Shopify and a draft are
 * refused; the record stays, the presence columns say who and why; close and reopen are each other's undo.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'

const state = vi.hoisted(() => ({ db: null as any, option: vi.fn(), getListing: vi.fn(), patch: vi.fn(), etsyState: vi.fn() }))
vi.mock('@nexus/database', async (original) => {
  const { formulaDatabase } = await import('../../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { ...(await original<object>()), default: state.db.client }
})
vi.mock('../../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn(async () => undefined) }))
vi.mock('../../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn(), emitTx: vi.fn() } }))
vi.mock('../../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(async () => undefined), refreshMany: vi.fn(async () => undefined), refreshInTransaction: vi.fn(async () => undefined) } }))
vi.mock('../../channel-delist.service.js', async (original) => ({ ...(await original<object>()), readEbayOutOfStockPreference: state.option }))
vi.mock('../../../clients/amazon-sp-api.client.js', async (original) => ({ ...(await original<object>()), amazonSpApiClient: { getListingsItem: state.getListing, patchPurchasableOffer: state.patch } }))
vi.mock('../../../lib/amazon-sp-client.js', async (original) => ({ ...(await original<object>()), getAmazonSellerId: async () => 'TEST-SELLER' }))
vi.mock('../../etsy/listing-write.service.js', async (original) => ({ ...(await original<object>()), setEtsyListingState: state.etsyState }))

import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'
import { MARKETPLACE_ID_MAP } from '../../amazon/flat-file.service.js'
import { callTool, executeTool, type UserPrincipal } from '../call-tool.js'
import { getTool } from '../tool-registry.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const person = (userId: string): UserPrincipal => ({
  kind: 'user', userId, label: userId,
  permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
  workspace: business, via: 'claude',
})
const claude = person('u-l9-asker')
const approver = person('u-l9-approver')
type Json = Record<string, any>
const db = () => state.db.client
const row = async (id: string) => (await state.db.db.query(`SELECT "offerClosedAt", "offerClosedBy", "listingStatus", quantity, "quantityOverride", "followMasterQuantity", "endedBy", "endedReason" FROM "ChannelListing" WHERE id = $1`, [id])).rows[0]

const dryRun = async (tool: string, args: Json) => (await inside(() => callTool(claude, tool, args))).raw as Json
async function approveAndRun(tool: string, args: Json) {
  const preview = await dryRun(tool, args)
  expect(preview.ok, preview.error).toBe(true)
  const ran = (await inside(() => executeTool(approver, tool, args, { approvedPreview: JSON.parse(JSON.stringify(preview.preview)), via: 'claude' }))).raw as Json
  return { preview: preview.preview as Json, ran }
}

const ids: Record<string, string> = {}
beforeAll(async () => {
  // The presence columns a raw-SQL migration adds (20260913180000_pr_presence).
  await state.db.db.exec('ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "endedAt" TIMESTAMP(3); ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "endedBy" TEXT; ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "endedReason" TEXT;')
  await inside(async () => {
    for (const [channel, code] of [['AMAZON', 'IT'], ['EBAY', 'IT'], ['ETSY', 'GLOBAL'], ['SHOPIFY', 'GLOBAL']]) {
      await db().marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } as never })
    }
    const account = async (channelType: string) => (await db().channelConnection.create({ data: { channelType, accountLabel: `Test ${channelType}`, isActive: true, isPrimary: true, externalAccountId: `TEST-L9-${channelType}` } })).id
    const accounts = { AMAZON: await account('AMAZON'), EBAY: await account('EBAY'), ETSY: await account('ETSY'), SHOPIFY: await account('SHOPIFY') } as Record<string, string>
    ids.parent = (await db().product.create({ data: { sku: 'TEST-SKU-L9', name: 'L9 jacket', basePrice: 10, isParent: true, productType: 'COAT' } })).id
    ids.child = (await db().product.create({ data: { sku: 'TEST-SKU-L9-M', name: 'L9 M', basePrice: 10, totalStock: 4, parentId: ids.parent, productType: 'COAT' } })).id
    ids.fba = (await db().product.create({ data: { sku: 'TEST-SKU-L9-L', name: 'L9 L', basePrice: 10, parentId: ids.parent, productType: 'COAT', fulfillmentMethod: 'FBA' } as never })).id
    const listing = (productId: string, channel: string, marketplace: string, extra: Json = {}) => db().channelListing.create({ data: { productId, channel, marketplace,
      channelMarket: `${channel}_${marketplace}`, region: marketplace, channelConnectionId: accounts[channel], price: 10, quantity: 4, followMasterQuantity: true,
      listingStatus: 'ACTIVE', isPublished: true, externalListingId: `TEST-L9-${channel}-${productId.slice(-4)}`, ...extra } as never })
    ids.amazon = (await listing(ids.child, 'AMAZON', 'IT', { fulfillmentMethod: 'FBM' })).id
    ids.amazonFba = (await listing(ids.fba, 'AMAZON', 'IT', { fulfillmentMethod: 'FBA' })).id
    ids.ebay = (await listing(ids.child, 'EBAY', 'IT')).id
    ids.etsy = (await listing(ids.child, 'ETSY', 'GLOBAL', { externalListingId: '123456789' })).id
    ids.shopify = (await listing(ids.child, 'SHOPIFY', 'GLOBAL')).id
    ids.draft = (await listing(ids.parent, 'EBAY', 'IT', { listingStatus: 'DRAFT', isPublished: false, externalListingId: null, aliasKey: '' , channelConnectionId: null })).id
  })
}, 120_000)
afterAll(async () => { await state.db?.close() }, 60_000)
beforeEach(() => {
  vi.unstubAllEnvs()
  state.option.mockReset(); state.option.mockResolvedValue('UNKNOWN')
  state.getListing.mockResolvedValue({ success: true, rawResponse: { summaries: [{ productType: 'COAT' }], attributes: {
    purchasable_offer: [{ marketplace_id: MARKETPLACE_ID_MAP.IT, currency: 'EUR', our_price: [{ schedule: [{ value_with_tax: 10 }] }] }],
    fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 4 }] } } })
  state.patch.mockReset(); state.patch.mockResolvedValue({ success: true })
  state.etsyState.mockReset(); state.etsyState.mockResolvedValue({ sent: true, state: 'inactive' })
})

describe('Amazon', () => {
  it('closes one market\'s offer as approved, records who and why; reopen is its undo and reopens from the snapshot', async () => {
    const { preview, ran } = await approveAndRun('close-listing', { listingIds: [ids.amazon], reason: 'Out of season' })
    expect(preview).toMatchObject({ how: expect.stringContaining('offer of this market is closed'), listings: [{ listingId: ids.amazon, does: 'amazon-offer' }] })
    expect(ran.ok, ran.error).toBe(true)
    expect(state.patch).toHaveBeenCalledWith(expect.objectContaining({ sellerId: 'TEST-SELLER', sku: 'TEST-SKU-L9-M', marketplaceId: MARKETPLACE_ID_MAP.IT, op: 'delete' }))
    expect(await row(ids.amazon)).toMatchObject({ offerClosedBy: 'u-l9-approver', endedBy: 'u-l9-approver', endedReason: 'Out of season' })
    expect((await row(ids.amazon)).offerClosedAt).not.toBeNull()
    const tool = getTool('close-listing')!
    expect(await inside(() => tool.undo!.current(ran.change))).toEqual(ran.change.after)
    const undo = tool.undo!.request(ran.change) as Json
    expect(undo).toEqual({ tool: 'reopen-listing', args: { listingIds: [ids.amazon] } })
    const reopened = await approveAndRun('reopen-listing', undo.args)
    expect(reopened.ran.ok, reopened.ran.error).toBe(true)
    expect(state.patch).toHaveBeenLastCalledWith(expect.objectContaining({ op: 'replace' }))
    expect(await row(ids.amazon)).toMatchObject({ offerClosedAt: null, endedBy: null, endedReason: null })
  })

  it('never closes FBA, a draft, a Shopify listing, or two coordinates at once', async () => {
    expect((await dryRun('close-listing', { listingIds: [ids.amazonFba] })).error).toContain('fulfilled by Amazon (FBA)')
    expect((await dryRun('close-listing', { listingIds: [ids.draft] })).error).toContain('a draft was never live')
    expect((await dryRun('close-listing', { listingIds: [ids.shopify] })).error).toContain('Shopify listing from Nexus is not available yet')
    state.option.mockResolvedValue('ON')
    expect((await dryRun('close-listing', { listingIds: [ids.amazon, ids.ebay] })).error).toContain('more than one channel')
    expect(state.patch).not.toHaveBeenCalled()
  })
})

describe('eBay', () => {
  it('hides at 0 only while the out-of-stock option is ON; reopen follows the stock again', async () => {
    state.option.mockResolvedValue('OFF')
    expect((await dryRun('close-listing', { listingIds: [ids.ebay] })).error).toContain('out-of-stock option is OFF')
    state.option.mockResolvedValue('ON')
    const { ran } = await approveAndRun('close-listing', { listingIds: [ids.ebay] })
    expect(ran.ok, ran.error).toBe(true)
    expect(await row(ids.ebay)).toMatchObject({ quantity: 0, followMasterQuantity: false })
    const reopened = await approveAndRun('reopen-listing', { listingIds: [ids.ebay] })
    expect(reopened.ran.ok, reopened.ran.error).toBe(true)
    expect(await row(ids.ebay)).toMatchObject({ followMasterQuantity: true })
  })
})

describe('Etsy', () => {
  it('only while Etsy publishing is live: then inactive, and active again with the renewal stated', async () => {
    expect((await dryRun('close-listing', { listingIds: [ids.etsy] })).error).toContain('Etsy publishing is turned off')
    vi.stubEnv('NEXUS_ENABLE_ETSY_PUBLISH', 'true'); vi.stubEnv('ETSY_PUBLISH_MODE', 'live')
    const { ran } = await approveAndRun('close-listing', { listingIds: [ids.etsy] })
    expect(ran.ok, ran.error).toBe(true)
    expect(state.etsyState).toHaveBeenCalledWith(expect.objectContaining({ listingId: '123456789', change: { state: 'inactive' } }))
    expect(await row(ids.etsy)).toMatchObject({ listingStatus: 'INACTIVE' })
    const reopen = await approveAndRun('reopen-listing', { listingIds: [ids.etsy] })
    expect(reopen.preview.how).toContain('renewal')
    expect(state.etsyState).toHaveBeenLastCalledWith(expect.objectContaining({ change: { state: 'active', acceptRenewalAndQuantityReset: true } }))
    expect(await row(ids.etsy)).toMatchObject({ listingStatus: 'ACTIVE' })
  })
})

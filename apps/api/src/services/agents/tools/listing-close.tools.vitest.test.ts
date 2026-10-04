/**
 * MCP full control L9, build shape v2 (P3) — close-listing and reopen-listing are Pause offer / Resume offer of the
 * listing-action engine, run through the one door (call-tool.ts) on `listing-close.service.ts` → listing-action.service.ts
 * and its adapters (SCT.6 offer close, the eBay Trading pause, the Etsy state writer), against a real PostgreSQL with the
 * production schema and business-isolation policies (PGlite). Amazon's API, eBay's Trading calls and Etsy's writer are
 * faked: no channel is called.
 *
 * Proven here: the wrappers call the engine (its preview, run, hold and audit record) and no longer write `endedAt` on a
 * pause; a resume clears an `endedAt` an older close wrote; Amazon pauses and resumes one market's offer, FBA too (its
 * quantity untouched, no stock queued on resume); eBay pauses only with the item's out-of-stock control on (checked when
 * sending) and resume lifts the hold and sends the current stock; Etsy only while Etsy publishing is live; Shopify is
 * supported now; a draft and two coordinates are refused; pause and resume are each other's undo.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { AMAZON_FBA_PAUSE_WARNING } from '@nexus/shared/listing-actions'

const state = vi.hoisted(() => ({ db: null as any, option: vi.fn(), getListing: vi.fn(), patch: vi.fn(), etsyState: vi.fn(), trading: vi.fn(), activated: vi.fn() }))
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
vi.mock('../../amazon-publish-gate.service.js', async (original) => ({ ...(await original<object>()), getAmazonPublishMode: () => 'live' }))
vi.mock('../../ebay-publish-gate.service.js', async (original) => ({ ...(await original<object>()), getEbayPublishMode: () => 'live' }))
vi.mock('../../shopify-publish-gate.service.js', async (original) => ({ ...(await original<object>()), getShopifyPublishMode: () => 'live' }))
vi.mock('../../ebay-trading-api.service.js', async (original) => ({ ...(await original<object>()), callTradingApi: state.trading }))
vi.mock('../../ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: async () => 'token' } }))
vi.mock('../../connection-resolver.service.js', async (original) => ({ ...(await original<object>()),
  tryResolveConnection: async ({ accountId }: { accountId: string }) => ({ id: accountId, channelType: 'EBAY' }) }))
vi.mock('../../listing-activation-sync.service.js', () => ({ syncActivatedListings: state.activated }))

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
const row = async (id: string) => (await state.db.db.query(`SELECT "offerClosedAt", "offerClosedBy", "offerCloseReason", "listingStatus", quantity, "quantityOverride", "followMasterQuantity", "endedAt", "endedBy", "endedReason" FROM "ChannelListing" WHERE id = $1`, [id])).rows[0]

const dryRun = async (tool: string, args: Json) => (await inside(() => callTool(claude, tool, args))).raw as Json
async function approveAndRun(tool: string, args: Json) {
  const preview = await dryRun(tool, args)
  expect(preview.ok, preview.error).toBe(true)
  const ran = (await inside(() => executeTool(approver, tool, args, { approvedPreview: JSON.parse(JSON.stringify(preview.preview)), via: 'claude' }))).raw as Json
  return { preview: preview.preview as Json, ran }
}

const ITEM = '110000000001'
const getItem = (oos: 'true' | 'false') => ({ ack: 'Success', itemId: ITEM, raw: `<Item><ItemID>${ITEM}</ItemID><Quantity>4</Quantity><SellingStatus><QuantitySold>0</QuantitySold><ListingStatus>Active</ListingStatus></SellingStatus><OutOfStockControl>${oos}</OutOfStockControl></Item>` })

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
    ids.amazonFba = (await listing(ids.fba, 'AMAZON', 'IT', { fulfillmentMethod: 'FBA', followMasterQuantity: false, quantity: 9 })).id
    ids.ebay = (await listing(ids.child, 'EBAY', 'IT', { externalListingId: ITEM })).id
    ids.etsy = (await listing(ids.child, 'ETSY', 'GLOBAL', { externalListingId: '123456789' })).id
    ids.shopify = (await listing(ids.child, 'SHOPIFY', 'GLOBAL')).id
    ids.draft = (await listing(ids.parent, 'EBAY', 'IT', { listingStatus: 'DRAFT', isPublished: false, externalListingId: null, aliasKey: '' , channelConnectionId: null })).id
  })
}, 120_000)
afterAll(async () => { await state.db?.close() }, 60_000)
beforeEach(() => {
  vi.unstubAllEnvs()
  vi.stubEnv('NEXUS_EBAY_REAL_API', 'true')
  state.option.mockReset(); state.option.mockResolvedValue('UNKNOWN')
  state.getListing.mockResolvedValue({ success: true, rawResponse: { summaries: [{ productType: 'COAT' }], attributes: {
    purchasable_offer: [{ marketplace_id: MARKETPLACE_ID_MAP.IT, currency: 'EUR', our_price: [{ schedule: [{ value_with_tax: 10 }] }] }],
    fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 4 }] } } })
  state.patch.mockReset(); state.patch.mockResolvedValue({ success: true })
  state.etsyState.mockReset(); state.etsyState.mockResolvedValue({ sent: true, state: 'inactive' })
  state.trading.mockReset(); state.activated.mockReset()
})

describe('Amazon', () => {
  it('pauses one market\'s offer through the engine as approved, never writes endedAt; resume is its undo and clears an older endedAt', async () => {
    expect(getTool('close-listing')!.title).toBe('Pause offer')
    expect(getTool('reopen-listing')!.title).toBe('Resume offer')
    const { preview, ran } = await approveAndRun('close-listing', { listingIds: [ids.amazon], reason: 'Out of season' })
    expect(preview).toMatchObject({ how: expect.stringContaining('this market\'s offer is removed'), listings: [{ listingId: ids.amazon, does: 'amazon-offer' }] })
    expect(ran.ok, ran.error).toBe(true)
    expect(state.patch).toHaveBeenCalledWith(expect.objectContaining({ sellerId: 'TEST-SELLER', sku: 'TEST-SKU-L9-M', marketplaceId: MARKETPLACE_ID_MAP.IT, op: 'delete' }))
    expect(await row(ids.amazon)).toMatchObject({ offerClosedBy: 'u-l9-approver', offerCloseReason: 'sheet-pause', endedAt: null, endedBy: null, endedReason: null })
    expect((await row(ids.amazon)).offerClosedAt).not.toBeNull()
    // The engine's own audit record, with the reason Claude gave.
    expect(await inside(() => db().channelListingSnapshot.findFirst({ where: { channelListingId: ids.amazon, reason: 'pause' } })))
      .toMatchObject({ outcome: 'ACCEPTED', payload: expect.objectContaining({ kind: 'listing-action', reason: 'Out of season' }) })
    const tool = getTool('close-listing')!
    expect(await inside(() => tool.undo!.current(ran.change))).toEqual(ran.change.after)
    const undo = tool.undo!.request(ran.change) as Json
    expect(undo).toEqual({ tool: 'reopen-listing', args: { listingIds: [ids.amazon] } })
    // An older close wrote the presence columns; a resume clears them.
    await state.db.db.query(`UPDATE "ChannelListing" SET "endedAt" = now(), "endedBy" = 'old-close', "endedReason" = 'old' WHERE id = $1`, [ids.amazon])
    const reopened = await approveAndRun('reopen-listing', undo.args)
    expect(reopened.ran.ok, reopened.ran.error).toBe(true)
    expect(state.patch).toHaveBeenLastCalledWith(expect.objectContaining({ op: 'replace' }))
    expect(await row(ids.amazon)).toMatchObject({ offerClosedAt: null, endedAt: null, endedBy: null, endedReason: null })
  })

  it('pauses an FBA offer too (with the warning) and resumes it without sending any quantity', async () => {
    const { preview, ran } = await approveAndRun('close-listing', { listingIds: [ids.amazonFba] })
    expect(preview.listings).toEqual([expect.objectContaining({ listingId: ids.amazonFba, does: 'amazon-offer', note: expect.stringContaining(AMAZON_FBA_PAUSE_WARNING) })])
    expect(ran.ok, ran.error).toBe(true)
    expect(state.patch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sku: 'TEST-SKU-L9-L', op: 'delete' }))
    expect((await row(ids.amazonFba)).offerClosedAt).not.toBeNull()
    const reopened = await approveAndRun('reopen-listing', { listingIds: [ids.amazonFba] })
    expect(reopened.ran.ok, reopened.ran.error).toBe(true)
    expect(state.patch).toHaveBeenLastCalledWith(expect.objectContaining({ sku: 'TEST-SKU-L9-L', op: 'replace' }))
    // FBA quantity is untouchable: no Set Follow, no pin change, nothing queued.
    expect(await row(ids.amazonFba)).toMatchObject({ offerClosedAt: null, followMasterQuantity: false, quantity: 9, quantityOverride: null })
    expect(await inside(() => db().outboundSyncQueue.count({ where: { channelListingId: ids.amazonFba, syncType: 'QUANTITY_UPDATE' } }))).toBe(0)
  })

  it('never pauses a draft or two coordinates at once; a reopen takes no quantity', async () => {
    expect((await dryRun('close-listing', { listingIds: [ids.draft] })).error).toContain('a draft was never live')
    expect((await dryRun('close-listing', { listingIds: [ids.amazon, ids.ebay] })).error).toContain('more than one channel')
    expect((await dryRun('reopen-listing', { listingIds: [ids.amazon], quantity: 3 })).error).toContain('use set-listing-stock')
    expect(state.patch).not.toHaveBeenCalled()
  })
})

describe('eBay', () => {
  it('pauses at 0 only while the item\'s out-of-stock control is on (checked when sending), holds it; resume lifts the hold and sends the stock', async () => {
    state.trading.mockImplementation(async (call: string) => call === 'GetItem' ? getItem('false') : { ack: 'Success', itemId: ITEM, raw: '' })
    const off = await approveAndRun('close-listing', { listingIds: [ids.ebay] })
    expect(off.preview).toMatchObject({ listings: [{ listingId: ids.ebay, does: 'ebay-quantity' }], checkedWhenSending: expect.stringContaining('out-of-stock control') })
    expect(off.ran).toMatchObject({ ok: false, error: expect.stringMatching(/Nothing paused/) })
    expect(state.trading.mock.calls.map((c) => c[0])).toEqual(['GetItem'])
    expect(await row(ids.ebay)).toMatchObject({ offerClosedAt: null })

    state.trading.mockReset().mockImplementation(async (call: string) => call === 'GetItem' ? getItem('true') : { ack: 'Success', itemId: ITEM, raw: '' })
    const { ran } = await approveAndRun('close-listing', { listingIds: [ids.ebay] })
    expect(ran.ok, ran.error).toBe(true)
    expect(state.trading.mock.calls.map((c) => c[0])).toEqual(['GetItem', 'ReviseInventoryStatus'])
    expect(await row(ids.ebay)).toMatchObject({ offerCloseReason: 'sheet-pause', followMasterQuantity: true, quantityOverride: null, endedAt: null })
    const reopened = await approveAndRun('reopen-listing', { listingIds: [ids.ebay] })
    expect(reopened.ran.ok, reopened.ran.error).toBe(true)
    expect(await row(ids.ebay)).toMatchObject({ offerClosedAt: null, followMasterQuantity: true })
    expect(state.activated).toHaveBeenCalledWith([ids.ebay])
  })
})

describe('Etsy', () => {
  it('only while Etsy publishing is live: then inactive and held, and active again with the renewal stated', async () => {
    expect((await dryRun('close-listing', { listingIds: [ids.etsy] })).error).toContain('Etsy publishing is turned off')
    vi.stubEnv('NEXUS_ENABLE_ETSY_PUBLISH', 'true'); vi.stubEnv('ETSY_PUBLISH_MODE', 'live')
    const { ran } = await approveAndRun('close-listing', { listingIds: [ids.etsy] })
    expect(ran.ok, ran.error).toBe(true)
    expect(state.etsyState).toHaveBeenCalledWith(expect.objectContaining({ listingId: '123456789', change: { state: 'inactive' } }))
    expect(await row(ids.etsy)).toMatchObject({ listingStatus: 'INACTIVE', offerCloseReason: 'sheet-pause', endedAt: null })
    const reopen = await approveAndRun('reopen-listing', { listingIds: [ids.etsy] })
    expect(reopen.preview.how).toContain('renewal')
    expect(reopen.ran.ok, reopen.ran.error).toBe(true)
    expect(state.etsyState).toHaveBeenLastCalledWith(expect.objectContaining({ change: { state: 'active', acceptRenewalAndQuantityReset: true } }))
    expect(await row(ids.etsy)).toMatchObject({ listingStatus: 'ACTIVE', offerClosedAt: null })
  })
})

describe('Shopify', () => {
  it('is supported now: a pause plans quantity 0 per variant through the engine', async () => {
    const preview = await dryRun('close-listing', { listingIds: [ids.shopify] })
    expect(preview.ok, preview.error).toBe(true)
    expect(preview.preview).toMatchObject({ how: expect.stringContaining('quantity 0 per variant'), listings: [{ listingId: ids.shopify, does: 'shopify-quantity' }] })
  })
})

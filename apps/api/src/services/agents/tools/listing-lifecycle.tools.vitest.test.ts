/**
 * MCP full control, phase 3 (T1) — end-listing, relist-listing and delete-listing are the product page's End listing,
 * Relist and Delete listing: run through the one door (call-tool.ts) on `listing-lifecycle.service.ts` →
 * listing-action.service.ts and its adapters, against a real PostgreSQL with the production schema and business-isolation
 * policies (PGlite). eBay's Trading calls, Amazon's delete and live read are faked at their one door each: no channel is
 * called.
 *
 * Proven here: each needs products.delete and the family SKU typed (confirmSku), and is refused before any engine read
 * otherwise; End reaches the whole eBay item (every variation, the item number kept), Relist gives a NEW item number, and
 * each is the other's undo; reopen-listing on an Ended listing points to relist-listing; Amazon and Etsy have no End or
 * Relist and Etsy no Delete; an Amazon Delete removes this market's listing only, warns of FBA units and Pan-European
 * FBA, cannot be undone, and leaves the delete's own record that keeps every Publish (publish-listing included) leaving
 * the row Not listed; Shopify's End and Delete say they reach every market of the store; a stale approval runs nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { AMAZON_PAN_EU_DELETE_WARNING } from '@nexus/shared/listing-actions'

const state = vi.hoisted(() => ({ db: null as any, end: vi.fn(), relist: vi.fn(), trading: vi.fn(), amazonDelete: vi.fn(), amazonLive: vi.fn(), activated: vi.fn() }))
vi.mock('@nexus/database', async (original) => {
  const { formulaDatabase } = await import('../../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { ...(await original<object>()), default: state.db.client }
})
vi.mock('../../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn(async () => undefined) }))
vi.mock('../../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn(), emitTx: vi.fn() } }))
vi.mock('../../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(async () => undefined), refreshMany: vi.fn(async () => undefined), refreshInTransaction: vi.fn(async () => undefined) } }))
vi.mock('../../amazon-publish-gate.service.js', async (original) => ({ ...(await original<object>()), getAmazonPublishMode: () => 'live' }))
vi.mock('../../ebay-publish-gate.service.js', async (original) => ({ ...(await original<object>()), getEbayPublishMode: () => 'live' }))
vi.mock('../../shopify-publish-gate.service.js', async (original) => ({ ...(await original<object>()), getShopifyPublishMode: () => 'live' }))
vi.mock('../../ebay-trading-api.service.js', async (original) => ({ ...(await original<object>()),
  callTradingApi: state.trading, endFixedPriceItem: state.end, relistFixedPriceItem: state.relist }))
vi.mock('../../ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: async () => 'token' } }))
vi.mock('../../connection-resolver.service.js', async (original) => ({ ...(await original<object>()),
  tryResolveConnection: async ({ accountId }: { accountId: string }) => ({ id: accountId, channelType: 'EBAY' }) }))
vi.mock('../../channel-delist.service.js', async (original) => ({ ...(await original<object>()), deleteAmazonListingOnChannel: state.amazonDelete }))
vi.mock('../../amazon/purchasable-offer.js', async (original) => ({ ...(await original<object>()), readAmazonOfferLive: state.amazonLive }))
vi.mock('../../../lib/amazon-sp-client.js', async (original) => ({ ...(await original<object>()), getAmazonSellerId: async () => 'TEST-SELLER' }))
vi.mock('../../listing-activation-sync.service.js', () => ({ syncActivatedListings: state.activated }))

import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'
import { MARKETPLACE_ID_MAP } from '../../amazon/flat-file.service.js'
import { readListingActionState } from '../../listings/listing-action.service.js'
import { readListingDeletions } from '../../listings/listing-deletions.js'
import { callTool, executeTool, type UserPrincipal } from '../call-tool.js'
import { getTool } from '../tool-registry.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const person = (userId: string, without: string[] = []): UserPrincipal => ({
  kind: 'user', userId, label: userId,
  permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)].filter((p) => !without.includes(p))) },
  workspace: business, via: 'claude',
})
const claude = person('u-t1-asker')
const approver = person('u-t1-approver')
type Json = Record<string, any>
const db = () => state.db.client
const row = async (id: string) => (await state.db.db.query(`SELECT "listingStatus", "isPublished", "externalListingId", "syncPaused" FROM "ChannelListing" WHERE id = $1`, [id])).rows[0]

const dryRun = async (tool: string, args: Json) => (await inside(() => callTool(claude, tool, args))).raw as Json
async function approveAndRun(tool: string, args: Json) {
  const preview = await dryRun(tool, args)
  expect(preview.ok, preview.error).toBe(true)
  const ran = (await inside(() => executeTool(approver, tool, args, { approvedPreview: JSON.parse(JSON.stringify(preview.preview)), via: 'claude' }))).raw as Json
  return { preview: preview.preview as Json, ran }
}

const ITEM = '120000000001'
const NEW_ITEM = '120000000002'
const ids: Record<string, string> = {}
beforeAll(async () => {
  await inside(async () => {
    for (const [channel, code] of [['AMAZON', 'IT'], ['EBAY', 'IT'], ['ETSY', 'GLOBAL'], ['SHOPIFY', 'GLOBAL']]) {
      await db().marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } as never })
    }
    const account = async (channelType: string) => (await db().channelConnection.create({ data: { channelType, accountLabel: `Test ${channelType}`, isActive: true, isPrimary: true, externalAccountId: `TEST-T1-${channelType}` } })).id
    const accounts = { AMAZON: await account('AMAZON'), EBAY: await account('EBAY'), ETSY: await account('ETSY'), SHOPIFY: await account('SHOPIFY') } as Record<string, string>
    const product = (sku: string, extra: Json = {}) => db().product.create({ data: { sku, name: sku, basePrice: 10, totalStock: 4, productType: 'COAT', ...extra } as never })
    const listing = async (productId: string, channel: string, marketplace: string, extra: Json = {}) => (await db().channelListing.create({ data: { productId, channel, marketplace,
      channelMarket: `${channel}_${marketplace}`, region: marketplace, channelConnectionId: accounts[channel], price: 10, quantity: 4, followMasterQuantity: true,
      listingStatus: 'ACTIVE', isPublished: true, externalListingId: `TEST-T1-${channel}-${productId.slice(-4)}`, ...extra } as never })).id
    // eBay: one family, one item (main product and two variations).
    ids.ebayFamily = (await product('TEST-SKU-T1E', { isParent: true })).id
    ids.ebayS = (await product('TEST-SKU-T1E-S', { parentId: ids.ebayFamily })).id
    ids.ebayM = (await product('TEST-SKU-T1E-M', { parentId: ids.ebayFamily })).id
    ids.ebayParentListing = await listing(ids.ebayFamily, 'EBAY', 'IT', { externalListingId: ITEM })
    ids.ebaySListing = await listing(ids.ebayS, 'EBAY', 'IT', { externalListingId: ITEM })
    ids.ebayMListing = await listing(ids.ebayM, 'EBAY', 'IT', { externalListingId: ITEM })
    // A second eBay family, live.
    ids.otherFamily = (await product('TEST-SKU-T1F', { isParent: true })).id
    ids.otherS = (await product('TEST-SKU-T1F-S', { parentId: ids.otherFamily })).id
    ids.otherListing = await listing(ids.otherS, 'EBAY', 'IT', { externalListingId: '120000000009' })
    // Amazon: a family with an FBM and an FBA variation in IT; Etsy for the FBM one.
    ids.amazonFamily = (await product('TEST-SKU-T1A', { isParent: true })).id
    ids.amazonS = (await product('TEST-SKU-T1A-S', { parentId: ids.amazonFamily })).id
    ids.amazonM = (await product('TEST-SKU-T1A-M', { parentId: ids.amazonFamily, fulfillmentMethod: 'FBA' })).id
    ids.amazonSListing = await listing(ids.amazonS, 'AMAZON', 'IT', { fulfillmentMethod: 'FBM', externalListingId: 'B0T1SSSS' })
    ids.amazonMListing = await listing(ids.amazonM, 'AMAZON', 'IT', { fulfillmentMethod: 'FBA', externalListingId: 'B0T1MMMM', followMasterQuantity: false, quantity: 5 })
    ids.etsyListing = await listing(ids.amazonS, 'ETSY', 'GLOBAL', { externalListingId: '123456789' })
    ids.draft = await listing(ids.amazonFamily, 'EBAY', 'IT', { listingStatus: 'DRAFT', isPublished: false, externalListingId: null })
    // Shopify: one product with one variant.
    ids.shopifyFamily = (await product('TEST-SKU-T1H', { isParent: true })).id
    ids.shopifyS = (await product('TEST-SKU-T1H-S', { parentId: ids.shopifyFamily })).id
    ids.shopifyParentListing = await listing(ids.shopifyFamily, 'SHOPIFY', 'GLOBAL', { externalListingId: '9100', platformAttributes: { status: 'ACTIVE' } })
    ids.shopifySListing = await listing(ids.shopifyS, 'SHOPIFY', 'GLOBAL', { externalListingId: '9100' })
    // Amazon's FBA units of the FBA variation in IT, as Nexus last read them.
    for (const [condition, quantity] of [['SELLABLE', 4], ['INBOUND', 1]] as const) {
      await db().fbaInventoryDetail.create({ data: { productId: ids.amazonM, sku: 'TEST-SKU-T1A-M', asin: 'B0T1MMMM', marketplaceId: MARKETPLACE_ID_MAP.IT,
        fulfillmentCenterId: 'MXP6', condition, quantity, lastSyncedAt: new Date() } })
    }
  })
}, 120_000)
afterAll(async () => { await state.db?.close() }, 60_000)
beforeEach(() => {
  vi.unstubAllEnvs()
  vi.stubEnv('NEXUS_EBAY_REAL_API', 'true')
  state.end.mockReset(); state.relist.mockReset(); state.trading.mockReset(); state.activated.mockReset()
  state.amazonDelete.mockReset(); state.amazonLive.mockReset()
  state.amazonLive.mockResolvedValue({ read: 'ok', offers: [], fulfillmentChannels: ['AMAZON_EU'], instances: [], productType: 'COAT' })
})

describe('the contract a person keeps', () => {
  it('each waits for a person, needs products.delete and the typed family SKU; delete cannot be undone', async () => {
    for (const name of ['end-listing', 'relist-listing', 'delete-listing']) {
      const tool = getTool(name)!
      expect({ name, alwaysAsk: tool.alwaysAsk, trust: tool.maxClaudeTrust, open: tool.openWorld }).toEqual({ name, alwaysAsk: true, trust: 'ask', open: true })
      expect(tool.requires).toEqual(expect.arrayContaining(['products.delete', 'listings.publish', 'inventory.adjust']))
    }
    expect([getTool('end-listing')!.title, getTool('relist-listing')!.title, getTool('delete-listing')!.title]).toEqual(['End listing', 'Relist', 'Delete listing'])
    expect(getTool('delete-listing')!.reversibility).toBe('none')
    expect(getTool('delete-listing')!.undo).toBeUndefined()
    // Without products.delete the door refuses before the tool runs.
    const noDelete = person('u-t1-no-delete', ['products.delete'])
    await expect(inside(() => callTool(noDelete, 'end-listing', { listingIds: [ids.ebaySListing], confirmSku: 'TEST-SKU-T1E' }))).rejects.toThrow(/products\.delete/)
    // A wrong family SKU is refused, and nothing is planned or sent.
    for (const confirmSku of ['TEST-SKU-T1E-S', 'test-sku-t1e', 'TEST-SKU-T1F']) {
      expect((await dryRun('end-listing', { listingIds: [ids.ebaySListing], confirmSku })).error).toContain('confirmSku does not match the family SKU')
    }
    expect(state.end).not.toHaveBeenCalled()
  })

  it('refuses what the channel has not, a draft, two families, two coordinates, and a Relist of a live listing', async () => {
    const refusal = async (tool: string, listingIds: string[], confirmSku: string) => (await dryRun(tool, { listingIds, confirmSku })).error as string
    expect(await refusal('end-listing', [ids.amazonSListing], 'TEST-SKU-T1A')).toContain('Amazon has no End. close-listing pauses')
    expect(await refusal('relist-listing', [ids.amazonSListing], 'TEST-SKU-T1A')).toContain('Amazon has no End or Relist')
    expect(await refusal('end-listing', [ids.etsyListing], 'TEST-SKU-T1A')).toContain('Etsy has no End here')
    expect(await refusal('delete-listing', [ids.etsyListing], 'TEST-SKU-T1A')).toContain('Deleting Etsy listings from Nexus is not available yet')
    expect(await refusal('delete-listing', [ids.draft], 'TEST-SKU-T1A')).toContain('a draft was never live')
    expect(await refusal('end-listing', [ids.ebaySListing, ids.otherListing], 'TEST-SKU-T1E')).toContain('more than one product family')
    expect(await refusal('end-listing', [ids.ebaySListing, ids.amazonSListing], 'TEST-SKU-T1E')).toContain('more than one channel')
    expect(await refusal('relist-listing', [ids.otherListing], 'TEST-SKU-T1F')).toContain('relist-listing relists only an Ended listing')
    expect(await refusal('end-listing', [ids.ebaySListing], 'TEST-SKU-T1E')).toBeUndefined()
    expect(state.end).not.toHaveBeenCalled()
    expect(state.amazonDelete).not.toHaveBeenCalled()
  })
})

describe('eBay: End and Relist', () => {
  it('a stale approval runs nothing', async () => {
    const preview = await dryRun('end-listing', { listingIds: [ids.otherListing], confirmSku: 'TEST-SKU-T1F' })
    expect(preview.ok, preview.error).toBe(true)
    const tampered = { ...preview.preview, listings: [{ listingId: ids.otherListing, does: 'skip' }] }
    const ran = (await inside(() => executeTool(approver, 'end-listing', { listingIds: [ids.otherListing], confirmSku: 'TEST-SKU-T1F' }, { approvedPreview: tampered, via: 'claude' }))).raw as Json
    expect(ran).toMatchObject({ ok: false, error: expect.stringContaining('changed since it was approved') })
    const unapproved = (await inside(() => executeTool(approver, 'end-listing', { listingIds: [ids.otherListing], confirmSku: 'TEST-SKU-T1F' }, { via: 'claude' }))).raw as Json
    expect(unapproved).toMatchObject({ ok: false, error: expect.stringContaining('only after a person approved') })
    expect(state.end).not.toHaveBeenCalled()
    expect(await row(ids.otherListing)).toMatchObject({ listingStatus: 'ACTIVE' })
  })

  it('End ends the whole item through the engine (the item number kept); reopen points to relist-listing; Relist is its undo with a NEW item number, and End is Relist\'s', async () => {
    const args = { listingIds: [ids.ebaySListing], confirmSku: ' TEST-SKU-T1E ', reason: 'Season over' }
    state.end.mockResolvedValue({ ack: 'Success', itemId: ITEM, errors: [] })
    const { preview, ran } = await approveAndRun('end-listing', args)
    expect(preview).toMatchObject({
      action: 'end-listing',
      summary: expect.stringMatching(/^End TEST-SKU-T1E on eBay · IT \(2 listings\): eBay ends the whole item.*NEW item number/),
      how: expect.stringContaining('Relist makes a new eBay item number'),
      warning: expect.stringMatching(/relist-listing gives it a NEW item number\. It also reaches listings not named: TEST-SKU-T1E-M\./),
      listings: [{ listingId: ids.ebayMListing, sku: 'TEST-SKU-T1E-M', does: 'end', reached: true }, { listingId: ids.ebaySListing, sku: 'TEST-SKU-T1E-S', does: 'end' }],
      changes: [{ sku: 'TEST-SKU-T1E-M', field: 'status', from: 'Active', to: 'Ended' }, { sku: 'TEST-SKU-T1E-S', field: 'status', from: 'Active', to: 'Ended' }],
      confirmSku: 'TEST-SKU-T1E',
    })
    expect(ran.ok, ran.error).toBe(true)
    expect(state.end).toHaveBeenCalledExactlyOnceWith({ itemId: ITEM, endingReason: 'NotAvailable' }, expect.objectContaining({ connectionId: expect.any(String) }))
    for (const id of [ids.ebayParentListing, ids.ebaySListing, ids.ebayMListing]) expect(await row(id)).toMatchObject({ listingStatus: 'ENDED', externalListingId: ITEM })
    // The engine's own audit record, with the reason Claude gave.
    expect(await inside(() => db().channelListingSnapshot.findFirst({ where: { channelListingId: ids.ebaySListing, reason: 'end' } })))
      .toMatchObject({ outcome: 'ACCEPTED', capturedBy: 'u-t1-approver', payload: expect.objectContaining({ kind: 'listing-action', reason: 'Season over' }) })

    // reopen-listing does not relist: it names relist-listing.
    expect((await dryRun('reopen-listing', { listingIds: [ids.ebaySListing] })).error).toContain('use relist-listing (on eBay it gets a NEW item number)')

    const end = getTool('end-listing')!
    expect(await inside(() => end.undo!.current(ran.change))).toEqual(ran.change.after)
    const undo = end.undo!.request(ran.change) as Json
    expect(undo).toEqual({ tool: 'relist-listing', args: { listingIds: [ids.ebayMListing, ids.ebaySListing], confirmSku: 'TEST-SKU-T1E' } })

    state.relist.mockResolvedValue({ ack: 'Success', newItemId: NEW_ITEM, errors: [] })
    const relisted = await approveAndRun('relist-listing', undo.args)
    expect(relisted.preview).toMatchObject({
      summary: expect.stringContaining('under a NEW eBay item number; the old item number stays ended'),
      warning: expect.stringContaining('eBay may charge an insertion fee'),
      changes: [{ sku: 'TEST-SKU-T1E-M', from: 'Ended', to: 'Active' }, { sku: 'TEST-SKU-T1E-S', from: 'Ended', to: 'Active' }],
    })
    expect(relisted.ran.ok, relisted.ran.error).toBe(true)
    expect(state.relist).toHaveBeenCalledExactlyOnceWith({ itemId: ITEM }, expect.anything())
    expect(relisted.ran.data.relisted).toEqual(expect.arrayContaining([expect.objectContaining({ sku: 'TEST-SKU-T1E-S', detail: expect.stringContaining(NEW_ITEM) })]))
    for (const id of [ids.ebaySListing, ids.ebayMListing]) expect(await row(id)).toMatchObject({ listingStatus: 'ACTIVE', externalListingId: NEW_ITEM })
    expect(state.activated).toHaveBeenCalled()
    expect(getTool('relist-listing')!.undo!.request(relisted.ran.change)).toEqual({ tool: 'end-listing', args: { listingIds: [ids.ebayMListing, ids.ebaySListing], confirmSku: 'TEST-SKU-T1E' } })
    expect(await inside(() => getTool('relist-listing')!.undo!.current(relisted.ran.change))).toEqual(relisted.ran.change.after)
  })
})

describe('Amazon: Delete', () => {
  it('deletes this market\'s listing only, warns of FBA units and Pan-European FBA, and leaves the record that keeps every Publish leaving it Not listed', async () => {
    const args = { listingIds: [ids.amazonMListing], confirmSku: 'TEST-SKU-T1A' }
    state.amazonDelete.mockResolvedValue({ success: true, outcome: 'SUCCESS', submissionId: 'sub-t1' })
    const { preview, ran } = await approveAndRun('delete-listing', args)
    expect(preview).toMatchObject({
      action: 'delete-listing',
      summary: 'Delete 1 listing of TEST-SKU-T1A on Amazon · IT only; other Amazon markets keep their listings. This cannot be undone.',
      listings: [{ listingId: ids.amazonMListing, does: 'delete' }],
      changes: [{ sku: 'TEST-SKU-T1A-M', from: 'Active', to: 'Not listed (deleted)' }],
    })
    expect(preview.warning).toMatch(/^This cannot be undone\. TEST-SKU-T1A-M: Amazon holds 5 FBA units for this SKU here \(4 sellable, 1 on the way\)/)
    expect(preview.warning).toContain(AMAZON_PAN_EU_DELETE_WARNING)
    expect(preview.warning).toContain('publish-listing leaves it out; only a person lists it again')
    expect(ran.ok, ran.error).toBe(true)
    expect(state.amazonDelete).toHaveBeenCalledExactlyOnceWith({ sellerId: 'TEST-SELLER', sku: 'TEST-SKU-T1A-M', marketplaceId: MARKETPLACE_ID_MAP.IT })
    expect(ran.data.next).toContain('publish-listing leaves it Not listed')
    expect(await row(ids.amazonMListing)).toMatchObject({ listingStatus: 'DRAFT', isPublished: false, externalListingId: null, syncPaused: true })
    // The other variation and the other channels are untouched.
    expect(await row(ids.amazonSListing)).toMatchObject({ listingStatus: 'ACTIVE', externalListingId: 'B0T1SSSS' })
    // The delete's own record: what keeps every Publish — publish-listing included — leaving the row Not listed.
    const listing = await inside(() => db().channelListing.findUnique({ where: { id: ids.amazonMListing } }))
    expect((await inside(() => readListingDeletions([listing]))).get(ids.amazonMListing)).toMatchObject({ where: 'Amazon · IT' })
    const read = await inside(() => readListingActionState(ids.amazonFamily, { channel: 'AMAZON', market: 'IT', accountId: listing.channelConnectionId }))
    expect(read.rows.find((r) => r.listingId === ids.amazonMListing)).toMatchObject({ state: 'not_listed', actions: [] })
    // Nothing more for Claude to do to it: a second delete and a relist are refused in plain words.
    expect((await dryRun('delete-listing', args)).error).toContain('Already deleted on Amazon · IT')
    expect((await dryRun('relist-listing', args)).error).toMatch(/Deleted on Amazon · IT on .*Only a person lists it again/)
    expect(state.amazonDelete).toHaveBeenCalledTimes(1)
  })
})

describe('Shopify: every market of the store', () => {
  it('End archives and Delete deletes the whole product in every market of the store, and say so', async () => {
    const args = { listingIds: [ids.shopifySListing], confirmSku: 'TEST-SKU-T1H' }
    const end = await dryRun('end-listing', args)
    expect(end.ok, end.error).toBe(true)
    expect(end.preview).toMatchObject({
      summary: expect.stringContaining('Shopify archives the product in every market of the store'),
      warning: expect.stringContaining('EVERY market of the store'),
      listings: expect.arrayContaining([expect.objectContaining({ listingId: ids.shopifyParentListing, does: 'end', reached: true }), expect.objectContaining({ listingId: ids.shopifySListing, does: 'end' })]),
    })
    const del = await dryRun('delete-listing', args)
    expect(del.ok, del.error).toBe(true)
    expect(del.preview.summary).toContain('Shopify deletes the product and all its variants in every market of the store. This cannot be undone.')
    expect(del.preview.warning).toContain('in EVERY market of the store, not one market')
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { withPresenceFixture } from '../test-support/presence-local.js'
import { whereCoordinate } from './listing-coordinate.js'

const state = vi.hoisted(() => {
  const s: any = {
    db: null, recon: null,
    patch: vi.fn(), delist: vi.fn(), get: vi.fn(), deleteItem: vi.fn(),
    journal: vi.fn(async () => ({ id: 'mock-event' })),
    queue: vi.fn(async () => ({ id: 'mock-queue' })),
    activate: vi.fn(async () => {}), enqueue: vi.fn(async () => ({})),
  }
  s.wrap = (db: any): any => new Proxy(db, { get(target, key) {
    if (key === '$transaction') return (fn: any, opts: any) => target.$transaction((tx: any) => fn(s.wrap(tx)), opts)
    if (key === 'productEvent' || key === 'syncControlAudit' || key === 'listingRecoveryEvent') return { create: s.journal, createMany: s.journal, update: s.journal }
    if (key === 'outboundSyncQueue') return { create: s.queue, createMany: s.queue, updateMany: s.queue }
    if (key === 'listingReconciliation') return { findUniqueOrThrow: async () => s.recon, update: s.journal }
    if (key === 'marketplace') return { findFirst: async () => ({ marketplaceId: 'APJ6JRA9NG5V4' }) }
    const value = target[key]
    return typeof value === 'function' ? value.bind(target) : value
  } })
  s.client = new Proxy({}, { get(_t, key) {
    if (!s.db) throw new Error(`DB used outside announced fixture: ${String(key)}`)
    return s.wrap(s.db)[key]
  } })
  return s
})

vi.mock('../db.js', () => ({ default: state.client }))
vi.mock('@nexus/database', async importOriginal => ({ ...await importOriginal<any>(), prisma: state.client }))
vi.mock('./amazon-sp-client.js', () => ({ getAmazonSellerId: async () => 'synthetic-seller' }))
vi.mock('../clients/amazon-sp-api.client.js', () => ({ amazonSpApiClient: { getListingsItem: state.get, patchPurchasableOffer: state.patch, deleteListingsItem: state.deleteItem } }))
vi.mock('../services/amazon/flat-file.service.js', () => ({ MARKETPLACE_ID_MAP: { IT: 'APJ6JRA9NG5V4', DE: 'A1PA6795UKMFR9' } }))
vi.mock('../services/channel-delist.service.js', () => ({ dispatchChannelDelist: state.delist }))
vi.mock('./queue.js', () => ({ outboundSyncQueue: {}, addJobSafely: vi.fn(async () => {}) }))
vi.mock('../services/sync-coalesce.js', () => ({ coalescePendingQuantityRows: vi.fn(async () => {}) }))
vi.mock('../services/outbound-sync.service.js', async () => ({ isFbaListing: (await import('./amazon-fulfillment.js')).isFbaCoordinate }))
vi.mock('../services/outbound-enqueue.js', async importOriginal => ({ ...await importOriginal<any>(), enqueueOutboundRowsInstant: state.enqueue }))
vi.mock('../services/stock-movement.service.js', () => ({ recascadeAfterSyncControlChange: vi.fn(async () => 0) }))
vi.mock('../services/marketplaces/amazon.service.js', () => ({ AmazonService: class {}, AMAZON_MARKETPLACE_CODE_TO_ID: {}, XAVIA_ACTIVE_MARKETPLACES: [] }))
vi.mock('../services/listing-activation-sync.service.js', () => ({ syncActivatedListings: state.activate }))
vi.mock('../services/ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: vi.fn(async () => 'synthetic-token') } }))
vi.mock('../services/ebay-trading-api.service.js', () => ({ callTradingApi: vi.fn(async () => { throw new Error('NO CHANNEL') }), reviseInventoryStatus: vi.fn(), siteIdForMarket: () => 101, escapeXml: (s: string) => s }))

const { removeAmazonListing } = await import('../services/amazon/amazon-flat-file-remove.service.js')
const { runEbayFlatFileDelete } = await import('../services/ebay-flat-file-delete.service.js')
const { closeMarketOffers, reopenMarketOffers } = await import('../services/amazon-market-offer.service.js')
const { previewRecovery, executeRecovery } = await import('../services/listings/recovery.service.js')
const { backfillListingIdentity } = await import('../services/ebay-label-guard.service.js')
const { confirmReconRow } = await import('../services/listing-reconciliation.service.js')
const { default: marketplaceRoutes } = await import('../routes/marketplaces.routes.js')
const { default: syncRoutes } = await import('../routes/sync-control.routes.js')

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('NO CHANNEL: PR.3 local fixture') }))
  state.patch.mockResolvedValue({ success: true, dryRun: false })
  state.deleteItem.mockResolvedValue({ success: true, dryRun: false })
  state.delist.mockResolvedValue({ success: false, dryRun: true, error: 'synthetic no-channel rehearsal' })
  state.get.mockResolvedValue({ rawResponse: { attributes: { purchasable_offer: [{ marketplace_id: 'APJ6JRA9NG5V4', currency: 'EUR', our_price: [{ schedule: [{ value_with_tax: 10 }] }] }] }, summaries: [{ productType: 'AUTO_ACCESSORY' }] } })
})

afterEach(() => { expect(globalThis.fetch).not.toHaveBeenCalled(); state.db = null; vi.unstubAllGlobals() })

describe.skipIf(process.env.PR3_LOCAL_DB_TESTS !== '1')('PR.3 site isolation — LOCAL XAVIA, two DRAFT rows, no channels', () => {
  it('Amazon removal: old three-level count=2; full coordinate removes 1; named fan-out; sibling survives', async () => {
    await withPresenceFixture('AMAZON', async f => {
      state.db = f.db
      const r = await removeAmazonListing(state.client, { ...f.coordinate, actor: 'PR3-fixture' })
      expect(r.channelListingsRemoved).toBe(1)
      expect(r.fanOut).toHaveLength(1)
      expect(r.fanOut[0]).toMatchObject(f.coordinate)
      expect(r.delisted).toBe(false)
      expect(state.journal.mock.calls[0][0].data.data.coordinate).toEqual(f.coordinate)
      const rows = await f.readBack()
      expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject(f.sibling)
      expect(state.delist.mock.calls[0][0]).toMatchObject({ sellerSku: f.sku, channelConnectionId: f.coordinate.channelConnectionId })
      console.log('REHEARSAL old-count=2 removed=1 sibling=1; no channel call')
    })
  }, 60_000)

  it('eBay removal: one row deleted; surviving alias prevents the per-market file exclusion', async () => {
    await withPresenceFixture('EBAY', async f => {
      state.db = f.db
      const r = await runEbayFlatFileDelete(state.client, [{ ...f.coordinate, sku: f.sku, intent: 'remove-channel-listing' }])
      expect(r[0].channelListingsRemoved).toBe(1)
      expect(r[0].fanOut).toHaveLength(1)
      expect(r[0].excludedFromFile).toBe(0)
      const rows = await f.readBack()
      expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject(f.sibling)
    })
  }, 60_000)

  it('offer loadRow + close write: dry-run changes nothing; real ack changes only target closedAt and offerActive', async () => {
    await withPresenceFixture('AMAZON', async f => {
      state.db = f.db
      const opts = { targets: [f.coordinate], actor: 'PR3-fixture' }
      state.patch.mockResolvedValueOnce({ success: true, dryRun: true })
      const dry = await closeMarketOffers(opts)
      expect(dry.results[0].action).toBe('DRY_RUN'); expect(state.queue).not.toHaveBeenCalled()
      let rows = await f.readBack()
      expect(rows.every(r => r.offerActive && r.offerClosedAt === null)).toBe(true)
      expect((await closeMarketOffers(opts)).updated).toBe(1)
      rows = await f.readBack()
      expect(rows[0]).toMatchObject({ aliasKey: f.coordinate.aliasKey, offerActive: false })
      expect(rows[0].offerClosedAt).toBeInstanceOf(Date)
      expect(rows[1]).toMatchObject({ aliasKey: f.sibling.aliasKey, offerActive: true, offerClosedAt: null })
    })
  }, 60_000)

  for (const action of ['ZERO_PIN', 'FOLLOW'] as const) it(`Sync Control ${action}: loader and delegated write touch one row`, async () => {
    await withPresenceFixture('AMAZON', async f => {
      state.db = f.db
      await f.db.channelListing.updateMany({ where: whereCoordinate(f.coordinate), data: { followMasterQuantity: false, quantityOverride: 5 } })
      const app = Fastify(); await app.register(syncRoutes)
      try {
        const response = await app.inject({ method: 'POST', url: '/stock/sync-control/actions', payload: { action, listings: [f.coordinate] } })
        expect(response.statusCode, response.body).toBe(200)
        expect(response.json().updated).toBe(1)
        const rows = await f.readBack()
        expect(rows).toHaveLength(2)
        expect(rows[0].quantity).toBe(0)
        expect(rows[0].followMasterQuantity).toBe(action === 'FOLLOW')
        expect(rows[1]).toMatchObject({ aliasKey: f.sibling.aliasKey, quantity: 5, quantityOverride: null })
      } finally { await app.close() }
    })
  }, 60_000)

  for (const bulk of [false, true]) it(`marketplaces ${bulk ? 'bulk' : 'single'} availability: exact account/alias survives route boundary`, async () => {
    await withPresenceFixture('AMAZON', async f => {
      state.db = f.db
      const app = Fastify(); await app.register(marketplaceRoutes)
      try {
        const response = await app.inject({ method: bulk ? 'POST' : 'PATCH', url: bulk ? '/products/bulk-offer-availability' : `/products/${f.coordinate.productId}/offer-availability`, payload: bulk
          ? { productIds: [f.coordinate.productId], markets: [f.coordinate], offerActive: false }
          : { markets: [{ ...f.coordinate, offerActive: false }] } })
        expect(response.statusCode, response.body).toBe(200)
        const rows = await f.readBack()
        expect(rows).toHaveLength(2); expect(rows[0].offerActive).toBe(false); expect(rows[1].offerActive).toBe(true)
        expect(state.activate).not.toHaveBeenCalled()
      } finally { await app.close() }
    })
  }, 60_000)

  for (const signal of ['product', 'attributes']) it(`ZERO_PIN push path refuses FBA ${signal} evidence through the shared predicate`, async () => {
    await withPresenceFixture('AMAZON', async f => {
      state.db = f.db
      if (signal === 'product') await f.db.product.update({ where: { id: f.coordinate.productId }, data: { fulfillmentMethod: 'FBA' } })
      else await f.db.channelListing.updateMany({ where: whereCoordinate(f.coordinate), data: { platformAttributes: { fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU' }] } } })
      const app = Fastify(); await app.register(syncRoutes)
      try {
        const response = await app.inject({ method: 'POST', url: '/stock/sync-control/actions', payload: { action: 'ZERO_PIN', listings: [f.coordinate] } })
        expect(response.statusCode, response.body).toBe(200)
        expect(response.json()).toMatchObject({ updated: 0, skippedFba: 1 })
        expect(state.enqueue).not.toHaveBeenCalled()
        expect((await f.readBack()).every(r => r.quantity === 5)).toBe(true)
      } finally { await app.close() }
    })
  }, 60_000)

  it('recovery preview + destructive update: target ASIN is cleared and sibling identity survives', async () => {
    await withPresenceFixture('AMAZON', async f => {
      state.db = f.db
      const req = { ...f.coordinate, action: 'NEW_ASIN_SAME_SKU' as const, initiatedBy: 'PR3-fixture' }
      expect((await previewRecovery(req)).before.asin).toBe(`${f.marker}-0`)
      expect((await executeRecovery(req)).status).toBe('SUCCEEDED')
      const rows = await f.readBack()
      expect(rows).toHaveLength(2); expect(rows[0]).toMatchObject({ externalListingId: null, listingStatus: 'ENDED' })
      expect(rows[1]).toMatchObject({ externalListingId: `${f.marker}-1`, listingStatus: 'DRAFT' })
    })
  }, 60_000)

  it('label backfill: one NULL identity is linked; ENDED target is never reattached', async () => {
    await withPresenceFixture('EBAY', async f => {
      state.db = f.db
      await f.db.channelListing.updateMany({ where: { productId: f.coordinate.productId }, data: { externalListingId: null } })
      expect(await backfillListingIdentity(f.coordinate, `${f.marker}-new`)).toBe(1)
      let rows = await f.readBack()
      expect(rows[0].externalListingId).toBe(`${f.marker}-new`); expect(rows[1].externalListingId).toBeNull()
      await f.db.channelListing.updateMany({ where: whereCoordinate(f.coordinate), data: { externalListingId: null, listingStatus: 'ENDED', isPublished: false, offerActive: false } })
      expect(await backfillListingIdentity(f.coordinate, `${f.marker}-resurrection`)).toBe(0)
      rows = await f.readBack(); expect(rows.every(r => r.externalListingId === null)).toBe(true)
    })
  }, 60_000)

  it('reconciliation confirm: one DRAFT becomes ACTIVE; ENDED target refuses resurrection', async () => {
    await withPresenceFixture('AMAZON', async f => {
      state.db = f.db
      state.recon = { id: 'mock-recon', matchedProductId: f.coordinate.productId, channel: 'AMAZON', marketplace: 'IT', externalListingId: `${f.marker}-0`, parentAsin: null, matchedVariationId: null }
      await confirmReconRow('mock-recon', 'PR3-fixture', f.coordinate)
      let rows = await f.readBack()
      expect(rows[0].listingStatus).toBe('ACTIVE'); expect(rows[1].listingStatus).toBe('DRAFT')
      await f.db.channelListing.updateMany({ where: whereCoordinate(f.coordinate), data: { listingStatus: 'ENDED', isPublished: false } })
      await expect(confirmReconRow('mock-recon', 'PR3-fixture', f.coordinate)).rejects.toThrow('RECON_RECREATE_REQUIRED')
      rows = await f.readBack(); expect(rows[0].listingStatus).toBe('ENDED'); expect(rows[1].listingStatus).toBe('DRAFT')
    })
  }, 60_000)
})

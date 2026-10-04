/** Amazon sheet gaps — the Matrix's quantity verdict as one pure function (what the sheet's stock columns will read). */
import { describe, expect, it } from 'vitest'
import { syncLedgerOf } from '../sync-control-core.js'
import type { ProductLedger } from '../stock-pool/sync-ledgers.js'
import { listingQuantityVerdict } from './listing-quantity-verdict.js'

const ledger = (rows: Array<{ locationCode: string; available: number; syncRoutes: string[] }>): ProductLedger => ({
  productId: 'p', source: { kind: 'own' }, ledger: syncLedgerOf(rows), quantity: 0, available: 0, uncountedIsZero: false, fbaBucket: 0,
})
const listing = (over: Record<string, unknown> = {}) => ({
  channel: 'AMAZON', marketplace: 'IT', fulfillmentMethod: 'FBM', platformAttributes: {}, offerClosedAt: null,
  followMasterQuantity: true, syncPaused: false, quantity: 4, stockBuffer: 1, sourceLocationCodes: [], ...over,
})
const split = ledger([{ locationCode: 'WH-IT', available: 6, syncRoutes: ['AMAZON:IT'] }, { locationCode: 'WH-DE', available: 9, syncRoutes: ['AMAZON:DE'] }])

describe('listingQuantityVerdict', () => {
  it('follow: routed stock minus the buffer; only the locations serving the market', () => {
    const v = listingQuantityVerdict({ listing: listing() as never, productFulfillmentMethod: 'FBM', ledger: split, fbaStockQty: 0, hasActiveFbaOffer: false, channelPolicy: null })
    expect(v).toMatchObject({ isFba: false, resolution: { kind: 'FOLLOW', quantity: 5 }, routed: [{ locationCode: 'WH-IT', available: 6 }], warehouseAvailable: 6, publishable: 5 })
    expect(v.sync).toMatchObject({ kind: 'FOLLOW', mode: 'FOLLOW', intended: 5, held: 4, buffer: 1, poolAvailable: 6, routedLocations: ['WH-IT'], oversold: false })
  })

  it('pinned: the pin; an FBA code under .attributes → FBA_EXCLUDED with no ceiling', () => {
    expect(listingQuantityVerdict({ listing: listing({ followMasterQuantity: false, quantity: 10 }) as never, productFulfillmentMethod: 'FBM', ledger: split, fbaStockQty: 0, hasActiveFbaOffer: false, channelPolicy: null }).resolution)
      .toEqual({ kind: 'PINNED', quantity: 10 })
    const fba = listingQuantityVerdict({ listing: listing({ platformAttributes: { attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU_RAFN' }] } } }) as never,
      productFulfillmentMethod: 'FBM', ledger: split, fbaStockQty: 0, hasActiveFbaOffer: false, channelPolicy: null, fbaAtAmazon: 12 })
    expect(fba).toMatchObject({ isFba: true, resolution: { kind: 'FBA_EXCLUDED' }, publishable: null, sync: { kind: 'FBA_EXCLUDED', fbaAtAmazon: 12 } })
  })

  it('policy pause and a closed offer, verbatim from the resolver', () => {
    expect(listingQuantityVerdict({ listing: listing() as never, productFulfillmentMethod: null, ledger: split, fbaStockQty: 0, hasActiveFbaOffer: false, channelPolicy: { pushesPaused: true } }).resolution)
      .toEqual({ kind: 'PAUSED', via: 'POLICY' })
    expect(listingQuantityVerdict({ listing: listing({ offerClosedAt: new Date() }) as never, productFulfillmentMethod: null, ledger: split, fbaStockQty: 0, hasActiveFbaOffer: false, channelPolicy: null }).resolution)
      .toEqual({ kind: 'CLOSED' })
  })
})

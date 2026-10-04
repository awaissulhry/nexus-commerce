/**
 * Amazon sheet gaps (bug 3) — ONE send quantity for the stock job and Publish. Each case pins what the stock job
 * (`outbound-sync.service.ts` `syncToAmazon`, ~1160–1335) sends for the same listing: Publish used to send 7 where the
 * job sent 10 (pin 10, buffer 3, routed 50), and counted stock in a warehouse that does not serve the market.
 */
import { describe, expect, it } from 'vitest'
import { syncLedgerOf } from '../sync-control-core.js'
import type { ProductLedger } from '../stock-pool/sync-ledgers.js'
import { amazonSendQuantity, routedSendCeiling, type SendQuantityInput } from './send-quantity.js'

const ledger = (rows: Array<{ locationCode: string; available: number; syncRoutes: string[] }>, over: Partial<ProductLedger> = {}): ProductLedger => ({
  productId: 'p1', source: { kind: 'own' }, ledger: syncLedgerOf(rows), quantity: rows.reduce((s, r) => s + r.available, 0),
  available: rows.reduce((s, r) => s + r.available, 0), uncountedIsZero: false, fbaBucket: 0, ...over,
})
const ROUTED_50 = ledger([{ locationCode: 'WH-IT', available: 50, syncRoutes: ['AMAZON:IT'] }])
const listing = (over: Record<string, unknown> = {}) => ({
  marketplace: 'IT', quantity: 10, followMasterQuantity: false, stockBuffer: 3, sourceLocationCodes: [],
  fulfillmentMethod: 'FBM', platformAttributes: { attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT' }] } }, ...over,
})
const input = (over: Partial<SendQuantityInput> = {}): SendQuantityInput => ({
  sku: 'SKU-1', listing: listing() as never, product: { id: 'p1', fulfillmentMethod: 'FBM' }, ledger: ROUTED_50,
  evidence: { fbaStockQty: 0, hasActiveFbaOffer: false }, euRows: [], switches: { orderingV2: true, oversellClamp: true, euGuard: true }, ...over,
})

describe('equals the stock job', () => {
  it('pin 10, buffer 3, routed 50 → 10 (a pin is not reduced by the buffer; the ceiling is 47)', () => {
    const r = amazonSendQuantity(input())
    expect(r).toMatchObject({ quantity: 10, fba: false, refusal: null, clamped: false, available: 47 })
    // The job with its payload quantity (anything): the listing's committed number wins (NEXUS_SYNC_ORDERING_V2).
    expect(amazonSendQuantity(input({ requested: 99 })).quantity).toBe(10)
  })

  it('follow with stock in a location that does not serve the market: that stock is not counted', () => {
    const split = ledger([
      { locationCode: 'WH-IT', available: 5, syncRoutes: ['AMAZON:IT'] },
      { locationCode: 'WH-DE', available: 20, syncRoutes: ['AMAZON:DE'] },
    ])
    // A stale committed number that counted all 25: clamped to the 5 routed to IT.
    const stale = amazonSendQuantity(input({ ledger: split, listing: listing({ followMasterQuantity: true, quantity: 25, stockBuffer: 0 }) as never }))
    expect(stale).toMatchObject({ quantity: 5, clamped: true, requested: 25, available: 5 })
    // No committed number (a new listing, Publish): the resolver's FOLLOW number over the routed rows.
    const fresh = amazonSendQuantity(input({ ledger: split, listing: listing({ followMasterQuantity: true, quantity: null, stockBuffer: 0 }) as never }))
    expect(fresh).toMatchObject({ quantity: 5, clamped: false })
  })

  it('FBA → no quantity at all (product flag, an AMAZON code in either place, FBA stock, an active FBA offer)', () => {
    const cases: Array<Partial<SendQuantityInput>> = [
      { product: { id: 'p1', fulfillmentMethod: 'FBA' } },
      { listing: listing({ platformAttributes: { attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 1 }, { fulfillment_channel_code: 'AMAZON_EU_RAFN' }] } } }) as never },
      { listing: listing({ platformAttributes: { fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU' }] } }) as never },
      { evidence: { fbaStockQty: 4, hasActiveFbaOffer: false } },
      { evidence: { fbaStockQty: 0, hasActiveFbaOffer: true } },
    ]
    for (const c of cases) expect(amazonSendQuantity(input(c))).toMatchObject({ quantity: null, fba: true, refusal: null })
  })

  it('EU shared-quantity conflict → refused with the job\'s sentence; agreeing markets → sent', () => {
    const conflict = amazonSendQuantity(input({ euRows: [
      { marketplace: 'IT', followMasterQuantity: true, quantityOverride: null, quantity: 10 },
      { marketplace: 'DE', followMasterQuantity: false, quantityOverride: 0, quantity: 0 },
    ] }))
    expect(conflict).toMatchObject({ quantity: null, code: 'EU_SHARED_QTY_CONFLICT' })
    expect(conflict.refusal).toMatch(/^EU shared-quantity conflict for SKU-1: IT follow the pool while DE is pinned at 0 .*Push refused so no market's intent is silently overwritten\./)
    expect(conflict.euConflict?.rows).toHaveLength(2)
    const agree = amazonSendQuantity(input({ euRows: [
      { marketplace: 'IT', followMasterQuantity: false, quantityOverride: 10, quantity: 10 },
      { marketplace: 'DE', followMasterQuantity: false, quantityOverride: 10, quantity: 10 },
    ] }))
    expect(agree.quantity).toBe(10)
  })

  it('the EU guard could not run → held, never sent blind; a non-EU market is not checked', () => {
    const held = amazonSendQuantity(input({ euRows: null, euRowsError: 'connection reset' }))
    expect(held).toMatchObject({ quantity: null, code: 'EU_SHARED_QTY_GUARD_UNAVAILABLE' })
    expect(held.refusal).toMatch(/^EU shared-quantity guard could not run for SKU-1 \(connection reset\)\. Push held rather than sent blind/)
    const uk = amazonSendQuantity(input({ euRows: null, listing: listing({ marketplace: 'UK' }) as never, ledger: ledger([{ locationCode: 'WH', available: 50, syncRoutes: [] }]) }))
    expect(uk.quantity).toBe(10)
  })

  it('nothing routed to the market on a pooled product → refused (never capped to 0 and sent)', () => {
    const pooled = ledger([{ locationCode: 'WH-DE', available: 20, syncRoutes: ['AMAZON:DE'] }])
    const r = amazonSendQuantity(input({ ledger: pooled }))
    expect(r).toMatchObject({ quantity: null, code: 'NO_ROUTED_LOCATION' })
    expect(r.refusal).toBe('Nothing was sent to Amazon: no stock location is routed to IT for this listing, so the quantity it may promise cannot be worked out. Route a location to this market in Sync Control.')
    // A product that left a pool: uncounted means 0 — the ceiling is 0, not unknown.
    expect(amazonSendQuantity(input({ ledger: { ...pooled, uncountedIsZero: true } }))).toMatchObject({ quantity: 0, clamped: true })
  })

  it('kill switches as the job reads them: ordering off → the requested number; clamp off → no ceiling; guard off → no EU check', () => {
    expect(amazonSendQuantity(input({ requested: 30, switches: { orderingV2: false, oversellClamp: true, euGuard: true } }))).toMatchObject({ quantity: 30 })
    expect(amazonSendQuantity(input({ listing: listing({ quantity: 80 }) as never, switches: { orderingV2: true, oversellClamp: false, euGuard: true } })).quantity).toBe(80)
    expect(amazonSendQuantity(input({ euRows: null, switches: { orderingV2: true, oversellClamp: true, euGuard: false } })).quantity).toBe(10)
  })

  it('no number anywhere: refused with the reason (paused, closed, uncounted)', () => {
    const paused = amazonSendQuantity(input({ listing: listing({ quantity: null, followMasterQuantity: true, syncPaused: true }) as never }))
    expect(paused).toMatchObject({ quantity: null, code: 'NO_QUANTITY' })
    expect(paused.refusal).toMatch(/paused/)
    expect(amazonSendQuantity(input({ listing: listing({ quantity: null, offerClosedAt: new Date() }) as never })).refusal).toMatch(/closed/)
  })
})

describe('the routed ceiling', () => {
  it('is the routed stock minus the buffer, and names the routed locations', () => {
    const c = routedSendCeiling(ledger([
      { locationCode: 'WH-IT', available: 12, syncRoutes: ['AMAZON:IT'] },
      { locationCode: 'WH-ALL', available: 3, syncRoutes: [] },
      { locationCode: 'WH-DE', available: 40, syncRoutes: ['AMAZON:DE'] },
    ]), { channel: 'AMAZON', channelLabel: 'Amazon', marketplace: 'IT', sourceLocationCodes: [], stockBuffer: 2 })
    expect(c).toEqual({ available: 13, routedAvailable: 15, locationCodes: ['WH-IT', 'WH-ALL'], refusal: null })
  })
})

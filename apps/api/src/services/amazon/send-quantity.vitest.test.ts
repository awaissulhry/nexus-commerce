/**
 * Amazon sheet gaps (bug 3) — ONE send quantity for the stock job and Publish. Each case pins what the stock job
 * (`outbound-sync.service.ts` `syncToAmazon`, ~1160–1335) sends for the same listing: Publish used to send 7 where the
 * job sent 10 (pin 10, buffer 3, routed 50), and counted stock in a warehouse that does not serve the market.
 */
import { describe, expect, it, vi } from 'vitest'

// S3's loader case only: the product's ledger (50 routed to DE) and no channel policy. Every other case passes its ledger.
vi.mock('../stock-pool/sync-ledgers.js', async (original) => {
  const actual = await original<typeof import('../stock-pool/sync-ledgers.js')>()
  const { syncLedgerOf: of } = await import('../sync-control-core.js')
  return { ...actual, loadSyncLedgers: async (_db: unknown, ids: string[]) => new Map(ids.map(id => [id, {
    productId: id, source: { kind: 'own' }, ledger: of([{ locationCode: 'WH-DE', available: 50, syncRoutes: ['AMAZON:DE'] }]),
    quantity: 50, available: 50, uncountedIsZero: false, fbaBucket: 0 }])) }
})
vi.mock('../sync-control-policy.service.js', () => ({ loadChannelPolicies: async () => new Map(), policyFor: () => null }))
import { syncLedgerOf } from '../sync-control-core.js'
import type { ProductLedger } from '../stock-pool/sync-ledgers.js'
import { amazonSendQuantity, loadAmazonSendQuantity, readEuIntentRows, routedSendCeiling, withEuSources, type SendQuantityInput } from './send-quantity.js'
import { detectEuIntentConflict } from '../amazon-eu-quantity-guard.js'

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

  it('after an FBM → FBA conversion is SENT: no merchant quantity for that SKU, on the converted market or a refused one', () => {
    // The conversion writes Nexus FBA BEFORE the patch (fulfilmentAttributes: typed FBA, own entry AMAZON_EU); Amazon's
    // reported copy still says DEFAULT with the old merchant quantity until its report catches up.
    const converted = listing({ fulfillmentMethod: 'FBA', followMasterQuantity: true, quantity: 6, platformAttributes: {
      fulfillmentChannel: 'AFN', fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU' }],
      attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 6 }] },
    } })
    expect(amazonSendQuantity(input({ listing: converted as never, requested: 6, product: { id: 'p1', fulfillmentMethod: 'FBA' } }))).toMatchObject({ quantity: null, fba: true })
    // A market Amazon refused is put back to FBM, but the product's FBA mark stays while another market is FBA: none either.
    expect(amazonSendQuantity(input({ requested: 6, product: { id: 'p1', fulfillmentMethod: 'FBA' } }))).toMatchObject({ quantity: null, fba: true })
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

describe('Step 2 "Sells from" — the EU guard compares what each Follow market sells from', () => {
  const rows2 = (over: Record<string, unknown> = {}) => [
    { marketplace: 'IT', followMasterQuantity: true, quantityOverride: null, quantity: 10 },
    { marketplace: 'DE', followMasterQuantity: true, quantityOverride: null, quantity: 10, ...over },
  ]
  const twoWarehouses = (marketSources?: Map<string, string[]>) => ({
    productId: 'p1', source: { kind: 'own' as const }, quantity: 60, available: 60, uncountedIsZero: false, fbaBucket: 0,
    ledger: syncLedgerOf([{ locationCode: 'IT-MAIN', available: 50, syncRoutes: [] }, { locationCode: 'MI-3PL', available: 10, syncRoutes: [] }], { marketSources }),
  })

  it('withEuSources: each row\'s own list, else the market\'s, else the routes; no ledger → rows unchanged', () => {
    const eu = new Map([['AMAZON:IT', ['MI-3PL', 'IT-MAIN']], ['AMAZON:DE', ['MI-3PL', 'IT-MAIN']]])
    expect(withEuSources(rows2({ sourceLocationCodes: ['IT-MAIN'] }) as never, twoWarehouses(eu)).map((r) => r.sources)).toEqual([['MI-3PL', 'IT-MAIN'], ['IT-MAIN']])
    expect(withEuSources(rows2() as never, twoWarehouses()).map((r) => r.sources)).toEqual([['IT-MAIN', 'MI-3PL'], ['IT-MAIN', 'MI-3PL']])
    const plain = rows2() as never
    expect(withEuSources(plain, undefined)).toBe(plain)
  })

  it('a Follow sibling with its own list fights the market\'s list → refused; all on the market\'s list → sent', () => {
    const eu = new Map([['AMAZON:IT', ['MI-3PL', 'IT-MAIN']], ['AMAZON:DE', ['MI-3PL', 'IT-MAIN']]])
    const follow = listing({ quantity: 57, followMasterQuantity: true })
    const fight = amazonSendQuantity(input({ listing: follow as never, ledger: twoWarehouses(eu), euRows: rows2({ sourceLocationCodes: ['IT-MAIN'] }) as never }))
    expect(fight).toMatchObject({ quantity: null, code: 'EU_SHARED_QTY_CONFLICT' })
    expect(fight.refusal).toMatch(/follow the pool from different warehouses \(IT from IT-MAIN \+ MI-3PL, DE from IT-MAIN\)/)
    expect(amazonSendQuantity(input({ listing: follow as never, ledger: twoWarehouses(eu), euRows: rows2() as never }))).toMatchObject({ quantity: 57, code: null })
  })

  it('the EU sibling read carries a row\'s own list only when it has one', async () => {
    const LIVE = { listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'B0TEST' }
    const sib = (marketplace: string, sourceLocationCodes: string[]) => ({
      marketplace, followMasterQuantity: true, quantityOverride: null, quantity: 5, syncPaused: false, fulfillmentMethod: 'FBM', offerClosedAt: null, sourceLocationCodes,
      aliasKey: '', channelSku: null, liveChannelSku: null, platformAttributes: {}, flatFileSnapshot: null, offers: [], product: { sku: 'SKU-1' }, ...LIVE,
    })
    const rows = await readEuIntentRows({ channelListing: { findMany: async () => [sib('IT', []), sib('DE', ['MI-3PL'])] } } as never, 'p1')
    expect(rows[0]).not.toHaveProperty('sourceLocationCodes')
    expect(rows[1]).toMatchObject({ marketplace: 'DE', sourceLocationCodes: ['MI-3PL'] })
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

/**
 * S3 (per-channel SKU) — the EU sibling read is per seller SKU: Amazon keeps one EU quantity per seller SKU, so a
 * market selling the product under another SKU holds another quantity. A fake reader (the rows the read selects).
 */
describe('S3 — the EU sibling read, per seller SKU', () => {
  const LIVE = { listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'B0TEST' }
  const sib = (marketplace: string, over: Record<string, unknown> = {}) => ({
    marketplace, followMasterQuantity: true, quantityOverride: null, quantity: 5, syncPaused: false, fulfillmentMethod: 'FBM',
    aliasKey: '', channelSku: null, liveChannelSku: null, platformAttributes: {}, flatFileSnapshot: null, offers: [], product: { sku: 'SKU-1' }, ...LIVE, ...over,
  })
  const reader = (rows: unknown[]) => ({ channelListing: { findMany: async () => rows } }) as never
  const markets = (rows: Array<{ marketplace: string }>) => rows.map(r => r.marketplace)

  it('parity: no SKU given → every row, as before', async () => {
    const rows = [sib('IT'), sib('DE', { liveChannelSku: 'OWN-DE' })]
    expect(markets(await readEuIntentRows(reader(rows), 'p1'))).toEqual(['IT', 'DE'])
  })

  it('parity: rows with no SKU of their own all sell under the product SKU', async () => {
    expect(markets(await readEuIntentRows(reader([sib('IT'), sib('DE'), sib('FR')]), 'p1', 'SKU-1'))).toEqual(['IT', 'DE', 'FR'])
  })

  it('a row under another seller SKU is left out; the rows under that SKU are its own group', async () => {
    const rows = [sib('IT'), sib('DE', { liveChannelSku: 'OWN-DE' }), sib('FR', { offers: [{ sku: 'OWN-DE', isActive: true, fulfillmentMethod: 'FBM' }] })]
    expect(markets(await readEuIntentRows(reader(rows), 'p1', 'SKU-1'))).toEqual(['IT'])
    expect(markets(await readEuIntentRows(reader(rows), 'p1', 'OWN-DE'))).toEqual(['DE', 'FR'])
  })

  it('a row whose SKU cannot be told is kept (fail closed)', async () => {
    const rows = [sib('IT'), sib('DE', { platformAttributes: { sellerSku: 'X-1' }, flatFileSnapshot: { item_sku: 'X-2' } })]
    expect(markets(await readEuIntentRows(reader(rows), 'p1', 'SKU-1'))).toEqual(['IT', 'DE'])
  })

  it('the shape the guard reads is unchanged', async () => {
    expect(await readEuIntentRows(reader([sib('DE', { followMasterQuantity: false, quantityOverride: 0, fulfillmentMethod: 'FBA' })]), 'p1', 'SKU-1'))
      .toEqual([{ marketplace: 'DE', followMasterQuantity: false, quantityOverride: 0, quantity: 5, syncPaused: false, isFba: true, offerClosed: false }])
  })

  it('a closed market offer expresses no intent: a live Follow next to a closed pinned market is no conflict (SCT.6)', async () => {
    const rows = [sib('IT'), sib('ES', { followMasterQuantity: false, quantityOverride: null, quantity: 2, offerClosedAt: new Date('2026-10-07T10:17:00Z') })]
    const read = await readEuIntentRows(reader(rows), 'p1', 'SKU-1')
    expect(read.map((r) => [r.marketplace, r.offerClosed])).toEqual([['IT', false], ['ES', true]])
    expect(detectEuIntentConflict(read)).toEqual({ conflict: false, detail: '' })
    // Control: the same ES offer open again is the conflict the guard exists for.
    const open = await readEuIntentRows(reader([sib('IT'), sib('ES', { followMasterQuantity: false, quantityOverride: null, quantity: 2, offerClosedAt: null })]), 'p1', 'SKU-1')
    expect(detectEuIntentConflict(open).conflict).toBe(true)
  })

  it('loadAmazonSendQuantity reads the guard under the listing\'s own seller SKU and names it', async () => {
    const own = { id: 'l-de', productId: 'p1', marketplace: 'DE', quantity: 4, followMasterQuantity: false, stockBuffer: 0, sourceLocationCodes: [],
      fulfillmentMethod: 'FBM', platformAttributes: {}, syncPaused: false, offerClosedAt: null, channelConnectionId: 'amz', aliasKey: '',
      channelSku: 'OWN-DE', liveChannelSku: 'OWN-DE', flatFileSnapshot: null, offers: [], ...LIVE, product: { id: 'p1', sku: 'SKU-1', fulfillmentMethod: 'FBM' } }
    const db = (siblings: unknown[]) => ({
      channelListing: { findUnique: async () => own, findMany: async () => siblings },
      stockLevel: { aggregate: async () => ({ _sum: { quantity: 0 } }) },
      offer: { findFirst: async () => null },
    }) as never
    // IT pinned at 0 under the product SKU is another quantity: no conflict for OWN-DE.
    const apart = await loadAmazonSendQuantity(db([sib('IT', { followMasterQuantity: false, quantityOverride: 0 }), sib('DE', { liveChannelSku: 'OWN-DE', followMasterQuantity: false, quantityOverride: 4 })]), { listingId: 'l-de' })
    expect(apart.code).not.toBe('EU_SHARED_QTY_CONFLICT')
    // FR pinned at 0 under OWN-DE fights DE pinned at 4: refused, by the listing's own SKU.
    const together = await loadAmazonSendQuantity(db([sib('DE', { liveChannelSku: 'OWN-DE', followMasterQuantity: false, quantityOverride: 4 }), sib('FR', { liveChannelSku: 'OWN-DE', followMasterQuantity: false, quantityOverride: 0 })]), { listingId: 'l-de' })
    expect(together).toMatchObject({ code: 'EU_SHARED_QTY_CONFLICT' })
    expect(together.refusal).toMatch(/^EU shared-quantity conflict for OWN-DE: /)
  })
})

/**
 * MX.1 — the door's PURE rules: how a carried change is re-verified (`paramsForChange`) and how a captured cell is
 * restored by VALUE (`restoreWrites`). The stateful paths run in `routes/studio-matrix.routes.vitest.test.ts` (mocked
 * primitives) and in the live fixture rehearsal recorded in `docs/pes-claims.md`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MatrixCells, VerbChange } from '@nexus/shared/matrix-contract'

// The door's version bump runs in a transaction: a stand-in that lets every compare-and-set through (one row each).
// No product here sells from another business's stock (shared stock by SKU: `sharedStockLender` asks the link).
const h = vi.hoisted(() => ({
  findMany: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })),
  // Step 2 ("Sells from"): the business's warehouses, the audit, and the shared-stock link the door asks again.
  locations: vi.fn(async () => [] as Array<{ code: string; name: string; isActive: boolean }>), audit: vi.fn(async () => ({ count: 0 })), link: vi.fn(async () => null as unknown),
}))
vi.mock('../../db.js', () => ({ default: {
  $transaction: async (work: (tx: unknown) => unknown) => work({ channelListing: { updateMany: h.updateMany, findUnique: async () => ({ version: 9 }) } }),
  channelListing: { findMany: h.findMany }, stockPoolLink: { findFirst: h.link }, stockLocation: { findMany: h.locations }, syncControlAudit: { createMany: h.audit },
} }))
vi.mock('../../lib/queue.js', () => ({ addJobSafely: async () => null, outboundSyncQueue: null }))
vi.mock('../follow-master.service.js', () => ({ setFollowMasterQuantity: vi.fn(), setStockBuffer: vi.fn(), amazonManagedListingIds: vi.fn(async () => new Set<string>()) }))
vi.mock('../stock-movement.service.js', () => ({ recascadeAfterSyncControlChange: vi.fn() }))
vi.mock('../sync-coalesce.js', () => ({ coalescePendingQuantityRows: vi.fn() }))
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn() }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refreshMany: vi.fn() } }))
vi.mock('./fulfillment-method.service.js', () => ({ setFulfillmentMethod: vi.fn() }))
vi.mock('./fulfilment-conversion.service.js', () => ({ convertAmazonFulfilment: vi.fn(), loadConversionPlan: vi.fn() }))
vi.mock('./channel-price-write.service.js', () => ({ writeChannelPrices: vi.fn() }))
vi.mock('./matrix.service.js', () => ({ getMatrixRead: vi.fn() }))
vi.mock('../listing-values-events.js', () => ({ announceListingValues: vi.fn() }))

import { applyCell, paramsForChange, restoreWrites, writeMatrixCells } from './matrix-write.service.js'
import { writeChannelPrices, type PriceWriteTarget } from './channel-price-write.service.js'
import { amazonManagedListingIds, setFollowMasterQuantity, setStockBuffer } from '../follow-master.service.js'
import { recascadeAfterSyncControlChange } from '../stock-movement.service.js'
import { announceListingValues } from '../listing-values-events.js'
import { setFulfillmentMethod } from './fulfillment-method.service.js'
import { convertAmazonFulfilment } from './fulfilment-conversion.service.js'
import { getMatrixRead } from './matrix.service.js'
import { productReadCacheService } from '../product-read-cache.service.js'
import { MATRIX_COPY } from '@nexus/shared/matrix-contract'
import { sharedStockReason } from './matrix-cells.js'

const change = (over: Partial<VerbChange>): VerbChange => ({ rowId: 'r', sku: 'S', coordinateKey: 'AMAZON:EU', cell: 'syncQty', from: 1, to: 2, fromLabel: '', toLabel: '', ...over })

describe('paramsForChange — the server rebuilds the params that reproduce ONE carried change', () => {
  it('every price verb re-runs as set-price at the carried value; the inventory verbs carry their value or nothing', () => {
    expect(paramsForChange('adjust-prices', change({ cell: 'price', to: 99.75 }))).toEqual({ verb: 'set-price', value: 99.75 })
    expect(paramsForChange('copy-prices', change({ cell: 'price', to: 80 }))).toEqual({ verb: 'set-price', value: 80 })
    expect(paramsForChange('pin-quantity', change({ to: 4 }))).toEqual({ verb: 'pin-quantity', value: 4 })
    expect(paramsForChange('set-buffer', change({ cell: 'syncBuffer', to: 2 }))).toEqual({ verb: 'set-buffer', value: 2 })
    expect(paramsForChange('set-follow', change({ cell: 'syncMode', to: 'FOLLOW' }))).toEqual({ verb: 'set-follow' })
    expect(paramsForChange('set-fulfilment', change({ cell: 'fulfilment', to: 'FBM' }))).toEqual({ verb: 'set-fulfilment', method: 'FBM' })
    expect(paramsForChange('pause-sync', change({ cell: 'syncState', to: 'PAUSED' }))).toEqual({ verb: 'pause-sync' })
  })
  it('a carried change whose value is not what the verb takes cannot be rebuilt — so it cannot be applied', () => {
    expect(paramsForChange('set-price', change({ cell: 'price', to: 'free' }))).toBeNull()
    expect(paramsForChange('set-fulfilment', change({ cell: 'fulfilment', to: 'DROPSHIP' }))).toBeNull()
  })
  it('Sells from re-runs with the carried list ([] = the market default); anything but a list of codes cannot be rebuilt', () => {
    expect(paramsForChange('set-source', change({ cell: 'source', from: [], to: ['MI-3PL', 'IT-MAIN'] }))).toEqual({ verb: 'set-source', codes: ['MI-3PL', 'IT-MAIN'] })
    expect(paramsForChange('set-source', change({ cell: 'source', from: ['MI-3PL'], to: [] }))).toEqual({ verb: 'set-source', codes: [] })
    expect(paramsForChange('set-source', change({ cell: 'source', to: 'IT-MAIN' }))).toBeNull()
    expect(paramsForChange('set-source', change({ cell: 'source', to: [3] }))).toBeNull()
  })
})

const cells = (over: Partial<MatrixCells>): MatrixCells => ({
  listingId: 'l', version: 1, listing: null,
  fulfilment: { method: 'FBM', source: 'set', guard: 'FBM', reported: null },
  sync: { kind: 'FOLLOW', via: null, mode: 'FOLLOW', intended: 10, held: 10, buffer: 0, poolAvailable: 10, routedLocations: ['IT-MAIN'], fbaAtAmazon: null, oversold: false },
  queue: null, price: { value: 100, currency: 'EUR', source: 'master', formula: null, clamped: null }, sale: { value: null, start: null, end: null },
  writable: {}, writeBlockedReason: {}, ...over,
})

describe('restoreWrites — the writes that take a live cell back to its captured value, in door order', () => {
  it('a pin is undone with Follow; a Follow that became a pin is restored by pinning at the captured value', () => {
    const before = cells({})
    const live = cells({ sync: { ...before.sync!, kind: 'PINNED', mode: 'PINNED', intended: 7, held: 7 } })
    expect(restoreWrites('r', 'AMAZON:EU', before, live)).toEqual([{ kind: 'cell', cell: 'syncMode', value: 'FOLLOW' }])
    expect(restoreWrites('r', 'AMAZON:EU', live, before)).toEqual([{ kind: 'cell', cell: 'syncQty', value: 7 }])
  })
  it('a pause is undone before the value writes; a master price is restored by CLEARING the override; a sale is restored whole', () => {
    const before = cells({})
    const live = cells({
      sync: { ...before.sync!, kind: 'PAUSED', via: 'LISTING', intended: null, buffer: 3 },
      fulfilment: { method: 'FBA', source: 'set', guard: 'FBA', reported: null },
      price: { value: 90, currency: 'EUR', source: 'override', formula: null, clamped: null },
      sale: { value: 80, start: '2026-09-14', end: '2026-09-20' },
    })
    expect(restoreWrites('r', 'EBAY:IT', before, live)).toEqual([
      { kind: 'state', verb: 'resume-sync' },
      { kind: 'cell', cell: 'fulfilment', value: 'FBM' },
      { kind: 'cell', cell: 'syncBuffer', value: 0 },
      { kind: 'cell', cell: 'price', value: null },
      { kind: 'cell', cell: 'salePrice', value: { value: null, start: null, end: null } },
    ])
    /* Amazon (2026-10-07): never a value-only fulfilment write — the revert sends the opposite conversion instead. */
    expect(restoreWrites('r', 'AMAZON:EU', before, live)).toEqual([
      { kind: 'state', verb: 'resume-sync' },
      { kind: 'cell', cell: 'syncBuffer', value: 0 },
      { kind: 'cell', cell: 'price', value: null },
      { kind: 'cell', cell: 'salePrice', value: { value: null, start: null, end: null } },
    ])
  })
  it('Sells from is restored to the listing\'s own list as it was ([] = the market default again); the same list needs nothing', () => {
    const src = (own: string[]) => ({ own, marketDefault: ['IT-MAIN'], defaultOrigin: 'routes' as const, effective: [], writable: true, blockedReason: null })
    expect(restoreWrites('r', 'AMAZON:EU', cells({ source: src([]) }), cells({ source: src(['MI-3PL', 'IT-MAIN']) }))).toEqual([{ kind: 'cell', cell: 'source', value: [] }])
    expect(restoreWrites('r', 'AMAZON:EU', cells({ source: src(['MI-3PL']) }), cells({ source: src([]) }))).toEqual([{ kind: 'cell', cell: 'source', value: ['MI-3PL'] }])
    expect(restoreWrites('r', 'AMAZON:EU', cells({ source: src(['MI-3PL']) }), cells({ source: src(['mi-3pl']) }))).toEqual([])
  })
  it('an identical live cell needs nothing; a formula-owned price and an FBA row are left alone', () => {
    expect(restoreWrites('r', 'AMAZON:EU', cells({}), cells({}))).toEqual([])
    const formula = cells({ price: { value: 95, currency: 'EUR', source: 'formula', formula: '= $basePrice * 0.95', clamped: null } })
    expect(restoreWrites('r', 'AMAZON:EU', formula, cells({ price: { value: 90, currency: 'EUR', source: 'override', formula: null, clamped: null } }))).toEqual([])
    const fba = cells({ sync: { kind: 'FBA_EXCLUDED', via: null, mode: 'FOLLOW', intended: null, held: null, buffer: 0, poolAvailable: 10, routedLocations: [], fbaAtAmazon: 4, oversold: false } })
    expect(restoreWrites('r', 'AMAZON:EU', fba, cells({ sync: { ...fba.sync!, mode: 'PINNED' } }))).toEqual([])
  })
})

// A-17 (R-12) — the price the operator saw reaches the door, so a version moved by something else can be retried.
describe('applyCell passes the price it read as expectedPrice', () => {
  const read = (price: { value: number | null; source: 'master' | 'override' | 'formula'; clamped?: 'floor' | 'ceiling' | null }) => ({
    rows: [{ id: 'row', cells: { 'EBAY:IT': { listingId: 'listing', version: 7, price: { currency: 'EUR', formula: null, clamped: null, ...price },
      sale: null, listing: null, fulfilment: null, sync: null, queue: null, writable: { price: true }, writeBlockedReason: {} } } }],
    coordinates: [{ key: 'EBAY:IT', kind: 'market', channel: 'EBAY', market: 'IT', label: 'eBay · IT', region: null }],
  }) as never
  const ctx = { productId: 'row', actor: 'tester', can: () => true }
  const cell = { rowId: 'row', coordinateKey: 'EBAY:IT', cell: 'price', value: 30, expectedVersion: 7 } as never
  it.each([
    ['a pinned price', { value: 25, source: 'override' as const }, 25],
    ['a price following the master', { value: 10, source: 'master' as const }, null],
    ['a clamped price', { value: 25, source: 'override' as const, clamped: 'floor' as const }, undefined],
  ])('%s', async (_name, price, expected) => {
    const door = vi.mocked(writeChannelPrices)
    door.mockReset().mockResolvedValue({ results: [{ listingId: 'listing', productId: 'row', channel: 'EBAY', marketplace: 'IT', outcome: 'applied', version: 8, guarded: true, queueId: null }], applied: 1, refused: 0, noop: 0, conflict: 0 })
    await applyCell(read(price), cell, ctx)
    // The door's own target type: `expectedPrice` is on both of its shapes, so no cast is needed to read it.
    const target: PriceWriteTarget = door.mock.calls[0][0].targets[0]
    expect(target).toMatchObject({ listingId: 'listing', price: 30, expectedVersion: 7 })
    if (expected === undefined) expect(target).not.toHaveProperty('expectedPrice')
    else expect(target.expectedPrice).toBe(expected)
  })
})

// 2026-09-30 — Etsy's listing API has no sale price, so the read serves no Sale cell for an Etsy coordinate
// (`channelShape`), and a sale written at one anyway (an old tab, a hand-made request) is refused before the door.
describe('an Etsy coordinate has no Sale cell', () => {
  it('a sale written there is refused by name, and the price door is never called', async () => {
    const door = vi.mocked(writeChannelPrices); door.mockReset()
    const read = {
      rows: [{ id: 'row', cells: { 'ETSY:GLOBAL': { ...cells({ fulfilment: null, sync: null }), sale: null, listingId: 'listing', version: 3 } } }],
      coordinates: [{ key: 'ETSY:GLOBAL', kind: 'global', channel: 'ETSY', market: 'GLOBAL', label: 'Etsy', region: null }],
    } as never
    const outcome = await applyCell(read, { rowId: 'row', coordinateKey: 'ETSY:GLOBAL', cell: 'salePrice', value: { value: 19, start: '2026-10-01', end: '2026-10-08' }, expectedVersion: 3 } as never, { productId: 'row', actor: 'tester', can: () => true })
    // The fresh read the door re-reads serves no writable Sale cell there, so it is refused before any value check.
    expect(outcome).toMatchObject({ outcome: 'refused', reason: 'This cell cannot be changed here' })
    expect(door).not.toHaveBeenCalled()
  })
})

// 2026-10-01 — Etsy stock joins the cascade. The door hands an Etsy inventory cell to the same primitives as every other
// channel, which now queue the Etsy row (`follow-master.bulk.vitest.test.ts`, `etsy-stock-cascade.vitest.test.ts`).
describe('an Etsy coordinate\'s Mode, Qty and Buffer cells go through the follow / pin / buffer primitives', () => {
  const read = () => ({
    rows: [{ id: 'row', cells: { 'ETSY:GLOBAL': { ...cells({ fulfilment: null }), listingId: 'listing', version: 3, writable: { syncMode: true, syncQty: true, syncBuffer: true } } } }],
    coordinates: [{ key: 'ETSY:GLOBAL', kind: 'global', channel: 'ETSY', market: 'GLOBAL', label: 'Etsy', region: null }],
  }) as never
  const ctx = { productId: 'row', actor: 'tester', can: () => true }
  const done = { updated: 1, skippedFba: 0, unchanged: 0, matched: 1, results: [] }

  it.each([
    ['syncMode', 'PINNED', () => expect(setFollowMasterQuantity).toHaveBeenCalledWith({ productIds: ['row'], channel: 'ETSY', markets: ['GLOBAL'], follow: false, actor: 'tester' })],
    ['syncQty', 4, () => expect(setFollowMasterQuantity).toHaveBeenCalledWith({ productIds: ['row'], channel: 'ETSY', markets: ['GLOBAL'], follow: false, actor: 'tester' })],
    ['syncBuffer', 2, () => expect(setStockBuffer).toHaveBeenCalledWith({ productIds: ['row'], channel: 'ETSY', markets: ['GLOBAL'], buffer: 2, actor: 'tester' })],
  ] as const)('%s', async (cell, value, called) => {
    vi.mocked(setFollowMasterQuantity).mockReset().mockResolvedValue(done)
    vi.mocked(setStockBuffer).mockReset().mockResolvedValue({ ...done, results: [] })
    const outcome = await applyCell(read(), { rowId: 'row', coordinateKey: 'ETSY:GLOBAL', cell, value, expectedVersion: 3 } as never, ctx)
    expect(outcome).toMatchObject({ outcome: 'applied', version: 4 })
    called()
  })
})

// Amazon sheet gaps (design-sync §1.B) — the outcome names every listing row it moved, so the sheet and the Matrix adopt
// the new versions; another listing on the coordinate is a conflict; the door reads with the caller's account.
describe('the door answers the listings it moved, refuses a listing it did not expect, and reads with the caller’s account', () => {
  const EU_ROWS = [{ id: 'l-it', marketplace: 'IT', version: 3, offerClosedAt: null }, { id: 'l-de', marketplace: 'DE', version: 5, offerClosedAt: null }]
  const euRead = (version = 3) => ({
    version: 1, productId: 'root',
    rows: [{ id: 'row', sku: 'S', cells: {
      'AMAZON:EU': { ...cells({}), listingId: 'l-it', version, writable: { fulfilment: true, syncMode: true, syncQty: true, syncBuffer: true } },
      'AMAZON:IT': { ...cells({ fulfilment: null, sync: null }), listingId: 'l-it', version, writable: { price: true, salePrice: true } },
    } }],
    coordinates: [
      { key: 'AMAZON:EU', kind: 'region-inventory', channel: 'AMAZON', market: 'EU', label: 'Amazon EU', region: 'EU', accountId: 'acc', sharedInventoryWith: ['IT', 'DE'], vocabulary: { fulfilment: ['FBA', 'FBM'] } },
      { key: 'AMAZON:IT', kind: 'market', channel: 'AMAZON', market: 'IT', label: 'Amazon · IT', region: 'EU', accountId: 'acc', sharedInventoryWith: null, vocabulary: { fulfilment: ['FBA', 'FBM'] } },
    ],
  }) as never
  const ctx = { productId: 'root', actor: 'tester', can: () => true }
  const done = { updated: 2, skippedFba: 0, unchanged: 0, matched: 2, results: [] }
  const EU_AFTER = [{ listingId: 'l-it', productId: 'row', version: 4 }, { listingId: 'l-de', productId: 'row', version: 6 }]

  beforeEach(() => {
    h.findMany.mockReset().mockResolvedValue(EU_ROWS)
    h.updateMany.mockClear()
    vi.mocked(setFollowMasterQuantity).mockReset().mockResolvedValue(done)
    vi.mocked(setStockBuffer).mockReset().mockResolvedValue({ ...done, results: [] })
    vi.mocked(getMatrixRead).mockReset().mockImplementation(async () => euRead())
    vi.mocked(productReadCacheService.refreshMany).mockReset().mockResolvedValue(undefined as never)
  })

  it.each([['syncMode', 'PINNED'], ['syncQty', 7], ['syncBuffer', 2]] as const)('an EU %s write returns every EU row at its version + 1', async (cell, value) => {
    const outcome = await applyCell(euRead(), { rowId: 'row', coordinateKey: 'AMAZON:EU', cell, value, expectedVersion: 3 } as never, ctx)
    expect(outcome).toMatchObject({ outcome: 'applied', version: 4, expandedTo: ['AMAZON:IT', 'AMAZON:DE'] })
    expect(outcome.listings).toEqual(EU_AFTER)
  })

  it('fulfilment and price answer the versions their own doors report', async () => {
    /* Amazon (2026-10-07): the conversion answers the listings it wrote, Amazon's partial refusal by name. */
    vi.mocked(setFulfillmentMethod).mockReset()
    vi.mocked(convertAmazonFulfilment).mockReset().mockResolvedValue({ outcome: 'applied', reason: 'Sent to Amazon IT — Amazon DE refused: Amazon refused it: 8541', listings: [{ listingId: 'l-it', productId: 'row', version: 4 }], runId: 'run', accepted: ['IT'], refused: [{ market: 'DE', reason: 'Amazon refused it: 8541' }] })
    const f = await applyCell(euRead(), { rowId: 'row', coordinateKey: 'AMAZON:EU', cell: 'fulfilment', value: 'FBA', expectedVersion: 3 } as never, { ...ctx, conversion: 'matrix-verb' })
    expect(f).toMatchObject({ outcome: 'applied', version: 4, reason: expect.stringContaining('Amazon DE refused'), listings: [{ listingId: 'l-it', productId: 'row', version: 4 }] })
    expect(vi.mocked(convertAmazonFulfilment).mock.calls[0]![0]).toMatchObject({ primaryListingId: 'l-it', to: 'FBA', origin: 'matrix-verb', targets: [{ id: 'l-it', marketplace: 'IT', version: 3 }, { id: 'l-de', marketplace: 'DE', version: 5 }] })
    expect(setFulfillmentMethod).not.toHaveBeenCalled()

    vi.mocked(writeChannelPrices).mockReset().mockResolvedValue({ results: [{ listingId: 'l-it', productId: 'row', channel: 'AMAZON', marketplace: 'IT', outcome: 'applied', version: 4, guarded: true, queueId: null }], applied: 1, refused: 0, noop: 0, conflict: 0 })
    const p = await applyCell(euRead(), { rowId: 'row', coordinateKey: 'AMAZON:IT', cell: 'price', value: 90, expectedVersion: 3 } as never, ctx)
    expect(p).toMatchObject({ outcome: 'applied', version: 4, listings: [{ listingId: 'l-it', productId: 'row', version: 4 }] })
  })

  it('an Amazon Fulfilment cell written directly (not the confirmed verb) is refused by name; nothing is converted', async () => {
    vi.mocked(convertAmazonFulfilment).mockReset()
    vi.mocked(setFulfillmentMethod).mockReset()
    const f = await applyCell(euRead(), { rowId: 'row', coordinateKey: 'AMAZON:EU', cell: 'fulfilment', value: 'FBM', expectedVersion: 3 } as never, ctx)
    expect(f).toMatchObject({ outcome: 'refused', reason: MATRIX_COPY.fulfilmentViaVerb, version: 3 })
    expect(convertAmazonFulfilment).not.toHaveBeenCalled()
    expect(setFulfillmentMethod).not.toHaveBeenCalled()
    /* A clear is not a conversion on Amazon, even from the confirmed verb. */
    const cleared = await applyCell(euRead(), { rowId: 'row', coordinateKey: 'AMAZON:EU', cell: 'fulfilment', value: null, expectedVersion: 3 } as never, { ...ctx, conversion: 'matrix-verb' })
    expect(cleared).toMatchObject({ outcome: 'refused', reason: expect.stringContaining('FBA or FBM') })
  })

  it('a refusal after the rows were staged still reports them (their versions moved)', async () => {
    vi.mocked(setStockBuffer).mockResolvedValue({ ...done, results: [{ listingId: 'l-de', sku: 'S', channel: 'AMAZON', marketplace: 'DE', action: 'SKIPPED_FBA', buffer: 0, quantity: null }] })
    const outcome = await applyCell(euRead(), { rowId: 'row', coordinateKey: 'AMAZON:EU', cell: 'syncBuffer', value: 2, expectedVersion: 3 } as never, ctx)
    expect(outcome).toMatchObject({ outcome: 'refused', reason: MATRIX_COPY.amazonManaged, version: 4, listings: EU_AFTER })
  })

  /* GALE 2026-10-08: sizes converted FBA → FBM on Amazon IT, their DE offer closed, an SE row still a never-published
     draft that reads FBA. The preview showed Follow; the commit refused "Amazon-managed" because the draft voted. */
  describe('a never-published draft does not vote in the FBA verdict; a live FBA offer still refuses the whole write', () => {
    const GROUP = [
      { id: 'l-it', marketplace: 'IT', version: 3, offerClosedAt: null },
      { id: 'l-de', marketplace: 'DE', version: 5, offerClosedAt: new Date('2026-10-07T00:00:00Z') },
      { id: 'l-se', marketplace: 'SE', version: 1, offerClosedAt: null },
    ]
    const live = (ids: string[]) => (args: { where?: { isPublished?: boolean; id?: { in?: string[] } } }) =>
      args?.where?.isPublished ? (args.where.id?.in ?? []).filter((id) => ids.includes(id)).map((id) => ({ id })) : GROUP
    const fbaAmong = (fba: string[]) => async (ids: readonly string[]) => new Set(ids.filter((id) => fba.includes(id)))

    it('closed FBA DE + FBM IT + draft FBA SE → Follow applied; the verdict asks about the live IT offer only', async () => {
      h.findMany.mockReset().mockImplementation(async (args: never) => live(['l-it'])(args))
      vi.mocked(amazonManagedListingIds).mockReset().mockImplementation(fbaAmong(['l-de', 'l-se']))
      vi.mocked(setFollowMasterQuantity).mockReset().mockResolvedValue({ ...done, results: [
        { listingId: 'l-it', sku: 'S', channel: 'AMAZON', marketplace: 'IT', action: 'FOLLOW', quantity: 41 },
        { listingId: 'l-se', sku: 'S', channel: 'AMAZON', marketplace: 'SE', action: 'SKIPPED_FBA', quantity: null },
      ] })
      const read = euRead()
      ;(read as { rows: Array<{ cells: Record<string, { sync: unknown }> }> }).rows[0]!.cells['AMAZON:EU']!.sync = { ...cells({}).sync!, kind: 'PINNED', mode: 'PINNED' }
      const outcome = await applyCell(read, { rowId: 'row', coordinateKey: 'AMAZON:EU', cell: 'syncMode', value: 'FOLLOW', expectedVersion: 3 } as never, ctx)
      expect(outcome).toMatchObject({ outcome: 'applied', version: 4, expandedTo: ['AMAZON:IT', 'AMAZON:SE'] })
      expect(vi.mocked(amazonManagedListingIds).mock.calls[0]![0]).toEqual(['l-it'])
      expect(vi.mocked(setFollowMasterQuantity).mock.calls[0]![0]).toMatchObject({ follow: true, markets: ['IT', 'SE'] })
    })

    it('the same holds for a buffer: a draft the primitive skips as FBA does not refuse it', async () => {
      h.findMany.mockReset().mockImplementation(async (args: never) => live(['l-it'])(args))
      vi.mocked(amazonManagedListingIds).mockReset().mockImplementation(fbaAmong(['l-se']))
      vi.mocked(setStockBuffer).mockReset().mockResolvedValue({ ...done, results: [{ listingId: 'l-se', sku: 'S', channel: 'AMAZON', marketplace: 'SE', action: 'SKIPPED_FBA', buffer: 0, quantity: null }] })
      const outcome = await applyCell(euRead(), { rowId: 'row', coordinateKey: 'AMAZON:EU', cell: 'syncBuffer', value: 2, expectedVersion: 3 } as never, ctx)
      expect(outcome).toMatchObject({ outcome: 'applied', version: 4 })
    })

    it('an OPEN, published FBA DE offer beside FBM IT still refuses the whole write before anything is staged', async () => {
      const open = GROUP.map((r) => (r.id === 'l-de' ? { ...r, offerClosedAt: null } : r))
      h.findMany.mockReset().mockImplementation(async (args: { where?: { isPublished?: boolean; id?: { in?: string[] } } }) =>
        args?.where?.isPublished ? (args.where.id?.in ?? []).filter((id) => id !== 'l-se').map((id) => ({ id })) : open)
      h.updateMany.mockClear()
      vi.mocked(amazonManagedListingIds).mockReset().mockImplementation(fbaAmong(['l-de']))
      vi.mocked(setFollowMasterQuantity).mockReset().mockResolvedValue(done)
      const outcome = await applyCell(euRead(), { rowId: 'row', coordinateKey: 'AMAZON:EU', cell: 'syncQty', value: 7, expectedVersion: 3 } as never, ctx)
      expect(outcome).toMatchObject({ outcome: 'refused', reason: MATRIX_COPY.amazonManaged, version: 3 })
      expect(h.updateMany).not.toHaveBeenCalled()
      expect(setFollowMasterQuantity).not.toHaveBeenCalled()
    })

    it('a LIVE offer the primitive skips as FBA still refuses (staged), as before', async () => {
      h.findMany.mockReset().mockImplementation(async (args: never) => live(['l-it', 'l-se'])(args))
      vi.mocked(amazonManagedListingIds).mockReset().mockResolvedValue(new Set())
      vi.mocked(setFollowMasterQuantity).mockReset().mockResolvedValue({ ...done, results: [{ listingId: 'l-se', sku: 'S', channel: 'AMAZON', marketplace: 'SE', action: 'SKIPPED_FBA', quantity: null }] })
      const outcome = await applyCell(euRead(), { rowId: 'row', coordinateKey: 'AMAZON:EU', cell: 'syncQty', value: 7, expectedVersion: 3 } as never, ctx)
      expect(outcome).toMatchObject({ outcome: 'refused', reason: MATRIX_COPY.amazonManaged, version: 4 })
    })
  })

  it('another listing on the coordinate than the caller saw is a conflict carrying the current version; nothing is written', async () => {
    const outcome = await applyCell(euRead(), { rowId: 'row', coordinateKey: 'AMAZON:EU', cell: 'syncQty', value: 7, expectedVersion: 3, expectedListingId: 'l-other-account' } as never, ctx)
    expect(outcome).toEqual({ rowId: 'row', coordinateKey: 'AMAZON:EU', cell: 'syncQty', outcome: 'conflict', reason: MATRIX_COPY.changedElsewhere, version: 3 })
    expect(h.updateMany).not.toHaveBeenCalled()
    expect(setFollowMasterQuantity).not.toHaveBeenCalled()
    /* positive control: the listing the caller saw → applied */
    const ok = await applyCell(euRead(), { rowId: 'row', coordinateKey: 'AMAZON:EU', cell: 'syncQty', value: 7, expectedVersion: 3, expectedListingId: 'l-it' } as never, ctx)
    expect(ok).toMatchObject({ outcome: 'applied', version: 4 })
  })

  it('the same expectedVersion twice is a conflict with the current version and the one sentence — in one write and across two', async () => {
    const one = await writeMatrixCells(ctx, [
      { rowId: 'row', coordinateKey: 'AMAZON:EU', cell: 'syncQty', value: 7, expectedVersion: 3 },
      { rowId: 'row', coordinateKey: 'AMAZON:EU', cell: 'syncBuffer', value: 2, expectedVersion: 3 },
    ])
    expect(one.results.map((r) => [r.outcome, r.version, r.reason])).toEqual([['applied', 4, undefined], ['conflict', 4, 'Changed elsewhere — reloaded']])
    expect(setStockBuffer).not.toHaveBeenCalled()
    // A second request carrying the version the first one spent: the fresh read holds 4.
    vi.mocked(getMatrixRead).mockImplementation(async () => euRead(4))
    const two = await writeMatrixCells(ctx, [{ rowId: 'row', coordinateKey: 'AMAZON:EU', cell: 'syncQty', value: 8, expectedVersion: 3 }])
    expect(two.results[0]).toMatchObject({ outcome: 'conflict', version: 4, reason: MATRIX_COPY.changedElsewhere })
  })

  it('the caller’s accountId reaches the read (the GET’s account), and none means none', async () => {
    await writeMatrixCells({ ...ctx, accountId: 'acc-2' }, [])
    expect(getMatrixRead).toHaveBeenLastCalledWith(expect.objectContaining({ productId: 'root', accountId: 'acc-2' }))
    await writeMatrixCells(ctx, [])
    expect(getMatrixRead).toHaveBeenLastCalledWith(expect.objectContaining({ productId: 'root', accountId: null }))
  })
})

/**
 * Step 2 (Owner 2026-10-07) — "Sells from" through the one door: `inventory.adjust`, the read's own gate, the codes checked
 * against this business's warehouses NOW, a list equal to the market default stored as [], the same list a noop, and on
 * Amazon EU the SAME list on every EU row of the SKU — closed offers included — each version-checked, then audited,
 * announced (`stockSource`, `quantity`) and re-pushed.
 */
describe('applyCell — Sells from (cell: source)', () => {
  const EU_ROWS = [
    { id: 'l-it', marketplace: 'IT', version: 3, offerClosedAt: null },
    { id: 'l-de', marketplace: 'DE', version: 5, offerClosedAt: new Date('2026-10-01T00:00:00Z') },
    { id: 'l-fr', marketplace: 'FR', version: 2, offerClosedAt: null },
  ]
  const WAREHOUSES = [
    { code: 'IT-MAIN', name: 'Italy main', isActive: true },
    { code: 'MI-3PL', name: 'Milan 3PL', isActive: true },
    { code: 'OLD', name: 'Old store', isActive: false },
  ]
  const source = (over: Partial<NonNullable<MatrixCells['source']>> = {}): NonNullable<MatrixCells['source']> => ({
    own: [], marketDefault: ['IT-MAIN'], defaultOrigin: 'routes', effective: [{ code: 'IT-MAIN', available: 12 }], writable: true, blockedReason: null, ...over,
  })
  const read = (src: MatrixCells['source'] = source(), role: 'parent' | 'variant' = 'variant') => ({
    version: 1, productId: 'root',
    rows: [{ id: 'row', sku: 'GALE-M', role, cells: {
      'AMAZON:EU': { ...cells({}), listingId: 'l-it', version: 3, writable: { syncMode: true, syncQty: true, syncBuffer: true }, source: src },
      'AMAZON:IT': { ...cells({ fulfilment: null, sync: null }), listingId: 'l-it', version: 3, writable: { price: true } },
      'EBAY:IT': { ...cells({ fulfilment: null }), listingId: 'l-eb', version: 7, writable: { syncMode: true, syncQty: true }, source: src },
    } }],
    coordinates: [
      { key: 'AMAZON:EU', kind: 'region-inventory', channel: 'AMAZON', market: 'EU', label: 'Amazon EU', region: 'EU', accountId: 'acc', sharedInventoryWith: ['IT', 'DE', 'FR'], vocabulary: { fulfilment: ['FBA', 'FBM'] } },
      { key: 'AMAZON:IT', kind: 'market', channel: 'AMAZON', market: 'IT', label: 'Amazon · IT', region: 'EU', accountId: 'acc', sharedInventoryWith: null, inventoryOn: 'AMAZON:EU', vocabulary: { fulfilment: ['FBA', 'FBM'] } },
      { key: 'EBAY:IT', kind: 'market', channel: 'EBAY', market: 'IT', label: 'eBay · IT', region: null, accountId: 'e1', sharedInventoryWith: null, vocabulary: { fulfilment: ['FBM', 'MCF'] } },
    ],
  }) as never
  const STOCK = 'inventory.adjust'
  const ctx = { productId: 'root', actor: 'tester', can: (p: string) => p === STOCK }
  const write = (value: unknown, over: { key?: string; version?: number; read?: unknown; ctx?: typeof ctx } = {}) =>
    applyCell((over.read ?? read()) as never, { rowId: 'row', coordinateKey: over.key ?? 'AMAZON:EU', cell: 'source', value, expectedVersion: over.version ?? (over.key === 'EBAY:IT' ? 7 : 3) }, over.ctx ?? ctx)

  beforeEach(() => {
    h.findMany.mockReset().mockImplementation(async (args: { select?: Record<string, unknown> }) =>
      args?.select?.sourceLocationCodes ? EU_ROWS.map((r) => ({ id: r.id, sourceLocationCodes: r.id === 'l-de' ? ['OLD'] : [] })) : EU_ROWS)
    h.updateMany.mockReset().mockResolvedValue({ count: 1 })
    h.locations.mockReset().mockResolvedValue(WAREHOUSES)
    h.audit.mockReset().mockResolvedValue({ count: 3 })
    h.link.mockReset().mockResolvedValue(null)
    vi.mocked(amazonManagedListingIds).mockReset().mockResolvedValue(new Set())
    vi.mocked(announceListingValues).mockReset()
    vi.mocked(recascadeAfterSyncControlChange).mockReset().mockResolvedValue({ ok: 1, noLedger: 0, failed: 0, heldPricesSent: 0 })
  })

  it('Amazon EU: the same list lands on EVERY EU row — the closed DE offer too — each version-checked; audited, announced, re-pushed', async () => {
    const out = await write(['mi-3pl', 'IT-MAIN'])
    expect(out).toMatchObject({ cell: 'source', outcome: 'applied', version: 4, expandedTo: ['AMAZON:IT', 'AMAZON:DE', 'AMAZON:FR'] })
    expect(out.listings).toEqual([{ listingId: 'l-it', productId: 'row', version: 4 }, { listingId: 'l-de', productId: 'row', version: 6 }, { listingId: 'l-fr', productId: 'row', version: 3 }])
    /* stored in the warehouse's own spelling, in the chosen order */
    for (const [id, version] of [['l-it', 3], ['l-de', 5], ['l-fr', 2]] as const) {
      expect(h.updateMany).toHaveBeenCalledWith({ where: { id, version }, data: { sourceLocationCodes: ['MI-3PL', 'IT-MAIN'], version: { increment: 1 } } })
    }
    const audit = (h.audit.mock.calls[0] as unknown as [{ data: Array<Record<string, unknown>> }])[0].data
    expect(audit).toHaveLength(3)
    expect(audit.find((a) => a.scopeId === 'l-de')).toMatchObject({ scopeType: 'LISTING', field: 'sourceLocationCodes', scopeName: 'GALE-M@AMAZON:DE', before: { sourceLocationCodes: ['OLD'] }, after: { sourceLocationCodes: ['MI-3PL', 'IT-MAIN'] }, reason: 'matrix', actor: 'tester' })
    expect(announceListingValues).toHaveBeenCalledWith(['l-it', 'l-de', 'l-fr'], ['stockSource', 'quantity'], 'matrix')
    expect(recascadeAfterSyncControlChange).toHaveBeenCalledWith(['row'], 'tester')
  })

  it('a list equal to the market default is stored as []; the list the listing already has is a noop that spends nothing', async () => {
    expect(await write(['IT-MAIN'], { read: read(source({ own: ['MI-3PL'] })) })).toMatchObject({ outcome: 'applied' })
    expect(h.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { sourceLocationCodes: [], version: { increment: 1 } } }))
    h.updateMany.mockClear()
    expect(await write([])).toMatchObject({ outcome: 'noop', version: 3 }) // [] already follows the default
    expect(await write(['IT-MAIN'])).toMatchObject({ outcome: 'noop', version: 3 })
    expect(await write(['MI-3PL'], { read: read(source({ own: ['MI-3PL'] })) })).toMatchObject({ outcome: 'noop' })
    expect(h.updateMany).not.toHaveBeenCalled(); expect(announceListingValues).toHaveBeenCalledTimes(1)
  })

  it('one market (eBay IT) writes its own listing only', async () => {
    const out = await write(['MI-3PL'], { key: 'EBAY:IT' })
    expect(out).toMatchObject({ outcome: 'applied', version: 8, listings: [{ listingId: 'l-eb', productId: 'row', version: 8 }] })
    expect(h.updateMany).toHaveBeenCalledTimes(1)
    expect(h.updateMany).toHaveBeenCalledWith({ where: { id: 'l-eb', version: 7 }, data: { sourceLocationCodes: ['MI-3PL'], version: { increment: 1 } } })
  })

  it.each([
    ['no inventory.adjust', () => write(['MI-3PL'], { ctx: { ...ctx, can: () => false } }), MATRIX_COPY.sourcePermission],
    ['the parent (the read holds it)', () => write(['MI-3PL'], { read: read(source({ writable: false, blockedReason: MATRIX_COPY.sourceParent }), 'parent') }), MATRIX_COPY.sourceParent],
    ['FBA (the read holds it)', () => write(['MI-3PL'], { read: read(source({ writable: false, blockedReason: MATRIX_COPY.sourceFba })) }), MATRIX_COPY.sourceFba],
    ['a pooled SKU (the read holds it)', () => write(['MI-3PL'], { read: read(source({ writable: false, blockedReason: sharedStockReason('Lender A') })) }), sharedStockReason('Lender A')],
    ['no source cell on the coordinate', () => write(['MI-3PL'], { read: read(null) }), MATRIX_COPY.sourceNone],
    ['an unknown code', () => write(['NOPE']), MATRIX_COPY.sourceUnknown('NOPE')],
    ['a switched-off warehouse', () => write(['OLD']), MATRIX_COPY.sourceInactive('OLD')],
    ['a code twice', () => write(['IT-MAIN', 'it-main']), MATRIX_COPY.sourceTwice('it-main')],
    ['more than 20', () => write(Array.from({ length: 21 }, (_, i) => `L${i}`)), MATRIX_COPY.sourceTooMany],
    ['not a list', () => write('IT-MAIN'), 'Sells from is a list of location codes'],
  ])('refuses %s by name and writes nothing', async (_name, run, reason) => {
    expect(await run()).toMatchObject({ cell: 'source', outcome: 'refused', reason })
    expect(h.updateMany).not.toHaveBeenCalled()
    expect(announceListingValues).not.toHaveBeenCalled()
  })

  it('asks FBA and shared stock AGAIN at write time: an Amazon-managed EU row or an active pool link refuses the whole write', async () => {
    vi.mocked(amazonManagedListingIds).mockResolvedValueOnce(new Set(['l-de']))
    expect(await write(['MI-3PL'])).toMatchObject({ outcome: 'refused', reason: MATRIX_COPY.sourceFba })
    h.link.mockResolvedValueOnce({ grant: { ownerWorkspace: { name: 'Lender A' } } })
    expect(await write(['MI-3PL'])).toMatchObject({ outcome: 'refused', reason: sharedStockReason('Lender A') })
    expect(h.updateMany).not.toHaveBeenCalled()
  })

  it('a stale version, or an EU row that moved, is a conflict — nothing announced, nothing re-pushed', async () => {
    expect(await write(['MI-3PL'], { version: 2 })).toMatchObject({ outcome: 'conflict', version: 3 })
    h.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })
    expect(await write(['MI-3PL'])).toMatchObject({ outcome: 'conflict', reason: MATRIX_COPY.changedElsewhere })
    expect(announceListingValues).not.toHaveBeenCalled(); expect(recascadeAfterSyncControlChange).not.toHaveBeenCalled()
  })
})

/**
 * MX.1 — the door's PURE rules: how a carried change is re-verified (`paramsForChange`) and how a captured cell is
 * restored by VALUE (`restoreWrites`). The stateful paths run in `routes/studio-matrix.routes.vitest.test.ts` (mocked
 * primitives) and in the live fixture rehearsal recorded in `docs/pes-claims.md`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MatrixCells, VerbChange } from '@nexus/shared/matrix-contract'

// The door's version bump runs in a transaction: a stand-in that lets every compare-and-set through (one row each).
// No product here sells from another business's stock (shared stock by SKU: `sharedStockLender` asks the link).
const h = vi.hoisted(() => ({ findMany: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) }))
vi.mock('../../db.js', () => ({ default: { $transaction: async (work: (tx: unknown) => unknown) => work({ channelListing: { updateMany: h.updateMany } }), channelListing: { findMany: h.findMany }, stockPoolLink: { findFirst: async () => null } } }))
vi.mock('../../lib/queue.js', () => ({ addJobSafely: async () => null, outboundSyncQueue: null }))
vi.mock('../follow-master.service.js', () => ({ setFollowMasterQuantity: vi.fn(), setStockBuffer: vi.fn(), amazonManagedListingIds: vi.fn(async () => new Set<string>()) }))
vi.mock('../stock-movement.service.js', () => ({ recascadeAfterSyncControlChange: vi.fn() }))
vi.mock('../sync-coalesce.js', () => ({ coalescePendingQuantityRows: vi.fn() }))
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn() }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refreshMany: vi.fn() } }))
vi.mock('./fulfillment-method.service.js', () => ({ setFulfillmentMethod: vi.fn() }))
vi.mock('./channel-price-write.service.js', () => ({ writeChannelPrices: vi.fn() }))
vi.mock('./matrix.service.js', () => ({ getMatrixRead: vi.fn() }))
vi.mock('../listing-values-events.js', () => ({ announceListingValues: vi.fn() }))

import { applyCell, paramsForChange, restoreWrites, writeMatrixCells } from './matrix-write.service.js'
import { writeChannelPrices, type PriceWriteTarget } from './channel-price-write.service.js'
import { setFollowMasterQuantity, setStockBuffer } from '../follow-master.service.js'
import { setFulfillmentMethod } from './fulfillment-method.service.js'
import { getMatrixRead } from './matrix.service.js'
import { productReadCacheService } from '../product-read-cache.service.js'
import { MATRIX_COPY } from '@nexus/shared/matrix-contract'

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
    expect(restoreWrites('r', 'AMAZON:EU', before, live)).toEqual([
      { kind: 'state', verb: 'resume-sync' },
      { kind: 'cell', cell: 'fulfilment', value: 'FBM' },
      { kind: 'cell', cell: 'syncBuffer', value: 0 },
      { kind: 'cell', cell: 'price', value: null },
      { kind: 'cell', cell: 'salePrice', value: { value: null, start: null, end: null } },
    ])
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
    vi.mocked(setFulfillmentMethod).mockReset().mockResolvedValue({ results: [
      { listingId: 'l-it', productId: 'row', channel: 'AMAZON', marketplace: 'IT', outcome: 'applied', version: 4, productFlag: null },
      { listingId: 'l-de', productId: 'row', channel: 'AMAZON', marketplace: 'DE', outcome: 'noop', version: 5, productFlag: null },
    ], applied: 1, refused: 0, noop: 1, conflict: 0, productConversions: [] })
    const f = await applyCell(euRead(), { rowId: 'row', coordinateKey: 'AMAZON:EU', cell: 'fulfilment', value: 'FBA', expectedVersion: 3 } as never, ctx)
    expect(f).toMatchObject({ outcome: 'applied', version: 4, listings: [{ listingId: 'l-it', productId: 'row', version: 4 }] })

    vi.mocked(writeChannelPrices).mockReset().mockResolvedValue({ results: [{ listingId: 'l-it', productId: 'row', channel: 'AMAZON', marketplace: 'IT', outcome: 'applied', version: 4, guarded: true, queueId: null }], applied: 1, refused: 0, noop: 0, conflict: 0 })
    const p = await applyCell(euRead(), { rowId: 'row', coordinateKey: 'AMAZON:IT', cell: 'price', value: 90, expectedVersion: 3 } as never, ctx)
    expect(p).toMatchObject({ outcome: 'applied', version: 4, listings: [{ listingId: 'l-it', productId: 'row', version: 4 }] })
  })

  it('a refusal after the rows were staged still reports them (their versions moved)', async () => {
    vi.mocked(setStockBuffer).mockResolvedValue({ ...done, results: [{ listingId: 'l-de', sku: 'S', channel: 'AMAZON', marketplace: 'DE', action: 'SKIPPED_FBA', buffer: 0, quantity: null }] })
    const outcome = await applyCell(euRead(), { rowId: 'row', coordinateKey: 'AMAZON:EU', cell: 'syncBuffer', value: 2, expectedVersion: 3 } as never, ctx)
    expect(outcome).toMatchObject({ outcome: 'refused', reason: MATRIX_COPY.amazonManaged, version: 4, listings: EU_AFTER })
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

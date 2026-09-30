/**
 * MX.1 — the door's PURE rules: how a carried change is re-verified (`paramsForChange`) and how a captured cell is
 * restored by VALUE (`restoreWrites`). The stateful paths run in `routes/studio-matrix.routes.vitest.test.ts` (mocked
 * primitives) and in the live fixture rehearsal recorded in `docs/pes-claims.md`.
 */
import { describe, expect, it, vi } from 'vitest'
import type { MatrixCells, VerbChange } from '@nexus/shared/matrix-contract'

vi.mock('../../db.js', () => ({ default: {} }))
vi.mock('../../lib/queue.js', () => ({ addJobSafely: async () => null, outboundSyncQueue: null }))
vi.mock('../follow-master.service.js', () => ({ setFollowMasterQuantity: vi.fn(), setStockBuffer: vi.fn(), amazonManagedListingIds: vi.fn(async () => new Set<string>()) }))
vi.mock('../stock-movement.service.js', () => ({ recascadeAfterSyncControlChange: vi.fn() }))
vi.mock('../sync-coalesce.js', () => ({ coalescePendingQuantityRows: vi.fn() }))
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn() }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refreshMany: vi.fn() } }))
vi.mock('./fulfillment-method.service.js', () => ({ setFulfillmentMethod: vi.fn() }))
vi.mock('./channel-price-write.service.js', () => ({ writeChannelPrices: vi.fn() }))
vi.mock('./matrix.service.js', () => ({ getMatrixRead: vi.fn() }))

import { applyCell, paramsForChange, restoreWrites } from './matrix-write.service.js'
import { writeChannelPrices } from './channel-price-write.service.js'

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
    const target = door.mock.calls[0][0].targets[0] as Record<string, unknown>
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

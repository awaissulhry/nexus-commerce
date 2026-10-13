import { describe, expect, it } from 'vitest'

import type { MatrixCells } from './matrix-contract.js'
import { matrixCellStamp, matrixStampHolds } from './matrix-stamp.js'

const cells = (over: Partial<MatrixCells> = {}): MatrixCells => ({
  listingId: 'l', version: 4, listing: null,
  fulfilment: { method: 'FBM', source: 'set', guard: 'FBM', reported: null },
  sync: { kind: 'FOLLOW', via: null, mode: 'FOLLOW', intended: 10, held: 10, buffer: 1, poolAvailable: 11, routedLocations: ['IT-MAIN'], fbaAtAmazon: null, oversold: false },
  queue: null,
  price: { value: 100, currency: 'EUR', source: 'master', formula: null, clamped: null },
  sale: { value: null, start: null, end: null },
  writable: {}, writeBlockedReason: {}, ...over,
})

describe('matrixCellStamp — the field(s) each cell writes, as it shows them', () => {
  it('a Follow Qty cell stamps its mode only (Owner 4A); a Pinned one its number too', () => {
    expect(matrixCellStamp('syncQty', cells())).toEqual({ mode: 'FOLLOW' })
    const pinned = cells({ sync: { ...cells().sync!, kind: 'PINNED', mode: 'PINNED', intended: 7, held: 7 } })
    expect(matrixCellStamp('syncQty', pinned)).toEqual({ mode: 'PINNED', qty: 7 })
  })
  it('a price stamps the listing\'s own price: the override, or null while it follows the master; a clamped price has none', () => {
    expect(matrixCellStamp('price', cells())).toEqual({ own: null })
    expect(matrixCellStamp('price', cells({ price: { value: 90, currency: 'EUR', source: 'override', formula: null, clamped: null } }))).toEqual({ own: 90 })
    expect(matrixCellStamp('price', cells({ price: { value: 90, currency: 'EUR', source: 'override', formula: null, clamped: 'floor' } }))).toBeUndefined()
    expect(matrixCellStamp('price', cells({ price: { value: 95, currency: 'EUR', source: 'formula', formula: '= $basePrice', clamped: null } }))).toBeUndefined()
  })
  it('the business cells stamp the setting, never the numbers worked out from the normal price', () => {
    const business = { rule: 'PERCENT_OFF' as const, percent: 5, exact: null, tiers: { type: 'percent' as const, levels: [{ minQty: 2, value: 3, unitPrice: 92.15 }] }, price: 95, normalPrice: 100, minPrice: null, maxPrice: null, currency: 'EUR', warnings: [], held: null, send: null, live: null, reported: null }
    const stamp = { business: { rule: 'PERCENT_OFF', percent: 5, exact: null, tiers: { type: 'percent', levels: [{ minQty: 2, value: 3 }] } } }
    expect(matrixCellStamp('businessPrice', cells({ business }))).toEqual(stamp)
    expect(matrixCellStamp('businessTiers', cells({ business: { ...business, price: 99, normalPrice: 104, tiers: { type: 'percent', levels: [{ minQty: 2, value: 3, unitPrice: 96 }] } } }))).toEqual(stamp)
    expect(matrixCellStamp('businessPrice', cells({ business: { ...business, rule: null, percent: null, tiers: null } }))).toEqual({ business: null })
  })
  it('no cells, or a kind the coordinate does not serve: no stamp', () => {
    expect(matrixCellStamp('syncQty', null)).toBeUndefined()
    expect(matrixCellStamp('syncBuffer', cells({ sync: null }))).toBeUndefined()
    expect(matrixCellStamp('source', cells())).toBeUndefined()
  })
})

describe('matrixStampHolds — the door\'s question: is every stamped field what the person saw?', () => {
  it('a sale moved the follow number and the version: the Follow Qty stamp still holds', () => {
    const seen = matrixCellStamp('syncQty', cells())
    expect(matrixStampHolds('syncQty', seen, cells({ version: 9, sync: { ...cells().sync!, intended: 8, poolAvailable: 9 } }))).toBe(true)
  })
  it('the stamped field moved: it does not hold', () => {
    expect(matrixStampHolds('price', { own: null }, cells({ price: { value: 90, currency: 'EUR', source: 'override', formula: null, clamped: null } }))).toBe(false)
    expect(matrixStampHolds('syncBuffer', { buffer: 1 }, cells({ sync: { ...cells().sync!, buffer: 3 } }))).toBe(false)
    expect(matrixStampHolds('syncQty', { mode: 'FOLLOW' }, cells({ sync: { ...cells().sync!, kind: 'PINNED', mode: 'PINNED', intended: 7 } }))).toBe(false)
  })
  it('the master price moved under a cell that follows it: the own-price stamp still holds', () => {
    expect(matrixStampHolds('price', { own: null }, cells({ price: { value: 110, currency: 'EUR', source: 'master', formula: null, clamped: null } }))).toBe(true)
  })
  it('key order and JSON\'s dropped `undefined` do not matter; no stamp never holds', () => {
    const seen = JSON.parse(JSON.stringify({ sale: { end: null, start: null, value: null } }))
    expect(matrixStampHolds('salePrice', seen, cells())).toBe(true)
    expect(matrixStampHolds('salePrice', undefined, cells())).toBe(false)
    expect(matrixStampHolds('syncQty', { mode: 'FOLLOW' }, cells({ sync: null }))).toBe(false)
  })
})

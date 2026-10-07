/**
 * The bulk Edit's fields (Owner 2026-10-07): every field listed, a field the selection cannot take held with its reason,
 * only the markets that serve a field offered, the focused market ticked first, and the lines the page works out itself
 * (Base price, Sale price, Status) honest about what changes and what is skipped.
 */
import { describe, expect, it } from 'vitest'
import type { PublishActionCell } from '@nexus/shared/publish-actions'

import type { MatrixCells, MatrixCoordinate } from '../contract'
import {
  BULK_PARENT_ONLY, BULK_PRICE_PERMISSION, basePriceLines, bulkChoices, bulkDefaultMarkets, bulkFields, bulkMarkets, largeChangeWord,
  saleLines, statusLines, verbLines, verbNotices, verbParams, verbTargets, BULK_HOLD_NOTICE, BULK_STATUS_NEW_ROW, type BulkContext,
} from './fields'
import { verbSentence } from './bulkSource'

const coord = (key: string, label: string, cells: MatrixCoordinate['cells'], extra: Partial<MatrixCoordinate> = {}): MatrixCoordinate => ({
  key, kind: 'market', channel: key.split(':')[0]!, market: key.split(':')[1]!, label, region: null, alias: null, accountId: null, currency: 'EUR',
  connected: true, listed: 1, draft: 0, cells, absent: [], sharedInventoryWith: null, inventoryOn: null, vocabulary: { fulfilment: null }, ...extra,
})
const EU = coord('AMAZON:EU', 'Amazon EU · IT DE FR ES', ['fulfilment', 'syncMode', 'syncQty', 'syncBuffer', 'syncState'], { kind: 'region-inventory', vocabulary: { fulfilment: ['FBA', 'FBM'] } })
const IT = coord('AMAZON:IT', 'Amazon · IT', ['listing', 'price', 'salePrice'])
const EBAY = coord('EBAY:IT', 'eBay · IT', ['listing', 'fulfilment', 'syncMode', 'syncQty', 'syncBuffer', 'syncState', 'price'], { vocabulary: { fulfilment: ['FBM', 'MCF'] } })

const cells = (over: Partial<MatrixCells> = {}): MatrixCells => ({
  listingId: 'L', version: 1, listing: null, fulfilment: null, sync: null, queue: null, price: null, sale: null, writable: {}, writeBlockedReason: {}, ...over,
})
const priced = (value: number, sale: MatrixCells['sale'] = null) => cells({ price: { value, currency: 'EUR', source: 'override', formula: null, clamped: null }, sale, writable: { salePrice: true, price: true } })
const synced = () => cells({ fulfilment: { method: 'FBA', source: 'set', guard: null, reported: null }, sync: { kind: 'FBA_EXCLUDED', via: null, mode: 'FOLLOW', intended: null, held: null, buffer: 0, poolAvailable: 6, routedLocations: [], fbaAtAmazon: 0, oversold: false } })

const statusCell = (over: Partial<PublishActionCell> = {}): PublishActionCell => ({
  listingId: 'L1', productId: 'p', sku: 'S', channel: 'AMAZON', marketplace: 'IT', accountId: 'a', aliasKey: '', state: 'active', stateReason: null,
  send: { mode: 'partial', setAt: null, setById: null, setByName: null, noLongerApplies: null },
  status: { target: null, setAt: null, setById: null, setByName: null, noLongerApplies: null },
  sendOptions: [],
  statusOptions: [
    { target: 'active', offered: true, action: null, reason: null, warning: null, checkedAtSend: null },
    { target: 'inactive', offered: true, action: null, reason: null, warning: null, checkedAtSend: null },
    { target: 'ended', offered: false, action: null, reason: 'Amazon has no Ended', warning: null, checkedAtSend: null },
  ],
  ...over,
} as PublishActionCell)

function ctx(over: Partial<BulkContext> = {}): BulkContext {
  const table: Record<string, MatrixCells> = {
    'a|AMAZON:EU': synced(), 'b|AMAZON:EU': synced(),
    'a|AMAZON:IT': priced(105), 'b|AMAZON:IT': priced(99.75, { value: 80, start: '2026-10-01', end: '2026-10-31' }),
  }
  return {
    rows: [{ id: 'a', sku: 'A', isParent: false, basePrice: 105 }, { id: 'b', sku: 'B', isParent: false, basePrice: 99.75 }],
    coordinates: [EU, IT, EBAY],
    cellsOf: (rowId, key) => table[`${rowId}|${key}`] ?? null,
    statusCellOf: (rowId, c) => (c.key === 'AMAZON:IT' ? statusCell({ listingId: `L-${rowId}`, sku: rowId.toUpperCase() }) : null),
    canPrice: true, masterHeld: null, statusHeld: null, canDelete: false, focusedKey: null,
    ...over,
  }
}

describe('bulkFields', () => {
  it('lists the eight fields in their groups, every one offered for these rows except the markets they are not on', () => {
    const fields = bulkFields(ctx())
    expect(fields.map((f) => [f.group, f.label])).toEqual([
      ['Prices', 'Base price'], ['Prices', 'Price'], ['Prices', 'Sale price'], ['Listing', 'Status'], ['Listing', 'Fulfilment'],
      ['Stock', 'Quantity'], ['Stock', 'Buffer'], ['Stock', 'Stock sync'],
    ])
    expect(fields.every((f) => f.held === null)).toBe(true)
  })
  it('holds the three price fields, with the reason, for a role that cannot change prices', () => {
    const held = bulkFields(ctx({ canPrice: false })).filter((f) => f.held)
    expect(held.map((f) => f.id)).toEqual(['basePrice', 'price', 'salePrice'])
    expect(held[0]!.held).toBe(BULK_PRICE_PERMISSION)
  })
  it('holds the per-market fields for a parent-only selection, and keeps Base price', () => {
    const fields = bulkFields(ctx({ rows: [{ id: 'p', sku: 'P', isParent: true, basePrice: 105 }] }))
    expect(fields.find((f) => f.id === 'basePrice')!.held).toBeNull()
    expect(fields.find((f) => f.id === 'fulfilment')!.held).toBe(BULK_PARENT_ONLY)
  })
  it('holds Status with the read\'s own reason', () => {
    expect(bulkFields(ctx({ statusHeld: 'Your role cannot publish' })).find((f) => f.id === 'listingStatus')!.held).toBe('Your role cannot publish')
  })
})

describe('markets', () => {
  it('offers only the markets that serve the field; one the rows are not on is held, not hidden', () => {
    expect(bulkMarkets(ctx(), 'fulfilment').map((m) => [m.key, m.held])).toEqual([['AMAZON:EU', null], ['EBAY:IT', 'None of these rows is on this market']])
    expect(bulkMarkets(ctx(), 'price').map((m) => m.key)).toEqual(['AMAZON:IT', 'EBAY:IT'])
    expect(bulkMarkets(ctx(), 'basePrice')).toEqual([])
  })
  it('ticks the focused market when it serves the field, else every market the rows are on', () => {
    expect(bulkDefaultMarkets(ctx({ focusedKey: 'AMAZON:EU' }), 'fulfilment')).toEqual(['AMAZON:EU'])
    expect(bulkDefaultMarkets(ctx({ focusedKey: 'AMAZON:EU' }), 'price')).toEqual(['AMAZON:IT'])
  })
  it('ticks only the Amazon markets for Fulfilment when nothing is focused: FBA / FBM is Amazon\'s choice', () => {
    const both: BulkContext = ctx({ cellsOf: (_rowId, key) => (key === 'EBAY:IT' || key === 'AMAZON:EU' ? synced() : null) })
    expect(bulkDefaultMarkets(both, 'fulfilment')).toEqual(['AMAZON:EU'])
    expect(bulkDefaultMarkets(both, 'quantity')).toEqual(['AMAZON:EU', 'EBAY:IT'])
  })
  it('offers the methods the chosen markets have, and the Status targets their cells offer', () => {
    expect(bulkChoices(ctx(), 'fulfilment', 'method', ['AMAZON:EU']).map((c) => c.value)).toEqual(['FBA', 'FBM'])
    expect(bulkChoices(ctx(), 'fulfilment', 'method', ['AMAZON:EU', 'EBAY:IT']).map((c) => c.value)).toEqual(['FBA', 'FBM', 'MCF'])
    expect(bulkChoices(ctx(), 'listingStatus', 'status', ['AMAZON:IT']).map((c) => c.label)).toEqual(['Active', 'Inactive'])
    expect(bulkChoices(ctx(), 'price', 'copy', ['AMAZON:IT']).map((c) => c.value)).toEqual(['EBAY:IT'])
  })
})

describe('verbs', () => {
  it('maps each field and mode to its Matrix verb', () => {
    expect(verbParams('fulfilment', 'method', { choice: 'FBM' })).toEqual({ verb: 'set-fulfilment', method: 'FBM' })
    expect(verbParams('quantity', 'follow', {})).toEqual({ verb: 'set-follow' })
    expect(verbParams('quantity', 'pin', { amount: 4 })).toEqual({ verb: 'pin-quantity', value: 4 })
    expect(verbParams('price', 'adjust', { percent: -5 })).toEqual({ verb: 'adjust-prices', percent: -5 })
    expect(verbParams('stockSync', 'hold', {})).toEqual({ verb: 'pause-sync' })
    expect(verbParams('price', 'set', {})).toBeNull()
  })
  it('targets every ticked variant on every chosen market where it has the field', () => {
    expect(verbTargets(ctx(), 'fulfilment', ['AMAZON:EU', 'EBAY:IT'])).toEqual([{ rowId: 'a', coordinateKey: 'AMAZON:EU' }, { rowId: 'b', coordinateKey: 'AMAZON:EU' }])
  })
  it('turns the server preview into lines: changes, then refusals with their reason; a hold says what else it holds', () => {
    const lines = verbLines({
      changes: [{ rowId: 'a', sku: 'A', coordinateKey: 'AMAZON:EU', cell: 'fulfilment', from: 'FBA', to: 'FBM', fromLabel: 'FBA', toLabel: 'FBM', note: 'Follow → 6' }],
      refusals: [{ rowId: 'b', sku: 'B', coordinateKey: 'AMAZON:EU', kind: 'guard', reason: 'Refused — 3 units of FBA stock on hand keep the guard closed' }],
    }, (k) => (k === 'AMAZON:EU' ? 'Amazon EU' : k))
    expect(lines.map((l) => [l.sku, l.where, l.now, l.next, l.note, l.skipped])).toEqual([
      ['A', 'Amazon EU', 'FBA', 'FBM', 'Follow → 6', null],
      ['B', 'Amazon EU', '', null, null, 'Refused — 3 units of FBA stock on hand keep the guard closed'],
    ])
    expect(verbNotices({ verb: 'set-fulfilment', notices: ['Sends Amazon …'] })).toEqual(['Sends Amazon …'])
    expect(verbNotices({ verb: 'pause-sync', notices: [] })).toEqual([BULK_HOLD_NOTICE])
  })
  it('says the result in words, counting what the server applied', () => {
    expect(verbSentence({ verb: 'set-fulfilment', changes: [{ toLabel: 'FBM', coordinateKey: 'AMAZON:EU' } as never] }, 10, 2)).toBe('10 listings sent to Amazon as FBM · 2 skipped. Amazon\'s report confirms it within about 15 minutes — the Fulfilment cell shows it.')
    expect(verbSentence({ verb: 'set-fulfilment', changes: [{ toLabel: 'MCF', coordinateKey: 'EBAY:IT' } as never] }, 1, 0)).toBe('1 listing set to MCF in Nexus.')
    expect(verbSentence({ verb: 'set-price', changes: [] }, 1, 0)).toBe('1 price changed. Nexus sends it in about 30 seconds.')
  })
})

describe('lines the page works out', () => {
  it('Base price: set to a value; a row already at it is skipped, said plainly', () => {
    const lines = basePriceLines(ctx(), 'set', { amount: 105 }, 'EUR')
    expect(lines.map((l) => [l.sku, l.now, l.next, l.skipped])).toEqual([['A', '€105.00', null, 'Already €105.00'], ['B', '€99.75', '€105.00', null]])
  })
  it('Base price: change by a percentage, rounded to the cent', () => {
    expect(basePriceLines(ctx(), 'adjust', { percent: -10 }, 'EUR').map((l) => l.next)).toEqual(['€94.50', '€89.78'])
  })
  it('Sale price: set on the chosen market; a sale at or above the price is skipped with the price named', () => {
    const lines = saleLines(ctx(), 'sale-set', { sale: { value: 99.75, start: '2026-11-01', end: '2026-11-30' } }, ['AMAZON:IT'])
    expect(lines.map((l) => [l.sku, l.now, l.next, l.skipped])).toEqual([
      ['A', 'No sale', '€99.75 · 1 Nov–30 Nov', null],
      ['B', '€80.00 · 1 Oct–31 Oct', null, 'The sale price must be below the price (€99.75)'],
    ])
  })
  it('Sale price: remove; a row with no sale is skipped', () => {
    expect(saleLines(ctx(), 'sale-remove', {}, ['AMAZON:IT']).map((l) => [l.sku, l.next, l.skipped])).toEqual([['A', null, 'No sale to remove'], ['B', 'No sale', null]])
  })
  it('Status: waits for Publish; a target the cell does not offer is skipped with the cell\'s own reason', () => {
    expect(statusLines(ctx(), 'inactive', ['AMAZON:IT']).map((l) => [l.sku, l.now, l.next, l.note])).toEqual([['A', 'Active', 'Inactive', 'Waits for Publish'], ['B', 'Active', 'Inactive', 'Waits for Publish']])
    expect(statusLines(ctx(), 'ended', ['AMAZON:IT']).map((l) => l.skipped)).toEqual(['Amazon has no Ended', 'Amazon has no Ended'])
    expect(statusLines(ctx(), 'active', ['AMAZON:IT']).map((l) => l.skipped)).toEqual(['Already Active', 'Already Active'])
  })
  it('Status never creates a listing: a row not on the market yet is skipped, and a market with only such rows is held', () => {
    const fresh = ctx({ statusCellOf: (rowId, c) => (c.key === 'AMAZON:IT' ? statusCell({ listingId: `new:${rowId}`, create: { target: 'not_listed', source: 'default', sentence: null } as never }) : null) })
    expect(statusLines(fresh, 'inactive', ['AMAZON:IT']).map((l) => l.skipped)).toEqual([BULK_STATUS_NEW_ROW, BULK_STATUS_NEW_ROW])
    expect(bulkMarkets(fresh, 'listingStatus').map((m) => [m.key, m.held])).toEqual([['AMAZON:IT', 'None of these rows is on this market'], ['EBAY:IT', 'None of these rows is on this market']])
    expect(bulkFields(fresh).find((f) => f.id === 'listingStatus')!.held).toMatch(/None of these rows has a Status/)
  })
  it('asks for a typed word on a large change, as the verbs do', () => {
    expect(largeChangeWord(100)).toBe('APPLY')
    expect(largeChangeWord(3, -30)).toBe('APPLY')
    expect(largeChangeWord(3, -5)).toBeNull()
  })
})

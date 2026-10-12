/**
 * The bulk Edit's runner (v2, 2026-10-12): what it asks the server for, what it writes, and what its sentences count —
 * the server's answer, never the request. "Use base price" writes `price: null` and its Undo puts each price back; a
 * verb's Undo counts what the revert put back; Copy from never targets its own source; Raise / Lower by an amount send
 * the markets' currency; a refused line's Now is never empty; and hand-offs open their own dialog.
 */
import { describe, expect, it, vi } from 'vitest'

import type { MatrixCells, MatrixCoordinate, MatrixVerbRequest, MatrixWriteCell, MatrixWriteOutcome, VerbOperation, VerbPreview } from '../contract'
import { createBulkSource, revertSentence, type BulkDoors } from './bulkSource'
import { BULK_ALREADY_FOLLOWS, BULK_FOLLOWS_BASE, BULK_NO_HANDOFF, BULK_NOT_ON_SCREEN, BULK_SENT, type BulkContext } from './fields'
import type { BulkRequest } from './types'

const coord = (key: string, label: string, cells: MatrixCoordinate['cells'], extra: Partial<MatrixCoordinate> = {}): MatrixCoordinate => ({
  key, kind: 'market', channel: key.split(':')[0]!, market: key.split(':')[1]!, label, region: null, alias: null, accountId: null, currency: 'EUR',
  connected: true, listed: 1, draft: 0, cells, absent: [], sharedInventoryWith: null, inventoryOn: null, vocabulary: { fulfilment: null }, ...extra,
})
const IT = coord('AMAZON:IT', 'Amazon · IT', ['listing', 'price', 'salePrice'])
const EBAY = coord('EBAY:IT', 'eBay · IT', ['listing', 'price', 'syncMode', 'syncQty', 'syncBuffer', 'syncState'])
const price = (value: number, source: 'override' | 'master' = 'override', version = 1, listingId = 'L'): MatrixCells => ({
  listingId, version, listing: null, fulfilment: null, sync: null, queue: null, sale: null,
  price: { value, currency: 'EUR', source, formula: null, clamped: null }, writable: { price: true, salePrice: true }, writeBlockedReason: {},
})

function doorsFor(table: Record<string, MatrixCells>, over: Partial<BulkDoors> = {}, ctxOver: Partial<BulkContext> = {}) {
  const writes: MatrixWriteCell[][] = []
  const context = (): BulkContext => ({
    rows: [{ id: 'a', sku: 'A', name: 'Nero · S', isParent: false, basePrice: 105 }, { id: 'b', sku: 'B', name: 'Nero · M', isParent: false, basePrice: 100 }],
    coordinates: [IT, EBAY],
    cellsOf: (rowId, key) => table[`${rowId}|${key}`] ?? null,
    statusCellOf: () => null,
    canEdit: true, canPrice: true, statusHeld: null, canDelete: false, focusedKey: null, locations: [],
    handoffHeld: { casePack: null, stockPool: null },
    ...ctxOver,
  })
  const doors: BulkDoors = {
    context,
    previewVerb: vi.fn(async (req: MatrixVerbRequest): Promise<VerbPreview> => ({ verb: req.params.verb, changes: [], refusals: [], notices: [], confirm: 'none', confirmWord: null, simulated: false })),
    applyVerb: vi.fn(),
    revertVerb: vi.fn(),
    writeCells: vi.fn(async (cells: readonly MatrixWriteCell[]) => {
      writes.push([...cells])
      return cells.map((c): MatrixWriteOutcome => ({ rowId: c.rowId, coordinateKey: c.coordinateKey, cell: c.cell, outcome: 'applied', version: c.expectedVersion + 1 }))
    }),
    masterWrite: vi.fn(async (ws: ReadonlyArray<{ rowId: string; value: number | null }>) => ws.map((w) => ({ rowId: w.rowId, ok: true }))),
    statusWrite: vi.fn(),
    openElsewhere: vi.fn(),
    ...over,
  }
  return { doors, writes, source: createBulkSource(doors, { title: 'Edit 2 variants', subtitle: 'FAM · 2 of 2 variants' }) }
}
const req = (r: Partial<BulkRequest> & Pick<BulkRequest, 'field' | 'mode'>): BulkRequest => ({ input: {}, coordinateKeys: ['AMAZON:IT'], ...r })

describe('Use base price', () => {
  it('writes price: null at the cell\'s version, says what the server applied, and Undo puts each own price back', async () => {
    const table: Record<string, MatrixCells> = { 'a|AMAZON:IT': price(105, 'master'), 'b|AMAZON:IT': price(99, 'override', 4) }
    const { source, writes } = doorsFor(table)
    const pv = await source.preview(req({ field: 'price', mode: 'follow-base' }))
    expect(pv.lines.map((l) => [l.sku, l.next, l.skipped])).toEqual([['A', null, BULK_ALREADY_FOLLOWS], ['B', BULK_FOLLOWS_BASE, null]])
    expect([pv.changes, pv.skipped, pv.undoable]).toEqual([1, 1, true])

    const result = await source.apply(pv)
    expect(writes[0]).toEqual([{ rowId: 'b', coordinateKey: 'AMAZON:IT', cell: 'price', value: null, expectedVersion: 4, expectedListingId: 'L' }])
    expect(result.sentence).toBe(`1 market now follows the base price · 1 skipped. ${BULK_SENT.it}`)

    // The server handed it back: the cell now follows the base price, at a new version. Undo sets the old price again.
    table['b|AMAZON:IT'] = price(100, 'master', 5)
    expect(await result.undo!()).toBe('Put back 1 price.')
    expect(writes[1]).toEqual([{ rowId: 'b', coordinateKey: 'AMAZON:IT', cell: 'price', value: 99, expectedVersion: 5 }])
  })
})

describe('verbs', () => {
  it('Copy from never targets the market it copies from; the source is a choice even when ticked', async () => {
    const table = { 'a|AMAZON:IT': price(105), 'a|EBAY:IT': price(110) }
    const { source, doors } = doorsFor(table)
    expect(source.choicesFor('price', 'copy', ['AMAZON:IT', 'EBAY:IT']).map((c) => c.value)).toEqual(['AMAZON:IT', 'EBAY:IT'])
    await source.preview(req({ field: 'price', mode: 'copy', input: { choice: 'EBAY:IT' }, coordinateKeys: ['AMAZON:IT', 'EBAY:IT'] }))
    expect((doors.previewVerb as ReturnType<typeof vi.fn>).mock.calls[0]![0].targets).toEqual([{ rowId: 'a', coordinateKey: 'AMAZON:IT' }])
  })
  it('Raise by an amount sends it in the markets\' currency; Lower by a percentage sends it negative', async () => {
    const { source, doors } = doorsFor({ 'a|AMAZON:IT': price(105) })
    await source.preview(req({ field: 'price', mode: 'raise', input: { delta: 2 } }))
    await source.preview(req({ field: 'price', mode: 'lower', input: { percent: 5 } }))
    const calls = (doors.previewVerb as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].params)
    expect(calls).toEqual([{ verb: 'adjust-prices', amount: 2, currency: 'EUR' }, { verb: 'adjust-prices', percent: -5 }])
  })
  it('a refused line\'s Now is the row as it is; ids carry the field and mode', async () => {
    const table = { 'a|AMAZON:IT': price(105), 'b|AMAZON:IT': price(99) }
    const { source } = doorsFor(table, {
      previewVerb: async () => ({
        verb: 'set-price', confirm: 'none', confirmWord: null, simulated: false, notices: [],
        changes: [{ rowId: 'b', sku: 'B', coordinateKey: 'AMAZON:IT', cell: 'price', from: 99, to: 90, fromLabel: '€99.00', toLabel: '€90.00' }],
        refusals: [{ rowId: 'a', sku: 'A', coordinateKey: 'AMAZON:IT', kind: 'formula', reason: 'A formula sets this price' }],
      }),
    })
    const pv = await source.preview(req({ field: 'price', mode: 'set', input: { amount: 90 } }))
    expect(pv.lines.map((l) => [l.sku, l.name, l.now, l.next, l.skipped])).toEqual([['A', 'Nero · S', '€105.00', null, 'A formula sets this price'], ['B', 'Nero · M', '€99.00', '€90.00', null]])
    expect(pv.lines.every((l) => l.id.startsWith('price|set|'))).toBe(true)
    expect(pv.notices).toEqual([{ text: BULK_SENT.prices, tone: 'info' }])
  })
  it('Undo counts what the revert PUT BACK, and says why one could not be', async () => {
    const op: VerbOperation = { id: 'op1', verb: 'set-buffer', appliedAt: '', applied: 2, refused: 0, before: [] }
    const { source } = doorsFor({}, {
      previewVerb: async () => ({
        verb: 'set-buffer', confirm: 'none', confirmWord: null, simulated: false, notices: [], refusals: [],
        changes: [
          { rowId: 'a', sku: 'A', coordinateKey: 'EBAY:IT', cell: 'syncBuffer', from: 0, to: 2, fromLabel: '0', toLabel: '2' },
          { rowId: 'b', sku: 'B', coordinateKey: 'EBAY:IT', cell: 'syncBuffer', from: 0, to: 2, fromLabel: '0', toLabel: '2' },
        ],
      }),
      applyVerb: async () => op,
      revertVerb: async () => ({
        ...op, applied: 1, refused: 1, results: [
          { rowId: 'a', coordinateKey: 'EBAY:IT', cell: 'syncBuffer', outcome: 'applied', version: 3 },
          { rowId: 'b', coordinateKey: 'EBAY:IT', cell: 'syncBuffer', outcome: 'refused', reason: 'No listing on this coordinate any more', version: 0 },
        ],
      }),
    }, { cellsOf: () => ({ ...price(1), sync: { kind: 'FOLLOW', via: null, mode: 'FOLLOW', intended: 1, held: 1, buffer: 0, poolAvailable: 1, routedLocations: [], fbaAtAmazon: 0, oversold: false } }) })
    const pv = await source.preview(req({ field: 'buffer', mode: 'buffer', input: { amount: 2 }, coordinateKeys: ['EBAY:IT'] }))
    const result = await source.apply(pv)
    expect(await result.undo!()).toBe('Put back 1 listing as it was · 1 could not be put back: No listing on this coordinate any more.')
    expect(revertSentence({ applied: 3, refused: 0, results: [
      { rowId: 'a', coordinateKey: 'EBAY:IT', cell: 'syncMode', outcome: 'applied', version: 2 },
      { rowId: 'a', coordinateKey: 'EBAY:IT', cell: 'syncQty', outcome: 'applied', version: 3 },
      { rowId: 'b', coordinateKey: 'EBAY:IT', cell: 'syncQty', outcome: 'applied', version: 3 },
    ] })).toBe('Put back 2 listings as they were.')
  })
})

describe('Base price', () => {
  it('a drop of 30 % or more asks for the typed word; a row not on screen is refused, never reported saved', async () => {
    const { source } = doorsFor({}, {
      masterWrite: async (ws) => ws.map((w) => (w.rowId === 'b' ? { rowId: 'b', ok: false, reason: BULK_NOT_ON_SCREEN } : { rowId: w.rowId, ok: true })),
    })
    const pv = await source.preview(req({ field: 'basePrice', mode: 'set', input: { amount: 70 }, coordinateKeys: [] }))
    expect(pv.confirmWord).toBe('APPLY')
    expect(pv.lines.every((l) => l.where === 'Shared')).toBe(true)
    expect(pv.notices).toEqual([{ text: BULK_SENT.followers, tone: 'info' }])
    const result = await source.apply(pv)
    expect([result.applied, result.skipped]).toEqual([1, 1])
    expect(result.lines!.map((l) => l.skipped)).toEqual([null, BULK_NOT_ON_SCREEN])
    expect(result.sentence).toBe(`1 base price changed · 1 skipped. ${BULK_SENT.followers}`)
  })
  it('a small change needs no typed word', async () => {
    const { source } = doorsFor({})
    expect((await source.preview(req({ field: 'basePrice', mode: 'lower', input: { percent: -5 }, coordinateKeys: [] }))).confirmWord).toBeNull()
  })
})

describe('the source the dialog reads', () => {
  it('hand-offs open their own dialog; without the page\'s door they are held', async () => {
    const { source, doors } = doorsFor({})
    expect(source.fields.find((f) => f.id === 'casePack')!.held).toBeNull()
    source.openElsewhere!('casePack')
    expect(doors.openElsewhere).toHaveBeenCalledWith('casePack')
    expect((await source.preview(req({ field: 'casePack', mode: 'open', coordinateKeys: [] }))).lines).toEqual([])
    const none = doorsFor({}, { openElsewhere: undefined }).source
    expect(none.fields.find((f) => f.id === 'stockPool')!.held).toBe(BULK_NO_HANDOFF)
    expect(none.openElsewhere).toBeUndefined()
  })
  it('supplies the rows as they are now, the mode a field opens on, and the markets\' note', () => {
    const { source } = doorsFor({ 'a|AMAZON:IT': price(105), 'b|AMAZON:IT': price(99, 'master') })
    expect(source.current('price', ['AMAZON:IT']).map((l) => [l.name, l.now, l.note])).toEqual([['Nero · S', '€105.00', 'Set here'], ['Nero · M', '€99.00', BULK_FOLLOWS_BASE]])
    expect(source.defaultMode('price', ['AMAZON:IT'])).toBeNull()
    expect(source.marketsNote('salePrice')).toBe('Not on eBay IT: no sale price there')
  })
})

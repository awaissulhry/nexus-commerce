/**
 * The bulk Edit's runner (v2, 2026-10-12): what it asks the server for, what it writes, and what its sentences count —
 * the server's answer, never the request. "Use base price" writes `price: null` and its Undo puts each price back; a
 * verb's Undo counts what the revert put back; Copy from never targets its own source; Raise / Lower by an amount send
 * the markets' currency; a refused line's Now is never empty; and hand-offs open their own dialog.
 */
import { describe, expect, it, vi } from 'vitest'

import type { MatrixCells, MatrixCoordinate, MatrixVerbRequest, MatrixWriteCell, MatrixWriteOutcome, VerbOperation, VerbPreview } from '../contract'
import { createBulkSource, revertSentence, type BulkDoors } from './bulkSource'
import { BULK_ALREADY_FOLLOWS, BULK_AMAZON_OWN_UNDO, BULK_FOLLOWS_BASE, BULK_NO_HANDOFF, BULK_NOT_ON_SCREEN, BULK_SENT, type BulkContext } from './fields'
import { MATRIX_COPY } from '../contract'
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
    // The page's line: a function is built when the writes' turn comes (here, at once).
    writeCells: vi.fn(async (asked: readonly MatrixWriteCell[] | (() => readonly MatrixWriteCell[])) => {
      const cells = typeof asked === 'function' ? asked() : asked
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

/**
 * One save line (2026-10-13): an Undo is built when its turn in the page's line comes, never when it is clicked; and it puts
 * a cell back only while the cell still holds what Apply wrote — a newer value (the person's own, or anyone else's) stays.
 */
describe('Undo — built at its turn, and only over what Apply wrote', () => {
  const sale = (value: number | null, version: number, start: string | null = null): MatrixCells => ({
    ...price(120, 'override', version), sale: { value, start, end: null },
  })
  /** writeCells as the page's line runs it: a write waits for `release()`, and its cells are built then. */
  function line(table: Record<string, MatrixCells>) {
    const built: MatrixWriteCell[][] = []
    let gate: Promise<void> = Promise.resolve()
    const writeCells = vi.fn(async (asked: readonly MatrixWriteCell[] | (() => readonly MatrixWriteCell[])) => {
      await gate
      const cells = typeof asked === 'function' ? asked() : asked
      built.push([...cells])
      return cells.map((c): MatrixWriteOutcome => {
        const k = `${c.rowId}|${c.coordinateKey}`
        const next = table[k]!.version + 1
        table[k] = c.cell === 'salePrice' ? { ...table[k]!, version: next, sale: c.value as MatrixCells['sale'] } : { ...table[k]!, version: next }
        return { rowId: c.rowId, coordinateKey: c.coordinateKey, cell: c.cell, outcome: 'applied', version: next }
      })
    })
    return { built, writeCells, hold: () => { let release!: () => void; gate = new Promise((r) => { release = r }); return () => { gate = Promise.resolve(); release() } } }
  }

  it('Sale: the Undo clicked while a write is on its way is built from the cells as that write left them', async () => {
    const table: Record<string, MatrixCells> = { 'a|AMAZON:IT': sale(null, 4) }
    const l = line(table)
    const { source } = doorsFor(table, { writeCells: l.writeCells })
    const pv = await source.preview(req({ field: 'salePrice', mode: 'sale-set', input: { sale: { value: 99, start: '2026-10-14', end: '2026-10-31' } } }))
    const result = await source.apply(pv)
    expect(l.built[0]!.map((c) => c.expectedVersion)).toEqual([4])
    // Another write of this page is on its way (it moves the listing to version 7) when Undo is clicked.
    const release = l.hold()
    const undoing = result.undo!()
    table['a|AMAZON:IT'] = { ...table['a|AMAZON:IT']!, version: 7 }
    release()
    expect(await undoing).toBe('Put back 1 sale.')
    expect(l.built[1]).toEqual([expect.objectContaining({ cell: 'salePrice', value: { value: null, start: null, end: null }, expectedVersion: 7 })])
  })

  it('Sale: a cell whose sale changed since keeps it (changedSince); the others are put back', async () => {
    const table: Record<string, MatrixCells> = { 'a|AMAZON:IT': sale(null, 4), 'b|AMAZON:IT': sale(null, 2) }
    const { source, writes } = doorsFor(table, {
      writeCells: vi.fn(async (asked: readonly MatrixWriteCell[] | (() => readonly MatrixWriteCell[])) => {
        const cells = typeof asked === 'function' ? asked() : asked
        writes.push([...cells])
        return cells.map((c): MatrixWriteOutcome => ({ rowId: c.rowId, coordinateKey: c.coordinateKey, cell: c.cell, outcome: 'applied', version: c.expectedVersion + 1 }))
      }),
    })
    const pv = await source.preview(req({ field: 'salePrice', mode: 'sale-set', input: { sale: { value: 99, start: '2026-10-14', end: '2026-10-31' } } }))
    const result = await source.apply(pv)
    expect(result.applied).toBe(2)
    // a still shows the bulk's sale (the read spells the day as a full time); b was changed to 89 since.
    table['a|AMAZON:IT'] = { ...sale(99, 5, '2026-10-14T00:00:00.000Z'), sale: { value: 99, start: '2026-10-14T00:00:00.000Z', end: '2026-10-31T00:00:00.000Z' } }
    table['b|AMAZON:IT'] = { ...sale(89, 4, '2026-10-14T00:00:00.000Z'), sale: { value: 89, start: '2026-10-14T00:00:00.000Z', end: '2026-10-31T00:00:00.000Z' } }
    expect(await result.undo!()).toBe(`Put back 1 sale · 1 could not be put back: ${MATRIX_COPY.changedSince}.`)
    expect(writes[1]!.map((c) => [c.rowId, c.expectedVersion])).toEqual([['a', 5]])
  })

  it('Use base price: a price set again since (no longer following the base) keeps it; the Undo is built at its turn', async () => {
    const table: Record<string, MatrixCells> = { 'a|AMAZON:IT': price(99, 'override', 2), 'b|AMAZON:IT': price(98, 'override', 4) }
    const { source, writes } = doorsFor(table)
    const result = await source.apply(await source.preview(req({ field: 'price', mode: 'follow-base' })))
    expect(result.applied).toBe(2)
    table['a|AMAZON:IT'] = price(105, 'master', 3)
    table['b|AMAZON:IT'] = price(97, 'override', 6)
    expect(await result.undo!()).toBe(`Put back 1 price · 1 could not be put back: ${MATRIX_COPY.changedSince}.`)
    expect(writes[1]).toEqual([{ rowId: 'a', coordinateKey: 'AMAZON:IT', cell: 'price', value: 99, expectedVersion: 3 }])
  })

  it('Base price: a row whose base price changed since keeps it; the others are put back', async () => {
    const now: Record<string, number | null> = {}
    const { source, doors } = doorsFor({}, {}, { basePriceNow: (rowId) => now[rowId] ?? null })
    const result = await source.apply(await source.preview(req({ field: 'basePrice', mode: 'set', input: { amount: 90 }, coordinateKeys: [] })))
    expect(result.applied).toBe(2)
    now.a = 90
    now.b = 95
    expect(await result.undo!()).toBe(`Put back 1 base price · 1 could not be put back: ${MATRIX_COPY.changedSince}.`)
    expect((doors.masterWrite as ReturnType<typeof vi.fn>).mock.calls[1]![0]).toEqual([{ rowId: 'a', value: 105 }])
  })
})

describe('Amazon Business — the B2B price and tiers run as Matrix verbs', () => {
  const IT_B2B = coord('AMAZON:IT', 'Amazon · IT', ['listing', 'price', 'salePrice', 'businessPrice', 'businessTiers'])
  const b2b = (rule: 'PERCENT_OFF' | 'FIXED' | null, listingId: string): MatrixCells => ({
    ...price(105, 'override', 2, listingId),
    business: { rule, percent: rule === 'PERCENT_OFF' ? 5 : null, exact: rule === 'FIXED' ? 90 : null, tiers: null, price: rule === 'PERCENT_OFF' ? 99.75 : rule === 'FIXED' ? 90 : null, normalPrice: 105, minPrice: null, maxPrice: null, currency: 'EUR', warnings: [], held: null, send: null, live: null, reported: null },
    writable: { price: true, salePrice: true, businessPrice: true, businessTiers: true },
  })
  const table = { 'a|AMAZON:IT': b2b(null, 'LA'), 'b|AMAZON:IT': b2b('FIXED', 'LB'), 'a|EBAY:IT': price(105), 'b|EBAY:IT': price(105) }
  const setting = { rule: 'PERCENT_OFF', percent: 5, price: null, tiers: null }

  it('preview asks the server with the verb\'s params on the B2B markets only; Apply sends exactly that preview; Undo is the verb\'s revert', async () => {
    const op: VerbOperation = { id: 'op-b2b', verb: 'set-business-price', appliedAt: '', applied: 1, refused: 0, before: [] }
    const shown: VerbPreview = {
      verb: 'set-business-price', confirm: 'none', confirmWord: null, simulated: false, notices: [],
      changes: [{ rowId: 'a', sku: 'A', coordinateKey: 'AMAZON:IT', cell: 'businessPrice', from: null, to: setting, fromLabel: '—', toLabel: '€99.75 · −5%', note: 'First business price here' }],
      refusals: [{ rowId: 'b', sku: 'B', coordinateKey: 'AMAZON:IT', kind: 'guard', reason: 'The business price EUR 99.75 is above the normal price EUR 90.00' }],
    }
    const { doors, source } = doorsFor(table, {
      previewVerb: vi.fn(async () => shown),
      applyVerb: vi.fn(async () => ({ ...op, results: [{ rowId: 'a', coordinateKey: 'AMAZON:IT', cell: 'businessPrice' as const, outcome: 'applied' as const, version: 3, writtenAt: 2 }] })),
      revertVerb: vi.fn(async () => ({ ...op, results: [{ rowId: 'a', coordinateKey: 'AMAZON:IT', cell: 'businessPrice' as const, outcome: 'applied' as const, version: 4 }] })),
    }, { coordinates: [IT_B2B, EBAY] })
    const pv = await source.preview(req({ field: 'businessPrice', mode: 'b2b-percent', input: { percent: 5 }, coordinateKeys: ['AMAZON:IT', 'EBAY:IT'] }))
    expect(doors.previewVerb).toHaveBeenCalledWith({ params: { verb: 'set-business-price', mode: 'percent', percent: 5 }, targets: [{ rowId: 'a', coordinateKey: 'AMAZON:IT' }, { rowId: 'b', coordinateKey: 'AMAZON:IT' }], commit: false })
    expect(pv.lines.map((l) => [l.sku, l.now, l.next, l.note, l.skipped])).toEqual([
      ['A', '—', '€99.75 · −5%', 'First business price here', null],
      ['B', '€90.00', null, null, 'The business price EUR 99.75 is above the normal price EUR 90.00'],
    ])
    expect(pv.notices).toEqual([{ text: BULK_SENT.business, tone: 'info' }])
    expect(pv.undoable).toBe(true)
    const result = await source.apply(pv)
    expect(doors.applyVerb).toHaveBeenCalledWith(shown)
    expect(result.sentence).toBe(`1 business price set · 1 skipped. ${BULK_SENT.business}`)
    expect(await result.undo!()).toBe('Put back 1 listing as it was.')
    expect(doors.revertVerb).toHaveBeenCalledWith(expect.objectContaining({ id: 'op-b2b' }))
  })

  it('no Undo when every line applied replaced a business price set outside Nexus; with others it stays, and the sentence says it', async () => {
    const own = (listingId: string): MatrixCells => {
      const c = b2b(null, listingId)
      return { ...c, business: { ...c.business!, reported: { price: 95 } } }
    }
    const line = (rowId: string) => ({ rowId, sku: rowId.toUpperCase(), coordinateKey: 'AMAZON:IT', cell: 'businessPrice' as const, from: null, to: setting, fromLabel: '—', toLabel: '€99.75 · −5%' })
    const run = async (rows: string[], tbl: Record<string, MatrixCells>) => {
      const shown: VerbPreview = { verb: 'set-business-price', confirm: 'none', confirmWord: null, simulated: false, notices: [], refusals: [], changes: rows.map(line) }
      const { source } = doorsFor(tbl, {
        previewVerb: vi.fn(async () => shown),
        applyVerb: vi.fn(async () => ({ id: 'op-own', verb: 'set-business-price' as const, appliedAt: '', applied: rows.length, refused: 0, before: [], results: rows.map((r) => ({ rowId: r, coordinateKey: 'AMAZON:IT', cell: 'businessPrice' as const, outcome: 'applied' as const, version: 3, writtenAt: 2 })) })),
      }, { coordinates: [IT_B2B, EBAY] })
      return source.apply(await source.preview(req({ field: 'businessPrice', mode: 'b2b-percent', input: { percent: 5 } })))
    }
    const onlyOwn = await run(['a'], { ...table, 'a|AMAZON:IT': own('LA') })
    expect(onlyOwn.undo).toBeNull()
    expect(onlyOwn.sentence).toBe(`1 business price set. ${BULK_SENT.business} ${BULK_AMAZON_OWN_UNDO}`)
    const mixed = await run(['a', 'b'], { ...table, 'a|AMAZON:IT': own('LA') })
    expect(mixed.undo).not.toBeNull()
    expect(mixed.sentence).toBe(`2 business prices set. ${BULK_SENT.business} ${BULK_AMAZON_OWN_UNDO}`)
    const none = await run(['b'], table)
    expect([none.undo !== null, none.sentence]).toEqual([true, `1 business price set. ${BULK_SENT.business}`])
  })

  it('a line refused at Apply is skipped with the server\'s reason (Changed since the preview)', async () => {
    const shown: VerbPreview = {
      verb: 'set-business-tiers', confirm: 'none', confirmWord: null, simulated: false, notices: [], refusals: [],
      changes: [{ rowId: 'b', sku: 'B', coordinateKey: 'AMAZON:IT', cell: 'businessTiers', from: null, to: { ...setting, tiers: { type: 'percent', levels: [{ minQty: 2, value: 3 }] } }, fromLabel: '—', toLabel: '2+ −3%' }],
    }
    const { source } = doorsFor(table, {
      previewVerb: vi.fn(async () => shown),
      applyVerb: vi.fn(async () => ({ id: 'op2', verb: 'set-business-tiers' as const, appliedAt: '', applied: 0, refused: 1, before: [], results: [{ rowId: 'b', coordinateKey: 'AMAZON:IT', cell: 'businessTiers' as const, outcome: 'refused' as const, reason: 'Changed since the preview — reload and run the verb again', version: 2 }] })),
    }, { coordinates: [IT_B2B, EBAY] })
    const pv = await source.preview(req({ field: 'businessTiers', mode: 'tiers-set', input: { tiers: { type: 'percent', levels: [{ minQty: 2, value: 3 }] } } }))
    const result = await source.apply(pv)
    expect(result.lines!.map((l) => l.skipped)).toEqual(['Changed since the preview — reload and run the verb again'])
    expect(result.tone).toBe('danger')
    expect(result.undo).toBeNull()
  })
})

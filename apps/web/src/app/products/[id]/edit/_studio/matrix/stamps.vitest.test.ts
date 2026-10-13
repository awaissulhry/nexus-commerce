/**
 * Field stamps (2026-10-13) on the page side: every Matrix write carries what its cell SHOWED when the person edited it,
 * read from the pristine read — never from the grid's clone, which the engine's valueSetter has already overwritten with
 * the typed value — and a write the server did not change still leaves its ⌘Z step.
 */
import { describe, expect, it } from 'vitest'

import { matrixApplyValue, matrixCellValue, matrixWrite, type MatrixCells } from '@/design-system/grid'
import { matrixCellStamp } from '@nexus/shared/matrix-stamp'
import { SheetUndoHistory } from '../sheet/sheetUndo'
import { forgetUnsaved, matrixHistoryAfter, matrixHistoryBefore, type MatrixHistoryNote } from './matrixUndo'
import { patchMatrix } from './source'
import { recordOwnMoves, withStamp } from './stamps'

const pristine = (over: Partial<MatrixCells> = {}): MatrixCells => ({
  listingId: 'L1', version: 3, listing: null,
  fulfilment: { method: 'FBM', source: 'set', guard: 'FBM', reported: null },
  sync: { kind: 'FOLLOW', via: null, mode: 'FOLLOW', intended: 10, held: 10, buffer: 0, poolAvailable: 10, routedLocations: ['W1'], fbaAtAmazon: null, oversold: false },
  queue: null,
  price: { value: 105, currency: 'EUR', source: 'master', formula: null, clamped: null },
  sale: { value: null, start: null, end: null },
  writable: { syncMode: true, syncQty: true, syncBuffer: true, price: true, salePrice: true },
  writeBlockedReason: {},
  ...over,
})

/** What `onCellValueChanged` does: the engine has written the typed value into the grid's clone, then the write is built. */
function typed(kind: 'syncQty' | 'price' | 'syncBuffer', saved: MatrixCells, value: unknown) {
  const clone = structuredClone(saved)
  const before = matrixCellValue(kind, clone)
  expect(matrixApplyValue(clone, kind, value)).toBe(true)
  const decision = matrixWrite({ kind, coordinateKey: 'AMAZON:EU', rowId: 'r1' }, clone, before, value)
  if (!decision.send) throw new Error(decision.reason)
  return { clone, cell: withStamp({ ...decision.cell, expectedListingId: 'L1' }, saved) }
}

describe('a cell edit sends the value its cell showed (the stamp), from the pristine read', () => {
  it('a number typed into a Follow Qty cell stamps the mode it showed — the follow number may move under it (Owner 4A)', () => {
    const { cell } = typed('syncQty', pristine(), 7)
    expect(cell).toMatchObject({ cell: 'syncQty', value: 7, expectedVersion: 3, expected: { mode: 'FOLLOW' } })
  })
  it('a typed price stamps the listing\'s own price as it showed (following the master: null), never the typed number', () => {
    const { cell } = typed('price', pristine(), 99)
    expect(cell.expected).toEqual({ own: null })
  })
  it('🔴 a Pinned Qty cell stamps the number it SHOWED; the grid\'s clone already holds the typed one (negative control)', () => {
    const saved = pristine({ sync: { ...pristine().sync!, kind: 'PINNED', mode: 'PINNED', intended: 7, held: 7 } })
    const { clone, cell } = typed('syncQty', saved, 9)
    expect(cell.expected).toEqual({ mode: 'PINNED', qty: 7 })
    expect(matrixCellStamp('syncQty', clone)).toEqual({ mode: 'PINNED', qty: 9 })
  })
  it('cells read at another version, or on another listing, are not what the person saw: no stamp, the version decides', () => {
    const write = { rowId: 'r1', coordinateKey: 'AMAZON:EU', cell: 'syncBuffer' as const, value: 2, expectedVersion: 3, expectedListingId: 'L1' }
    expect(withStamp(write, pristine({ version: 4 }))).toEqual(write)
    expect(withStamp(write, pristine({ listingId: 'L2' }))).toEqual(write)
    expect(withStamp(write, null)).toEqual(write)
    expect(withStamp(write, pristine())).toEqual({ ...write, expected: { buffer: 0 } })
  })
  it('the stamp travels in the PATCH body, cell by cell', async () => {
    let body: unknown = null
    const fetchImpl = (async (_url: string, init: { body: string }) => { body = JSON.parse(init.body); return new Response(JSON.stringify({ results: [], version: 1 })) }) as unknown as typeof fetch
    const { cell } = typed('syncQty', pristine(), 7)
    await patchMatrix('p1', [cell], { fetchImpl, baseUrl: 'http://api.test' })
    expect(body).toEqual({ cells: [{ rowId: 'r1', coordinateKey: 'AMAZON:EU', cell: 'syncQty', value: 7, expectedVersion: 3, expectedListingId: 'L1', expected: { mode: 'FOLLOW' } }] })
  })
})

describe('a write the server did not change leaves its ⌘Z step (forgetUnsaved)', () => {
  const note: MatrixHistoryNote = { rowId: 'r1', colId: 'AMAZON:IT.price', key: 'AMAZON:IT', after: matrixHistoryAfter(99) }
  const recorded = () => {
    const history = new SheetUndoHistory()
    history.begin()
    history.record({ rowId: note.rowId, colId: note.colId, before: matrixHistoryBefore(pristine()), after: note.after })
    history.end()
    return history
  }
  it('a stamped field that moved (a conflict with the field as it is now): the step is forgotten — nothing to undo', () => {
    const history = recorded()
    forgetUnsaved(history, [note], [{ rowId: 'r1', coordinateKey: 'AMAZON:IT', cell: 'price', outcome: 'conflict', reason: 'Changed elsewhere — reloaded', version: 5, current: { own: 95 } }])
    expect(history.canUndo).toBe(false)
  })
  it('positive control: the same write applied (a sale had moved the version, the price had not) keeps its step', () => {
    const history = recorded()
    forgetUnsaved(history, [note], [{ rowId: 'r1', coordinateKey: 'AMAZON:IT', cell: 'price', outcome: 'applied', version: 6 }])
    expect(history.canUndo).toBe(true)
  })
})

describe('own-move re-basing (#592) hops from the version the server checked the write at', () => {
  const sent = { rowId: 'r1', coordinateKey: 'AMAZON:IT', cell: 'price' as const, value: 90, expectedVersion: 3, expectedListingId: 'L1' }
  it('a write applied at the version it was sent: the hop is sent → new (a later edit on the same view follows it)', () => {
    const moves = new Map<string, Map<number, number>>()
    recordOwnMoves(moves, [sent], [{ rowId: 'r1', coordinateKey: 'AMAZON:IT', cell: 'price', outcome: 'applied', version: 4 }])
    expect([...moves.get('L1')!]).toEqual([[3, 4]])
  })
  it('🔴 a stamped write that went ahead over a sale (3 → 5): the hop is 5 → 6, never 3 → 6 — a later edit made on the view at 3 is still checked against the sale', () => {
    const moves = new Map<string, Map<number, number>>()
    recordOwnMoves(moves, [sent], [{ rowId: 'r1', coordinateKey: 'AMAZON:IT', cell: 'price', outcome: 'applied', version: 6, writtenAt: 5 }])
    expect([...moves.get('L1')!]).toEqual([[5, 6]])
  })
  it('a refusal or a conflict moves nothing', () => {
    const moves = new Map<string, Map<number, number>>()
    recordOwnMoves(moves, [sent, { ...sent, cell: 'salePrice' as const }], [
      { rowId: 'r1', coordinateKey: 'AMAZON:IT', cell: 'price', outcome: 'conflict', version: 5, current: { own: 95 } },
      { rowId: 'r1', coordinateKey: 'AMAZON:IT', cell: 'salePrice', outcome: 'refused', reason: 'no', version: 3 },
    ])
    expect(moves.size).toBe(0)
  })
})

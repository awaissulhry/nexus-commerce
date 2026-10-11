import { describe, expect, it } from 'vitest'

import type { MatrixCells } from '@/design-system/grid'
import { isHistoryOnly, SheetUndoHistory } from '../sheet/sheetUndo'
import { isMatrixHistoryValue, matrixHistoryAfter, matrixHistoryBefore, matrixReplay, MATRIX_UNDO_COPY } from './matrixUndo'

type Over = { [K in keyof MatrixCells]?: MatrixCells[K] extends object | null ? Partial<NonNullable<MatrixCells[K]>> | null : MatrixCells[K] }

/** A writable, following, master-priced cell — each case moves what it needs. */
function cells(over: Over = {}): MatrixCells {
  const base: MatrixCells = {
    listingId: 'L1', version: 3,
    listing: { state: 'listed', externalId: 'B0FXD0620C', detail: null, published: true },
    fulfilment: { method: 'FBM', source: 'set', guard: 'FBM', reported: null },
    sync: { kind: 'FOLLOW', via: null, mode: 'FOLLOW', intended: 29, held: 29, buffer: 0, poolAvailable: 29, routedLocations: ['W1'], fbaAtAmazon: null, oversold: false },
    queue: null,
    price: { value: 105, currency: 'EUR', source: 'master', formula: null, clamped: null },
    sale: { value: null, start: null, end: null },
    writable: { fulfilment: true, syncMode: true, syncQty: true, syncBuffer: true, price: true, salePrice: true },
    writeBlockedReason: {},
  }
  const out = { ...base } as unknown as Record<string, unknown>
  for (const k of Object.keys(over) as (keyof MatrixCells)[]) {
    const v = over[k]
    const b = (base as unknown as Record<string, unknown>)[k]
    out[k] = v && typeof v === 'object' && b && typeof b === 'object' && k !== 'writable' ? { ...(b as object), ...(v as object) } : v
  }
  return out as unknown as MatrixCells
}

const place = { rowId: 'r1', coordinateKey: 'AMAZON:EU' }
const undo = (kind: Parameters<typeof matrixReplay>[0], before: MatrixCells | null, live: MatrixCells | null) => matrixReplay(kind, matrixHistoryBefore(before), live, place)
const write = (cell: string, value: unknown, expectedVersion: number) => ({ kind: 'write', cell: { rowId: 'r1', coordinateKey: 'AMAZON:EU', cell, value, expectedVersion } })

describe('matrixReplay — undo puts a cell back AS IT WAS, not only its number', () => {
  it('a number typed into a Follow quantity (the server pinned it) follows the stock again — never a pin at the old number', () => {
    const live = cells({ version: 4, sync: { kind: 'PINNED', mode: 'PINNED', intended: 35 } })
    expect(undo('syncQty', cells(), live)).toEqual(write('syncMode', 'FOLLOW', 4))
  })
  it('a pinned quantity goes back to its own pin; Mode back to Pinned pins at the number it had', () => {
    const before = cells({ sync: { kind: 'PINNED', mode: 'PINNED', intended: 20 } })
    expect(undo('syncQty', before, cells({ version: 4, sync: { kind: 'PINNED', mode: 'PINNED', intended: 30 } }))).toEqual(write('syncQty', 20, 4))
    expect(undo('syncMode', before, cells({ version: 5 }))).toEqual(write('syncQty', 20, 5))
  })
  it('a price that followed the base price follows it again (null); an own price comes back as its number', () => {
    expect(undo('price', cells(), cells({ version: 4, price: { value: 99, source: 'override' } }))).toEqual(write('price', null, 4))
    const own = cells({ price: { value: 110, source: 'override' } })
    expect(undo('price', own, cells({ version: 4, price: { value: 99, source: 'override' } }))).toEqual(write('price', 110, 4))
  })
  it('a buffer and a sale come back as they were', () => {
    expect(undo('syncBuffer', cells(), cells({ version: 4, sync: { buffer: 2 } }))).toEqual(write('syncBuffer', 0, 4))
    const sale = { value: 89, start: '2026-09-12T00:00:00.000Z', end: null }
    expect(undo('salePrice', cells({ sale }), cells({ version: 4, sale: { value: 79 } }))).toEqual(write('salePrice', sale, 4))
  })
  it('nothing to write when the cell already is as it was (the edit was refused, or someone put it back)', () => {
    expect(undo('syncQty', cells(), cells({ version: 4 }))).toEqual({ kind: 'skip' })
    expect(undo('price', cells(), cells())).toEqual({ kind: 'skip' })
    expect(undo('syncQty', cells({ sync: { kind: 'FBA_EXCLUDED' } }), cells({ sync: { kind: 'PINNED', mode: 'PINNED' } }))).toEqual({ kind: 'skip' })
  })
  it('another listing on the coordinate now, or none: refused with its reason (negative controls)', () => {
    expect(undo('syncQty', cells(), cells({ listingId: 'L2' }))).toEqual({ kind: 'refuse', reason: MATRIX_UNDO_COPY.gone })
    expect(undo('syncQty', cells(), null)).toEqual({ kind: 'refuse', reason: MATRIX_UNDO_COPY.gone })
    expect(undo('syncQty', null, cells())).toEqual({ kind: 'refuse', reason: MATRIX_UNDO_COPY.gone })
  })
})

describe('matrixReplay — redo sends the edit again, as typing it would', () => {
  it('the written value at the version the cell has now; unchanged sends nothing; a held cell says why', () => {
    expect(matrixReplay('syncQty', matrixHistoryAfter(35), cells({ version: 6 }), place)).toEqual(write('syncQty', 35, 6))
    expect(matrixReplay('syncQty', matrixHistoryAfter(29), cells(), place)).toEqual({ kind: 'skip' })
    const held = cells({ writable: { price: false }, writeBlockedReason: { price: 'A formula owns this cell — edit the formula' } })
    expect(matrixReplay('price', matrixHistoryAfter(99), held, place)).toEqual({ kind: 'refuse', reason: 'A formula owns this cell — edit the formula' })
  })
})

describe('the history values', () => {
  it('only the history holds them: the sheet replay skips them, and the "before" is a copy taken at the edit', () => {
    const source = cells()
    const before = matrixHistoryBefore(source)
    source.sync!.intended = 99
    expect(before.before!.sync!.intended).toBe(29)
    expect(isHistoryOnly(before)).toBe(true)
    expect(isMatrixHistoryValue(before)).toBe(true)
    expect(isMatrixHistoryValue(matrixHistoryAfter(5))).toBe(true)
    expect(isMatrixHistoryValue(5)).toBe(false)
  })
  it('one paste is one step: ⌘Z hands back every cell\'s "before", ⌘⇧Z every "after"', () => {
    const history = new SheetUndoHistory()
    history.begin()
    history.record({ rowId: 'r1', colId: 'AMAZON:EU.syncQty', before: matrixHistoryBefore(cells()), after: matrixHistoryAfter(35) })
    history.record({ rowId: 'r2', colId: 'AMAZON:EU.syncQty', before: matrixHistoryBefore(cells()), after: matrixHistoryAfter(36) })
    history.end()
    const seen: unknown[] = []
    expect(history.undo((values) => { seen.push(...values) })).toBe(2)
    expect(seen.map((v) => (v as { rowId: string }).rowId)).toEqual(['r1', 'r2'])
    expect(history.redo((values) => { seen.push(...values.map((v) => (v.value as { value: unknown }).value)) })).toBe(2)
    expect(seen.slice(2)).toEqual([35, 36])
  })
})

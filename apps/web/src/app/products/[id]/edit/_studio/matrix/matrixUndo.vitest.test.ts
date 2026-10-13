import { describe, expect, it } from 'vitest'

import type { MatrixCells } from '@/design-system/grid'
import { isHistoryOnly, SheetUndoHistory } from '../sheet/sheetUndo'
import { MATRIX_COPY, type MatrixWriteOutcome } from './contract'
import { forgetUnsaved, isMatrixHistoryValue, matrixHistoryAfter, matrixHistoryBefore, matrixHistoryColId, matrixHistoryPlace, matrixReplay, matrixStepReplay, MATRIX_UNDO_COPY } from './matrixUndo'

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

describe('matrixReplay — Amazon Business: undo puts the whole business setting back', () => {
  const biz = (over: Record<string, unknown> = {}) => ({
    rule: 'PERCENT_OFF', percent: 5, exact: null, price: 99.75, normalPrice: 105, minPrice: null, maxPrice: null, currency: 'EUR',
    tiers: { type: 'percent', levels: [{ minQty: 2, value: 3, unitPrice: 96.76 }] }, warnings: [], held: null, send: null, live: null, reported: null, ...over,
  }) as never
  it('a changed rule goes back as it was, through the column\'s own kind; a removal comes back; nothing moved → skip', () => {
    const was = cells({ business: biz() })
    expect(undo('businessPrice', was, cells({ version: 4, business: biz({ percent: 6, price: 98.7 }) })))
      .toEqual(write('businessPrice', { rule: 'PERCENT_OFF', percent: 5, price: null, tiers: { type: 'percent', levels: [{ minQty: 2, value: 3 }] } }, 4))
    expect(undo('businessTiers', was, cells({ version: 5, business: biz({ tiers: null }) })))
      .toEqual(write('businessTiers', { rule: 'PERCENT_OFF', percent: 5, price: null, tiers: { type: 'percent', levels: [{ minQty: 2, value: 3 }] } }, 5))
    expect(undo('businessPrice', cells({ business: biz({ rule: null, percent: null, price: null, tiers: null }) }), cells({ version: 6, business: biz() })))
      .toEqual(write('businessPrice', null, 6))
    expect(undo('businessPrice', was, cells({ version: 4, business: biz() }))).toEqual({ kind: 'skip' })
  })
})

describe('matrixReplay — Amazon Business: a redo sends the WHOLE setting the edit saved', () => {
  const biz = (over: Record<string, unknown> = {}) => ({
    rule: 'PERCENT_OFF', percent: 5, exact: null, price: 99.75, normalPrice: 105, minPrice: null, maxPrice: null, currency: 'EUR',
    tiers: { type: 'percent', levels: [{ minQty: 2, value: 3, unitPrice: 96.76 }] }, warnings: [], held: null, send: null, live: null, reported: null, ...over,
  }) as never
  const saved = { rule: 'PERCENT_OFF', percent: 7, price: null, tiers: { type: 'percent', levels: [{ minQty: 3, value: 4 }] } }
  it('the recorded setting, price and tiers together — never the half its column shows joined to what is there after the undo', () => {
    const live = cells({ version: 9, business: biz() })
    expect(matrixReplay('businessTiers', matrixHistoryAfter(saved), live, place)).toEqual(write('businessTiers', saved, 9))
    expect(matrixReplay('businessPrice', matrixHistoryAfter(null), live, place)).toEqual(write('businessPrice', null, 9))
  })
  it('already there → skip', () => {
    const live = cells({ version: 9, business: biz({ percent: 7, tiers: { type: 'percent', levels: [{ minQty: 3, value: 4, unitPrice: null }] } }) })
    expect(matrixReplay('businessPrice', matrixHistoryAfter(saved), live, place)).toEqual({ kind: 'skip' })
  })
})

/**
 * One save line (2026-10-13): an undo puts a cell back only while it still holds what the edit wrote — a newer value, the
 * person's own or anyone else's, stays. The written value rides on the step's undo side (`matrixHistoryBefore(cells, after)`).
 */
describe('matrixReplay — undo only over what the edit wrote', () => {
  const undoOf = (kind: Parameters<typeof matrixReplay>[0], before: MatrixCells, written: unknown, live: MatrixCells) =>
    matrixReplay(kind, matrixHistoryBefore(before, matrixHistoryAfter(written)), live, place)
  it('a price typed to 99 is put back while the cell shows 99; once someone set 95 it stays, and says why', () => {
    expect(undoOf('price', cells(), 99, cells({ version: 4, price: { value: 99, source: 'override' } }))).toEqual(write('price', null, 4))
    expect(undoOf('price', cells(), 99, cells({ version: 5, price: { value: 95, source: 'override' } }))).toEqual({ kind: 'refuse', reason: MATRIX_COPY.changedSince })
    // Someone put it back already: nothing to write, nothing to say.
    expect(undoOf('price', cells(), 99, cells({ version: 5 }))).toEqual({ kind: 'skip' })
  })
  it('a pinned quantity, a buffer and a sale: the same rule', () => {
    expect(undoOf('syncQty', cells(), 35, cells({ version: 4, sync: { kind: 'PINNED', mode: 'PINNED', intended: 35 } }))).toEqual(write('syncMode', 'FOLLOW', 4))
    expect(undoOf('syncQty', cells(), 35, cells({ version: 4, sync: { kind: 'PINNED', mode: 'PINNED', intended: 40 } }))).toEqual({ kind: 'refuse', reason: MATRIX_COPY.changedSince })
    expect(undoOf('syncBuffer', cells(), 2, cells({ version: 4, sync: { buffer: 3 } }))).toEqual({ kind: 'refuse', reason: MATRIX_COPY.changedSince })
    const typed = { value: 79, start: '2026-10-14', end: null }
    expect(undoOf('salePrice', cells(), typed, cells({ version: 4, sale: { value: 79, start: '2026-10-14T00:00:00.000Z' } }))).toEqual(write('salePrice', { value: null, start: null, end: null }, 4))
    expect(undoOf('salePrice', cells(), typed, cells({ version: 4, sale: { value: 69, start: '2026-10-14T00:00:00.000Z' } }))).toEqual({ kind: 'refuse', reason: MATRIX_COPY.changedSince })
  })
  it('the B2B setting the pop-up saved is put back only while the cell holds that setting', () => {
    const biz = (over: Record<string, unknown> = {}) => ({
      rule: 'PERCENT_OFF', percent: 5, exact: null, price: 99.75, normalPrice: 105, minPrice: null, maxPrice: null, currency: 'EUR',
      tiers: null, warnings: [], held: null, send: null, live: null, reported: null, ...over,
    }) as never
    const none = cells({ business: biz({ rule: null, percent: null, price: null }) })
    const saved = { rule: 'PERCENT_OFF', percent: 5, price: null, tiers: null }
    expect(undoOf('businessPrice', none, saved, cells({ version: 8, business: biz() }))).toEqual(write('businessPrice', null, 8))
    expect(undoOf('businessPrice', none, saved, cells({ version: 9, business: biz({ percent: 7, price: 97.65 }) }))).toEqual({ kind: 'refuse', reason: MATRIX_COPY.changedSince })
  })
  it('a step recorded without what it wrote (an older history value) keeps the old rule', () => {
    expect(undo('price', cells(), cells({ version: 5, price: { value: 95, source: 'override' } }))).toEqual(write('price', null, 5))
  })
  it('a clamped price shows its floor, not its own price: an own price is never put back over it blind; its source still decides', () => {
    // Typed 12, clamped to the floor 15 — whether someone set 13 since cannot be read: refused, with the reason.
    const clamped = cells({ version: 6, price: { value: 15, source: 'override', clamped: 'floor' } })
    expect(undoOf('price', cells({ price: { value: 10, source: 'override' } }), 12, clamped)).toEqual({ kind: 'refuse', reason: MATRIX_UNDO_COPY.clamped })
    expect(undo('price', cells({ price: { value: 10, source: 'override' } }), clamped)).toEqual({ kind: 'refuse', reason: MATRIX_UNDO_COPY.clamped })
    // "Use base price" (written null): an own price set since — clamped or not — stays; still following the base, it goes back.
    const own99 = cells({ price: { value: 99, source: 'override' } })
    expect(undoOf('price', own99, null, cells({ version: 7, price: { value: 15, source: 'override', clamped: 'floor' } }))).toEqual({ kind: 'refuse', reason: MATRIX_COPY.changedSince })
    expect(undoOf('price', own99, null, cells({ version: 7, price: { value: 15, source: 'master', clamped: 'floor' } }))).toEqual(write('price', 99, 7))
  })
})

describe('Amazon Business: a business price set at Amazon is never removed to undo (the toast offers no Undo; ⌘Z refuses the same)', () => {
  it('the first Nexus save over Amazon\'s own business price: ⌘Z refuses, and writes nothing — never `null`', () => {
    const biz = (over: Record<string, unknown> = {}) => ({
      rule: 'PERCENT_OFF', percent: 5, exact: null, price: 99.75, normalPrice: 105, minPrice: null, maxPrice: null, currency: 'EUR',
      tiers: null, warnings: [], held: null, send: null, live: null, reported: null, ...over,
    }) as never
    const amazonOwn = cells({ business: biz({ rule: null, percent: null, price: null, reported: { price: 90 } }) })
    const saved = { rule: 'PERCENT_OFF', percent: 5, price: null, tiers: null }
    expect(matrixReplay('businessPrice', matrixHistoryBefore(amazonOwn, matrixHistoryAfter(saved)), cells({ version: 8, business: biz() }), place))
      .toEqual({ kind: 'refuse', reason: MATRIX_UNDO_COPY.amazonOwn })
    expect(matrixReplay('businessTiers', matrixHistoryBefore(amazonOwn), cells({ version: 8, business: biz() }), place))
      .toEqual({ kind: 'refuse', reason: MATRIX_UNDO_COPY.amazonOwn })
  })
})

/**
 * 2026-10-13 review — a refused undo never reaches the redo stack: one ⌘⇧Z must not write the old edit over the newer value
 * (a price, or a B2B setting that goes to Amazon). And a toast that takes a step from the middle never reorders ⌘⇧Z.
 */
describe('a refused undo leaves the redo stack (`matrixStepReplay` + `SheetUndoHistory.dropRedo`)', () => {
  const colId = 'AMAZON:EU.price'
  /** Replays a step the way the page does: builds at the line's turn, then hands the server's answer back. */
  function replayer(history: SheetUndoHistory, liveOf: () => MatrixCells, answer: (cell: { cell: string }) => MatrixWriteOutcome['outcome'] = () => 'applied') {
    const sent: unknown[][] = []
    const apply = (values: Array<{ rowId: string; colId: string; value: unknown }>, direction: 'undo' | 'redo') => {
      const step = matrixStepReplay(values, direction, { liveOf: () => liveOf(), history })
      const cells = step.build()
      sent.push(cells.map((c) => c.value))
      step.settle(cells.map((c) => ({ rowId: c.rowId, coordinateKey: c.coordinateKey, cell: c.cell, outcome: answer(c), version: 9 })))
    }
    return { apply, sent }
  }

  it('A: typed 20, the bulk Edit set 25 since — ⌘Z refuses ("Changed since"), and ⌘⇧Z then writes nothing', () => {
    const history = new SheetUndoHistory()
    const typed = matrixHistoryAfter(20)
    history.record({ rowId: 'r1', colId, before: matrixHistoryBefore(cells({ price: { value: 15, source: 'override' } }), typed), after: typed })
    const live = cells({ version: 5, price: { value: 25, source: 'override' } })
    const r = replayer(history, () => live)
    expect(history.undo(r.apply)).toBe(1)
    expect(r.sent).toEqual([[]])
    expect(history.canRedo).toBe(false)
    expect(history.redo(r.apply)).toBe(0)
    expect(r.sent).toEqual([[]])
  })

  it('an undo the SERVER refuses (a conflict) leaves the redo stack too; one it stored stays redoable', () => {
    const history = new SheetUndoHistory()
    const typed = matrixHistoryAfter(20)
    history.record({ rowId: 'r1', colId, before: matrixHistoryBefore(cells({ price: { value: 15, source: 'override' } }), typed), after: typed })
    const live = cells({ version: 5, price: { value: 20, source: 'override' } })
    expect(history.undo(replayer(history, () => live, () => 'conflict').apply)).toBe(1)
    expect(history.canRedo).toBe(false)

    const again = new SheetUndoHistory()
    again.record({ rowId: 'r1', colId, before: matrixHistoryBefore(cells({ price: { value: 15, source: 'override' } }), typed), after: typed })
    again.undo(replayer(again, () => live).apply)
    expect(again.canRedo).toBe(true)
  })

  it('B (B2B, sent to Amazon): a toast Undo refused under a newer setting is not redoable; ⌘Z, ⌘⇧Z, ⌘⇧Z ends on the newer setting', () => {
    const history = new SheetUndoHistory()
    const bcol = 'AMAZON:EU.businessPrice'
    const biz = (percent: number | null) => ({ rule: percent == null ? null : 'PERCENT_OFF', percent, exact: null, price: null, normalPrice: 105, minPrice: null, maxPrice: null, currency: 'EUR', tiers: null, warnings: [], held: null, send: null, live: null, reported: null }) as never
    const none = cells({ business: biz(null) }), atA = cells({ version: 4, business: biz(5) })
    const A = { rule: 'PERCENT_OFF', percent: 5, price: null, tiers: null }, B = { rule: 'PERCENT_OFF', percent: 8, price: null, tiers: null }
    const sA = matrixHistoryAfter(A), sB = matrixHistoryAfter(B)
    history.record({ rowId: 'r1', colId: bcol, before: matrixHistoryBefore(none, sA), after: sA })
    history.undo(() => {}); history.redo(() => {}) // the first step is closed and done again
    history.record({ rowId: 'r1', colId: bcol, before: matrixHistoryBefore(atA, sB), after: sB })
    // The cell as the server holds it: B, then A once B is undone, then B again.
    let live = cells({ version: 5, business: biz(8) })
    const r = replayer(history, () => live)
    // The toast's Undo of the first save: refused (the cell holds B), and not redoable.
    expect(history.undoStep((c) => c.after === sA, r.apply)).toBe(1)
    expect(r.sent).toEqual([[]])
    // ⌘Z undoes B (back to A); ⌘⇧Z redoes B; a second ⌘⇧Z has nothing left — the cell ends on B.
    expect(history.undo(r.apply)).toBe(1)
    expect(r.sent.at(-1)).toEqual([A])
    live = cells({ version: 6, business: biz(5) })
    expect(history.redo(r.apply)).toBe(1)
    expect(r.sent.at(-1)).toEqual([B])
    expect(history.redo(r.apply)).toBe(0)
  })

  it('a step a toast took from the middle: ⌘⇧Z still redoes the steps in the order they were made', () => {
    const history = new SheetUndoHistory()
    const first = matrixHistoryAfter(1), second = matrixHistoryAfter(2)
    history.record({ rowId: 'r1', colId: 'X.price', before: matrixHistoryBefore(cells()), after: first })
    history.undo(() => {}); history.redo(() => {})
    history.record({ rowId: 'r1', colId: 'Y.price', before: matrixHistoryBefore(cells()), after: second })
    expect(history.undoStep((c) => c.after === first, () => {})).toBe(1)
    expect(history.undo(() => {})).toBe(1)
    const redone: string[] = []
    const apply = (values: Array<{ colId: string }>) => { redone.push(...values.map((v) => v.colId)) }
    history.redo(apply); history.redo(apply)
    expect(redone).toEqual(['X.price', 'Y.price'])
    // And ⌘Z after that undoes the newest first.
    const undone: string[] = []
    history.undo((values) => { undone.push(...values.map((v) => v.colId)) })
    expect(undone).toEqual(['Y.price'])
  })
})

describe('Sells from (this product) is a ⌘Z step like any Matrix cell', () => {
  const src = (own: string[]) => ({ own, marketDefault: ['IT-MAIN'], defaultOrigin: 'routes' as const, effective: [], writable: true, blockedReason: null })
  it('its history column is the group\'s From column; undo puts the list back, redo sends it again', () => {
    expect(matrixHistoryColId('AMAZON:EU', 'source')).toBe('AMAZON:EU.from')
    expect(matrixHistoryPlace('AMAZON:EU.from')).toEqual({ key: 'AMAZON:EU', kind: 'source' })
    expect(matrixHistoryPlace('AMAZON:EU.price')).toEqual({ key: 'AMAZON:EU', kind: 'price' })
    expect(matrixHistoryPlace('AMAZON:EU.status')).toBeNull()
    const before = cells({ source: src([]) })
    const live = cells({ version: 4, source: src(['MI-3PL']) })
    expect(matrixReplay('source', matrixHistoryBefore(before, matrixHistoryAfter(['MI-3PL'])), live, place)).toEqual(write('source', [], 4))
    // Changed since (someone chose another list): it stays.
    expect(matrixReplay('source', matrixHistoryBefore(before, matrixHistoryAfter(['MI-3PL'])), cells({ version: 5, source: src(['IT-MAIN', 'MI-3PL']) }), place))
      .toEqual({ kind: 'refuse', reason: MATRIX_COPY.changedSince })
    expect(matrixReplay('source', matrixHistoryAfter(['MI-3PL']), cells({ version: 6, source: src([]) }), place)).toEqual(write('source', ['MI-3PL'], 6))
    expect(matrixReplay('source', matrixHistoryAfter(['MI-3PL']), live, place)).toEqual({ kind: 'skip' })
  })
  it('a refused Sells-from save leaves the history (its note matched on the From column)', () => {
    const after = matrixHistoryAfter(['MI-3PL'])
    const forgot: unknown[] = []
    const refused: MatrixWriteOutcome = { rowId: 'r1', coordinateKey: 'AMAZON:EU', cell: 'source', outcome: 'conflict', version: 5 }
    forgetUnsaved({ forget: (rowId, colId, a) => { forgot.push([rowId, colId, a]) } }, [{ rowId: 'r1', key: 'AMAZON:EU', colId: 'AMAZON:EU.from', after }], [refused])
    expect(forgot).toEqual([['r1', 'AMAZON:EU.from', after]])
  })
})

describe('one step, two doors: a toast\'s Undo and ⌘Z undo the SAME step (`undoStep`)', () => {
  const step = (after: unknown) => ({ rowId: 'r1', colId: 'AMAZON:IT.businessPrice', before: matrixHistoryBefore(cells()), after })
  it('the toast takes its step wherever it is; ⌘Z then finds the step before it — never the toast\'s change again', () => {
    const history = new SheetUndoHistory()
    const typed = matrixHistoryAfter(99)
    const popup = matrixHistoryAfter({ rule: 'PERCENT_OFF', percent: 5, price: null, tiers: null })
    history.record({ rowId: 'r1', colId: 'AMAZON:IT.price', before: matrixHistoryBefore(cells()), after: typed })
    history.undo(() => {}); history.redo(() => {}) // closes the first step
    history.record(step(popup))
    const seen: string[] = []
    const apply = (values: Array<{ colId: string }>) => { seen.push(...values.map((v) => v.colId)) }
    expect(history.undoStep((c) => c.after === popup, apply)).toBe(1)
    expect(seen).toEqual(['AMAZON:IT.businessPrice'])
    // The toast again, or ⌘Z for the same change: it is gone — ⌘Z undoes the typed price instead.
    expect(history.undoStep((c) => c.after === popup, apply)).toBe(0)
    expect(history.undo(apply)).toBe(1)
    expect(seen).toEqual(['AMAZON:IT.businessPrice', 'AMAZON:IT.price'])
    // ⌘⇧Z redoes the oldest undone step first: the typed price, made before the pop-up's save.
    expect(history.redo(apply)).toBe(1)
    expect(seen.at(-1)).toBe('AMAZON:IT.price')
  })
  it('⌘Z first: the toast\'s Undo then finds nothing to put back', () => {
    const history = new SheetUndoHistory()
    const popup = matrixHistoryAfter(null)
    history.record(step(popup))
    expect(history.undo(() => {})).toBe(1)
    expect(history.undoStep((c) => c.after === popup, () => {})).toBe(0)
  })
})

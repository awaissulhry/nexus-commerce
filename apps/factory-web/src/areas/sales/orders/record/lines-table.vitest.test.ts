import { describe, expect, it } from 'vitest'
import { canOf, LINE_BLK, LINE_RED, order } from '../_demo/fixtures'
import type { Order } from '../api'
import type { Freeze } from '../depth/api'
import { abilitiesOf } from '../model'
import { addLines, addSize, EMPTY_HISTORY, newLineKey, removeLine, setCell, setNewLine, setPrice, type NewLine } from './lines-draft'
import {
  cellId,
  cellLockOf,
  cellOfRow,
  chargesOf,
  closedFiguresOf,
  columnsOf,
  headOf,
  lineAmountOf,
  linesReaderOf,
  locksOfCard,
  mtmOf,
  natureKindOf,
  notesOf,
  offeredOf,
  orderTotalOf,
  ownDatesOf,
  patternOf,
  priceCellId,
  priceLockOf,
  styleCardsOf,
  taxBasisOf,
  totalsOf,
  type CardRow,
} from './lines-table'

/**
 * F-OL-01 (d) (Order LINES lane; 10-design-tab §1–§10): the table and the totals by reader — prices only with the price grain,
 * Ready by only when a line has its own date, one card per style with the draft's new rows, each cell's "was", "min" and lock, the
 * head, a closed line's figures, a made-to-measure unit, the charges and the totals in plain words. Every name and number is made up.
 */

const production = order('IN_PRODUCTION')
const confirmed = order('CONFIRMED')
const lineRow = (value: Order, id: string, removed = false): CardRow => ({ kind: 'line', key: id, line: value.lines.find((line) => line.id === id)!, removed, typeable: true })
const brown = (over: Partial<NewLine> = {}): NewLine => ({ key: newLineKey(production.lines[0]!.styleId, 'cw-brown'), styleId: production.lines[0]!.styleId, colourwayId: 'cw-brown', colour: 'BRN · Marrone', style: { code: 'DEMO-JKT-01', name: 'Giacca pelle demo' }, sizes: {}, price: '', description: '', note: '', ...over })

describe('F-OL-01 (d): columns by reader', () => {
  it('the Owner: Colour | sizes | + Size | Pieces | Unit price | Line total | Ready by (own dates) | ⋯', () => {
    const owner = linesReaderOf(canOf('owner'))
    expect(owner).toEqual({ writes: true, prices: true, salesHint: false, moves: true })
    expect(columnsOf(owner, ['50', '52'], true).map((column) => column.key)).toEqual(['colour', 'size', 'size', 'plus', 'pieces', 'unitPrice', 'lineTotal', 'readyBy', 'more'])
  })

  it('Sales: no money column anywhere and one line why; Finance reads prices, types nothing; Read-only: plain numbers, no ⋯', () => {
    const sales = linesReaderOf(canOf('sales'))
    expect(sales).toEqual({ writes: true, prices: false, salesHint: true, moves: true })
    expect(columnsOf(sales, ['50'], false).map((column) => column.key)).toEqual(['colour', 'size', 'plus', 'pieces', 'more'])
    expect(columnsOf(linesReaderOf(canOf('finance')), ['50'], false).map((column) => column.key)).toEqual(['colour', 'size', 'pieces', 'unitPrice', 'lineTotal', 'more'])
    expect(columnsOf(linesReaderOf(abilitiesOf(['orders.view'])), ['50'], false).map((column) => column.key)).toEqual(['colour', 'size', 'pieces'])
  })

  it('Ready by is a column only when a goods line has its own date (not the order\'s)', () => {
    expect(ownDatesOf(production)).toBe(true) // red promised 22 Dec, the order 15 Dec
    expect(ownDatesOf(confirmed)).toBe(false)
    expect(ownDatesOf({ ...production, lines: production.lines.map((line) => ({ ...line, promiseDate: production.promiseDate })) })).toBe(false)
  })
})

describe('F-OL-01 (d): one card per style, the draft\'s rows in it', () => {
  it('one card for the demo style with its two colours; a new colour at the end of its card; a removed one marked', () => {
    let history = addLines(EMPTY_HISTORY, production, [brown()])
    history = removeLine(history, production, LINE_RED)
    const [card] = styleCardsOf(production, history.draft)
    expect(card!.rows.map((row) => [row.key, row.kind, row.kind === 'line' ? row.removed : null])).toEqual([
      [LINE_BLK, 'line', false],
      [LINE_RED, 'line', true],
      [brown().key, 'new', null],
    ])
    expect(card!.sizes).toEqual(['48', '50', '52', '54'])
    expect(card!.leaves).toBe(false)
    expect(patternOf(card!.revision)).toEqual({ kind: 'approved', revision: 3 })
    expect(patternOf(null)).toEqual({ kind: 'none' })
  })

  it('"+ Size" adds a column in the style\'s range order when the style was read; every colour removed: the style leaves the order', () => {
    const styleId = production.lines[0]!.styleId
    const sized = addSize(EMPTY_HISTORY, styleId, '46')
    const style = { id: styleId, code: 'DEMO-JKT-01', name: 'x', season: null, sizes: ['46', '48', '50', '52', '54'], ppeClass: null, ppeCategory: 'NONE', mtmAllowed: false, status: 'ACTIVE', revisionState: 'RELEASED' as const, colourways: [], matrix: { sizes: ['46', '48', '50', '52', '54'].map((code) => ({ code, label: code })) } }
    expect(styleCardsOf(production, sized.draft, { [styleId]: style })[0]!.sizes).toEqual(['46', '48', '50', '52', '54'])
    const gone = removeLine(removeLine(EMPTY_HISTORY, production, LINE_BLK), production, LINE_RED)
    expect(styleCardsOf(production, gone.draft)[0]!.leaves).toBe(true)
  })
})

describe('F-OL-01 (d): a cell — its value, "was", "min" where cut or shipped binds, the company lock, offered', () => {
  const floors = { [LINE_BLK]: { '50': { cut: 2, shipped: 0 }, '52': { cut: 2, shipped: 1 } } }

  it('typed: the value and "was 2"; untouched: no mark; the floor only where cut or shipped binds', () => {
    const draft = setCell(EMPTY_HISTORY, production, LINE_BLK, '50', 3).draft
    const row = lineRow(production, LINE_BLK)
    expect(cellOfRow(row, '50', { draft, offered: null, floors })).toEqual({ offered: true, value: 3, was: 2, floor: { count: 2, by: 'cut' }, lock: null })
    expect(cellOfRow(row, '52', { draft, offered: null, floors })).toMatchObject({ value: 2, was: null, floor: { count: 2, by: 'cut' } })
    expect(cellOfRow(row, '54', { draft, offered: null, floors }).floor).toBeNull()
  })

  it('a size the colour does not hold: offered only when the style read says so (never guessed)', () => {
    const red = lineRow(production, LINE_RED)
    expect(cellOfRow(red, '48', { draft: EMPTY_HISTORY.draft, offered: null }).offered).toBe(false)
    expect(cellOfRow(red, '48', { draft: EMPTY_HISTORY.draft, offered: ['48', '50'] }).offered).toBe(true)
    const style = { colourways: [{ id: production.lines[1]!.colourwayId, offeredSizes: ['48'] }] } as never
    expect(offeredOf(red, style)).toEqual(['48', '50', '52', '54'])
    expect(offeredOf(red, null)).toBeNull()
  })

  it('a company lock on a size and on the price; the card\'s ONE lock line counts them', () => {
    const freeze = { lines: [{ lineId: LINE_BLK, seq: 10, stage: 'CUT', on: null, fields: [{ field: 'PRICE', state: 'CHANGE_REQUEST', frozenFrom: 'CUT' }], sizes: [{ size: '50', stage: 'CUT', on: null, locked: true, state: 'CHANGE_REQUEST' }, { size: '52', stage: 'FINISHED', on: null, locked: true, state: 'BLOCKED' }, { size: '54', stage: null, on: null, locked: false, state: 'OPEN' }] }] } as unknown as Freeze
    expect(cellLockOf(freeze, LINE_BLK, '50')).toEqual({ state: 'CHANGE_REQUEST', stage: 'CUT' })
    expect(cellLockOf(freeze, LINE_BLK, '52')).toEqual({ state: 'BLOCKED', stage: 'FINISHED' })
    expect(cellLockOf(freeze, LINE_BLK, '54')).toBeNull()
    expect(cellLockOf(null, LINE_BLK, '50')).toBeNull()
    expect(priceLockOf(freeze, LINE_BLK)).toEqual({ state: 'CHANGE_REQUEST', stage: 'CUT' })
    const [card] = styleCardsOf(production, EMPTY_HISTORY.draft)
    expect(locksOfCard(card!, freeze).map((entry) => entry.size)).toEqual(['50', '52'])
  })

  it('the doors land on a box by its id: a size box per row and size, a price box per row', () => {
    expect(cellId(LINE_BLK, '48')).toBe(`lines-cell-${LINE_BLK}-48`)
    expect(priceCellId(LINE_BLK)).toBe(`lines-price-${LINE_BLK}`)
  })
})

describe('F-OL-01 (d): a row\'s money (price readers), the head, closed lines, made to measure, notes', () => {
  it('the line total as the server priced it; with my cells or price the same arithmetic and "was"; a new row on the list price: unknown', () => {
    const row = lineRow(production, LINE_BLK)
    expect(lineAmountOf(row, EMPTY_HISTORY.draft)).toEqual({ now: 360000, was: null })
    const more = setCell(EMPTY_HISTORY, production, LINE_BLK, '50', 3).draft
    expect(lineAmountOf(row, more)).toEqual({ now: 405000, was: 360000 })
    const priced = setPrice(EMPTY_HISTORY, production, LINE_BLK, '460').draft
    expect(lineAmountOf(row, priced)).toEqual({ now: 368000, was: 360000 })
    const added = setNewLine(addLines(EMPTY_HISTORY, production, [brown()]), brown().key, { size: '50', pieces: 2 }).draft
    expect(lineAmountOf({ kind: 'new', key: brown().key, row: added.added[0]! }, added)).toEqual({ now: null, was: null })
  })

  it('the head: pieces to make (closed ones out) now and as saved, goods lines, charges', () => {
    expect(headOf(production, EMPTY_HISTORY.draft)).toEqual({ pieces: 14, piecesWas: null, lines: 2, charges: 0 })
    const more = setCell(EMPTY_HISTORY, production, LINE_BLK, '50', 4).draft
    expect(headOf(production, more)).toEqual({ pieces: 16, piecesWas: 14, lines: 2, charges: 0 })
    const fee: Order = { ...production, lines: [...production.lines, { ...production.lines[0]!, id: 'fee', seq: 90, kind: 'FEE', feeKind: 'DEVELOPMENT', netAmount: 48000, sizes: [], quantity: 1 }] }
    expect(headOf(fee, EMPTY_HISTORY.draft).charges).toBe(1)
    expect(chargesOf(fee)).toEqual([{ id: 'fee', kind: 'DEVELOPMENT', forStyle: 'DEMO-JKT-01', amount: 48000 }])
  })

  it('a closed line: "10 ordered · 9 to make · 1 cancelled"; a made-to-measure unit: "1 unit · base size 52"; notes and files', () => {
    expect(closedFiguresOf({ quantity: 10, closedShort: { quantity: 1, at: null, byId: null, reason: null, reasonCode: null } })).toEqual({ ordered: 10, make: 9, cancelled: 1 })
    expect(closedFiguresOf({ quantity: 10, closedShort: null })).toBeNull()
    expect(mtmOf({ kind: 'MADE_TO_MEASURE', baseSize: '52', quantity: 1 })).toEqual({ units: 1, baseSize: '52' })
    expect(mtmOf({ kind: 'SIZE_GRID', baseSize: null, quantity: 8 })).toBeNull()
    const noted: Order = { ...production, lines: production.lines.map((line) => (line.id === LINE_BLK ? { ...line, description: 'Logo sul petto', artwork: [{ fileId: 'f1', name: 'logo.pdf', contentType: 'application/pdf', sizeBytes: 10 }] } : line)) }
    expect(notesOf(lineRow(noted, LINE_BLK), EMPTY_HISTORY.draft)).toEqual({ notes: 1, files: 1, description: 'Logo sul petto', note: '' })
  })
})

describe('F-OL-01 (d): totals in plain words, by the order\'s own tax basis', () => {
  it('VAT on a net order: Subtotal · VAT 22 % · Total; my draft moves them by its estimate with "was"', () => {
    expect(taxBasisOf(production)).toEqual({ kind: 'vat', rate: '22.00' })
    const cards = styleCardsOf(production, EMPTY_HISTORY.draft)
    expect(totalsOf(production, EMPTY_HISTORY.draft, cards)).toEqual([
      { key: 'subtotal', amount: 624000, was: null },
      { key: 'vat', amount: 137280, was: null },
      { key: 'total', amount: 761280, was: null, grand: true },
    ])
    const more = setCell(EMPTY_HISTORY, production, LINE_BLK, '50', 3).draft
    const rows = totalsOf(production, more, styleCardsOf(production, more))
    expect(rows[0]).toEqual({ key: 'subtotal', amount: 669000, was: 624000 })
    expect(rows[1]).toEqual({ key: 'vat', amount: 147180, was: 137280 })
    expect(orderTotalOf(rows)).toEqual({ key: 'total', amount: 816180, was: 761280, grand: true })
  })

  it('no VAT on the sale: the code in words (export outside the EU), never "N3.1" on screen; a consumer\'s gross: Total · of which VAT', () => {
    const exportSale: Order = { ...production, vatAmount: 0, grossAmount: 624000, lines: production.lines.map((line) => ({ ...line, vatRatePct: '0.00', vatNature: 'N3.1' })) }
    expect(taxBasisOf(exportSale)).toEqual({ kind: 'vatNone', nature: 'N3.1' })
    expect(natureKindOf('N3.1')).toBe('export')
    expect(natureKindOf('N3.2')).toBe('intraEu')
    expect(natureKindOf('N2.2')).toBe('other')
    expect(totalsOf(exportSale, EMPTY_HISTORY.draft, styleCardsOf(exportSale, EMPTY_HISTORY.draft)).map((row) => row.key)).toEqual(['subtotal', 'vatNone', 'total'])
    const gross: Order = { ...production, priceBasis: 'GROSS' }
    expect(totalsOf(gross, EMPTY_HISTORY.draft, []).map((row) => row.key)).toEqual(['total', 'ofWhichVat'])
  })
})

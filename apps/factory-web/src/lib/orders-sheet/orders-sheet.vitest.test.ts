import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CONFIRMED_ASKED, DRAFT, IN_PRODUCTION, SENT_TEXT, SHEET_ORDERS } from './fixtures'
import {
  NEW_ROW_KEY,
  SHEET_KEYS,
  askOf,
  commitOf,
  dayOf,
  departmentNoOf,
  detailsOf,
  groupsOf,
  heldWhyOf,
  isPhoneRoom,
  mainActOf,
  mayType,
  parseTarget,
  piecesOf,
  sheetRowsOf,
  sideActOf,
  sumOf,
  targetOf,
  totalsOf,
  type SheetRow,
} from './rows'

const rowOf = (rows: readonly SheetRow[], key: string): SheetRow => {
  const row = rows.find((entry) => entry.key === key)
  if (!row) throw new Error(`no row ${key}`)
  return row
}

describe('owb-of3 step 1 — the rows of the ONE orders sheet', () => {
  it('draws each order (P) and right under it its lines (C), in the door’s order', () => {
    const rows = sheetRowsOf(SHEET_ORDERS, new Set(), false)
    expect(rows.map((row) => `${row.kind}:${row.key}`)).toEqual([
      'P:REQUEST:r1',
      'C:REQUEST:r1/L1',
      'C:REQUEST:r1/L2',
      'P:REQUEST:r2',
      'C:REQUEST:r2/L1',
      'P:ORDER:o1',
      'C:ORDER:o1/L1',
      'P:ORDER:o2',
      'C:ORDER:o2/L1',
      'C:ORDER:o2/L2',
    ])
  })

  it('a shut order shows no C rows (its P row stays)', () => {
    const rows = sheetRowsOf(SHEET_ORDERS, new Set([DRAFT.key, IN_PRODUCTION.key]), false)
    expect(rows.filter((row) => row.order?.key === DRAFT.key).map((row) => row.kind)).toEqual(['P'])
    expect(rows.filter((row) => row.order?.key === IN_PRODUCTION.key).map((row) => row.kind)).toEqual(['P'])
    expect(rows.filter((row) => row.order?.key === SENT_TEXT.key).map((row) => row.kind)).toEqual(['P', 'C'])
  })

  it('"New order" is the first row only when the door offers a new order', () => {
    expect(sheetRowsOf(SHEET_ORDERS, new Set(), true)[0]).toMatchObject({ key: NEW_ROW_KEY, kind: 'N' })
    expect(sheetRowsOf(SHEET_ORDERS, new Set(), false).some((row) => row.kind === 'N')).toBe(false)
  })
})

describe('owb-of3 step 1 — a cell a person may not type in takes nothing (L2)', () => {
  const rows = sheetRowsOf(SHEET_ORDERS, new Set(), true)

  it('a draft takes its subject, wanted day and its lines’ cells; never the customer, the promise or the news', () => {
    const p = rowOf(rows, DRAFT.key)
    const c = rowOf(rows, 'REQUEST:r1/L2')
    expect(mayType(p, 'what', 'office', true)).toBe(true)
    expect(mayType(p, 'wanted', 'office', true)).toBe(true)
    expect(mayType(p, 'customer', 'office', true)).toBe(false)
    expect(mayType(p, 'promised', 'office', true)).toBe(false)
    expect(mayType(p, 'news', 'office', true)).toBe(false)
    for (const column of ['what', 'material', 'sizes', 'pieces'] as const) expect(mayType(c, column, 'office', true)).toBe(true)
  })

  it('a Sent order reads only in the office and says "Confirm it first"', () => {
    const p = rowOf(rows, SENT_TEXT.key)
    const c = rowOf(rows, 'REQUEST:r2/L1')
    expect(mayType(p, 'what', 'office', true)).toBe(false)
    expect(mayType(c, 'pieces', 'office', true)).toBe(false)
    expect(heldWhyOf(c, 'pieces', 'office')).toBe('confirmFirst')
    expect(heldWhyOf(c, 'news', 'office')).toBeNull()
    expect(commitOf(c, 'pieces', '9', 'office', true)).toEqual({ kind: 'none' })
  })

  it('a confirmed order stages only a line’s sizes (Review and save); in production every cell reads only', () => {
    const c = rowOf(rows, 'ORDER:o1/L1')
    expect(mayType(c, 'sizes', 'office', true)).toBe(true)
    expect(mayType(c, 'pieces', 'office', true)).toBe(false)
    expect(mayType(c, 'material', 'office', true)).toBe(false)
    const later = rowOf(rows, 'ORDER:o2/L1')
    for (const column of ['what', 'material', 'sizes', 'pieces'] as const) expect(mayType(later, column, 'office', true)).toBe(false)
    expect(heldWhyOf(later, 'sizes', 'office')).toBe('readOnly')
    expect(commitOf(later, 'sizes', '48:1', 'office', true)).toEqual({ kind: 'none' })
  })

  it('a withdrawn order takes nothing; the totals row takes nothing', () => {
    const gone = sheetRowsOf([{ ...DRAFT, life: 'WITHDRAWN' }], new Set(), false)
    expect(gone.every((row) => !mayType(row, 'what', 'office', false))).toBe(true)
    expect(mayType({ key: 'totals', kind: 'T', order: null, line: null, index: -1 }, 'pieces', 'office', false)).toBe(false)
  })

  it('the "New order" row: the office types a subject only, and only when the door offers a new order', () => {
    const n = rowOf(rows, NEW_ROW_KEY)
    expect(mayType(n, 'what', 'office', true)).toBe(true)
    expect(mayType(n, 'pieces', 'office', true)).toBe(false)
    expect(mayType(n, 'pieces', 'portal', true)).toBe(true)
    expect(mayType(n, 'what', 'office', false)).toBe(false)
    expect(commitOf(n, 'what', '  Winter jackets ', 'office', true)).toEqual({ kind: 'new', seed: { column: 'what', value: 'Winter jackets' } })
    expect(commitOf(n, 'what', '   ', 'office', true)).toEqual({ kind: 'none' })
  })

  it('a typed value: pieces a whole number ≥ 1 (a sum may make it), a day in any of three forms; the same value again sends nothing', () => {
    const c = rowOf(rows, 'REQUEST:r1/L1')
    expect(commitOf(c, 'pieces', '=4+2', 'office', true)).toEqual({ kind: 'commit', commit: { orderKey: DRAFT.key, lineKey: 'REQUEST:r1/L1', column: 'pieces', value: '6' } })
    expect(commitOf(c, 'pieces', '0', 'office', true)).toEqual({ kind: 'refused', why: 'pieces' })
    expect(commitOf(c, 'pieces', '5', 'office', true)).toEqual({ kind: 'none' })
    const p = rowOf(rows, DRAFT.key)
    expect(commitOf(p, 'wanted', '3/1/2027', 'office', true)).toEqual({ kind: 'commit', commit: { orderKey: DRAFT.key, lineKey: null, column: 'wanted', value: '2027-01-03' } })
    expect(commitOf(p, 'wanted', '31/02/2027', 'office', true)).toEqual({ kind: 'refused', why: 'day' })
  })
})

describe('owb-of3 step 1 — sums, days, asks, totals, groups, doors', () => {
  it('a number cell takes a sum; anything else is not a number', () => {
    expect(sumOf('=500+20')).toBe(520)
    expect(sumOf('3*150')).toBe(450)
    expect(sumOf('(2+3)*4')).toBe(20)
    expect(sumOf('2+')).toBeNull()
    expect(sumOf('=B2*3')).toBeNull()
    expect(sumOf('1/0')).toBeNull()
    expect(piecesOf('2.5')).toBeNull()
    expect(piecesOf('=3*2')).toBe(6)
    expect(dayOf('2027-01-03')).toBe('2027-01-03')
    expect(dayOf('')).toBe('')
    expect(dayOf('tomorrow')).toBeNull()
  })

  it('the customer’s ask stands beside the official value of its column only', () => {
    const rows = sheetRowsOf([CONFIRMED_ASKED], new Set(), false)
    const c = rowOf(rows, 'ORDER:o1/L1')
    expect(askOf(c, 'pieces')).toMatchObject({ requestId: 'cr1', to: '7' })
    expect(askOf(c, 'sizes')).toBeNull()
    expect(askOf(rowOf(rows, CONFIRMED_ASKED.key), 'pieces')).toBeNull()
  })

  it('the totals: every order on screen, or the selected ones', () => {
    expect(totalsOf(SHEET_ORDERS, new Set())).toEqual({ orders: 4, lines: 6, pieces: 8 + 5 + 5 + 9, selected: false })
    expect(totalsOf(SHEET_ORDERS, new Set([IN_PRODUCTION.key]))).toEqual({ orders: 1, lines: 2, pieces: 9, selected: true })
  })

  it('the strip: neighbouring columns of one group are one band', () => {
    expect(groupsOf(['what', 'customer', 'wanted', 'promised', 'where', 'news', 'material', 'sizes', 'pieces', 'details', 'act']).map((band) => `${band.group}:${band.columns.length}`)).toEqual(['order:4', 'production:1', 'news:1', 'product:4', 'act:1'])
  })

  it('Details: two chips, then the rest counted', () => {
    const own = ['A', 'B', 'C', 'D'].map((name, index) => ({ columnId: `c${index}`, name, kind: 'TEXT' as const, value: `v${index}` }))
    const out = detailsOf([...own, { columnId: 'c9', name: 'Empty', kind: 'TEXT', value: null }])
    expect(out.shown.map((value) => value.name)).toEqual(['A', 'B'])
    expect(out.more.map((value) => value.name)).toEqual(['C', 'D'])
  })

  it('the act: Confirm on a draft or Sent row the office may confirm, else Open; the customer withdraws or asks to cancel', () => {
    expect(mainActOf(SENT_TEXT, 'office')).toEqual({ act: 'confirm', primary: true })
    expect(mainActOf({ ...SENT_TEXT, may: { ...SENT_TEXT.may, confirm: false } }, 'office')).toEqual({ act: 'open', primary: false })
    expect(mainActOf(IN_PRODUCTION, 'office')).toEqual({ act: 'open', primary: false })
    expect(sideActOf(DRAFT, 'office')).toBeNull()
    expect(sideActOf({ ...DRAFT, may: { ...DRAFT.may, withdraw: true } }, 'portal')).toBe('withdraw')
    expect(sideActOf({ ...CONFIRMED_ASKED, may: { ...CONFIRMED_ASKED.may, askCancel: true } }, 'portal')).toBe('askCancel')
  })

  it('a door’s target is the act and the order’s key (a key may hold a colon)', () => {
    expect(targetOf('picture', 'ORDER:o1')).toBe('picture:ORDER:o1')
    expect(parseTarget('picture:ORDER:o1')).toEqual({ act: 'picture', key: 'ORDER:o1' })
  })

  it('the office’s department of an order in production comes from its stage; none before or after', () => {
    expect(departmentNoOf(IN_PRODUCTION)).toBe(4)
    expect(departmentNoOf(CONFIRMED_ASKED)).toBeNull()
  })

  it('a phone room (under 640 px) draws cards, never the grid', () => {
    expect(isPhoneRoom(375)).toBe(true)
    expect(isPhoneRoom(639)).toBe(true)
    expect(isPhoneRoom(640)).toBe(false)
    expect(isPhoneRoom(0)).toBe(false)
  })
})

describe('owb-of3 step 1 — the keys live in ONE information icon', () => {
  it('the sheet names its keys once, in the footer’s ⓘ; no key hint anywhere else in the part', () => {
    const sheet = readFileSync(new URL('./view/OrdersSheet.tsx', import.meta.url), 'utf8')
    const cells = readFileSync(new URL('./view/SheetCells.tsx', import.meta.url), 'utf8')
    const cards = readFileSync(new URL('./view/SheetCards.tsx', import.meta.url), 'utf8')
    expect(sheet.match(/<ListKeysInfo\b/g)).toHaveLength(1)
    for (const source of [sheet, cells, cards]) expect(source).not.toMatch(/<Kbd\b/)
    expect(cells).not.toMatch(/ListKeysInfo/)
    expect(cards).not.toMatch(/ListKeysInfo/)
    expect(SHEET_KEYS.map((entry) => entry.id)).toEqual(['arrows', 'enter', 'tab', 'esc', 'select', 'range'])
  })

  it('every key of the ⓘ has its words in both languages', () => {
    for (const locale of ['en', 'it']) {
      const words = JSON.parse(readFileSync(new URL(`../../../messages/${locale}/orders-sheet.json`, import.meta.url), 'utf8')) as { part: { keys: Record<string, string> } }
      for (const entry of SHEET_KEYS) expect(typeof words.part.keys[entry.id]).toBe('string')
    }
  })
})

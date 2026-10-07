import { describe, expect, it } from 'vitest'
import { CASE_COPY } from '@nexus/shared/stock-cases'

import {
  availableOf, buildMatrixModel, buildSingleModel, casesOf, CASES_EDITOR_COPY, changesOf, countsCases, deltaOf, hasCaseColumns, onHandOf,
  pendingCellCount, refusedColumn, rowSyncStatus, rowTotalAvailable, sharedCaseSize, stockLevelOf, totalsOf, withCasesEdit, withEdit,
  type MatrixModel,
} from './inventoryEditor.logic'

const LOCS = [
  { id: 'fba', code: 'AMAZON-EU-FBA', name: 'Amazon FBA', type: 'AMAZON_FBA' },
  { id: 'it', code: 'IT-MAIN', name: 'Italy', type: 'WAREHOUSE' },
]
const model = (): MatrixModel => buildMatrixModel(LOCS, [
  { id: 'p1', sku: 'A-S', name: 'A small', thumbnailUrl: null, stockLevels: [{ locationId: 'it', locationCode: 'IT-MAIN', locationType: 'WAREHOUSE', quantity: 10, reserved: 2, available: 8, syncStatus: 'SYNCED' }] },
  { id: 'p2', sku: 'A-M', name: 'A medium', thumbnailUrl: null, stockLevels: [{ locationId: 'it', locationCode: 'IT-MAIN', locationType: 'WAREHOUSE', quantity: 3, reserved: 0, available: 3, syncStatus: 'FAILED' }, { locationId: 'fba', locationCode: 'AMAZON-EU-FBA', locationType: 'AMAZON_FBA', quantity: 7, reserved: 0, available: 7 }] },
])

describe('the model — one shape for a family and for a single product', () => {
  it('marks FBA and Shopify columns read-only and fills missing levels with zeros', () => {
    const m = model()
    expect(m.columns.map((c) => c.editable)).toEqual([false, true])
    expect(m.rows[0].cells.fba).toBeUndefined()
    expect(onHandOf(m.rows[0], 'fba', new Map())).toBe(0)
  })
  it('a single product is a one-row family with every active location present', () => {
    const m = buildSingleModel({ id: 'p9', sku: 'KNEE', name: 'Knee slider', thumbnailUrl: null, lowStockThreshold: 4 }, [{ location: LOCS[1], quantity: 20, reserved: 1, available: 19 }], LOCS)
    expect(m.rows).toHaveLength(1)
    expect(m.rows[0].lowStockThreshold).toBe(4)
    expect(availableOf(m.rows[0], 'it', new Map())).toBe(19)
    expect(availableOf(m.rows[0], 'fba', new Map())).toBe(0)
  })
})

describe('pending edits sit over the server numbers', () => {
  it('a typed value shows, moves Available live, and reports its delta', () => {
    const m = model()
    const p = withEdit(new Map(), m.rows[0], 'it', '15')
    expect(onHandOf(m.rows[0], 'it', p)).toBe(15)
    expect(availableOf(m.rows[0], 'it', p)).toBe(13)
    expect(deltaOf(m.rows[0], 'it', p)).toBe(5)
    expect(changesOf(p)).toEqual([{ productId: 'p1', locationId: 'it', value: 15 }])
  })
  it('typing the server value back clears the edit; invalid input is refused', () => {
    const m = model()
    let p = withEdit(new Map(), m.rows[0], 'it', 15)
    p = withEdit(p, m.rows[0], 'it', 10)
    expect(p.size).toBe(0)
    expect(withEdit(p, m.rows[0], 'it', -1).size).toBe(0)
    expect(withEdit(p, m.rows[0], 'it', 2.5).size).toBe(0)
    expect(withEdit(p, m.rows[0], 'it', 'abc').size).toBe(0)
  })
  it('available never goes below zero when on-hand is set under the reserved figure', () => {
    const m = model()
    const p = withEdit(new Map(), m.rows[0], 'it', 1)
    expect(availableOf(m.rows[0], 'it', p)).toBe(0)
  })
})

describe('totals and badges', () => {
  it('totals follow what the grid shows, pending included', () => {
    const m = model()
    const before = totalsOf(m, new Map())
    expect(before.cells.it).toEqual({ quantity: 13, reserved: 2, available: 11 })
    expect(before.totalAvailable).toBe(18)
    const p = withEdit(new Map(), m.rows[1], 'it', 13)
    expect(totalsOf(m, p).cells.it.quantity).toBe(23)
    expect(rowTotalAvailable(m.rows[1], m.columns, p)).toBe(20)
  })
  it('a row shows its worst sync state; a level with no state shows none', () => {
    const m = model()
    expect(rowSyncStatus(m.rows[0])).toBe('SYNCED')
    expect(rowSyncStatus(m.rows[1])).toBe('FAILED')
    expect(stockLevelOf(0, 10)).toBe('out'); expect(stockLevelOf(10, 10)).toBe('low'); expect(stockLevelOf(11, 10)).toBe('ok')
  })
})

// ── Step 3: cases — sealed + loose per warehouse ──────────────────────────────────────────────
const it_ = (quantity: number, cases?: number) => ({ locationId: 'it', locationCode: 'IT-MAIN', locationType: 'WAREHOUSE', quantity, reserved: 0, available: quantity, ...(cases === undefined ? {} : { cases }) })
/** p1: 12 / case, 4 sealed + 3 loose (51). p2: no case size. */
const cased = (): MatrixModel => buildMatrixModel(LOCS, [
  { id: 'p1', sku: 'A-S', name: 'A small', thumbnailUrl: null, unitsPerCase: 12, stockLevels: [it_(51, 4), { locationId: 'fba', locationCode: 'AMAZON-EU-FBA', locationType: 'AMAZON_FBA', quantity: 7, reserved: 0, available: 7 }] },
  { id: 'p2', sku: 'A-M', name: 'A medium', thumbnailUrl: null, unitsPerCase: null, stockLevels: [it_(9)] },
])
const none = new Map<string, number>()

describe('cases — the model carries the case size and the sealed count', () => {
  it('a family row and a single product both carry units per case and each level its sealed cases', () => {
    const m = cased()
    expect(m.rows[0].unitsPerCase).toBe(12)
    expect(m.rows[0].cells.it.cases).toBe(4)
    expect(m.rows[1].unitsPerCase).toBeNull()
    const single = buildSingleModel({ id: 'p9', sku: 'K', name: 'K', thumbnailUrl: null, unitsPerCase: 6 }, [{ location: LOCS[1], quantity: 13, reserved: 0, available: 13, cases: 2 }], LOCS)
    expect(single.rows[0].unitsPerCase).toBe(6)
    expect(casesOf(single.rows[0], 'it', none, none)).toMatchObject({ sealed: 2, loose: 1 })
  })
  it('the Cases column shows only at a warehouse and only when some row has a case size', () => {
    expect(hasCaseColumns(cased())).toBe(true)
    expect(hasCaseColumns(model())).toBe(false)
    expect(cased().columns.map(countsCases)).toEqual([false, true])
    expect(countsCases({ locationType: 'SHOPIFY_LOCATION' })).toBe(false)
    expect(sharedCaseSize(cased())).toBe(12)
  })
  it('a missing or invalid case size is no case size; a stored count above the units reads clamped', () => {
    const m = buildMatrixModel(LOCS, [
      { id: 'a', sku: 'A', name: 'A', thumbnailUrl: null, unitsPerCase: 0, stockLevels: [it_(10, 1)] },
      { id: 'b', sku: 'B', name: 'B', thumbnailUrl: null, unitsPerCase: 12, stockLevels: [it_(30, 9)] },
    ])
    expect(m.rows[0].unitsPerCase).toBeNull()
    expect(casesOf(m.rows[0], 'it', none, none)).toMatchObject({ size: null, loose: null })
    expect(casesOf(m.rows[1], 'it', none, none)).toMatchObject({ sealed: 2, loose: 6, delta: 0 })
  })
})

describe('cases — the cell shows "4 + 3" and previews a pending On hand (loose first, then a case opens)', () => {
  it('server numbers: 4 sealed + 3 loose', () => {
    const v = casesOf(cased().rows[0], 'it', none, none)
    expect(v).toEqual({ size: 12, sealed: 4, loose: 3, delta: 0, typed: false, opens: 0, problem: null })
    expect(CASE_COPY.split(v.sealed, v.loose!)).toBe('4 + 3')
  })
  it('lowering On hand takes the loose units first, then shows the case that opens', () => {
    const m = cased()
    expect(casesOf(m.rows[0], 'it', withEdit(none, m.rows[0], 'it', 48), none)).toMatchObject({ sealed: 4, loose: 0, delta: 0, opens: 0 })
    const v = casesOf(m.rows[0], 'it', withEdit(none, m.rows[0], 'it', 47), none)
    expect(v).toMatchObject({ sealed: 3, loose: 11, delta: -1, opens: 1, typed: false, problem: null })
    expect(CASES_EDITOR_COPY.opens(v.opens)).toBe('1 sealed case opens')
    expect(casesOf(m.rows[0], 'it', withEdit(none, m.rows[0], 'it', 0), none)).toMatchObject({ sealed: 0, loose: 0, opens: 4 })
  })
  it('raising On hand never touches the sealed count: the units arrive loose', () => {
    const m = cased()
    expect(casesOf(m.rows[0], 'it', withEdit(none, m.rows[0], 'it', 80), none)).toMatchObject({ sealed: 4, loose: 32, delta: 0 })
  })
})

describe('cases — a typed sealed count', () => {
  it('shows as typed with its loose units and chip; typing the shown value back leaves nothing to apply', () => {
    const m = cased()
    let c = withCasesEdit(none, m.rows[0], 'it', '2', none)
    expect(casesOf(m.rows[0], 'it', none, c)).toMatchObject({ sealed: 2, loose: 27, delta: -2, typed: true, problem: null })
    c = withCasesEdit(c, m.rows[0], 'it', 4, none)
    expect(c.size).toBe(0)
  })
  it('a count equal to the preview of a pending On hand is not a change (an undo restores the preview)', () => {
    const m = cased()
    const p = withEdit(none, m.rows[0], 'it', 47)
    let c = withCasesEdit(none, m.rows[0], 'it', 2, p)
    expect(c.size).toBe(1)
    c = withCasesEdit(c, m.rows[0], 'it', 3, p)
    expect(c.size).toBe(0)
  })
  it('refuses what is not a whole number ≥ 0, and any count on a row without a case size', () => {
    const m = cased()
    for (const bad of [-1, 1.5, 'abc', Number.NaN]) expect(withCasesEdit(none, m.rows[0], 'it', bad, none).size).toBe(0)
    expect(withCasesEdit(none, m.rows[1], 'it', 1, none).size).toBe(0)
  })
  it('a count the units cannot hold is kept, red, with the reason; enough units clear it; fewer units bring it back', () => {
    const m = cased()
    const c = withCasesEdit(none, m.rows[0], 'it', 5, none)
    expect(casesOf(m.rows[0], 'it', none, c)).toMatchObject({ sealed: 5, loose: null, typed: true, problem: CASE_COPY.exceeds(5, 12, 51) })
    expect(casesOf(m.rows[0], 'it', withEdit(none, m.rows[0], 'it', 60), c)).toMatchObject({ sealed: 5, loose: 0, problem: null })
    const four = withCasesEdit(none, m.rows[0], 'it', 3, none)
    expect(casesOf(m.rows[0], 'it', withEdit(none, m.rows[0], 'it', 30), four).problem).toBe(CASE_COPY.exceeds(3, 12, 30))
  })
  it('0 always fits', () => {
    const m = cased()
    expect(casesOf(m.rows[0], 'it', withEdit(none, m.rows[0], 'it', 0), withCasesEdit(none, m.rows[0], 'it', 0, none))).toMatchObject({ sealed: 0, loose: 0, problem: null })
  })
})

describe('cases — one change per cell, refusals on the right cell', () => {
  it('units and cases of one cell travel together; a case-only count has no value; Apply counts cells', () => {
    const m = cased()
    const p = withEdit(none, m.rows[1], 'it', 12)
    let c = withCasesEdit(none, m.rows[0], 'it', 3, p)
    expect(changesOf(p, c)).toEqual([{ productId: 'p2', locationId: 'it', value: 12 }, { productId: 'p1', locationId: 'it', cases: 3 }])
    expect(pendingCellCount(p, c)).toBe(2)
    const both = withEdit(p, m.rows[0], 'it', 60)
    c = withCasesEdit(none, m.rows[0], 'it', 5, both)
    expect(changesOf(both, c)).toEqual([{ productId: 'p2', locationId: 'it', value: 12 }, { productId: 'p1', locationId: 'it', value: 60, cases: 5 }])
    expect(pendingCellCount(both, c)).toBe(2)
  })
  it('a refusal turns red the cell it concerns', () => {
    expect(refusedColumn({ productId: 'p', locationId: 'l', cases: 3 }, 'NO_LOCATION')).toBe('cases')
    expect(refusedColumn({ productId: 'p', locationId: 'l', value: 3 }, 'CASES_EXCEED_UNITS')).toBe('onhand')
    expect(refusedColumn({ productId: 'p', locationId: 'l', value: 3, cases: 9 }, 'CASES_EXCEED_UNITS')).toBe('cases')
    expect(refusedColumn({ productId: 'p', locationId: 'l', value: 3, cases: 9 }, 'INVALID_VALUE')).toBe('onhand')
  })
})

describe('cases — the totals row: Σ sealed + Σ loose ("12 + 9")', () => {
  const family = () => buildMatrixModel(LOCS, [
    { id: 'v1', sku: 'V1', name: 'V1', thumbnailUrl: null, unitsPerCase: 12, stockLevels: [it_(51, 4)] },
    { id: 'v2', sku: 'V2', name: 'V2', thumbnailUrl: null, unitsPerCase: 12, stockLevels: [it_(50, 4)] },
    { id: 'v3', sku: 'V3', name: 'V3', thumbnailUrl: null, unitsPerCase: 12, stockLevels: [it_(52, 4)] },
    { id: 'v4', sku: 'V4', name: 'V4', thumbnailUrl: null, unitsPerCase: null, stockLevels: [it_(100)] },
  ])
  it('adds the rows with a case size only; FBA has none', () => {
    const t = totalsOf(family(), none)
    expect(t.cases.it).toEqual({ sealed: 12, loose: 9 })
    expect(CASE_COPY.split(t.cases.it!.sealed, t.cases.it!.loose)).toBe('12 + 9')
    expect(t.cases.fba).toBeNull()
    expect(totalsOf(model(), none).cases.it).toBeNull()
  })
  it('follows the pending numbers: the preview, and a typed count — never more cases than the units hold', () => {
    const m = family()
    const p = withEdit(none, m.rows[0], 'it', 47)
    expect(totalsOf(m, p).cases.it).toEqual({ sealed: 11, loose: 17 })
    const c = withCasesEdit(none, m.rows[1], 'it', 9, none)
    expect(totalsOf(m, none, c).cases.it).toEqual({ sealed: 12, loose: 9 })
  })
})

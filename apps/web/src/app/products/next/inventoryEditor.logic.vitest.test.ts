import { describe, expect, it } from 'vitest'
import { CASE_COPY } from '@nexus/shared/stock-cases'

import {
  availableOf, buildMatrixModel, buildSingleModel, casesKey, casesOf, CASES_EDITOR_COPY, changesOf, countsCases, deltaOf, familyCaseSizes, hasCaseColumns,
  keepCasesOf, onHandOf, pendingCellCount, refusedColumn, rowSyncStatus, rowTotalAvailable, stockLevelOf, totalsOf, withCasesEdit, withEdit,
  type MatrixModel,
} from './inventoryEditor.logic'
import { concernsEditor } from './useInventoryEditor'

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

// ── Step 3: cases — sealed per size + loose per warehouse ───────────────────────────────────
const c = (unitsPerCase: number, cases: number) => ({ unitsPerCase, cases })
const it_ = (quantity: number, cases?: Array<{ unitsPerCase: number; cases: number }>) => ({ locationId: 'it', locationCode: 'IT-MAIN', locationType: 'WAREHOUSE', quantity, reserved: 0, available: quantity, ...(cases === undefined ? {} : { cases }) })
/** p1: 12 / case, 4 sealed + 3 loose (51). p2: no case size. */
const cased = (): MatrixModel => buildMatrixModel(LOCS, [
  { id: 'p1', sku: 'A-S', name: 'A small', thumbnailUrl: null, caseSizes: [12], stockLevels: [it_(51, [c(12, 4)]), { locationId: 'fba', locationCode: 'AMAZON-EU-FBA', locationType: 'AMAZON_FBA', quantity: 7, reserved: 0, available: 7 }] },
  { id: 'p2', sku: 'A-M', name: 'A medium', thumbnailUrl: null, caseSizes: [], stockLevels: [it_(9)] },
])
/** q1: 12 / case and 6 / case — 2×12 + 1×6 + 3 loose (33). q2: 12 / case only, 1 + 5 (17). */
const twoSizes = (): MatrixModel => buildMatrixModel(LOCS, [
  { id: 'q1', sku: 'B-S', name: 'B small', thumbnailUrl: null, caseSizes: [6, 12], stockLevels: [it_(33, [c(12, 2), c(6, 1)])] },
  { id: 'q2', sku: 'B-M', name: 'B medium', thumbnailUrl: null, caseSizes: [12], stockLevels: [it_(17, [c(12, 1)])] },
])
const none = new Map<string, number>()

describe('cases — the model carries the case sizes and the sealed counts', () => {
  it('a family row and a single product both carry their case sizes (biggest first) and each level its sealed cases', () => {
    const m = cased()
    expect(m.rows[0].caseSizes).toEqual([12])
    expect(m.rows[0].cells.it.cases).toEqual([c(12, 4)])
    expect(m.rows[1].caseSizes).toEqual([])
    expect(twoSizes().rows[0].caseSizes).toEqual([12, 6])
    const single = buildSingleModel({ id: 'p9', sku: 'K', name: 'K', thumbnailUrl: null, caseSizes: [6] }, [{ location: LOCS[1], quantity: 13, reserved: 0, available: 13, cases: [c(6, 2)] }], LOCS)
    expect(single.rows[0].caseSizes).toEqual([6])
    expect(casesOf(single.rows[0], 'it', 6, none, none)).toMatchObject({ sealed: 2, loose: 1 })
  })
  it('the Cases columns show only at a warehouse and only when some row has a case size; one per family size', () => {
    expect(hasCaseColumns(cased())).toBe(true)
    expect(hasCaseColumns(model())).toBe(false)
    expect(cased().columns.map(countsCases)).toEqual([false, true])
    expect(countsCases({ locationType: 'SHOPIFY_LOCATION' })).toBe(false)
    expect(familyCaseSizes(cased())).toEqual([12])
    expect(familyCaseSizes(twoSizes())).toEqual([12, 6])
  })
  it('a broken case size is dropped; a stored count above the units reads clamped; an unknown size reads as none', () => {
    const m = buildMatrixModel(LOCS, [
      { id: 'a', sku: 'A', name: 'A', thumbnailUrl: null, caseSizes: [0, 2.5], stockLevels: [it_(10, [c(0, 1)])] },
      { id: 'b', sku: 'B', name: 'B', thumbnailUrl: null, caseSizes: [12], stockLevels: [it_(30, [c(12, 9), c(5, 2)])] },
    ])
    expect(m.rows[0].caseSizes).toEqual([])
    expect(casesOf(m.rows[0], 'it', 12, none, none)).toMatchObject({ size: null, loose: null })
    expect(casesOf(m.rows[1], 'it', 12, none, none)).toMatchObject({ sealed: 2, loose: 6, delta: 0 })
  })
})

describe('cases — one size: the cell shows "4 + 3" and previews a pending On hand (loose first, then a case opens)', () => {
  it('server numbers: 4 sealed + 3 loose', () => {
    const v = casesOf(cased().rows[0], 'it', 12, none, none)
    expect(v).toEqual({ size: 12, sealed: 4, loose: 3, delta: 0, typed: false, opens: 0, problem: null })
    expect(CASE_COPY.split([c(12, v.sealed)], v.loose!)).toBe('4 + 3')
  })
  it('lowering On hand takes the loose units first, then shows the case that opens', () => {
    const m = cased()
    expect(casesOf(m.rows[0], 'it', 12, withEdit(none, m.rows[0], 'it', 48), none)).toMatchObject({ sealed: 4, loose: 0, delta: 0, opens: 0 })
    const v = casesOf(m.rows[0], 'it', 12, withEdit(none, m.rows[0], 'it', 47), none)
    expect(v).toMatchObject({ sealed: 3, loose: 11, delta: -1, opens: 1, typed: false, problem: null })
    expect(CASES_EDITOR_COPY.opens(v.opens)).toBe('1 sealed case opens')
    expect(casesOf(m.rows[0], 'it', 12, withEdit(none, m.rows[0], 'it', 0), none)).toMatchObject({ sealed: 0, loose: 0, opens: 4 })
  })
  it('raising On hand never touches the sealed count: the units arrive loose', () => {
    const m = cased()
    expect(casesOf(m.rows[0], 'it', 12, withEdit(none, m.rows[0], 'it', 80), none)).toMatchObject({ sealed: 4, loose: 32, delta: 0 })
  })
})

describe('cases — several sizes: one column per size, the loose units after the smallest', () => {
  it('each size shows its own count; only the row\'s smallest own size carries the loose units', () => {
    const m = twoSizes()
    expect(casesOf(m.rows[0], 'it', 12, none, none)).toMatchObject({ size: 12, sealed: 2, loose: null })
    expect(casesOf(m.rows[0], 'it', 6, none, none)).toMatchObject({ size: 6, sealed: 1, loose: 3 })
    // q2 has no 6 / case: that cell has nothing to edit; its loose units sit in its 12 column.
    expect(casesOf(m.rows[1], 'it', 6, none, none)).toMatchObject({ size: null })
    expect(casesOf(m.rows[1], 'it', 12, none, none)).toMatchObject({ sealed: 1, loose: 5 })
  })
  it('a lower On hand opens the smallest case first', () => {
    const m = twoSizes()
    const p = withEdit(none, m.rows[0], 'it', 29)
    expect(casesOf(m.rows[0], 'it', 12, p, none)).toMatchObject({ sealed: 2, delta: 0, opens: 0 })
    expect(casesOf(m.rows[0], 'it', 6, p, none)).toMatchObject({ sealed: 0, loose: 5, delta: -1, opens: 1 })
  })
  it('a typed count is checked with the whole level: the other sizes keep theirs', () => {
    const m = twoSizes()
    // 2×12 + 2×6 = 36 > 33: the typed 6 / case cell is refused; the 12 cell is not typed and not red.
    const k = withCasesEdit(none, m.rows[0], 'it', 6, 2, none)
    expect(casesOf(m.rows[0], 'it', 6, none, k)).toMatchObject({ sealed: 2, typed: true, loose: null, problem: CASE_COPY.exceeds([c(12, 2), c(6, 2)], 33) })
    expect(casesOf(m.rows[0], 'it', 12, none, k)).toMatchObject({ sealed: 2, typed: false, problem: null })
    // One 12 case less makes room: both typed, both fine.
    const k2 = withCasesEdit(k, m.rows[0], 'it', 12, 1, none)
    expect(casesOf(m.rows[0], 'it', 6, none, k2)).toMatchObject({ sealed: 2, loose: 9, problem: null })
    expect(changesOf(none, k2)).toEqual([{ productId: 'q1', locationId: 'it', cases: [c(12, 1), c(6, 2)] }])
    expect(pendingCellCount(none, k2)).toBe(1)
  })
  it('a size the row does not have refuses a typed count', () => {
    const m = twoSizes()
    expect(withCasesEdit(none, m.rows[1], 'it', 6, 1, none).size).toBe(0)
  })
  it('the totals add each size and the loose units; the header names each size', () => {
    const m = twoSizes()
    expect(totalsOf(m, none).cases.it).toEqual({ sealed: [c(12, 3), c(6, 1)], loose: 8 })
    expect(CASES_EDITOR_COPY.header([12, 6], 6)).toBe('6 / case')
    expect(CASES_EDITOR_COPY.header([12], 12)).toBe('Cases')
    expect(CASES_EDITOR_COPY.headerTooltip([12])).toBe('Sealed cases + loose units (12 / case). A sale takes loose units first, then opens the smallest case.')
    expect(CASES_EDITOR_COPY.headerTooltip([12, 6])).toBe('Sealed cases + loose units. A sale takes loose units first, then opens the smallest case.')
  })
})

describe('cases — a typed sealed count', () => {
  it('shows as typed with its loose units and chip; typing the shown value back leaves nothing to apply', () => {
    const m = cased()
    let k = withCasesEdit(none, m.rows[0], 'it', 12, '2', none)
    expect(casesOf(m.rows[0], 'it', 12, none, k)).toMatchObject({ sealed: 2, loose: 27, delta: -2, typed: true, problem: null })
    k = withCasesEdit(k, m.rows[0], 'it', 12, 4, none)
    expect(k.size).toBe(0)
  })
  it('a count equal to the preview of a pending On hand is not a change (an undo restores the preview)', () => {
    const m = cased()
    const p = withEdit(none, m.rows[0], 'it', 47)
    let k = withCasesEdit(none, m.rows[0], 'it', 12, 2, p)
    expect(k.size).toBe(1)
    k = withCasesEdit(k, m.rows[0], 'it', 12, 3, p)
    expect(k.size).toBe(0)
  })
  it('refuses what is not a whole number ≥ 0, and any count on a row without a case size', () => {
    const m = cased()
    for (const bad of [-1, 1.5, 'abc', Number.NaN]) expect(withCasesEdit(none, m.rows[0], 'it', 12, bad, none).size).toBe(0)
    expect(withCasesEdit(none, m.rows[1], 'it', 12, 1, none).size).toBe(0)
  })
  it('a count the units cannot hold is kept, red, with the reason; enough units clear it; fewer units bring it back', () => {
    const m = cased()
    const k = withCasesEdit(none, m.rows[0], 'it', 12, 5, none)
    expect(casesOf(m.rows[0], 'it', 12, none, k)).toMatchObject({ sealed: 5, loose: null, typed: true, problem: CASE_COPY.exceeds([c(12, 5)], 51) })
    expect(casesOf(m.rows[0], 'it', 12, withEdit(none, m.rows[0], 'it', 60), k)).toMatchObject({ sealed: 5, loose: 0, problem: null })
    const three = withCasesEdit(none, m.rows[0], 'it', 12, 3, none)
    expect(casesOf(m.rows[0], 'it', 12, withEdit(none, m.rows[0], 'it', 30), three).problem).toBe(CASE_COPY.exceeds([c(12, 3)], 30))
  })
  it('0 always fits', () => {
    const m = cased()
    expect(casesOf(m.rows[0], 'it', 12, withEdit(none, m.rows[0], 'it', 0), withCasesEdit(none, m.rows[0], 'it', 12, 0, none))).toMatchObject({ sealed: 0, loose: 0, problem: null })
  })
})

describe('cases — one change per cell, refusals on the right cell', () => {
  it('units and cases of one cell travel together; a case-only count has no value; Apply counts cells', () => {
    const m = cased()
    const p = withEdit(none, m.rows[1], 'it', 12)
    let k = withCasesEdit(none, m.rows[0], 'it', 12, 3, p)
    expect(changesOf(p, k)).toEqual([{ productId: 'p2', locationId: 'it', value: 12 }, { productId: 'p1', locationId: 'it', cases: [c(12, 3)] }])
    expect(pendingCellCount(p, k)).toBe(2)
    const both = withEdit(p, m.rows[0], 'it', 60)
    k = withCasesEdit(none, m.rows[0], 'it', 12, 5, both)
    expect(changesOf(both, k)).toEqual([{ productId: 'p2', locationId: 'it', value: 12 }, { productId: 'p1', locationId: 'it', value: 60, cases: [c(12, 5)] }])
    expect(pendingCellCount(both, k)).toBe(2)
  })
  it('after an Apply only the refused cells keep their typed counts', () => {
    const m = twoSizes()
    let k = withCasesEdit(none, m.rows[0], 'it', 12, 1, none)
    k = withCasesEdit(k, m.rows[0], 'it', 6, 2, none)
    k = withCasesEdit(k, m.rows[1], 'it', 12, 0, none)
    expect([...keepCasesOf(k, new Set(['q1:it'])).keys()].sort()).toEqual([casesKey('q1', 'it', 12), casesKey('q1', 'it', 6)].sort())
    expect(keepCasesOf(k, new Set()).size).toBe(0)
  })
  it('a refusal turns red the cell it concerns', () => {
    expect(refusedColumn({ productId: 'p', locationId: 'l', cases: [c(12, 3)] }, 'NO_LOCATION')).toBe('cases')
    expect(refusedColumn({ productId: 'p', locationId: 'l', value: 3 }, 'CASES_EXCEED_UNITS')).toBe('onhand')
    expect(refusedColumn({ productId: 'p', locationId: 'l', value: 3, cases: [c(12, 9)] }, 'CASES_EXCEED_UNITS')).toBe('cases')
    expect(refusedColumn({ productId: 'p', locationId: 'l', value: 3, cases: [c(12, 9)] }, 'INVALID_VALUE')).toBe('onhand')
  })
})

describe('cases — the totals row: Σ sealed + Σ loose ("12 + 9")', () => {
  const family = () => buildMatrixModel(LOCS, [
    { id: 'v1', sku: 'V1', name: 'V1', thumbnailUrl: null, caseSizes: [12], stockLevels: [it_(51, [c(12, 4)])] },
    { id: 'v2', sku: 'V2', name: 'V2', thumbnailUrl: null, caseSizes: [12], stockLevels: [it_(50, [c(12, 4)])] },
    { id: 'v3', sku: 'V3', name: 'V3', thumbnailUrl: null, caseSizes: [12], stockLevels: [it_(52, [c(12, 4)])] },
    { id: 'v4', sku: 'V4', name: 'V4', thumbnailUrl: null, caseSizes: [], stockLevels: [it_(100)] },
  ])
  it('adds the rows with a case size only; FBA has none', () => {
    const t = totalsOf(family(), none)
    expect(t.cases.it).toEqual({ sealed: [c(12, 12)], loose: 9 })
    expect(CASE_COPY.split(t.cases.it!.sealed, t.cases.it!.loose)).toBe('12 + 9')
    expect(t.cases.fba).toBeNull()
    expect(totalsOf(model(), none).cases.it).toBeNull()
  })
  it('follows the pending numbers: the preview, and a typed count — never more cases than the units hold', () => {
    const m = family()
    const p = withEdit(none, m.rows[0], 'it', 47)
    expect(totalsOf(m, p).cases.it).toEqual({ sealed: [c(12, 11)], loose: 17 })
    const k = withCasesEdit(none, m.rows[1], 'it', 12, 9, none)
    expect(totalsOf(m, none, k).cases.it).toEqual({ sealed: [c(12, 12)], loose: 9 })
  })
})

describe('live: which stock events re-read the editor', () => {
  const ids = new Set(['p1', 'p2'])
  it('a stock or case change of a shown product, from elsewhere', () => {
    expect(concernsEditor({ type: 'inventory.stock_changed', id: 'p1', meta: { source: 'sse', subtype: 'cases' } }, ids)).toBe(true)
    expect(concernsEditor({ type: 'stock.adjusted', meta: { productId: 'p2', source: 'matrix' } }, ids)).toBe(true)
  })
  it('not its own Apply, not another product, not an FBA plan, not an event with no product', () => {
    expect(concernsEditor({ type: 'stock.adjusted', meta: { productId: 'p1', source: 'products-next-inventory-editor' } }, ids)).toBe(false)
    expect(concernsEditor({ type: 'inventory.stock_changed', id: 'zz' }, ids)).toBe(false)
    expect(concernsEditor({ type: 'inventory.stock_changed', id: 'p1', meta: { subtype: 'fba-plan' } }, ids)).toBe(false)
    expect(concernsEditor({ type: 'stock.adjusted' }, ids)).toBe(false)
  })
})

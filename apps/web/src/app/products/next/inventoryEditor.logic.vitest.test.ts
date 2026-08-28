import { describe, expect, it } from 'vitest'

import {
  availableOf, buildMatrixModel, buildSingleModel, changesOf, deltaOf, onHandOf, rowSyncStatus, rowTotalAvailable, stockLevelOf, totalsOf, withEdit,
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

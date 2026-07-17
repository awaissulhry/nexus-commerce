/**
 * EI.3 — policies, destructive gate, cell plan tests.
 * Run: npx vitest run apps/web/src/app/products/ebay-flat-file/importPlan.vitest.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  filterRowsByPolicies,
  findDestructiveActionRows,
  applyDestructiveGate,
  planImportCells,
  pruneExcludedCells,
} from './importPlan.pure'

describe('filterRowsByPolicies', () => {
  const row = {
    sku: 'A', parentage: 'child', parent_sku: 'P', shared_sku_listing: true,
    it_price: 105, it_qty: 7, it_buffer: 2, title: 'T', description: 'D',
    image_url_1: 'http://x/1.jpg', fulfillment_policy_id: 'pol-1', vat_percent: '22',
    it_item_id: '111', aspect_Colore: 'Nero', _rowId: 'r1',
  }
  it('OFF toggles strip their columns; identity/structure/aspects survive', () => {
    const out = filterRowsByPolicies([row], new Set(['prices', 'quantities', 'images', 'policies']))
    expect(out[0]).toEqual({
      sku: 'A', parentage: 'child', parent_sku: 'P', shared_sku_listing: true,
      title: 'T', description: 'D', it_item_id: '111', aspect_Colore: 'Nero', _rowId: 'r1',
    })
  })
  it('content OFF strips title/description but keeps prices', () => {
    const out = filterRowsByPolicies([row], new Set(['content']))
    expect(out[0].title).toBeUndefined()
    expect(out[0].it_price).toBe(105)
  })
  it('no toggles → rows pass through by reference', () => {
    const rows = [row]
    expect(filterRowsByPolicies(rows, new Set())).toBe(rows)
  })
})

describe('destructive action gate', () => {
  const rows = [
    { sku: 'A', row_action: '' },
    { sku: 'B', row_action: 'end' },
    { sku: 'C', row_action: 'deactivate' },
    { sku: 'D', row_action: 'skip' },
  ]
  it('finds end/deactivate rows only (skip is harmless)', () => {
    const s = findDestructiveActionRows(rows)
    expect(s.destructiveIndexes).toEqual([1, 2])
    expect(s.byAction).toEqual({ end: 1, deactivate: 1 })
  })
  it('drops them unless armed', () => {
    const s = findDestructiveActionRows(rows)
    expect(applyDestructiveGate(rows, s, false).map((r) => r.sku)).toEqual(['A', 'D'])
    expect(applyDestructiveGate(rows, s, true)).toHaveLength(4)
  })
})

describe('planImportCells', () => {
  const existing = [
    { sku: 'A', title: 'Old title', it_price: '100', shared_sku_listing: false },
    { sku: 'B', title: '', it_price: '' },
  ]
  it('fill-missing: only empty cells apply; structural shared flag always applies', () => {
    const plan = planImportCells(
      [
        { sku: 'A', title: 'New title', it_price: '105', shared_sku_listing: true },
        { sku: 'B', title: 'B title' },
      ],
      existing,
      'fill-missing',
    )
    const bySig = Object.fromEntries(plan.changes.map((c) => [`${c.sku}|${c.columnId}`, c.willApply]))
    expect(bySig).toEqual({
      'A|title': false,
      'A|it_price': false,
      'A|shared_sku_listing': true, // structural — applies in both modes
      'B|title': true,
    })
    expect(plan.applyCount).toBe(2)
    expect(plan.newRowSkus).toEqual([])
  })
  it('overwrite: every differing cell applies; unknown SKUs are new rows', () => {
    const plan = planImportCells(
      [{ sku: 'A', title: 'New title' }, { sku: 'NEW-1', title: 'X' }],
      existing,
      'overwrite',
    )
    expect(plan.changes).toEqual([{ sku: 'A', columnId: 'title', from: 'Old title', to: 'New title', willApply: true }])
    expect(plan.newRowSkus).toEqual(['NEW-1'])
  })
  it('identical and empty incoming cells produce no change rows', () => {
    const plan = planImportCells([{ sku: 'A', title: 'Old title', it_price: '' }], existing, 'overwrite')
    expect(plan.changes).toHaveLength(0)
  })
})

describe('pruneExcludedCells', () => {
  it('removes exactly the excluded sku|column cells', () => {
    const rows = [{ sku: 'A', title: 'T', it_price: '9' }, { sku: 'B', title: 'U' }]
    const out = pruneExcludedCells(rows, new Set(['A|it_price']))
    expect(out[0]).toEqual({ sku: 'A', title: 'T' })
    expect(out[1]).toEqual({ sku: 'B', title: 'U' })
  })
})

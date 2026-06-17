/**
 * FX.5 — import merge planner. Pure, so fill-missing vs overwrite, new-vs-update
 * by item_sku, the column allowlist, blank/unchanged skipping, and the apply/skip
 * accounting are fully unit-testable.
 */
import { describe, it, expect } from 'vitest'
import { planImportMerge, dedupeBySku } from './flat-file-merge.js'

const existing = [
  { _rowId: 'r1', item_sku: 'A1', item_name: 'Jacket', standard_price: '100', color_name: '' },
  { _rowId: 'r2', item_sku: 'A2', item_name: '', standard_price: '50', color_name: 'Red' },
]

describe('FX.5 — planImportMerge: fill-missing (default)', () => {
  const incoming = [
    { item_sku: 'A1', item_name: 'Jacket Pro', color_name: 'Black' }, // name conflicts (skip), color blank→fill
    { item_sku: 'A3', item_name: 'Gloves', standard_price: '30' },     // new row
  ]
  const plan = planImportMerge(existing, incoming, { mode: 'fill-missing' })

  it('updates an existing SKU only where the grid cell is blank', () => {
    const u = plan.updates.find((u) => u.sku === 'A1')!
    expect(u.rowId).toBe('r1')
    const name = u.cells.find((c) => c.columnId === 'item_name')!
    const color = u.cells.find((c) => c.columnId === 'color_name')!
    expect(name).toMatchObject({ from: 'Jacket', to: 'Jacket Pro', willApply: false, reason: 'skip-existing' })
    expect(color).toMatchObject({ from: '', to: 'Black', willApply: true, reason: 'fill' })
  })
  it('adds an unknown SKU as a new row (all cells fill)', () => {
    const n = plan.newRows.find((n) => n.sku === 'A3')!
    expect(n.cells.every((c) => c.willApply && c.reason === 'fill' && c.from === '')).toBe(true)
    expect(n.cells.map((c) => c.columnId).sort()).toEqual(['item_name', 'item_sku', 'standard_price'])
  })
  it('accounts apply vs skip', () => {
    // A1: color fill (apply) + name skip-existing (skip); A3: 3 cells apply
    expect(plan.stats).toMatchObject({ newRows: 1, updatedRows: 1, cellsToApply: 4, cellsToSkip: 1 })
  })
})

describe('FX.5 — planImportMerge: overwrite', () => {
  const incoming = [{ item_sku: 'A1', item_name: 'Jacket Pro' }]
  const plan = planImportMerge(existing, incoming, { mode: 'overwrite' })
  it('writes over an existing non-blank cell', () => {
    const name = plan.updates[0].cells.find((c) => c.columnId === 'item_name')!
    expect(name).toMatchObject({ from: 'Jacket', to: 'Jacket Pro', willApply: true, reason: 'overwrite' })
  })
})

describe('FX.5 — column allowlist + unchanged/blank skipping', () => {
  it('columns not in the allowlist are shown but not applied', () => {
    const incoming = [{ item_sku: 'A2', item_name: 'Pants', color_name: 'Blue' }]
    const plan = planImportMerge(existing, incoming, { mode: 'overwrite', columns: ['item_name'] })
    const u = plan.updates[0]
    expect(u.cells.find((c) => c.columnId === 'item_name')).toMatchObject({ willApply: true })
    expect(u.cells.find((c) => c.columnId === 'color_name')).toMatchObject({ willApply: false, reason: 'skip-column' })
  })
  it('unchanged + blank incoming cells are dropped from the diff', () => {
    const incoming = [{ item_sku: 'A1', item_name: 'Jacket', color_name: '' }] // name same, color blank
    const plan = planImportMerge(existing, incoming, { mode: 'overwrite' })
    expect(plan.updates).toEqual([]) // nothing to show
  })
})

describe('FX.5 — addNewRows=false + blank-sku', () => {
  it('skips unknown SKUs instead of creating rows', () => {
    const incoming = [{ item_sku: 'ZZ', item_name: 'X' }]
    const plan = planImportMerge(existing, incoming, { mode: 'overwrite', addNewRows: false })
    expect(plan.newRows).toEqual([])
    expect(plan.unmatchedSkipped).toEqual(['ZZ'])
  })
  it('counts incoming rows with a blank match key', () => {
    const incoming = [{ item_sku: '  ', item_name: 'No SKU' }, { item_sku: 'A1', color_name: 'Black' }]
    const plan = planImportMerge(existing, incoming, { mode: 'fill-missing' })
    expect(plan.skippedNoSku).toBe(1)
  })
})

describe('FX.6 — dedupeBySku + duplicate handling', () => {
  it('collapses repeated SKUs (later non-blank wins) and counts them', () => {
    const { rows, duplicates } = dedupeBySku([
      { item_sku: 'A1', item_name: 'First', color_name: 'Red' },
      { item_sku: 'A1', item_name: 'Second', color_name: '' }, // name overrides; blank color ignored
      { item_sku: 'A2', item_name: 'Solo' },
    ])
    expect(duplicates).toBe(1)
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.item_sku === 'A1')).toMatchObject({ item_name: 'Second', color_name: 'Red' })
  })
  it('planImportMerge dedups incoming → one merged new row + duplicateSkus count', () => {
    const plan = planImportMerge([], [
      { item_sku: 'NEW', item_name: 'A' },
      { item_sku: 'NEW', standard_price: '10' },
    ], { mode: 'overwrite' })
    expect(plan.duplicateSkus).toBe(1)
    expect(plan.newRows).toHaveLength(1)
  })
})

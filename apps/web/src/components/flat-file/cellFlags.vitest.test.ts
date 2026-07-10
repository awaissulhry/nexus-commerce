import { describe, it, expect } from 'vitest'
import { dropReadOnlyCellChanges } from './cellFlags'
import type { BaseRow, FlatFileColumn } from './FlatFileGrid.types'

const col = (over: Partial<FlatFileColumn> & { id: string }): FlatFileColumn => ({
  label: over.id, kind: 'text', width: 100, ...over,
})
const row = (over: Partial<BaseRow> & { _rowId: string }): BaseRow => ({ ...over })

// ── UFX P2b — per-cell read-only skip (commitCells guard) ──────────────────

describe('dropReadOnlyCellChanges — per-cell read-only skip', () => {
  // Mirrors the future Amazon FBA-quantity lock: quantity is locked for FBA
  // rows only; every other cell stays writable.
  const qty = col({ id: 'quantity' })
  const price = col({ id: 'price' })
  const colById = new Map([[qty.id, qty], [price.id, price]])
  const fba = row({ _rowId: 'r-fba', channel: 'FBA' })
  const fbm = row({ _rowId: 'r-fbm', channel: 'FBM' })
  const rowById = new Map([[fba._rowId, fba], [fbm._rowId, fbm]])
  const lockFbaQty = (c: FlatFileColumn, r: BaseRow) => c.id === 'quantity' && r.channel === 'FBA'

  const changes = [
    { rowId: 'r-fba', colId: 'quantity', value: '5' },   // locked → dropped
    { rowId: 'r-fba', colId: 'price', value: '9.99' },   // other col on same row → kept
    { rowId: 'r-fbm', colId: 'quantity', value: '3' },   // same col on unlocked row → kept
  ]

  it('drops changes targeting cells the predicate locks, keeps the rest', () => {
    const out = dropReadOnlyCellChanges(changes, colById, rowById, lockFbaQty)
    expect(out).toEqual([
      { rowId: 'r-fba', colId: 'price', value: '9.99' },
      { rowId: 'r-fbm', colId: 'quantity', value: '3' },
    ])
  })

  it('is a pass-through when no predicate is provided (eBay oracle: prop unused ⇒ identical)', () => {
    expect(dropReadOnlyCellChanges(changes, colById, rowById, undefined)).toBe(changes)
  })

  it('keeps changes whose column or row cannot be resolved (caller guards handle those)', () => {
    const out = dropReadOnlyCellChanges(
      [
        { rowId: 'r-fba', colId: 'nope', value: 'x' },
        { rowId: 'ghost', colId: 'quantity', value: 'y' },
      ],
      colById, rowById, lockFbaQty,
    )
    expect(out).toHaveLength(2)
  })

  it('drops everything when the predicate locks everything', () => {
    expect(dropReadOnlyCellChanges(changes, colById, rowById, () => true)).toEqual([])
  })
})

import { describe, it, expect } from 'vitest'
import { dropReadOnlyCellChanges, typeApplicabilityGuidance, isRequiredForRow, enumOptionsForRow } from './cellFlags'
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

// ── UFX P2c — built-in per-type applicability ───────────────────────────────

describe('typeApplicabilityGuidance', () => {
  const shirtOnly = col({ id: 'sleeve_type', applicableProductTypes: ['SHIRT', 'SWEATER'] })

  it('returns null when the column has no applicableProductTypes (legacy column)', () => {
    expect(typeApplicabilityGuidance(col({ id: 'title' }), row({ _rowId: 'r', product_type: 'PANTS' }))).toBeNull()
  })

  it("returns null when the row's type is in the list", () => {
    expect(typeApplicabilityGuidance(shirtOnly, row({ _rowId: 'r', product_type: 'SHIRT' }))).toBeNull()
    expect(typeApplicabilityGuidance(shirtOnly, row({ _rowId: 'r', product_type: 'SWEATER' }))).toBeNull()
  })

  it("returns 'not-applicable' when the row's type is NOT in the list", () => {
    expect(typeApplicabilityGuidance(shirtOnly, row({ _rowId: 'r', product_type: 'PANTS' }))).toBe('not-applicable')
  })

  it('compares uppercased on both sides (mixed-case data and schema)', () => {
    expect(typeApplicabilityGuidance(shirtOnly, row({ _rowId: 'r', product_type: 'shirt' }))).toBeNull()
    expect(typeApplicabilityGuidance(shirtOnly, row({ _rowId: 'r', product_type: '  Shirt ' }))).toBeNull()
    expect(typeApplicabilityGuidance(col({ id: 'c', applicableProductTypes: ['shirt'] }), row({ _rowId: 'r', product_type: 'SHIRT' }))).toBeNull()
    expect(typeApplicabilityGuidance(shirtOnly, row({ _rowId: 'r', product_type: 'pants' }))).toBe('not-applicable')
  })

  it('returns null when the row has no usable product_type (absent, empty, non-string)', () => {
    expect(typeApplicabilityGuidance(shirtOnly, row({ _rowId: 'r' }))).toBeNull()
    expect(typeApplicabilityGuidance(shirtOnly, row({ _rowId: 'r', product_type: '' }))).toBeNull()
    expect(typeApplicabilityGuidance(shirtOnly, row({ _rowId: 'r', product_type: 42 }))).toBeNull()
  })
})

describe('isRequiredForRow', () => {
  it('falls back to col.required when requiredForProductTypes is absent (legacy columns unchanged)', () => {
    expect(isRequiredForRow(col({ id: 'c', required: true }), row({ _rowId: 'r', product_type: 'PANTS' }))).toBe(true)
    expect(isRequiredForRow(col({ id: 'c' }), row({ _rowId: 'r', product_type: 'PANTS' }))).toBe(false)
    expect(isRequiredForRow(col({ id: 'c', required: true }), row({ _rowId: 'r' }))).toBe(true)
  })

  it("shows required only for rows whose type is in requiredForProductTypes", () => {
    const c = col({ id: 'c', required: true, requiredForProductTypes: ['SHIRT'] })
    expect(isRequiredForRow(c, row({ _rowId: 'r', product_type: 'SHIRT' }))).toBe(true)
    expect(isRequiredForRow(c, row({ _rowId: 'r', product_type: 'PANTS' }))).toBe(false)
  })

  it('compares uppercased on both sides', () => {
    const c = col({ id: 'c', requiredForProductTypes: ['Shirt'] })
    expect(isRequiredForRow(c, row({ _rowId: 'r', product_type: 'shirt' }))).toBe(true)
    expect(isRequiredForRow(c, row({ _rowId: 'r', product_type: ' SHIRT ' }))).toBe(true)
  })

  it('is not required for rows without a resolvable product_type when the list is present', () => {
    const c = col({ id: 'c', required: true, requiredForProductTypes: ['SHIRT'] })
    expect(isRequiredForRow(c, row({ _rowId: 'r' }))).toBe(false)
    expect(isRequiredForRow(c, row({ _rowId: 'r', product_type: '' }))).toBe(false)
  })

  it("UFX P2d — ghost canvas rows are never required (no '⚠ required' on the blank canvas)", () => {
    expect(isRequiredForRow(col({ id: 'c', required: true }), row({ _rowId: 'g', _ghost: true }))).toBe(false)
    const c = col({ id: 'c', required: true, requiredForProductTypes: ['SHIRT'] })
    expect(isRequiredForRow(c, row({ _rowId: 'g', _ghost: true, product_type: 'SHIRT' }))).toBe(false)
    // materialized (no longer ghost) → required again
    expect(isRequiredForRow(c, row({ _rowId: 'g', _ghost: false, product_type: 'SHIRT' }))).toBe(true)
  })
})

// ── UFX P4d — per-row enum options ──────────────────────────────────────────

describe('enumOptionsForRow', () => {
  const theme = col({
    id: 'variation_theme', kind: 'enum',
    options: ['', 'SIZE_COLOR', 'SIZE', 'WAIST_LENGTH'],           // union superset
    optionsByProductType: { JACKET: ['SIZE_COLOR', 'SIZE'], PANTS: ['WAIST_LENGTH'] },
  })

  it("uses the row's OWN type's list (blank prepended) on a union column", () => {
    expect(enumOptionsForRow(theme, row({ _rowId: 'r', product_type: 'JACKET' })))
      .toEqual(['', 'SIZE_COLOR', 'SIZE'])
    expect(enumOptionsForRow(theme, row({ _rowId: 'r', product_type: 'pants' })))
      .toEqual(['', 'WAIST_LENGTH'])
  })

  it('falls back to the flat union for untyped rows and unlisted types', () => {
    expect(enumOptionsForRow(theme, row({ _rowId: 'r' }))).toEqual(['', 'SIZE_COLOR', 'SIZE', 'WAIST_LENGTH'])
    expect(enumOptionsForRow(theme, row({ _rowId: 'r', product_type: 'SHIRT' })))
      .toEqual(['', 'SIZE_COLOR', 'SIZE', 'WAIST_LENGTH'])
  })

  it('keeps a per-type list intact when it already leads with the blank entry', () => {
    const c = col({ id: 'c', kind: 'enum', options: ['a'], optionsByProductType: { SHIRT: ['', 'a'] } })
    expect(enumOptionsForRow(c, row({ _rowId: 'r', product_type: 'SHIRT' }))).toEqual(['', 'a'])
  })

  it('legacy columns unchanged: plain enums use options, booleans fixed, others null', () => {
    expect(enumOptionsForRow(col({ id: 'c', kind: 'enum', options: ['x', 'y'] }), row({ _rowId: 'r', product_type: 'SHIRT' })))
      .toEqual(['x', 'y'])
    expect(enumOptionsForRow(col({ id: 'c', kind: 'boolean' }), row({ _rowId: 'r' }))).toEqual(['', 'true', 'false'])
    expect(enumOptionsForRow(col({ id: 'c', kind: 'text' }), row({ _rowId: 'r' }))).toBeNull()
    expect(enumOptionsForRow(col({ id: 'c', kind: 'enum' }), row({ _rowId: 'r' }))).toBeNull()
  })
})

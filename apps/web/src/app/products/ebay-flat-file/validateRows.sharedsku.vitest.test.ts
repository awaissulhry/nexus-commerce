/**
 * Task 6 — unit tests for isSharedDuplicateAllowed.
 * Shared-SKU management: same child SKU is allowed under ≥2 DISTINCT
 * shared families but stays an error for same-family or non-shared families.
 * Run: npx vitest run apps/web/src/app/products/ebay-flat-file/validateRows.sharedsku.vitest.test.ts
 */
import { describe, it, expect } from 'vitest'
import { isSharedDuplicateAllowed, type EbayRowMin } from './validateRows.shared'

// ── helpers ───────────────────────────────────────────────────────────────

const parent = (id: string, shared: boolean): EbayRowMin => ({
  _rowId: id,
  _productId: id,
  sku: `parent-sku-${id}`,
  _isParent: true,
  shared_sku_listing: shared,
})

const child = (sku: string, familyId: string): EbayRowMin => ({
  _rowId: `${sku}-${familyId}`,
  platformProductId: familyId,
  sku,
  _isParent: false,
})

// ── test cases ────────────────────────────────────────────────────────────

describe('isSharedDuplicateAllowed', () => {
  it('(a) same SKU under two shared parents → allowed (returns true)', () => {
    // Family A and Family B both have shared_sku_listing=true
    // Child "SKU-X" appears under both families — this should be allowed
    const rows: EbayRowMin[] = [
      parent('familyA', true),
      parent('familyB', true),
      child('SKU-X', 'familyA'),
      child('SKU-X', 'familyB'),
    ]
    expect(isSharedDuplicateAllowed('SKU-X', rows)).toBe(true)
  })

  it('(b) same SKU under two NON-shared parents → error (returns false)', () => {
    // Family A and Family B both have shared_sku_listing=false (default)
    // Child "SKU-X" under both = real duplicate, must stay an error
    const rows: EbayRowMin[] = [
      parent('familyA', false),
      parent('familyB', false),
      child('SKU-X', 'familyA'),
      child('SKU-X', 'familyB'),
    ]
    expect(isSharedDuplicateAllowed('SKU-X', rows)).toBe(false)
  })

  it('(c) same SKU twice under ONE parent → error (returns false)', () => {
    // Two rows with the same SKU but same platformProductId → only 1 distinct family key
    const rows: EbayRowMin[] = [
      parent('familyA', true),
      child('SKU-X', 'familyA'),
      child('SKU-X', 'familyA'), // duplicate within same family
    ]
    expect(isSharedDuplicateAllowed('SKU-X', rows)).toBe(false)
  })

  it('(d) same SKU under one shared + one non-shared parent → error (returns false)', () => {
    // Mixed: familyA is shared, familyB is NOT — must stay an error
    const rows: EbayRowMin[] = [
      parent('familyA', true),
      parent('familyB', false),
      child('SKU-X', 'familyA'),
      child('SKU-X', 'familyB'),
    ]
    expect(isSharedDuplicateAllowed('SKU-X', rows)).toBe(false)
  })

  // ── Multi-listing import fixes (duplicate-SKU publish blocker) ────────────

  it('(e) imported flags as TEXT ("TRUE") still qualify as shared', () => {
    const rows: EbayRowMin[] = [
      { ...parent('familyA', false), shared_sku_listing: 'TRUE' },
      { ...parent('familyB', false), shared_sku_listing: 'true' },
      child('SKU-X', 'familyA'),
      child('SKU-X', 'familyB'),
    ]
    expect(isSharedDuplicateAllowed('SKU-X', rows)).toBe(true)
  })

  it('(f) file-linked children (parent_sku only, no platformProductId) resolve their parent', () => {
    // Freshly imported, unsaved: parents have no product ids yet; children link by parent_sku.
    const rows: EbayRowMin[] = [
      { _rowId: 'p1', sku: 'GALE-JACKET', _isParent: true, shared_sku_listing: true },
      { _rowId: 'p2', sku: 'IT-GALE-JACKET', _isParent: true, shared_sku_listing: true },
      { _rowId: 'c1', sku: 'GALE-JACKET-BLACK-MEN-M', _isParent: false, parent_sku: 'GALE-JACKET' },
      { _rowId: 'c2', sku: 'GALE-JACKET-BLACK-MEN-M', _isParent: false, parent_sku: 'IT-GALE-JACKET' },
    ]
    expect(isSharedDuplicateAllowed('GALE-JACKET-BLACK-MEN-M', rows)).toBe(true)
  })

  it('(g) file-linked children under ONE parent stay a real duplicate', () => {
    const rows: EbayRowMin[] = [
      { _rowId: 'p1', sku: 'GALE-JACKET', _isParent: true, shared_sku_listing: true },
      { _rowId: 'c1', sku: 'SKU-X', _isParent: false, parent_sku: 'GALE-JACKET' },
      { _rowId: 'c2', sku: 'SKU-X', _isParent: false, parent_sku: 'GALE-JACKET' },
    ]
    expect(isSharedDuplicateAllowed('SKU-X', rows)).toBe(false)
  })

  it('(h) membership-synthesized rows (_shared, no parent row in grid) are allowed', () => {
    // Saved family + read-back membership rows of the OTHER listings: those
    // rows carry _shared + a parent_sku that has NO parent row in the grid.
    const rows: EbayRowMin[] = [
      parent('familyA', true),
      child('SKU-X', 'familyA'),
      { _rowId: 'm1', sku: 'SKU-X', _isParent: false, _shared: true, parent_sku: 'IT-GALE-JACKET' },
      { _rowId: 'm2', sku: 'SKU-X', _isParent: false, _shared: true, parent_sku: 'GALE-JACKET-ALT1' },
    ]
    expect(isSharedDuplicateAllowed('SKU-X', rows)).toBe(true)
  })

  it('(i) mixed saved family + file-linked new families (the GALE 5-listing import)', () => {
    const rows: EbayRowMin[] = [
      { ...parent('galeProd', false), sku: 'GALE-JACKET', shared_sku_listing: 'TRUE' },
      { _rowId: 'p2', sku: 'GALE-JACKET-ALT1', _isParent: true, shared_sku_listing: 'TRUE' },
      { _rowId: 'p3', sku: 'GALE-JACKET-ALT2', _isParent: true, shared_sku_listing: 'TRUE' },
      child('GALE-JACKET-BLACK-MEN-M', 'galeProd'),
      { _rowId: 'c2', sku: 'GALE-JACKET-BLACK-MEN-M', _isParent: false, parent_sku: 'GALE-JACKET-ALT1' },
      { _rowId: 'c3', sku: 'GALE-JACKET-BLACK-MEN-M', _isParent: false, parent_sku: 'GALE-JACKET-ALT2' },
    ]
    expect(isSharedDuplicateAllowed('GALE-JACKET-BLACK-MEN-M', rows)).toBe(true)
  })

  it('(j) unresolvable children (no parent anywhere, no flag) stay errors', () => {
    const rows: EbayRowMin[] = [
      { _rowId: 'c1', sku: 'SKU-X', _isParent: false },
      { _rowId: 'c2', sku: 'SKU-X', _isParent: false },
    ]
    expect(isSharedDuplicateAllowed('SKU-X', rows)).toBe(false)
  })
})

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
})

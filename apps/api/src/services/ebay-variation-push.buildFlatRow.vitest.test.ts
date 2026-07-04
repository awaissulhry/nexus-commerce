/**
 * P1a — Unit tests for buildFlatRow parentage + parent_sku fields.
 *
 * Covers the three derivation cases for `parentage` and confirms that
 * `parent_sku` is always the placeholder '' from buildFlatRow (the GET
 * /rows route fills the real value after the full product set is loaded).
 */

import { describe, it, expect } from 'vitest'
import { buildFlatRow } from './ebay-variation-push.service.js'

/** Minimal product fixture that buildFlatRow accepts. */
function makeProduct(overrides: {
  parentId?: string | null
  isParent?: boolean | null
}): Parameters<typeof buildFlatRow>[0] {
  return {
    id: 'prod-1',
    sku: 'SKU-001',
    name: 'Test Product',
    ean: null,
    parentId: overrides.parentId ?? null,
    isParent: overrides.isParent ?? false,
    variationTheme: null,
    categoryAttributes: null,
    variantAttributes: null,
    brand: null,
    images: [],
    channelListings: [],
  }
}

describe('buildFlatRow — parentage column derivation (P1a)', () => {
  it('parentId set → parentage:"child"', () => {
    const row = buildFlatRow(makeProduct({ parentId: 'parent-id', isParent: false }))
    expect(row.parentage).toBe('child')
  })

  it('isParent:true + no parentId → parentage:"parent"', () => {
    const row = buildFlatRow(makeProduct({ parentId: null, isParent: true }))
    expect(row.parentage).toBe('parent')
  })

  it('neither parentId nor isParent → parentage:""', () => {
    const row = buildFlatRow(makeProduct({ parentId: null, isParent: false }))
    expect(row.parentage).toBe('')
  })

  it('parent_sku is always "" (placeholder — route fills it)', () => {
    const rowChild = buildFlatRow(makeProduct({ parentId: 'p', isParent: false }))
    const rowParent = buildFlatRow(makeProduct({ parentId: null, isParent: true }))
    const rowStand = buildFlatRow(makeProduct({ parentId: null, isParent: false }))
    expect(rowChild.parent_sku).toBe('')
    expect(rowParent.parent_sku).toBe('')
    expect(rowStand.parent_sku).toBe('')
  })

  it('_isParent and platformProductId are UNCHANGED (back-compat)', () => {
    const rowChild = buildFlatRow(makeProduct({ parentId: 'parent-id', isParent: false }))
    expect(rowChild._isParent).toBe(false)
    expect(rowChild.platformProductId).toBe('parent-id')

    const rowParent = buildFlatRow(makeProduct({ parentId: null, isParent: true }))
    expect(rowParent._isParent).toBe(true)
    expect(rowParent.platformProductId).toBe('prod-1')
  })
})

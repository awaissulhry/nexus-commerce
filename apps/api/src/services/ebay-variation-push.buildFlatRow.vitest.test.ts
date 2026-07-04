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

// ── P4 image inheritance ────────────────────────────────────────────────────

describe('buildFlatRow — P4 image inheritance', () => {
  const parentImgs = [
    { url: 'https://cdn.example.com/parent-main.jpg', sortOrder: 0, type: 'MAIN' },
    { url: 'https://cdn.example.com/parent-2.jpg',    sortOrder: 1, type: 'PT01' },
  ]

  it('child with no own images inherits parent images into image_1..N', () => {
    const product = makeProduct({ parentId: 'parent-id', isParent: false })
    const row = buildFlatRow(product, { parentImages: parentImgs })
    expect(row.image_1).toBe('https://cdn.example.com/parent-main.jpg')
    expect(row.image_2).toBe('https://cdn.example.com/parent-2.jpg')
    expect(row.image_3).toBe('')
  })

  it('child with own images does NOT inherit (own images take precedence)', () => {
    const product: Parameters<typeof buildFlatRow>[0] = {
      ...makeProduct({ parentId: 'parent-id', isParent: false }),
      images: [{ url: 'https://cdn.example.com/own.jpg', sortOrder: 0, type: 'MAIN' }],
    }
    const row = buildFlatRow(product, { parentImages: parentImgs })
    expect(row.image_1).toBe('https://cdn.example.com/own.jpg')
    expect(row.image_2).toBe('')
  })

  it('standalone product with no parentImages stays empty', () => {
    const row = buildFlatRow(makeProduct({ parentId: null, isParent: true }))
    expect(row.image_1).toBe('')
    expect(row.image_2).toBe('')
  })

  it('MAIN-typed parent image sorts first regardless of sortOrder position', () => {
    const shuffled = [
      { url: 'https://cdn.example.com/parent-2.jpg',    sortOrder: 0, type: 'PT01' },
      { url: 'https://cdn.example.com/parent-main.jpg', sortOrder: 1, type: 'MAIN' },
    ]
    const product = makeProduct({ parentId: 'parent-id', isParent: false })
    const row = buildFlatRow(product, { parentImages: shuffled })
    expect(row.image_1).toBe('https://cdn.example.com/parent-main.jpg')
    expect(row.image_2).toBe('https://cdn.example.com/parent-2.jpg')
  })
})

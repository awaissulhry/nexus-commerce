/**
 * EFX P6 — deriveImageFamilies: the images-drawer family list is built from
 * the grid's CURRENT rows (not the SSR snapshot), so it must handle both row
 * conventions (_isParent flag / P2.B2 parentage strings), the single-family
 * `familyId` mode, and child→parent attachment by id OR parent_sku.
 *
 * Run: npx vitest run apps/web/src/app/products/ebay-flat-file/imageFamilies.vitest.test.ts
 */
import { describe, it, expect } from 'vitest'
import { deriveImageFamilies, mergeImageFamilies, type FamilyDeriveRow, type ImageFamilySummary } from './imageFamilies.pure'

const parent = (id: string, sku: string, title = ''): FamilyDeriveRow => ({
  _isParent: true, _productId: id, sku, title,
})
const child = (parentId: string, sku: string): FamilyDeriveRow => ({
  _isParent: false, platformProductId: parentId, sku,
})

describe('deriveImageFamilies', () => {
  it('one entry per parent row, with sku/title and variant counts', () => {
    const rows = [
      parent('p1', 'GALE-JACKET', 'Gale Jacket'),
      child('p1', 'GALE-JACKET-RED-M'),
      child('p1', 'GALE-JACKET-RED-L'),
      parent('p2', 'AIREON', 'Aireon Gloves'),
      child('p2', 'AIREON-BLK-S'),
    ]
    expect(deriveImageFamilies(rows)).toEqual([
      { productId: 'p1', parentSku: 'GALE-JACKET', title: 'Gale Jacket', variantCount: 2 },
      { productId: 'p2', parentSku: 'AIREON', title: 'Aireon Gloves', variantCount: 1 },
    ])
  })

  it('standalone parent (no children) still appears, count 0', () => {
    expect(deriveImageFamilies([parent('p1', 'SOLO', 'Solo product')])).toEqual([
      { productId: 'p1', parentSku: 'SOLO', title: 'Solo product', variantCount: 0 },
    ])
  })

  it('accepts the P2.B2 parentage convention when _isParent is absent', () => {
    const rows: FamilyDeriveRow[] = [
      { parentage: 'parent', _productId: 'p1', sku: 'PAR', title: 'T' },
      { parentage: 'child', platformProductId: 'p1', sku: 'PAR-A' },
      { parentage: 'child', parent_sku: 'PAR', sku: 'PAR-B' }, // id not back-filled yet
    ]
    expect(deriveImageFamilies(rows)).toEqual([
      { productId: 'p1', parentSku: 'PAR', title: 'T', variantCount: 2 },
    ])
  })

  it('_isParent (boolean) wins over parentage when both are present', () => {
    const rows: FamilyDeriveRow[] = [
      // a mis-labelled row: explicit boolean says child → treated as child
      { _isParent: false, parentage: 'parent', platformProductId: 'p1', sku: 'X' },
      parent('p1', 'PAR'),
    ]
    expect(deriveImageFamilies(rows)).toEqual([
      { productId: 'p1', parentSku: 'PAR', title: '', variantCount: 1 },
    ])
  })

  it('familyId is always included first, back-filled from its parent row when present', () => {
    const rows = [parent('fam1', 'FAM', 'Family title'), child('fam1', 'FAM-A')]
    expect(deriveImageFamilies(rows, 'fam1')).toEqual([
      { productId: 'fam1', parentSku: 'FAM', title: 'Family title', variantCount: 1 },
    ])
    // parent row not rendered → placeholder entry survives
    expect(deriveImageFamilies([], 'fam1')).toEqual([
      { productId: 'fam1', parentSku: '', title: '', variantCount: 0 },
    ])
  })

  it('falls back to platformProductId for the parent id and skips id-less parents', () => {
    const rows: FamilyDeriveRow[] = [
      { _isParent: true, platformProductId: 'p9', sku: 'VIA-PLATFORM' },
      { _isParent: true, sku: 'NO-ID' }, // unsaved new row — no product yet
    ]
    expect(deriveImageFamilies(rows)).toEqual([
      { productId: 'p9', parentSku: 'VIA-PLATFORM', title: '', variantCount: 0 },
    ])
  })

  it('dedupes duplicate parent rows for the same product id', () => {
    const rows = [parent('p1', 'DUP', 'First'), parent('p1', 'DUP', 'Second'), child('p1', 'DUP-A')]
    const out = deriveImageFamilies(rows)
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ productId: 'p1', parentSku: 'DUP', title: 'First', variantCount: 1 })
  })

  it('children of unknown parents are ignored (no phantom families)', () => {
    const rows = [parent('p1', 'PAR'), child('ghost', 'GHOST-A')]
    expect(deriveImageFamilies(rows)).toEqual([
      { productId: 'p1', parentSku: 'PAR', title: '', variantCount: 0 },
    ])
  })
})

describe('mergeImageFamilies', () => {
  const fam = (id: string, extra: Partial<ImageFamilySummary> = {}): ImageFamilySummary => ({
    productId: id, parentSku: id.toUpperCase(), title: '', variantCount: 0, ...extra,
  })

  it('appends added families after the derived ones, in order', () => {
    const derived = [fam('p1'), fam('p2')]
    const added = [fam('a1', { hasEbayListing: true }), fam('a2', { hasEbayListing: false })]
    expect(mergeImageFamilies(derived, added).map(f => f.productId)).toEqual(['p1', 'p2', 'a1', 'a2'])
  })

  it('derived family wins on id collision (added duplicate dropped)', () => {
    const derived = [fam('p1', { variantCount: 3, parentSku: 'SHEET' })]
    const added = [fam('p1', { variantCount: 0, parentSku: 'PICKER', hasEbayListing: false })]
    const out = mergeImageFamilies(derived, added)
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ productId: 'p1', parentSku: 'SHEET', title: '', variantCount: 3 })
  })

  it('de-dupes within the added list too', () => {
    const out = mergeImageFamilies([], [fam('a1'), fam('a1', { title: 'dup' })])
    expect(out).toHaveLength(1)
    expect(out[0].productId).toBe('a1')
  })

  it('preserves the hasEbayListing draft flag on added families', () => {
    const out = mergeImageFamilies([fam('p1')], [fam('a1', { hasEbayListing: false })])
    expect(out.find(f => f.productId === 'a1')?.hasEbayListing).toBe(false)
    // derived family stays flag-free (unknown)
    expect(out.find(f => f.productId === 'p1')?.hasEbayListing).toBeUndefined()
  })

  it('skips id-less entries defensively', () => {
    const out = mergeImageFamilies([fam('p1')], [{ productId: '', parentSku: '', title: '', variantCount: 0 }])
    expect(out.map(f => f.productId)).toEqual(['p1'])
  })
})

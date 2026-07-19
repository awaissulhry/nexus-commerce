/**
 * EB-IMG Phase 2 — copy-from-listing bucket mapping invariants.
 */
import { describe, expect, it } from 'vitest'
import { mapSourceToBuckets, type CopySourceListingImage } from './copyFromListing.pure'
import { SHARED_GALLERY_AXIS } from './variationValueOrder.pure'

const li = (
  url: string,
  variantGroupKey: string | null = null,
  variantGroupValue: string | null = null,
  position = 0,
  platform = 'EBAY',
  variationId: string | null = null,
): CopySourceListingImage => ({ platform, variationId, variantGroupKey, variantGroupValue, url, position })

describe('mapSourceToBuckets', () => {
  it('maps shared + per-value sets onto the target buckets, synonym axis + case-insensitive values', () => {
    const out = mapSourceToBuckets({
      sourceListing: [
        li('https://c/cover2.jpg', null, null, 1),
        li('https://c/cover1.jpg', null, null, 0),
        li('https://c/nero1.jpg', 'Color', 'nero', 0),
        li('https://c/nero2.jpg', 'Color', 'Nero', 1),
        li('https://c/verde1.jpg', 'Color', 'VERDE', 0),
      ],
      targetAxis: 'Colore',
      targetValues: ['Nero', 'Verde', 'Grigio'],
    })
    expect(out.buckets.get(SHARED_GALLERY_AXIS)).toEqual(['https://c/cover1.jpg', 'https://c/cover2.jpg'])
    expect(out.buckets.get('Nero')).toEqual(['https://c/nero1.jpg', 'https://c/nero2.jpg'])
    expect(out.buckets.get('Verde')).toEqual(['https://c/verde1.jpg'])
    expect(out.buckets.get('Grigio')).toEqual([])
    expect(out.copiedImages).toBe(5)
    expect(out.copiedSets).toBe(2)
    expect(out.unmatchedSourceValues).toEqual([])
    expect(out.emptyTargetValues).toEqual(['Grigio'])
  })

  it('reports source values missing on the target instead of dropping them silently', () => {
    const out = mapSourceToBuckets({
      sourceListing: [li('https://c/giallo.jpg', 'Color', 'Giallo')],
      targetAxis: 'Color',
      targetValues: ['Nero'],
    })
    expect(out.unmatchedSourceValues).toEqual(['Giallo'])
    expect(out.copiedImages).toBe(0)
  })

  it('reports a whole-axis mismatch with axis-qualified labels', () => {
    const out = mapSourceToBuckets({
      sourceListing: [li('https://c/m.jpg', 'Size', 'M')],
      targetAxis: 'Color',
      targetValues: ['Nero'],
    })
    expect(out.unmatchedSourceValues).toEqual(['Size: M'])
  })

  it('folds everything into one gallery when the target is in shared mode', () => {
    const out = mapSourceToBuckets({
      sourceListing: [
        li('https://c/cover.jpg', null, null, 0),
        li('https://c/nero.jpg', 'Color', 'Nero', 0),
        li('https://c/nero.jpg', 'Color', 'Verde', 0), // dup URL folds once
      ],
      targetAxis: SHARED_GALLERY_AXIS,
      targetValues: [],
    })
    expect(out.buckets.get(SHARED_GALLERY_AXIS)).toEqual(['https://c/cover.jpg', 'https://c/nero.jpg'])
    expect(out.copiedImages).toBe(2)
  })

  it('ignores non-EBAY and per-SKU rows and respects the cap', () => {
    const many = Array.from({ length: 15 }, (_, i) => li(`https://c/n${i}.jpg`, 'Color', 'Nero', i))
    const out = mapSourceToBuckets({
      sourceListing: [
        li('https://c/amz.jpg', null, null, 0, 'AMAZON'),
        li('https://c/sku.jpg', null, null, 0, 'EBAY', 'prod-1'),
        ...many,
      ],
      targetAxis: 'Color',
      targetValues: ['Nero'],
    })
    expect(out.buckets.get(SHARED_GALLERY_AXIS)).toEqual([])
    expect(out.buckets.get('Nero')).toHaveLength(12)
  })
})

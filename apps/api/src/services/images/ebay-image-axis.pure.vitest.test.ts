/**
 * EFX P5 — tests for the pure eBay image-axis logic:
 *   • deriveWorkspaceAxes: union of variantAttributes + categoryAttributes.variations
 *     keys, synonym dedup (first-seen casing), distinct value counts
 *   • resolveImagePictureAxis: '__shared__' round-trip (activeAxis AND stored
 *     preference), FFP.7/15/16 rules preserved
 *   • clampImageSets: 12-image clamp with per-value truncation warnings
 *
 * Run: npx vitest run src/services/images/ebay-image-axis.pure.vitest.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  deriveWorkspaceAxes,
  resolveImagePictureAxis,
  clampImageSets,
  SHARED_GALLERY_AXIS,
  EBAY_VARIATION_IMAGE_MAX,
} from './ebay-image-axis.pure.js'

describe('deriveWorkspaceAxes', () => {
  it('unions variantAttributes AND categoryAttributes.variations keys', () => {
    const { availableAxes } = deriveWorkspaceAxes([
      { variantAttributes: { Colore: 'Nero', Taglia: 'M' } },
      // Axis living ONLY in categoryAttributes.variations (legacy bulk-create)
      { variantAttributes: null, categoryAttributes: { variations: { 'Tipo di prodotto': 'Guanti', Colore: 'Rosso' } } },
    ])
    expect(availableAxes).toEqual(['Colore', 'Taglia', 'Tipo di prodotto'])
  })

  it('dedups synonyms across sources, keeping first-seen casing', () => {
    const { availableAxes, axisValueCounts } = deriveWorkspaceAxes([
      { variantAttributes: { Colore: 'Nero' } },
      // "color name" is the same synonym dimension as "Colore" → no new axis
      { variantAttributes: { 'color name': 'Rosso' }, categoryAttributes: { variations: { Color: 'Blu' } } },
    ])
    expect(availableAxes).toEqual(['Colore'])
    // Nero + Rosso + Blu = 3 distinct values collected across all aliases
    expect(axisValueCounts).toEqual({ Colore: 3 })
  })

  it('counts distinct values case-insensitively (single-valued axis → 1)', () => {
    const { axisValueCounts } = deriveWorkspaceAxes([
      { variantAttributes: { Colore: 'Nero', Taglia: 'S' } },
      { variantAttributes: { Colore: 'NERO ', Taglia: 'M' } },
    ])
    expect(axisValueCounts.Colore).toBe(1)
    expect(axisValueCounts.Taglia).toBe(2)
  })

  it('ignores malformed categoryAttributes shapes', () => {
    const { availableAxes } = deriveWorkspaceAxes([
      { variantAttributes: null, categoryAttributes: { variations: ['not', 'an', 'object'] } },
      { variantAttributes: null, categoryAttributes: 'garbage' },
      { variantAttributes: null, categoryAttributes: null },
    ])
    expect(availableAxes).toEqual([])
  })
})

describe('resolveImagePictureAxis', () => {
  const axes = (spec: Record<string, string[]>) =>
    Object.entries(spec).map(([label, values]) => ({ label, values: new Set(values) }))

  const colourSize = axes({ Colore: ['nero', 'rosso'], Taglia: ['s', 'm', 'l'] })

  it("'__shared__' as activeAxis → explicit shared gallery, no picture axis", () => {
    const r = resolveImagePictureAxis(colourSize, SHARED_GALLERY_AXIS, 'Colore')
    expect(r).toEqual({
      requestedAxis: SHARED_GALLERY_AXIS,
      pictureAxis: null,
      realAxes: ['Colore', 'Taglia'],
      sharedGallery: true,
      explicitShared: true,
    })
  })

  it("'__shared__' stored as imageAxisPreference (bulk/scheduled path — no activeAxis) also works", () => {
    const r = resolveImagePictureAxis(colourSize, undefined, SHARED_GALLERY_AXIS)
    expect(r.sharedGallery).toBe(true)
    expect(r.explicitShared).toBe(true)
    expect(r.pictureAxis).toBeNull()
  })

  it('activeAxis wins over the stored preference and matches across synonyms', () => {
    const r = resolveImagePictureAxis(colourSize, 'Color', 'Taglia')
    expect(r.pictureAxis).toBe('Colore') // display-cased family label, not the request
    expect(r.sharedGallery).toBe(false)
    expect(r.requestedAxis).toBe('Color')
  })

  it('falls back to imageAxisPreference then Color when no activeAxis', () => {
    expect(resolveImagePictureAxis(colourSize, undefined, 'Taglia').pictureAxis).toBe('Taglia')
    expect(resolveImagePictureAxis(colourSize, '  ', null).pictureAxis).toBe('Colore') // 'Color' default → synonym match
  })

  it('single-valued requested axis → shared gallery, pictureAxis kept for curated folding (FFP.15)', () => {
    const r = resolveImagePictureAxis(axes({ Colore: ['nero'], Taglia: ['s', 'm'] }), 'Colore', null)
    expect(r.sharedGallery).toBe(true)
    expect(r.explicitShared).toBe(false)
    expect(r.pictureAxis).toBe('Colore')
    expect(r.realAxes).toEqual(['Taglia'])
  })

  it('unknown requested axis → first NON-size multi axis (FFP.16), not shared', () => {
    const r = resolveImagePictureAxis(
      axes({ Taglia: ['s', 'm'], 'Tipo di prodotto': ['guanti', 'sottoguanti'] }),
      'Materiale',
      null,
    )
    expect(r.sharedGallery).toBe(false)
    expect(r.pictureAxis).toBe('Tipo di prodotto')
  })

  it('unknown requested axis with ONLY size-like multi axes → shared gallery (FFP.16)', () => {
    const r = resolveImagePictureAxis(axes({ Taglia: ['s', 'm', 'l'] }), 'Colore', null)
    expect(r.sharedGallery).toBe(true)
    expect(r.realAxes).toEqual(['Taglia'])
  })

  it('an EXPLICIT size pick on a family that truly varies by size is honored', () => {
    const r = resolveImagePictureAxis(colourSize, 'Taglia', null)
    expect(r.pictureAxis).toBe('Taglia')
    expect(r.sharedGallery).toBe(false)
  })

  it("custom axis ('Tipo di prodotto') is a first-class pick — not forced onto colour", () => {
    const r = resolveImagePictureAxis(
      axes({ Colore: ['nero', 'rosso'], 'Tipo di prodotto': ['guanti', 'sottoguanti'] }),
      'Tipo di prodotto',
      null,
    )
    expect(r.pictureAxis).toBe('Tipo di prodotto')
    expect(r.sharedGallery).toBe(false)
  })
})

describe('clampImageSets', () => {
  const urls = (n: number) => Array.from({ length: n }, (_, i) => `https://img/${i}.jpg`)

  it('clamps oversized sets to the max IN PLACE and returns one warning per truncated set', () => {
    const sets = new Map<string, string[]>([
      ['nero', urls(15)],
      ['rosso', urls(12)],
      ['blu', urls(3)],
    ])
    const warnings = clampImageSets(sets, EBAY_VARIATION_IMAGE_MAX, (k) => `Curated Colore set "${k}"`)
    expect(sets.get('nero')).toHaveLength(12)
    expect(sets.get('nero')![0]).toBe('https://img/0.jpg') // first 12 kept, order preserved
    expect(sets.get('rosso')).toHaveLength(12)
    expect(sets.get('blu')).toHaveLength(3)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Curated Colore set "nero"')
    expect(warnings[0]).toContain('15 images')
    expect(warnings[0]).toContain('first 12')
  })

  it('returns no warnings when every set is within the limit', () => {
    const sets = new Map([['nero', urls(12)]])
    expect(clampImageSets(sets, EBAY_VARIATION_IMAGE_MAX, (k) => k)).toEqual([])
  })

  it('the exported eBay cap is 12 (multi-variation per-variation limit)', () => {
    expect(EBAY_VARIATION_IMAGE_MAX).toBe(12)
  })
})

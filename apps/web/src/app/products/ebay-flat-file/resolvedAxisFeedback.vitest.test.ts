/**
 * EFX P5 — resolved-axis feedback (describeResolvedAxis).
 *
 * The image modal calls this with the axis it REQUESTED and the publish
 * response's additive fields (pictureAxis / sharedGallery) to render
 * "Images vary by: X" / "Shared gallery" and to warn VISIBLY whenever the
 * publish landed with a different grouping than the operator picked.
 *
 * Run: npx vitest run apps/web/src/app/products/ebay-flat-file/resolvedAxisFeedback.vitest.test.ts
 */
import { describe, it, expect } from 'vitest'
import { describeResolvedAxis, SHARED_GALLERY_AXIS } from './variationValueOrder.pure'

describe('describeResolvedAxis', () => {
  it('returns null for responses that predate the feedback fields', () => {
    expect(describeResolvedAxis('Colore', 2, {})).toBeNull()
  })

  it('requested axis published as-is → label, no mismatch', () => {
    const fb = describeResolvedAxis('Colore', 2, { pictureAxis: 'Colore', sharedGallery: false })
    expect(fb).toEqual({ label: 'Images vary by: Colore', mismatch: false })
  })

  it('synonym-equivalent resolution (Color → Colore) is NOT a mismatch', () => {
    const fb = describeResolvedAxis('Color', 2, { pictureAxis: 'Colore', sharedGallery: false })
    expect(fb?.mismatch).toBe(false)
  })

  it("'__shared__' round-trip: requested shared, published shared → no mismatch", () => {
    const fb = describeResolvedAxis(SHARED_GALLERY_AXIS, undefined, { pictureAxis: null, sharedGallery: true })
    expect(fb?.mismatch).toBe(false)
    expect(fb?.label).toBe('Shared gallery — one image set for the whole listing')
  })

  it('requested shared but published varying → mismatch with visible warning', () => {
    const fb = describeResolvedAxis(SHARED_GALLERY_AXIS, undefined, { pictureAxis: 'Colore', sharedGallery: false })
    expect(fb?.mismatch).toBe(true)
    expect(fb?.warning).toContain('one shared gallery')
    expect(fb?.warning).toContain('"Colore"')
  })

  it('single-valued axis pick resolving to shared gallery is the ADVERTISED outcome → no mismatch', () => {
    const fb = describeResolvedAxis('Colore', 1, { pictureAxis: 'Colore', sharedGallery: true })
    expect(fb?.mismatch).toBe(false)
    expect(fb?.label).toContain('Shared gallery')
  })

  it('multi-valued axis pick resolving to shared gallery → mismatch (never silent)', () => {
    const fb = describeResolvedAxis('Colore', 3, { pictureAxis: 'Colore', sharedGallery: true })
    expect(fb?.mismatch).toBe(true)
    expect(fb?.warning).toContain('"Colore"')
  })

  it('server swapped to a different axis → mismatch with both axes named', () => {
    const fb = describeResolvedAxis('Tipo di prodotto', 2, { pictureAxis: 'Colore', sharedGallery: false })
    expect(fb?.mismatch).toBe(true)
    expect(fb?.warning).toContain('"Tipo di prodotto"')
    expect(fb?.warning).toContain('"Colore"')
  })
})

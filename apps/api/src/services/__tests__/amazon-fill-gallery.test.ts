/**
 * M6 verifier — gallery → Amazon slot mapping.
 */

import { describe, it, expect } from 'vitest'
import { planGalleryFill, type GalleryImage } from '../images/amazon-fill-gallery.service.js'

describe('planGalleryFill', () => {
  it('maps the primary image to MAIN and the rest to PT in order', () => {
    const g: GalleryImage[] = [
      { id: 'b', url: 'b', type: 'MAIN', isPrimary: true, sortOrder: 0 },
      { id: 'a', url: 'a', type: 'LIFESTYLE', isPrimary: false, sortOrder: 1 },
      { id: 'c', url: 'c', type: 'LIFESTYLE', isPrimary: false, sortOrder: 2 },
    ]
    const plan = planGalleryFill(g, 8)
    expect(plan[0]).toMatchObject({ slot: 'MAIN', sourceProductImageId: 'b' })
    expect(plan.slice(1).map((p) => p.slot)).toEqual(['PT01', 'PT02'])
    expect(plan[1]!.sourceProductImageId).toBe('a')
  })

  it('falls back to type MAIN, then first, when nothing is primary', () => {
    const g: GalleryImage[] = [
      { id: 'x', url: 'x', type: 'LIFESTYLE', isPrimary: false, sortOrder: 0 },
      { id: 'y', url: 'y', type: 'MAIN', isPrimary: false, sortOrder: 1 },
    ]
    expect(planGalleryFill(g, 8)[0]!.sourceProductImageId).toBe('y')
  })

  it('caps PT slots at ptCap', () => {
    const g: GalleryImage[] = Array.from({ length: 12 }, (_, i): GalleryImage => ({
      id: `i${i}`, url: `u${i}`, type: 'LIFESTYLE', isPrimary: i === 0, sortOrder: i,
    }))
    expect(planGalleryFill(g, 3)).toHaveLength(4) // MAIN + PT01..PT03
  })

  it('empty gallery → empty plan', () => {
    expect(planGalleryFill([], 8)).toEqual([])
  })
})

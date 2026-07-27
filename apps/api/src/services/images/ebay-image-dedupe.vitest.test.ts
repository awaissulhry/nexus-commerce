/**
 * Regression: GALE-JACKET-ALT2 (operator-reported 2026-07-27).
 *
 * Both colours were curated with 7 photos in Nexus but went live on eBay with
 * 6, and the surviving first image was a "LEVEL 2 PROTECTORS" marketing tile
 * instead of the jacket. Cause: the old P5 de-dupe subtracted the shared
 * "cover & common" pool from every per-colour set, and each colour's hero WAS
 * the cover shot. Verified against the real DB rows before the fix:
 *
 *   shared    = [vija9w5x(black), ttor0wjo(yellow)]
 *   Nero[0]   = vija9w5x   -> dropped
 *   Giallo[0] = ttor0wjo   -> dropped
 *
 * OPERATOR RULE: shared-pool images may be reused in ANY row and ANY position.
 * Curation goes to eBay verbatim, in order. These tests exist so a filter can
 * never be reintroduced silently.
 *
 * Run: npx vitest run src/services/images/ebay-image-dedupe.vitest.test.ts
 */
import { describe, it, expect } from 'vitest'
import { galleryForCuratedRow } from './ebay-inventory-image-publish.service.js'

const BLACK = 'https://cdn/vija9w5xgwhywwgdn4as.png'
const YELLOW = 'https://cdn/ttor0wjodwlefkjb8alj.png'

describe('galleryForCuratedRow — curation is sent verbatim', () => {
  it('keeps all 7 photos when the hero is also the cover shot (the exact bug)', () => {
    const nero = [BLACK, 'https://cdn/t2.jpg', 'https://cdn/t3.jpg', 'https://cdn/t4.jpg',
      'https://cdn/t5.jpg', 'https://cdn/t6.jpg', 'https://cdn/t7.jpg']
    const out = galleryForCuratedRow(nero)
    expect(out).toHaveLength(7)   // published 6 before the fix
    expect(out[0]).toBe(BLACK)    // hero survives -> eBay Principale
    expect(out).toEqual(nero)
  })

  it('keeps a shared-pool photo reused in the MIDDLE of a row, not just the hero', () => {
    // The operator may reuse a shared image anywhere; position is their choice.
    const giallo = [YELLOW, 'https://cdn/a.jpg', BLACK, 'https://cdn/b.jpg']
    expect(galleryForCuratedRow(giallo)).toEqual(giallo)
  })

  it('keeps a row composed ENTIRELY of shared-pool photos', () => {
    // The old rule returned [] here — a variation with no images at all.
    expect(galleryForCuratedRow([BLACK, YELLOW])).toEqual([BLACK, YELLOW])
  })

  it('preserves order exactly — eBay renders position order', () => {
    const urls = ['https://cdn/1.jpg', 'https://cdn/2.jpg', 'https://cdn/3.jpg']
    expect(galleryForCuratedRow(urls)).toEqual(urls)
  })

  it('returns a COPY, so a caller mutating the result cannot corrupt curation', () => {
    const urls = [BLACK, 'https://cdn/a.jpg']
    const out = galleryForCuratedRow(urls)
    out.push('https://cdn/injected.jpg')
    expect(urls).toHaveLength(2)
  })

  it('handles an empty row without throwing', () => {
    expect(galleryForCuratedRow([])).toEqual([])
  })
})

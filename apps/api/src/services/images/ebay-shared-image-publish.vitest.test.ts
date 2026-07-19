/**
 * EB-IMG Phase 1 — pure logic of the shell/adopted-listing image publish:
 * curated buckets → live-axis mapping → ReviseFixedPriceItem XML.
 */
import { describe, expect, it } from 'vitest'
import {
  buildReviseItemPicturesXml,
  buildSharedPicturePayload,
  type CuratedImageRow,
} from './ebay-shared-image-publish.service.js'

const row = (
  url: string,
  variantGroupKey: string | null = null,
  variantGroupValue: string | null = null,
  variationId: string | null = null,
): CuratedImageRow => ({ url, variantGroupKey, variantGroupValue, variationId })

const LIVE_IT = { Colore: ['Nero', 'Grigio', 'Verde'], Taglia: ['S', 'M', 'L'] }

describe('buildSharedPicturePayload', () => {
  it('maps the workspace axis (Color) onto the live Italian axis (Colore) with case-insensitive values', () => {
    const out = buildSharedPicturePayload({
      curated: [
        row('https://c/cover1.jpg'),
        row('https://c/nero1.jpg', 'Color', 'nero'),
        row('https://c/grigio1.jpg', 'Color', 'Grigio'),
      ],
      liveSpecificsSet: LIVE_IT,
      requestedAxis: 'Color',
    })
    expect(out.axisName).toBe('Colore')
    expect(out.byValue).toEqual({ Nero: ['https://c/nero1.jpg'], Grigio: ['https://c/grigio1.jpg'] })
    expect(out.galleryUrls).toEqual(['https://c/cover1.jpg'])
    expect(out.sharedGallery).toBe(false)
    expect(out.warnings).toEqual([])
  })

  it('skips values with no live variation and says so', () => {
    const out = buildSharedPicturePayload({
      curated: [row('https://c/giallo.jpg', 'Color', 'Giallo')],
      liveSpecificsSet: LIVE_IT,
      requestedAxis: 'Color',
    })
    expect(out.byValue).toEqual({})
    expect(out.warnings.some((w) => w.includes('Giallo'))).toBe(true)
    // Nothing matched → falls back to shared gallery semantics (no Pictures node).
    expect(out.axisName).toBeNull()
  })

  it('folds buckets into one gallery when the listing declares no matching axis', () => {
    const out = buildSharedPicturePayload({
      curated: [
        row('https://c/cover.jpg'),
        row('https://c/a.jpg', 'Color', 'Nero'),
        row('https://c/b.jpg', 'Color', 'Grigio'),
      ],
      liveSpecificsSet: { Taglia: ['S', 'M'] },
      requestedAxis: 'Color',
    })
    expect(out.axisName).toBeNull()
    expect(out.sharedGallery).toBe(true)
    expect(out.galleryUrls).toEqual(['https://c/cover.jpg', 'https://c/a.jpg', 'https://c/b.jpg'])
    expect(out.warnings.some((w) => w.includes('no matching image axis'))).toBe(true)
  })

  it('folds everything into the gallery on explicit __shared__ pick, no warning', () => {
    const out = buildSharedPicturePayload({
      curated: [row('https://c/cover.jpg'), row('https://c/a.jpg', 'Color', 'Nero')],
      liveSpecificsSet: LIVE_IT,
      requestedAxis: '__shared__',
    })
    expect(out.axisName).toBeNull()
    expect(out.galleryUrls).toEqual(['https://c/cover.jpg', 'https://c/a.jpg'])
    expect(out.warnings).toEqual([])
  })

  it('falls back to the curated rows own axis when no axis was requested', () => {
    const out = buildSharedPicturePayload({
      curated: [row('https://c/s.jpg', 'Size', 'M')],
      liveSpecificsSet: LIVE_IT,
      requestedAxis: null,
    })
    expect(out.axisName).toBe('Taglia')
    expect(out.byValue).toEqual({ M: ['https://c/s.jpg'] })
  })

  it('warns about per-SKU overrides and excludes them', () => {
    const out = buildSharedPicturePayload({
      curated: [row('https://c/sku.jpg', null, null, 'prod-123'), row('https://c/nero.jpg', 'Color', 'Nero')],
      liveSpecificsSet: LIVE_IT,
      requestedAxis: 'Color',
    })
    expect(out.warnings.some((w) => w.includes('per-SKU'))).toBe(true)
    expect(out.galleryUrls).toEqual([])
    expect(out.byValue.Nero).toEqual(['https://c/nero.jpg'])
  })

  it('gallery wins over sets (dedup) and both respect the 12 cap', () => {
    const shared = row('https://c/shared.jpg')
    const dupInSet = row('https://c/shared.jpg', 'Color', 'Nero')
    const many = Array.from({ length: 14 }, (_, i) => row(`https://c/n${i}.jpg`, 'Color', 'Nero'))
    const out = buildSharedPicturePayload({
      curated: [shared, dupInSet, ...many],
      liveSpecificsSet: LIVE_IT,
      requestedAxis: 'Color',
    })
    expect(out.byValue.Nero).toHaveLength(12)
    expect(out.byValue.Nero).not.toContain('https://c/shared.jpg')
    expect(out.warnings.some((w) => w.includes('caps variation sets'))).toBe(true)
  })

  it('drops a set that dedup empties entirely', () => {
    const out = buildSharedPicturePayload({
      curated: [row('https://c/x.jpg'), row('https://c/x.jpg', 'Color', 'Verde')],
      liveSpecificsSet: LIVE_IT,
      requestedAxis: 'Color',
    })
    expect(out.byValue).toEqual({})
    expect(out.axisName).toBeNull()
  })
})

describe('buildReviseItemPicturesXml', () => {
  it('builds gallery + variation picture sets in the Trading shape', () => {
    const xml = buildReviseItemPicturesXml({
      itemId: '256566101420',
      galleryUrls: ['https://c/cover.jpg'],
      axisName: 'Colore',
      byValue: { Nero: ['https://c/nero1.jpg', 'https://c/nero2.jpg'] },
    })
    expect(xml).toContain('<ReviseFixedPriceItemRequest')
    expect(xml).toContain('<ItemID>256566101420</ItemID>')
    expect(xml).toContain('<PictureDetails>')
    expect(xml).toContain('<PictureURL>https://c/cover.jpg</PictureURL>')
    expect(xml).toContain('<VariationSpecificName>Colore</VariationSpecificName>')
    expect(xml).toContain('<VariationSpecificValue>Nero</VariationSpecificValue>')
    expect(xml.indexOf('<PictureDetails>')).toBeLessThan(xml.indexOf('<Variations>'))
  })

  it('omits Variations for gallery-only publishes and escapes XML entities', () => {
    const xml = buildReviseItemPicturesXml({
      itemId: '1',
      galleryUrls: ['https://c/a.jpg?x=1&y=2'],
    })
    expect(xml).not.toContain('<Variations>')
    expect(xml).toContain('x=1&amp;y=2')
  })
})

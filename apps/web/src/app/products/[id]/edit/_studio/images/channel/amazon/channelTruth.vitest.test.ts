/**
 * PES.7 — live-vs-Nexus drift, and what the stale answer can support.
 * The identity test is the load-bearing one: every URL the matrix renders is CDN-rewritten, so a
 * naive string compare would report drift on every cell.
 */
import { describe, expect, it } from 'vitest'

import { findDrift, imageIdentity, sameImage, staleActionability, type LiveImage } from './channelTruth'

const live = (p: Partial<LiveImage> & { url: string }): LiveImage =>
  ({ marketplace: 'IT', externalSku: 'SKU-1', asin: 'B01', slot: 'MAIN', fetchedAt: '2026-09-01T00:00:00Z', ...p })

const CLOUD = 'https://res.cloudinary.com/x/image/upload/v1780/product-images/p1/abc.jpg'
const CLOUD_SIZED = 'https://res.cloudinary.com/x/image/upload/w_360,c_fit,f_auto,q_auto/v1780/product-images/p1/abc.jpg'
const CLOUD_OTHER = 'https://res.cloudinary.com/x/image/upload/v1780/product-images/p1/zzz.jpg'

describe('sameImage — the same picture through a different CDN transform', () => {
  it('treats a sized rendition as the SAME picture as its original', () => {
    // Without this every cell would report drift, because the matrix renders through cdnFit.
    expect(sameImage(CLOUD, CLOUD_SIZED)).toBe(true)
  })

  it('still distinguishes genuinely different pictures', () => {
    expect(sameImage(CLOUD, CLOUD_OTHER)).toBe(false)
  })

  it('strips an Amazon size modifier before comparing', () => {
    expect(sameImage('https://m.media-amazon.com/images/I/71abcDEF.jpg',
                     'https://m.media-amazon.com/images/I/71abcDEF._SL1500_.jpg')).toBe(true)
  })

  it('does not treat two different Amazon assets as one', () => {
    expect(sameImage('https://m.media-amazon.com/images/I/71abcDEF.jpg',
                     'https://m.media-amazon.com/images/I/99zzzZZZ.jpg')).toBe(false)
  })

  it('handles nulls without pretending they match a picture', () => {
    expect(sameImage(null, null)).toBe(true)
    expect(sameImage(CLOUD, null)).toBe(false)
  })

  it('keeps the identity stable across the transforms the app actually emits', () => {
    expect(imageIdentity(CLOUD)).toBe(imageIdentity(CLOUD_SIZED))
  })
})

describe('findDrift', () => {
  it('reports a slot where Amazon and Nexus hold different pictures', () => {
    const d = findDrift({ live: [live({ url: CLOUD })], resolvedBySlot: { MAIN: CLOUD_OTHER }, market: 'IT' })
    expect(d).toHaveLength(1)
    expect(d[0].kind).toBe('different')
  })

  it('reports nothing when they hold the same picture at a different size', () => {
    expect(findDrift({ live: [live({ url: CLOUD })], resolvedBySlot: { MAIN: CLOUD_SIZED }, market: 'IT' })).toEqual([])
  })

  it('reports a picture Amazon has that Nexus does not resolve', () => {
    const d = findDrift({ live: [live({ url: CLOUD, slot: 'PT01' })], resolvedBySlot: {}, market: 'IT' })
    expect(d[0].kind).toBe('onlyOnChannel')
    expect(d[0].sku).toBe('SKU-1')
  })

  it('reports a picture Nexus resolves that Amazon does not have', () => {
    const d = findDrift({ live: [], resolvedBySlot: { PT02: CLOUD }, market: 'IT' })
    expect(d[0].kind).toBe('onlyInNexus')
  })

  it('ignores a slot neither side has — that is empty, not drift', () => {
    expect(findDrift({ live: [], resolvedBySlot: { PT03: null }, market: 'IT' })).toEqual([])
  })

  it('never compares one market against another', () => {
    const d = findDrift({ live: [live({ url: CLOUD, marketplace: 'DE' })], resolvedBySlot: { MAIN: CLOUD_OTHER }, market: 'IT' })
    // The DE row must not be read as IT drift; IT simply has a picture Amazon-IT does not.
    expect(d).toHaveLength(1)
    expect(d[0].kind).toBe('onlyInNexus')
  })
})

describe('staleActionability — do not offer an action that cannot act', () => {
  it('offers re-publish when there are variant targets', () => {
    const s = staleActionability({ totalStaleRows: 4, staleAsins: ['B01'], staleVariantIds: ['v1'] })
    expect(s.canRepublish).toBe(true)
    expect(s.note).toBeNull()
  })

  it('🔴 shows the count but REFUSES the action when nothing can be targeted', () => {
    // The measured shape on GALE-JACKET: 23 stale rows, zero named variants.
    const s = staleActionability({ totalStaleRows: 23, staleAsins: [], staleVariantIds: [] })
    expect(s.count).toBe(23)
    expect(s.canRepublish).toBe(false)
    expect(s.note).toMatch(/no per-variant targets/)
  })

  it('says nothing at all when nothing is stale', () => {
    expect(staleActionability({ totalStaleRows: 0, staleAsins: [], staleVariantIds: [] }))
      .toEqual({ count: 0, canRepublish: false, note: null })
  })

  it('treats an unanswered stale check as nothing to report, not as clean', () => {
    expect(staleActionability(null).count).toBe(0)
  })
})

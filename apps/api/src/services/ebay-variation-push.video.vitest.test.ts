/**
 * EFX P9d — unit tests for the pure listing-video mapper + its round-trip.
 *
 *  resolveVideoIds → eBay Inventory API inventory item product.videoIds
 *  buildFlatRow / packSharedFields → video_id ⇄ platformAttributes.videoId
 *
 * eBay allows ONE video per listing (Media-API videoId), so a supplied id maps
 * to a single-element array; blank/invalid values are omitted (never sent).
 */

import { describe, it, expect } from 'vitest'
import {
  resolveVideoIds,
  buildFlatRow,
  packSharedFields,
} from './ebay-variation-push.service.js'

describe('resolveVideoIds', () => {
  it('present videoId → single-element array', () => {
    expect(resolveVideoIds('v1|1234567890|0')).toEqual(['v1|1234567890|0'])
    expect(resolveVideoIds('  8765432109  ')).toEqual(['8765432109']) // trimmed
  })

  it('blank / null / undefined / whitespace-only → undefined (field omitted)', () => {
    expect(resolveVideoIds('')).toBeUndefined()
    expect(resolveVideoIds('   ')).toBeUndefined()
    expect(resolveVideoIds(null)).toBeUndefined()
    expect(resolveVideoIds(undefined)).toBeUndefined()
  })

  it('a URL (classic wrong paste) → omitted + warned', () => {
    const warnings: string[] = []
    expect(resolveVideoIds('https://youtu.be/abc123', warnings)).toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('videoId')
  })

  it('a value with internal whitespace → omitted + warned', () => {
    const warnings: string[] = []
    expect(resolveVideoIds('not a video id', warnings)).toBeUndefined()
    expect(warnings).toHaveLength(1)
  })

  it('invalid value with no sink → silently omitted (no throw)', () => {
    expect(resolveVideoIds('http://x.mp4')).toBeUndefined()
  })

  it('warning sink dedups identical warnings', () => {
    const warnings: string[] = []
    resolveVideoIds('https://x/v.mp4', warnings)
    resolveVideoIds('https://x/v.mp4', warnings)
    expect(warnings).toHaveLength(1)
  })
})

describe('buildFlatRow / packSharedFields — video_id round-trip', () => {
  function makeProductWithVideoId(videoId: string | undefined): Parameters<typeof buildFlatRow>[0] {
    return {
      id: 'prod-1',
      sku: 'SKU-001',
      name: 'Test Product',
      ean: null,
      parentId: null,
      isParent: true,
      variationTheme: null,
      categoryAttributes: null,
      variantAttributes: null,
      brand: null,
      images: [],
      channelListings: videoId === undefined ? [] : [{
        id: 'cl-1',
        region: 'IT',
        externalListingId: null,
        title: 'Test',
        description: '',
        price: null,
        quantity: 0,
        platformAttributes: { videoId },
        listingStatus: 'DRAFT',
        offerActive: false,
        syncStatus: 'pending',
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      }],
    }
  }

  it('buildFlatRow emits video_id from platformAttributes.videoId', () => {
    const row = buildFlatRow(makeProductWithVideoId('v1|555|0'))
    expect(row.video_id).toBe('v1|555|0')
  })

  it('buildFlatRow defaults video_id to "" when absent', () => {
    expect(buildFlatRow(makeProductWithVideoId(undefined)).video_id).toBe('')
  })

  it('packSharedFields writes trimmed videoId back into platformAttributes', () => {
    const packed = packSharedFields({ video_id: '  v1|555|0  ' })
    expect((packed.platformAttributes as Record<string, unknown>).videoId).toBe('v1|555|0')
  })

  it('packSharedFields stores "" when video_id blank', () => {
    const packed = packSharedFields({})
    expect((packed.platformAttributes as Record<string, unknown>).videoId).toBe('')
  })
})

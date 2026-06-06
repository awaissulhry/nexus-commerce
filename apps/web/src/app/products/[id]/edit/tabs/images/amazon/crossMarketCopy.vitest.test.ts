import { describe, it, expect } from 'vitest'
import { buildCrossMarketUpserts, SHARED_TARGET } from './crossMarketCopy'
import type { CellDisplay } from './useAmazonImages'
import type { ListingImage } from '../types'

const cell = (over: Partial<CellDisplay> & { url: string }): CellDisplay => ({
  origin: 'own',
  isPending: false,
  ...over,
})

// Source (IT) shows: MAIN (master-linked) + PT01; everything else empty.
const resolveCell = (g: string | null, slot: string): CellDisplay | null => {
  if (g === null && slot === 'MAIN') return cell({ url: 'main.jpg', listingImageId: 'src-main', masterImageId: 'm1' })
  if (g === null && slot === 'PT01') return cell({ url: 'pt01.jpg' })
  return null
}

const base = { sourceMarketplace: 'IT', activeAxis: 'Color', resolveCell, listingImages: [] as ListingImage[] }

describe('buildCrossMarketUpserts', () => {
  it('copies non-empty source slots to a target market (MARKETPLACE scope), skips empty', () => {
    const u = buildCrossMarketUpserts({ ...base, targets: ['DE'], slots: ['MAIN', 'PT01', 'PT02'], groups: [null] })
    expect(u).toHaveLength(2) // PT02 empty → skipped
    expect(u[0]).toMatchObject({ scope: 'MARKETPLACE', marketplace: 'DE', platform: 'AMAZON', amazonSlot: 'MAIN', url: 'main.jpg', sourceProductImageId: 'm1' })
    expect(u[1]).toMatchObject({ amazonSlot: 'PT01', url: 'pt01.jpg', marketplace: 'DE' })
  })

  it('per-slot copy fans out to multiple targets at the same slot', () => {
    const u = buildCrossMarketUpserts({ ...base, targets: ['DE', 'FR'], slots: ['MAIN'], groups: [null] })
    expect(u.map((x) => x.marketplace)).toEqual(['DE', 'FR'])
    expect(u.every((x) => x.amazonSlot === 'MAIN')).toBe(true)
  })

  it('SHARED target → PLATFORM scope, marketplace null', () => {
    const u = buildCrossMarketUpserts({ ...base, targets: [SHARED_TARGET], slots: ['MAIN'], groups: [null] })
    expect(u[0]).toMatchObject({ scope: 'PLATFORM', marketplace: null, amazonSlot: 'MAIN' })
  })

  it('replaces the target existing slot in place (sets id → update, swaps url)', () => {
    const existing = {
      id: 'de-main', productId: 'p', variationId: null, scope: 'MARKETPLACE', platform: 'AMAZON',
      marketplace: 'DE', amazonSlot: 'MAIN', variantGroupKey: null, variantGroupValue: null,
      url: 'old.jpg', filename: null, position: 0, role: 'MAIN', width: null, height: null,
      fileSize: null, mimeType: null, hasWhiteBackground: null, sourceProductImageId: null,
      publishStatus: 'PUBLISHED', publishedAt: null, publishError: null, uploadedAt: '', altOverride: null,
    } as ListingImage
    const u = buildCrossMarketUpserts({ ...base, listingImages: [existing], targets: ['DE'], slots: ['MAIN'], groups: [null] })
    expect(u[0]!.id).toBe('de-main')
    expect(u[0]!.url).toBe('main.jpg')
  })

  it('never copies a market onto itself', () => {
    const u = buildCrossMarketUpserts({ ...base, targets: ['IT', 'DE'], slots: ['MAIN'], groups: [null] })
    expect(u.every((x) => x.marketplace === 'DE')).toBe(true)
  })
})

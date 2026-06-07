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
const C = (slot: string, group: string | null = null) => ({ group, slot })

describe('buildCrossMarketUpserts', () => {
  it('copies the selected cells to a target market, skipping empty source cells', () => {
    const u = buildCrossMarketUpserts({ ...base, targets: ['DE'], cells: [C('MAIN'), C('PT01'), C('PT02')] })
    expect(u).toHaveLength(2) // PT02 empty → skipped
    expect(u[0]).toMatchObject({ scope: 'MARKETPLACE', marketplace: 'DE', platform: 'AMAZON', amazonSlot: 'MAIN', url: 'main.jpg', sourceProductImageId: 'm1' })
    expect(u[1]).toMatchObject({ amazonSlot: 'PT01', url: 'pt01.jpg', marketplace: 'DE' })
  })

  it('fans a single cell out to multiple targets at the same placement', () => {
    const u = buildCrossMarketUpserts({ ...base, targets: ['DE', 'FR'], cells: [C('MAIN')] })
    expect(u.map((x) => x.marketplace)).toEqual(['DE', 'FR'])
    expect(u.every((x) => x.amazonSlot === 'MAIN')).toBe(true)
  })

  it('carries the variant group through (per-color cell)', () => {
    const rc = (g: string | null, slot: string) => (g === 'Black' && slot === 'PT03' ? cell({ url: 'blk-pt03.jpg' }) : null)
    const u = buildCrossMarketUpserts({ ...base, resolveCell: rc, targets: ['DE'], cells: [C('PT03', 'Black')] })
    expect(u[0]).toMatchObject({ amazonSlot: 'PT03', variantGroupKey: 'Color', variantGroupValue: 'Black', url: 'blk-pt03.jpg' })
  })

  it('SHARED target → PLATFORM scope, marketplace null', () => {
    const u = buildCrossMarketUpserts({ ...base, targets: [SHARED_TARGET], cells: [C('MAIN')] })
    expect(u[0]).toMatchObject({ scope: 'PLATFORM', marketplace: null, amazonSlot: 'MAIN' })
  })

  it('replaces the target existing cell in place (sets id → update, swaps url)', () => {
    const existing = {
      id: 'de-main', productId: 'p', variationId: null, scope: 'MARKETPLACE', platform: 'AMAZON',
      marketplace: 'DE', amazonSlot: 'MAIN', variantGroupKey: null, variantGroupValue: null,
      url: 'old.jpg', filename: null, position: 0, role: 'MAIN', width: null, height: null,
      fileSize: null, mimeType: null, hasWhiteBackground: null, sourceProductImageId: null,
      publishStatus: 'PUBLISHED', publishedAt: null, publishError: null, uploadedAt: '', altOverride: null,
    } as ListingImage
    const u = buildCrossMarketUpserts({ ...base, listingImages: [existing], targets: ['DE'], cells: [C('MAIN')] })
    expect(u[0]!.id).toBe('de-main')
    expect(u[0]!.url).toBe('main.jpg')
  })

  it('never copies a market onto itself', () => {
    const u = buildCrossMarketUpserts({ ...base, targets: ['IT', 'DE'], cells: [C('MAIN')] })
    expect(u.every((x) => x.marketplace === 'DE')).toBe(true)
  })
})

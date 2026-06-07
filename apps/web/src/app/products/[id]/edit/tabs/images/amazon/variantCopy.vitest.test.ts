import { describe, it, expect } from 'vitest'
import { buildVariantCopyUpserts } from './variantCopy'
import type { CellDisplay } from './useAmazonImages'
import type { ListingImage } from '../types'

const cell = (over: Partial<CellDisplay> & { url: string }): CellDisplay => ({ origin: 'own', isPending: false, ...over })

// Source colour "Giallo": MAIN + PT01 filled.
const resolveCell = (g: string | null, slot: string): CellDisplay | null => {
  if (g === 'Giallo' && slot === 'MAIN') return cell({ url: 'g-main.jpg', listingImageId: 's1', masterImageId: 'm1' })
  if (g === 'Giallo' && slot === 'PT01') return cell({ url: 'g-pt01.jpg' })
  return null
}
const base = { activeAxis: 'Color', activeMarketplace: 'ALL', resolveCell, listingImages: [] as ListingImage[] }
const C = (slot: string, group = 'Giallo') => ({ group, slot })

describe('buildVariantCopyUpserts', () => {
  it('copies selected cells to a target variant at the same slot (PLATFORM on ALL)', () => {
    const u = buildVariantCopyUpserts({ ...base, cells: [C('MAIN'), C('PT01'), C('PT02')], targetGroups: ['Nero'] })
    expect(u).toHaveLength(2) // PT02 empty → skipped
    expect(u[0]).toMatchObject({ scope: 'PLATFORM', marketplace: null, variantGroupKey: 'Color', variantGroupValue: 'Nero', amazonSlot: 'MAIN', url: 'g-main.jpg', sourceProductImageId: 'm1' })
    expect(u[1]).toMatchObject({ variantGroupValue: 'Nero', amazonSlot: 'PT01', url: 'g-pt01.jpg' })
  })

  it('fans out to multiple target variants', () => {
    const u = buildVariantCopyUpserts({ ...base, cells: [C('MAIN')], targetGroups: ['Nero', 'Rosso'] })
    expect(u.map((x) => x.variantGroupValue)).toEqual(['Nero', 'Rosso'])
  })

  it('lands at MARKETPLACE scope on a specific market', () => {
    const u = buildVariantCopyUpserts({ ...base, activeMarketplace: 'IT', cells: [C('MAIN')], targetGroups: ['Nero'] })
    expect(u[0]).toMatchObject({ scope: 'MARKETPLACE', marketplace: 'IT' })
  })

  it('never copies a variant onto itself', () => {
    const u = buildVariantCopyUpserts({ ...base, cells: [C('MAIN')], targetGroups: ['Giallo', 'Nero'] })
    expect(u.every((x) => x.variantGroupValue === 'Nero')).toBe(true)
  })

  it('replaces the target variant cell in place (sets id) and skips locked targets', () => {
    const nero = (slot: string, locked = false) => ({
      id: `n-${slot}`, productId: 'p', variationId: null, scope: 'PLATFORM', platform: 'AMAZON',
      marketplace: null, amazonSlot: slot, variantGroupKey: 'Color', variantGroupValue: 'Nero',
      url: 'old.jpg', filename: null, position: 0, role: 'GALLERY', width: null, height: null,
      fileSize: null, mimeType: null, hasWhiteBackground: null, sourceProductImageId: null,
      publishStatus: 'PUBLISHED', publishedAt: null, publishError: null, uploadedAt: '', altOverride: null,
      mediaType: 'IMAGE', posterUrl: null, durationSec: null, sourceAssetId: null, locked,
    } as ListingImage)
    const u = buildVariantCopyUpserts({ ...base, listingImages: [nero('MAIN'), nero('PT01', true)], cells: [C('MAIN'), C('PT01')], targetGroups: ['Nero'] })
    expect(u).toHaveLength(1) // PT01 target locked → skipped
    expect(u[0]!.id).toBe('n-MAIN')
    expect(u[0]!.url).toBe('g-main.jpg')
  })
})

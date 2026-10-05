import { describe, expect, it } from 'vitest'
import { AMAZON_ALIAS_PHOTOS } from '@nexus/shared/product-media'
import { mediaListingName, withProductMediaColumn } from './productMediaColumn'
import { mediaReadOnlyReason, type MediaRow } from './useMediaCellActions'
import type { StudioRow } from '../sheet/channel/types'
import type { SheetColumn } from '../sheet/master/types'

const column = (key: string, extra: Partial<SheetColumn> = {}) => ({ key, label: key, ...extra } as SheetColumn)
describe('one Product media workspace in every sheet', () => {
  it('replaces an owned Etsy API field with one gallery and keeps unrelated columns', () => {
    const input = [column('name'), column('description'), column('image_ids', { managedBy: 'productMedia' }), column('file_data')]
    expect(withProductMediaColumn(input).map(c => c.key)).toEqual(['name', 'description', 'productMedia', 'file_data'])
    expect(input.map(c => c.key)).toContain('image_ids')
  })
  it('removes duplicates even when a gallery already exists, preserving its position and options', () => {
    const gallery = column('productMedia', { width: 310 })
    const input = [column('sku'), gallery, column('image_ids', { managedBy: 'productMedia' })]
    const result = withProductMediaColumn(input)
    expect(result).toEqual([input[0], gallery])
    expect(withProductMediaColumn(result)).toEqual(result)
  })
  it('keeps the established shared-sheet layout for eBay, Amazon and Shopify', () => {
    for (const input of [[column('sku'), column('description')], [column('sku'), column('description'), column('media', { label: 'Product media' })]])
      expect(withProductMediaColumn(input).map(c => c.key)).toEqual(['sku', 'description', 'productMedia'])
    expect(withProductMediaColumn([column('unrelated_ids')]).map(c => c.key)).toEqual(['productMedia', 'unrelated_ids'])
  })
  it('stays after Description when the Languages menu splits it per language (2026-09-27)', () => {
    const input = [column('name@it'), column('name@de'), column('description@it'), column('description@de'), column('brand')]
    expect(withProductMediaColumn(input).map(c => c.key)).toEqual(['name@it', 'name@de', 'description@it', 'description@de', 'productMedia', 'brand'])
  })
})

/** Owner 2026-10-05 — the sheet manages every listing alias, photos included: the pop-up names the row's listing as its band does. */
describe('the Product media pop-up names the listing as the sheet band does (DS AliasMark)', () => {
  it('an alias by its mark and its label: ALT1 at position 1 is "① ALT1", never "Listing 2"', () => {
    expect(mediaListingName(1, 'ALT1', 3)).toBe('① ALT1')
    expect(mediaListingName(2, ' ALT2 ', 3)).toBe('② ALT2')
    expect(mediaListingName(1, 'ALT1', 3)).not.toContain('Listing 2')
  })
  it('the main listing: "★ Main listing" beside its aliases, plain "Main listing" when it is the only one', () => {
    expect(mediaListingName(0, 'Primary', 2)).toBe('★ Main listing')
    expect(mediaListingName(0, null, 1)).toBe('Main listing')
  })
  it('an alias with no label reads as the mark\'s own name', () => {
    expect(mediaListingName(1, null, 2)).toBe('① Listing alias 1')
    expect(mediaListingName(1, '  ', 1)).toBe('Listing alias 1')
  })
})

describe('an Amazon alias row shows the main listing\'s photos, read-only (Owner 2026-10-05)', () => {
  it('the row\'s mark gives the server\'s reason; any other row has none', () => {
    const row = { id: 'p1', aliasId: 'alias-1', productMediaFollows: 'main-listing' } as Pick<StudioRow, 'productMediaFollows'> & { id: string; aliasId: string }
    const media: MediaRow = row
    expect(mediaReadOnlyReason(media)).toBe(AMAZON_ALIAS_PHOTOS)
    expect(AMAZON_ALIAS_PHOTOS).toBe('Amazon shows one photo set per product. These are the Main listing\'s photos; change them on the Main listing.')
    expect(mediaReadOnlyReason({})).toBe('')
  })
})

import { describe, expect, it } from 'vitest'
import { withProductMediaColumn } from './productMediaColumn'
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
})

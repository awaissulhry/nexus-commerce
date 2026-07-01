import { describe, it, expect } from 'vitest'
import { resolveIssueColumns, type ManifestColumnLite } from './feed-attribute-columns.js'

const cols: ManifestColumnLite[] = [
  { id: 'item_sku', label: 'SKU' },
  { id: 'item_name', label: 'Item name' },
  { id: 'main_product_image_locator', label: 'Main product image' },
  { id: 'bullet_point_1', label: 'Bullet 1' },
  { id: 'bullet_point_2', label: 'Bullet 2' },
  { id: 'bullet_point_3', label: 'Bullet 3' },
  { id: 'purchasable_offer__our_price', label: 'Our price' },
  { id: 'purchasable_offer__currency', label: 'Currency' },
]

describe('resolveIssueColumns', () => {
  it('resolves an exact attribute to its labeled column (the 20017 image case)', () => {
    expect(resolveIssueColumns(['main_product_image_locator'], cols))
      .toEqual([{ id: 'main_product_image_locator', label: 'Main product image' }])
  })

  it('expands a compound attribute to all numbered columns', () => {
    expect(resolveIssueColumns(['bullet_point'], cols).map((c) => c.id))
      .toEqual(['bullet_point_1', 'bullet_point_2', 'bullet_point_3'])
  })

  it('expands a `__`-nested compound attribute', () => {
    expect(resolveIssueColumns(['purchasable_offer'], cols).map((c) => c.id))
      .toEqual(['purchasable_offer__our_price', 'purchasable_offer__currency'])
  })

  it('degrades gracefully for an unmapped attribute (never crashes)', () => {
    expect(resolveIssueColumns(['some_new_amazon_attr'], cols))
      .toEqual([{ id: 'some_new_amazon_attr', label: 'some_new_amazon_attr' }])
  })

  it('dedupes across multiple attributeNames + skips blanks', () => {
    const out = resolveIssueColumns(['item_name', '', 'item_name', 'bullet_point'], cols)
    expect(out.map((c) => c.id)).toEqual(['item_name', 'bullet_point_1', 'bullet_point_2', 'bullet_point_3'])
  })
})

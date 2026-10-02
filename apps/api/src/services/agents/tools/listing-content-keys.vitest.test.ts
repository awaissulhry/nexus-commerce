import { describe, expect, it } from 'vitest'
import { isListingContentKey } from './listing-content-keys.js'

describe('isListingContentKey', () => {
  it('names the text fields, with or without attr_, a channel prefix or a slot number', () => {
    for (const key of ['title', 'attr_title', 'attr_amazon_title', 'ebay_description', 'attr_product_description', 'attr_item_name',
      'bullet_point', 'attr_bullet_point_3', 'bulletPoints', 'attr_generic_keyword', 'keywords', 'search_terms', 'attr_tags']) {
      expect(isListingContentKey(key), key).toBe(true)
    }
  })

  it('leaves attributes that only end in a text word to set-listing-fields (Amazon Age Range, 2026-10-02)', () => {
    for (const key of ['attr_age_range_description', 'attr_item_length_description', 'attr_item_type_name', 'attr_model_name',
      'attr_color', 'attr_style', 'attr_title_case', 'attr_subtitle']) {
      expect(isListingContentKey(key), key).toBe(false)
    }
  })
})

/**
 * CHMAP M7 — shared defaults read by more than one path. A change here changes every reader at once, so the exact
 * values are pinned; change them on purpose, with the readers' tests.
 */
import { expect, it } from 'vitest'
import { AMAZON_LISTING_SKU_KEYS } from './defaults.js'

it('the import and the product-sheet push look for a listing\'s Amazon seller SKU in the same places, in the same order', () => {
  expect(AMAZON_LISTING_SKU_KEYS).toEqual({ platformAttributes: ['sellerSku', 'seller_sku', 'sku', 'item_sku'], flatFileSnapshot: ['item_sku'] })
})

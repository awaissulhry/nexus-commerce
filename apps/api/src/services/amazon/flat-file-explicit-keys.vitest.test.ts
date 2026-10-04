/**
 * CHMAP M4 — the feed and the saved attributes read ONE list of case-by-case columns. These are the two literal
 * lists it replaced, character for character: a change to either set is a payload change and needs its own review.
 * U4b — restock date and always available joined it: they belong to the one fulfilment root (`flatFileFulfilmentRoot`),
 * and the generic loop that handled them replaced that root and lost the code and the quantity.
 */
import { expect, it } from 'vitest'
import { FEED_EXPLICIT_KEYS, SAVED_EXPLICIT_KEYS } from './flat-file.service.js'

const SHARED = ['item_sku', 'product_type', 'record_action', 'parentage_level', 'parent_sku', 'variation_theme', 'item_name', 'brand',
  'product_description', 'bullet_point', 'generic_keyword', 'color', 'main_product_image_locator', 'purchasable_offer',
  'purchasable_offer__condition_type', 'purchasable_offer__currency', 'purchasable_offer__our_price', 'purchasable_offer__sale_price',
  'purchasable_offer__sale_from_date', 'purchasable_offer__sale_end_date', 'fulfillment_availability',
  'fulfillment_availability__fulfillment_channel_code', 'fulfillment_availability__quantity', 'fulfillment_availability__lead_time_to_ship_max_days',
  'fulfillment_availability__restock_date', 'fulfillment_availability__is_inventory_available']

it('the feed keeps exactly its old list: the shared columns plus the product identifier', () => {
  expect([...FEED_EXPLICIT_KEYS].sort()).toEqual([...SHARED, 'external_product_id', 'external_product_id_type'].sort())
})

it('the saved attributes keep exactly their old list: the shared columns plus standard_price', () => {
  expect([...SAVED_EXPLICIT_KEYS].sort()).toEqual([...SHARED, 'standard_price'].sort())
})

/**
 * Amazon sheet gaps — the offer/fulfilment registry covers every key Amazon's schema gives these roots (the cached
 * IT/OUTERWEAR definition; all 181 cached rule sets carry the same sub-attributes, checked 2026-10-02), and the
 * channel spec takes its stores and holds from it.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { amazonSpecFromDefinition, AMAZON_FULFILMENT_KEY } from '../pim/channel-specs/amazon.js'
import {
  AMAZON_OFFER_FIELDS, AMAZON_OFFER_LEAVES, AMAZON_OFFER_OUT_OF_SCOPE, QUANTITY_HELD_REASON, amazonOfferFieldFor, amazonOfferKeysOf,
  amazonOfferLeafRefusal, amazonOfferLivePath, isAmazonOfferDraftKey, rootOfLeaf,
} from './offer-fields.js'

const here = dirname(fileURLToPath(import.meta.url))
const def = JSON.parse(readFileSync(join(here, '../pim/channel-specs/__tests__/fixtures/amazon-it-outerwear.trimmed.json'), 'utf8'))
const spec = amazonSpecFromDefinition({ marketplace: 'IT', productType: 'OUTERWEAR', schemaDefinition: def })
const ROOTS = ['purchasable_offer', 'fulfillment_availability', 'list_price']

describe('coverage — every offer / fulfilment / RRP key in the schema is in the registry or explicitly out of scope', () => {
  it('every spec key of the three roots has a registry entry', () => {
    const keys = spec.fields.filter((f) => ROOTS.includes(f.attribute)).map((f) => f.key)
    expect(keys.length).toBeGreaterThan(10)
    for (const key of keys) expect(amazonOfferFieldFor(key), key).not.toBeNull()
  })

  it('every sub-property of the three roots is a registry key, one of its sub-leaves, or out of scope', () => {
    for (const root of ROOTS) {
      for (const sub of Object.keys(def.properties[root].items.properties)) {
        const key = root === 'list_price' && sub === 'value_with_tax' ? 'list_price' : `${root}__${sub}`
        const covered = !!amazonOfferFieldFor(key) || AMAZON_OFFER_FIELDS.some((f) => f.key.startsWith(`${key}__`)) || key in AMAZON_OFFER_OUT_OF_SCOPE
        expect(covered, key).toBe(true)
      }
    }
  })

  it('every registry key exists in the schema (no invented column)', () => {
    const keys = new Set(spec.fields.map((f) => f.key))
    for (const f of AMAZON_OFFER_FIELDS) expect(keys.has(f.key), f.key).toBe(true)
  })

  it('every leaf has its keys; the sale is three keys of one leaf; quantity and fulfilment method are never drafts', () => {
    for (const leaf of AMAZON_OFFER_LEAVES) expect(amazonOfferKeysOf(leaf).length, leaf).toBeGreaterThan(0)
    expect(amazonOfferKeysOf('sale').sort()).toEqual([
      'purchasable_offer__discounted_price__end_at', 'purchasable_offer__discounted_price__start_at', 'purchasable_offer__discounted_price__value_with_tax',
    ])
    expect(amazonOfferFieldFor('fulfillment_availability__quantity')).toMatchObject({ leaf: null, lane: 'matrix', writeService: 'writeMatrixCells' })
    expect(amazonOfferFieldFor(AMAZON_FULFILMENT_KEY)).toMatchObject({ leaf: null, lane: 'matrix', writeService: 'setFulfillmentMethod' })
    expect(isAmazonOfferDraftKey('attr_purchasable_offer__map_price')).toBe(true)
    expect(isAmazonOfferDraftKey('fulfillment_availability__quantity')).toBe(false)
  })

  it('fulfilment settings are FBM-only and EU-shared; offer leaves apply on FBA and are per market', () => {
    for (const f of AMAZON_OFFER_FIELDS.filter((x) => x.leaf && rootOfLeaf(x.leaf) === 'fulfillment_availability')) {
      expect(f).toMatchObject({ fbaApplies: false, euShared: true, writeService: 'setAmazonFulfilmentSettings' })
    }
    for (const f of AMAZON_OFFER_FIELDS.filter((x) => x.leaf && rootOfLeaf(x.leaf) === 'purchasable_offer')) {
      expect(f).toMatchObject({ fbaApplies: true, euShared: false, writeService: 'writeChannelPrices' })
    }
  })
})

describe('stores', () => {
  it('live paths: amazonOffer.* / amazonFulfillment.*; the price facts live in the price columns', () => {
    expect(amazonOfferLivePath('minimum_seller_allowed_price')).toEqual(['amazonOffer', 'minimum_seller_allowed_price'])
    expect(amazonOfferLivePath('offer_start_at')).toEqual(['amazonOffer', 'start_at'])
    expect(amazonOfferLivePath('automated_pricing_rule_id')).toEqual(['amazonOffer', 'automated_pricing_rule_id'])
    expect(amazonOfferLivePath('lead_time_to_ship_max_days')).toEqual(['amazonFulfillment', 'lead_time_to_ship_max_days'])
    expect(amazonOfferLivePath('our_price')).toBeNull()
    expect(amazonOfferLivePath('sale')).toBeNull()
  })

  it('the channel spec carries the registry\'s stores (with Amazon\'s report as the fallback paths) and holds', () => {
    const byKey = new Map(spec.fields.map((f) => [f.key, f]))
    expect(byKey.get('purchasable_offer__our_price')!.channelStore).toEqual({ kind: 'listingColumn', column: 'price', followFlag: 'followMasterPrice' })
    expect(byKey.get('purchasable_offer__map_price')!.channelStore).toEqual({ kind: 'platformAttributes', path: ['amazonOffer', 'map_price'],
      legacyPaths: [['attributes', 'purchasable_offer', '0', 'map_price', '0', 'schedule', '0', 'value_with_tax'], ['purchasable_offer', '0', 'map_price', '0', 'schedule', '0', 'value_with_tax']] })
    expect(byKey.get('fulfillment_availability__restock_date')!.channelStore).toEqual({ kind: 'platformAttributes', path: ['amazonFulfillment', 'restock_date'],
      legacyPaths: [['attributes', 'fulfillment_availability', '0', 'restock_date'], ['fulfillment_availability', '0', 'restock_date']] })
    expect(byKey.get('fulfillment_availability__quantity')!.editHeldReason).toBe(QUANTITY_HELD_REASON)
    // No registry key is channel-owned: their mapping and source owner stay (readOnlyReason would delete them).
    for (const f of spec.fields.filter((x) => ROOTS.includes(x.attribute))) expect(f.readOnlyReason, f.key).toBeUndefined()
    // The sale has no single store: its three columns go to the price door as one write (U5).
    expect(byKey.get('purchasable_offer__discounted_price__value_with_tax')!.channelStore).toBeUndefined()
    // RRP keeps its own store.
    expect(byKey.get('list_price')!.channelStore).toMatchObject({ kind: 'platformAttributes', path: ['list_price', 'value_with_tax'] })
  })

  it('the Fulfillment method column offers FBA and FBM only, even when a schema lists more', () => {
    const wide = JSON.parse(JSON.stringify(def))
    wide.properties.fulfillment_availability.items.properties.fulfillment_channel_code.enum = ['AMAZON_EU', 'AMAZON_EU_RAFN', 'AMAZON_EU2AE_RAFN', 'DEFAULT']
    const f = amazonSpecFromDefinition({ marketplace: 'IT', productType: 'OUTERWEAR', schemaDefinition: wide }).fields.find((x) => x.key === AMAZON_FULFILMENT_KEY)!
    expect(f.options).toEqual(['AMAZON_EU', 'DEFAULT'])
    expect(f.optionLabels).toEqual({ AMAZON_EU: 'FBA — Amazon stores and ships', DEFAULT: 'FBM — you ship' })
  })
})

describe('leaf checks', () => {
  const today = '2026-10-02'
  it('each leaf refuses a wrong value with one sentence; null (remove on Amazon) always passes', () => {
    expect(amazonOfferLeafRefusal('our_price', { pin: 44.9 })).toBeNull()
    expect(amazonOfferLeafRefusal('our_price', { follow: true })).toBeNull()
    expect(amazonOfferLeafRefusal('our_price', { pin: -1 })).toMatch(/zero or more/)
    expect(amazonOfferLeafRefusal('sale', { price: 39.9, start: '2026-10-10', end: '2026-10-20' })).toBeNull()
    expect(amazonOfferLeafRefusal('sale', { price: 39.9, start: '2026-10-10', end: null })).toMatch(/start and an end date/)
    expect(amazonOfferLeafRefusal('sale', { price: 39.9, start: '2026-10-20', end: '2026-10-10' })).toMatch(/ends on or after/)
    expect(amazonOfferLeafRefusal('map_price', 'x')).toMatch(/zero or more/)
    expect(amazonOfferLeafRefusal('lead_time_to_ship_max_days', 121)).toMatch(/0 to 120/)
    expect(amazonOfferLeafRefusal('lead_time_to_ship_max_days', 3)).toBeNull()
    expect(amazonOfferLeafRefusal('restock_date', '2026-10-01', today)).toMatch(/today or later/)
    expect(amazonOfferLeafRefusal('restock_date', '2026-10-02', today)).toBeNull()
    expect(amazonOfferLeafRefusal('is_inventory_available', 'yes')).toMatch(/on or off/)
    expect(amazonOfferLeafRefusal('automated_pricing_rule_id', '  ')).toMatch(/rule id/)
    expect(amazonOfferLeafRefusal('offer_end_at', '2026-12-31T23:59:59Z')).toBeNull()
    for (const leaf of AMAZON_OFFER_LEAVES) expect(amazonOfferLeafRefusal(leaf, null), leaf).toBeNull()
  })
})

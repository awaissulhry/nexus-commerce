/**
 * Google Ads Shopping (2026-10-15, G4) — a Standard Shopping campaign's inventory filter (its LISTING_SCOPE criterion) and
 * Shopping settings, built from a request and the live state (pure): the exact operations (remove + create, as the scope
 * is immutable and one per campaign; an update mask of leaf paths), Google's rules checked first, what widens (SPENDS
 * MONEY) and what narrows, and the records undo reads.
 */
import { describe, expect, it } from 'vitest'
import {
  inventoryFilterDraft, inventoryFilterRecordAfterRun, inventoryFilterRecordNow, inventoryFilterUndoArgs, shoppingSettingsArgs, shoppingSettingsDraft,
  type InventoryFilterRecord,
} from './change-shopping.js'
import { inventoryFilterOf, shoppingCampaignOf, type ShoppingLiveState } from './live-shopping.js'
import type { GoogleChangeDraft } from './change-draft.js'

const C = 'customers/1234567890'
const campaign = (extra: Record<string, unknown> = {}, shopping: Record<string, unknown> = {}) =>
  shoppingCampaignOf({ campaign: { id: '21', name: 'Shop A', status: 'ENABLED', advertisingChannelType: 'SHOPPING', shoppingSetting: { merchantId: '5', feedLabel: 'IT', ...shopping }, ...extra } })
const scope = (id: string, dimensions: unknown[]) => inventoryFilterOf({ campaignCriterion: { criterionId: id, listingScope: { dimensions } } })
const state = (filters: ReturnType<typeof scope>[] = [], c = campaign()): ShoppingLiveState => ({ campaign: c, filters })
const ok = (d: GoogleChangeDraft | { refusal: string }): GoogleChangeDraft => { if ('refusal' in d) throw new Error(d.refusal); return d }
const no = (d: GoogleChangeDraft | { refusal: string }) => ('refusal' in d ? d.refusal : null)

describe('inventory filter', () => {
  it('set where there is none: one create of the listing scope, conditions in one order; narrowing is safe', () => {
    const d = ok(inventoryFilterDraft(C, { campaignId: '21', filter: [{ dimension: 'CUSTOM_LABEL_0', value: 'top' }, { dimension: 'BRAND', value: 'Brand A' }, { dimension: 'PRODUCT_TYPE_1', value: 'Jackets' }] }, state()))
    expect(d.operations).toEqual([{ campaignCriterionOperation: { create: { campaign: `${C}/campaigns/21`, listingScope: { dimensions: [
      { productBrand: { value: 'Brand A' } }, { productType: { level: 'LEVEL1', value: 'Jackets' } }, { productCustomAttribute: { index: 'INDEX0', value: 'top' } },
    ] } } } }])
    expect(d.spendsMoney).toEqual([])
    expect(d.warnings).toEqual(['Only products with brand = "Brand A" and product type (level 1) = "Jackets" and custom label 0 = "top" can be advertised in "Shop A"; its product groups set the bids among them.'])
    expect(d.after).toEqual({ campaignId: '21', filter: [{ dimension: 'BRAND', value: 'Brand A' }, { dimension: 'PRODUCT_TYPE_1', value: 'Jackets' }, { dimension: 'CUSTOM_LABEL_0', value: 'top' }], criterionId: 'op:0' })
  })

  it('a change is remove + create in one request (immutable, one per campaign); letting products in that were left out SPENDS MONEY', () => {
    const live = state([scope('61', [{ productBrand: { value: 'Brand A' } }, { productCondition: { condition: 'NEW' } }])], campaign({ status: 'PAUSED' }))
    const wider = ok(inventoryFilterDraft(C, { campaignId: '21', filter: [{ dimension: 'BRAND', value: 'brand a' }] }, live))
    expect(wider.operations).toEqual([
      { campaignCriterionOperation: { remove: `${C}/campaignCriteria/21~61` } },
      { campaignCriterionOperation: { create: { campaign: `${C}/campaigns/21`, listingScope: { dimensions: [{ productBrand: { value: 'brand a' } }] } } } },
    ])
    expect(wider.spendsMoney).toEqual(['Changes the inventory filter of "Shop A" so products it left out can be advertised (brand = "Brand A" and condition = "NEW" → brand = "brand a"), as its product groups allow (the campaign is paused: nothing spends until it is enabled).'])
    const narrower = ok(inventoryFilterDraft(C, { campaignId: '21', filter: [{ dimension: 'BRAND', value: 'Brand A' }, { dimension: 'CONDITION', value: 'new' }, { dimension: 'CHANNEL', value: 'online' }] }, live))
    expect(narrower.spendsMoney).toEqual([])
    expect(narrower.before).toEqual({ campaignId: '21', filter: [{ dimension: 'BRAND', value: 'Brand A' }, { dimension: 'CONDITION', value: 'NEW' }], criterionId: '61' })
  })

  it('clear: the criterion is removed; every product can be advertised again — SPENDS MONEY', () => {
    const d = ok(inventoryFilterDraft(C, { campaignId: '21', clear: true }, state([scope('61', [{ productBrand: { value: 'Brand A' } }])])))
    expect(d.operations).toEqual([{ campaignCriterionOperation: { remove: `${C}/campaignCriteria/21~61` } }])
    expect(d.spendsMoney).toEqual(['Removes the inventory filter of "Shop A": every product of its Merchant Center feed can be advertised again (as its product groups allow).'])
    expect(d.after).toEqual({ campaignId: '21', filter: [], criterionId: null })
  })

  it('refused before anything is sent', () => {
    const live = state([scope('61', [{ productBrand: { value: 'Brand A' } }])])
    expect(no(inventoryFilterDraft(C, { campaignId: '21', filter: [{ dimension: 'BRAND', value: 'BRAND A' }] }, live))).toMatch(/^Nothing to change/)
    expect(no(inventoryFilterDraft(C, { campaignId: '21', clear: true }, state()))).toMatch(/^Nothing to change/)
    expect(no(inventoryFilterDraft(C, { campaignId: '21' }, live))).toMatch(/Give filter .* or clear: true/)
    expect(no(inventoryFilterDraft(C, { campaignId: '21', filter: [{ dimension: 'BRAND', value: 'A' }, { dimension: 'BRAND', value: 'B' }] }, live))).toMatch(/brand is named twice/)
    expect(no(inventoryFilterDraft(C, { campaignId: '21', filter: [{ dimension: 'CATEGORY_2', value: '166' }] }, live))).toMatch(/needs category \(level 1\) in the filter too/)
    expect(no(inventoryFilterDraft(C, { campaignId: '21', filter: Array.from({ length: 8 }, (_, i) => ({ dimension: (['BRAND', 'CONDITION', 'CHANNEL', 'CHANNEL_EXCLUSIVITY', 'ITEM_ID', 'CUSTOM_LABEL_0', 'CUSTOM_LABEL_1', 'CUSTOM_LABEL_2'] as const)[i], value: 'x' })) }, live))).toMatch(/at most 7/)
    expect(no(inventoryFilterDraft(C, { campaignId: '21', filter: [{ dimension: 'CONDITION', value: 'mint' }] }, live))).toMatch(/not a condition Google knows/)
    expect(no(inventoryFilterDraft(C, { campaignId: '21', clear: true }, state([], campaign({ advertisingChannelType: 'PERFORMANCE_MAX' }))))).toMatch(/PERFORMANCE_MAX campaign/)
    expect(no(inventoryFilterDraft(C, { campaignId: '21', clear: true }, { campaign: null, filters: [] }))).toMatch(/not in this account/)
    expect(no(inventoryFilterDraft(C, { campaignId: '21', clear: true }, state([scope('61', [{ productGrouping: { value: 'x' } }])])))).toMatch(/condition Nexus cannot read/)
  })

  it('records: the id Google gave the new filter; what Google holds now reads equal; undo puts the old filter back, or clears it', () => {
    const d = ok(inventoryFilterDraft(C, { campaignId: '21', filter: [{ dimension: 'BRAND', value: 'Brand A' }] }, state()))
    const ran = inventoryFilterRecordAfterRun(d.after as InventoryFilterRecord, [{ campaignCriterionResult: { resourceName: `${C}/campaignCriteria/21~77` } }])
    expect(ran).toEqual({ campaignId: '21', filter: [{ dimension: 'BRAND', value: 'Brand A' }], criterionId: '77' })
    expect(inventoryFilterRecordNow(ran, state([scope('77', [{ productBrand: { value: 'brand a' } }])]))).toEqual(ran)
    expect(inventoryFilterUndoArgs(d.before as InventoryFilterRecord)).toEqual({ args: { campaignId: '21', clear: true } })
    expect(inventoryFilterUndoArgs({ campaignId: '21', filter: [{ dimension: 'BRAND', value: 'Brand B' }], criterionId: '61' })).toEqual({ args: { campaignId: '21', filter: [{ dimension: 'BRAND', value: 'Brand B' }] } })
  })
})

describe('Shopping settings', () => {
  it('feed label, local products, brand exclusions: one update with leaf paths; widening SPENDS MONEY', () => {
    const d = ok(shoppingSettingsDraft(C, { campaignId: '21', feedLabel: 'DE', localInventory: true, ignoreBrandExclusions: true }, state()))
    expect(d.operations).toEqual([{ campaignOperation: {
      update: { resourceName: `${C}/campaigns/21`, shoppingSetting: { feedLabel: 'DE', enableLocal: true, ignoreBrandExclusionInShoppingAds: true } },
      updateMask: 'shopping_setting.feed_label,shopping_setting.enable_local,shopping_setting.ignore_brand_exclusion_in_shopping_ads',
    } }])
    expect(d.spendsMoney).toEqual([
      'Changes the feed label of "Shop A" to DE: the products of that feed can be advertised, and those of IT stop.',
      'Turns on local products in "Shop A": products sold in local stores can be advertised too.',
      'Lets Google ignore the brand exclusions for the Shopping ads of "Shop A": they can show where the exclusions held them back.',
    ])
    expect(d.before).toEqual({ campaignId: '21', settings: { feedLabel: 'IT', localInventory: false, ignoreBrandExclusions: false } })
    expect(d.after).toEqual({ campaignId: '21', settings: { feedLabel: 'DE', localInventory: true, ignoreBrandExclusions: true } })
  })

  it('clearFeedLabel clears it (the path in the mask, no value: Google clears it) — SPENDS MONEY; turning things off is safe', () => {
    const live = state([], campaign({}, { enableLocal: true, ignoreBrandExclusionInShoppingAds: true }))
    const d = ok(shoppingSettingsDraft(C, { campaignId: '21', clearFeedLabel: true, localInventory: false, ignoreBrandExclusions: false }, live))
    expect(d.operations).toEqual([{ campaignOperation: {
      update: { resourceName: `${C}/campaigns/21`, shoppingSetting: { enableLocal: false, ignoreBrandExclusionInShoppingAds: false } },
      updateMask: 'shopping_setting.feed_label,shopping_setting.enable_local,shopping_setting.ignore_brand_exclusion_in_shopping_ads',
    } }])
    expect(d.spendsMoney).toEqual(['Removes the feed label of "Shop A": products of every feed of its Merchant Center account can be advertised.'])
    expect(d.before).toMatchObject({ settings: { feedLabel: 'IT' } })
    expect(d.after).toMatchObject({ settings: { feedLabel: null } })
    expect(shoppingSettingsArgs({ feedLabel: null, localInventory: true })).toEqual({ localInventory: true, clearFeedLabel: true })
  })

  it('a label where there was none narrows (safe); "NONE" is a label like any other', () => {
    const live = state([], campaign({}, { feedLabel: undefined }))
    const d = ok(shoppingSettingsDraft(C, { campaignId: '21', feedLabel: 'NONE' }, live))
    expect(d.operations).toEqual([{ campaignOperation: { update: { resourceName: `${C}/campaigns/21`, shoppingSetting: { feedLabel: 'NONE' } }, updateMask: 'shopping_setting.feed_label' } }])
    expect(d.spendsMoney).toEqual([])
    expect(d.warnings).toContain('Only products of feed label NONE can be advertised in "Shop A" after this change (now: every feed).')
    expect(no(shoppingSettingsDraft(C, { campaignId: '21', feedLabel: 'DE', clearFeedLabel: true }, live))).toMatch(/not both/)
  })

  it('refused: nothing to change, a feed label Google does not take, not a Shopping campaign', () => {
    expect(no(shoppingSettingsDraft(C, { campaignId: '21', feedLabel: 'IT', localInventory: false }, state()))).toMatch(/^Nothing to change/)
    expect(no(shoppingSettingsDraft(C, { campaignId: '21' }, state()))).toMatch(/^Say what to change/)
    expect(no(shoppingSettingsDraft(C, { campaignId: '21', feedLabel: 'it shop' }, state()))).toMatch(/is not one Google takes/)
    expect(no(shoppingSettingsDraft(C, { campaignId: '21', localInventory: true }, state([], campaign({ advertisingChannelType: 'SEARCH' }))))).toMatch(/SEARCH campaign/)
  })
})

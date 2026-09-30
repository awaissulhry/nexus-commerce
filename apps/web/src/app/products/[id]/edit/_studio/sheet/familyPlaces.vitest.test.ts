import { describe, expect, it } from 'vitest'
import { familyAttributesElsewhere, placeOf, type FamilyAttributePlaces } from './familyPlaces'

/** P1 (issue #15, #14) — the family attributes with no column on this sheet, and where each one is. */
const places = (over: Partial<FamilyAttributePlaces> = {}): FamilyAttributePlaces => ({
  family: { id: 'f', label: 'Jackets' },
  channelsWithAccount: ['EBAY', 'SHOPIFY'],
  attributes: [
    { code: 'material', label: 'Material', placement: 'shared', channels: [], archived: false },
    { code: 'neckline', label: 'Neckline', placement: 'shared', channels: [], archived: false },
    { code: 'supplier_declared_dg_hz_regulation', label: 'Dangerous goods regulation', placement: 'channel', channels: ['AMAZON'], archived: false },
    { code: 'ebay_only', label: 'eBay only', placement: 'channel', channels: ['EBAY'], archived: false },
    { code: 'old_fit', label: 'Old fit', placement: 'shared', channels: [], archived: true },
  ],
  ...over,
})

describe('familyAttributesElsewhere', () => {
  it('on Shared: counts the columns here and names where the rest live (#14: placed on Amazon, no Amazon account)', () => {
    const view = familyAttributesElsewhere(places(), [{ key: 'material' }, { key: 'neckline', writeField: 'attr_neckline' }], null)
    expect(view).toEqual({ family: 'Jackets', total: 5, here: 2, groups: [
      { where: 'Placed on Amazon — no Amazon account', labels: ['Dangerous goods regulation'] },
      { where: 'Placed on eBay — open that channel’s sheet', labels: ['eBay only'] },
      { where: 'Archived — restore it in Settings → Attributes to edit it', labels: ['Old fit'] },
    ] })
  })
  it('on a channel: a Shared attribute is on the Shared sheet; one placed on this channel says its category does not use it', () => {
    const view = familyAttributesElsewhere(places(), [{ key: 'material' }], 'EBAY')
    expect(view.here).toBe(1)
    expect(view.groups.map(g => [g.where, g.labels.length])).toEqual([
      ['On the Shared product sheet (a channel reads it through its field mapping)', 1],
      ['Placed on Amazon — no Amazon account', 1],
      ['Placed on eBay, but this product’s eBay category does not use it', 1],
      ['Archived — restore it in Settings → Attributes to edit it', 1],
    ])
  })
  it('names a channel with an account as the place to go', () => {
    expect(placeOf({ code: 'x', label: 'X', placement: 'channel', channels: ['SHOPIFY'], archived: false }, null, new Set(['SHOPIFY']))).toBe('Placed on Shopify — open that channel’s sheet')
  })
})

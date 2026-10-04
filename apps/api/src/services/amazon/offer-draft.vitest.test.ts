/** Amazon sheet gaps (D4=B) — the offer draft model: set/remove, equal-to-live removes, counts, the promotion plan. */
import { describe, expect, it } from 'vitest'
import {
  amazonOfferDraftCount, amazonOfferDraftTotals, amazonOfferPromotionPlan, amazonOfferValuesEqual, readAmazonOfferDraft,
  removeAmazonOfferDraftLeaf, setAmazonOfferDraftLeaf, withAmazonOfferDraft,
} from './offer-draft.js'

const at = '2026-10-02T09:00:00.000Z'

describe('set / remove', () => {
  it('a saved leaf keeps its value and the live value as its base', () => {
    const d = setAmazonOfferDraftLeaf(null, 'map_price', { value: 42, live: 40, at, by: 'u1' })
    expect(d).toEqual({ v: 1, leaves: { map_price: { value: 42, base: 40, savedAt: at, savedBy: 'u1' } } })
  })

  it('a value equal to live removes the leaf; the last leaf removed leaves no draft', () => {
    let d = setAmazonOfferDraftLeaf(null, 'map_price', { value: 42, live: 40, at, by: 'u1' })
    d = setAmazonOfferDraftLeaf(d, 'lead_time_to_ship_max_days', { value: 3, live: 2, at, by: 'u1' })
    d = setAmazonOfferDraftLeaf(d, 'map_price', { value: 40.001, live: 40, at, by: 'u1' })
    expect(Object.keys(d!.leaves)).toEqual(['lead_time_to_ship_max_days'])
    expect(removeAmazonOfferDraftLeaf(d, 'lead_time_to_ship_max_days')).toBeNull()
  })

  it('null is a removal on Amazon, kept as a draft while live holds a value', () => {
    expect(setAmazonOfferDraftLeaf(null, 'map_price', { value: null, live: 40, at, by: 'u' })!.leaves.map_price!.value).toBeNull()
    expect(setAmazonOfferDraftLeaf(null, 'map_price', { value: null, live: null, at, by: 'u' })).toBeNull()
  })

  it('saving again refreshes the base to the live value now', () => {
    const first = setAmazonOfferDraftLeaf(null, 'our_price', { value: { pin: 44.9 }, live: { pin: 49.9 }, at, by: 'u' })
    const again = setAmazonOfferDraftLeaf(first, 'our_price', { value: { pin: 43.9 }, live: { pin: 52 }, at, by: 'u' })
    expect(again!.leaves.our_price).toMatchObject({ value: { pin: 43.9 }, base: { pin: 52 } })
  })

  it('the bag keeps every other key; a null draft removes the key', () => {
    const bag = { attributes: { x: 1 }, amazonOffer: { map_price: 40 } }
    const d = setAmazonOfferDraftLeaf(null, 'map_price', { value: 42, live: 40, at, by: 'u' })
    const withDraft = withAmazonOfferDraft(bag, d)
    expect(withDraft).toEqual({ ...bag, amazonOfferDraft: d })
    expect(withAmazonOfferDraft(withDraft, null)).toEqual(bag)
    expect(bag).not.toHaveProperty('amazonOfferDraft')
  })
})

describe('reading a stored draft', () => {
  it('unknown leaves and malformed entries are dropped; a wrong version is no draft', () => {
    const pa = { amazonOfferDraft: { v: 1, leaves: { map_price: { value: 42, base: 40, savedAt: at, savedBy: 'u' }, bogus: { value: 1 }, restock_date: 'x' } } }
    expect(readAmazonOfferDraft(pa)).toEqual({ v: 1, leaves: { map_price: { value: 42, base: 40, savedAt: at, savedBy: 'u' } } })
    expect(readAmazonOfferDraft({ amazonOfferDraft: { v: 2, leaves: {} } })).toBeNull()
    expect(readAmazonOfferDraft({})).toBeNull()
  })
})

describe('equality', () => {
  it('prices to the cent; follow vs pin; sale as a whole; dates by day when written at midnight UTC', () => {
    expect(amazonOfferValuesEqual('map_price', 40, 40.004)).toBe(true)
    expect(amazonOfferValuesEqual('our_price', { follow: true }, { follow: true })).toBe(true)
    expect(amazonOfferValuesEqual('our_price', { follow: true }, { pin: 40 })).toBe(false)
    expect(amazonOfferValuesEqual('sale', { price: 39.9, start: '2026-10-10', end: '2026-10-20' }, { price: 39.9, start: '2026-10-10', end: '2026-10-21' })).toBe(false)
    expect(amazonOfferValuesEqual('restock_date', '2026-11-01', '2026-11-01T00:00:00.000Z')).toBe(true)
    expect(amazonOfferValuesEqual('offer_start_at', '2026-11-01', '2026-11-01T10:00:00Z')).toBe(false)
    expect(amazonOfferValuesEqual('is_inventory_available', false, null)).toBe(false)
  })
})

describe('counts', () => {
  it('per listing and across listings', () => {
    const d = setAmazonOfferDraftLeaf(setAmazonOfferDraftLeaf(null, 'map_price', { value: 42, live: 40, at, by: 'u' }), 'restock_date', { value: '2026-11-01', live: null, at, by: 'u' })
    expect(amazonOfferDraftCount(d)).toBe(2)
    expect(amazonOfferDraftTotals([d, null, setAmazonOfferDraftLeaf(null, 'map_price', { value: 1, live: 2, at, by: 'u' })])).toEqual({ listings: 2, leaves: 3 })
  })
})

describe('promotion plan (after Amazon accepted a Publish)', () => {
  const draft = setAmazonOfferDraftLeaf(setAmazonOfferDraftLeaf(null, 'map_price', { value: 42, live: 40, at, by: 'u' }), 'our_price', { value: { pin: 44.9 }, live: { pin: 49.9 }, at, by: 'u' })

  it('live still equals the base → promote and remove the draft leaf', () => {
    const plan = amazonOfferPromotionPlan({ sent: { map_price: { value: 42, base: 40 } }, live: { map_price: 40 }, draft })
    expect(plan.promote).toEqual([{ leaf: 'map_price', value: 42 }])
    expect(plan.drop).toEqual([])
    expect(plan.removeDraft).toEqual(['map_price'])
  })

  it('live moved after the save → the newer live wins, the leaf is dropped with a note', () => {
    const plan = amazonOfferPromotionPlan({ sent: { our_price: { value: { pin: 44.9 }, base: { pin: 49.9 } } }, live: { our_price: { pin: 52 } }, draft })
    expect(plan.promote).toEqual([])
    expect(plan.drop).toEqual([expect.objectContaining({ leaf: 'our_price', value: { pin: 44.9 }, live: { pin: 52 }, note: expect.stringContaining('Live changed') })])
    expect(plan.removeDraft).toEqual(['our_price'])
  })

  it('a newer saved value (after the send) stays in the draft either way', () => {
    const newer = setAmazonOfferDraftLeaf(draft, 'map_price', { value: 43, live: 40, at, by: 'u' })
    const plan = amazonOfferPromotionPlan({ sent: { map_price: { value: 42, base: 40 } }, live: { map_price: 40 }, draft: newer })
    expect(plan.promote).toEqual([{ leaf: 'map_price', value: 42 }])
    expect(plan.removeDraft).toEqual([])
  })
})

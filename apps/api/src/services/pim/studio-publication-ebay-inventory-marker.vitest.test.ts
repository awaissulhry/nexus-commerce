/** PE P3.4 — which eBay listings Publish treats as Inventory-model (the marker agreed with eBay on every live item, P3.0). */
import { expect, it } from 'vitest'
import { usesEbayInventory } from './studio-publication-ebay.js'

const facts = (...platformAttributes: Record<string, unknown>[]) => ({ listings: platformAttributes.map(pa => ({ platformAttributes: pa })) }) as any

it('an offer id on any listing of the family marks it Inventory; an empty marker or none is Trading', () => {
  expect(usesEbayInventory(facts({}, { __offerIds: { EBAY_IT: 'offer' } }))).toBe(true)
  expect(usesEbayInventory(facts({ offerId: 'offer' }))).toBe(true)
  expect(usesEbayInventory(facts({}, { __offerIds: {} }))).toBe(false)
  expect(usesEbayInventory(facts({ itemSpecifics: {} }))).toBe(false)
})

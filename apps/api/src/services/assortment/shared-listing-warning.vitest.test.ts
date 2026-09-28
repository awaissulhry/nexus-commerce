import { describe, expect, it } from 'vitest'
import { sharedListingWarningText } from './shared-listing-warning.js'

describe('sharing studio step 5 — the publish warning for a shared product live in another business', () => {
  it('names the other business and its live listings on the same market, and says what to check', () => {
    expect(sharedListingWarningText('EBAY', 'IT', [{ business_name: 'Business A', marketplace: 'IT', listings: 1 }, { business_name: 'Business C', marketplace: 'IT', listings: 2 }])).toBe(
      'This product is shared between your businesses and is already live on eBay IT in Business A (1 listing), Business C (2 listings). Two sellers listing the same item can break eBay’s duplicate-listing rules. Check that both listings should be live before you publish.')
  })

  it('says nothing for another market, or when nothing is live', () => {
    expect(sharedListingWarningText('EBAY', 'DE', [{ business_name: 'Business A', marketplace: 'IT', listings: 1 }])).toBeNull()
    expect(sharedListingWarningText('EBAY', 'IT', [])).toBeNull()
  })
})

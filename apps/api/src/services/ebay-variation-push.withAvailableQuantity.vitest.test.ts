/**
 * FM/25004 self-heal — unit tests for the pure `withAvailableQuantity` helper.
 *
 * It powers the reactive 25004 recovery in pushVariationGroup: an offer parked
 * at availableQuantity:0 gets its quantity raised while every other required
 * updateOffer field (a FULL replacement) is preserved unchanged.
 */

import { describe, it, expect } from 'vitest'
import { withAvailableQuantity } from './ebay-variation-push.service.js'

describe('withAvailableQuantity', () => {
  const fullOffer = {
    offerId: '123',
    sku: 'SKU-A',
    marketplaceId: 'EBAY_IT',
    format: 'FIXED_PRICE',
    availableQuantity: 0,
    categoryId: '57988',
    merchantLocationKey: 'WAREHOUSE-1',
    pricingSummary: { price: { value: '49.00', currency: 'EUR' } },
    listingPolicies: {
      fulfillmentPolicyId: 'f1',
      paymentPolicyId: 'p1',
      returnPolicyId: 'r1',
    },
    // read-only container echoed by getOffer — must NOT be sent to updateOffer
    listing: { listingId: '9999', listingStatus: 'ACTIVE' },
  }

  it('raises availableQuantity to the given qty', () => {
    const out = withAvailableQuantity(fullOffer, 9)
    expect(out.availableQuantity).toBe(9)
  })

  it('preserves every other required updateOffer field unchanged', () => {
    const out = withAvailableQuantity(fullOffer, 9)
    expect(out.marketplaceId).toBe('EBAY_IT')
    expect(out.format).toBe('FIXED_PRICE')
    expect(out.categoryId).toBe('57988')
    expect(out.merchantLocationKey).toBe('WAREHOUSE-1')
    expect(out.pricingSummary).toEqual({ price: { value: '49.00', currency: 'EUR' } })
    expect(out.listingPolicies).toEqual({
      fulfillmentPolicyId: 'f1',
      paymentPolicyId: 'p1',
      returnPolicyId: 'r1',
    })
  })

  it('strips the read-only `listing` container', () => {
    const out = withAvailableQuantity(fullOffer, 9)
    expect('listing' in out).toBe(false)
  })

  it('does not mutate the input offer', () => {
    const clone = JSON.parse(JSON.stringify(fullOffer))
    withAvailableQuantity(fullOffer, 9)
    expect(fullOffer).toEqual(clone)
  })

  it('coerces a numeric-string qty to a number and is idempotent', () => {
    const out = withAvailableQuantity(withAvailableQuantity(fullOffer, 9), Number('9'))
    expect(out.availableQuantity).toBe(9)
    expect(typeof out.availableQuantity).toBe('number')
  })
})

/**
 * FM/25004 self-heal — unit tests for the pure `withAvailableQuantity` helper.
 *
 * It powers the reactive 25004 recovery in pushVariationGroup: an offer parked
 * at availableQuantity:0 gets its quantity raised while every other required
 * updateOffer field (a FULL replacement) is preserved unchanged.
 */

import { describe, it, expect } from 'vitest'
import {
  withAvailableQuantity,
  computeSafeQty,
  familyHasSellableVariant,
} from './ebay-variation-push.service.js'

// ── STEP 1a — computeSafeQty (extracted from the inline safeQty expression) ──
describe('computeSafeQty', () => {
  it('clamps NaN / null / undefined / negative to 0', () => {
    expect(computeSafeQty(Number.NaN)).toBe(0)
    expect(computeSafeQty(null)).toBe(0)
    expect(computeSafeQty(undefined)).toBe(0)
    expect(computeSafeQty(-5)).toBe(0)
    expect(computeSafeQty('nope')).toBe(0)
    expect(computeSafeQty(0)).toBe(0)
  })
  it('floors a fractional qty (3.9 → 3)', () => {
    expect(computeSafeQty(3.9)).toBe(3)
    expect(computeSafeQty('4.7')).toBe(4)
  })
  it('passes a positive integer through', () => {
    expect(computeSafeQty(7)).toBe(7)
    expect(computeSafeQty('12')).toBe(12)
  })
})

// ── STEP 1b — familyHasSellableVariant (mirrors anyVariantSellable) ──────────
describe('familyHasSellableVariant', () => {
  it('all-zero → false (drives the all-zero publish abort)', () => {
    expect(familyHasSellableVariant([0, 0, 0])).toBe(false)
    expect(familyHasSellableVariant([])).toBe(false)
  })
  it('any positive → true', () => {
    expect(familyHasSellableVariant([0, 0, 3])).toBe(true)
    expect(familyHasSellableVariant([5])).toBe(true)
  })
})

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

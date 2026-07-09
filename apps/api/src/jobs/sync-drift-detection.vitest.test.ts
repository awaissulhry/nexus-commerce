/**
 * FB3 — the master-drift detector must judge a FOLLOWING listing against the
 * SAME reserved-adjusted warehouse available (StockLevel.available − buffer) the
 * cascade publishes, NOT gross totalStock, and must never flag an FBA listing.
 * expectedFollowingQuantity is the pure kernel of that decision.
 */
import { describe, it, expect } from 'vitest'
import { expectedFollowingQuantity } from './sync-drift-detection.job.js'

const fbmAmazon = {
  channel: 'AMAZON',
  stockBuffer: 2,
  fulfillmentMethod: 'FBM' as string | null,
  platformAttributes: null as unknown,
  productFulfillmentMethod: null as string | null,
}

describe('FB3 — expectedFollowingQuantity (drift baseline = available − buffer)', () => {
  it('totalStock 10, reserved 3 (available 7), buffer 2 → expected 5 (quantity 5 is NOT drift)', () => {
    // warehouseAvailable is already reserved-adjusted (10 − 3 = 7); 7 − buffer 2 = 5.
    const expected = expectedFollowingQuantity(fbmAmazon, 7, 0)
    expect(expected).toBe(5)
    // A listing sitting at 5 matches → the job would NOT flag it.
    expect(5 === expected).toBe(true)
  })

  it('same pool, quantity 8 IS drift (8 !== expected 5)', () => {
    const expected = expectedFollowingQuantity(fbmAmazon, 7, 0)
    expect(expected).toBe(5)
    expect(8 === expected).toBe(false)
  })

  it('an FBA following listing is never flagged (expected = null)', () => {
    // FBA signal via explicit fulfillmentMethod…
    expect(expectedFollowingQuantity({ ...fbmAmazon, fulfillmentMethod: 'FBA' }, 7, 0)).toBeNull()
    // …via FBA stock evidence…
    expect(expectedFollowingQuantity({ ...fbmAmazon, fulfillmentMethod: null }, 7, 40)).toBeNull()
    // …and via the Amazon fulfillment_availability channel code.
    expect(
      expectedFollowingQuantity(
        { ...fbmAmazon, fulfillmentMethod: null, platformAttributes: { fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_NA' }] } },
        7,
        0,
      ),
    ).toBeNull()
  })

  it('a merchant channel (eBay) is FBM even when the product master is FBA', () => {
    // FBA only exists on Amazon — a product-level FBA flag must not exclude eBay.
    const expected = expectedFollowingQuantity(
      { channel: 'EBAY', stockBuffer: 1, fulfillmentMethod: null, platformAttributes: null, productFulfillmentMethod: 'FBA' },
      6,
      99,
    )
    expect(expected).toBe(5) // 6 − buffer 1
  })

  it('buffer larger than available clamps expected to 0', () => {
    expect(expectedFollowingQuantity({ ...fbmAmazon, stockBuffer: 20 }, 7, 0)).toBe(0)
  })
})

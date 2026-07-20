/** P0c — diffReadback: Amazon actual vs intended, FBM-only. */
import { describe, it, expect } from 'vitest'
import { diffReadback } from './amazon-qty-readback.job.js'

describe('P0c — diffReadback', () => {
  const ours = [
    { sku: 'A', quantity: 10, channelListingId: 'c1', productId: 'p1' },
    { sku: 'B', quantity: 5, channelListingId: 'c2', productId: 'p2' },
    { sku: 'C', quantity: null, channelListingId: 'c3', productId: 'p3' },
  ]

  it('flags mismatches, matches pass, null-intended skipped, unknown-sku skipped', () => {
    const diffs = diffReadback(
      [
        { sku: 'A', quantity: 0 },            // mismatch 0 vs 10
        { sku: 'B', quantity: 5 },            // match
        { sku: 'C', quantity: 7 },            // intended null → skip
        { sku: 'ZZZ', quantity: 3 },          // not ours → skip
      ],
      ours, 'IT',
    )
    expect(diffs).toHaveLength(1)
    expect(diffs[0]).toMatchObject({ sku: 'A', amazonQty: 0, intendedQty: 10, marketplace: 'IT' })
  })

  it('NEVER compares AMAZON_* (FBA) report rows — Amazon-managed stock', () => {
    const diffs = diffReadback(
      [{ sku: 'A', quantity: 0, fulfillmentChannel: 'AMAZON_EU' }],
      ours, 'IT',
    )
    expect(diffs).toHaveLength(0)
  })
})

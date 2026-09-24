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

describe('A-36 (Step 3.5a) — amazonDriftRecords: one ChannelDrift record per listing the report answered for', () => {
  const ours = [
    { sku: 'A', quantity: 10, price: 20, channelListingId: 'c1' },
    { sku: 'B', quantity: 5, price: 30, channelListingId: 'c2' },
    { sku: 'F', quantity: 3, price: 40, channelListingId: 'c3' },
    { sku: 'GONE', quantity: 1, price: 1, channelListingId: 'c4' },
  ]
  it('🔴 differences are stored, matches are compared-and-clear, FBA stock is never compared, an unreported SKU is not recorded', async () => {
    const { amazonDriftRecords } = await import('./amazon-qty-readback.job.js')
    const report = [
      { sku: 'A', quantity: 0, price: 20 },                                   // quantity differs, price matches
      { sku: 'B', quantity: 5, price: 30 },                                   // both match
      { sku: 'F', quantity: 99, price: 45, fulfillmentChannel: 'AMAZON_EU' }, // FBA: price only
    ]
    const qtyDiffs = [{ sku: 'A', marketplace: 'IT', amazonQty: 0, intendedQty: 10, channelListingId: 'c1', productId: 'p1' }]
    const priceDiffs = [{ sku: 'F', marketplace: 'IT', channelListingId: 'c3', productId: 'p3', drift: { channelPrice: 45, intendedPrice: 40, difference: 5 } as any }]
    expect(amazonDriftRecords(report, ours, qtyDiffs, priceDiffs)).toEqual([
      { channelListingId: 'c1', compared: ['quantity', 'price'], differing: [{ field: 'quantity', ours: 10, theirs: 0 }] },
      { channelListingId: 'c2', compared: ['quantity', 'price'], differing: [] },
      { channelListingId: 'c3', compared: ['price'], differing: [{ field: 'price', ours: 40, theirs: 45 }] },
    ])
  })
})

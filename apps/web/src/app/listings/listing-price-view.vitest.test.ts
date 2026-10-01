/**
 * What the listings screens say about a price (2026-10-01, "pricing rules reach the channels").
 *
 * 🔴 The listing drawer, the matrix cell and the per-channel comparison compared a following listing's price with the
 * MASTER, so a listing following at "master +10%" (11.00 on a master of 10.00) was labelled "+1.00 vs master" drift.
 * And the grid's price cell sent `{ price }`, which `PATCH /api/listings/:id` refuses: it always failed.
 */
import { describe, expect, it } from 'vitest'
import { inlineCellPatchBody, priceDriftView } from './listing-price-view'

describe('priceDriftView — the rule-aware comparison', () => {
  it('🔴 a listing following at master +10% is ON its rule: no drift', () => {
    expect(priceDriftView({ price: 11, followMasterPrice: true, pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: 10 }, 10))
      .toEqual({ expected: 11, drift: 0, label: '0.00 vs expected (the master price +10%) 11.00' })
  })

  it('a following listing off its rule shows the drift against the rule price', () => {
    expect(priceDriftView({ price: '12.50', followMasterPrice: true, pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: '10' }, '10'))
      .toEqual({ expected: 11, drift: 1.5, label: '+1.50 vs expected (the master price +10%) 11.00' })
    expect(priceDriftView({ price: 9, followMasterPrice: true, pricingRule: 'FIXED' }, 10).label).toBe('-1.00 vs expected (the master price) 10.00')
  })

  it('a pinned listing is compared with the master, as before; Match Amazon and no master have no expectation', () => {
    expect(priceDriftView({ price: 15, followMasterPrice: false, pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: 10 }, 10))
      .toEqual({ expected: 10, drift: 5, label: '+5.00 vs master' })
    expect(priceDriftView({ price: 15, followMasterPrice: true, pricingRule: 'MATCH_AMAZON' }, 10)).toEqual({ expected: null, drift: null, label: null })
    expect(priceDriftView({ price: 15, followMasterPrice: true, pricingRule: 'FIXED' }, null)).toEqual({ expected: null, drift: null, label: null })
  })
})

describe('inlineCellPatchBody — the grid cell asks for what the PATCH takes', () => {
  it('🔴 a price is a pin (priceOverride), never `price`', () => {
    expect(inlineCellPatchBody('price', 12.5, 7)).toEqual({ priceOverride: 12.5, expectedVersion: 7 })
    expect(inlineCellPatchBody('quantity', 3, 7)).toEqual({ quantity: 3, expectedVersion: 7 })
  })
})

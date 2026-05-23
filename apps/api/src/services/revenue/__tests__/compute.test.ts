// DA-RT.1 — unit tests for the central revenue helper. Covers the
// 3-tier waterfall + rollup + flag semantics. Pure-function tests
// — no DB. buildPriceLookup / computeOrdersRevenue (which touch
// prisma) are smoke-tested via integration tests once a callsite
// migrates in DA-RT.2.

import { describe, it, expect } from 'vitest'
import {
  computeOrderRevenue,
  rollupRevenue,
  type OrderForRevenue,
  type PriceLookup,
} from '../compute.js'

const EMPTY_LOOKUP: PriceLookup = {
  byChannelListing: new Map(),
  byProduct: new Map(),
}

describe('computeOrderRevenue — Tier 1: Order.totalPrice', () => {
  it('uses Order.totalPrice when positive', () => {
    const r = computeOrderRevenue({ totalPrice: 42.50 })
    expect(r).toEqual({
      cents: 4250,
      nativeCents: 4250,
      currency: 'EUR',
      source: 'order_total',
      estimated: false,
      awaitingPrice: false,
      fxMissing: false,
    })
  })

  it('accepts string Decimal serialisation', () => {
    const r = computeOrderRevenue({ totalPrice: '99.99' })
    expect(r.cents).toBe(9999)
    expect(r.source).toBe('order_total')
  })

  it('skips Tier 1 when totalPrice is null and falls through', () => {
    const r = computeOrderRevenue({ totalPrice: null })
    expect(r.source).toBe('none')
    expect(r.cents).toBe(0)
    expect(r.awaitingPrice).toBe(true)
  })

  it('skips Tier 1 when totalPrice is 0 and falls through', () => {
    const r = computeOrderRevenue({ totalPrice: 0 })
    expect(r.source).toBe('none')
  })
})

describe('computeOrderRevenue — Tier 2: OrderItem.price summation', () => {
  it('sums items when all have positive prices', () => {
    const o: OrderForRevenue = {
      totalPrice: 0,
      items: [
        { productId: 'p1', quantity: 2, price: 10.00 },
        { productId: 'p2', quantity: 1, price: 5.50 },
      ],
    }
    const r = computeOrderRevenue(o)
    expect(r.cents).toBe(2550)
    expect(r.source).toBe('item_sum')
    expect(r.estimated).toBe(false)
  })

  it('falls through when ANY item has zero/null price (no partial sums)', () => {
    const o: OrderForRevenue = {
      totalPrice: 0,
      items: [
        { productId: 'p1', quantity: 2, price: 10.00 },
        { productId: 'p2', quantity: 1, price: 0 },
      ],
    }
    const r = computeOrderRevenue(o)
    // Without a priceLookup, falls through to Tier 4 (none) rather
    // than silently emitting a partial Tier 2 number.
    expect(r.source).toBe('none')
  })

  it('handles string-serialised item prices', () => {
    const o: OrderForRevenue = {
      totalPrice: 0,
      items: [{ productId: 'p1', quantity: 3, price: '7.25' }],
    }
    const r = computeOrderRevenue(o)
    expect(r.cents).toBe(2175)
    expect(r.source).toBe('item_sum')
  })
})

describe('computeOrderRevenue — Tier 3: ChannelListing estimate', () => {
  it('uses ChannelListing.price when items have no prices', () => {
    const lookup: PriceLookup = {
      byChannelListing: new Map([['p1|IT', 19.99]]),
      byProduct: new Map(),
    }
    const o: OrderForRevenue = {
      totalPrice: 0,
      marketplace: 'IT',
      items: [{ productId: 'p1', quantity: 2, price: 0 }],
    }
    const r = computeOrderRevenue(o, lookup)
    expect(r.cents).toBe(3998)
    expect(r.source).toBe('channel_listing')
    expect(r.estimated).toBe(true)
    expect(r.awaitingPrice).toBe(true)
  })

  it('falls back to Product.basePrice when no ChannelListing', () => {
    const lookup: PriceLookup = {
      byChannelListing: new Map(),
      byProduct: new Map([['p1', 12.00]]),
    }
    const o: OrderForRevenue = {
      totalPrice: 0,
      marketplace: 'IT',
      items: [{ productId: 'p1', quantity: 3, price: 0 }],
    }
    const r = computeOrderRevenue(o, lookup)
    expect(r.cents).toBe(3600)
    expect(r.source).toBe('base_price')
    expect(r.estimated).toBe(true)
  })

  it('mixes channel_listing + base_price when items differ', () => {
    const lookup: PriceLookup = {
      byChannelListing: new Map([['p1|IT', 20.00]]),
      byProduct: new Map([['p2', 10.00]]),
    }
    const o: OrderForRevenue = {
      totalPrice: 0,
      marketplace: 'IT',
      items: [
        { productId: 'p1', quantity: 1, price: 0 },
        { productId: 'p2', quantity: 2, price: 0 },
      ],
    }
    const r = computeOrderRevenue(o, lookup)
    expect(r.cents).toBe(4000) // 20 + (10*2)
    expect(r.source).toBe('mixed_estimate')
    expect(r.estimated).toBe(true)
  })

  it('returns NONE when neither channel listing nor basePrice exists', () => {
    const o: OrderForRevenue = {
      totalPrice: 0,
      marketplace: 'IT',
      items: [{ productId: 'p1', quantity: 1, price: 0 }],
    }
    const r = computeOrderRevenue(o, EMPTY_LOOKUP)
    expect(r.source).toBe('none')
    expect(r.cents).toBe(0)
    expect(r.awaitingPrice).toBe(true)
  })

  it('item without productId is silently skipped (no productId = no lookup possible)', () => {
    const lookup: PriceLookup = {
      byChannelListing: new Map([['p1|IT', 20.00]]),
      byProduct: new Map(),
    }
    const o: OrderForRevenue = {
      totalPrice: 0,
      marketplace: 'IT',
      items: [
        { productId: null, quantity: 1, price: 0 },
        { productId: 'p1', quantity: 1, price: 0 },
      ],
    }
    const r = computeOrderRevenue(o, lookup)
    expect(r.cents).toBe(2000) // only p1 contributed
    expect(r.source).toBe('channel_listing')
  })
})

describe('computeOrderRevenue — waterfall precedence', () => {
  it('Tier 1 wins over Tier 2 even when items have prices', () => {
    const o: OrderForRevenue = {
      totalPrice: 100,
      items: [{ productId: 'p1', quantity: 5, price: 999 }],
    }
    const r = computeOrderRevenue(o)
    expect(r.cents).toBe(10000)
    expect(r.source).toBe('order_total')
  })

  it('Tier 2 wins over Tier 3 (real items beat estimate)', () => {
    const lookup: PriceLookup = {
      byChannelListing: new Map([['p1|IT', 999.99]]),
      byProduct: new Map(),
    }
    const o: OrderForRevenue = {
      totalPrice: 0,
      marketplace: 'IT',
      items: [{ productId: 'p1', quantity: 1, price: 10 }],
    }
    const r = computeOrderRevenue(o, lookup)
    expect(r.cents).toBe(1000)
    expect(r.source).toBe('item_sum')
    expect(r.estimated).toBe(false)
  })
})

describe('rollupRevenue', () => {
  it('separates confirmed vs estimated cents', () => {
    const results = [
      { revenue: { cents: 4000, source: 'order_total' as const, estimated: false, awaitingPrice: false } },
      { revenue: { cents: 2000, source: 'item_sum' as const, estimated: false, awaitingPrice: false } },
      { revenue: { cents: 1500, source: 'channel_listing' as const, estimated: true, awaitingPrice: true } },
      { revenue: { cents: 800, source: 'base_price' as const, estimated: true, awaitingPrice: true } },
      { revenue: { cents: 0, source: 'none' as const, estimated: false, awaitingPrice: true } },
    ]
    const r = rollupRevenue(results)
    expect(r.confirmedCents).toBe(6000)
    expect(r.estimatedCents).toBe(2300)
    expect(r.totalCents).toBe(8300)
    expect(r.awaitingPriceCount).toBe(2)  // the 2 estimated ones (cents > 0 + awaitingPrice)
    expect(r.zeroCount).toBe(1)           // the NONE
  })

  it('mixed_estimate counts toward estimatedCents', () => {
    const results = [
      { revenue: { cents: 5000, source: 'mixed_estimate' as const, estimated: true, awaitingPrice: true } },
    ]
    const r = rollupRevenue(results)
    expect(r.estimatedCents).toBe(5000)
    expect(r.totalCents).toBe(5000)
    expect(r.awaitingPriceCount).toBe(1)
  })

  it('empty input returns zeroed rollup', () => {
    const r = rollupRevenue([])
    expect(r).toEqual({
      confirmedCents: 0,
      estimatedCents: 0,
      totalCents: 0,
      awaitingPriceCount: 0,
      zeroCount: 0,
      fxMissingCount: 0,
    })
  })
})

// DA-RT.8 — FX conversion via FxLookup. EUR-only batches skip the FX
// path entirely; non-EUR batches multiply native cents by the rate.
describe('computeOrderRevenue — Tier FX (DA-RT.8)', () => {
  it('passes through EUR unchanged when FxLookup provided', () => {
    const fx = { rates: new Map([['GBP', 1.15]]), asOf: new Date() }
    const r = computeOrderRevenue({ totalPrice: 100, currencyCode: 'EUR' }, undefined, fx)
    expect(r.cents).toBe(10000)
    expect(r.nativeCents).toBe(10000)
    expect(r.fxMissing).toBe(false)
  })

  it('converts GBP cents to EUR via the lookup', () => {
    const fx = { rates: new Map([['GBP', 1.15]]), asOf: new Date() }
    const r = computeOrderRevenue({ totalPrice: 100, currencyCode: 'GBP' }, undefined, fx)
    expect(r.nativeCents).toBe(10000)
    expect(r.cents).toBe(11500) // 100 GBP × 1.15 = 115 EUR
    expect(r.currency).toBe('GBP')
    expect(r.fxMissing).toBe(false)
  })

  it('flags fxMissing when the currency is absent from the lookup', () => {
    const fx = { rates: new Map([['GBP', 1.15]]), asOf: new Date() }
    const r = computeOrderRevenue({ totalPrice: 100, currencyCode: 'TRY' }, undefined, fx)
    // Falls back to native; UI should flag
    expect(r.cents).toBe(10000)
    expect(r.nativeCents).toBe(10000)
    expect(r.fxMissing).toBe(true)
  })

  it('Tier 2 item_sum also gets FX applied', () => {
    const fx = { rates: new Map([['GBP', 1.15]]), asOf: new Date() }
    const o = {
      totalPrice: 0,
      currencyCode: 'GBP',
      items: [{ productId: 'p1', quantity: 2, price: 10 }],
    }
    const r = computeOrderRevenue(o, undefined, fx)
    expect(r.source).toBe('item_sum')
    expect(r.nativeCents).toBe(2000) // 2 × 10 GBP × 100 = 2000 GBP cents
    expect(r.cents).toBe(2300)        // × 1.15 = 23.00 EUR
  })
})

describe('rollupRevenue — FX missing exclusion (DA-RT.8)', () => {
  it('excludes fxMissing orders from totals but counts them', () => {
    const results = [
      { revenue: { cents: 5000, nativeCents: 5000, currency: 'EUR', source: 'order_total' as const, estimated: false, awaitingPrice: false, fxMissing: false } },
      { revenue: { cents: 3000, nativeCents: 3000, currency: 'TRY', source: 'order_total' as const, estimated: false, awaitingPrice: false, fxMissing: true } },
    ]
    const r = rollupRevenue(results)
    expect(r.confirmedCents).toBe(5000) // only the EUR order
    expect(r.fxMissingCount).toBe(1)
    expect(r.totalCents).toBe(5000)
  })
})

/**
 * The pricing engine shows a LISTING's price exactly as Nexus's own rules give it (2026-10-01).
 *
 * 🔴 WHAT THIS GUARDS. `/pricing`'s "Price" column, its "Resolved price", the Products page's Pricing lens, the
 * `/pricing/alerts` "Price" and the rule simulator's "Current" all show this engine's number as the listing's price,
 * and `POST /pricing/push` and the snapshot repricer send it. It disagreed with the price the master-price cascade and
 * the channel price door actually store and send (`@nexus/shared/listing-price`):
 *   - a following listing in another currency was priced with an FX-converted master (Nexus refuses to send that);
 *   - a following listing in a tax-inclusive market had VAT added on top of the master (the cascade sends the master);
 *   - a pinned listing with no priceOverride was priced by the channel rule (it keeps its own price);
 *   - MATCH_AMAZON was shown as "lowest competitor − 0.01" (Nexus does not set that price — a suggestion);
 *   - a listing's price was clamped to the engine's cost floor (nothing sends that);
 *   - cents were rounded with `Math.round(n * 100) / 100` (10.005 → 10.00; the cascade gives 10.01).
 * Now the listing's price is the shared rule's, and the engine's own numbers are a labelled `breakdown.suggestion`.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./connection-resolver.service.js', () => ({ primaryConnectionIds: vi.fn(async () => new Map([['AMAZON', 'account-1']])) }))

let resolvePrice: typeof import('./pricing-engine.service.js').resolvePrice
beforeAll(async () => { resolvePrice = (await import('./pricing-engine.service.js')).resolvePrice })

const CURRENCY: Record<string, string> = { IT: 'EUR', UK: 'GBP' }
interface Setup {
  listing: Record<string, unknown> | null
  product?: Record<string, unknown>
  vatRate?: number
  taxInclusive?: boolean
}
function fake(setup: Setup) {
  return {
    marketplace: { findUnique: vi.fn(async ({ where }: any) => ({ currency: CURRENCY[where.channel_code.code], vatRate: setup.vatRate ?? null, taxInclusive: setup.taxInclusive ?? false })) },
    productVariation: { findUnique: vi.fn(async () => null) },
    product: { findFirst: vi.fn(async () => ({ id: 'p-A', basePrice: 10, costPrice: null, minPrice: null, maxPrice: null, ...setup.product })) },
    channelListing: { findUnique: vi.fn(async () => setup.listing) },
    offer: { findUnique: vi.fn(async () => null) },
    fxRate: { findFirst: vi.fn(async () => ({ rate: 0.85 })) },
    stockCostLayer: { findFirst: vi.fn(async () => null) },
    pricingRuleVariation: { findMany: vi.fn(async () => []) },
  } as any
}
/** A following listing on Amazon IT, at 10 under FIXED, unless told otherwise. */
const listing = (over: Record<string, unknown> = {}) => ({ id: 'L-A', followMasterPrice: true, pricingRule: 'FIXED', priceAdjustmentPercent: null, price: 10, priceOverride: null,
  salePrice: null, lowestCompetitorPrice: null, estimatedFbaFee: null, referralFeePercent: null, ...over })
const resolve = (setup: Setup, marketplace = 'IT') => resolvePrice(fake(setup), { sku: 'A', channel: 'AMAZON', marketplace })

beforeEach(() => vi.clearAllMocks())

describe('a following listing carries its rule\'s price — the cascade\'s and the door\'s', () => {
  it('🔴 PERCENT +10 in a tax-inclusive 22% market is 11.00, not 13.42: no VAT on a follower price', async () => {
    const r = await resolve({ listing: listing({ pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: 10, price: 11 }), taxInclusive: true, vatRate: 22 })
    expect(r).toMatchObject({ price: 11, source: 'CHANNEL_RULE', constraints: { isClamped: false } })
    expect(r.breakdown.appliedRule).toMatchObject({ type: 'PERCENT_OF_MASTER', adjustment: 10 })
  })

  it('🔴 FIXED in a tax-inclusive market is the master (10), source MASTER_INHERIT', async () => {
    expect(await resolve({ listing: listing(), taxInclusive: true, vatRate: 22 })).toMatchObject({ price: 10, source: 'MASTER_INHERIT' })
  })

  it('🔴 rounds with the one cents helper: master 10 at +0.05% is 10.01', async () => {
    expect((await resolve({ listing: listing({ pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: 0.05 }) })).price).toBe(10.01)
  })

  it('🔴 a market in another currency keeps its own price (refuse, don\'t convert) and says so', async () => {
    const r = await resolve({ listing: listing({ pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: 10, price: 9.5 }) }, 'UK')
    expect(r).toMatchObject({ price: 9.5, currency: 'GBP', source: 'LISTING_PRICE' })
    expect(r.warnings.join(' ')).toContain('Not converted: the master price is EUR 10.00 and this market sells in GBP')
  })
})

describe('a pinned listing keeps its own price', () => {
  it('🔴 pinned with a price and no priceOverride: its own 25, never the channel rule\'s 11', async () => {
    const r = await resolve({ listing: listing({ followMasterPrice: false, pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: 10, price: 25 }) })
    expect(r).toMatchObject({ price: 25, source: 'CHANNEL_OVERRIDE' })
  })

  it('pinned with a priceOverride: the override', async () => {
    expect(await resolve({ listing: listing({ followMasterPrice: false, price: 25, priceOverride: 24 }) })).toMatchObject({ price: 24, source: 'CHANNEL_OVERRIDE' })
  })
})

describe('the engine\'s own numbers are suggestions, labelled', () => {
  it('🔴 MATCH_AMAZON keeps the listing\'s price; competitor − 0.01 is a suggestion', async () => {
    const r = await resolve({ listing: listing({ pricingRule: 'MATCH_AMAZON', price: 14, lowestCompetitorPrice: 13 }), taxInclusive: true, vatRate: 22 })
    expect(r).toMatchObject({ price: 14, source: 'LISTING_PRICE' })
    expect(r.breakdown.suggestion).toMatchObject({ kind: 'MATCH_AMAZON', price: 12.99 })
    expect(r.reasoning.join(' ')).toContain('a suggestion, not the listing\'s price')
  })

  it('🔴 a listing price below the cost floor is NOT clamped: it is a warning', async () => {
    const r = await resolve({ listing: listing(), product: { costPrice: 12 } })
    expect(r).toMatchObject({ price: 10, constraints: { isClamped: false } })
    expect(r.warnings.join(' ')).toContain('The listing\'s price 10.00 is below the floor 13.20')
  })

  it('a GBP listing is not held to a EUR-derived floor either (refuse, don\'t convert)', async () => {
    const r = await resolve({ listing: listing({ price: 5 }), product: { minPrice: 9 } }, 'UK')
    expect(r.warnings.join(' ')).not.toContain('below the floor')
  })

  it('a market the SKU has no listing on is an estimate, priced and clamped as before', async () => {
    const r = await resolve({ listing: null, taxInclusive: true, vatRate: 22 })
    expect(r).toMatchObject({ price: 12.2, source: 'MASTER_INHERIT' })
  })
})

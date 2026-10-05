import { describe, it, expect } from 'vitest'
import {
  computeEffectivePrice,
  computeMarginPercent,
  passesFilters,
  type ResolveCandidate,
} from './ebay-volume-pricing-resolve.service.js'

const base = (over: Partial<ResolveCandidate> = {}): ResolveCandidate => ({
  sku: 'SKU-1',
  basePrice: 100,
  brand: 'Xavia',
  cost: 60,
  listingPrice: null,
  ...over,
})

describe('VP.3 — computeEffectivePrice', () => {
  it('uses the listing price when set', () => {
    expect(computeEffectivePrice(base({ listingPrice: 90 }))).toBe(90)
  })
  it('falls back to basePrice when the listing price is null', () => {
    expect(computeEffectivePrice(base({ listingPrice: null }))).toBe(100)
  })
  it('falls back to basePrice when the listing price is 0', () => {
    expect(computeEffectivePrice(base({ listingPrice: 0 }))).toBe(100)
  })
})

describe('VP.3 — computeMarginPercent', () => {
  it('computes margin off the effective price', () => {
    expect(computeMarginPercent(80, 60)).toBe(25) // (80-60)/80
  })
  it('is null when cost is unknown', () => {
    expect(computeMarginPercent(80, null)).toBeNull()
  })
  it('is null when cost is non-positive', () => {
    expect(computeMarginPercent(80, 0)).toBeNull()
  })
})

describe('VP.3 — passesFilters', () => {
  it('keeps a candidate matching every filter, returning price + margin', () => {
    const r = passesFilters(base({ listingPrice: 80 }), {
      brand: 'Xavia',
      maxPrice: 100,
      minMarginPercent: 20,
    })
    expect(r).toEqual({ sku: 'SKU-1', price: 80, marginPercent: 25 })
  })
  it('drops on brand mismatch', () => {
    expect(passesFilters(base(), { brand: 'Other' })).toBeNull()
  })
  it('drops when the effective price exceeds maxPrice', () => {
    expect(passesFilters(base({ listingPrice: 120 }), { maxPrice: 100 })).toBeNull()
  })
  it('drops when margin is below the floor', () => {
    // base 100, cost 95 → 5% margin, below a 20% floor
    expect(passesFilters(base({ cost: 95 }), { minMarginPercent: 20 })).toBeNull()
  })
  it('drops when a margin floor is set but cost is unknown', () => {
    expect(passesFilters(base({ cost: null }), { minMarginPercent: 20 })).toBeNull()
  })
  it('keeps an unknown-cost candidate when no margin floor is set', () => {
    const r = passesFilters(base({ cost: null }), { maxPrice: 200 })
    expect(r).toEqual({ sku: 'SKU-1', price: 100, marginPercent: null })
  })
  it('keeps when no filters are set', () => {
    expect(passesFilters(base(), {})).not.toBeNull()
  })
})

/**
 * S4 (per-channel SKU) — the resolved list names each product by the SKU eBay holds for its ACTIVE listing on this
 * marketplace: the product SKU (parity), or the listing's own confirmed SKU. A wanted SKU eBay has not confirmed is not
 * named (eBay never received it). The push sends this list as eBay's inventory references.
 */
describe('S4 — resolveSkusByRule names the SKU eBay holds', async () => {
  const { resolveSkusByRule } = await import('./ebay-volume-pricing-resolve.service.js')
  const listing = (over: Record<string, unknown> = {}) => ({ price: null, productId: 'p', aliasKey: '', channelSku: null, liveChannelSku: null,
    listingStatus: 'ACTIVE', isPublished: true, externalListingId: '123', ...over })
  const product = (sku: string, over: Record<string, unknown> = {}) => ({ sku, basePrice: 50, brand: 'Xavia', costPrice: null, weightedAvgCostCents: null, channelListings: [listing(over)] })
  const db = (products: unknown[]) => ({ product: { findMany: async () => products }, categoryClosure: { findMany: async () => [] } }) as never

  it('parity: no own SKU → the product SKU; an own confirmed SKU → that SKU; a wanted-only SKU → the product SKU', async () => {
    const result = await resolveSkusByRule(db([product('VP-PLAIN'), product('VP-OWN', { liveChannelSku: 'VP-OWN-EB', channelSku: 'VP-OWN-EB' }), product('VP-WANT', { channelSku: 'VP-WANT-EB' })]),
      { marketplace: 'IT' })
    expect(result.skus).toEqual(['VP-OWN-EB', 'VP-PLAIN', 'VP-WANT'])
  })

  it('the listing read asks for the SKU facts of the ACTIVE eBay listing on this marketplace', async () => {
    let args: any = null
    await resolveSkusByRule({ product: { findMany: async (a: unknown) => { args = a; return [] } }, categoryClosure: { findMany: async () => [] } } as never, { marketplace: 'IT' })
    expect(args.select.channelListings).toMatchObject({ where: { channel: 'EBAY', marketplace: 'IT', listingStatus: 'ACTIVE' },
      select: { channelSku: true, liveChannelSku: true, listingStatus: true, isPublished: true, externalListingId: true } })
  })
})

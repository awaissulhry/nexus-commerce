/**
 * Phase 0 — outbound-sync correctness helpers.
 *
 * 0.1: master→eBay sync sent a malformed inventory_item body (price on the item,
 * wrong qty key, hardcoded USD) → silent oversell/mispricing. These lock the
 * corrected shapes: qty under shipToLocationAvailability, price on the OFFER,
 * EUR/GBP currency, and a GET-merge-PUT that never wipes existing content.
 * 0.2: the Amazon price PATCH was scoped to the US marketplace for an IT seller.
 */
import { describe, it, expect, vi } from 'vitest'

// outbound-sync.service imports prisma + clients at module load; mock the DB so
// importing the pure helpers under test never spins up a real PrismaClient.
vi.mock('../db.js', () => ({ default: {} }))

import {
  ebayCurrencyForMarket,
  mergeEbayInventoryItem,
  buildEbayOfferUpdate,
  resolveAmazonMarketplaceId,
} from './outbound-sync.service.js'

describe('Phase 0.1 — eBay sync payload helpers', () => {
  it('currency is EUR for EU sites, GBP for GB — never USD', () => {
    expect(ebayCurrencyForMarket('EBAY_IT')).toBe('EUR')
    expect(ebayCurrencyForMarket('EBAY_DE')).toBe('EUR')
    expect(ebayCurrencyForMarket('EBAY_GB')).toBe('GBP')
    expect(ebayCurrencyForMarket(undefined)).toBe('EUR')
  })

  it('qty merges under shipToLocationAvailability and preserves existing content (no wipe)', () => {
    const existing = { product: { title: 'Keep me', aspects: { Color: ['Black'] } }, condition: 'NEW' }
    const merged = mergeEbayInventoryItem(existing, { quantity: 7 })
    expect(merged.availability.shipToLocationAvailability.quantity).toBe(7)
    expect(merged.availability.availableQuantity).toBeUndefined() // not the wrong (ignored) key
    expect(merged.product.title).toBe('Keep me') // existing content preserved
    expect(merged.condition).toBe('NEW')
  })

  it('content updates land under product.* when provided', () => {
    const merged = mergeEbayInventoryItem({}, { title: 'New', description: 'Desc', images: ['u1', 'u2'] })
    expect(merged.product.title).toBe('New')
    expect(merged.product.description).toBe('Desc')
    expect(merged.product.imageUrls).toEqual(['u1', 'u2'])
  })

  it('price goes on the OFFER (pricingSummary) with the right currency, preserving offer fields', () => {
    const offer = { offerId: 'O1', categoryId: '123', listingPolicies: { x: 1 } }
    const updated = buildEbayOfferUpdate(offer, 189.9, 'EUR')
    expect(updated.pricingSummary.price).toEqual({ value: '189.90', currency: 'EUR' })
    expect(updated.offerId).toBe('O1')
    expect(updated.categoryId).toBe('123')
    expect(updated.listingPolicies).toEqual({ x: 1 })
  })
})

describe('Phase 0.2 — Amazon marketplace resolution (never US by default)', () => {
  it('resolves EU market codes to their marketplace IDs', () => {
    expect(resolveAmazonMarketplaceId('IT')).toBe('APJ6JRA9NG5V4')
    expect(resolveAmazonMarketplaceId('DE')).toBe('A1PA6795UKMFR9')
    expect(resolveAmazonMarketplaceId('FR')).toBe('A13V1IB3VIYZZH')
  })
  it('defaults to IT (not US) for missing/unknown markets', () => {
    expect(resolveAmazonMarketplaceId(undefined)).toBe('APJ6JRA9NG5V4')
    expect(resolveAmazonMarketplaceId('zz')).toBe('APJ6JRA9NG5V4')
  })
  it('passes a full Amazon marketplace id through unchanged', () => {
    expect(resolveAmazonMarketplaceId('A1PA6795UKMFR9')).toBe('A1PA6795UKMFR9')
  })
})

/**
 * EFX P9a / P9f — unit tests for the pure offer-term mappers.
 *
 *  buildBestOfferTerms → eBay Inventory API listingPolicies.bestOfferTerms
 *  resolveQuantityLimitPerBuyer → offer.quantityLimitPerBuyer (wave 2: null when blank or invalid, never 10)
 */

import { describe, it, expect } from 'vitest'
import {
  buildBestOfferTerms,
  resolveQuantityLimitPerBuyer,
} from './ebay-variation-push.service.js'

describe('buildBestOfferTerms', () => {
  it('enabled with both thresholds → floor=autoDecline, ceiling=autoAccept', () => {
    const terms = buildBestOfferTerms(
      { sku: 'A', best_offer_enabled: true, best_offer_floor: 40, best_offer_ceiling: 90 },
      'EUR',
    )
    expect(terms).toEqual({
      bestOfferEnabled: true,
      autoAcceptPrice: { value: '90.00', currency: 'EUR' },
      autoDeclinePrice: { value: '40.00', currency: 'EUR' },
    })
  })

  it('enabled with only floor → autoDeclinePrice, no autoAcceptPrice', () => {
    const terms = buildBestOfferTerms(
      { best_offer_enabled: true, best_offer_floor: 25, best_offer_ceiling: 0 },
      'EUR',
    )
    expect(terms).toEqual({
      bestOfferEnabled: true,
      autoDeclinePrice: { value: '25.00', currency: 'EUR' },
    })
    expect(terms).not.toHaveProperty('autoAcceptPrice')
  })

  it('enabled with only ceiling → autoAcceptPrice, no autoDeclinePrice', () => {
    const terms = buildBestOfferTerms(
      { best_offer_enabled: true, best_offer_ceiling: 120 },
      'GBP',
    )
    expect(terms).toEqual({
      bestOfferEnabled: true,
      autoAcceptPrice: { value: '120.00', currency: 'GBP' },
    })
  })

  it('disabled → explicit { bestOfferEnabled: false } (clears live terms)', () => {
    expect(buildBestOfferTerms({ best_offer_enabled: false }, 'EUR')).toEqual({
      bestOfferEnabled: false,
    })
    // undefined / missing also treated as off
    expect(buildBestOfferTerms({}, 'EUR')).toEqual({ bestOfferEnabled: false })
  })

  it('enabled with blank/zero thresholds → thresholds omitted', () => {
    const terms = buildBestOfferTerms(
      { best_offer_enabled: true, best_offer_floor: 0, best_offer_ceiling: '' },
      'EUR',
    )
    expect(terms).toEqual({ bestOfferEnabled: true })
  })

  it('floor ≥ ceiling → both thresholds dropped, warning pushed, still enabled', () => {
    const warnings: string[] = []
    const terms = buildBestOfferTerms(
      { sku: 'BAD', best_offer_enabled: true, best_offer_floor: 90, best_offer_ceiling: 90 },
      'EUR',
      warnings,
    )
    expect(terms).toEqual({ bestOfferEnabled: true })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('BAD')
    expect(warnings[0]).toContain('below')
  })

  it('floor > ceiling → dropped + warned', () => {
    const warnings: string[] = []
    const terms = buildBestOfferTerms(
      { best_offer_enabled: true, best_offer_floor: 100, best_offer_ceiling: 50 },
      'EUR',
      warnings,
    )
    expect(terms).toEqual({ bestOfferEnabled: true })
    expect(warnings).toHaveLength(1)
  })

  it('warning sink dedups identical warnings', () => {
    const warnings: string[] = ['already there']
    const row = { sku: 'X', best_offer_enabled: true, best_offer_floor: 5, best_offer_ceiling: 5 }
    buildBestOfferTerms(row, 'EUR', warnings)
    buildBestOfferTerms(row, 'EUR', warnings)
    // one pre-existing + exactly one new (deduped on the 2nd call)
    expect(warnings).toHaveLength(2)
  })
})

// Wave 2 (2026-10-05) — the one eBay rule (`ebay-quantity-limit.ts`): a whole number, 1 or more, is sent; blank is null and
// an invalid value is null plus a warning. Nexus never invents 10 any more: a null limit keeps eBay's (`offerQuantityLimit`).
describe('resolveQuantityLimitPerBuyer', () => {
  it('blank / null / empty string → null (nothing of ours; eBay keeps its limit), and nothing is said', () => {
    const warnings: string[] = []
    expect(resolveQuantityLimitPerBuyer({}, warnings)).toBeNull()
    expect(resolveQuantityLimitPerBuyer({ quantity_limit_per_buyer: '' }, warnings)).toBeNull()
    expect(resolveQuantityLimitPerBuyer({ quantity_limit_per_buyer: null }, warnings)).toBeNull()
    expect(warnings).toEqual([])
  })

  it('valid override wins', () => {
    expect(resolveQuantityLimitPerBuyer({ quantity_limit_per_buyer: 3 })).toBe(3)
    expect(resolveQuantityLimitPerBuyer({ quantity_limit_per_buyer: '5' })).toBe(5)
  })

  it.each([0, -4, 'abc', 2.7])('a value eBay cannot take (%j) → null and one warning, never a guess', (value) => {
    const warnings: string[] = []
    expect(resolveQuantityLimitPerBuyer({ quantity_limit_per_buyer: value }, warnings)).toBeNull()
    resolveQuantityLimitPerBuyer({ quantity_limit_per_buyer: value }, warnings)
    expect(warnings).toEqual([`Max per buyer: eBay takes a whole number, 1 or more (this row has ${JSON.stringify(value)}). Not sent.`])
  })
})

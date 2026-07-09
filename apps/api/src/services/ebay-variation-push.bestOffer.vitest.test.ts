/**
 * EFX P9a / P9f — unit tests for the pure offer-term mappers.
 *
 *  buildBestOfferTerms → eBay Inventory API listingPolicies.bestOfferTerms
 *  resolveQuantityLimitPerBuyer → offer.quantityLimitPerBuyer (default 10)
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

describe('resolveQuantityLimitPerBuyer', () => {
  it('blank / null / empty string → default 10', () => {
    expect(resolveQuantityLimitPerBuyer({})).toBe(10)
    expect(resolveQuantityLimitPerBuyer({ quantity_limit_per_buyer: '' })).toBe(10)
    expect(resolveQuantityLimitPerBuyer({ quantity_limit_per_buyer: null })).toBe(10)
  })

  it('valid override wins', () => {
    expect(resolveQuantityLimitPerBuyer({ quantity_limit_per_buyer: 3 })).toBe(3)
    expect(resolveQuantityLimitPerBuyer({ quantity_limit_per_buyer: '5' })).toBe(5)
  })

  it('below 1 or non-numeric → default 10', () => {
    expect(resolveQuantityLimitPerBuyer({ quantity_limit_per_buyer: 0 })).toBe(10)
    expect(resolveQuantityLimitPerBuyer({ quantity_limit_per_buyer: -4 })).toBe(10)
    expect(resolveQuantityLimitPerBuyer({ quantity_limit_per_buyer: 'abc' })).toBe(10)
  })

  it('fractional → floored', () => {
    expect(resolveQuantityLimitPerBuyer({ quantity_limit_per_buyer: 2.7 })).toBe(2)
  })
})

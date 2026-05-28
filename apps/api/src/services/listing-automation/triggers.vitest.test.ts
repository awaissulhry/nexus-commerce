/**
 * OL.D.7 — listing-automation context/condition contract tests.
 *
 * The evaluator builds a ListingRuleContext; rule authors write
 * conditions against dotted paths into it (price.spreadPct,
 * inventory.available, health.score). These tests pin that contract so a
 * rename on either side fails loudly instead of silently never matching.
 * Pure — no DB, no engine I/O.
 */

import { describe, it, expect } from 'vitest'
import { currencyForMarket, marketLanguage, type ListingRuleContext } from './triggers.js'
import { matchesAllConditions, type Condition } from '../automation-rule.service.js'

describe('listing-automation market maps', () => {
  it('currencyForMarket', () => {
    expect(currencyForMarket('IT')).toBe('EUR')
    expect(currencyForMarket('UK')).toBe('GBP')
    expect(currencyForMarket('GB')).toBe('GBP')
    expect(currencyForMarket('US')).toBe('USD')
    expect(currencyForMarket('zz')).toBe('EUR')
  })
  it('marketLanguage', () => {
    expect(marketLanguage('DE')).toBe('de')
    expect(marketLanguage('IT')).toBe('it')
    expect(marketLanguage('UK')).toBe('en')
    expect(marketLanguage('XX')).toBe('en')
  })
})

describe('listing-automation condition ↔ context contract', () => {
  const base = { product: { id: 'p1', sku: 'SKU', name: 'Helmet', basePrice: 99 }, listings: [] }

  it('price_diverged: price.spreadPct path resolves', () => {
    const ctx: ListingRuleContext = { ...base, trigger: 'price_diverged', price: { min: 89, max: 119, spreadPct: 33.7, currency: 'EUR' } }
    expect(matchesAllConditions([{ field: 'price.spreadPct', op: 'gt', value: 10 }], ctx)).toBe(true)
    expect(matchesAllConditions([{ field: 'price.spreadPct', op: 'gt', value: 50 }], ctx)).toBe(false)
  })

  it('inventory_low: inventory.available path resolves', () => {
    const ctx: ListingRuleContext = { ...base, trigger: 'inventory_low', inventory: { available: 3 } }
    expect(matchesAllConditions([{ field: 'inventory.available', op: 'lt', value: 5 }], ctx)).toBe(true)
    expect(matchesAllConditions([{ field: 'inventory.available', op: 'lt', value: 2 }], ctx)).toBe(false)
  })

  it('listing_health_low: health.score path resolves', () => {
    const ctx: ListingRuleContext = { ...base, trigger: 'listing_health_low', health: { score: 45, ready: 1, total: 3, blocked: 2 } }
    expect(matchesAllConditions([{ field: 'health.score', op: 'lt', value: 60 }], ctx)).toBe(true)
  })

  it('master_content_changed: content.staleCount path resolves', () => {
    const ctx: ListingRuleContext = { ...base, trigger: 'master_content_changed', content: { staleCount: 2, masterName: 'Helmet' } }
    expect(matchesAllConditions([{ field: 'content.staleCount', op: 'gte', value: 1 }], ctx)).toBe(true)
  })

  it('empty conditions match every trigger (fire-always rule)', () => {
    const ctx: ListingRuleContext = { ...base, trigger: 'inventory_low', inventory: { available: 0 } }
    expect(matchesAllConditions([] as Condition[], ctx)).toBe(true)
  })
})

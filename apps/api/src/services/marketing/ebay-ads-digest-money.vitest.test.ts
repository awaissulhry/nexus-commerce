/**
 * AM-21 — the eBay weekly digest never adds two currencies. Pure; fake ids and amounts only.
 */
import { describe, expect, it } from 'vitest'
import { weeklyDigestMoney, type CurrencySums } from './ebay-ads-digest-money.js'

const eur = (fees: number, sales: number, extra: Partial<CurrencySums> = {}): CurrencySums => ({ currency: 'EUR', adFeesCents: fees, salesCents: sales, clicks: 10, impressions: 100, soldQty: 1, ...extra })
const gbp = (fees: number, sales: number, extra: Partial<CurrencySums> = {}): CurrencySums => ({ currency: 'GBP', adFeesCents: fees, salesCents: sales, clicks: 5, impressions: 50, soldQty: 2, ...extra })
const names: Record<string, string> = { 'EXT-1': 'Italy general', 'EXT-2': 'UK priority' }
const markets: Record<string, string> = { 'EXT-1': 'EBAY_IT', 'EXT-2': 'EBAY_GB' }
const base = { nameOf: (id: string) => names[id], marketOf: (id: string) => markets[id] }

describe('weeklyDigestMoney', () => {
  it('THE FINDING: a week with UK ads keeps one total per currency; the single totals carry no money', () => {
    const m = weeklyDigestMoney({
      ...base,
      current: [eur(900, 9999), gbp(555, 4444)],
      prior: [eur(222, 3333)],
      campaigns: [
        { entityId: 'EXT-1', currency: 'EUR', adFeesCents: 900, salesCents: 9999, soldQty: 1 },
        { entityId: 'EXT-2', currency: 'GBP', adFeesCents: 555, salesCents: 4444, soldQty: 2 },
      ],
    })
    expect(m.currency).toBeNull()
    // Was 1455 / 14443 printed with "€".
    expect(m.totals).toEqual({ adFeesCents: null, salesCents: null, clicks: 15, impressions: 150, soldQty: 3, acosPct: null })
    expect(m.prior).toEqual({ adFeesCents: null, salesCents: null, soldQty: 1 })
    expect(m.byCurrency).toEqual([
      { currency: 'EUR', adFeesCents: 900, salesCents: 9999, soldQty: 1, acosPct: 9, prior: { adFeesCents: 222, salesCents: 3333, soldQty: 1 } },
      { currency: 'GBP', adFeesCents: 555, salesCents: 4444, soldQty: 2, acosPct: 12.5, prior: { adFeesCents: 0, salesCents: 0, soldQty: 0 } },
    ])
    expect(m.byMarketplace.map((x) => [x.marketplace, x.currency, x.adFeesCents])).toEqual([['EBAY_IT', 'EUR', 900], ['EBAY_GB', 'GBP', 555]])
    expect(m.movers.map((x) => [x.campaign, x.currency, x.feesCents])).toEqual([['Italy general', 'EUR', 900], ['UK priority', 'GBP', 555]])
    expect(m.moneyLine).toBe('€9.00 fees · €99.99 sales; £5.55 fees · £44.44 sales')
  })

  it('a one-currency week keeps its totals exactly as before, in its own currency', () => {
    const m = weeklyDigestMoney({ ...base, current: [eur(900, 9999)], prior: [eur(222, 3333)], campaigns: [] })
    expect(m.currency).toBe('EUR')
    expect(m.totals).toMatchObject({ adFeesCents: 900, salesCents: 9999, acosPct: 9 })
    expect(m.prior).toEqual({ adFeesCents: 222, salesCents: 3333, soldQty: 1 })
    const uk = weeklyDigestMoney({ ...base, current: [gbp(555, 4444)], prior: [], campaigns: [] })
    expect([uk.currency, uk.moneyLine]).toEqual(['GBP', '£5.55 fees · £44.44 sales'])
  })

  it('an empty week: EUR zeros, as the digest always showed', () => {
    const m = weeklyDigestMoney({ ...base, current: [], prior: [], campaigns: [] })
    expect([m.currency, m.totals.adFeesCents, m.moneyLine]).toEqual(['EUR', 0, '€0.00 fees · €0.00 sales'])
  })

  it('a deleted campaign keeps its fees under "unknown", per currency', () => {
    const m = weeklyDigestMoney({
      ...base, current: [eur(10, 0), gbp(20, 0)], prior: [],
      campaigns: [
        { entityId: 'GONE-1', currency: 'EUR', adFeesCents: 10, salesCents: 0, soldQty: 0 },
        { entityId: 'GONE-2', currency: 'GBP', adFeesCents: 20, salesCents: 0, soldQty: 0 },
      ],
    })
    expect(m.byMarketplace.map((x) => [x.marketplace, x.currency, x.adFeesCents])).toEqual([['unknown', 'GBP', 20], ['unknown', 'EUR', 10]])
  })
})

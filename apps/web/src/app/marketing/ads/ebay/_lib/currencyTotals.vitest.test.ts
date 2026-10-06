/**
 * AM-21 — eBay totals never add GBP and EUR. Fake amounts only.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { currencyTotals, moneyPerCurrency, ratioPerCurrency } from './currencyTotals'

type Row = { ccy: string | null; fees: number; sales: number }
const rows: Row[] = [
  { ccy: 'EUR', fees: 900, sales: 9999 },
  { ccy: 'GBP', fees: 555, sales: 4444 },
  { ccy: 'EUR', fees: 100, sales: 1 },
  { ccy: null, fees: 0, sales: 0 },
]
const totals = currencyTotals(rows, (r) => r.ccy, (r) => r.fees, (r) => r.sales)

describe('currencyTotals', () => {
  it('one total per currency (a row with no currency renders as EUR, so it counts as EUR)', () => {
    expect(totals).toEqual([
      { currency: 'EUR', feesCents: 1000, salesCents: 10000 },
      { currency: 'GBP', feesCents: 555, salesCents: 4444 },
    ])
  })

  it('THE FINDING: the old total printed one euro sum of 1555 cents; now each currency keeps its own', () => {
    const text = moneyPerCurrency(totals, (t) => t.feesCents)
    expect(text).toBe('€10.00 · £5.55')
    expect(text).not.toContain('15.55')
  })

  it('a ratio is per currency when there are several, and plain when there is one', () => {
    const acos = (t: { feesCents: number; salesCents: number }) => (t.salesCents > 0 ? t.feesCents / t.salesCents : null)
    const fmt = (v: number) => `${(v * 100).toFixed(2)}%`
    expect(ratioPerCurrency(totals, acos, fmt)).toBe('EUR 10.00% · GBP 12.49%')
    expect(ratioPerCurrency(totals.slice(0, 1), acos, fmt)).toBe('10.00%')
    expect(ratioPerCurrency([{ currency: 'EUR', feesCents: 5, salesCents: 0 }], acos, fmt)).toBe('—')
    expect(ratioPerCurrency([], acos, fmt)).toBe('—')
  })

  it('no rows: zero, in euros as before', () => {
    expect(moneyPerCurrency([], (t) => t.feesCents)).toBe('€0.00')
  })
})

describe('the eBay screens use it', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
  it('the campaign grid totals, the KPI strip and the digest never format a total with the euro-only formatter', () => {
    const grid = read('../campaigns/EbayCampaignsGrid.tsx')
    expect(grid).not.toMatch(/total: \(vr\) => money\(/)
    expect(grid).toContain('moneyPerCurrency(totOf(vr), (t) => t.feesCents)')
    expect(read('../_dash/KpiStrip.tsx')).not.toContain('eurC(')
    expect(read('../digest/EbayDigestClient.tsx')).not.toContain('eurC(')
  })
})

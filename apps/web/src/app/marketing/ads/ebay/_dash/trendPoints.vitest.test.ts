/**
 * AM-19 (eBay) — the dashboard trend chart: a day with no sales has no ACOS. The key is left out so
 * the line breaks there, instead of plotting 0 % (the best value) on the worst day.
 */
import { describe, expect, it } from 'vitest'
import { trendPoint } from './trendPoints'

const point = (over: Record<string, unknown>) => ({
  date: '2026-09-30', impressions: 100, clicks: 4, adFeesCents: 350, salesCents: 0, soldQty: 0,
  ctrPct: 4, acosPct: null, avgCpcCents: null, ...over,
}) as never

describe('trendPoint', () => {
  it('leaves ACOS out on a no-sales day — a gap, never 0', () => {
    const p = trendPoint(point({ acosPct: null }))
    expect(p).not.toHaveProperty('acos')
    expect(p).toMatchObject({ date: '09-30', fees: 3.5, sales: 0, clicks: 4, impressions: 100 })
  })
  it('keeps a real ACOS, including one above 100 %', () => {
    expect(trendPoint(point({ salesCents: 200, acosPct: 175 })).acos).toBe(175)
    expect(trendPoint(point({ salesCents: 2000, acosPct: 17.5 })).acos).toBe(17.5)
  })
})

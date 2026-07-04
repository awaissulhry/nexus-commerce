/** E4 — pure guardrail + validation + CSV parsing tests (+ EV3 scheduling). */
import { describe, it, expect } from 'vitest'
import { rateGuardrail, resolveStartDate, validateRatePct } from './ebay-ads-write.service.js'
import { parseAdsOpsCsv } from './ebay-ads-csv.service.js'

describe('resolveStartDate (EV3 — scheduled campaign start)', () => {
  const now = new Date('2026-07-04T15:30:00Z')
  it('blank/undefined ⇒ launch now, not scheduled', () => {
    expect(resolveStartDate(undefined, now)).toEqual({ start: now, scheduled: false })
    expect(resolveStartDate('', now)).toEqual({ start: now, scheduled: false })
  })
  it('a future date ⇒ that UTC midnight, scheduled', () => {
    const r = resolveStartDate('2026-07-10', now)
    expect(r.start.toISOString()).toBe('2026-07-10T00:00:00.000Z')
    expect(r.scheduled).toBe(true)
  })
  it("today ⇒ clamps to now (eBay rejects a startDate earlier than the call), not scheduled", () => {
    const r = resolveStartDate('2026-07-04', now)
    expect(r.start.getTime()).toBe(now.getTime())
    expect(r.scheduled).toBe(false)
  })
  it('a past date throws', () => {
    expect(() => resolveStartDate('2026-07-03', now)).toThrow(/cannot be in the past/)
  })
  it('garbage throws', () => {
    expect(() => resolveStartDate('next tuesday', now)).toThrow(/ISO date/)
  })
})

describe('validateRatePct (verified eBay bounds 2–100%)', () => {
  it('accepts in-range, rejects out-of-range', () => {
    expect(validateRatePct(2)).toBeNull()
    expect(validateRatePct(13.1)).toBeNull()
    expect(validateRatePct(100)).toBeNull()
    expect(validateRatePct(1.9)).toMatch(/between 2%/)
    expect(validateRatePct(101)).toMatch(/between 2%/)
    expect(validateRatePct(NaN)).toMatch(/not a number/)
  })
})

describe('rateGuardrail (margin-aware §4.2)', () => {
  it('BLOCKS a rate above break-even without an override', () => {
    const g = rateGuardrail(20, 15.5, 'ESTIMATED')
    expect(g.blocked).toMatch(/exceeds break-even 15.5%/)
    expect(g.warning).toBeNull()
  })
  it('allows above break-even ONLY with an explicit named override (audited)', () => {
    const g = rateGuardrail(20, 15.5, 'ESTIMATED', { reason: 'launch push for 2 weeks' })
    expect(g.blocked).toBeNull()
    expect(g.warning).toMatch(/override: launch push/)
  })
  it('an empty override reason does not unlock', () => {
    expect(rateGuardrail(20, 15.5, 'ESTIMATED', { reason: '   ' }).blocked).toMatch(/exceeds break-even/)
  })
  it('allows at/below break-even silently', () => {
    expect(rateGuardrail(15.5, 15.5, 'ESTIMATED')).toEqual({ blocked: null, warning: null })
    expect(rateGuardrail(10, 15.5, 'ESTIMATED')).toEqual({ blocked: null, warning: null })
  })
  it('unknown economics ⇒ allowed with a warning (manual-only binds automations, not operators)', () => {
    const g = rateGuardrail(12, null, 'MISSING_COGS')
    expect(g.blocked).toBeNull()
    expect(g.warning).toMatch(/no product cost/)
  })
})

describe('parseAdsOpsCsv', () => {
  const header = 'entity,campaign_id,listing_id,ad_rate_pct,keyword_id,bid_eur,daily_budget_eur,action'
  it('parses rate, add, remove, keyword bid/status, campaign action/budget', () => {
    const csv = [
      header,
      'AD,123,555,,,,,remove',
      'AD,123,556,9.5,,,,',
      'AD,123,557,8,,,,add',
      'KEYWORD,123,,,kw1,0.45,,',
      'KEYWORD,123,,,kw2,,,pause',
      'CAMPAIGN,123,,,,,12.50,',
      'CAMPAIGN,124,,,,,,end',
    ].join('\n')
    const r = parseAdsOpsCsv(csv)
    expect(r.errors).toEqual([])
    expect(r.ops).toEqual([
      { kind: 'AD_REMOVE', campaignExternalId: '123', listingId: '555', row: 2 },
      { kind: 'AD_RATE', campaignExternalId: '123', listingId: '556', ratePct: 9.5, row: 3 },
      { kind: 'AD_ADD', campaignExternalId: '123', listingId: '557', ratePct: 8, row: 4 },
      { kind: 'KEYWORD_BID', campaignExternalId: '123', keywordExternalId: 'kw1', bidCents: 45, row: 5 },
      { kind: 'KEYWORD_STATUS', campaignExternalId: '123', keywordExternalId: 'kw2', status: 'PAUSED', row: 6 },
      { kind: 'CAMPAIGN_BUDGET', campaignExternalId: '123', dailyBudgetCents: 1250, row: 7 },
      { kind: 'CAMPAIGN_ACTION', campaignExternalId: '124', action: 'end', row: 8 },
    ])
  })
  it('collects row-level errors without dying', () => {
    const r = parseAdsOpsCsv([header, 'AD,123,,,,,,', 'WAT,123,,,,,,', ',123,,,,,,'].join('\n'))
    expect(r.ops).toEqual([])
    expect(r.errors.map((e) => e.row)).toEqual([2, 3, 4])
  })
  it('handles quoted cells + comma decimals', () => {
    const r = parseAdsOpsCsv(['entity,campaign_id,listing_id,ad_rate_pct', 'AD,"1,23",555,"7,5"'].join('\n'))
    expect(r.ops[0]).toMatchObject({ campaignExternalId: '1,23', ratePct: 7.5 })
  })
  it('rejects an empty file loudly', () => {
    expect(parseAdsOpsCsv('').errors[0]!.error).toMatch(/no data rows/)
  })
})

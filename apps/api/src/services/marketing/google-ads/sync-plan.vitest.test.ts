/**
 * Google Ads step 1b — what one run reads and costs (sync-plan.ts), pure: 21 operations on a regular day, 26 on an
 * account's first run (ad groups and keywords 90 days in three pieces, search terms 30 days in two); the windows in the
 * account's days ending yesterday (14 / 7 days, 35 / 14 on its Sundays), a grain that missed runs reaching back to the
 * day after its last day read but never further than its first read; tiers dropped 5, 4, 3, 2; the retention cut-off.
 */
import { describe, expect, it } from 'vitest'
import {
  CORE_OPS, DETAIL_STEPS, GRAINS, READ_RESOURCE_TEXT, RUN_OPS, SPARE_OPS, TIER_CANDIDATES, detailOps, grainOf, grainRead, knownTimeZone, planDetailRead,
  retentionKeepFrom, runOps,
} from './sync-plan.js'

const ROME = 'Europe/Rome'
const TUESDAY = new Date('2026-10-13T06:25:00Z') // the account's yesterday is 2026-10-12
const SUNDAY = new Date('2026-10-18T06:25:00Z') // a Sunday in Rome; yesterday 2026-10-17
const NEVER = {}
const READ_TO_11 = Object.fromEntries(GRAINS.map((g) => [g.resource, '2026-10-11']))
const spec = (resource: string) => grainOf(resource as never)!

describe('the cost of a run', () => {
  it('core 4 + step 1b 16 (tiers 4 / 5 / 4 / 3) + 1 spare = 21', () => {
    expect([CORE_OPS, SPARE_OPS, RUN_OPS]).toEqual([4, 1, 21])
    const perTier = (tier: number) => DETAIL_STEPS.filter((s) => s.tier === tier).reduce((t, s) => t + s.ops, 0)
    expect([perTier(2), perTier(3), perTier(4), perTier(5)]).toEqual([4, 5, 4, 3])
    expect(DETAIL_STEPS.map((s) => s.resource)).toEqual([
      'CAMPAIGN_SETTINGS', 'AD_POLICY', 'PRODUCT_STATUS', 'AUTO_APPLY',
      'AD_GROUP_DAYS', 'KEYWORD_DAYS', 'ASSET_GROUP_DAYS', 'PRODUCT_DAYS', 'SEARCH_TERM_DAYS',
      'AD_GROUPS', 'KEYWORDS', 'CAMPAIGN_NEGATIVES', 'ASSET_GROUPS',
      'NEGATIVE_LISTS', 'RECOMMENDATIONS',
    ])
    for (const step of DETAIL_STEPS) expect(READ_RESOURCE_TEXT[step.resource]).toMatch(/^[A-Z][a-z -]+$/)
  })

  it('a regular day costs 21, a Sunday too; short of allowance the run drops tier 5, then 4, 3, 2', () => {
    for (const now of [TUESDAY, SUNDAY]) {
      const steps = planDetailRead({ timeZone: ROME, now, readThrough: READ_TO_11 })
      expect(runOps(steps, [2, 3, 4, 5])).toBe(21)
    }
    const steps = planDetailRead({ timeZone: ROME, now: TUESDAY, readThrough: READ_TO_11 })
    expect(TIER_CANDIDATES).toEqual([[2, 3, 4, 5], [2, 3, 4], [2, 3], [2], []])
    expect(TIER_CANDIDATES.map((tiers) => runOps(steps, tiers))).toEqual([21, 18, 14, 9, 5])
  })

  it('the first run of an account costs 26: ad groups +2, keywords +2, search terms +1', () => {
    const steps = planDetailRead({ timeZone: ROME, now: TUESDAY, readThrough: NEVER })
    expect(runOps(steps, [2, 3, 4, 5])).toBe(26)
    expect(Object.fromEntries(steps.filter((s) => s.grain).map((s) => [s.resource, s.ops]))).toEqual({
      AD_GROUP_DAYS: 3, KEYWORD_DAYS: 3, ASSET_GROUP_DAYS: 1, PRODUCT_DAYS: 1, SEARCH_TERM_DAYS: 2,
    })
    // A grain's first read is reserved whole with its tier, or not at all.
    expect(detailOps(steps, [3])).toBe(10)
    expect(detailOps(steps, [2])).toBe(4)
  })
})

describe('the windows (the account\'s days, never today)', () => {
  it('first reads: ad groups and keywords 90 days in three 30-day pieces; search terms 30 in two; asset groups 90 and products 30 in one', () => {
    expect(grainRead(spec('AD_GROUP_DAYS'), ROME, TUESDAY, null)).toEqual({
      window: { from: '2026-07-15', to: '2026-10-12' }, first: true,
      chunks: [{ from: '2026-07-15', to: '2026-08-13' }, { from: '2026-08-14', to: '2026-09-12' }, { from: '2026-09-13', to: '2026-10-12' }],
    })
    expect(grainRead(spec('KEYWORD_DAYS'), ROME, TUESDAY, null).chunks).toHaveLength(3)
    expect(grainRead(spec('SEARCH_TERM_DAYS'), ROME, TUESDAY, null)).toEqual({
      window: { from: '2026-09-13', to: '2026-10-12' }, first: true,
      chunks: [{ from: '2026-09-13', to: '2026-09-27' }, { from: '2026-09-28', to: '2026-10-12' }],
    })
    expect(grainRead(spec('ASSET_GROUP_DAYS'), ROME, TUESDAY, null)).toMatchObject({ window: { from: '2026-07-15', to: '2026-10-12' }, chunks: [{ from: '2026-07-15', to: '2026-10-12' }] })
    expect(grainRead(spec('PRODUCT_DAYS'), ROME, TUESDAY, null)).toMatchObject({ window: { from: '2026-09-13', to: '2026-10-12' }, chunks: [{ from: '2026-09-13', to: '2026-10-12' }] })
  })

  it('a regular day: 14 days (search terms 7); the account\'s Sunday: 35 (search terms 14), one query each', () => {
    expect(grainRead(spec('KEYWORD_DAYS'), ROME, TUESDAY, '2026-10-11')).toEqual({ window: { from: '2026-09-29', to: '2026-10-12' }, chunks: [{ from: '2026-09-29', to: '2026-10-12' }], first: false })
    expect(grainRead(spec('SEARCH_TERM_DAYS'), ROME, TUESDAY, '2026-10-11').window).toEqual({ from: '2026-10-06', to: '2026-10-12' })
    expect(grainRead(spec('PRODUCT_DAYS'), ROME, SUNDAY, '2026-10-16')).toEqual({ window: { from: '2026-09-13', to: '2026-10-17' }, chunks: [{ from: '2026-09-13', to: '2026-10-17' }], first: false })
    expect(grainRead(spec('SEARCH_TERM_DAYS'), ROME, SUNDAY, '2026-10-16').window).toEqual({ from: '2026-10-04', to: '2026-10-17' })
    // The account's day, not UTC's: at 23:30 UTC on Saturday it is already Sunday in Rome.
    expect(grainRead(spec('SEARCH_TERM_DAYS'), ROME, new Date('2026-10-17T23:30:00Z'), '2026-10-16').window).toEqual({ from: '2026-10-04', to: '2026-10-17' })
  })

  it('missed runs: from the day after the last day read, in pieces when longer than the Sunday window, never past the first read', () => {
    expect(grainRead(spec('AD_GROUP_DAYS'), ROME, TUESDAY, '2026-09-01')).toEqual({
      window: { from: '2026-09-02', to: '2026-10-12' }, first: false,
      chunks: [{ from: '2026-09-02', to: '2026-10-01' }, { from: '2026-10-02', to: '2026-10-12' }],
    })
    expect(grainRead(spec('SEARCH_TERM_DAYS'), ROME, TUESDAY, '2026-09-20').chunks).toEqual([{ from: '2026-09-21', to: '2026-10-05' }, { from: '2026-10-06', to: '2026-10-12' }])
    expect(grainRead(spec('KEYWORD_DAYS'), ROME, TUESDAY, '2026-01-01')).toMatchObject({ window: { from: '2026-07-15', to: '2026-10-12' }, first: false })
    // Read up to yesterday already (a second run the same day): the regular window again.
    expect(grainRead(spec('KEYWORD_DAYS'), ROME, TUESDAY, '2026-10-12').window).toEqual({ from: '2026-09-29', to: '2026-10-12' })
  })

  it('the plan carries each grain\'s window; the other steps have none', () => {
    const steps = planDetailRead({ timeZone: ROME, now: TUESDAY, readThrough: { KEYWORD_DAYS: '2026-10-11' } })
    expect(steps.find((s) => s.resource === 'KEYWORD_DAYS')?.grain).toMatchObject({ first: false, window: { from: '2026-09-29' }, spec: { entityType: 'KEYWORD' } })
    expect(steps.find((s) => s.resource === 'AD_GROUP_DAYS')?.grain?.first).toBe(true)
    expect(steps.find((s) => s.resource === 'AD_GROUPS')?.grain).toBeUndefined()
  })
})

describe('retention and time zones', () => {
  it('search terms keep 180 days, the other grains 400 (campaign days are not a grain here: kept forever)', () => {
    expect(retentionKeepFrom(spec('SEARCH_TERM_DAYS'), ROME, TUESDAY)).toBe('2026-04-16')
    for (const resource of ['AD_GROUP_DAYS', 'KEYWORD_DAYS', 'ASSET_GROUP_DAYS', 'PRODUCT_DAYS']) {
      expect(retentionKeepFrom(spec(resource), ROME, TUESDAY)).toBe('2025-09-08')
    }
    expect(GRAINS.map((g) => g.entityType)).not.toContain('CAMPAIGN')
  })

  it('a time zone Intl does not know is none', () => {
    expect(knownTimeZone('Europe/Rome')).toBe('Europe/Rome')
    expect(knownTimeZone('')).toBeNull()
    expect(knownTimeZone(null)).toBeNull()
    expect(knownTimeZone('Not/AZone')).toBeNull()
  })
})

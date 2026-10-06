/**
 * Date-range engine tests (moved with the module from services/advertising
 * in E1) + priorRange ("vs previous period") coverage added in E1.
 */
import { describe, it, expect } from 'vitest'
import { resolveRange, priorRange, bucketFor, comparisonRanges, lastCompleteDay } from './date-range.js'

// Fixed "now" = 2026-05-31 10:00 UTC → Rome is 2026-05-31 (CEST, UTC+2).
const NOW = new Date('2026-05-31T10:00:00.000Z')

describe('resolveRange', () => {
  it('today', () => {
    const r = resolveRange({ preset: 'today' }, NOW)
    expect(r.sinceStr).toBe('2026-05-31')
    expect(r.untilStr).toBe('2026-05-31')
    expect(r.days).toBe(1)
    expect(r.includesToday).toBe(true)
  })
  it('yesterday', () => {
    const r = resolveRange({ preset: 'yesterday' }, NOW)
    expect(r.sinceStr).toBe('2026-05-30')
    expect(r.untilStr).toBe('2026-05-30')
    expect(r.includesToday).toBe(false)
  })
  // AM-16 — "Last N days" is N COMPLETE days ending yesterday: today has no daily report yet.
  it('last7 = the 7 complete days ending yesterday', () => {
    const r = resolveRange({ preset: 'last7' }, NOW)
    expect(r.sinceStr).toBe('2026-05-24')
    expect(r.untilStr).toBe('2026-05-30')
    expect(r.days).toBe(7)
    expect(r.includesToday).toBe(false)
  })
  it('last30', () => {
    const r = resolveRange({ preset: 'last30' }, NOW)
    expect(r.sinceStr).toBe('2026-05-01')
    expect(r.untilStr).toBe('2026-05-30')
    expect(r.days).toBe(30)
    expect(r.includesToday).toBe(false)
  })
  it('last14 and last90 end yesterday too', () => {
    expect(resolveRange({ preset: 'last14' }, NOW)).toMatchObject({ sinceStr: '2026-05-17', untilStr: '2026-05-30', days: 14 })
    expect(resolveRange({ preset: 'last90' }, NOW)).toMatchObject({ sinceStr: '2026-03-02', untilStr: '2026-05-30', days: 90 })
  })
  it('wtd starts Monday (2026-05-31 is a Sunday → Mon 2026-05-25)', () => {
    const r = resolveRange({ preset: 'wtd' }, NOW)
    expect(r.sinceStr).toBe('2026-05-25')
    expect(r.untilStr).toBe('2026-05-31')
  })
  it('mtd', () => {
    const r = resolveRange({ preset: 'mtd' }, NOW)
    expect(r.sinceStr).toBe('2026-05-01')
    expect(r.untilStr).toBe('2026-05-31')
  })
  it('last_month', () => {
    const r = resolveRange({ preset: 'last_month' }, NOW)
    expect(r.sinceStr).toBe('2026-04-01')
    expect(r.untilStr).toBe('2026-04-30')
    expect(r.days).toBe(30)
  })
  it('qtd (Q2 starts April)', () => {
    const r = resolveRange({ preset: 'qtd' }, NOW)
    expect(r.sinceStr).toBe('2026-04-01')
    expect(r.untilStr).toBe('2026-05-31')
  })
  it('ytd', () => {
    const r = resolveRange({ preset: 'ytd' }, NOW)
    expect(r.sinceStr).toBe('2026-01-01')
    expect(r.untilStr).toBe('2026-05-31')
  })
  it('last_year', () => {
    const r = resolveRange({ preset: 'last_year' }, NOW)
    expect(r.sinceStr).toBe('2025-01-01')
    expect(r.untilStr).toBe('2025-12-31')
    expect(r.includesToday).toBe(false)
  })
  it('custom range (normalises swapped order)', () => {
    const r = resolveRange({ preset: 'custom', startDate: '2026-03-15', endDate: '2026-02-01' }, NOW)
    expect(r.sinceStr).toBe('2026-02-01')
    expect(r.untilStr).toBe('2026-03-15')
    expect(r.preset).toBe('custom')
  })
  it('windowDays fallback (no preset) — complete days, ending yesterday', () => {
    const r = resolveRange({ windowDays: 30 }, NOW)
    expect(r.sinceStr).toBe('2026-05-01')
    expect(r.untilStr).toBe('2026-05-30')
    expect(r.days).toBe(30)
    expect(r.includesToday).toBe(false)
    expect(r.preset).toBe('window')
  })
  it('defaults to 7-day window when nothing supplied', () => {
    const r = resolveRange({}, NOW)
    expect(r.days).toBe(7)
    expect(r.untilStr).toBe('2026-05-30')
    expect(r.preset).toBe('window')
  })
})

describe('priorRange (vs previous period)', () => {
  it('last7 compares to the 7 days immediately before', () => {
    const r = resolveRange({ preset: 'last7' }, NOW) // 05-24..05-30
    const p = priorRange(r)
    expect(p.sinceStr).toBe('2026-05-17')
    expect(p.untilStr).toBe('2026-05-23')
    expect(p.days).toBe(7)
    expect(p.includesToday).toBe(false)
  })
  it('today compares to yesterday', () => {
    const p = priorRange(resolveRange({ preset: 'today' }, NOW))
    expect(p.sinceStr).toBe('2026-05-30')
    expect(p.untilStr).toBe('2026-05-30')
  })
  it('is equal-length block, not calendar-aware (documented contract)', () => {
    const r = resolveRange({ preset: 'last_month' }, NOW) // Apr 1..30 (30d)
    const p = priorRange(r)
    expect(p.untilStr).toBe('2026-03-31')
    expect(p.sinceStr).toBe('2026-03-02') // 30 days ending Mar 31 — by design
    expect(p.days).toBe(30)
  })
  it('crosses month/year boundaries correctly', () => {
    const r = resolveRange({ preset: 'custom', startDate: '2026-01-05', endDate: '2026-01-14' }, NOW) // 10d
    const p = priorRange(r)
    expect(p.sinceStr).toBe('2025-12-26')
    expect(p.untilStr).toBe('2026-01-04')
    expect(p.days).toBe(10)
  })
  it('chains: prior of prior is the block before that', () => {
    const r = resolveRange({ preset: 'last7' }, NOW)
    const pp = priorRange(priorRange(r))
    expect(pp.sinceStr).toBe('2026-05-10')
    expect(pp.untilStr).toBe('2026-05-16')
  })
})

// AM-16 — a change compares complete days on both sides; today (no daily report yet) is never on one side only.
describe('comparisonRanges (complete days only)', () => {
  it('the last complete day is yesterday in Rome', () => {
    expect(lastCompleteDay(NOW)).toBe('2026-05-30')
    // 23:30 UTC on the 30th is already the 31st in Rome, so yesterday is the 30th.
    expect(lastCompleteDay(new Date('2026-05-30T23:30:00.000Z'))).toBe('2026-05-30')
  })
  it('a window of complete days compares with the equal block before it', () => {
    const c = comparisonRanges(resolveRange({ preset: 'last7' }, NOW), NOW)!
    expect(c.todayLeftOut).toBe(false)
    expect([c.current.sinceStr, c.current.untilStr]).toEqual(['2026-05-24', '2026-05-30'])
    expect([c.prior.sinceStr, c.prior.untilStr, c.prior.days]).toEqual(['2026-05-17', '2026-05-23', 7])
  })
  it('month to date leaves today out of BOTH sides', () => {
    const c = comparisonRanges(resolveRange({ preset: 'mtd' }, NOW), NOW)! // 05-01..05-31, today = 05-31
    expect(c.todayLeftOut).toBe(true)
    expect([c.current.sinceStr, c.current.untilStr, c.current.days]).toEqual(['2026-05-01', '2026-05-30', 30])
    expect([c.prior.sinceStr, c.prior.untilStr, c.prior.days]).toEqual(['2026-04-01', '2026-04-30', 30])
  })
  it('a custom range ending today is clamped the same way', () => {
    const c = comparisonRanges(resolveRange({ startDate: '2026-05-25', endDate: '2026-05-31' }, NOW), NOW)!
    expect([c.current.untilStr, c.current.days, c.prior.sinceStr, c.prior.untilStr]).toEqual(['2026-05-30', 6, '2026-05-19', '2026-05-24'])
  })
  it('today alone has no complete day: no comparison, not a made-up one', () => {
    expect(comparisonRanges(resolveRange({ preset: 'today' }, NOW), NOW)).toBeNull()
  })
})

describe('bucketFor', () => {
  it('daily for short ranges', () => { expect(bucketFor(7)).toBe('day'); expect(bucketFor(90)).toBe('day') })
  it('weekly for medium', () => { expect(bucketFor(180)).toBe('week') })
  it('monthly for long', () => { expect(bucketFor(700)).toBe('month') })
})

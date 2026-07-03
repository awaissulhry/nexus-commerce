/**
 * Date-range engine tests (moved with the module from services/advertising
 * in E1) + priorRange ("vs previous period") coverage added in E1.
 */
import { describe, it, expect } from 'vitest'
import { resolveRange, priorRange, bucketFor } from './date-range.js'

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
  it('last7 = today + 6 prior', () => {
    const r = resolveRange({ preset: 'last7' }, NOW)
    expect(r.sinceStr).toBe('2026-05-25')
    expect(r.untilStr).toBe('2026-05-31')
    expect(r.days).toBe(7)
  })
  it('last30', () => {
    const r = resolveRange({ preset: 'last30' }, NOW)
    expect(r.sinceStr).toBe('2026-05-02')
    expect(r.days).toBe(30)
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
  it('windowDays fallback (no preset)', () => {
    const r = resolveRange({ windowDays: 30 }, NOW)
    expect(r.sinceStr).toBe('2026-05-02')
    expect(r.untilStr).toBe('2026-05-31')
    expect(r.preset).toBe('window')
  })
  it('defaults to 7-day window when nothing supplied', () => {
    const r = resolveRange({}, NOW)
    expect(r.days).toBe(7)
    expect(r.preset).toBe('window')
  })
})

describe('priorRange (vs previous period)', () => {
  it('last7 compares to the 7 days immediately before', () => {
    const r = resolveRange({ preset: 'last7' }, NOW) // 05-25..05-31
    const p = priorRange(r)
    expect(p.sinceStr).toBe('2026-05-18')
    expect(p.untilStr).toBe('2026-05-24')
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
    expect(pp.sinceStr).toBe('2026-05-11')
    expect(pp.untilStr).toBe('2026-05-17')
  })
})

describe('bucketFor', () => {
  it('daily for short ranges', () => { expect(bucketFor(7)).toBe('day'); expect(bucketFor(90)).toBe('day') })
  it('weekly for medium', () => { expect(bucketFor(180)).toBe('week') })
  it('monthly for long', () => { expect(bucketFor(700)).toBe('month') })
})

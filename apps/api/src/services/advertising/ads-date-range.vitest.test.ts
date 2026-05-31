import { describe, it, expect } from 'vitest'
import { resolveRange, bucketFor } from './ads-date-range.js'

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

describe('bucketFor', () => {
  it('daily for short ranges', () => { expect(bucketFor(7)).toBe('day'); expect(bucketFor(90)).toBe('day') })
  it('weekly for medium', () => { expect(bucketFor(180)).toBe('week') })
  it('monthly for long', () => { expect(bucketFor(700)).toBe('month') })
})

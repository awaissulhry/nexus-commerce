import { describe, expect, it } from 'vitest'
import { DEFAULT_PERIOD, PERIODS, parsePeriod, periodRange, periodWords, serializePeriod } from './reviewsPeriod'

describe('reviews period', () => {
  it('reads the address and falls back on anything it does not know', () => {
    expect(parsePeriod('7d')).toBe('7d')
    expect(parsePeriod(' 12M ')).toBe('12m')
    expect(parsePeriod('all')).toBe('all')
    expect(parsePeriod(null)).toBe(DEFAULT_PERIOD)
    expect(parsePeriod('14d')).toBe('30d')
    expect(parsePeriod('', '7d')).toBe('7d')
  })

  it('leaves the default out of the address and round-trips every other period', () => {
    expect(serializePeriod('30d')).toBeNull()
    expect(serializePeriod('7d', '7d')).toBeNull()
    for (const p of PERIODS) {
      const written = serializePeriod(p)
      expect(parsePeriod(written)).toBe(p)
    }
  })

  it('says each period in words', () => {
    expect(periodWords('30d')).toEqual({ label: 'last 30 days', short: '30 days', prev: 'the 30 days before' })
    expect(periodWords('12m').short).toBe('12 months')
    expect(periodWords('all')).toEqual({ label: 'all time', short: 'All time', prev: null })
  })

  it('covers the right dates and the period before', () => {
    const now = new Date('2026-10-26T10:00:00.000Z')
    const week = periodRange('7d', now)
    expect(week.from?.toISOString()).toBe('2026-10-19T10:00:00.000Z')
    expect(week.prevFrom?.toISOString()).toBe('2026-10-12T10:00:00.000Z')
    expect(week.prevTo?.toISOString()).toBe(week.from?.toISOString())
    expect(periodRange('90d', now).from?.toISOString()).toBe('2026-07-28T10:00:00.000Z')
    const year = periodRange('12m', now)
    expect(year.from?.toISOString()).toBe('2025-10-26T10:00:00.000Z')
    expect(year.prevFrom?.toISOString()).toBe('2024-10-26T10:00:00.000Z')
    expect(periodRange('all', now)).toEqual({ from: null, to: now, prevFrom: null, prevTo: null })
  })

  it('clamps a month end to the shorter month', () => {
    const leap = periodRange('12m', new Date('2028-02-29T00:00:00.000Z'))
    expect(leap.from?.toISOString()).toBe('2027-02-28T00:00:00.000Z')
  })
})

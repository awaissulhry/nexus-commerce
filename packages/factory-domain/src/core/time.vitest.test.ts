import { describe, expect, it } from 'vitest'
import {
  BUSINESS_TIME_ZONE,
  businessDate,
  businessDayRange,
  businessDayStart,
  fixedClock,
  isBusinessDate,
  parseInstant,
  toUtcIso,
} from './time'

describe('business dates (Europe/Rome)', () => {
  it('uses Europe/Rome by default', () => {
    expect(BUSINESS_TIME_ZONE).toBe('Europe/Rome')
  })

  it('puts an evening UTC instant on the next Rome day', () => {
    // 23:30 UTC on 31 December is 00:30 on 1 January in Rome (UTC+1 in winter).
    expect(businessDate(new Date('2026-12-31T23:30:00.000Z'))).toBe('2027-01-01')
    expect(businessDate(new Date('2026-12-31T22:59:59.999Z'))).toBe('2026-12-31')
    // Summer: UTC+2.
    expect(businessDate(new Date('2026-07-14T22:00:00.000Z'))).toBe('2026-07-15')
    expect(businessDate(new Date('2026-07-14T21:59:59.999Z'))).toBe('2026-07-14')
  })

  it('takes another zone when asked', () => {
    expect(businessDate(new Date('2026-12-31T23:30:00.000Z'), 'UTC')).toBe('2026-12-31')
  })

  it('finds local midnight as UTC, in winter and in summer', () => {
    expect(businessDayStart('2026-01-15').toISOString()).toBe('2026-01-14T23:00:00.000Z')
    expect(businessDayStart('2026-07-15').toISOString()).toBe('2026-07-14T22:00:00.000Z')
  })

  it('has 23 hours on the spring change day and 25 on the autumn one', () => {
    const spring = businessDayRange('2026-03-29')
    expect(spring.start.toISOString()).toBe('2026-03-28T23:00:00.000Z')
    expect(spring.end.toISOString()).toBe('2026-03-29T22:00:00.000Z')
    expect((spring.end.getTime() - spring.start.getTime()) / 3_600_000).toBe(23)
    const autumn = businessDayRange('2026-10-25')
    expect((autumn.end.getTime() - autumn.start.getTime()) / 3_600_000).toBe(25)
  })

  it('crosses month and year ends', () => {
    expect(businessDayRange('2026-12-31').end.toISOString()).toBe('2026-12-31T23:00:00.000Z')
    expect(businessDayRange('2028-02-28').end).toEqual(businessDayStart('2028-02-29'))
  })

  it('round-trips: every instant of a day lands on that day', () => {
    const { start, end } = businessDayRange('2026-10-25')
    for (let time = start.getTime(); time < end.getTime(); time += 15 * 60_000) {
      expect(businessDate(new Date(time))).toBe('2026-10-25')
    }
    expect(businessDate(end)).toBe('2026-10-26')
  })

  it('accepts only real calendar days', () => {
    expect(isBusinessDate('2028-02-29')).toBe(true)
    for (const bad of ['2026-02-29', '2026-13-01', '2026-00-10', '2026-1-01', '20261028', '2026-10-28T00:00', 20261028]) {
      expect(isBusinessDate(bad)).toBe(false)
    }
    expect(() => businessDayStart('2026-02-30')).toThrow(/calendar day/)
  })
})

describe('instants (UTC, milliseconds)', () => {
  it('are written in UTC with milliseconds', () => {
    expect(toUtcIso(new Date(Date.UTC(2026, 9, 28, 9, 15)))).toBe('2026-10-28T09:15:00.000Z')
    expect(() => toUtcIso(new Date(Number.NaN))).toThrow()
  })

  it('are read only with a zone', () => {
    expect(parseInstant('2026-10-28T10:15:00+01:00')?.toISOString()).toBe('2026-10-28T09:15:00.000Z')
    expect(parseInstant('2026-10-28T09:15:00.123Z')?.toISOString()).toBe('2026-10-28T09:15:00.123Z')
    expect(parseInstant('2026-10-28T09:15Z')?.toISOString()).toBe('2026-10-28T09:15:00.000Z')
    for (const bad of ['2026-10-28T09:15:00', '2026-10-28', '2026-02-30T09:15:00Z', '2026-10-28T24:00:00Z', '28/10/2026', 1]) {
      expect(parseInstant(bad)).toBeNull()
    }
  })

  it('a fixed clock always answers the same instant, as a fresh Date', () => {
    const clock = fixedClock('2026-10-28T09:15:00.000Z')
    const first = clock.now()
    first.setTime(0)
    expect(clock.now().toISOString()).toBe('2026-10-28T09:15:00.000Z')
    expect(() => fixedClock('yesterday')).toThrow()
  })
})

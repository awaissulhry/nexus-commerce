/**
 * ACR.4.3 — the week the digest reports on.
 *
 * A scheduler that gets its window wrong is worse than one that does not run: it delivers a
 * confident summary of the wrong days. Two properties matter and neither is obvious from
 * reading the function:
 *
 *   · `previous` must be the last COMPLETE Monday–Sunday. A Monday email that included today
 *     would report a few hours of activity as a week and show every figure collapsing.
 *   · The boundary is the OPERATOR's clock (Europe/Rome), not UTC. Rome is UTC+1/+2, so late
 *     Sunday evening in Rome is still Sunday — and a UTC-based week would already have rolled
 *     over and reported the wrong seven days.
 */
import { describe, it, expect } from 'vitest'
import { digestWindow } from './ads-weekly-digest.service.js'

/** Monday 2026-08-03 09:00 Rome — a normal mid-morning tick. */
const MONDAY = new Date('2026-08-03T07:00:00Z')

describe('previous — the last complete week', () => {
  it('on a Monday, reports the Monday–Sunday that just ended', () => {
    const w = digestWindow('previous', MONDAY)
    expect(w.from.toISOString().slice(0, 10)).toBe('2026-07-27')
    expect(w.to.toISOString().slice(0, 10)).toBe('2026-08-02')
    expect(w.complete).toBe(true)
  })

  it('never includes today — the day the digest is sent is not in it', () => {
    const w = digestWindow('previous', MONDAY)
    expect(w.to.getTime()).toBeLessThan(Date.parse('2026-08-03T00:00:00Z'))
  })

  /**
   * Monday 00:00:00.000 → Sunday 23:59:59.999 — seven days minus a millisecond, not six days
   * and not seven. The exact end matters because the queries use `lte: to`: a `to` of Sunday
   * 00:00 would silently drop the whole of the last day, and a `to` of Monday 00:00 would pull
   * in the first instant of the week being reported FROM.
   */
  it('covers the full seven days, ending on the last instant of Sunday', () => {
    const w = digestWindow('previous', MONDAY)
    expect(w.to.getTime() - w.from.getTime()).toBe(7 * 86_400_000 - 1)
    expect(w.to.toISOString()).toBe('2026-08-02T23:59:59.999Z')
    expect(w.from.toISOString()).toBe('2026-07-27T00:00:00.000Z')
  })

  it('mid-week, still reports the same completed week', () => {
    const thursday = digestWindow('previous', new Date('2026-08-06T15:00:00Z'))
    expect(thursday.from.toISOString().slice(0, 10)).toBe('2026-07-27')
    expect(thursday.to.toISOString().slice(0, 10)).toBe('2026-08-02')
  })
})

describe('current — week to date', () => {
  it('runs from this Monday and is flagged incomplete', () => {
    const w = digestWindow('current', new Date('2026-08-05T18:00:00Z'))
    expect(w.from.toISOString().slice(0, 10)).toBe('2026-08-03')
    expect(w.complete).toBe(false)
    expect(w.label).toContain('today')
  })

  it('on a Monday it is a single day, not an empty range', () => {
    const w = digestWindow('current', MONDAY)
    expect(w.from.toISOString().slice(0, 10)).toBe('2026-08-03')
    expect(w.to.getTime()).toBeGreaterThan(w.from.getTime())
  })
})

describe('the boundary is the operator’s clock, not UTC', () => {
  /**
   * 2026-08-02 23:30 Rome is 21:30 UTC on the SAME date, so both agree here. The case that
   * separates them is the other side of midnight.
   */
  it('late Sunday evening in Rome is still inside the week that is ending', () => {
    const w = digestWindow('current', new Date('2026-08-02T21:30:00Z'))
    expect(w.from.toISOString().slice(0, 10)).toBe('2026-07-27') // that Sunday's own week
  })

  /**
   * 2026-08-02 23:30 UTC is 2026-08-03 01:30 in Rome — already Monday for the operator. A
   * UTC-based implementation would still call it Sunday and report the wrong week.
   */
  it('after midnight in Rome the week has rolled over, even though UTC says Sunday', () => {
    const w = digestWindow('current', new Date('2026-08-02T23:30:00Z'))
    expect(w.from.toISOString().slice(0, 10)).toBe('2026-08-03')
    const prev = digestWindow('previous', new Date('2026-08-02T23:30:00Z'))
    expect(prev.to.toISOString().slice(0, 10)).toBe('2026-08-02')
  })
})

describe('labels say which week without needing the dates parsed', () => {
  it('a complete week names both ends', () => {
    expect(digestWindow('previous', MONDAY).label).toBe('2026-07-27 → 2026-08-02')
  })
  it('an incomplete week says so', () => {
    expect(digestWindow('current', MONDAY).label).toBe('2026-08-03 → today')
  })
})

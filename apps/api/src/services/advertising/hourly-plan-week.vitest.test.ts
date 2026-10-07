/**
 * ADS AUTONOMY W4-1 — an hourly bid plan's week in numbers (pure): the 7 × 24 summary per day, what a change adds to
 * spend hour by hour, painting given days, and the next 24 hours in the plan's own time zone. Made-up targets.
 */
import { describe, expect, it } from 'vitest'
import { hourRaise, next24, paintDays, raiseWords, targetValuesOf, weekAddsSpend, weekRaise, weekSummary, type TargetValues } from './hourly-plan-week.js'

const floor = targetValuesOf({ key: 'test-floor', pause: true }, 'Min bid')
const top = targetValuesOf({ key: 'test-top', biasPct: 50 }, 'Top 50')
const push = targetValuesOf({ key: 'test-push', biasPct: 150, bidMode: 'absolute', bidValueCents: 80 }, 'Push')
const lib = new Map<string, TargetValues>([[floor.key, floor], [top.key, top], [push.key, push]])
// Nights at the floor on weekdays, evenings pushed, the rest of the week on top.
const WEEK = { windows: [{ days: [1, 2, 3, 4, 5], startHour: 0, endHour: 6, targetKey: 'test-floor' }, { days: [1, 2, 3, 4, 5], startHour: 18, endHour: 22, targetKey: 'test-push' }], defaultTargetKey: 'test-top' }

describe('W4-1 — the week, day by day', () => {
  it('a target\'s values from the engine\'s spec: a blend\'s highest lane, a base bid only when absolute, a suppress is a floor', () => {
    expect(targetValuesOf({ key: 'b', biasPct: 20, lanes: [{ biasPct: 70 }, { biasPct: 10 }] }, 'Blend').placementPct).toBe(70)
    expect(targetValuesOf({ key: 'h', biasPct: 20, bidMode: 'hold', bidValueCents: 90 }, 'Hold').bidValueCents).toBeNull()
    expect(targetValuesOf({ key: 's', bidMode: 'suppress' }, 'Suppress').floor).toBe(true)
  })

  it('a 7 × 24 summary, Monday first: a letter per hour, hours at the floor, per target, the highest placement and base bid', () => {
    const w = weekSummary(WEEK, lib)
    expect(w.days.map((d) => d.day)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
    expect(w.legend).toEqual({ A: 'test-floor (Min bid)', B: 'test-top (Top 50)', C: 'test-push (Push)' })
    expect(w.days[0]).toEqual({
      day: 'Mon', hours: 'AAAAAABBBBBBBBBBBBCCCCBB', hoursAtFloor: 6, hoursUnplanned: 0,
      hoursByTarget: { 'test-floor': 6, 'test-top': 14, 'test-push': 4 }, highestPlacementPct: 150, highestBaseBidCents: 80,
    })
    expect(w.days[5]).toMatchObject({ day: 'Sat', hours: 'B'.repeat(24), hoursAtFloor: 0, highestPlacementPct: 50, highestBaseBidCents: null })
    expect(w.totals).toEqual({ hoursAtFloor: 30, hoursUnplanned: 0, hoursPlanned: 168, highestPlacementPct: 150, highestBaseBidCents: 80 })
    expect(weekAddsSpend(w)).toBe(true)
  })

  it('no baseline: hours no window covers hold nothing; a target that is gone is a ? and named', () => {
    const w = weekSummary({ windows: [{ days: [0], startHour: 9, endHour: 11, targetKey: 'test-gone' }], defaultTargetKey: null }, lib)
    expect(w.days[6]).toMatchObject({ day: 'Sun', hours: `${'.'.repeat(9)}??${'.'.repeat(13)}`, hoursUnplanned: 22 })
    expect(w.missingTargets).toEqual(['test-gone'])
    expect(weekAddsSpend(weekSummary({ windows: [], defaultTargetKey: 'test-floor' }, lib))).toBe(false)
  })
})

describe('W4-1 — what a change adds to spend, hour by hour', () => {
  it('leaving the floor, a higher placement, a higher base bid or floor, a newly planned hour; going down adds nothing', () => {
    expect(hourRaise(floor, top)).toEqual(['leaveFloor'])
    expect(hourRaise(floor, null)).toEqual(['leaveFloor'])
    expect(hourRaise(floor, { ...floor, floorBidCents: 10 })).toEqual(['higherBaseBid'])
    expect(hourRaise(top, push)).toEqual(['higherPlacement', 'higherBaseBid'])
    expect(hourRaise(null, top)).toEqual(['newlyPlanned'])
    expect(hourRaise(push, top)).toEqual([])
    expect(hourRaise(top, floor)).toEqual([])
  })

  it('a week against another: the hours of each kind, and the words', () => {
    const louder = { windows: [{ days: [1, 2, 3, 4, 5], startHour: 0, endHour: 2, targetKey: 'test-floor' }, ...WEEK.windows.slice(1)], defaultTargetKey: 'test-push' }
    const r = weekRaise(WEEK, lib, louder, lib)
    // Weekdays 02–06 leave the floor (20 h, counted once); every other top hour becomes push (placement and base bid up).
    expect(r).toMatchObject({ leaveFloor: 20, toFloor: 0 })
    expect(r.higherPlacement).toBe(168 - 30 - 20)
    expect(raiseWords(r)).toEqual([
      '20 hours a week leave the Min-bid floor',
      '118 hours a week hold a higher placement %',
      '118 hours a week set a higher base bid or floor',
    ])
    expect(raiseWords(weekRaise(louder, lib, WEEK, lib))).toEqual([])
  })
})

describe('W4-1 — painting given days', () => {
  it('the named days leave every window they were in and take exactly the painted ones, first; other days stay', () => {
    const painted = paintDays(WEEK.windows, [1], [{ days: [1], startHour: 8, endHour: 12, targetKey: 'test-push' }])
    expect(painted).toEqual([
      { days: [1], startHour: 8, endHour: 12, targetKey: 'test-push' },
      { days: [2, 3, 4, 5], startHour: 0, endHour: 6, targetKey: 'test-floor' },
      { days: [2, 3, 4, 5], startHour: 18, endHour: 22, targetKey: 'test-push' },
    ])
    // Letters follow the order targets first appear in the summary: here top (A), then push (B).
    const summary = weekSummary({ windows: painted, defaultTargetKey: 'test-top' }, lib)
    expect(summary.days[0].hours).toBe('AAAAAAAABBBBAAAAAAAAAAAA')
    expect(summary.legend).toMatchObject({ A: 'test-top (Top 50)', B: 'test-push (Push)' })
    // A window over every day (no days) keeps the days not painted.
    expect(paintDays([{ startHour: 0, endHour: 24, targetKey: 'test-top' }], [0, 6], [])).toEqual([{ startHour: 0, endHour: 24, targetKey: 'test-top', days: [1, 2, 3, 4, 5] }])
  })
})

describe('W4-1 — the next 24 hours', () => {
  it('from the current hour in the plan\'s time zone, one line per change of target', () => {
    // Monday 03:30 in Rome (CEST, UTC+2) = 01:30 UTC.
    const lines = next24(WEEK, lib, 'Europe/Rome', new Date('2026-10-05T01:30:00Z'))
    expect(lines).toEqual([
      { at: '2026-10-05T01:00:00.000Z', local: 'Mon 03:00', targetKey: 'test-floor', floor: true },
      { at: '2026-10-05T04:00:00.000Z', local: 'Mon 06:00', targetKey: 'test-top', floor: false },
      { at: '2026-10-05T16:00:00.000Z', local: 'Mon 18:00', targetKey: 'test-push', floor: false },
      { at: '2026-10-05T20:00:00.000Z', local: 'Mon 22:00', targetKey: 'test-top', floor: false },
      { at: '2026-10-05T22:00:00.000Z', local: 'Tue 00:00', targetKey: 'test-floor', floor: true },
    ])
  })
})

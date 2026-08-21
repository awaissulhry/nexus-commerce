/**
 * W4 (2026-08-20) — first tests this executor has ever had. They pin the two pure functions;
 * the write path is exercised on prod by clicking, not here.
 */
import { describe, expect, it } from 'vitest'
import { activeWindow, classifyOverride, computeBudget, dateActive } from './ad-budget-schedule.job.js'

describe('computeBudget', () => {
  it('multiplier multiplies the base; 0/absent value means ×1, never ×0', () => {
    expect(computeBudget(10, 'budget-multiplier', undefined, 2)).toBe(20)
    expect(computeBudget(10, 'budget-multiplier', undefined, 0)).toBe(10)
    expect(computeBudget(10, 'budget-multiplier', undefined, undefined)).toBe(10)
  })

  it('campaign-budget: set / incPct / decPct', () => {
    expect(computeBudget(10, 'campaign-budget', 'set', 25)).toBe(25)
    expect(computeBudget(10, 'campaign-budget', 'incPct', 50)).toBe(15)
    expect(computeBudget(10, 'campaign-budget', 'decPct', 30)).toBe(7)
  })

  it('clamps to Amazon’s €1 floor and rounds to cents', () => {
    expect(computeBudget(2, 'campaign-budget', 'decPct', 90)).toBe(1)
    expect(computeBudget(3.333, 'campaign-budget', 'incPct', 10)).toBe(3.67)
  })
})

describe('dateActive', () => {
  const base = { startDate: new Date('2026-08-10'), endDate: new Date('2026-08-30'), neverExpire: false }
  const on = (iso: string) => new Date(`${iso}T09:00:00Z`)

  it('inside the range with no blackouts', () => {
    expect(dateActive({ ...base, excludeDates: [] }, on('2026-08-20'))).toBe(true)
  })

  it('before start and after end are inactive; neverExpire ignores the end', () => {
    expect(dateActive({ ...base, excludeDates: [] }, on('2026-08-09'))).toBe(false)
    expect(dateActive({ ...base, excludeDates: [] }, on('2026-08-31'))).toBe(false)
    expect(dateActive({ ...base, neverExpire: true, excludeDates: [] }, on('2026-09-15'))).toBe(true)
  })

  it('🔴 a blackout range covers its END day inclusively (the W4 fix)', () => {
    const s = { ...base, excludeDates: [{ start: '2026-08-25', end: '2026-08-26' }] }
    expect(dateActive(s, on('2026-08-24'))).toBe(true)
    expect(dateActive(s, on('2026-08-25'))).toBe(false)
    // Before the fix this day was ACTIVE: date-only ISO parses to UTC midnight, "today" is pinned
    // to UTC noon, so `today <= end` failed on the operator's own chosen end date.
    expect(dateActive(s, on('2026-08-26'))).toBe(false)
    expect(dateActive(s, on('2026-08-27'))).toBe(true)
  })

  it('a half-empty or boolean-era excludeDates entry is ignored, never a crash', () => {
    expect(dateActive({ ...base, excludeDates: [{ start: '2026-08-25' }] }, on('2026-08-25'))).toBe(true)
    expect(dateActive({ ...base, excludeDates: true }, on('2026-08-20'))).toBe(true)
  })
})

/**
 * BSP-P5 (2026-08-21) — `activeWindow` is the function that decides whether a budget schedule does
 * anything at all, and until now it had no test at all. It carries three branches that are almost
 * impossible to catch by looking: the midnight wrap, the post-midnight weekday shift, and the
 * all-day (Budget Multiplier) window that BSP-P4 finally made authorable.
 *
 * Times are pinned in UTC and read in Europe/Rome, so these assert the RELATIONSHIP (what the
 * executor believes the local weekday and clock are) rather than a frozen offset.
 */
describe('activeWindow', () => {
  const TZ = 'Europe/Rome'
  // 2026-08-21 is a Friday. Rome is UTC+2 in August.
  const at = (utc: string) => new Date(utc)

  it('an ordinary window matches only inside its own hours, on its own weekday', () => {
    const w = [{ day: 5, start: '18:00', end: '20:00', adj: 'set', value: 20 }] // Fri 18–20 Rome
    expect(activeWindow(w, TZ, at('2026-08-21T17:00:00Z'))?.win).toBeTruthy()   // 19:00 Rome, Friday
    expect(activeWindow(w, TZ, at('2026-08-21T15:00:00Z'))).toBeNull()     // 17:00 Rome — before
    expect(activeWindow(w, TZ, at('2026-08-21T18:00:00Z'))).toBeNull()     // 20:00 Rome — end is exclusive
    expect(activeWindow(w, TZ, at('2026-08-22T17:00:00Z'))).toBeNull()     // Saturday
  })

  it('🔴 a wrapping window covers hour 23 AND the post-midnight half, under the FOLLOWING weekday', () => {
    // BSP.2 §2.1 — `23:00 → 02:00` on Friday. Hour 23 was unreachable before that fix; the
    // post-midnight half belongs to Saturday's clock but to Friday's row.
    const w = [{ day: 5, start: '23:00', end: '02:00', adj: 'set', value: 30 }]
    expect(activeWindow(w, TZ, at('2026-08-21T21:30:00Z'))?.win).toBeTruthy()   // 23:30 Rome Friday
    expect(activeWindow(w, TZ, at('2026-08-21T23:30:00Z'))?.win).toBeTruthy()   // 01:30 Rome SATURDAY
    expect(activeWindow(w, TZ, at('2026-08-22T00:30:00Z'))).toBeNull()     // 02:30 Rome — past the end
    expect(activeWindow(w, TZ, at('2026-08-22T21:30:00Z'))).toBeNull()     // 23:30 Rome Saturday — wrong day
  })

  it('a degenerate window (start === end) is never active, not silently all-day', () => {
    const w = [{ day: 5, start: '12:00', end: '12:00', adj: 'set', value: 9 }]
    expect(activeWindow(w, TZ, at('2026-08-21T10:00:00Z'))).toBeNull()
    expect(activeWindow(w, TZ, at('2026-08-21T13:00:00Z'))).toBeNull()
  })

  it('🔴 BSP-P4 — a window with NO hours is all-day, which is what Budget Multiplier now writes', () => {
    // The engine has always supported this; before BSP-P4 the builder could not express it,
    // because `winComplete` demanded both times. These pin the branch the form now reaches.
    const w = [{ day: 5, start: '', end: '', adj: 'mult', value: 1.5 }]
    expect(activeWindow(w, TZ, at('2026-08-21T00:30:00Z'))?.win).toBeTruthy()   // 02:30 Rome Friday
    expect(activeWindow(w, TZ, at('2026-08-21T21:30:00Z'))?.win).toBeTruthy()   // 23:30 Rome Friday
    expect(activeWindow(w, TZ, at('2026-08-22T10:00:00Z'))).toBeNull()     // Saturday
  })

  it('picks the first matching window when several overlap — the documented precedence', () => {
    const w = [
      { day: 5, start: '10:00', end: '20:00', adj: 'set', value: 10 },
      { day: 5, start: '18:00', end: '20:00', adj: 'set', value: 99 },
    ]
    expect(activeWindow(w, TZ, at('2026-08-21T17:00:00Z'))?.win.value).toBe(10)
  })

  it('no windows at all is null, never a crash', () => {
    expect(activeWindow([], TZ, at('2026-08-21T17:00:00Z'))).toBeNull()
  })
})

/**
 * BSP.6 — the window ENTRY key. This is what turns "once per window" from an accident of
 * value-keyed memoisation into a stated rule, and every one of these cases is a way the old
 * value key got it wrong.
 */
describe('activeWindow — the entry key (BSP.6)', () => {
  const TZ = 'Europe/Rome'
  const at = (utc: string) => new Date(utc)

  it('the key is stable across every tick of one entry, so the schedule writes once', () => {
    const w = [{ day: 5, start: '18:00', end: '20:00', adj: 'set', value: 20 }]
    const a = activeWindow(w, TZ, at('2026-08-21T16:01:00Z'))!  // 18:01 Rome
    const b = activeWindow(w, TZ, at('2026-08-21T17:46:00Z'))!  // 19:46 Rome, same entry
    expect(a.key).toBe(b.key)
    expect(a.entryDate).toBe('2026-08-21')
  })

  it('🔴 a WRAPPING window is ONE entry across midnight — the post-midnight half keeps the OPENING date', () => {
    // The failure this prevents: keying on "today" would make 00:00 look like a second entry and
    // the schedule would write twice for one window.
    const w = [{ day: 5, start: '23:00', end: '02:00', adj: 'set', value: 30 }]
    const before = activeWindow(w, TZ, at('2026-08-21T21:30:00Z'))!  // 23:30 Fri Rome
    const after = activeWindow(w, TZ, at('2026-08-21T23:30:00Z'))!   // 01:30 SAT Rome
    expect(before.entryDate).toBe('2026-08-21')
    expect(after.entryDate).toBe('2026-08-21')
    expect(after.key).toBe(before.key)
  })

  it('the NEXT day is a new entry, so the schedule re-arms — the bug the value key could hide', () => {
    const w = [{ day: 5, start: '18:00', end: '20:00', adj: 'set', value: 20 }]
    const fri = activeWindow(w, TZ, at('2026-08-21T17:00:00Z'))!
    const nextFri = activeWindow(w, TZ, at('2026-08-28T17:00:00Z'))!
    expect(nextFri.key).not.toBe(fri.key)
    expect(nextFri.entryDate).toBe('2026-08-28')
  })

  it('editing the window changes the key — a changed instruction is carried out', () => {
    const before = activeWindow([{ day: 5, start: '18:00', end: '20:00', adj: 'set', value: 20 }], TZ, at('2026-08-21T17:00:00Z'))!
    const after = activeWindow([{ day: 5, start: '18:00', end: '20:00', adj: 'set', value: 25 }], TZ, at('2026-08-21T17:00:00Z'))!
    expect(after.key).not.toBe(before.key)
  })

  it('adding an unrelated row does NOT change the matched window’s key — content, not index', () => {
    const one = activeWindow([{ day: 5, start: '18:00', end: '20:00', adj: 'set', value: 20 }], TZ, at('2026-08-21T17:00:00Z'))!
    const two = activeWindow(
      [{ day: 2, start: '09:00', end: '10:00', adj: 'set', value: 5 }, { day: 5, start: '18:00', end: '20:00', adj: 'set', value: 20 }],
      TZ, at('2026-08-21T17:00:00Z'))!
    expect(two.key).toBe(one.key)
  })

  it('an all-day (multiplier) window keys on the calendar day and re-arms daily', () => {
    const w = [{ day: 5, start: '', end: '', adj: 'mult', value: 1.5 }]
    const early = activeWindow(w, TZ, at('2026-08-21T00:30:00Z'))!  // 02:30 Rome Fri
    const late = activeWindow(w, TZ, at('2026-08-21T21:30:00Z'))!   // 23:30 Rome Fri
    expect(early.key).toBe(late.key)
    expect(activeWindow(w, TZ, at('2026-08-28T10:00:00Z'))!.key).not.toBe(early.key)
  })

  it('🔴 the entry date is the SCHEDULE’s timezone, not UTC', () => {
    // 22:30 UTC on the 21st is 00:30 on the 22nd in Rome. A UTC date would file this entry under
    // the 21st and the schedule would think it had already run. [[reference_day_grouping_utc_local_trap]]
    const w = [{ day: 6, start: '00:00', end: '03:00', adj: 'set', value: 12 }] // Saturday, early
    const a = activeWindow(w, TZ, at('2026-08-21T22:30:00Z'))!
    expect(a.entryDate).toBe('2026-08-22')
    expect(a.entryDate).not.toBe('2026-08-21')
  })
})

describe('classifyOverride — who took the budget (BSP.6 item 2)', () => {
  it('the pacer is named as the envelope holder, because yielding to it is CORRECT', () => {
    const c = classifyOverride('automation:budget-manager-cron')
    expect(c.kind).toBe('pacer')
    expect(c.label).toContain('monthly envelope')
  })

  it('a bare cuid is a rule — the SG.0 actor shape', () => {
    expect(classifyOverride('automation:cmt3byq3i00arl901dwu06y4u').kind).toBe('rule')
  })

  it('another budget schedule is distinguished from a rule', () => {
    expect(classifyOverride('automation:budget-schedule-cmt3byq3i00arl901dwu06y4u').kind).toBe('schedule')
  })

  it('a human override says so plainly', () => {
    expect(classifyOverride('user:awais').kind).toBe('operator')
    expect(classifyOverride('awais').kind).toBe('operator')
  })

  it('an unknown automation is a named job, never blamed on the operator', () => {
    const c = classifyOverride('automation:ads-write-reconcile')
    expect(c.kind).toBe('job')
    expect(c.label).toBe('ads write reconcile')
  })

  it('a missing actor is unattributed rather than assigned to anyone', () => {
    expect(classifyOverride(null).kind).toBe('job')
    expect(classifyOverride(null).label).toContain('unattributed')
  })
})

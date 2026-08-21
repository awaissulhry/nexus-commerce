/**
 * BP.P2 — the schedule due-check, pinned. January dates are Rome winter (+01:00) and
 * Los Angeles winter (−08:00); one August case covers the DST side.
 */
import { describe, it, expect } from 'vitest'
import { scheduleIsDue, ruleStoredSchedule, type StoredRuleSchedule } from './ads-rule-schedule.js'

const d = (iso: string) => new Date(iso)
const daily = (time = '03:00', timezone = 'cet'): StoredRuleSchedule => ({ frequency: 'Daily', time, timezone })

describe('ruleStoredSchedule', () => {
  it('reads actions[0].schedule and nothing else', () => {
    expect(ruleStoredSchedule([{ type: 'bid', schedule: { frequency: 'Daily' } }])?.frequency).toBe('Daily')
    expect(ruleStoredSchedule([{ type: 'bid_down' }])).toBeNull()
    expect(ruleStoredSchedule(undefined)).toBeNull()
  })
})

describe('scheduleIsDue', () => {
  it('no schedule → always due (engine-native rules unchanged)', () => {
    expect(scheduleIsDue(null, d('2026-01-15T10:00:00Z'), d('2026-01-15T10:05:00Z'))).toBe(true)
  })

  it('an unknown frequency never silently stalls a rule', () => {
    expect(scheduleIsDue({ frequency: 'Fortnightly?' }, d('2026-01-15T10:00:00Z'), d('2026-01-15T10:05:00Z'))).toBe(true)
  })

  it('Hourly: due at ≥55 minutes, not before', () => {
    const s: StoredRuleSchedule = { frequency: 'Hourly', timezone: 'cet' }
    expect(scheduleIsDue(s, d('2026-01-15T10:00:00Z'), d('2026-01-15T10:30:00Z'))).toBe(false)
    expect(scheduleIsDue(s, d('2026-01-15T10:00:00Z'), d('2026-01-15T11:00:00Z'))).toBe(true)
    expect(scheduleIsDue(s, null, d('2026-01-15T11:00:00Z'))).toBe(true)
  })

  it('a rule that has never evaluated is due immediately', () => {
    expect(scheduleIsDue(daily(), null, d('2026-01-15T13:00:00Z'))).toBe(true)
  })

  it('Daily 03:00 Rome: not due before the fire time', () => {
    // 01:30Z = 02:30 Rome — before 03:00.
    expect(scheduleIsDue(daily(), d('2026-01-14T10:00:00Z'), d('2026-01-15T01:30:00Z'))).toBe(false)
  })

  it('Daily 03:00 Rome: due after the fire time when yesterday ran', () => {
    // 02:10Z = 03:10 Rome; last ran yesterday 03:05 Rome.
    expect(scheduleIsDue(daily(), d('2026-01-14T02:05:00Z'), d('2026-01-15T02:10:00Z'))).toBe(true)
  })

  it('Daily 03:00 Rome: NOT due again after today already ran', () => {
    // last today 03:05 Rome (02:05Z), now 03:20 Rome (02:20Z).
    expect(scheduleIsDue(daily(), d('2026-01-15T02:05:00Z'), d('2026-01-15T02:20:00Z'))).toBe(false)
  })

  it('Daily 03:00 Rome in August (+02:00 DST): fire time projects correctly', () => {
    // 01:10Z = 03:10 Rome DST; last ran yesterday.
    expect(scheduleIsDue(daily(), d('2026-08-14T01:05:00Z'), d('2026-08-15T01:10:00Z'))).toBe(true)
    // 00:30Z = 02:30 Rome DST — before 03:00.
    expect(scheduleIsDue(daily(), d('2026-08-14T01:05:00Z'), d('2026-08-15T00:30:00Z'))).toBe(false)
  })

  it('Weekly: interval binds — 2 days is not a week', () => {
    const s: StoredRuleSchedule = { frequency: 'Weekly', time: '03:00', timezone: 'cet' }
    expect(scheduleIsDue(s, d('2026-01-13T02:05:00Z'), d('2026-01-15T02:10:00Z'))).toBe(false)
    expect(scheduleIsDue(s, d('2026-01-08T02:05:00Z'), d('2026-01-15T02:10:00Z'))).toBe(true)
  })

  it('Custom every 2 Weeks on Monday: weekday AND interval both bind', () => {
    const s: StoredRuleSchedule = { frequency: 'Custom', everyN: '2', interval: 'Weeks', onDay: 'Monday', time: '03:00', timezone: 'cet' }
    // 2026-01-19 is a Monday; last ran 14 days earlier.
    expect(scheduleIsDue(s, d('2026-01-05T02:05:00Z'), d('2026-01-19T02:10:00Z'))).toBe(true)
    // Tuesday the 20th: interval fine, wrong weekday.
    expect(scheduleIsDue(s, d('2026-01-05T02:05:00Z'), d('2026-01-20T02:10:00Z'))).toBe(false)
    // Monday the 12th: right weekday, only 7 of 14 days elapsed.
    expect(scheduleIsDue(s, d('2026-01-05T02:05:00Z'), d('2026-01-12T02:10:00Z'))).toBe(false)
  })

  it('PST maps to Los Angeles: Daily 00:00 PST fires at 08:00Z in winter', () => {
    const s = daily('00:00', 'pst')
    // 09:00Z = 01:00 PST, past midnight; last ran yesterday PST.
    expect(scheduleIsDue(s, d('2026-01-14T09:00:00Z'), d('2026-01-15T09:00:00Z'))).toBe(true)
    // 07:00Z = 23:00 PST on the 14th — its fire time already ran that PST-day.
    expect(scheduleIsDue(s, d('2026-01-14T09:00:00Z'), d('2026-01-15T07:00:00Z'))).toBe(false)
  })
})

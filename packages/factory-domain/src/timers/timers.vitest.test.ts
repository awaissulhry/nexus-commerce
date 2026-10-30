import { describe, expect, it } from 'vitest'
import { CANCEL_REASONS, dueAtOf, fireAtOf, parseTimerKey, plusCalendarDays, TIMER_KEY, timerKeyOf, timerPlan, type PendingTimer, type WantedTimer } from './rules'

const day = (date: string) => dueAtOf(date)
const wanted = (recordId: string, date: string, daysBefore = 30, key = `CERTIFICATE_EXPIRY:-${daysBefore}d`): WantedTimer => ({
  recordType: 'Certificate',
  recordId,
  timerKey: key,
  dueAt: day(date),
  fireAt: day(plusCalendarDays(date, -daysBefore)),
})
const pending = (id: string, timer: WantedTimer): PendingTimer => ({ id, ...timer })

describe('timer keys and times', () => {
  it('name a kind and an offset, as the database checks them', () => {
    expect(timerKeyOf('CERTIFICATE_EXPIRY', { amount: -30, unit: 'd' })).toBe('CERTIFICATE_EXPIRY:-30d')
    expect(timerKeyOf('PO_CONFIRM_BY', { amount: 2, unit: 'h' })).toBe('PO_CONFIRM_BY:+2h')
    expect(timerKeyOf('INVOICE_DEADLINE')).toBe('INVOICE_DEADLINE')
    expect(timerKeyOf('INVOICE_DEADLINE', { amount: 0, unit: 'd' })).toBe('INVOICE_DEADLINE')
    expect(() => timerKeyOf('certificate')).toThrow(/not a timer key/)
    expect(parseTimerKey('CERTIFICATE_EXPIRY:-30d')).toEqual({ kind: 'CERTIFICATE_EXPIRY', offset: { amount: -30, unit: 'd' } })
    expect(parseTimerKey('X:15m')).toEqual({ kind: 'X', offset: { amount: 15, unit: 'm' } })
    expect(parseTimerKey('X:-0d')).toEqual({ kind: 'X', offset: null })
    expect(parseTimerKey('x:1d')).toBeNull()
    for (const key of ['A', 'A_B:+1m', 'A9:-12h', 'B:3d']) expect(TIMER_KEY.test(key), key).toBe(true)
  })

  it('fire relative to the due instant; a business date is due at its start in Rome', () => {
    expect(dueAtOf('2026-11-15').toISOString()).toBe('2026-11-14T23:00:00.000Z')
    expect(dueAtOf('2026-07-15').toISOString()).toBe('2026-07-14T22:00:00.000Z')
    expect(fireAtOf(new Date('2026-11-15T00:00:00.000Z'), { amount: -90, unit: 'm' }).toISOString()).toBe('2026-11-14T22:30:00.000Z')
    expect(fireAtOf(new Date('2026-11-15T00:00:00.000Z'), null).toISOString()).toBe('2026-11-15T00:00:00.000Z')
    expect(plusCalendarDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(plusCalendarDays('2026-12-31', 1)).toBe('2027-01-01')
  })
})

describe('keeping the timers in step with the dates (timerPlan)', () => {
  it('keeps the same date, moves a changed one (cancel + set), cancels what is no longer needed, sets the new', () => {
    const plan = timerPlan(
      [wanted('a', '2026-12-01'), wanted('b', '2027-01-10'), wanted('c', '2026-12-20')],
      [pending('t-a', wanted('a', '2026-12-01')), pending('t-b', wanted('b', '2026-12-10')), pending('t-d', wanted('d', '2026-12-05'))],
    )
    expect(plan.kept).toBe(1)
    expect(plan.set.map((timer) => [timer.recordId, timer.dueAt.toISOString()])).toEqual([
      ['b', day('2027-01-10').toISOString()],
      ['c', day('2026-12-20').toISOString()],
    ])
    expect(plan.cancel).toEqual([
      { id: 't-b', reason: 'MOVED' },
      { id: 't-d', reason: 'GONE' },
    ])
    expect(CANCEL_REASONS.MOVED).toMatch(/moved/)
  })

  it('never sets again a timer that fired for the same date; a moved date after firing gets a new one', () => {
    const fired = [wanted('a', '2026-12-01')]
    expect(timerPlan([wanted('a', '2026-12-01')], [], 'GONE', fired)).toEqual({ set: [], cancel: [], kept: 1 })
    expect(timerPlan([wanted('a', '2027-12-01')], [], 'GONE', fired).set).toHaveLength(1)
    // Another key (the rule's numbers changed) is another timer; the old one goes with the reason given.
    const changed = timerPlan([wanted('a', '2026-12-01', 20)], [pending('t-a', wanted('a', '2026-12-01'))], 'RULE_CHANGED')
    expect(changed.set.map((timer) => timer.timerKey)).toEqual(['CERTIFICATE_EXPIRY:-20d'])
    expect(changed.cancel).toEqual([{ id: 't-a', reason: 'RULE_CHANGED' }])
  })

  it('a record listed twice is one timer', () => {
    expect(timerPlan([wanted('a', '2026-12-01'), wanted('a', '2026-12-01')], []).set).toHaveLength(1)
  })
})

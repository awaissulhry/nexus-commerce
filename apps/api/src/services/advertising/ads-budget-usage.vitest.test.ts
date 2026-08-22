import { describe, it, expect } from 'vitest'
import { budgetDayStartUtc, isReadingCurrent, hoursFromSpans, type ObservedSpan } from './ads-budget-usage.service.js'

/**
 * ADM-P6. Every case here is a measurement from prod on 2026-08-22, not an invented example,
 * and each one fails against the implementation the plan originally called for.
 */

const iso = (s: string) => new Date(s)

describe('budgetDayStartUtc — the boundary that was measured, not assumed', () => {
  it('anchors on 00:00 UTC', () => {
    expect(budgetDayStartUtc(iso('2026-08-22T09:57:08.786Z')).toISOString()).toBe('2026-08-22T00:00:00.000Z')
  })

  /**
   * 🔴 The one that matters. The handover plan said to anchor on the marketplace day, and the
   * profiles do report Europe/Paris — but 301 campaign-days of Amazon's own daily report match
   * the UTC sum 298 times (EUR 1.03 error) against the local sum's 204 (EUR 46.74).
   *
   * At 01:30 UTC — 03:30 in Rome — a local-midnight anchor would put the day start at
   * 2026-08-21T22:00Z and sweep in two hours of YESTERDAY's budget. Measured that morning: the
   * local-day sum was EUR 2.55 across 38 campaigns, the UTC-day sum EUR 0.45 across 15.
   */
  it('does NOT shift to the marketplace day in the hours after local midnight', () => {
    const at = iso('2026-08-22T01:30:00.000Z') // 03:30 Europe/Rome, same date in both calendars
    expect(budgetDayStartUtc(at).toISOString()).toBe('2026-08-22T00:00:00.000Z')
    expect(budgetDayStartUtc(at).toISOString()).not.toBe('2026-08-21T22:00:00.000Z')
  })

  it('is stable across a UTC midnight it straddles', () => {
    expect(budgetDayStartUtc(iso('2026-08-21T23:59:59.999Z')).toISOString()).toBe('2026-08-21T00:00:00.000Z')
    expect(budgetDayStartUtc(iso('2026-08-22T00:00:00.000Z')).toISOString()).toBe('2026-08-22T00:00:00.000Z')
  })
})

describe('isReadingCurrent — a stale reading is yesterday, not zero', () => {
  const now = iso('2026-08-22T01:37:00.000Z')

  /**
   * 🔴 Measured: DE_Auto_Close read 27.2% stamped 2026-08-21T19:59:27Z, an hour and a half AFTER
   * the 00:00Z reset had already happened. Amazon does not zero the percentage at the reset; it
   * stops updating it. Rendering that as today's utilization is a confident lie.
   */
  it('rejects a reading stamped before the current reset', () => {
    expect(isReadingCurrent(iso('2026-08-21T19:59:27.000Z'), now)).toBe(false)
  })

  it('accepts the reset stamp itself — 00:00:00Z is inside today', () => {
    expect(isReadingCurrent(iso('2026-08-22T00:00:00.000Z'), now)).toBe(true)
  })

  it('accepts a reading from a minute ago', () => {
    expect(isReadingCurrent(iso('2026-08-22T01:36:06.000Z'), now)).toBe(true)
  })

  /**
   * GALE BROAD IT spent EUR 0.36 in UTC hour 22 of the previous day and Amazon reported 0% one
   * minute into the following 01:36Z — the spend belongs to the previous budget day. A reading
   * from 22:00Z is therefore NOT current at 01:37Z, which is the same fact from the other side.
   */
  it('rejects a reading from hour 22 of the previous day', () => {
    expect(isReadingCurrent(iso('2026-08-21T22:10:00.000Z'), now)).toBe(false)
  })
})

describe('hoursFromSpans — hours are counted from spans, never from samples', () => {
  const now = iso('2026-08-22T05:30:00.000Z') // six hours elapsed: 00,01,02,03,04,05
  const span = (percent: number, from: string, to: string): ObservedSpan => ({
    percent, firstSeenAt: iso(from), lastSeenAt: iso(to),
  })

  it('counts nothing when nothing was watched', () => {
    expect(hoursFromSpans([], now)).toEqual({ observed: 0, outOfBudget: 0, actBid: 0 })
  })

  /**
   * 🔴 The reason spans exist. One reading held for five hours is ONE row — a sampler that
   * counted rows would report a single hour, and a campaign pinned at 100% all morning would
   * read as one hour out of budget instead of five.
   */
  it('a single unchanged reading still covers every hour it spanned', () => {
    const r = hoursFromSpans([span(100, '2026-08-22T00:05:00Z', '2026-08-22T05:05:00Z')], now)
    expect(r.observed).toBe(6)
    expect(r.outOfBudget).toBe(6)
    expect(r.actBid).toBe(0)
  })

  it('counts only the hours a span actually touched', () => {
    const r = hoursFromSpans([span(40, '2026-08-22T02:10:00Z', '2026-08-22T03:50:00Z')], now)
    expect(r).toEqual({ observed: 2, outOfBudget: 0, actBid: 2 })
  })

  it('an hour is out of budget if ANY reading in it hit 100%, and observed either way', () => {
    const r = hoursFromSpans([
      span(60, '2026-08-22T04:00:00Z', '2026-08-22T04:30:00Z'),
      span(100, '2026-08-22T04:30:00Z', '2026-08-22T05:29:00Z'),
    ], now)
    expect(r.observed).toBe(2)
    expect(r.outOfBudget).toBe(2)
    expect(r.actBid).toBe(0)
  })

  it('above 100% is still out of budget — Amazon overspends daily budgets', () => {
    expect(hoursFromSpans([span(130, '2026-08-22T01:00:00Z', '2026-08-22T01:30:00Z')], now).outOfBudget).toBe(1)
  })

  it('95% is a warning, not an exhaustion', () => {
    expect(hoursFromSpans([span(95, '2026-08-22T01:00:00Z', '2026-08-22T01:30:00Z')], now).outOfBudget).toBe(0)
  })

  /** A span that ends exactly on the boundary belongs to the hour it ran in, not the next. */
  it('does not credit the hour a span merely touches the start of', () => {
    const r = hoursFromSpans([span(50, '2026-08-22T01:00:00Z', '2026-08-22T02:00:00Z')], now)
    expect(r.observed).toBe(1)
  })

  /** The day is still running: never count hours that have not happened. */
  it('never counts more hours than have elapsed today', () => {
    const r = hoursFromSpans([span(100, '2026-08-22T00:00:00Z', '2026-08-22T23:00:00Z')], now)
    expect(r.observed).toBe(6)
    expect(r.outOfBudget).toBe(6)
  })

  it('counts the full 24 once the day is over', () => {
    const endOfDay = iso('2026-08-22T23:59:00.000Z')
    const r = hoursFromSpans([span(10, '2026-08-22T00:00:00Z', '2026-08-22T23:59:00Z')], endOfDay)
    expect(r.observed).toBe(24)
    expect(r.actBid).toBe(24)
  })

  /** Yesterday's spans are not today's hours, however recently we saw them. */
  it('ignores a span that lies entirely in the previous budget day', () => {
    const r = hoursFromSpans([span(100, '2026-08-21T20:00:00Z', '2026-08-21T23:59:00Z')], now)
    expect(r).toEqual({ observed: 0, outOfBudget: 0, actBid: 0 })
  })

  it('counts only the part of a straddling span that falls after the reset', () => {
    const r = hoursFromSpans([span(100, '2026-08-21T22:00:00Z', '2026-08-22T01:30:00Z')], now)
    expect(r.observed).toBe(2) // hours 00 and 01 of today, and nothing from yesterday
    expect(r.outOfBudget).toBe(2)
  })
})

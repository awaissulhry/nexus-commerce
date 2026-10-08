/**
 * ONE BRAIN AB-7 — the pace of an envelope and its brakes (budget-pace.ts): the money clock (budget day 00:00–24:00 UTC,
 * the ladder on the market's clock — Europe/Rome for IT, summer and winter, across the month's end), the expected spend by
 * day and hour, the month-end projection (stream and run rate), the brakes at 95 / 100 / 105 %, the allowance. GALE IT
 * figures after the design, rounded (30 days of about €385 spend → €12.84 a day); values made up (public repo).
 */
import { describe, expect, it } from 'vitest'
import { atLeast, averageDaily, brakeOf, dayShareGone, dayWeights, hourCurve, MONEY_BRAKES, moneyClock, paceOf, type PaceFacts } from './budget-pace.js'

const ROME = 'Europe/Rome'
const facts = (now: Date, over: Partial<PaceFacts> = {}): PaceFacts => ({
  envelopeCents: 40_000, aimPct: 90, clock: moneyClock(now, ROME), dayWeights: null, hourWeights: null,
  spentCents: 0, reportedThroughDay: 0, stream: null, runRateCents: null, ...over,
})

describe('the money clock — the budget day in UTC, the ladder on the market\'s clock', () => {
  it('summer (CEST, +2): 10:45 in Rome is day 8 of 31 at 08:45 UTC; past local midnight the budget day is still the old one', () => {
    expect(moneyClock(new Date('2026-10-08T08:45:00Z'), ROME)).toMatchObject({ day: '2026-10-08', month: '2026-10', dayOfMonth: 8, daysInMonth: 31, daysAfterToday: 23, hour: 8, hourFraction: 0.75, localDay: '2026-10-08', localHour: 10.75, ladderHour: 10.75 })
    // 00:30 in Rome on the 9th is 22:30 UTC on the 8th: the budget day (and its money) is still the 8th.
    expect(moneyClock(new Date('2026-10-08T22:30:00Z'), ROME)).toMatchObject({ day: '2026-10-08', localDay: '2026-10-09', localHour: 0.5, ladderHour: 24.5 })
  })

  it('the month\'s end in winter (CET, +1, after the 25 October change): 00:30 Rome on 1 November is still October\'s last budget day', () => {
    expect(moneyClock(new Date('2026-10-31T23:30:00Z'), ROME)).toMatchObject({ day: '2026-10-31', month: '2026-10', dayOfMonth: 31, daysAfterToday: 0, localDay: '2026-11-01', localHour: 0.5, ladderHour: 24.5 })
    expect(moneyClock(new Date('2026-11-01T00:30:00Z'), ROME)).toMatchObject({ day: '2026-11-01', month: '2026-11', dayOfMonth: 1, daysInMonth: 30, daysAfterToday: 29, localDay: '2026-11-01', localHour: 1.5, ladderHour: 1.5 })
  })

  it('no time zone (or an unknown one): the UTC clock', () => {
    expect(moneyClock(new Date('2026-10-08T08:45:00Z'), null)).toMatchObject({ localHour: 8.75, ladderHour: 8.75, timeZone: null })
    expect(moneyClock(new Date('2026-10-08T08:45:00Z'), 'Mars/Olympus')).toMatchObject({ localHour: 8.75 })
  })
})

describe('the curves', () => {
  it('day weights: the Budget Manager calendar, else even; an unusable calendar is even', () => {
    expect(dayWeights(3, [{ day: 1, pct: 50 }, { day: 3, pct: 50 }])).toEqual({ weights: [50, 0, 50], from: 'calendar' })
    expect(dayWeights(3, [])).toEqual({ weights: [1, 1, 1], from: 'even' })
    expect(dayWeights(3, [{ day: 9, pct: 50 }, { day: 1, pct: -5 }])).toEqual({ weights: [1, 1, 1], from: 'even' })
  })
  it('the share of a day gone: by the hour curve (UTC hours), else even', () => {
    expect(dayShareGone(null, 12, 0)).toBe(0.5)
    expect(dayShareGone(null, 8, 0.75)).toBeCloseTo(8.75 / 24, 10)
    const evening = Array.from({ length: 24 }, (_, h) => (h >= 16 ? 1 : 0))
    expect(dayShareGone(evening, 12, 0)).toBe(0)
    expect(dayShareGone(evening, 20, 0)).toBe(0.5)
  })
  it('the hour curve: the product\'s own with €20 over 4 weeks, else the market\'s, else an even day', () => {
    const thin = Array.from({ length: 24 }, () => 10)
    const rich = Array.from({ length: 24 }, () => 100)
    expect(hourCurve(rich, thin).from).toBe('product')
    expect(hourCurve(thin, rich).from).toBe('market')
    expect(hourCurve(thin, thin)).toEqual({ weights: null, from: 'even' })
  })
  it('the run rate: the average of the last 7 days the report covers, a day with no row counting 0', () => {
    const days = new Map([['2026-10-07', 1_400], ['2026-10-06', 1_200], ['2026-10-04', 1_400]])
    expect(averageDaily(days, '2026-10-07')).toBe(571)
    expect(averageDaily(days, '2026-10-07', 7, '2026-10-06')).toBe(1_300)
    expect(averageDaily(days, null)).toBeNull()
  })
})

describe('the brakes — on projected month-end spend, % of the envelope', () => {
  it('> 95 % no raises · > 100 % bids −10 % a day · > 105 % stop the weakest; the thresholds themselves stay below', () => {
    const at = (pct: number) => brakeOf(Math.round(40_000 * pct) / 100, 40_000).level
    expect([at(95), at(95.01), at(100), at(100.01), at(105), at(105.01), at(115)]).toEqual(['none', 'hold_raises', 'hold_raises', 'cut_bids', 'cut_bids', 'stop_weakest', 'stop_weakest'])
    expect(MONEY_BRAKES.map((b) => [b.level, b.abovePct])).toEqual([['hold_raises', 95], ['cut_bids', 100], ['stop_weakest', 105]])
    expect(brakeOf(38_004, 40_000).why).toBe('projected 95.01 % of the envelope (above 95 %): no raises: bids, budgets and hours hold')
  })
  it('no envelope: no brake; an envelope of 0 with spend ahead: the strongest brake', () => {
    expect(brakeOf(10_000, null)).toMatchObject({ level: 'none', why: 'no envelope: nothing to pace, so no brake' })
    expect(brakeOf(1, 0).level).toBe('stop_weakest')
    expect(brakeOf(0, 0).level).toBe('none')
  })
  it('atLeast orders the brakes', () => {
    expect(atLeast('cut_bids', 'hold_raises')).toBe(true)
    expect(atLeast('none', 'hold_raises')).toBe(false)
  })
})

describe('AB-7 — the pace of GALE IT\'s envelope', () => {
  // €400 envelope (the Owner's monthly budget); 1–7 October reported at €12.84 a day; the stream has €4.68 today by 08:45 UTC.
  const NOW = new Date('2026-10-08T08:45:00Z')
  const gale = facts(NOW, { spentCents: 8_988, reportedThroughDay: 7, stream: { gapCents: 0, todayCents: 468 }, runRateCents: 1_284 })

  it('projected €398.04 = 99.51 % of €400 → no raises; the aim (90 %) leaves €11.23 a day', () => {
    const p = paceOf(gale)
    expect(p).toMatchObject({ aimCents: 36_000, spentNowCents: 9_456, projectedCents: 39_804, pacePct: 99.51, projection: 'stream and run rate', allowanceCents: 1_123, daysAhead: 23.64 })
    expect(p.brake).toMatchObject({ level: 'hold_raises', abovePct: 95 })
    // The curve: 90 % of €400 evenly → €11.61 a day; through the 7th €81.29; now (8.75 h into the 8th) €85.52.
    expect(p.curve!.byDayCents[6]).toBe(8_129)
    expect(p.curve!.byDayCents[30]).toBe(36_000)
    expect(p.expectedThroughReportedCents).toBe(8_129)
    expect(p.expectedNowCents).toBe(8_552)
    expect(p.vsCurvePct).toBe(110.57)
    expect(p.curve!.todayByHourCents[23]).toBe(p.curve!.byDayCents[7])
  })

  it('without the stream the run rate stands in for today so far (said)', () => {
    const p = paceOf({ ...gale, stream: null })
    expect(p.projection).toBe('run rate')
    expect(p.spentNowCents).toBe(9_456)
    expect(p.projectedCents).toBe(39_804)
    expect(p.why).toContain('no Marketing Stream hours')
  })

  it('the days the report does not cover yet: from the stream, else at the run rate', () => {
    // Reported through the 5th only: the 6th and 7th come from the stream (€30) or the run rate (2 × €12.84).
    expect(paceOf({ ...gale, spentCents: 6_420, reportedThroughDay: 5, stream: { gapCents: 3_000, todayCents: 468 } }).spentNowCents).toBe(9_888)
    expect(paceOf({ ...gale, spentCents: 6_420, reportedThroughDay: 5, stream: null }).spentNowCents).toBe(9_456)
  })

  it('a bigger envelope (€500): projected 79.6 %, no brake; the Owner\'s pacing limit of 80 % moves the aim', () => {
    expect(paceOf({ ...gale, envelopeCents: 50_000 })).toMatchObject({ pacePct: 79.61, aimCents: 45_000, brake: { level: 'none' } })
    expect(paceOf({ ...gale, envelopeCents: 50_000, aimPct: 80 })).toMatchObject({ aimCents: 40_000, allowanceCents: 1_292 })
  })

  it('a Budget Manager calendar shapes the curve (a tentpole day takes more)', () => {
    const w = Array.from({ length: 31 }, (_, i) => (i === 9 ? 10 : 3))
    const p = paceOf({ ...gale, dayWeights: w })
    expect(p.curve!.byDayCents[9] - p.curve!.byDayCents[8]).toBeGreaterThan(3 * (p.curve!.byDayCents[8] - p.curve!.byDayCents[7]))
  })

  it('month boundaries: the last half hour of October counts its own day only; 1 November starts a new month at zero', () => {
    const last = paceOf(facts(new Date('2026-10-31T23:30:00Z'), { spentCents: 38_520, reportedThroughDay: 30, stream: { gapCents: 0, todayCents: 1_250 }, runRateCents: 1_284 }))
    expect(last.daysAhead).toBe(0.02)
    expect(last.projectedCents).toBe(39_797)
    const first = paceOf(facts(new Date('2026-11-01T00:30:00Z'), { spentCents: 0, reportedThroughDay: 0, stream: { gapCents: 0, todayCents: 30 }, runRateCents: 1_284 }))
    expect(first).toMatchObject({ spentNowCents: 30, expectedThroughReportedCents: 0 })
    expect(first.curve!.byDayCents).toHaveLength(30)
    expect(first.projectedCents).toBe(Math.round(30 + 1_284 * (1 - 0.5 / 24 + 29)))
  })

  it('zero spend: projected 0 %, no brake; no envelope: nothing to pace', () => {
    expect(paceOf(facts(NOW, { runRateCents: 0, reportedThroughDay: 7 }))).toMatchObject({ projectedCents: 0, pacePct: 0, brake: { level: 'none' } })
    const none = paceOf(facts(NOW, { envelopeCents: null, spentCents: 8_988, reportedThroughDay: 7, runRateCents: 1_284 }))
    expect(none).toMatchObject({ aimCents: null, curve: null, pacePct: null, allowanceCents: null, brake: { level: 'none' } })
    expect(none.why).toMatch(/^no envelope: projected/)
    expect(paceOf(facts(NOW, { runRateCents: null })).projection).toBe('month to date only')
  })
})

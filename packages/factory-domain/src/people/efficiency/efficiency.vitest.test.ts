import { describe, expect, it } from 'vitest'
import { maskSmallGroups } from '../privacy/groups'
import { purposeUseProblems } from '../privacy/purposes'
import {
  ATTENDED_MINUTES_TAGS,
  attendedShares,
  cycleFiguresOf,
  decisionProblems,
  isTraineeDay,
  lineGroupsOf,
  offSinceOf,
  operationDaysOf,
  operationFiguresOf,
  percentOf,
  personDaysOf,
  reviewPlaceOf,
  reviewRuleOf,
  reviewRuleProblems,
  reviewRuleWords,
  STANDARD_REVIEW,
  timedReportOf,
  totalsOf,
  type LineFact,
  type OperationSample,
} from './rules'
import { Dec } from '../../tax/decimal'
import type { TimingRow } from '../../production/terminal/rules'

/** Efficiency's rules (B-W2b-44). The law the tests name: Statuto dei Lavoratori art. 4; c.c. art. 2101; GDPR art. 5(1)(b). */

const earned = (lineId: string | null, day: string, subjects: string[], minutes: string): LineFact => ({ kind: 'EARNED', lineId, day, subjects, earnedMinutes: minutes })
const attended = (lineId: string | null, day: string, employeeId: string, minutes: number, plannedMinutes = minutes): LineFact => ({ kind: 'ATTENDED', lineId, day, employeeId, minutes, plannedMinutes })
const offStandard = (lineId: string | null, day: string, minutes: number): LineFact => ({ kind: 'OFF_STANDARD', lineId, day, minutes })
const byLine = (fact: LineFact) => fact.lineId ?? ''

const sample = (over: Partial<OperationSample> = {}): OperationSample => ({ at: new Date('2026-06-02T10:00:00.000Z'), day: '2026-06-02', pieces: 10, seconds: 600, personSeconds: 600, pausedSeconds: 0, elapsedSeconds: 600, subjects: ['worker:a'], ...over })

const row = (id: string, kind: string, at: string, over: Partial<TimingRow> = {}): TimingRow => ({ id, kind, correctsId: null, goodQuantity: 0, scrapQuantity: 0, reworkQuantity: 0, pauseReasonCode: null, workerId: 'a', stationId: null, deviceId: 'd', deviceTime: null, serverTime: new Date(at), ...over })

describe('line figures: two denominators, per line', () => {
  const facts = [earned('L1', '2026-06-01', ['w:1', 'w:2', 'w:3'], '300.000'), attended('L1', '2026-06-01', 'e1', 200), attended('L1', '2026-06-01', 'e2', 200), attended('L1', '2026-06-01', 'e3', 200, 300), offStandard('L1', '2026-06-01', 100)]

  it('earned against attended, against the minutes on standard work and against the planned minutes', () => {
    const [group] = lineGroupsOf(facts, true, byLine)
    expect(group?.figures).toEqual({
      earnedMinutes: '300.000',
      attendedMinutes: '600.000',
      plannedMinutes: '700.000',
      offStandardMinutes: '100.000',
      onStandardMinutes: '500.000',
      efficiency: '50.0',
      onStandardEfficiency: '60.0',
      plannedEfficiency: '42.9',
    })
    expect(group?.people).toBe(3)
  })

  it('with the attendance purpose off no attended, planned or derived figure exists', () => {
    const [group] = lineGroupsOf(facts, false, byLine)
    expect(group?.figures).toMatchObject({ earnedMinutes: '300.000', attendedMinutes: null, plannedMinutes: null, onStandardMinutes: null, efficiency: null, onStandardEfficiency: null, plannedEfficiency: null })
  })

  it('Statuto art. 4: a line of many where ONE person reported shows one person\'s output, so its headcount is one', () => {
    const [group] = lineGroupsOf([earned('L1', '2026-06-01', ['w:1'], '300.000'), attended('L1', '2026-06-01', 'e1', 480), attended('L1', '2026-06-01', 'e2', 480), attended('L1', '2026-06-01', 'e3', 480), attended('L1', '2026-06-01', 'e4', 480)], true, byLine)
    expect(group?.people).toBe(1)
    expect(maskSmallGroups([group!], 3).rows[0]).toMatchObject({ tooFew: true, row: { people: null, figures: { efficiency: null, earnedMinutes: null } } })
  })

  it('Statuto art. 4: a total adds up only the lines shown, so a hidden line cannot be worked out by subtraction', () => {
    const groups = lineGroupsOf([...facts, earned('L2', '2026-06-01', ['w:9'], '999.000'), attended('L2', '2026-06-01', 'e9', 480)], true, byLine)
    const masked = maskSmallGroups(groups, 3)
    expect(masked.hidden).toBe(1)
    const shown = masked.rows.filter((entry) => !entry.tooFew).map((entry) => entry.row.figures)
    expect(totalsOf(shown, true)).toMatchObject({ earnedMinutes: '300.000', attendedMinutes: '600.000', efficiency: '50.0' })
    expect(totalsOf([], true)).toBeNull()
  })

  it('never divides by nothing', () => {
    expect(percentOf(new Dec(5), new Dec(0))).toBeNull()
    expect(percentOf(new Dec(5), null)).toBeNull()
    expect(lineGroupsOf([earned('L1', '2026-06-01', ['w:1'], '1.000'), attended('L1', '2026-06-01', 'e1', 60), offStandard('L1', '2026-06-01', 90)], true, byLine)[0]?.figures).toMatchObject({ onStandardMinutes: '0.000', onStandardEfficiency: null })
  })
})

describe('attended minutes split over lines', () => {
  const day = { presentMinutes: 480, plannedMinutes: 480, firstInAt: new Date('2026-06-01T06:00:00.000Z'), lastOutAt: new Date('2026-06-01T14:30:00.000Z'), homeLineId: 'L1', loans: [] }

  it('stays on the home line; a person with no line stays on no line', () => {
    expect(attendedShares(day)).toEqual([{ lineId: 'L1', minutes: 480, plannedMinutes: 480 }])
    expect(attendedShares({ ...day, homeLineId: null })).toEqual([{ lineId: null, minutes: 480, plannedMinutes: 480 }])
  })

  it('a day made by a MANUAL event (no tablet, no worker) counts: it is read by the person, and it may have no clock-in time', () => {
    expect(attendedShares({ ...day, firstInAt: null, lastOutAt: null })).toEqual([{ lineId: 'L1', minutes: 480, plannedMinutes: 480 }])
  })

  it('the minutes of a loan go to the line lent to, the rest stays home, the planned minutes with the biggest share', () => {
    const shares = attendedShares({ ...day, loans: [{ toLineId: 'L2', startsAt: new Date('2026-06-01T08:00:00.000Z'), endsAt: new Date('2026-06-01T10:00:00.000Z') }] })
    expect(shares).toEqual(expect.arrayContaining([{ lineId: 'L2', minutes: 120, plannedMinutes: 0 }, { lineId: 'L1', minutes: 360, plannedMinutes: 480 }]))
  })

  it('a whole-day loan leaves nothing at home', () => {
    expect(attendedShares({ ...day, loans: [{ toLineId: 'L2', startsAt: new Date('2026-06-01T00:00:00.000Z'), endsAt: new Date('2026-06-02T00:00:00.000Z') }] })).toEqual([{ lineId: 'L2', minutes: 480, plannedMinutes: 480 }])
  })

  it('a planned day with nobody present still carries its planned minutes', () => {
    expect(attendedShares({ ...day, presentMinutes: 0, firstInAt: null, lastOutAt: null })).toEqual([{ lineId: 'L1', minutes: 0, plannedMinutes: 480 }])
  })
})

describe('planned against actual per operation', () => {
  it('person-minutes per piece against the standard, either way', () => {
    const over = operationFiguresOf(Array.from({ length: 5 }, () => sample({ personSeconds: 780 })), '1.000')
    expect(over.figures).toMatchObject({ bundles: 5, pieces: 50, actualMinutes: '1.300', differencePercent: '30.0', state: 'REVIEW' })
    expect(operationFiguresOf(Array.from({ length: 5 }, () => sample({ personSeconds: 420 })), '1.000').figures).toMatchObject({ actualMinutes: '0.700', differencePercent: '-30.0', state: 'REVIEW' })
    expect(operationFiguresOf(Array.from({ length: 5 }, () => sample({ personSeconds: 630 })), '1.000').figures.state).toBe('WITHIN')
  })

  it('enough bundles: below the minimum it is not judged', () => {
    expect(operationFiguresOf(Array.from({ length: STANDARD_REVIEW.minBundles - 1 }, () => sample({ personSeconds: 780 })), '1.000').figures.state).toBe('TOO_FEW_BUNDLES')
  })

  it('exactly at the tolerance is within it', () => {
    expect(operationFiguresOf(Array.from({ length: 5 }, () => sample({ personSeconds: 660 })), '1.000').figures.state).toBe('WITHIN')
  })

  it('Statuto art. 4: the headcount counts the people behind the row, so one person on an operation is a group of one', () => {
    expect(operationFiguresOf(Array.from({ length: 9 }, () => sample()), '1.000').people).toBe(1)
    expect(operationDaysOf([sample({ subjects: ['worker:a'] }), sample({ subjects: ['worker:b'], day: '2026-06-03' })], '1.000').map((day) => day.people)).toEqual([1, 1])
  })

  it('a standard of zero is never divided by', () => {
    expect(operationFiguresOf([sample()], '0.000').figures.differencePercent).toBeNull()
  })

  it('the run of days off the standard, in one direction, up to the last day', () => {
    const days = [{ date: '2026-06-01', differencePercent: '30.0' }, { date: '2026-06-02', differencePercent: '2.0' }, { date: '2026-06-03', differencePercent: '20.0' }, { date: '2026-06-04', differencePercent: '30.0' }]
    expect(offSinceOf(days)).toBe('2026-06-03')
    expect(offSinceOf([...days, { date: '2026-06-05', differencePercent: '-30.0' }])).toBe('2026-06-05')
    expect(offSinceOf([...days, { date: '2026-06-05', differencePercent: '1.0' }])).toBeNull()
  })
})

describe('the timing behind a report', () => {
  const members = new Map<string, string[]>()

  it('a one-tap report closed no stretch: no timing (Owner answer F3)', () => {
    expect(timedReportOf([row('r', 'REPORT', '2026-06-01T08:00:00.000Z')], members, 'r')).toBeNull()
  })

  it('pauses are left out of the running time, and shown apart', () => {
    const timed = timedReportOf([row('s', 'START', '2026-06-01T08:00:00.000Z'), row('p', 'PAUSE', '2026-06-01T08:10:00.000Z', { pauseReasonCode: 'BREAK' }), row('u', 'RESUME', '2026-06-01T08:30:00.000Z'), row('r', 'REPORT', '2026-06-01T08:40:00.000Z')], members, 'r')
    expect(timed).toMatchObject({ seconds: 1200, personSeconds: 1200, pausedSeconds: 1200, elapsedSeconds: 2400, subjects: ['worker:a'] })
  })

  it('a team counts once per member in the labour, once in the cycle', () => {
    const timed = timedReportOf([row('s', 'START', '2026-06-01T08:00:00.000Z'), row('r', 'REPORT', '2026-06-01T08:10:00.000Z')], new Map([['s', ['a', 'b']]]), 'r')
    expect(timed).toMatchObject({ seconds: 600, personSeconds: 1200, subjects: expect.arrayContaining(['worker:a', 'worker:b']) })
  })

  it('work handed back by another person is kept in the bundle\'s time', () => {
    const timed = timedReportOf([row('s1', 'START', '2026-06-01T08:00:00.000Z', { workerId: 'b' }), row('h', 'HAND_BACK', '2026-06-01T08:05:00.000Z', { workerId: 'b' }), row('s2', 'START', '2026-06-01T09:00:00.000Z'), row('r', 'REPORT', '2026-06-01T09:05:00.000Z')], members, 'r')
    expect(timed).toMatchObject({ seconds: 600 })
    expect([...(timed?.subjects ?? [])].sort()).toEqual(['worker:a', 'worker:b'])
  })

  it('a station site counts stations, naming nobody', () => {
    expect(timedReportOf([row('s', 'START', '2026-06-01T08:00:00.000Z', { workerId: null, stationId: 'st' }), row('r', 'REPORT', '2026-06-01T08:10:00.000Z', { workerId: null, stationId: 'st' })], members, 'r')?.subjects).toEqual(['station:st'])
  })
})

describe('operation cycle time (ANA-016)', () => {
  it('running time per bundle and per piece, a team once, pauses and the elapsed time apart', () => {
    expect(cycleFiguresOf([sample({ seconds: 600, personSeconds: 1200, pausedSeconds: 120, elapsedSeconds: 720 }), sample({ seconds: 1200, personSeconds: 1200 })]).figures).toEqual({ bundles: 2, pieces: 20, cycleMinutesPerBundle: '15.000', cycleMinutesPerPiece: '1.500', pausedMinutesPerBundle: '1.000', elapsedMinutesPerBundle: '11.000' })
  })

  it('no sample, no figure', () => {
    expect(cycleFiguresOf([]).figures).toMatchObject({ bundles: 0, cycleMinutesPerBundle: null, cycleMinutesPerPiece: null })
  })
})

describe('the standard review (MES-251; c.c. art. 2101)', () => {
  const off = Array.from({ length: 5 }, (_, n) => sample({ at: new Date(`2026-06-0${n + 1}T10:00:00.000Z`), day: `2026-06-0${n + 1}`, personSeconds: 780 }))

  it('off beyond the tolerance over enough bundles comes on the queue', () => {
    expect(reviewPlaceOf(off, null, '1.000').reason).toBe('OFF_STANDARD')
  })

  it('a KEEP or a CHANGE counts only the bundles after it: it comes back when enough newer ones are off', () => {
    const keptOn = { decision: 'KEEP' as const, at: new Date('2026-06-03T12:00:00.000Z') }
    expect(reviewPlaceOf(off, keptOn, '1.000')).toMatchObject({ reason: null })
    expect(reviewPlaceOf(off, keptOn, '1.000').samples).toHaveLength(2)
    expect(reviewPlaceOf(off, { decision: 'CHANGE', at: new Date('2026-05-01T12:00:00.000Z') }, '1.000').reason).toBe('OFF_STANDARD')
  })

  it('INVESTIGATE and SEND stay on the queue whatever the figures say, until a person keeps or changes', () => {
    expect(reviewPlaceOf([], { decision: 'INVESTIGATE', at: new Date('2026-06-03T12:00:00.000Z') }, '1.000').reason).toBe('INVESTIGATING')
    expect(reviewPlaceOf([], { decision: 'SEND', at: new Date('2026-06-03T12:00:00.000Z') }, '1.000').reason).toBe('SENT')
  })

  it('a decision says why; a change says what to; SEND needs no reason', () => {
    expect(decisionProblems({ decision: 'KEEP', reason: ' ' }).map((problem) => problem.path)).toEqual(['body/reason'])
    expect(decisionProblems({ decision: 'CHANGE', reason: 'method changed' }).map((problem) => problem.path)).toEqual(['body/proposedMinutes'])
    expect(decisionProblems({ decision: 'CHANGE', reason: 'method changed', proposedMinutes: '0' }).map((problem) => problem.path)).toEqual(['body/proposedMinutes'])
    expect(decisionProblems({ decision: 'KEEP', reason: 'fine', proposedMinutes: '2' }).map((problem) => problem.path)).toEqual(['body/proposedMinutes'])
    expect(decisionProblems({ decision: 'CHANGE', reason: 'method changed', proposedMinutes: '1.300' })).toEqual([])
    expect(decisionProblems({ decision: 'SEND' })).toEqual([])
  })
})

describe('one person\'s figures', () => {
  it('earned against the timed minutes of the same reports: a one-tap report earns and carries no time', () => {
    const days = personDaysOf(
      [
        { day: '2026-06-01', pieces: 10, earnedMinutes: '10.000', timedPersonSeconds: 900 },
        { day: '2026-06-01', pieces: 10, earnedMinutes: '10.000', timedPersonSeconds: null },
      ],
      new Map([['2026-06-02', 30]]),
    )
    expect(days).toEqual([
      { date: '2026-06-01', pieces: 20, earnedMinutes: '20.000', timedEarnedMinutes: '10.000', timedMinutes: '15.000', offStandardMinutes: '0.000', efficiency: '66.7' },
      { date: '2026-06-02', pieces: 0, earnedMinutes: '0.000', timedEarnedMinutes: '0.000', timedMinutes: '0.000', offStandardMinutes: '30.000', efficiency: null },
    ])
  })

  it('Statuto art. 4: a person\'s day holds nothing to compare with: no rank, no average, no target, no colour', () => {
    const [day] = personDaysOf([{ day: '2026-06-01', pieces: 1, earnedMinutes: '1.000', timedPersonSeconds: 60 }], new Map())
    expect(Object.keys(day!).sort()).toEqual(['date', 'earnedMinutes', 'efficiency', 'offStandardMinutes', 'pieces', 'timedEarnedMinutes', 'timedMinutes'])
  })

  it('GDPR art. 5(1)(b): attended minutes are kept for attendance, so one person\'s work figure may not stand on them', () => {
    expect(purposeUseProblems(ATTENDED_MINUTES_TAGS, 'PERFORMANCE')).toHaveLength(1)
  })

  it('a trainee day is any open trainee period, until the sign-off day', () => {
    const levels = [{ since: '2026-06-01', traineeUntil: '2026-06-30', signedOffOn: '2026-06-10' }]
    expect(isTraineeDay(levels, '2026-05-31')).toBe(false)
    expect(isTraineeDay(levels, '2026-06-09')).toBe(true)
    expect(isTraineeDay(levels, '2026-06-10')).toBe(false)
  })
})

describe("the company's standard review rule (B-W2b-89)", () => {
  it('reads the People settings row, else the defaults (the same as the columns)', () => {
    expect(reviewRuleOf(null)).toEqual({ tolerancePercent: 10, minBundles: 5 })
    expect(reviewRuleOf({ standardReviewPercent: 12, standardReviewMinBundles: 8 })).toEqual({ tolerancePercent: 12, minBundles: 8 })
    expect(reviewRuleWords({ tolerancePercent: 12, minBundles: 8 })).toBe(`Operations more than 12% off their standard, in either direction, over at least 8 bundles of the last ${STANDARD_REVIEW.windowDays} days.`)
  })

  it('takes 1 to 100 percent over 1 to 1000 bundles, whole numbers, as the database does', () => {
    expect(reviewRuleProblems({ tolerancePercent: 1, minBundles: 1 })).toEqual([])
    expect(reviewRuleProblems({ tolerancePercent: 100, minBundles: 1000 })).toEqual([])
    expect(reviewRuleProblems({ tolerancePercent: 0, minBundles: 1001 }).map((issue) => issue.path)).toEqual(['body/tolerancePercent', 'body/minBundles'])
    expect(reviewRuleProblems({ tolerancePercent: 10.5, minBundles: 5 }).map((issue) => issue.path)).toEqual(['body/tolerancePercent'])
  })

  it('a stricter rule puts an operation on the queue that the default leaves off', () => {
    // Three bundles 7 % over a standard of one minute a piece.
    const samples = Array.from({ length: 3 }, (_, index) => sample({ personSeconds: 642, at: new Date(Date.UTC(2026, 5, 1, 8, index)) }))
    expect(operationFiguresOf(samples, '1.000').figures).toMatchObject({ differencePercent: '7.0', state: 'TOO_FEW_BUNDLES' })
    expect(operationFiguresOf(samples, '1.000', { tolerancePercent: 5, minBundles: 3 }).figures.state).toBe('REVIEW')
    expect(reviewPlaceOf(samples, null, '1.000', { tolerancePercent: 5, minBundles: 3 }).reason).toBe('OFF_STANDARD')
    expect(reviewPlaceOf(samples, null, '1.000', { tolerancePercent: 10, minBundles: 3 }).reason).toBeNull()
    expect(offSinceOf(operationDaysOf(samples, '1.000'), 5)).toBe('2026-06-02')
    expect(offSinceOf(operationDaysOf(samples, '1.000'))).toBeNull()
  })
})

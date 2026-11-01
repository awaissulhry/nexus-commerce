import { describe, expect, it } from 'vitest'
import { averagePerMinuteOf, bonusOf, defectPayOf, earnedForMakeUp, guaranteedPayOf, makeUpOf, paidTimeOf, periodPayOf, SchemePayError, teamSplitOf, type SchemePay } from './pay'
import {
  activationPlan,
  affectedPeriods,
  deleteRefusal,
  editRefusal,
  endRefusal,
  firstDayProblems,
  periodsInWords,
  rulesInWords,
  schemeFor,
  schemeStateOf,
  termsOf,
  type PeriodRow,
  type SchemeRow,
} from './rules'

/**
 * Incentive schemes (B-W2b-38; MES-253, MES-257, MES-258, MES-259; c.c. arts. 2100-2101 and the CCNL minimum: piece pay is
 * never below the guaranteed pay; waiting that is not the worker's doing never goes unpaid). Made-up figures only: no
 * rate here is any CCNL's.
 */

const scheme = (over: Partial<SchemeRow> = {}): SchemeRow => ({
  id: 's1',
  name: 'Plant scheme',
  companyId: 'c1',
  lineId: null,
  kind: 'PIECE_RATE',
  efficiencyThresholdPct: null,
  guaranteedBasis: 'CCNL_MINIMUM',
  guaranteedHourlyRate: '9',
  traineeHourlyRate: null,
  teamSplit: null,
  reworkOwnFault: 'UNPAID',
  scrapOwnFault: 'UNPAID',
  ownFaultRatePct: null,
  othersFaultPay: 'AVERAGE',
  waitingPay: 'AVERAGE',
  payOnlyWhileClockedIn: true,
  currency: 'EUR',
  validFrom: '2026-12-01',
  validTo: null,
  status: 'DRAFT',
  ...over,
})
const period = (id: string, month: string, status: PeriodRow['status']): PeriodRow => ({ id, periodStart: `${month}-01`, periodEnd: `${month}-${month.endsWith('-02') ? '28' : month.endsWith('-11') ? '30' : '31'}`, status })

describe('scheme settings (MES-253)', () => {
  it('makes the terms whole: a column of another kind cleared, the columns a kind needs asked for at their field', () => {
    const team = termsOf({ name: ' Team L1 ', kind: 'TEAM_INCENTIVE', teamSplit: 'HOURS_PRESENT', efficiencyThresholdPct: '90', ownFaultRatePct: '50', validFrom: '2026-12-01' })
    expect(team.problems).toEqual([])
    expect(team.terms).toMatchObject({ name: 'Team L1', teamSplit: 'HOURS_PRESENT', efficiencyThresholdPct: null, ownFaultRatePct: null, guaranteedBasis: 'UNDECIDED', othersFaultPay: 'AVERAGE', waitingPay: 'AVERAGE', payOnlyWhileClockedIn: true, currency: 'EUR' })
    const bad = termsOf({ name: '', kind: 'STANDARD_MINUTE_BONUS', efficiencyThresholdPct: '250', reworkOwnFault: 'REDUCED_RATE', ownFaultRatePct: '100', guaranteedHourlyRate: '0', traineeHourlyRate: '7.1234567', validFrom: '2026-13-01' })
    expect(bad.terms).toBeNull()
    expect(bad.problems.map((problem) => problem.path)).toEqual(['name', 'efficiencyThresholdPct', 'guaranteedHourlyRate', 'traineeHourlyRate', 'ownFaultRatePct', 'validFrom'])
    expect(termsOf({ name: 'T', kind: 'TEAM_INCENTIVE', validFrom: '2026-12-01' }).problems).toEqual([{ path: 'teamSplit', message: expect.stringContaining('by hours present or by skill weight') }])
  })

  it('never lets a scheme leave waiting or work spoiled by others unpaid (c.c. art. 2100)', () => {
    const unpaid = termsOf({ name: 'T', kind: 'PIECE_RATE', waitingPay: 'UNPAID' as never, othersFaultPay: 'UNPAID' as never, validFrom: '2026-12-01' })
    expect(unpaid.problems.map((problem) => problem.path)).toEqual(['othersFaultPay', 'waitingPay'])
    expect(unpaid.problems[1]!.message).toContain('never unpaid (c.c. art. 2100)')
  })

  it('starts a draft from today on, and says its rules in words without a pay figure', () => {
    expect(firstDayProblems('2026-10-31', '2026-11-01')).toEqual([{ path: 'validFrom', message: expect.stringContaining('never changes pay already worked') }])
    expect(firstDayProblems('2026-11-01', '2026-11-01')).toEqual([])
    const words = rulesInWords(scheme({ kind: 'TEAM_INCENTIVE', teamSplit: 'SKILL_WEIGHT', reworkOwnFault: 'REDUCED_RATE', ownFaultRatePct: '50', traineeHourlyRate: '7.5' }))
    expect(words.join(' ')).toContain('never below it')
    expect(words).toContain("Rework of the worker's own fault is paid at 50% of the rate.")
    expect(words).toContain("A team's pay splits in proportion to each member's skill weight.")
    expect(words.join(' ')).not.toMatch(/€|\b9\b|7\.5/)
  })

  it('shows the state of its days, and finds the scheme that applies: the line\'s own first, else the company\'s', () => {
    expect(schemeStateOf(scheme(), '2026-11-01').state).toBe('DRAFT')
    expect(schemeStateOf(scheme({ status: 'ACTIVE' }), '2026-11-01').state).toBe('TO_COME')
    expect(schemeStateOf(scheme({ status: 'ACTIVE' }), '2026-12-01').state).toBe('IN_FORCE')
    expect(schemeStateOf(scheme({ status: 'RETIRED', validTo: '2026-12-31' }), '2026-12-15')).toEqual({ state: 'ENDING', words: 'In force until 2026-12-31.' })
    expect(schemeStateOf(scheme({ status: 'RETIRED', validTo: '2026-12-31' }), '2027-01-01').state).toBe('ENDED')
    const company = scheme({ id: 'c', status: 'ACTIVE', validFrom: '2026-11-01' })
    const line = scheme({ id: 'l', lineId: 'L1', status: 'ACTIVE', validFrom: '2026-12-01' })
    const draft = scheme({ id: 'd', lineId: 'L2', status: 'DRAFT', validFrom: '2026-11-01' })
    expect(schemeFor([company, line, draft], 'L1', '2026-11-15')?.id).toBe('c')
    expect(schemeFor([company, line, draft], 'L1', '2026-12-01')?.id).toBe('l')
    expect(schemeFor([company, line, draft], 'L2', '2026-12-01')?.id).toBe('c')
    expect(schemeFor([line], null, '2026-12-01')).toBeNull()
  })

  it('starts a draft only with its guaranteed pay, from today, in no locked period, after the scheme before it (which ends the day before)', () => {
    const today = '2026-11-01'
    const before: Pick<SchemeRow, 'id' | 'name' | 'status' | 'validFrom' | 'validTo'> = { id: 'p', name: 'Old', status: 'ACTIVE', validFrom: '2026-11-01', validTo: null }
    expect(activationPlan({ scheme: scheme(), today, others: [before], periods: [period('n', '2026-11', 'OPEN')] })).toEqual({ plan: { retires: [{ id: 'p', name: 'Old', validTo: '2026-11-30' }] }, refusal: null })
    const refusal = (over: Partial<SchemeRow>, others = [before], periods: PeriodRow[] = []) => activationPlan({ scheme: scheme(over), today, others, periods }).refusal?.code
    expect(refusal({ status: 'ACTIVE' })).toBe('NOT_DRAFT')
    expect(refusal({ guaranteedBasis: 'UNDECIDED' })).toBe('NO_GUARANTEE')
    expect(refusal({ guaranteedHourlyRate: null })).toBe('NO_GUARANTEE')
    expect(refusal({ validFrom: '2026-10-31' })).toBe('STARTS_IN_PAST')
    expect(refusal({}, [], [period('d', '2026-12', 'LOCKED')])).toBe('PERIOD_LOCKED')
    expect(refusal({ validFrom: '2026-11-01' })).toBe('STARTS_BEFORE_LATEST')
    expect(refusal({}, [{ ...before, status: 'RETIRED', validTo: '2026-12-15' }])).toBe('OVERLAPS')
    expect(refusal({}, [{ ...before, status: 'RETIRED', validTo: '2026-11-30' }])).toBeUndefined()
    expect(activationPlan({ scheme: scheme({ guaranteedBasis: 'UNDECIDED' }), today, others: [], periods: [] }).refusal?.message).toContain('c.c. art. 2101')
  })

  it('ends a scheme in force once, from today, never under a site whose piece pay runs on it; deletes only a draft no switch names', () => {
    const active = scheme({ status: 'ACTIVE', validFrom: '2026-11-01' })
    expect(endRefusal({ scheme: active, lastDay: '2026-11-30', today: '2026-11-10', onAt: [] })).toBeNull()
    expect(endRefusal({ scheme: scheme(), lastDay: '2026-11-30', today: '2026-11-10', onAt: [] })?.code).toBe('NOT_ACTIVE')
    expect(endRefusal({ scheme: { ...active, validTo: '2026-12-31' }, lastDay: '2026-11-30', today: '2026-11-10', onAt: [] })?.code).toBe('ENDS_SET')
    expect(endRefusal({ scheme: active, lastDay: '2026-11-09', today: '2026-11-10', onAt: [] })?.code).toBe('ENDS_IN_PAST')
    expect(endRefusal({ scheme: { ...active, validFrom: '2026-12-01' }, lastDay: '2026-11-30', today: '2026-11-10', onAt: [] })?.code).toBe('ENDS_BEFORE_START')
    expect(endRefusal({ scheme: active, lastDay: '2026-11-30', today: '2026-11-10', onAt: ['Plant A1'] })).toEqual({ code: 'IN_USE', message: expect.stringContaining('Piece pay is on at Plant A1') })
    expect(deleteRefusal(scheme(), [])).toBeNull()
    expect(deleteRefusal(scheme(), ['Plant A1'])?.code).toBe('NAMED_BY_SWITCH')
    expect(deleteRefusal(active, [])?.code).toBe('NOT_DRAFT')
    expect(editRefusal(active)?.code).toBe('NOT_DRAFT')
  })

  it('shows the pay periods a change touches: open accrues, computed runs again, locked never changes', () => {
    const periods = [period('o', '2026-10', 'LOCKED'), period('n', '2026-11', 'REVIEW'), period('d', '2026-12', 'OPEN'), period('j', '2027-01', 'OPEN')]
    const touched = affectedPeriods(periods, '2026-11-15', '2026-12-31')
    expect(touched.map((row) => [row.month, row.effect])).toEqual([
      ['2026-11', 'RUN_AGAIN'],
      ['2026-12', 'ACCRUES'],
    ])
    expect(periodsInWords('2026-11-15', '2026-12-31', touched)).toBe('Applies from 2026-11-15 to 2026-12-31: accrues in 2026-12; run 2026-11 again.')
    expect(periodsInWords('2027-02-01', null, [])).toBe('Applies from 2027-02-01: no pay period of these days is made yet.')
  })
})

const pay = (over: Partial<SchemePay> = {}): SchemePay => ({ ...scheme(), ...over })

describe('make-up to guaranteed pay (MES-257; c.c. art. 2101 and the CCNL minimum)', () => {
  it('guarantees the minutes present at the hourly rate (a trainee\'s minutes at their own rate)', () => {
    expect(guaranteedPayOf(pay(), { minutesPresent: 9_600 })).toBe(144_000)
    expect(guaranteedPayOf(pay({ traineeHourlyRate: '7.5' }), { minutesPresent: 9_600, traineeMinutes: 4_800 })).toBe(132_000)
    expect(guaranteedPayOf(pay({ guaranteedHourlyRate: '9.123457' }), { minutesPresent: 1 })).toBe(15)
    expect(() => guaranteedPayOf(pay({ guaranteedHourlyRate: null }), { minutesPresent: 60 })).toThrow(SchemePayError)
    expect(() => guaranteedPayOf(pay(), { minutesPresent: 60, traineeMinutes: 61 })).toThrow(SchemePayError)
  })

  it('tops piece pay up to the guaranteed pay, and never takes anything away above it', () => {
    expect(makeUpOf(pay(), { minutesPresent: 9_600, earned: 130_000 })).toEqual({ minutes: 9_600, ratePerMinute: '0.15', guaranteed: 144_000, earned: 130_000, makeUp: 14_000 })
    expect(makeUpOf(pay(), { minutesPresent: 9_600, earned: 150_000 }).makeUp).toBe(0)
    expect(makeUpOf(pay(), { minutesPresent: 9_600, earned: 144_000 }).makeUp).toBe(0)
  })

  it('counts scans, team shares and paid time towards the guarantee; never an earlier make-up or an adjustment', () => {
    expect(
      earnedForMakeUp([
        { kind: 'SCAN', amount: 10_000 },
        { kind: 'SCAN', amount: -2_000 },
        { kind: 'TEAM_SPLIT', amount: 3_000 },
        { kind: 'OFF_STANDARD', amount: 1_500 },
        { kind: 'MAKE_UP', amount: 9_999 },
        { kind: 'ADJUSTMENT', amount: 5_000 },
      ]),
    ).toBe(12_500)
  })

  it('pays a standard-minute bonus above the threshold on top of the guaranteed time pay', () => {
    const bonus = pay({ kind: 'STANDARD_MINUTE_BONUS', efficiencyThresholdPct: '75' })
    expect(bonusOf(bonus, { minutesPresent: 9_600, earnedStandardMinutes: '8160', earnedValue: 120_000 })).toEqual({ efficiencyPct: '85', thresholdMinutes: '7200', bonusMinutes: '960', bonus: 14_118 })
    expect(bonusOf(bonus, { minutesPresent: 9_600, earnedStandardMinutes: '7000', earnedValue: 100_000 }).bonus).toBe(0)
    expect(periodPayOf(bonus, { minutesPresent: 9_600, earned: 0, earnedStandardMinutes: '8160', earnedValue: 120_000 })).toMatchObject({ guaranteed: 144_000, makeUp: null, total: 158_118 })
    expect(periodPayOf(pay(), { minutesPresent: 9_600, earned: 130_000 })).toMatchObject({ guaranteed: 144_000, total: 144_000, makeUp: { makeUp: 14_000 } })
  })
})

describe('rework and scrap pay (MES-258) and waiting (c.c. art. 2100)', () => {
  it('prices own-fault rework and scrap by the scheme: unpaid, a reduced percent of the rate, or the full rate', () => {
    const input = { pieces: 7, ratePerPiece: '1.25', minutes: 0, averagePerMinute: null }
    expect(defectPayOf(pay(), { ...input, what: 'REWORK', fault: 'OWN' })).toEqual({ pays: 'NOTHING', rule: 'UNPAID', amount: 0 })
    expect(defectPayOf(pay({ reworkOwnFault: 'REDUCED_RATE', ownFaultRatePct: '33.3333' }), { ...input, what: 'REWORK', fault: 'OWN' })).toEqual({ pays: 'PIECES', rule: 'REDUCED_RATE', pieces: 7, rate: '0.416666', amount: 292 })
    expect(defectPayOf(pay({ scrapOwnFault: 'FULL_RATE' }), { ...input, what: 'SCRAP', fault: 'OWN' })).toMatchObject({ pays: 'PIECES', rate: '1.25', amount: 875 })
    expect(defectPayOf(pay({ scrapOwnFault: 'FULL_RATE' }), { ...input, what: 'REWORK', fault: 'OWN' }).pays).toBe('NOTHING')
  })

  it('pays rework and scrap caused by others as time, at the average or the guaranteed rate (the guaranteed while no average is known)', () => {
    const others = { what: 'SCRAP' as const, fault: 'OTHERS' as const, pieces: 3, ratePerPiece: '1', minutes: 30 }
    expect(defectPayOf(pay(), { ...others, averagePerMinute: '0.2' })).toMatchObject({ pays: 'TIME', amount: 600, time: { basis: 'AVERAGE', ratePerMinute: '0.2' } })
    expect(defectPayOf(pay(), { ...others, averagePerMinute: null })).toMatchObject({ pays: 'TIME', amount: 450, time: { basis: 'GUARANTEED', ratePerMinute: '0.15' } })
    expect(defectPayOf(pay({ othersFaultPay: 'GUARANTEED' }), { ...others, averagePerMinute: '0.2' }).amount).toBe(450)
    expect(paidTimeOf(pay(), { rule: 'AVERAGE', minutes: 45, averagePerMinute: averagePerMinuteOf({ earned: 120_000, minutes: 9_000, currency: 'EUR' }) })).toEqual({ basis: 'AVERAGE', minutes: 45, ratePerMinute: '0.133333', amount: 600 })
    expect(averagePerMinuteOf({ earned: 0, minutes: 100, currency: 'EUR' })).toBeNull()
  })
})

describe('team incentive split (MES-259)', () => {
  it('shares a team\'s pay by hours present, adding up to it exactly (largest remainder, ties to the first listed)', () => {
    const shares = teamSplitOf({ basis: 'HOURS_PRESENT', pay: 1_000, members: [{ key: 'A', minutesPresent: 480 }, { key: 'B', minutesPresent: 480 }, { key: 'C', minutesPresent: 480 }] })
    expect(shares.map((share) => [share.key, share.sharePct, share.amount])).toEqual([
      ['A', '33.3333', 334],
      ['B', '33.3333', 333],
      ['C', '33.3333', 333],
    ])
    expect(shares.reduce((sum, share) => sum + share.amount, 0)).toBe(1_000)
  })

  it('shares by skill weight; a member who weighs nothing gets nothing; nothing to share by is refused', () => {
    const shares = teamSplitOf({ basis: 'SKILL_WEIGHT', pay: 2_399, members: [{ key: 'A', skillWeight: '3' }, { key: 'B', skillWeight: '1.5' }, { key: 'C', skillWeight: '0' }] })
    expect(shares.map((share) => [share.key, share.sharePct, share.amount])).toEqual([
      ['A', '66.6667', 1_599],
      ['B', '33.3333', 800],
      ['C', '0', 0],
    ])
    expect(() => teamSplitOf({ basis: 'SKILL_WEIGHT', pay: 100, members: [{ key: 'A', skillWeight: '0' }] })).toThrow('nothing to share by')
    expect(() => teamSplitOf({ basis: 'HOURS_PRESENT', pay: 100, members: [{ key: 'A' }] })).toThrow(SchemePayError)
    expect(() => teamSplitOf({ basis: 'HOURS_PRESENT', pay: 100, members: [{ key: 'A', minutesPresent: 1 }, { key: 'A', minutesPresent: 1 }] })).toThrow('listed twice')
  })
})

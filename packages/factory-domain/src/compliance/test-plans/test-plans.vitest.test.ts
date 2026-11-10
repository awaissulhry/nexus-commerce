import { describe, expect, it } from 'vitest'
import { dueTests, limitFits, planProblems, planSwitchRefusal, resultProblems, verdictOf, type LotFacts, type LotResultFact, type PlanFacts } from './rules'

/** B-W2b-256: test plan rules, the tests due on a lot and a substance test's verdict (pure). Every id and value is made up. */

const today = '2026-11-10'
const plan = (over: Partial<PlanFacts> = {}): PlanFacts => ({ id: 'tp-1', companyId: null, itemKind: 'LEATHER', itemId: null, test: 'AZO', frequency: 'EVERY_LOT', marketCode: null, substanceRuleId: null, method: 'EN ISO 17234-1', switchedOn: true, status: 'ACTIVE', ...over })
const lot = (id: string, over: Partial<LotFacts> = {}): LotFacts => ({ id, code: `L-${id}`, itemId: 'm-1', itemKind: 'LEATHER', companyId: 'c-1', supplierId: 's-1', itemColourId: 'col-1', arrivedOn: '2026-10-01', createdAt: '2026-10-01T08:00:00.000Z', ...over })
const result = (lotId: string, over: Partial<LotResultFact> = {}): LotResultFact => ({ resultId: `r-${lotId}`, lotId, test: 'AZO', verdict: 'PASS', testedOn: '2026-10-02', recordedAt: '2026-10-02T08:00:00.000Z', ...over })

describe('a test plan rule', () => {
  it('names a kind or one material, a test, a frequency, a market code; off with the reason', () => {
    expect(planProblems({ itemKind: 'LEATHER', test: 'AZO', frequency: 'ON_CHANGE', marketCode: 'FR' })).toEqual([])
    expect(planProblems({ itemKind: 'LEATHER', itemId: 'm-1', test: 'PH', frequency: 'DAILY', marketCode: 'france' }).map((problem) => problem.path)).toEqual(['body/itemKind', 'body/test', 'body/frequency', 'body/marketCode'])
    expect(planProblems({ itemKind: 'FINISHED', test: 'AZO', frequency: 'YEARLY', switchedOn: false }).map((problem) => problem.path)).toEqual(['body/itemKind', 'body/offReason'])
    expect(planSwitchRefusal({ switchedOn: true, status: 'ACTIVE' }, true, null)).toBe('This test plan rule is already on.')
    expect(planSwitchRefusal({ switchedOn: true, status: 'ACTIVE' }, false, 'no')).toMatch(/^Say why/)
    expect(planSwitchRefusal({ switchedOn: true, status: 'ARCHIVED' }, false, 'waits for a market')).toMatch(/archived/)
  })
})

describe('the tests due on a lot (PRD-309)', () => {
  const first = lot('1')
  const second = lot('2', { arrivedOn: '2026-11-01', createdAt: '2026-11-01T08:00:00.000Z' })
  const other = lot('3', { arrivedOn: '2026-11-02', createdAt: '2026-11-02T08:00:00.000Z', supplierId: 's-2' })
  const recolour = lot('4', { arrivedOn: '2026-11-03', createdAt: '2026-11-03T08:00:00.000Z', itemColourId: 'col-2' })
  const lots = [first, second, other, recolour]

  it('every lot: only this lot\'s result covers it', () => {
    const due = dueTests({ lot: second, plans: [plan()], markets: ['IT'], lots, results: [result('1')], today })
    expect(due).toMatchObject([{ status: 'DUE', words: 'AZO due (every lot): this lot has no result yet.' }])
    expect(dueTests({ lot: first, plans: [plan()], markets: ['IT'], lots, results: [result('1')], today })).toMatchObject([{ status: 'MET', coveredByOtherLot: false }])
  })

  it('the first lot of a supplier: an earlier lot of the same supplier covers it; a new supplier asks again', () => {
    const plans = [plan({ frequency: 'FIRST_LOT' })]
    expect(dueTests({ lot: second, plans, markets: [], lots, results: [result('1')], today })).toMatchObject([{ status: 'MET', coveredByOtherLot: true, result: { lotCode: 'L-1' } }])
    expect(dueTests({ lot: other, plans, markets: [], lots, results: [result('1')], today })).toMatchObject([{ status: 'DUE' }])
  })

  it('on a change: a new colour asks again; yearly: a result older than a year does not cover it; a failure shows', () => {
    expect(dueTests({ lot: recolour, plans: [plan({ frequency: 'ON_CHANGE' })], markets: [], lots, results: [result('1')], today })).toMatchObject([{ status: 'DUE' }])
    expect(dueTests({ lot: second, plans: [plan({ frequency: 'ON_CHANGE' })], markets: [], lots, results: [result('1', { verdict: 'FAIL' })], today })).toMatchObject([{ status: 'FAILED' }])
    expect(dueTests({ lot: other, plans: [plan({ frequency: 'YEARLY' })], markets: [], lots, results: [result('1', { testedOn: '2025-11-01' })], today })).toMatchObject([{ status: 'DUE' }])
    expect(dueTests({ lot: other, plans: [plan({ frequency: 'YEARLY' })], markets: [], lots, results: [result('1')], today })).toMatchObject([{ status: 'MET', coveredByOtherLot: true }])
  })

  it('applies a rule only when on, active, of the lot\'s material or kind, company and a market sold to; a material\'s own rule wins over its kind\'s', () => {
    const plans = [plan({ switchedOn: false }), plan({ id: 'tp-2', marketCode: 'FR' }), plan({ id: 'tp-3', itemKind: 'TRIM' }), plan({ id: 'tp-4', companyId: 'c-2' })]
    expect(dueTests({ lot: first, plans, markets: ['IT'], lots, results: [], today })).toEqual([])
    expect(dueTests({ lot: first, plans, markets: ['FR-75'], lots, results: [], today }).map((entry) => entry.planId)).toEqual(['tp-2'])
    const own = [plan({ id: 'kind' }), plan({ id: 'own', itemKind: null, itemId: 'm-1' })]
    expect(dueTests({ lot: first, plans: own, markets: [], lots, results: [], today }).map((entry) => entry.planId)).toEqual(['own'])
  })
})

describe('a substance test\'s verdict', () => {
  it('below the limit passes, above fails, at the limit as the rule\'s bound says', () => {
    expect(verdictOf('29.9', '30', 'AT_MOST')).toBe('PASS')
    expect(verdictOf('30', '30', 'AT_MOST')).toBe('PASS')
    expect(verdictOf('30', '30', 'BELOW')).toBe('FAIL')
    expect(verdictOf('31', '30', 'AT_MOST')).toBe('FAIL')
  })

  it('checks the result and judges it; below a detection limit above the rule\'s gives no verdict', () => {
    const draft = { test: 'AZO', method: 'EN ISO 17234-1', valueMgKg: '8.5', lab: 'Lab One', testedOn: '2026-11-05', evidence: 'LOT_REPORT' }
    expect(resultProblems(draft, { limitValue: '30', limitBound: 'AT_MOST' }, today)).toEqual({ verdict: 'PASS', problems: [] })
    expect(resultProblems({ ...draft, valueMgKg: null, belowDetectionLimit: true, detectionLimitMgKg: '5' }, { limitValue: '30', limitBound: 'AT_MOST' }, today).verdict).toBe('PASS')
    expect(resultProblems({ ...draft, valueMgKg: null, belowDetectionLimit: true, detectionLimitMgKg: '50' }, { limitValue: '30', limitBound: 'AT_MOST' }, today).problems.map((problem) => problem.path)).toEqual(['body/detectionLimitMgKg'])
    const bad = resultProblems({ test: 'CR_VI', method: '', valueMgKg: 'x', lab: '', testedOn: '2026-12-01', evidence: 'SUPPLIER_REPORT' }, { limitValue: '30', limitBound: 'AT_MOST' }, today)
    expect(bad.verdict).toBeNull()
    expect(bad.problems.map((problem) => problem.path)).toEqual(['body/test', 'body/method', 'body/lab', 'body/testedOn', 'body/valueMgKg', 'body/article', 'body/periodFrom'])
  })

  it('a limit a lab result can hold (8 digits, 3 decimals)', () => {
    expect(limitFits('30')).toBe(true)
    expect(limitFits('0.5')).toBe(true)
    expect(limitFits('0.100000')).toBe(true)
    expect(limitFits('0.0005')).toBe(false)
    expect(limitFits('100000')).toBe(false)
  })
})

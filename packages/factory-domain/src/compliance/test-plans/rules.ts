import type { Issue } from '../../core/errors'
import { isBusinessDate, type BusinessDate } from '../../core/time'
import { ITEM_KINDS } from '../../product/materials/rules'
import { MARKET_CODE, MARKET_CODE_MAX } from '../markets/rules'
import { marketCovered } from '../substances/evaluate'
import { SUBSTANCE_TESTS, UNIT_WORDS, type LimitBound, type RuleCode, type SubstanceTest, type SubstanceUnit } from '../substances/rules'

/**
 * Test plan rules (B-W2b-256; PRD-309; design compliance.tests › "Test plan rules (W2b)"), the pure part: which lab test a
 * material needs (by its kind, or one material), how often (every lot, the first lot of a supplier, once a year, when the
 * supplier or the colour changes), for which market; which tests are due on a lot, and what covers each (a result of this
 * lot, or of an earlier lot the frequency allows); and a substance test's verdict against its substance rule's limit (the
 * rule's bound decides a value at the limit). W1's chromium VI test of every leather lot stays W1's (modules/quality/lab):
 * a CR_VI plan rule shows on the lot beside the others. Nothing is ordered from a lab and no lab price is kept.
 */

export const TEST_FREQUENCIES = ['EVERY_LOT', 'FIRST_LOT', 'YEARLY', 'ON_CHANGE'] as const
export type TestFrequency = (typeof TEST_FREQUENCIES)[number]
export const PLAN_STATUSES = ['ACTIVE', 'ARCHIVED'] as const
export type PlanStatus = (typeof PLAN_STATUSES)[number]
/** The kinds a plan rule may name (never a finished garment). */
export const PLAN_ITEM_KINDS = ITEM_KINDS
/** The tests a result of this module records: every substance test but chromium VI (W1's route records that one). */
export const RECORDED_TESTS = SUBSTANCE_TESTS.filter((test) => test !== 'CR_VI') as readonly Exclude<SubstanceTest, 'CR_VI'>[]
export type RecordedTest = (typeof RECORDED_TESTS)[number]
export const RESULT_EVIDENCE = ['LOT_REPORT', 'SUPPLIER_REPORT'] as const
export type ResultEvidence = (typeof RESULT_EVIDENCE)[number]

export const PLAN_LIMITS = { method: 200, note: 1000, offReason: 500, lab: 200, reportNumber: 200, resultNote: 500, article: 200 } as const

export const FREQUENCY_WORDS: Readonly<Record<TestFrequency, string>> = Object.freeze({
  EVERY_LOT: 'every lot',
  FIRST_LOT: 'the first lot of each supplier',
  YEARLY: 'once a year',
  ON_CHANGE: 'when the supplier or the colour changes',
})

/** The substance rule code a test proves (a CMR or OTHER rule may name any test: the database's rule). */
export const RULE_CODE_OF_TEST: Readonly<Record<SubstanceTest, RuleCode>> = Object.freeze({ CR_VI: 'CR6', AZO: 'AZO', NICKEL: 'NICKEL', PAH: 'PAH', DMFU: 'DMFU', NPE: 'NPE', PFAS: 'PFAS' })

const CONTROL = /\p{Cc}/u
const CONTROL_BUT_LINES = /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const wordsOk = (words: string | null | undefined, longest: number, lines = false): boolean =>
  words === null || words === undefined || (words.trim() !== '' && words.length <= longest && !(lines ? CONTROL_BUT_LINES : CONTROL).test(words))

export interface PlanDraft {
  readonly itemKind?: string | null | undefined
  readonly itemId?: string | null | undefined
  readonly test: string
  readonly frequency: string
  readonly marketCode?: string | null | undefined
  readonly method?: string | null | undefined
  readonly note?: string | null | undefined
  readonly switchedOn?: boolean | undefined
  readonly offReason?: string | null | undefined
}

/** What is wrong with a plan rule as it would be saved (every problem at once; `body/…`). */
export function planProblems(draft: PlanDraft, at = 'body'): Issue[] {
  const problems: Issue[] = []
  const kind = draft.itemKind ?? null
  const item = draft.itemId ?? null
  if ((kind === null) === (item === null)) problems.push({ path: `${at}/itemKind`, message: 'A kind of material or one material, exactly one of them.' })
  if (kind !== null && !(PLAN_ITEM_KINDS as readonly string[]).includes(kind)) problems.push({ path: `${at}/itemKind`, message: `A kind of material: ${PLAN_ITEM_KINDS.join(', ')}.` })
  if (!(SUBSTANCE_TESTS as readonly string[]).includes(draft.test)) problems.push({ path: `${at}/test`, message: `One of ${SUBSTANCE_TESTS.join(', ')}.` })
  if (!(TEST_FREQUENCIES as readonly string[]).includes(draft.frequency)) problems.push({ path: `${at}/frequency`, message: `One of ${TEST_FREQUENCIES.join(', ')}.` })
  const market = draft.marketCode ?? null
  if (market !== null && (market.length > MARKET_CODE_MAX || !MARKET_CODE.test(market))) problems.push({ path: `${at}/marketCode`, message: 'A market code ("IT", "FR", "US-CA"), or none for every market.' })
  if (!wordsOk(draft.method, PLAN_LIMITS.method)) problems.push({ path: `${at}/method`, message: `The method to ask the lab for, up to ${PLAN_LIMITS.method} characters.` })
  if (!wordsOk(draft.note, PLAN_LIMITS.note, true)) problems.push({ path: `${at}/note`, message: `Up to ${PLAN_LIMITS.note} characters.` })
  if (draft.switchedOn === false && ((draft.offReason ?? '').trim().length < 3 || !wordsOk(draft.offReason, PLAN_LIMITS.offReason, true))) {
    problems.push({ path: `${at}/offReason`, message: `Say why it is off, in 3 to ${PLAN_LIMITS.offReason} characters (the question it waits for).` })
  }
  if (draft.switchedOn !== false && draft.offReason) problems.push({ path: `${at}/offReason`, message: 'A rule that is on has no reason to be off.' })
  return problems
}

/** Why a switch is refused (null: it may go), as the substance rules' switch. */
export function planSwitchRefusal(plan: { readonly switchedOn: boolean; readonly status: string }, on: boolean, reason: string | null | undefined): string | null {
  if (plan.status !== 'ACTIVE') return 'This test plan rule is archived: restore it before switching it.'
  if (plan.switchedOn === on) return `This test plan rule is already ${on ? 'on' : 'off'}.`
  const words = (reason ?? '').trim()
  if (!on && (words.length < 3 || !wordsOk(words, PLAN_LIMITS.offReason, true))) return `Say why it is switched off, in 3 to ${PLAN_LIMITS.offReason} characters.`
  return null
}

// ---- the tests due on a lot ------------------------------------------------------------------------------------------

export interface PlanFacts {
  readonly id: string
  readonly companyId: string | null
  readonly itemKind: string | null
  readonly itemId: string | null
  readonly test: SubstanceTest
  readonly frequency: TestFrequency
  readonly marketCode: string | null
  readonly substanceRuleId: string | null
  readonly method: string | null
  readonly switchedOn: boolean
  readonly status: string
}

/** A lot of the material (this one or an earlier one): who supplied it, in which colour, when it arrived. */
export interface LotFacts {
  readonly id: string
  readonly code: string
  readonly itemId: string
  readonly itemKind: string
  readonly companyId: string
  readonly supplierId: string | null
  readonly itemColourId: string | null
  /** The day it arrived (received, else made), the order of lots. */
  readonly arrivedOn: BusinessDate
  /** Tie-break of one day (ISO). */
  readonly createdAt: string
}

/** A current (not superseded) result of a substance test on a lot of the material. */
export interface LotResultFact {
  readonly resultId: string
  readonly lotId: string
  readonly test: SubstanceTest
  readonly verdict: 'PASS' | 'FAIL'
  readonly testedOn: BusinessDate
  readonly recordedAt: string
}

export type DueStatus = 'DUE' | 'MET' | 'FAILED'

export interface DueTest {
  readonly planId: string
  readonly test: SubstanceTest
  readonly frequency: TestFrequency
  readonly method: string | null
  readonly marketCode: string | null
  readonly substanceRuleId: string | null
  readonly status: DueStatus
  /** The result that covers it (this lot's, or an earlier lot's the frequency allows). */
  readonly result: (LotResultFact & { readonly lotCode: string }) | null
  readonly coveredByOtherLot: boolean
  readonly words: string
}

const YEAR_DAYS = 365
function minusDays(day: BusinessDate, days: number): BusinessDate {
  const at = new Date(`${day}T12:00:00Z`)
  at.setUTCDate(at.getUTCDate() - days)
  return at.toISOString().slice(0, 10)
}

const before = (a: LotFacts, b: LotFacts): boolean => a.arrivedOn < b.arrivedOn || (a.arrivedOn === b.arrivedOn && a.createdAt < b.createdAt)

/** Does the plan rule apply to this lot (ACTIVE, on, its material or kind, its company, a market sold to)? */
export function planApplies(plan: PlanFacts, lot: LotFacts, markets: readonly string[]): boolean {
  if (plan.status !== 'ACTIVE' || !plan.switchedOn) return false
  if (plan.companyId !== null && plan.companyId !== lot.companyId) return false
  if (plan.itemId !== null ? plan.itemId !== lot.itemId : plan.itemKind !== lot.itemKind) return false
  return plan.marketCode === null || markets.some((market) => marketCovered(plan.marketCode!, market))
}

/**
 * The tests due on a lot by the plan rules (PRD-309: "due tests appear on the lot as W1's chromium VI test does"). Which
 * results cover a rule: EVERY_LOT this lot's; FIRST_LOT this lot's or an earlier lot's of the same supplier; YEARLY any lot's
 * of the material tested within a year; ON_CHANGE this lot's or an earlier lot's of the same supplier and colour. The newest
 * covering result decides: PASS met, FAIL failed; none: due. A material with one plan rule per kind and one per material of
 * the same test and frequency shows it once (the material's own rule).
 */
export function dueTests(input: {
  readonly lot: LotFacts
  readonly plans: readonly PlanFacts[]
  readonly markets: readonly string[]
  /** Every lot of the material (this one included). */
  readonly lots: readonly LotFacts[]
  readonly results: readonly LotResultFact[]
  readonly today: BusinessDate
}): DueTest[] {
  const { lot } = input
  const lotsById = new Map(input.lots.map((entry) => [entry.id, entry]))
  const applying = input.plans.filter((plan) => planApplies(plan, lot, input.markets))
  // The material's own rule wins over its kind's for the same test and frequency.
  const chosen = applying.filter((plan) => plan.itemId !== null || !applying.some((other) => other.itemId !== null && other.test === plan.test && other.frequency === plan.frequency))
  const out: DueTest[] = []
  for (const plan of chosen) {
    const allowed = (other: LotFacts): boolean => {
      switch (plan.frequency) {
        case 'EVERY_LOT':
          return other.id === lot.id
        case 'FIRST_LOT':
          return other.id === lot.id || (before(other, lot) && other.supplierId === lot.supplierId)
        case 'YEARLY':
          return true
        case 'ON_CHANGE':
          return other.id === lot.id || (before(other, lot) && other.supplierId === lot.supplierId && other.itemColourId === lot.itemColourId)
      }
    }
    const since = minusDays(input.today, YEAR_DAYS)
    const covering = input.results
      .filter((result) => result.test === plan.test)
      .filter((result) => {
        const of = lotsById.get(result.lotId)
        return of !== undefined && allowed(of) && (plan.frequency !== 'YEARLY' || result.testedOn >= since)
      })
      .sort((a, b) => b.testedOn.localeCompare(a.testedOn) || b.recordedAt.localeCompare(a.recordedAt))
    const newest = covering[0] ?? null
    const lotCode = newest ? (lotsById.get(newest.lotId)?.code ?? '?') : null
    const other = newest !== null && newest.lotId !== lot.id
    const how = FREQUENCY_WORDS[plan.frequency]
    const base = { planId: plan.id, test: plan.test, frequency: plan.frequency, method: plan.method, marketCode: plan.marketCode, substanceRuleId: plan.substanceRuleId }
    if (newest === null) {
      const why =
        plan.frequency === 'FIRST_LOT'
          ? 'no lot of this supplier was tested yet'
          : plan.frequency === 'ON_CHANGE'
            ? 'no lot of this supplier and colour was tested yet'
            : plan.frequency === 'YEARLY'
              ? 'no lot of the material was tested within a year'
              : 'this lot has no result yet'
      out.push({ ...base, status: 'DUE', result: null, coveredByOtherLot: false, words: `${plan.test} due (${how}): ${why}.` })
    } else {
      const result = { ...newest, lotCode: lotCode! }
      const where = other ? ` on lot ${lotCode}` : ''
      out.push(
        newest.verdict === 'PASS'
          ? { ...base, status: 'MET', result, coveredByOtherLot: other, words: `${plan.test} (${how}): passed${where} on ${newest.testedOn}.` }
          : { ...base, status: 'FAILED', result, coveredByOtherLot: other, words: `${plan.test} (${how}): failed${where} on ${newest.testedOn}.` },
      )
    }
  }
  const order = (test: SubstanceTest): number => SUBSTANCE_TESTS.indexOf(test)
  const rank: Readonly<Record<DueStatus, number>> = { FAILED: 0, DUE: 1, MET: 2 }
  return out.sort((a, b) => rank[a.status] - rank[b.status] || order(a.test) - order(b.test))
}

// ---- a substance test's result ---------------------------------------------------------------------------------------

/** The unit a result of a rule is written in (LabResult.unit): nickel release in µg/cm²/week (EN 1811), the others as the rule's limit. */
export const unitOfRule = (unit: SubstanceUnit): string => UNIT_WORDS[unit]

const VALUE = /^\d{1,5}(\.\d{1,3})?$/

/** A value against the rule's limit: below passes, above fails, at the limit as the rule's bound says (BELOW: must be below). */
export function verdictOf(value: string, limit: string, bound: LimitBound): 'PASS' | 'FAIL' {
  const v = Number(value)
  const l = Number(limit)
  if (v < l) return 'PASS'
  if (v > l) return 'FAIL'
  return bound === 'AT_MOST' ? 'PASS' : 'FAIL'
}

export interface ResultDraft {
  readonly test: string
  readonly method?: string | null | undefined
  readonly valueMgKg?: string | null | undefined
  readonly belowDetectionLimit?: boolean | undefined
  readonly detectionLimitMgKg?: string | null | undefined
  readonly lab?: string | null | undefined
  readonly reportNumber?: string | null | undefined
  readonly testedOn: string
  readonly evidence: string
  readonly article?: string | null | undefined
  readonly periodFrom?: string | null | undefined
  readonly periodTo?: string | null | undefined
  readonly note?: string | null | undefined
}

/**
 * A substance test's result, checked against its rule's limit (every problem at once; `body/…`): the test (not chromium VI:
 * W1's route), the method, a measured value or "below the detection limit" with the limit, the laboratory, the test day,
 * the evidence (a supplier report names its article and period). The verdict: below the limit PASS, above FAIL, at it as
 * the rule's bound says; below a detection limit passes only when that limit is at or below the rule's (else no verdict:
 * the lab must test to a lower limit).
 */
export function resultProblems(draft: ResultDraft, rule: { readonly limitValue: string; readonly limitBound: LimitBound }, today: BusinessDate): { readonly verdict: 'PASS' | 'FAIL' | null; readonly problems: Issue[] } {
  const problems: Issue[] = []
  if (!(RECORDED_TESTS as readonly string[]).includes(draft.test)) problems.push({ path: 'body/test', message: `One of ${RECORDED_TESTS.join(', ')} (a chromium VI result is recorded on the lot: POST /quality/lots/:lotId/results).` })
  if (!draft.method || !wordsOk(draft.method, PLAN_LIMITS.method)) problems.push({ path: 'body/method', message: `The method as written on the report, up to ${PLAN_LIMITS.method} characters.` })
  if (!draft.lab || !wordsOk(draft.lab, PLAN_LIMITS.lab)) problems.push({ path: 'body/lab', message: `Name the laboratory, as on its report (at most ${PLAN_LIMITS.lab} characters).` })
  if (!wordsOk(draft.reportNumber, PLAN_LIMITS.reportNumber)) problems.push({ path: 'body/reportNumber', message: `At most ${PLAN_LIMITS.reportNumber} characters.` })
  if (!wordsOk(draft.note, PLAN_LIMITS.resultNote, true)) problems.push({ path: 'body/note', message: `At most ${PLAN_LIMITS.resultNote} characters.` })
  if (!isBusinessDate(draft.testedOn)) problems.push({ path: 'body/testedOn', message: 'The day of the test, YYYY-MM-DD.' })
  else if (draft.testedOn > today) problems.push({ path: 'body/testedOn', message: `The test day ${draft.testedOn} is after today (${today}).` })
  let verdict: 'PASS' | 'FAIL' | null = null
  if (draft.belowDetectionLimit === true) {
    if (draft.valueMgKg) problems.push({ path: 'body/valueMgKg', message: 'Below the detection limit has no measured value.' })
    if (!draft.detectionLimitMgKg || !VALUE.test(draft.detectionLimitMgKg) || Number(draft.detectionLimitMgKg) <= 0) problems.push({ path: 'body/detectionLimitMgKg', message: "The lab's detection limit, above 0, up to 3 decimals." })
    else if (Number(draft.detectionLimitMgKg) > Number(rule.limitValue)) problems.push({ path: 'body/detectionLimitMgKg', message: `A detection limit of ${draft.detectionLimitMgKg} is above the rule's limit of ${rule.limitValue}: the lab must test to a lower limit.` })
    else verdict = 'PASS'
  } else {
    if (draft.detectionLimitMgKg) problems.push({ path: 'body/detectionLimitMgKg', message: 'Only a result below the detection limit names one.' })
    if (!draft.valueMgKg || !VALUE.test(draft.valueMgKg)) problems.push({ path: 'body/valueMgKg', message: 'The measured value, from 0, up to 3 decimals (or below the detection limit).' })
    else verdict = verdictOf(draft.valueMgKg, rule.limitValue, rule.limitBound)
  }
  if (!(RESULT_EVIDENCE as readonly string[]).includes(draft.evidence)) problems.push({ path: 'body/evidence', message: `${RESULT_EVIDENCE.join(' or ')}.` })
  const covers = [draft.article, draft.periodFrom, draft.periodTo].some((value) => value !== null && value !== undefined && value.trim() !== '')
  if (draft.evidence === 'SUPPLIER_REPORT') {
    if (!draft.article || !wordsOk(draft.article, PLAN_LIMITS.article)) problems.push({ path: 'body/article', message: "Name the article the supplier's report covers, as on the report." })
    if (!isBusinessDate(draft.periodFrom ?? '') || !isBusinessDate(draft.periodTo ?? '')) problems.push({ path: 'body/periodFrom', message: 'The first and last day the report covers, YYYY-MM-DD.' })
    else if (draft.periodFrom! > draft.periodTo!) problems.push({ path: 'body/periodTo', message: 'The period ends before it starts.' })
  } else if (covers) problems.push({ path: 'body/article', message: 'Only a supplier report names the article and the period it covers.' })
  return { verdict: problems.length === 0 ? verdict : null, problems }
}

/** A limit LabResult can hold (8 digits, 3 decimals: Decimal(8,3)), above 0. */
export function limitFits(limit: string): boolean {
  const value = Number(limit)
  if (!Number.isFinite(value) || value <= 0 || value >= 100_000) return false
  return (limit.split('.')[1] ?? '').replace(/0+$/, '').length <= 3
}

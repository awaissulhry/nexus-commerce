import type { Issue } from '../../core/errors'
import { isAreaUom } from '../../inventory/hides/area'
import { Dec, type Decimal } from '../../tax/decimal'
import type { AqlDefectClass } from '../aql/sampling'

/**
 * The incoming inspection of a lot, hide by hide (B-W2b-98; QHS-025 "Leather lot sampling and area check", QHS-028 "Shade
 * grouping against a master swatch", QHS-034 "Partial acceptance and split", MES-054 "Mark defects and quality zones on a
 * hide"; design floor.incoming SCR-175: Sample "Inspect 13 of 120 hides", Hide by hide (area against the tannery, shade
 * tiles, HideMap marks and zones, Accept or Reject), Decision (three pads that must add up, signed with the PIN)).
 *
 * Pure rules the API's commands apply before the database (…_inspection_plans_w2b_guards' IncomingInspection and
 * IncomingHideResult triggers stay the last word, and write the computed result): the shape of a hide's result and its
 * marks, the found counts from the marks (a hide counts once, under its worst defect class), the tally of the sample's
 * decisions, the decision's rules (accepted + rejected + to sort = the lot; never fewer than the sample says; the units
 * outside the sample are accepted only on a whole sample; the whole lot never accepted over a critical defect, a failed
 * critical check or a missing mandatory check; the reason exactly when the whole lot goes against the computed result),
 * the plan check results by type, and the words of the sample and of what comes after the decision. The lot itself is
 * released or rejected by a person with the quality role who types its code, never its receiver (Owner answer W3).
 */

export const UNIT_DECISIONS = ['ACCEPTED', 'REJECTED', 'TO_SORT'] as const
export type UnitDecision = (typeof UNIT_DECISIONS)[number]

export const MARK_KINDS = ['DEFECT', 'ZONE'] as const
export type MarkKind = (typeof MARK_KINDS)[number]

export const CHECK_OUTCOMES = ['PASS', 'FAIL', 'NOT_APPLICABLE'] as const
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number]

export const INCOMING_LIMITS = Object.freeze({ note: 500, reasonMin: 5, reason: 500, marks: 60, outline: 60, markNote: 200, code: 40, results: 500, value: 500 })

/** An area or a quantity as text: up to 14 digits and 4 decimals (Decimal(18, 4)). */
const DECIMAL = /^\d{1,14}(\.\d{1,4})?$/
const WHOLE = /^\d{1,14}(\.0{1,4})?$/

type Words = { readonly it: string; readonly en: string }

// ---- a hide's result -----------------------------------------------------------------------------------------------------

export interface PointDraft {
  readonly x: number
  readonly y: number
}

/**
 * A mark on the hide map (MES-054), from 0 to 1 on each axis: a DEFECT names its defect code of the library (and the zone
 * it lies in, when known); a ZONE names its grade code and its outline (3 points or more). Kept on the hide's result while
 * the inspection is OPEN; written to the hide (HideMark) when it is signed.
 */
export interface MarkDraft extends PointDraft {
  readonly kind: MarkKind
  readonly code?: string | null | undefined
  readonly zone?: string | null | undefined
  readonly outline?: readonly PointDraft[] | null | undefined
  readonly note?: string | null | undefined
}

const onHide = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

/** What is wrong with the marks of one hide, in words (paths `<at>/<i>/<field>`). */
export function markProblems(marks: readonly MarkDraft[], at = 'marks'): Issue[] {
  const problems: Issue[] = []
  if (marks.length > INCOMING_LIMITS.marks) return [{ path: at, message: `At most ${INCOMING_LIMITS.marks} marks on one hide.` }]
  marks.forEach((mark, index) => {
    const path = `${at}/${index}`
    if (!onHide(mark.x) || !onHide(mark.y)) problems.push({ path: `${path}/x`, message: 'A mark lies on the hide: x and y from 0 to 1.' })
    const code = mark.code?.trim() ?? ''
    const zone = mark.zone?.trim() ?? ''
    const outline = mark.outline ?? []
    if (mark.kind === 'DEFECT') {
      if (!code) problems.push({ path: `${path}/code`, message: 'A defect mark names its defect.' })
      if (outline.length > 0) problems.push({ path: `${path}/outline`, message: 'A defect is a point: only a zone has an outline.' })
    } else {
      if (code) problems.push({ path: `${path}/code`, message: 'A zone names its grade, not a defect.' })
      if (!zone) problems.push({ path: `${path}/zone`, message: 'A zone names its grade (A, B, C …).' })
      if (outline.length < 3) problems.push({ path: `${path}/outline`, message: 'Draw the zone: at least 3 points.' })
      else if (outline.length > INCOMING_LIMITS.outline) problems.push({ path: `${path}/outline`, message: `At most ${INCOMING_LIMITS.outline} points.` })
      else if (outline.some((point) => !onHide(point?.x) || !onHide(point?.y))) problems.push({ path: `${path}/outline`, message: "A zone's points lie on the hide: x and y from 0 to 1." })
    }
    if (code.length > INCOMING_LIMITS.code || zone.length > INCOMING_LIMITS.code) problems.push({ path: `${path}/code`, message: `At most ${INCOMING_LIMITS.code} characters.` })
    if ((mark.note ?? '').length > INCOMING_LIMITS.markNote) problems.push({ path: `${path}/note`, message: `At most ${INCOMING_LIMITS.markNote} characters.` })
  })
  return problems
}

/** One hide's result as the bench sends it (QHS-025, QHS-028, MES-054): area, decision, note; marks apart. */
export interface HideDraft {
  /** The area measured now; none: the hide is not measured again (its area as received stands). */
  readonly measuredArea?: string | null | undefined
  /** The tannery's declared area of the hide, when its list says one apart from the area received. */
  readonly declaredArea?: string | null | undefined
  readonly areaUom?: string | null | undefined
  readonly decision?: UnitDecision | null | undefined
  readonly note?: string | null | undefined
}

/** What is wrong with a hide's result, in words. */
export function hideDraftProblems(draft: HideDraft): Issue[] {
  const problems: Issue[] = []
  const measured = draft.measuredArea?.trim() ?? ''
  const declared = draft.declaredArea?.trim() ?? ''
  if (measured && !(DECIMAL.test(measured) && new Dec(measured).greaterThan(0))) problems.push({ path: 'measuredArea', message: 'The area measured is above 0, with at most 4 decimals.' })
  if (declared && !(DECIMAL.test(declared) && new Dec(declared).greaterThan(0))) problems.push({ path: 'declaredArea', message: "The tannery's area is above 0, with at most 4 decimals." })
  if (declared && !measured) problems.push({ path: 'measuredArea', message: "Measure the hide to check it against the tannery's area." })
  if (measured && !(draft.areaUom && isAreaUom(draft.areaUom))) problems.push({ path: 'areaUom', message: 'Say the unit of the area: m², dm² or ft².' })
  if ((draft.note ?? '').length > INCOMING_LIMITS.note) problems.push({ path: 'note', message: `At most ${INCOMING_LIMITS.note} characters.` })
  return problems
}

// ---- counts and tallies ----------------------------------------------------------------------------------------------------

const RANK: Readonly<Record<AqlDefectClass, number>> = Object.freeze({ CRITICAL: 3, MAJOR: 2, MINOR: 1 })

/** The worst class of a hide's defects, or null (no defect). */
export function worstClass(classes: readonly AqlDefectClass[]): AqlDefectClass | null {
  return classes.reduce<AqlDefectClass | null>((worst, klass) => (worst === null || RANK[klass] > RANK[worst] ? klass : worst), null)
}

export interface Found {
  readonly critical: number
  readonly major: number
  readonly minor: number
}

/**
 * The units of the sample with a defect, per class (the record's foundCritical / foundMajor / foundMinor): each hide once,
 * under its worst defect class (a hide with a scar and a hole counts as one major hide, not two).
 */
export function foundOf(hides: readonly { readonly classes: readonly AqlDefectClass[] }[]): Found {
  const found = { critical: 0, major: 0, minor: 0 }
  for (const hide of hides) {
    const worst = worstClass(hide.classes)
    if (worst === 'CRITICAL') found.critical++
    else if (worst === 'MAJOR') found.major++
    else if (worst === 'MINOR') found.minor++
  }
  return found
}

export interface Tally {
  readonly done: number
  readonly accepted: number
  readonly rejected: number
  readonly toSort: number
  readonly undecided: number
}

/** The sample's decisions so far. */
export function tallyOf(decisions: readonly (UnitDecision | null)[]): Tally {
  return {
    done: decisions.length,
    accepted: decisions.filter((decision) => decision === 'ACCEPTED').length,
    rejected: decisions.filter((decision) => decision === 'REJECTED').length,
    toSort: decisions.filter((decision) => decision === 'TO_SORT').length,
    undecided: decisions.filter((decision) => decision === null).length,
  }
}

// ---- the computed result ---------------------------------------------------------------------------------------------------

export interface ComputedFacts {
  readonly found: Found
  readonly sampleSize: number
  /** Null: a fixed sample, no acceptance numbers (the database reads the sample). */
  readonly acceptMajor: number | null
  readonly acceptMinor: number | null
  /** Plan checks of class CRITICAL that failed, by name. */
  readonly failedCritical: readonly string[]
}

export interface Computed {
  readonly result: 'PASS' | 'FAIL'
  /** Why it is FAIL, in words. */
  readonly reasons: readonly string[]
  /** The reasons no whole-lot acceptance goes over: a critical defect, a failed critical check. */
  readonly hard: readonly string[]
}

const units = (n: number): string => `${n} ${n === 1 ? 'unit' : 'units'}`

/**
 * The result the rules give, as the database computes it at the decision: FAIL for a unit with a critical defect, a
 * failed critical check, or more major or minor units than the acceptance numbers (the sample when none).
 */
export function computedOf(facts: ComputedFacts): Computed {
  const hard: string[] = []
  const soft: string[] = []
  if (facts.found.critical > 0) hard.push(`${units(facts.found.critical)} with a critical defect: a critical defect is never accepted.`)
  if (facts.failedCritical.length > 0) hard.push(`Critical checks failed: ${facts.failedCritical.join(', ')}.`)
  const acceptMajor = facts.acceptMajor ?? facts.sampleSize
  const acceptMinor = facts.acceptMinor ?? facts.sampleSize
  if (facts.found.major > acceptMajor) soft.push(`${units(facts.found.major)} with a major defect; the plan accepts ${acceptMajor}.`)
  if (facts.found.minor > acceptMinor) soft.push(`${units(facts.found.minor)} with a minor defect; the plan accepts ${acceptMinor}.`)
  const reasons = [...hard, ...soft]
  return { result: reasons.length === 0 ? 'PASS' : 'FAIL', reasons, hard }
}

// ---- the decision (QHS-034) ------------------------------------------------------------------------------------------------

export interface DecisionDraft {
  readonly accepted: string
  readonly rejected: string
  readonly toSort: string
  readonly overrideReason?: string | null | undefined
  readonly note?: string | null | undefined
}

export interface DecisionFacts {
  readonly lotSize: string
  /** The lot is counted in whole units (hides, pieces): each quantity is a whole number. */
  readonly whole: boolean
  readonly sampleSize: number
  /** The lot is inspected hide by hide (its sample's decisions bind the quantities). */
  readonly byHide: boolean
  readonly tally: Tally
  /** The hides of the sample with no decision yet, by tag. */
  readonly undecided: readonly string[]
  readonly computed: Computed
  /** Mandatory plan checks with no result, by name. */
  readonly mandatoryMissing: readonly string[]
}

const quantityOf = (value: string): Decimal | null => (DECIMAL.test(value.trim()) ? new Dec(value.trim()) : null)

export type DecisionShape = 'WHOLE_ACCEPTED' | 'WHOLE_REJECTED' | 'PARTIAL'

/** The whole lot accepted, the whole lot rejected, or a split (QHS-034). */
export function decisionShape(draft: Pick<DecisionDraft, 'accepted' | 'rejected'>, lotSize: string): DecisionShape {
  const lot = new Dec(lotSize)
  if (quantityOf(draft.accepted)?.equals(lot)) return 'WHOLE_ACCEPTED'
  if (quantityOf(draft.rejected)?.equals(lot)) return 'WHOLE_REJECTED'
  return 'PARTIAL'
}

/** The whole lot decided against the computed result: the inspector's reason is asked (and only then). */
export function isOverride(shape: DecisionShape, computed: Pick<Computed, 'result'>): boolean {
  return (shape === 'WHOLE_ACCEPTED' && computed.result === 'FAIL') || (shape === 'WHOLE_REJECTED' && computed.result === 'PASS')
}

/** What keeps the decision from being signed, in words (paths `accepted`, `rejected`, `toSort`, `overrideReason`, `hides`). */
export function decisionProblems(draft: DecisionDraft, facts: DecisionFacts): Issue[] {
  const problems: Issue[] = []
  const lot = new Dec(facts.lotSize)
  const values: Record<'accepted' | 'rejected' | 'toSort', Decimal | null> = { accepted: quantityOf(draft.accepted), rejected: quantityOf(draft.rejected), toSort: quantityOf(draft.toSort) }
  for (const key of ['accepted', 'rejected', 'toSort'] as const) {
    const value = values[key]
    if (!value) problems.push({ path: key, message: 'From 0, with at most 4 decimals.' })
    else if (facts.whole && !WHOLE.test(draft[key].trim())) problems.push({ path: key, message: 'The lot is counted in whole units: a whole number.' })
  }
  if (problems.length > 0) return problems
  const accepted = values.accepted!
  const rejected = values.rejected!
  const toSort = values.toSort!
  if (!accepted.plus(rejected).plus(toSort).equals(lot)) {
    problems.push({ path: 'toSort', message: `Accepted, rejected and to sort add up to the lot of ${lot.toFixed()}: they add up to ${accepted.plus(rejected).plus(toSort).toFixed()}.` })
  }
  if (facts.undecided.length > 0) problems.push({ path: 'hides', message: `Decide every hide of the sample first: ${facts.undecided.join(', ')} ${facts.undecided.length === 1 ? 'has' : 'have'} no decision.` })
  if (facts.byHide) {
    if (accepted.lessThan(facts.tally.accepted)) problems.push({ path: 'accepted', message: `${facts.tally.accepted} hides of the sample are accepted: at least that many.` })
    if (rejected.lessThan(facts.tally.rejected)) problems.push({ path: 'rejected', message: `${facts.tally.rejected} hides of the sample are rejected: at least that many.` })
    if (toSort.lessThan(facts.tally.toSort)) problems.push({ path: 'toSort', message: `${facts.tally.toSort} hides of the sample are to sort: at least that many.` })
    if (facts.tally.done < facts.sampleSize && accepted.greaterThan(facts.tally.accepted)) {
      problems.push({ path: 'accepted', message: `Inspect the whole sample (${facts.tally.done} of ${facts.sampleSize} hides done) before accepting hides outside it; reject or sort the rest now.` })
    }
  }
  const shape = decisionShape(draft, facts.lotSize)
  // A failed sample says nothing good of the units outside it: they are rejected or sorted one by one. Accepting the whole
  // lot over a FAIL is the override below (with the reason); a split never accepts units it did not inspect.
  if (facts.byHide && shape === 'PARTIAL' && facts.computed.result === 'FAIL' && accepted.greaterThan(facts.tally.accepted)) {
    problems.push({ path: 'accepted', message: `The sample fails (${facts.computed.reasons.join(' ')}): accept only the ${facts.tally.accepted} hides inspected and accepted; reject or sort the rest.` })
  }
  if (shape === 'WHOLE_ACCEPTED') {
    if (facts.computed.hard.length > 0) problems.push({ path: 'accepted', message: `The whole lot is never accepted here: ${facts.computed.hard.join(' ')}` })
    if (facts.mandatoryMissing.length > 0) problems.push({ path: 'accepted', message: `Answer the mandatory checks before accepting the whole lot: ${facts.mandatoryMissing.join(', ')}.` })
  }
  const reason = draft.overrideReason?.trim() ?? ''
  if (isOverride(shape, facts.computed)) {
    if (reason.length < INCOMING_LIMITS.reasonMin) {
      problems.push({
        path: 'overrideReason',
        message:
          shape === 'WHOLE_ACCEPTED'
            ? `The rules say FAIL (${facts.computed.reasons.join(' ')}): accepting the whole lot over it needs your written reason.`
            : 'The rules say PASS: rejecting the whole lot over it needs your written reason.',
      })
    }
  } else if (reason) {
    problems.push({ path: 'overrideReason', message: 'A reason is written only when the whole lot is decided against the rules’ result; a split never has one.' })
  }
  if (reason.length > INCOMING_LIMITS.reason) problems.push({ path: 'overrideReason', message: `At most ${INCOMING_LIMITS.reason} characters.` })
  if ((draft.note ?? '').length > INCOMING_LIMITS.note) problems.push({ path: 'note', message: `At most ${INCOMING_LIMITS.note} characters.` })
  return problems
}

/** Why an inspection is cancelled: at least a few words. */
export function cancelReasonProblem(reason: string | null | undefined): Issue | null {
  const text = reason?.trim() ?? ''
  if (text.length < INCOMING_LIMITS.reasonMin) return { path: 'reason', message: `Say why, in at least ${INCOMING_LIMITS.reasonMin} characters.` }
  if (text.length > INCOMING_LIMITS.reason) return { path: 'reason', message: `At most ${INCOMING_LIMITS.reason} characters.` }
  return null
}

// ---- plan check results ----------------------------------------------------------------------------------------------------

export interface ResultDraft {
  readonly planCheckId: string
  readonly sampleIndex?: number | undefined
  readonly outcome: CheckOutcome
  readonly value?: string | null | undefined
  readonly note?: string | null | undefined
}

/** A check of the plan version the inspection runs on, as the rules need it. */
export interface CheckFacts {
  readonly id: string
  readonly code: string
  readonly label: string
  readonly type: string
  readonly checkClass: AqlDefectClass | null
  readonly mandatory: boolean
  /** Decimal text, with the tolerance; null: no nominal. */
  readonly nominal: string | null
  readonly tolerance: string | null
  readonly choices: readonly string[]
}

const MEASURED = /^-?\d{1,9}(\.\d{1,3})?$/

/** The outcome a measurement's numbers give against the check's nominal ± tolerance (null: no nominal). */
export function measuredOutcome(check: Pick<CheckFacts, 'nominal' | 'tolerance'>, value: string): 'PASS' | 'FAIL' | null {
  if (check.nominal === null || check.tolerance === null || !MEASURED.test(value.trim())) return null
  return new Dec(value.trim()).minus(check.nominal).abs().lessThanOrEqualTo(check.tolerance) ? 'PASS' : 'FAIL'
}

/**
 * What is wrong with the plan check results of an inspection (the whole list), in words (paths `results/<i>/<field>`):
 * a check of the frozen version, never an instruction, the unit from 1 up to the sample, each (check, unit) once, a value
 * of the check's type unless not applicable, a measurement's outcome as its numbers give, and a CRITICAL check "not
 * applicable" only with the reason (QHS-002: safety is never skipped in silence).
 */
export function resultProblems(results: readonly ResultDraft[], checks: ReadonlyMap<string, CheckFacts>, sampleSize: number): Issue[] {
  const problems: Issue[] = []
  if (results.length > INCOMING_LIMITS.results) return [{ path: 'results', message: `At most ${INCOMING_LIMITS.results} results.` }]
  const seen = new Set<string>()
  results.forEach((result, index) => {
    const at = `results/${index}`
    const check = checks.get(result.planCheckId)
    const unit = result.sampleIndex ?? 1
    if (!check) {
      problems.push({ path: `${at}/planCheckId`, message: 'Not a check of the plan version this inspection runs on.' })
      return
    }
    if (check.type === 'INSTRUCTION') problems.push({ path: `${at}/planCheckId`, message: `${check.label} is an instruction: it takes no result.` })
    if (!Number.isInteger(unit) || unit < 1 || unit > sampleSize) problems.push({ path: `${at}/sampleIndex`, message: `A unit of the sample: from 1 to ${sampleSize}.` })
    const key = `${check.id}|${unit}`
    if (seen.has(key)) problems.push({ path: `${at}/planCheckId`, message: `${check.label} is answered twice for unit ${unit}.` })
    seen.add(key)
    const value = result.value?.trim() ?? ''
    if (value.length > INCOMING_LIMITS.value) problems.push({ path: `${at}/value`, message: `At most ${INCOMING_LIMITS.value} characters.` })
    if ((result.note ?? '').length > INCOMING_LIMITS.note) problems.push({ path: `${at}/note`, message: `At most ${INCOMING_LIMITS.note} characters.` })
    if (result.outcome === 'NOT_APPLICABLE') {
      if (check.checkClass === 'CRITICAL' && !(result.note ?? '').trim()) problems.push({ path: `${at}/note`, message: `${check.label} is a critical check: say why it does not apply.` })
      return
    }
    if (check.type === 'MEASUREMENT') {
      if (!MEASURED.test(value)) problems.push({ path: `${at}/value`, message: 'A measurement takes its value: a number with at most 3 decimals.' })
      else {
        const given = measuredOutcome(check, value)
        if (given && given !== result.outcome) problems.push({ path: `${at}/outcome`, message: `${value} against ${check.nominal} ± ${check.tolerance} is a ${given}, by the numbers.` })
      }
    } else if (check.type === 'COUNT' && !/^\d{1,9}$/.test(value)) problems.push({ path: `${at}/value`, message: 'A count takes a whole number.' })
    else if (check.type === 'CHOICE' && !check.choices.includes(value)) problems.push({ path: `${at}/value`, message: `Pick one of: ${check.choices.join(', ')}.` })
    else if (check.type === 'FREE_TEXT' && !value) problems.push({ path: `${at}/value`, message: 'Write what was found.' })
  })
  return problems
}

export interface ChecksNow {
  readonly failed: readonly string[]
  readonly failedCritical: readonly string[]
  readonly mandatoryMissing: readonly string[]
}

/**
 * The checks as they stand, as the database reads them: a result or a measurement answers a check; a FAIL result or a
 * measurement out of tolerance fails it; a mandatory check that takes a result and has none is missing.
 */
export function checksNow(checks: readonly CheckFacts[], answers: readonly { readonly planCheckId: string; readonly failed: boolean }[]): ChecksNow {
  const answered = new Set(answers.map((answer) => answer.planCheckId))
  const failedIds = new Set(answers.filter((answer) => answer.failed).map((answer) => answer.planCheckId))
  const failed = checks.filter((check) => failedIds.has(check.id))
  return {
    failed: failed.map((check) => check.label),
    failedCritical: failed.filter((check) => check.checkClass === 'CRITICAL').map((check) => check.label),
    mandatoryMissing: checks.filter((check) => check.mandatory && check.type !== 'INSTRUCTION' && !answered.has(check.id)).map((check) => check.label),
  }
}

// ---- words -----------------------------------------------------------------------------------------------------------------

const countWord = (n: number | string, uom: string, language: 'it' | 'en'): string => {
  const one = String(n) === '1'
  if (uom === 'HIDE') return language === 'it' ? (one ? 'pelle' : 'pelli') : one ? 'hide' : 'hides'
  return language === 'it' ? (one ? 'pezzo' : 'pezzi') : one ? 'unit' : 'units'
}

/** "Inspect 13 of 120 hides · 5 done" (design floor.incoming Sample), in both languages. */
export function sampleWords(sampleSize: number, lotSize: string, uom: string, done: number | null): Words {
  const lot = new Dec(lotSize).toFixed()
  const all = new Dec(lotSize).equals(sampleSize)
  const it = all ? `Controlla tutte le ${lot} ${countWord(lot, uom, 'it')}` : `Controlla ${sampleSize} ${countWord(sampleSize, uom, 'it')} su ${lot}`
  const en = all ? `Inspect all ${lot} ${countWord(lot, uom, 'en')}` : `Inspect ${sampleSize} of ${lot} ${countWord(lot, uom, 'en')}`
  if (done === null) return { it, en }
  return { it: `${it} · ${done} ${done === 1 ? 'fatta' : 'fatte'}`, en: `${en} · ${done} done` }
}

export const NEXT_STEPS = ['RELEASE', 'REJECT', 'SORT', 'RELEASE_PART'] as const
export type NextStep = (typeof NEXT_STEPS)[number]

/**
 * What follows the decision, in words (Owner answer W3: a person with the quality role who types the lot's code releases
 * or rejects it, never the person who received it; the inspection never moves the lot):
 *   RELEASE       the whole lot accepted: the lot release;
 *   REJECT        the whole lot rejected: the lot rejection, and the return to the supplier (the buyer);
 *   SORT          some still to sort: every hide of the rest inspected (a new inspection of the lot) before the release;
 *   RELEASE_PART  accepted and rejected only: the rejected hides held or returned, then the lot release.
 */
export function nextStepOf(quantities: { readonly accepted: string; readonly rejected: string; readonly toSort: string }, lotSize: string): NextStep {
  const lot = new Dec(lotSize)
  if (new Dec(quantities.accepted).equals(lot)) return 'RELEASE'
  if (new Dec(quantities.rejected).equals(lot)) return 'REJECT'
  if (new Dec(quantities.toSort).greaterThan(0)) return 'SORT'
  return 'RELEASE_PART'
}

export function nextWords(step: NextStep, lotCode: string, quantities: { readonly accepted: string; readonly rejected: string; readonly toSort: string }, uom: string): Words {
  const n = (value: string) => new Dec(value).toFixed()
  const [a, r, s] = [n(quantities.accepted), n(quantities.rejected), n(quantities.toSort)]
  // Italian agrees with the count (una pelle accettata, due pelli accettate).
  const agreed = (count: string, one: string, many: string) => (count === '1' ? one : many)
  const typed = { it: `una persona con il ruolo qualità digita il codice del lotto ${lotCode} (mai chi lo ha ricevuto)`, en: `a person with the quality role types the code of lot ${lotCode} (never the person who received it)` }
  switch (step) {
    case 'RELEASE':
      return { it: `Tutto il lotto accettato. Ora ${typed.it} e lo rilascia.`, en: `The whole lot accepted. Next, ${typed.en} to release it.` }
    case 'REJECT':
      return { it: `Tutto il lotto respinto. Ora ${typed.it} e lo respinge; l'ufficio acquisti lo rende al fornitore.`, en: `The whole lot rejected. Next, ${typed.en} to reject it; purchasing returns it to the supplier.` }
    case 'SORT':
      return {
        it: `${a} ${countWord(a, uom, 'it')} ${agreed(a, 'accettata', 'accettate')}, ${r} ${agreed(r, 'respinta', 'respinte')}, ${s} da selezionare: si controllano una per una in una nuova ispezione del lotto prima del rilascio.`,
        en: `${a} accepted, ${r} rejected, ${s} ${countWord(s, uom, 'en')} to sort: inspect them one by one in a new inspection of the lot before it is released.`,
      }
    default:
      return {
        it: `${a} ${countWord(a, uom, 'it')} ${agreed(a, 'accettata', 'accettate')}, ${r} ${agreed(r, 'respinta', 'respinte')}: si bloccano o si rendono le respinte, poi ${typed.it} e lo rilascia.`,
        en: `${a} accepted, ${r} rejected: hold or return the rejected ${countWord(r, uom, 'en')}, then ${typed.en} to release it.`,
      }
  }
}

/** The refusal of a second OPEN inspection of a lot, in words (B-W2b-76: the command refuses it under the lot's lock). */
export const secondOpenWords = (lotCode: string, number: string): string => `Lot ${lotCode} has an open incoming inspection already, ${number}: finish or cancel it first.`

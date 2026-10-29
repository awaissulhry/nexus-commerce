import type { Issue } from '../../core/errors'
import { Dec } from '../../tax/decimal'

/**
 * The final inspection of a work order's finished garments (B-W1-45; QHS-013, QHS-050, QHS-058; A1 §2.5 "Final release";
 * design quality.inspections, floor.final): pure rules, figures by hand in final.vitest.test.ts. The database holds the
 * same rules (…_quality_shipping_guards, …_quality_final_release_guards); the API answers with these words first.
 *
 *   the lot and sample   an inspection judges a lot of the work order's FINISHED garments (good at the final operation),
 *                        from 1 up to them; it examines a sample from 1 up to the lot (the lot itself: a 100 %
 *                        inspection) under a sampling plan as the inspector states it in W1 (inspection level, the AQL of
 *                        the major and minor classes, and their acceptance numbers; ISO 2859-1 tables arrive in W2b)
 *   the checklist        the garment and label checks of QHS-050 in four groups (labels, garment, armour, packaging and
 *                        documents), each passed (ok true), failed (ok false, with a note) or not applicable (ok null);
 *                        a decision names every item
 *   the defects          per class and code, the garments of the sample with it (from 1, each class at most the sample)
 *   the computed result  FAIL with any critical defect, more major or minor defective garments than the acceptance
 *                        numbers, or a checklist item not ok; else PASS (QHS-013: the database writes it too)
 *   an override          a decision against the computed result, only with the inspector's written reason: a FAIL over a
 *                        PASS always; a PASS over a FAIL only when the acceptance numbers alone made it fail (never a
 *                        critical defect, never a checklist item not ok). Its releases need a second person (Q1 (a)).
 */

export const INSPECTION_STATUSES = ['OPEN', 'PASSED', 'FAILED', 'CANCELLED'] as const
export type InspectionStatus = (typeof INSPECTION_STATUSES)[number]
export const INSPECTION_RESULTS = ['PASS', 'FAIL'] as const
export type InspectionResult = (typeof INSPECTION_RESULTS)[number]
export const DEFECT_CLASSES = ['CRITICAL', 'MAJOR', 'MINOR'] as const
export type DefectClass = (typeof DEFECT_CLASSES)[number]

export const FINAL_LAW = 'PPE Regulation (EU) 2016/425 arts. 8 and 15; Textile labelling Regulation (EU) 1007/2011 art. 12' as const

export const CHECKLIST_GROUPS = ['LABELS', 'GARMENT', 'ARMOUR', 'PACKAGING'] as const
export type ChecklistGroup = (typeof CHECKLIST_GROUPS)[number]
export const CHECKLIST_GROUP_WORDS: Readonly<Record<ChecklistGroup, string>> = Object.freeze({
  LABELS: 'Labels',
  GARMENT: 'Garment',
  ARMOUR: 'Armour',
  PACKAGING: 'Packaging & documents',
})

/** The garment and label checks of QHS-050, in the floor's four groups (design floor.final). */
export const CHECKLIST_ITEMS = Object.freeze([
  { code: 'EN17092_CLASS_LABEL', group: 'LABELS', words: 'EN 17092 class label matches the certificate class' },
  { code: 'SIZE_LABEL', group: 'LABELS', words: 'Size label' },
  { code: 'CE_MARK', group: 'LABELS', words: 'CE marking' },
  { code: 'CARE_LABEL', group: 'LABELS', words: 'Care label' },
  { code: 'FIBRE_COMPOSITION', group: 'LABELS', words: 'Fibre composition (Reg. 1007/2011 art. 12)' },
  { code: 'ANIMAL_ORIGIN_PHRASE', group: 'LABELS', words: "'Contains non-textile parts of animal origin'" },
  { code: 'ZIPS', group: 'GARMENT', words: 'Zips' },
  { code: 'REFLECTIVES', group: 'GARMENT', words: 'Reflectives' },
  { code: 'ARMOUR_FITTED', group: 'ARMOUR', words: 'Armour fitted, right size, EN 1621 marked' },
  { code: 'HANGTAGS', group: 'PACKAGING', words: 'Hangtags' },
  { code: 'USER_INFORMATION', group: 'PACKAGING', words: "User information in the market's languages" },
  { code: 'PACKAGING', group: 'PACKAGING', words: 'Packaging' },
] as const satisfies readonly { readonly code: string; readonly group: ChecklistGroup; readonly words: string }[])
export const CHECKLIST_CODES = CHECKLIST_ITEMS.map((item) => item.code)
export type ChecklistCode = (typeof CHECKLIST_ITEMS)[number]['code']

/** One checklist answer: passed (true), failed (false: a note says what), not applicable (null). */
export interface ChecklistAnswer {
  readonly code: string
  readonly ok: boolean | null
  readonly note?: string | null | undefined
}

export interface DefectLine {
  readonly defectClass: DefectClass
  /** As the defect list names it ("STITCH-SKIP"): capitals, digits and dashes. */
  readonly code: string
  readonly quantity: number
  readonly workOrderSizeId?: string | null | undefined
  readonly description?: string | null | undefined
  readonly note?: string | null | undefined
}

export interface SamplingPlan {
  readonly lotSize: number
  readonly sampleSize: number
  readonly inspectionLevel: string
  /** Percent, up to three decimals ("2.5"). */
  readonly aqlMajor: string
  readonly aqlMinor: string
  readonly acceptMajor: number
  readonly acceptMinor: number
}

export const NOTE_MAX = 500
export const REASON_MIN = 3
export const REASON_MAX = 500
export const DEFECT_CODE = /^[A-Z0-9][A-Z0-9-]{1,39}$/
/** Defect lines of one inspection. */
export const MAX_DEFECT_LINES = 100

const issue = (path: string, message: string): Issue => ({ path, message })
const isWhole = (value: number, min: number) => Number.isInteger(value) && value >= min

/** A written reason (an override, a cancellation, a reversal): 3 to 500 characters. */
export function reasonProblem(reason: string | null | undefined, path = 'reason'): Issue | null {
  const text = reason?.trim() ?? ''
  if (text.length < REASON_MIN) return issue(path, `Say why, in at least ${REASON_MIN} characters.`)
  if (text.length > REASON_MAX) return issue(path, `At most ${REASON_MAX} characters.`)
  return null
}

/**
 * The sampling plan, every problem at once: the lot from 1 up to the finished garments of the work order (and its
 * pieces), the sample from 1 up to the lot, the acceptance numbers from 0 up to the sample, AQLs from 0 to 100 with at
 * most three decimals, an inspection level.
 */
export function planProblems(plan: SamplingPlan, limits: { readonly pieces: number; readonly finished: number | null }): Issue[] {
  const problems: Issue[] = []
  if (limits.finished === null) {
    problems.push(issue('lotSize', 'The routing has no scanned operation, so no garment is finished yet: the final inspection waits for it.'))
  } else if (!isWhole(plan.lotSize, 1)) {
    problems.push(issue('lotSize', 'The lot is at least one garment.'))
  } else if (plan.lotSize > Math.min(limits.finished, limits.pieces)) {
    problems.push(issue('lotSize', `The lot is at most the ${Math.min(limits.finished, limits.pieces)} finished garment(s) of the work order (good at the final operation).`))
  }
  if (!isWhole(plan.sampleSize, 1)) problems.push(issue('sampleSize', 'The sample is at least one garment.'))
  else if (isWhole(plan.lotSize, 1) && plan.sampleSize > plan.lotSize) problems.push(issue('sampleSize', `The sample is at most the lot (${plan.lotSize}); the whole lot is a 100 % inspection.`))
  for (const [key, value] of [
    ['acceptMajor', plan.acceptMajor],
    ['acceptMinor', plan.acceptMinor],
  ] as const) {
    if (!isWhole(value, 0)) problems.push(issue(key, 'An acceptance number is a whole number from 0.'))
    else if (isWhole(plan.sampleSize, 1) && value > plan.sampleSize) problems.push(issue(key, `An acceptance number is at most the sample (${plan.sampleSize}).`))
  }
  for (const [key, value] of [
    ['aqlMajor', plan.aqlMajor],
    ['aqlMinor', plan.aqlMinor],
  ] as const) {
    if (!/^\d{1,3}(\.\d{1,3})?$/.test(value.trim()) || new Dec(value.trim()).greaterThan(100)) problems.push(issue(key, 'An AQL is a percentage from 0 to 100, at most three decimals ("2.5").'))
  }
  const level = plan.inspectionLevel.trim()
  if (level === '' || level.length > 20) problems.push(issue('inspectionLevel', 'Name the inspection level ("II", "S-3"), at most 20 characters.'))
  return problems
}

/** The AQL as the database keeps it (Decimal(7,3)): "2.500". */
export const aqlText = (value: string): string => new Dec(value.trim()).toFixed(3)

/**
 * The checklist, every problem at once: known codes, each once, a note of at most 500 characters, a note on every failed
 * item; for a decision, every item answered (passed, failed or not applicable).
 */
export function checklistProblems(answers: readonly ChecklistAnswer[], options: { readonly forDecision: boolean }): Issue[] {
  const problems: Issue[] = []
  const seen = new Set<string>()
  answers.forEach((answer, index) => {
    if (!(CHECKLIST_CODES as readonly string[]).includes(answer.code)) problems.push(issue(`checklist/${index}/code`, `Not a check of the final checklist: ${answer.code}.`))
    else if (seen.has(answer.code)) problems.push(issue(`checklist/${index}/code`, `${answer.code} is answered twice.`))
    seen.add(answer.code)
    const note = answer.note?.trim() ?? ''
    if (note.length > NOTE_MAX) problems.push(issue(`checklist/${index}/note`, `At most ${NOTE_MAX} characters.`))
    if (answer.ok === false && note === '') problems.push(issue(`checklist/${index}/note`, 'A failed check says what is wrong.'))
  })
  if (options.forDecision) {
    const missing = CHECKLIST_ITEMS.filter((item) => !seen.has(item.code))
    if (missing.length > 0) problems.push(issue('checklist', `Answer every check before signing (pass, fail or not applicable): ${missing.map((item) => item.words).join(', ')}.`))
  }
  return problems
}

/** The checklist as stored (Inspection.checklist): in the list's order, notes trimmed (null when empty). */
export function checklistOf(answers: readonly ChecklistAnswer[]): { code: string; ok: boolean | null; note: string | null }[] {
  const order = new Map<string, number>(CHECKLIST_CODES.map((code, index) => [code, index]))
  return [...answers]
    .sort((a, b) => (order.get(a.code) ?? 99) - (order.get(b.code) ?? 99))
    .map((answer) => ({ code: answer.code, ok: answer.ok, note: answer.note?.trim() ? answer.note.trim() : null }))
}

/** The defect lines, every problem at once (the cells are the work order's). */
export function defectProblems(lines: readonly DefectLine[], context: { readonly sampleSize: number; readonly cellIds: ReadonlySet<string> }): Issue[] {
  const problems: Issue[] = []
  if (lines.length > MAX_DEFECT_LINES) problems.push(issue('defects', `At most ${MAX_DEFECT_LINES} defect lines.`))
  const seen = new Set<string>()
  const perClass = new Map<DefectClass, number>()
  lines.forEach((line, index) => {
    const at = `defects/${index}`
    if (!DEFECT_CODE.test(line.code)) problems.push(issue(`${at}/code`, 'A defect code is 2 to 40 capitals, digits or dashes ("STITCH-SKIP").'))
    const key = `${line.defectClass}|${line.code}`
    if (seen.has(key)) problems.push(issue(`${at}/code`, `${line.defectClass.toLowerCase()} ${line.code} is listed twice: one line per class and code.`))
    seen.add(key)
    if (!isWhole(line.quantity, 1)) problems.push(issue(`${at}/quantity`, 'A defect is found on at least one garment.'))
    else if (line.quantity > context.sampleSize) problems.push(issue(`${at}/quantity`, `At most the sample (${context.sampleSize}).`))
    if (line.workOrderSizeId && !context.cellIds.has(line.workOrderSizeId)) problems.push(issue(`${at}/workOrderSizeId`, 'Not a cell of this work order.'))
    for (const field of ['description', 'note'] as const) {
      if ((line[field]?.trim().length ?? 0) > NOTE_MAX) problems.push(issue(`${at}/${field}`, `At most ${NOTE_MAX} characters.`))
    }
    if (isWhole(line.quantity, 1)) perClass.set(line.defectClass, (perClass.get(line.defectClass) ?? 0) + line.quantity)
  })
  for (const [defectClass, garments] of perClass) {
    if (garments > context.sampleSize) problems.push(issue('defects', `${garments} garments with a ${defectClass.toLowerCase()} defect is more than the sample of ${context.sampleSize}.`))
  }
  return problems
}

export interface DefectCounts {
  readonly critical: number
  readonly major: number
  readonly minor: number
}

export function defectCounts(lines: readonly Pick<DefectLine, 'defectClass' | 'quantity'>[]): DefectCounts {
  const sum = (defectClass: DefectClass) => lines.filter((line) => line.defectClass === defectClass).reduce((total, line) => total + line.quantity, 0)
  return { critical: sum('CRITICAL'), major: sum('MAJOR'), minor: sum('MINOR') }
}

export interface ComputedResult {
  readonly result: InspectionResult
  /** Why it fails (empty for a PASS), in words; `byCountsOnly`: only the acceptance numbers made it fail. */
  readonly reasons: readonly string[]
  readonly byCountsOnly: boolean
}

/** The result the rules give (QHS-013), as the database computes it. */
export function computedResult(input: { readonly counts: DefectCounts; readonly plan: Pick<SamplingPlan, 'acceptMajor' | 'acceptMinor'>; readonly checklist: readonly Pick<ChecklistAnswer, 'code' | 'ok'>[] }): ComputedResult {
  const { counts, plan } = input
  const hard: string[] = []
  const soft: string[] = []
  if (counts.critical > 0) hard.push(`${counts.critical} garment(s) with a critical defect: a critical defect is never accepted.`)
  const failed = input.checklist.filter((answer) => answer.ok === false).map((answer) => CHECKLIST_ITEMS.find((item) => item.code === answer.code)?.words ?? answer.code)
  if (failed.length > 0) hard.push(`Checks not ok: ${failed.join(', ')}.`)
  if (counts.major > plan.acceptMajor) soft.push(`${counts.major} garment(s) with a major defect; the plan accepts ${plan.acceptMajor}.`)
  if (counts.minor > plan.acceptMinor) soft.push(`${counts.minor} garment(s) with a minor defect; the plan accepts ${plan.acceptMinor}.`)
  const reasons = [...hard, ...soft]
  return { result: reasons.length === 0 ? 'PASS' : 'FAIL', reasons, byCountsOnly: hard.length === 0 && soft.length > 0 }
}

/** The computed result in one sentence. */
export function resultWords(computed: ComputedResult): string {
  return computed.result === 'PASS' ? 'PASS: no critical defect, majors and minors within the acceptance numbers, every check ok.' : `FAIL: ${computed.reasons.join(' ')}`
}

/**
 * The decision against the computed result (QHS-013): the same, without a reason; another only with the inspector's
 * written reason, and a PASS over a FAIL only when the acceptance numbers alone made it fail.
 */
export function decisionProblems(decision: InspectionResult, computed: ComputedResult, overrideReason: string | null | undefined): Issue[] {
  const reason = overrideReason?.trim() ?? ''
  if (decision === computed.result) return reason === '' ? [] : [issue('overrideReason', `The result is ${decision} as computed: no override reason.`)]
  if (decision === 'PASS' && !computed.byCountsOnly) {
    return [issue('result', `A PASS over this FAIL is never signed: ${computed.reasons.join(' ')}`)]
  }
  const problem = reasonProblem(overrideReason, 'overrideReason')
  return problem ? [{ ...problem, message: `The rules say ${computed.result}: a ${decision} over it is an override with your written reason (QHS-013). ${problem.message}` }] : []
}

/** A decision is an override when it differs from the computed result. */
export const isOverride = (decision: InspectionResult, computed: Pick<ComputedResult, 'result'>): boolean => decision !== computed.result

/**
 * How an inspection is named: its own number (INS-2026-0412, its company's INSPECTION series), or, for one opened before
 * the series existed (W1 history, no number), its place among its work order's inspections: "WO-0003 · inspection 2".
 */
export const inspectionLabel = (workOrderNumber: string, seq: number, number: string | null = null): string => number ?? `${workOrderNumber} · inspection ${seq}`

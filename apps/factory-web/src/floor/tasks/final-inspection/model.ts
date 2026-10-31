import { CHECKLIST_GROUPS, CHECKLIST_ITEMS, type ChecklistCode, type ChecklistGroup, type DefectClass } from '@nexus/factory-domain/quality/final/rules'
import type { ReleaseCheckCode } from '@nexus/factory-domain/quality/release/rules'

/**
 * The final inspection bench's rules that need no screen and no API (SCR-097; design floor.final; QHS-050, QHS-058;
 * Owner answers Q1 (a), F1): the checklist in its four groups and what one tap does to it, the suggested sampling plan
 * the inspector checks before opening, the defect a failed check records, what the release of a cell may ask, and
 * which step comes next. Pure, so the tests hold them. The API decides every rule again.
 */

export { CHECKLIST_GROUPS, type ChecklistCode, type ChecklistGroup }

export interface Answer {
  readonly code: string
  readonly ok: boolean | null
  readonly note: string | null
}

/** The checks of a group, in the list's order. */
export const itemsOf = (group: ChecklistGroup): ChecklistCode[] => CHECKLIST_ITEMS.filter((item) => item.group === group).map((item) => item.code)

export const groupOf = (code: string): ChecklistGroup | null => CHECKLIST_ITEMS.find((item) => item.code === code)?.group ?? null

export type GroupState = 'open' | 'partly' | 'passed' | 'failed'

/** A group: every check passed or not applicable (passed), one failed (failed), some answered (partly), none (open). */
export function groupState(checklist: readonly Answer[], group: ChecklistGroup): GroupState {
  const items = itemsOf(group)
  const answers = items.map((code) => checklist.find((answer) => answer.code === code))
  if (answers.some((answer) => answer?.ok === false)) return 'failed'
  const answered = answers.filter((answer) => answer !== undefined).length
  if (answered === items.length) return 'passed'
  return answered === 0 ? 'open' : 'partly'
}

/** Groups with every check answered (passed or failed): "2 of 4 groups". */
export function groupsDone(checklist: readonly Answer[]): number {
  return CHECKLIST_GROUPS.filter((group) => itemsOf(group).every((code) => checklist.some((answer) => answer.code === code))).length
}

/** Every check answered: the inspection may be signed. */
export const checklistComplete = (checklist: readonly Answer[]): boolean => groupsDone(checklist) === CHECKLIST_GROUPS.length

/** The first group with a check left to answer, else the last one. */
export function nextGroup(checklist: readonly Answer[]): ChecklistGroup {
  return CHECKLIST_GROUPS.find((group) => itemsOf(group).some((code) => !checklist.some((answer) => answer.code === code))) ?? CHECKLIST_GROUPS[CHECKLIST_GROUPS.length - 1]!
}

/** The checklist in the list's order, one answer per check. */
function ordered(answers: readonly Answer[]): Answer[] {
  const order = new Map<string, number>(CHECKLIST_ITEMS.map((item, index) => [item.code, index]))
  const byCode = new Map(answers.map((answer) => [answer.code, answer]))
  return [...byCode.values()].sort((a, b) => (order.get(a.code) ?? 99) - (order.get(b.code) ?? 99))
}

/** "Group passes" (one tap after looking): every check of the group not answered yet passes; a failed one stays failed. */
export function passGroup(checklist: readonly Answer[], group: ChecklistGroup): Answer[] {
  const next = [...checklist]
  for (const code of itemsOf(group)) if (!next.some((answer) => answer.code === code)) next.push({ code, ok: true, note: null })
  return ordered(next)
}

/** One check passed (a failed one passes again: its note goes). */
export function passItem(checklist: readonly Answer[], code: string): Answer[] {
  return ordered([...checklist.filter((answer) => answer.code !== code), { code, ok: true, note: null }])
}

/** One check failed with what is wrong (a failed check says what: QHS-050). */
export function failItem(checklist: readonly Answer[], code: string, note: string): Answer[] {
  return ordered([...checklist.filter((answer) => answer.code !== code), { code, ok: false, note }])
}

// ---- what a failed check records (W1: a short reason list per group; a customer's defect list with classes is W2b) ----

export interface FailReason {
  readonly code: string
  readonly group: ChecklistGroup
  /** The defect class it is recorded in. W1 records every reason as MAJOR: any failed check fails the inspection anyway. */
  readonly defectClass: DefectClass
}

export const FAIL_REASONS: readonly FailReason[] = [
  { code: 'LABEL-MISSING', group: 'LABELS', defectClass: 'MAJOR' },
  { code: 'LABEL-WRONG', group: 'LABELS', defectClass: 'MAJOR' },
  { code: 'LABEL-UNREADABLE', group: 'LABELS', defectClass: 'MAJOR' },
  { code: 'STITCHING', group: 'GARMENT', defectClass: 'MAJOR' },
  { code: 'ZIP-FAULT', group: 'GARMENT', defectClass: 'MAJOR' },
  { code: 'REFLECTIVE-FAULT', group: 'GARMENT', defectClass: 'MAJOR' },
  { code: 'MATERIAL-DAMAGE', group: 'GARMENT', defectClass: 'MAJOR' },
  { code: 'ARMOUR-MISSING', group: 'ARMOUR', defectClass: 'MAJOR' },
  { code: 'ARMOUR-WRONG-SIZE', group: 'ARMOUR', defectClass: 'MAJOR' },
  { code: 'ARMOUR-UNMARKED', group: 'ARMOUR', defectClass: 'MAJOR' },
  { code: 'HANGTAG-MISSING', group: 'PACKAGING', defectClass: 'MAJOR' },
  { code: 'LEAFLET-MISSING', group: 'PACKAGING', defectClass: 'MAJOR' },
  { code: 'PACKAGING-DAMAGED', group: 'PACKAGING', defectClass: 'MAJOR' },
]

export const reasonsOf = (group: ChecklistGroup): FailReason[] => FAIL_REASONS.filter((reason) => reason.group === group)

export interface DefectLine {
  readonly defectClass: DefectClass
  readonly code: string
  readonly quantity: number
}

/**
 * The defect lines after a failed check with this reason: the reason's line counts one garment more (at most the sample),
 * every other line as it was (PUT …/defects sends the whole list).
 */
export function withDefect(lines: readonly DefectLine[], reason: FailReason, sampleSize: number): DefectLine[] {
  const found = lines.find((line) => line.code === reason.code && line.defectClass === reason.defectClass)
  if (!found) return [...lines, { defectClass: reason.defectClass, code: reason.code, quantity: 1 }]
  return lines.map((line) => (line === found ? { ...line, quantity: Math.min(sampleSize, line.quantity + 1) } : line))
}

/** The defect lines after a failed check passes again: its reason's line counts one garment less (gone at zero). */
export function withoutDefect(lines: readonly DefectLine[], reason: FailReason): DefectLine[] {
  return lines.flatMap((line) => (line.code === reason.code && line.defectClass === reason.defectClass ? (line.quantity > 1 ? [{ ...line, quantity: line.quantity - 1 }] : []) : [line]))
}

/** A failed check's note: what is wrong in the person's words, with the reason's code (the office reads both). */
export const noteOf = (words: string, code: string): string => `${words} (${code})`

/** The reason a failed check's note names, or null (a note written elsewhere). */
export function reasonOfNote(note: string | null | undefined): FailReason | null {
  const code = /\(([A-Z0-9-]+)\)$/.exec(note?.trim() ?? '')?.[1]
  return FAIL_REASONS.find((reason) => reason.code === code) ?? null
}

// ---- the sampling plan (W1: the inspector states it; ISO 2859-1 tables are W2b) -------------------------------------------

export interface Plan {
  readonly lotSize: number
  readonly sampleSize: number
  readonly inspectionLevel: string
  readonly aqlMajor: string
  readonly aqlMinor: string
  readonly acceptMajor: number
  readonly acceptMinor: number
}

/** What the bench may change: the lot and the acceptance numbers. The sample is always the whole lot on the floor in W1. */
export const PLAN_FIELDS = ['lotSize', 'acceptMajor', 'acceptMinor'] as const
export type PlanField = (typeof PLAN_FIELDS)[number]

/** The lot the bench suggests: the work order's finished garments not yet released (at least one), at most its pieces. */
export function suggestedLot(order: { readonly finished: number | null; readonly released: number; readonly pieces: number }): number {
  const finished = order.finished ?? 0
  return Math.max(1, Math.min(order.pieces, finished) - order.released)
}

/**
 * The plan the bench starts from: EVERY garment of the lot, no defect accepted (the strictest plan; no table claimed).
 * W1 has no ISO 2859-1 tables (W2b): the inspector states the customer's plan by changing the numbers before opening.
 */
export function suggestedPlan(lotSize: number): Plan {
  return { lotSize, sampleSize: lotSize, inspectionLevel: '100%', aqlMajor: '0', aqlMinor: '0', acceptMajor: 0, acceptMinor: 0 }
}

/** A plan after one number changed: the sample stays within the lot, the acceptance numbers within the sample. */
export function withPlanValue(plan: Plan, field: PlanField, value: number): Plan {
  const next = { ...plan, [field]: Math.max(field === 'lotSize' ? 1 : 0, Math.round(value)) }
  // The floor checks every garment of the lot (the AQL sample is W2b): the sample follows the lot.
  const sampleSize = next.lotSize
  return { ...next, sampleSize, acceptMajor: Math.min(next.acceptMajor, sampleSize), acceptMinor: Math.min(next.acceptMinor, sampleSize) }
}

/** The bounds of a plan number on the pad. */
export function planBounds(plan: Plan, field: PlanField, maxLot: number): { min: number; max: number } {
  switch (field) {
    case 'lotSize':
      return { min: 1, max: Math.max(1, maxLot) }
    default:
      return { min: 0, max: plan.sampleSize }
  }
}

// ---- the release ------------------------------------------------------------------------------------------------------------

export interface Check {
  readonly code: ReleaseCheckCode
  readonly state: 'OK' | 'OPEN' | 'NOT_NEEDED'
  readonly message: string
  readonly fix: string | null
}

export const openOf = (checks: readonly Check[]): Check[] => checks.filter((check) => check.state === 'OPEN')

/** What holds Release of a cell for this person, first match: no right, the maker check, the checks open, nothing to release. */
export type ReleaseHeld = 'offline' | 'noRight' | 'maker' | 'checks' | 'nothing' | null

export function releaseHeld(input: { readonly online: boolean; readonly mayRelease: boolean; readonly made: boolean; readonly checks: readonly Check[]; readonly releasable: number }): ReleaseHeld {
  if (!input.mayRelease) return 'noRight'
  if (input.made) return 'maker'
  if (input.releasable <= 0) return openOf(input.checks).length > 0 ? 'checks' : 'nothing'
  if (openOf(input.checks).some((check) => check.code !== 'QUANTITY')) return 'checks'
  if (!input.online) return 'offline'
  return null
}

/** The LABELS check is what still holds the cell, and this person may print them here. */
export const labelsToPrint = (checks: readonly Check[], mayPrint: boolean): boolean => mayPrint && checks.some((check) => check.code === 'LABELS' && check.state === 'OPEN')

// ---- which step the bench shows ---------------------------------------------------------------------------------------------------

export interface Situation {
  /** The OPEN inspection of the work order, and whether it is the viewer's. */
  readonly open: { readonly yours: boolean } | null
  /** The newest PASSED inspection with garments to release. */
  readonly passed: boolean
  readonly made: boolean
}

/** What the work order's main action is: continue my inspection, start one, release, or nothing (another's is open). */
export type MainAction = 'continue' | 'start' | 'release' | 'othersOpen' | 'maker' | null

export function mainAction(situation: Situation, can: { readonly record: boolean; readonly release: boolean }): MainAction {
  if (situation.open?.yours) return can.record ? 'continue' : null
  if (situation.passed && can.release) return situation.made ? 'maker' : 'release'
  if (situation.open) return 'othersOpen'
  if (!can.record) return null
  return situation.made ? 'maker' : 'start'
}

// ---- Hold lot at the bench (B-W2a-75; design floor.final "Hold lot (secondary): a reason, and an NCR") ----------------------

/** What holds Hold lot for this person, first match: no network, no right to record, the lot is on hold already. */
export type HoldHeld = 'offline' | 'noRight' | 'already' | null

export function holdHeld(input: { readonly online: boolean; readonly mayRecord: boolean; readonly holds: number }): HoldHeld {
  if (!input.mayRecord) return 'noRight'
  if (input.holds > 0) return 'already'
  if (!input.online) return 'offline'
  return null
}

/** The garments held (the NCR's quantity): the open inspection's lot, else the finished garments not yet released. */
export function holdQuantity(open: { readonly lotSize: number } | null, order: { readonly finished: number | null; readonly released: number; readonly pieces: number }): number {
  return open ? Math.max(1, open.lotSize) : suggestedLot(order)
}

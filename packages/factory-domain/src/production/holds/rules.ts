import type { Issue } from '../../core/errors'
import type { ReasonList } from '../../reasons/lists'
import type { WorkOrderStatus } from '../work-orders/machine'
import { HOLD_BRAND_WORDS_MAX, HOLD_LIFT_REASON_MAX, HOLD_NOTE_MAX, PRODUCTION_HOLD_LIST } from './kinds'

/**
 * B-PR-21 (production plan §5 "holds (one dialog)", 08-backend §4.5; R-22 "two hold buttons" → one dialog): the plain production
 * hold's rules, pure. apps/factory-api's modules/production/holds places and lifts it (one command each); quality keeps its own
 * holds (quality/holds/rules) and both lift a work order through ONE rule here (`afterHoldEnds`).
 *
 *   one dialog     the office's "Put on hold" (the work order record and the list's Hold N) offers the reasons of TWO lists; the
 *                  list the picked reason comes from decides the kind: a HOLD reason places today's quality hold (/quality/holds),
 *                  a PRODUCTION_HOLD reason a WorkOrderHold of kind PRODUCTION (/production/work-orders/…/holds) (`holdKindOfList`).
 *   place          a code of the PRODUCTION_HOLD list (A-Z, 0-9, _; at most 40), the office's note (at most 2000; never the
 *                  floor's or the customer's to read), the words the customer reads (one line, at most 500; none: the reason's
 *                  words), on an open work order: DRAFT, RELEASED or IN_PROGRESS go ON_HOLD, one ON_HOLD already stays held under
 *                  the record it has; a COMPLETED one has no work left to stop (its garments take a quality hold); CLOSED and
 *                  CANCELLED are final (`productionHoldMove`).
 *   lift           why, in one line of at most 500 (`liftProblems`).
 *   after a hold   (quality's release or close, a production lift) the work order leaves ON_HOLD only when NO hold names it any
 *                  more — no ACTIVE quality hold of the work order and no ACTIVE WorkOrderHold; else it stays held under the oldest
 *                  hold still standing (`afterHoldEnds`). A record of another kind (an NCR) lifts its own.
 *   the customer   reads "On hold" and `customerWordsOf`: the words meant for it, else the reason's words — never the office's note.
 */

/** The kinds the one "Put on hold" dialog places: today's quality hold, or the plain production hold. */
export const HOLD_DIALOG_KINDS = ['QUALITY', 'PRODUCTION'] as const
export type HoldDialogKind = (typeof HOLD_DIALOG_KINDS)[number]

/** The reason list each kind of the dialog offers (reasons/lists). */
export const HOLD_DIALOG_LISTS: Readonly<Record<HoldDialogKind, ReasonList>> = Object.freeze({ QUALITY: 'HOLD', PRODUCTION: PRODUCTION_HOLD_LIST })

/** The one dialog's rule: the list of the picked reason decides the kind (null: not a list the dialog offers). */
export function holdKindOfList(list: string): HoldDialogKind | null {
  return HOLD_DIALOG_KINDS.find((kind) => HOLD_DIALOG_LISTS[kind] === list) ?? null
}

/** A reason code as the database keeps it (WorkOrderHold_guard): A-Z first, then A-Z, 0-9 or _, at most 40. */
export const HOLD_REASON_CODE = /^[A-Z][A-Z0-9_]{0,39}$/

/** Words the database refuses: blank, too long, or (one line) with a line break. */
const lineProblem = (value: string, max: number): string | null => {
  if (value.trim() === '') return 'Write the words, or leave the field out.'
  if (value.length > max) return `At most ${max} characters.`
  if (/[\r\n]/.test(value)) return 'One line, without line breaks.'
  return null
}

export interface PlaceDraft {
  readonly reasonCode: string
  readonly note?: string | null | undefined
  readonly brandWords?: string | null | undefined
}

/** What is wrong with a hold before it is placed (paths are the body's fields). The reason's list is the API's to check. */
export function placeProblems(draft: PlaceDraft): Issue[] {
  const problems: Issue[] = []
  if (!HOLD_REASON_CODE.test(draft.reasonCode)) problems.push({ path: 'reasonCode', message: 'Pick a reason of the production hold list.' })
  const note = draft.note ?? null
  if (note !== null && note.trim() !== '' && note.length > HOLD_NOTE_MAX) problems.push({ path: 'note', message: `At most ${HOLD_NOTE_MAX} characters.` })
  const words = draft.brandWords ?? null
  if (words !== null && words.trim() !== '') {
    const problem = lineProblem(words, HOLD_BRAND_WORDS_MAX)
    if (problem) problems.push({ path: 'brandWords', message: problem })
  }
  return problems
}

/** What is wrong with a lift's reason (one line, at most 500; it is required). */
export function liftProblems(draft: { readonly reason?: string | null | undefined }): Issue[] {
  const reason = draft.reason ?? ''
  if (reason.trim() === '') return [{ path: 'reason', message: 'Say why the hold is lifted.' }]
  const problem = lineProblem(reason.trim(), HOLD_LIFT_REASON_MAX)
  return problem ? [{ path: 'reason', message: problem }] : []
}

/** Trimmed, or null when blank (the database keeps no blank words). */
export const wordsOrNull = (value: string | null | undefined): string | null => (value?.trim() ? value.trim() : null)

export type ProductionHoldMove = 'HOLD' | 'ALREADY' | 'REFUSED'

/** What placing a production hold does to a work order of this status. */
export function productionHoldMove(status: WorkOrderStatus): ProductionHoldMove {
  if (status === 'DRAFT' || status === 'RELEASED' || status === 'IN_PROGRESS') return 'HOLD'
  if (status === 'ON_HOLD') return 'ALREADY'
  return 'REFUSED'
}

/** Why a work order of this status takes no production hold, in words (null: it takes one). */
export function unholdableWords(number: string, status: WorkOrderStatus): string | null {
  if (productionHoldMove(status) !== 'REFUSED') return null
  if (status === 'COMPLETED') return `Work order ${number} is completed: no work is left to stop. Hold its garments with a quality hold instead.`
  return `Work order ${number} is ${status.toLowerCase()}: nothing is left to hold.`
}

/** The words a customer reads beside "On hold": the words meant for it, else the reason's words. Never the office's note. */
export function customerWordsOf(hold: { readonly brandWords: string | null }, reasonWords: string): string {
  return hold.brandWords?.trim() ? hold.brandWords.trim() : reasonWords
}

// ---- after a hold ends: one rule for quality's release / close and the production lift ---------------------------------

/** The two kinds of hold record a work order ON_HOLD names (WorkOrder.holdRecordType). */
export const HOLD_RECORD_TYPES = ['QualityHold', 'WorkOrderHold'] as const
export type HoldRecordType = (typeof HOLD_RECORD_TYPES)[number]

/** A hold still standing on the work order: an ACTIVE quality hold of it, or an ACTIVE WorkOrderHold. */
export interface StandingHold {
  readonly recordType: HoldRecordType
  readonly id: string
  /** The words the work order shows while held under it (WorkOrder.holdReason; the floor reads them). */
  readonly reason: string
  readonly placedAt: Date
}

export type AfterHoldEnds =
  /** It is not ON_HOLD, or it stays held under the record it has (a standing hold, or a record of another kind: an NCR). */
  | { readonly action: 'STAY' }
  /** It stays ON_HOLD under the oldest hold still standing: its record and reason put right. */
  | { readonly action: 'REPOINT'; readonly to: StandingHold }
  /** No hold names it any more: back to the status it was held from. */
  | { readonly action: 'LIFT' }

/**
 * What a held work order does once a hold of it ended (released, closed or lifted): `standing` is every hold still standing on it
 * (the ended one is left out here whatever the caller passed).
 */
export function afterHoldEnds(input: {
  readonly workOrder: { readonly status: string; readonly holdRecordType: string | null; readonly holdRecordId: string | null }
  readonly ended: { readonly recordType: HoldRecordType; readonly id: string }
  readonly standing: readonly StandingHold[]
}): AfterHoldEnds {
  const { workOrder, ended } = input
  if (workOrder.status !== 'ON_HOLD') return { action: 'STAY' }
  const ours = workOrder.holdRecordType === null || (HOLD_RECORD_TYPES as readonly string[]).includes(workOrder.holdRecordType)
  // ON_HOLD under a record of another kind (an NCR): that record lifts it.
  if (!ours) return { action: 'STAY' }
  const standing = input.standing
    .filter((hold) => !(hold.recordType === ended.recordType && hold.id === ended.id))
    .sort((x, y) => x.placedAt.getTime() - y.placedAt.getTime() || x.id.localeCompare(y.id))
  if (standing.length === 0) return { action: 'LIFT' }
  const named = standing.some((hold) => hold.recordType === workOrder.holdRecordType && hold.id === workOrder.holdRecordId)
  return named ? { action: 'STAY' } : { action: 'REPOINT', to: standing[0]! }
}

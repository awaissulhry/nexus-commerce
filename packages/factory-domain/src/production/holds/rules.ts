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

// ---- B-OO-005 (order overview N6, F13, F16; 13-backend §5): "Hold the whole order" — the ONE plan, imported by the web -----

/** Words in both languages of the office (tu). */
export interface HoldPlanWords {
  readonly it: string
  readonly en: string
}

/** One work order of the order as the office's production read sends it (`work.workOrders[]`). */
export interface OrderHoldWorkOrder {
  readonly id: string
  readonly number: string
  readonly status: string
  /** Its version read: the bulk hold sends it back (stale: refused, nothing held). */
  readonly version: number
  /** It also makes other customers' work (made before the one-customer rule): changed on its own page only. */
  readonly sharedWithOtherCustomers: boolean
  /** The reader's right to hold it (can() over its company, site and customer; false for a shared one). */
  readonly rights: { readonly hold: boolean }
}

export interface OrderHoldPlanInput {
  readonly workOrders: readonly OrderHoldWorkOrder[]
  /** Live work orders of the order's lines the reader does not reach (`work.workOrdersLeftOut`): counted, never named. */
  readonly workOrdersLeftOut?: number | undefined
  /** The order waits for a yes (PENDING_APPROVAL): nothing is in work until then. */
  readonly waitingForYes?: boolean | undefined
}

/** Why "Hold the whole order…" is held (no work order to hold), as a code the web may key on, and its words. */
export const ORDER_HOLD_HELD = ['WAITING_FOR_YES', 'NONE_YET', 'NONE_REACHED', 'NO_RIGHT', 'ALL_DONE', 'ALL_ON_HOLD', 'NONE_HOLDABLE'] as const
export type OrderHoldHeld = (typeof ORDER_HOLD_HELD)[number]

export interface OrderHoldPlan {
  /** The work orders the bulk hold places one production (or quality) hold on, in the read's order. */
  readonly ids: readonly string[]
  /** Their numbers, in the same order (the one Hold dialog names them). */
  readonly numbers: readonly string[]
  /** Their versions read: the body's `versions` (POST /production/work-orders/holds), always sent. */
  readonly versions: Readonly<Record<string, number>>
  /** The reached work orders left out, each by its number with why (a shared one: hold it on its page). A cancelled one is no work. */
  readonly left: readonly { readonly id: string; readonly number: string; readonly words: HoldPlanWords }[]
  /** Live work orders the reader does not reach: counted here, never named (F13: not the shared ones). */
  readonly notReached: number
  /** Nothing to hold: why, in words (null: `ids` holds at least one). */
  readonly held: { readonly code: OrderHoldHeld; readonly words: HoldPlanWords } | null
}

/** F13: a shared work order is reached and named, and held from its own page only (its other customers' cells). */
export const SHARED_HOLD_WORDS: HoldPlanWords = Object.freeze({ it: 'Condiviso con altri clienti: mettilo in sospeso dalla sua pagina.', en: 'Shared with other customers: hold it on its page.' })

const LEFT_WORDS: Readonly<Record<'ON_HOLD' | 'COMPLETED' | 'CLOSED' | 'NO_RIGHT', HoldPlanWords>> = Object.freeze({
  ON_HOLD: { it: 'Già in sospeso.', en: 'On hold already.' },
  COMPLETED: { it: 'Completato: non resta lavoro da fermare. Metti invece i suoi capi in blocco qualità.', en: 'Completed: no work is left to stop. Hold its garments with a quality hold instead.' },
  CLOSED: { it: 'Chiuso: non resta niente da fermare.', en: 'Closed: nothing is left to hold.' },
  NO_RIGHT: { it: 'Non puoi metterlo in sospeso: lo fa la Produzione.', en: 'Not yours to hold: Production puts work orders on hold.' },
})

/** The held words of each code; NONE_REACHED counts the work orders the reader does not reach (never names them). */
export function orderHoldHeldWords(code: OrderHoldHeld, notReached = 0): HoldPlanWords {
  switch (code) {
    case 'WAITING_FOR_YES':
      return { it: "L'ordine aspetta un sì: fino ad allora non c'è niente in lavorazione.", en: 'The order waits for a yes: nothing is in work until then.' }
    case 'NONE_YET':
      return { it: 'Ancora niente da fermare: nessun ordine di lavoro è stato creato per questo ordine.', en: 'Nothing to hold yet: no work order is made for this order.' }
    case 'NONE_REACHED':
      return notReached === 1
        ? { it: '1 ordine di lavoro di questo ordine non ti è visibile: chiedi alla Produzione di metterlo in sospeso.', en: '1 work order of this order is not shown to you: ask Production to hold it.' }
        : { it: `${notReached} ordini di lavoro di questo ordine non ti sono visibili: chiedi alla Produzione di metterli in sospeso.`, en: `${notReached} work orders of this order are not shown to you: ask Production to hold them.` }
    case 'NO_RIGHT':
      return { it: 'Non puoi mettere in sospeso gli ordini di lavoro: lo fa la Produzione.', en: 'You may not put work orders on hold: Production does this.' }
    case 'ALL_DONE':
      return { it: 'Ogni ordine di lavoro di questo ordine è completato: non resta lavoro da fermare. Metti invece i capi in blocco qualità.', en: 'Every work order of this order is completed: no work is left to stop. Hold its garments with a quality hold instead.' }
    case 'ALL_ON_HOLD':
      return { it: 'Ogni ordine di lavoro aperto di questo ordine è già in sospeso.', en: 'Every open work order of this order is on hold already.' }
    case 'NONE_HOLDABLE':
      return { it: 'Nessun ordine di lavoro di questo ordine si mette in sospeso da qui: ognuno dice perché.', en: 'No work order of this order is held from here: each one says why.' }
  }
}

const DONE: readonly string[] = ['COMPLETED', 'CLOSED']

/**
 * "Hold the whole order…" (the order's own move, F-OO-108): which of the order's work orders the ONE Hold dialog holds, and which
 * it leaves out with why. Pure; the web imports it (no web copy) with the production read's work orders and its count of those
 * the reader does not reach.
 *
 *   holds       every reached work order that is not shared, open (DRAFT, RELEASED, IN_PROGRESS: `productionHoldMove` HOLD) and
 *               the reader's to hold (`rights.hold`), with its version (the bulk hold always sends them: F16)
 *   left out    (F13, two cases, two sets of words) a SHARED one is reached and named: "hold it on its page"; one ON_HOLD already,
 *               completed or closed, or not the reader's to hold is named with why; a cancelled one is no work (not named)
 *   not reached counted, never named (`notReached`)
 *   held        nothing to hold, first match: the order waits for a yes · no work order is made yet · none is reached · the reader
 *               holds none of them (Production does) · the rest is not reached (counted) · every one is completed · every open one
 *               is on hold already · none from here
 */
export function orderHoldPlanOf(input: OrderHoldPlanInput): OrderHoldPlan {
  const notReached = Math.max(0, input.workOrdersLeftOut ?? 0)
  const heldPlan = (code: OrderHoldHeld, left: OrderHoldPlan['left'] = []): OrderHoldPlan => ({ ids: [], numbers: [], versions: {}, left, notReached, held: { code, words: orderHoldHeldWords(code, notReached) } })
  if (input.waitingForYes) return heldPlan('WAITING_FOR_YES')
  const live = input.workOrders.filter((workOrder) => workOrder.status !== 'CANCELLED')
  if (live.length === 0) return heldPlan(notReached === 0 ? 'NONE_YET' : 'NONE_REACHED')

  const ids: string[] = []
  const numbers: string[] = []
  const versions: Record<string, number> = {}
  const left: { id: string; number: string; words: HoldPlanWords }[] = []
  for (const workOrder of live) {
    const leave = (words: HoldPlanWords) => left.push({ id: workOrder.id, number: workOrder.number, words })
    if (workOrder.sharedWithOtherCustomers) leave(SHARED_HOLD_WORDS)
    else if (workOrder.status === 'ON_HOLD') leave(LEFT_WORDS.ON_HOLD)
    else if (workOrder.status === 'COMPLETED' || workOrder.status === 'CLOSED') leave(LEFT_WORDS[workOrder.status])
    else if (!workOrder.rights.hold) leave(LEFT_WORDS.NO_RIGHT)
    else {
      ids.push(workOrder.id)
      numbers.push(workOrder.number)
      versions[workOrder.id] = workOrder.version
    }
  }
  if (ids.length > 0) return { ids, numbers, versions, left, notReached, held: null }

  const own = live.filter((workOrder) => !workOrder.sharedWithOtherCustomers)
  if (own.length > 0 && own.every((workOrder) => !workOrder.rights.hold)) return heldPlan('NO_RIGHT', left)
  // Each one reached says why; the ones not reached are Production's to hold.
  if (notReached > 0) return heldPlan('NONE_REACHED', left)
  if (live.every((workOrder) => DONE.includes(workOrder.status))) return heldPlan('ALL_DONE', left)
  if (live.filter((workOrder) => !DONE.includes(workOrder.status)).every((workOrder) => workOrder.status === 'ON_HOLD')) return heldPlan('ALL_ON_HOLD', left)
  return heldPlan('NONE_HOLDABLE', left)
}
// ---- end B-OO-005

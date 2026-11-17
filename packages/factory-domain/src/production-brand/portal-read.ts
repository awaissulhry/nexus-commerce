import { businessDate, type BusinessDate } from '../core/time'
import type { Words } from '../portal/tasks/kinds'
import { dayWords } from '../sales/change-requests/rules'
import type { IssueStatus } from './issues'
import { shares, type ProductionShareLevel } from './levels'
import { nextStageOf, type BrandStage } from './stages'
import { STAGE_WORDS } from './words'

/**
 * B-PR-18 (production plan §4 "What a brand sees", 06-tree §0.5 and B.1/B.2; review fixes R-10, R-26, R-42, R-43, R-65; the Owner
 * rule 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the production unit, should
 * be able to see it all. And manage it all as well."): what a customer reads of its orders in production beyond the rules of the
 * stage, the health, who acts next and its urgency (./stages, ./health, ./waiting, ./urgency), pure. The API
 * (apps/factory-api modules/production/brand-portal) reads its OWN orders in the partner scope first, then the office's facts of
 * exactly those orders, and words them here:
 *
 *   gates       its real pre-production gates: PP sample, size set, sample approved, leather, trims, lab (OrderGate; a gate in
 *               the office's own words, OTHER, never reaches it) — waiting on you (its sample round's approval is open) or on
 *               us, passed (the day), or started before (never the office's reason); target dates as planned
 *   approvals   its colour, leather, fabric and trims swatch answers: approvals it gave or is asked for, not gates
 *   planned     the cut start, sewing start and finish of its own work orders in the PUBLISHED plan only (Owner P3: the
 *               working plan never reaches a customer); dates only, never a line, a lane, minutes or a load
 *   next        the next milestone a list row shows, by level: Status only the next stage; + Progress the count of the stage
 *               it is at ("32 of 40 sewn"); + Gates & dates the next waiting gate with its target date, else the next stage
 *               with its planned start
 *   problem     the state of the problems it reported on an order: "Waiting on us since 16 Nov" until we write to it in the
 *               order's thread, then "Answered 17 Nov"; for the other orders of a batch answered in one order's thread,
 *               "Answered in SO-…" (R-43, the fallback of threads ask T11). Never the issue, its task or who answers (R-41)
 *   keys        the keys no customer read may hold (PW-15, PW-P03): a supervisor, an office person, a note, a place in our
 *               queue, a line, a lane, a load, a lot size, a work order or another customer
 */

// ---- gates -----------------------------------------------------------------------------------------------------------------

/**
 * The gates a customer reads, in the order it reads them. SIZE_SET is the size-set gate the schema adds with B-PR-23 (wave 4);
 * a gate kind not listed here (OTHER: "something else, in words") stays the office's.
 */
export const BRAND_GATE_KINDS = ['PP_SAMPLE', 'SIZE_SET', 'SAMPLE_APPROVED', 'LEATHER_APPROVED', 'TRIMS_IN', 'LAB_PASSED'] as const
export type BrandGateKind = (typeof BRAND_GATE_KINDS)[number]

export const isBrandGate = (kind: string): kind is BrandGateKind => (BRAND_GATE_KINDS as readonly string[]).includes(kind)

export const GATE_WORDS: Readonly<Record<BrandGateKind, Words>> = Object.freeze({
  PP_SAMPLE: { it: 'Campione di pre-produzione', en: 'PP sample' },
  SIZE_SET: { it: 'Set taglie', en: 'Size set' },
  SAMPLE_APPROVED: { it: 'Campione approvato', en: 'Sample approved' },
  LEATHER_APPROVED: { it: 'Pelle approvata', en: 'Leather approved' },
  TRIMS_IN: { it: 'Accessori arrivati', en: 'Trims in' },
  LAB_PASSED: { it: 'Test di laboratorio', en: 'Lab test' },
})

export const BRAND_GATE_STATES = ['WAITING_YOU', 'WAITING_US', 'PASSED', 'STARTED_BEFORE'] as const
export type BrandGateState = (typeof BRAND_GATE_STATES)[number]

export const GATE_STATE_WORDS: Readonly<Record<BrandGateState, Words>> = Object.freeze({
  WAITING_YOU: { it: 'Tocca a voi', en: 'Waiting on you' },
  WAITING_US: { it: 'Tocca a noi', en: 'Waiting on us' },
  PASSED: { it: 'Superata', en: 'Passed' },
  STARTED_BEFORE: { it: "Avviato prima dell'approvazione", en: 'Started before approval' },
})

/** A gate's state for the customer: passed wins over started before; a waiting gate waits on it while its approval is open. */
export function brandGateStateOf(gate: { readonly passedAt: unknown; readonly overriddenAt: unknown; readonly waitsOnYou: boolean }): BrandGateState {
  if (gate.passedAt != null) return 'PASSED'
  if (gate.overriddenAt != null) return 'STARTED_BEFORE'
  return gate.waitsOnYou ? 'WAITING_YOU' : 'WAITING_US'
}

export const isWaitingGate = (state: BrandGateState): boolean => state === 'WAITING_YOU' || state === 'WAITING_US'

/** One gate as the customer reads it. */
export interface BrandGate {
  readonly kind: BrandGateKind
  readonly state: BrandGateState
  /** The day it should pass (as planned); null: none set. */
  readonly targetDate: BusinessDate | null
  /** The day it passed (or the work started before it); null: still waiting. */
  readonly doneOn: BusinessDate | null
}

/** The gates in reading order: by target day (none last), then by kind. */
export function gateOrder(a: BrandGate, b: BrandGate): number {
  const at = (gate: BrandGate) => gate.targetDate ?? '9999-12-31'
  return at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : BRAND_GATE_KINDS.indexOf(a.kind) - BRAND_GATE_KINDS.indexOf(b.kind)
}

// ---- swatch answers: approvals, not gates ----------------------------------------------------------------------------------

/** The swatch kinds a customer answers (COLOUR and LEATHER today; FABRIC and TRIM with the swatch kinds still to come). */
export const SWATCH_WORDS: Readonly<Record<string, Words>> = Object.freeze({
  COLOUR: { it: 'Colore', en: 'Colour' },
  LEATHER: { it: 'Pelle', en: 'Leather' },
  FABRIC: { it: 'Tessuto', en: 'Fabric' },
  TRIM: { it: 'Accessori', en: 'Trims' },
})
const SWATCH_ANY: Words = Object.freeze({ it: 'Campione di materiale', en: 'Material swatch' })
export const swatchWords = (kind: string): Words => SWATCH_WORDS[kind] ?? SWATCH_ANY

export const APPROVAL_STATES = ['WAITING_YOU', 'APPROVED', 'APPROVED_WITH_COMMENTS', 'REFUSED'] as const
export type ApprovalState = (typeof APPROVAL_STATES)[number]

export const APPROVAL_STATE_WORDS: Readonly<Record<ApprovalState, Words>> = Object.freeze({
  WAITING_YOU: { it: 'Tocca a voi', en: 'Waiting on you' },
  APPROVED: { it: 'Approvato', en: 'Approved' },
  APPROVED_WITH_COMMENTS: { it: 'Approvato con commenti', en: 'Approved with comments' },
  REFUSED: { it: 'Rifiutato', en: 'Refused' },
})

/**
 * A sent swatch's state: its decision when it has one, else waiting on the customer while the approval asked of it is open;
 * null: nothing to show (withdrawn or expired without an answer).
 */
export function swatchStateOf(swatch: { readonly decision: string | null; readonly requestStatus: string | null }): ApprovalState | null {
  if (swatch.decision === 'APPROVED') return 'APPROVED'
  if (swatch.decision === 'APPROVED_WITH_COMMENTS') return 'APPROVED_WITH_COMMENTS'
  if (swatch.decision === 'REJECTED') return 'REFUSED'
  if (swatch.requestStatus === 'APPROVED') return 'APPROVED'
  if (swatch.requestStatus === 'APPROVED_WITH_CHANGES') return 'APPROVED_WITH_COMMENTS'
  if (swatch.requestStatus === 'REFUSED') return 'REFUSED'
  return swatch.requestStatus === 'OPEN' ? 'WAITING_YOU' : null
}

// ---- the published plan's dates -------------------------------------------------------------------------------------------

/** The cut start, sewing start and finish of the customer's own work in the published plan (null: not planned there). */
export interface PlannedDates {
  readonly cutStart: BusinessDate | null
  readonly sewStart: BusinessDate | null
  readonly finish: BusinessDate | null
}

/**
 * The planned dates from the published slots of the customer's own work orders: the first start at a CUTTING work centre, the
 * first start at a SEWING one, the last end of any (a slot of the whole work order counts for the finish only). Days only.
 */
export function plannedDatesOf(slots: readonly { readonly centre: string | null; readonly start: BusinessDate; readonly end: BusinessDate }[]): PlannedDates {
  const first = (centre: string): BusinessDate | null =>
    slots.filter((slot) => slot.centre === centre).reduce<BusinessDate | null>((least, slot) => (least === null || slot.start < least ? slot.start : least), null)
  const finish = slots.reduce<BusinessDate | null>((last, slot) => (last === null || slot.end > last ? slot.end : last), null)
  return { cutStart: first('CUTTING'), sewStart: first('SEWING'), finish }
}

// ---- the next milestone of a list row ------------------------------------------------------------------------------------

/** The counts of the order's pieces at each stage (sales/portal-orders progress: cut and bundled, sewn, checked, packed). */
export interface StageCounts {
  readonly ordered: number
  readonly cut: number | null
  readonly sewn: number | null
  readonly inspected: number | null
  readonly packed: number | null
}

/** Which count tells how far the stage it is at went (PREPARING: none). */
export const COUNT_OF_STAGE: Readonly<Record<BrandStage, 'cut' | 'sewn' | 'inspected' | 'packed' | null>> = Object.freeze({
  PREPARING: null,
  CUTTING: 'cut',
  SEWING: 'sewn',
  QUALITY: 'inspected',
  READY: 'packed',
})

const COUNT_WORDS: Readonly<Record<'cut' | 'sewn' | 'inspected' | 'packed', Words>> = Object.freeze({
  cut: { it: 'tagliati', en: 'cut' },
  sewn: { it: 'cuciti', en: 'sewn' },
  inspected: { it: 'controllati', en: 'checked' },
  packed: { it: 'imballati', en: 'packed' },
})

/** "32 of 40 sewn" / "32 di 40 cuciti". */
export function countWords(count: 'cut' | 'sewn' | 'inspected' | 'packed', done: number, of: number): Words {
  return { it: `${done} di ${of} ${COUNT_WORDS[count].it}`, en: `${done} of ${of} ${COUNT_WORDS[count].en}` }
}

export type NextMilestone =
  | { readonly kind: 'STAGE'; readonly stage: BrandStage; readonly date: BusinessDate | null; readonly words: Words }
  | { readonly kind: 'GATE'; readonly gate: BrandGateKind; readonly date: BusinessDate | null; readonly words: Words }

export interface MilestoneRead {
  readonly next: NextMilestone | null
  /** + Progress: how far the stage it is at went ("32 of 40 sewn"); null below the level or with no count. */
  readonly count: { readonly done: number; readonly of: number; readonly words: Words } | null
}

/** The planned start of a stage in the published plan (quality and ready follow the planned finish of the work). */
const plannedStartOf = (stage: BrandStage, planned: PlannedDates | null): BusinessDate | null => {
  if (!planned) return null
  if (stage === 'CUTTING') return planned.cutStart
  if (stage === 'SEWING') return planned.sewStart
  if (stage === 'QUALITY' || stage === 'READY') return planned.finish
  return null
}

/**
 * The next milestone a list row shows, by level (06-tree §0.5). Every input is the customer's own order's; what the level does not
 * share is never read into the answer (no count below + Progress, no gate and no date below + Gates & dates).
 */
export function nextMilestoneOf(input: {
  readonly level: ProductionShareLevel
  readonly stage: BrandStage | null
  readonly counts: StageCounts | null
  readonly gates: readonly BrandGate[]
  readonly planned: PlannedDates | null
}): MilestoneRead {
  if (input.stage === null) return { next: null, count: null }
  const key = COUNT_OF_STAGE[input.stage]
  const figure = key && input.counts ? input.counts[key] : null
  const count = shares(input.level, 'progress') && key && input.counts && figure !== null ? { done: figure, of: input.counts.ordered, words: countWords(key, figure, input.counts.ordered) } : null
  const nextStage = nextStageOf(input.stage)
  if (shares(input.level, 'gates')) {
    const waiting = [...input.gates].filter((gate) => isWaitingGate(gate.state)).sort(gateOrder)[0]
    if (waiting) return { next: { kind: 'GATE', gate: waiting.kind, date: waiting.targetDate, words: GATE_WORDS[waiting.kind] }, count }
    if (nextStage === null) return { next: null, count }
    return { next: { kind: 'STAGE', stage: nextStage, date: plannedStartOf(nextStage, input.planned), words: STAGE_WORDS[nextStage] }, count }
  }
  return { next: nextStage === null ? null : { kind: 'STAGE', stage: nextStage, date: null, words: STAGE_WORDS[nextStage] }, count }
}

// ---- the problems it reported ----------------------------------------------------------------------------------------------

/** One problem the customer reported on an order (ProductionIssue, source BRAND), as the API read it for that customer. */
export interface ReportedProblem {
  readonly orderId: string
  readonly partyId: string
  readonly status: IssueStatus
  readonly raisedAt: Date
  readonly answeredAt: Date | null
  /** The order whose thread holds our answer: its own, another order of its batch, or null (none found). */
  readonly answeredInOrderId: string | null
}

export type ProblemState =
  | { readonly state: 'WAITING_ON_US'; readonly since: BusinessDate }
  | { readonly state: 'ANSWERED'; readonly on: BusinessDate | null }
  | { readonly state: 'ANSWERED_IN'; readonly on: BusinessDate | null; readonly orderId: string }

/**
 * Where a problem was answered (R-42, R-43): the first shared office message after it was raised (and not after it was marked
 * answered) in the thread of its own order, else in the thread of another order of its batch (the earliest), else nowhere known.
 * `answers` holds, per order of the batch, the times of the office's shared messages in that order's thread.
 */
export function answeredInOf(problem: { readonly orderId: string; readonly raisedAt: Date; readonly answeredAt: Date | null }, batchOrderIds: readonly string[], answers: ReadonlyMap<string, readonly Date[]>): string | null {
  const counts = (at: Date) => at.getTime() >= problem.raisedAt.getTime() && (problem.answeredAt === null || at.getTime() <= problem.answeredAt.getTime())
  const firstOf = (orderId: string): number | null => {
    const times = (answers.get(orderId) ?? []).filter(counts).map((at) => at.getTime())
    return times.length > 0 ? Math.min(...times) : null
  }
  if (firstOf(problem.orderId) !== null) return problem.orderId
  let found: { orderId: string; at: number } | null = null
  for (const orderId of [...new Set(batchOrderIds)].sort()) {
    if (orderId === problem.orderId) continue
    const at = firstOf(orderId)
    if (at !== null && (found === null || at < found.at)) found = { orderId, at }
  }
  return found?.orderId ?? null
}

/**
 * The state of the problems the customer reported on one of its orders (null: none, or only cancelled ones). An open one reads
 * "Waiting on us" since the oldest open one was raised; else the newest answered one reads "Answered", or "Answered in" the order
 * whose thread holds the answer. Throws on a problem of another customer (wall).
 */
export function problemStateOf(orderId: string, partyId: string, problems: readonly ReportedProblem[]): ProblemState | null {
  if (problems.some((problem) => problem.partyId !== partyId)) throw new Error("production-brand portal-read: a customer's problems were given one of another customer")
  const own = problems.filter((problem) => problem.orderId === orderId && problem.status !== 'CANCELLED')
  const open = own.filter((problem) => problem.status === 'OPEN')
  if (open.length > 0) return { state: 'WAITING_ON_US', since: businessDate(new Date(Math.min(...open.map((problem) => problem.raisedAt.getTime())))) }
  const answered = own.filter((problem) => problem.status === 'ANSWERED').sort((a, b) => (b.answeredAt?.getTime() ?? 0) - (a.answeredAt?.getTime() ?? 0))[0]
  if (!answered) return null
  const on = answered.answeredAt ? businessDate(answered.answeredAt) : null
  if (answered.answeredInOrderId !== null && answered.answeredInOrderId !== orderId) return { state: 'ANSWERED_IN', on, orderId: answered.answeredInOrderId }
  return { state: 'ANSWERED', on }
}

/** The problem's state in words; `inOrder` names the order that holds the answer (its number, "SO-…"). */
export function problemWords(problem: ProblemState, inOrder: string | null = null): Words {
  if (problem.state === 'WAITING_ON_US') return { it: `In attesa di una nostra risposta dal ${dayWords(problem.since, 'it')}`, en: `Waiting on us since ${dayWords(problem.since, 'en')}` }
  if (problem.state === 'ANSWERED_IN' && inOrder !== null) return { it: `Risposto in ${inOrder}`, en: `Answered in ${inOrder}` }
  return problem.on ? { it: `Risposto il ${dayWords(problem.on, 'it')}`, en: `Answered ${dayWords(problem.on, 'en')}` } : { it: 'Risposto', en: 'Answered' }
}

// ---- marks and holds -------------------------------------------------------------------------------------------------------

/** What holds an order's work, as the customer reads it: quality's check, our production hold, or its own pause. */
export const BRAND_HOLD_READS = ['QUALITY', 'PRODUCTION', 'BRAND'] as const
export type BrandHoldRead = (typeof BRAND_HOLD_READS)[number]

/** Its own pause (an accepted HOLD ask): the words of the mark, never a reason of ours. */
export const PAUSED_WORDS: Words = Object.freeze({ it: 'In pausa su vostra richiesta', en: 'Paused at your request' })
export const ON_HOLD_WORDS: Words = Object.freeze({ it: 'In sospeso', en: 'On hold' })
export const PARTLY_SHIPPED_WORDS: Words = Object.freeze({ it: 'Spedito in parte', en: 'Partly shipped' })
export const CHANGE_PENDING_WORDS: Words = Object.freeze({ it: 'Modifica in attesa', en: 'Change pending' })

// ---- the wall: keys a customer read never holds -----------------------------------------------------------------------------

/**
 * Keys no brand read may hold (PW-15, PW-P03): who supervises or answers, an office person or note, a place in our queue, a
 * production line, a lane, a load or a lot, a work order, a site (`lineId` of a read is the customer's own ORDER line, as the portal's
 * progress has always named it). The PG wall tests walk every answer with `forbiddenKeysIn`.
 */
export const FORBIDDEN_BRAND_KEYS = Object.freeze([
  'supervisor',
  'supervisorId',
  'supervisorAssignedAt',
  'backup',
  'healthNote',
  'note',
  'healthSetById',
  'urgencySetById',
  'urgencyLockedById',
  'createdById',
  'placedById',
  'liftedById',
  'answeredById',
  'assigneeId',
  'priority',
  'priorityLevel',
  'backlogRank',
  'position',
  'queuePlace',
  'productionLineId',
  'workCentreId',
  'laneId',
  'minutes',
  'capacity',
  'load',
  'lotSize',
  'workOrderId',
  'workOrders',
  'siteId',
] as const)

/** The forbidden keys found anywhere in a value (paths like `items/0/health/note`), in the order met. */
export function forbiddenKeysIn(value: unknown, at = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => forbiddenKeysIn(entry, `${at}/${index}`))
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => [
    ...((FORBIDDEN_BRAND_KEYS as readonly string[]).includes(key) ? [`${at}/${key}`] : []),
    ...forbiddenKeysIn(entry, `${at}/${key}`),
  ])
}

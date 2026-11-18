import { CHANGE_REFUSALS, CHANGE_WORDS, MAX_DECISION_NOTE, applyRouteOf, changedSince, takesEveryCell, type ApplyRoute, type Words } from '@nexus/factory-domain/order-apply/rules'
import { OPEN_CUT_ORDER_STATUSES } from '@nexus/factory-domain/production/cutorders/rules'
import { LOWER_REFUSALS, LOWER_WORDS, cutLinePlan, cutOrderStand, type CutLineFacts, type CutOrderStand } from '@nexus/factory-domain/production/work-orders/lower'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import type { Loaded } from '../../../sales/quotes/record/record-model'
import type { WorkOrder } from '../../../production/_shared/api'
import type { WorkOrderChange } from './api'

/**
 * F-SA-245 (sales page plan R1; lead picks P6', Round 4–5; 14-change-flow §2.0 S7; review C-11, R-6) — work-order changes in the
 * office, without a screen: ONE decide window, opened from Home › Approvals' row "Work order change · WO-…" (B-SA-044's source,
 * `?open=<change id>`) and from the work order's band notice (`?open=<change id>` on its page). PURE: the container reads, this
 * decides, the view draws.
 *
 *   the window   the change in words (its title, the order, who proposed it, why), each cell before → after beside what the work
 *                order makes now and what of it is already cut and bundled (its own cells only), the extra pieces and the outcome
 *                chosen at Accept, the lay it touches (the work order's cut orders on those cells, with their stand), what Apply
 *                does on the work order as it is now
 *   Apply        "Lower to the order" (a draft: its cells set; released: production's Lower to the order, never below what is
 *                cut; a unit or every size to 0: the work order cancelled), "Make more for the order", "Make the new work order" —
 *                held with why before the click: decided already, not this reader's, the work order closed / on hold / released
 *                for a raise, "WO-… changed since — propose again" (its cells are not the figures proposed on), "Re-plan the lay
 *                first" (a lay fixed for the cell holds more than it may keep — the same rule as the command, factory-domain
 *                cutLinePlan), offline, busy. A refusal of the API says its own words; one that would come again holds Apply
 *                until Read again.
 *   Leave as is  words required (1 to 300): the order's "Still to do" shows them ("Left as is: …").
 * A proposal is not an approval (rule 42, C-11): the person who accepted may apply it, the proposer is always named.
 * Words: catalogue `approvals` (`workOrderChange.*`); the change's own title, status and extra pieces in the API's two languages.
 */

export const WOC = 'workOrderChange'

/** The attention kind of a waiting change (Home › Approvals, B-SA-044). */
export const WORK_ORDER_CHANGE_KIND = 'WORK_ORDER_CHANGE'

/** "Work order change" in both languages (a notice's `{request}`: "Work order change: WO-0142"). */
export const CHANGE_KIND_WORDS: Words = Object.freeze({ en: 'Work order change', it: "Modifica dell'ordine di lavoro" })

// ---- the cells ------------------------------------------------------------------------------------------------------------

/** One cell of the change beside the work order as it is now. */
export interface DecideCell {
  readonly key: string
  readonly line: number | null
  readonly size: string
  readonly colourway: string | null
  readonly from: number
  readonly to: number
  /** What the work order makes of it now (0: a new cell of a raise); null: the work order was not read. */
  readonly now: number | null
  /** Pieces cut and bundled of it (null: not counted here, or not read). */
  readonly cut: number | null
  readonly bundled: number | null
  /** The work order makes another figure now than the change was proposed on. */
  readonly changed: boolean
}

type CellsOf = Pick<WorkOrder, 'cells'>

/** The change's cells beside the work order's (by its cell, else by line and size for a raise's new cell). */
export function decideCellsOf(change: Pick<WorkOrderChange, 'cells'>, workOrder: CellsOf | null): DecideCell[] {
  return change.cells.map((cell, index) => {
    const own = workOrder ? (cell.workOrderSizeId ? workOrder.cells.find((entry) => entry.id === cell.workOrderSizeId) : workOrder.cells.find((entry) => entry.salesOrderLineId === cell.salesOrderLineId && entry.size === cell.size)) : undefined
    const now = workOrder ? (own?.quantity ?? 0) : null
    return {
      key: cell.workOrderSizeId ?? `${cell.salesOrderLineId}|${cell.size}|${index}`,
      line: cell.lineSeq,
      size: cell.size,
      colourway: own?.colourwayCode ?? null,
      from: cell.from,
      to: cell.to,
      now,
      cut: own?.progress.cut ?? null,
      bundled: own?.progress.bundled ?? null,
      changed: now !== null && now !== cell.from,
    }
  })
}

/** The cells proposed on another figure than the work order makes now (the command's own rule: factory-domain changedSince). */
export function changedCellsOf(change: Pick<WorkOrderChange, 'cells'>, workOrder: CellsOf): number {
  const byCell = new Map(workOrder.cells.map((cell) => [cell.id, cell.quantity]))
  const byLineSize = new Map(workOrder.cells.flatMap((cell) => (cell.salesOrderLineId ? [[`${cell.salesOrderLineId}|${cell.size}`, cell.quantity] as const] : [])))
  return changedSince(change.cells, byCell, byLineSize).length
}

/** How Apply carries the change out on the work order as it is now (the command's own route), or why it cannot now. */
export function routeOf(change: Pick<WorkOrderChange, 'kind' | 'workOrder' | 'cells'>, workOrder: Pick<WorkOrder, 'status' | 'kind' | 'cells'> | null): ReturnType<typeof applyRouteOf> {
  const everyCell = change.kind === 'LOWER_TO_ORDER' && workOrder !== null && takesEveryCell(change.cells, workOrder.cells.map((cell) => cell.id))
  return applyRouteOf({ kind: change.kind, workOrderId: change.workOrder?.id ?? null }, workOrder ?? (change.workOrder ? { status: change.workOrder.status, kind: '' } : null), everyCell)
}

/** The Apply button's words for a route (a `workOrderChange.apply.` key). */
export function applyLabelOf(change: Pick<WorkOrderChange, 'kind' | 'workOrder'>, route: ApplyRoute | null): string {
  if (route === 'NEW_DRAFT' || (change.kind === 'MAKE_MORE' && !change.workOrder)) return `${WOC}.apply.NEW_DRAFT`
  if (change.kind === 'MAKE_MORE') return `${WOC}.apply.MAKE_MORE`
  return route === 'CANCEL_WORK_ORDER' ? `${WOC}.apply.CANCEL_WORK_ORDER` : `${WOC}.apply.LOWER_TO_ORDER`
}

// ---- the lay it touches ----------------------------------------------------------------------------------------------------

/** A cut order of the work order, as its record reads (its lines on the work order's cells). */
export interface LayRecord {
  readonly cutOrder: { readonly id: string; readonly number: string; readonly kind: string; readonly status: string }
  readonly lines: readonly { readonly id: string; readonly seq: number; readonly workOrderSizeId: string; readonly quantity: number }[]
}

export interface ChangeLay {
  readonly id: string
  readonly number: string
  readonly status: string
  readonly stand: CutOrderStand
  /** The sizes of the change it holds pieces of. */
  readonly sizes: readonly string[]
}

/** What stops Apply at a lay (the command's refusal, read before the click): the first fixed or cutting one by number. */
export interface LayStop {
  readonly code: 'REPLAN_LAY' | 'CUTTING_UNDER_WAY'
  readonly cutOrderId: string
  readonly number: string
}

/**
 * The lays the change touches (the work order's open cut orders — planned, released, being cut — holding its cells), and the
 * first that stops a lowering. Per cell lowered: its lines on those cut orders against the new figure, by the command's own rule
 * (factory-domain cutLinePlan: a planned leather one follows; a fixed or cutting one holding more than the cell may keep stops).
 * Lines already cut are not counted here: they can only raise what the command finds, so a stop said here is always the command's
 * (never a held button the API would allow); one only the API finds is said in its words when Apply is refused.
 */
export function laysOf(change: Pick<WorkOrderChange, 'kind' | 'cells'>, records: readonly LayRecord[]): { readonly lays: ChangeLay[]; readonly stop: LayStop | null } {
  const open = records.filter((record) => (OPEN_CUT_ORDER_STATUSES as readonly string[]).includes(record.cutOrder.status))
  const ids = new Set(change.cells.flatMap((cell) => (cell.workOrderSizeId ? [cell.workOrderSizeId] : [])))
  const lays = open
    .map((record) => ({ record, held: record.lines.filter((line) => ids.has(line.workOrderSizeId)) }))
    .filter((entry) => entry.held.length > 0)
    .map(({ record, held }) => ({ id: record.cutOrder.id, number: record.cutOrder.number, status: record.cutOrder.status, stand: cutOrderStand(record.cutOrder), sizes: [...new Set(held.map((line) => change.cells.find((cell) => cell.workOrderSizeId === line.workOrderSizeId)?.size ?? ''))].filter(Boolean) }))
    .sort((a, b) => a.number.localeCompare(b.number))
  if (change.kind !== 'LOWER_TO_ORDER') return { lays, stop: null }
  for (const cell of change.cells) {
    if (!cell.workOrderSizeId || cell.to >= cell.from) continue
    const facts: CutLineFacts[] = open.flatMap((record) =>
      record.lines.filter((line) => line.workOrderSizeId === cell.workOrderSizeId).map((line) => ({ lineId: line.id, cutOrderId: record.cutOrder.id, number: record.cutOrder.number, seq: line.seq, stand: cutOrderStand(record.cutOrder), garments: line.quantity })),
    )
    const plan = cutLinePlan(facts, cell.to)
    if (!plan.ok) return { lays, stop: { code: plan.code, number: plan.number, cutOrderId: facts.find((fact) => fact.number === plan.number)?.cutOrderId ?? '' } }
  }
  return { lays, stop: null }
}

// ---- refusals in words --------------------------------------------------------------------------------------------------------

/** The refusals this window says itself (`workOrderChange.refusal.<code>`): the change's and Lower to the order's. */
export const KNOWN_CHANGE_REFUSALS: ReadonlySet<string> = new Set<string>([...CHANGE_REFUSALS, ...LOWER_REFUSALS])

/** A refusal that comes back until the work order or its lay changes: Apply stays held until Read again. */
const HOLDS_APPLY: ReadonlySet<string> = new Set(['CHANGED_SINCE', 'REPLAN_LAY', 'CUTTING_UNDER_WAY', 'ON_HOLD', 'WORK_ORDER_DONE', 'NOT_A_DRAFT', 'UNIT_CUT', 'DECIDED'])

/** A problem of the last write, in this window's words. */
export interface ChangeProblem {
  readonly key: string
  /** The refusal's code (null: not a refusal of the rules). */
  readonly code: string | null
  /** The cut order a lay refusal names (its number from the API's words; null: not named). */
  readonly lay: string | null
  /** Read the change (and the inbox) again. */
  readonly reload: boolean
  /** Apply stays held with these words until Read again. */
  readonly holds: boolean
}

const SENTINEL = '\u0001'
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** The API's English words of a refusal as a pattern (its one value captured), from factory-domain's own words. */
const patternOf = (en: (value: string) => string): RegExp => new RegExp(`^${escape(en(SENTINEL)).replace(escape(SENTINEL), '(.+?)')}$`)
const STORED: readonly { readonly code: string; readonly pattern: RegExp; readonly lay: boolean }[] = [
  { code: 'CHANGED_SINCE', pattern: patternOf((n) => CHANGE_WORDS.changedSince(n).en), lay: false },
  { code: 'WORK_ORDER_DONE', pattern: patternOf((n) => CHANGE_WORDS.workOrderDone(n).en), lay: false },
  { code: 'ON_HOLD', pattern: patternOf((n) => CHANGE_WORDS.onHold(n).en), lay: false },
  { code: 'NOT_A_DRAFT', pattern: patternOf((n) => CHANGE_WORDS.notADraft(n).en), lay: false },
  { code: 'UNIT_CUT', pattern: patternOf((n) => CHANGE_WORDS.unitCut(n).en), lay: false },
  { code: 'REPLAN_LAY', pattern: patternOf((n) => LOWER_WORDS.replanLay(n).en), lay: true },
  { code: 'CUTTING_UNDER_WAY', pattern: patternOf((n) => LOWER_WORDS.cuttingUnderWay(n).en), lay: true },
  { code: 'LAST_CELL', pattern: patternOf((n) => LOWER_WORDS.lastCell(n).en), lay: false },
  { code: 'ON_HOLD', pattern: patternOf((n) => LOWER_WORDS.onHold(n).en), lay: false },
  { code: 'CELL_IN_USE', pattern: patternOf((n) => LOWER_WORDS.cellInUse(n).en), lay: false },
]

/** The API's words of a refusal read back to its code (a change's `lastError`, a 409's message), with the lay it names. */
export function wordsRefusalOf(text: string | null | undefined): { readonly code: string; readonly lay: string | null } | null {
  const said = (text ?? '').trim()
  if (!said) return null
  for (const entry of STORED) {
    const match = entry.pattern.exec(said)
    if (match) return { code: entry.code, lay: entry.lay ? (match[1] ?? null) : null }
  }
  return null
}

export const changeRefusalKeyOf = (code: string | null): string => (code && KNOWN_CHANGE_REFUSALS.has(code) ? `${WOC}.refusal.${code}` : `${WOC}.refusal.other`)

/** A write's failure as this window's words: `refusal/<CODE>` (409), a moved version, gone, the rest by kind. */
export function changeProblemOf(error: unknown): ChangeProblem {
  if (!isApiError(error)) return { key: `${WOC}.problem.internal`, code: null, lay: null, reload: false, holds: false }
  for (const issue of error.issues) {
    const path = issuePath(issue)
    if (!path.startsWith('refusal/')) continue
    const code = path.slice('refusal/'.length).split('/')[0] ?? ''
    const lay = code === 'REPLAN_LAY' || code === 'CUTTING_UNDER_WAY' ? (wordsRefusalOf(issue.message)?.lay ?? null) : null
    return { key: changeRefusalKeyOf(code), code, lay, reload: true, holds: HOLDS_APPLY.has(code) }
  }
  switch (error.kind) {
    case 'conflict':
      return { key: `${WOC}.refusal.moved`, code: null, lay: null, reload: true, holds: false }
    case 'not_found':
      return { key: `${WOC}.refusal.gone`, code: null, lay: null, reload: true, holds: false }
    case 'forbidden':
    case 'invalid':
    case 'unavailable':
    case 'rate_limited':
    case 'signed_out':
      return { key: `${WOC}.problem.${error.kind}`, code: null, lay: null, reload: false, holds: false }
    default:
      return { key: `${WOC}.problem.internal`, code: null, lay: null, reload: false, holds: false }
  }
}

// ---- held with the reason before the click -------------------------------------------------------------------------------------

/** Why words are held: a `workOrderChange.held.` key and its params. */
export interface Held {
  readonly key: string
  readonly params?: Record<string, string>
}

export interface DecideFacts {
  /** The work order as it is now (null: none named, or not read — the API decides then). */
  readonly workOrder: Pick<WorkOrder, 'number' | 'status' | 'kind' | 'cells'> | null
  /** The first lay that stops a lowering (null: none, or the lays were not read). */
  readonly stop: LayStop | null
  /** The last write's refusal, while it holds Apply (until Read again). */
  readonly problem: ChangeProblem | null
  readonly offline: boolean
  readonly busy: boolean
}

/** Why Apply waits, or null — in order: decided, not this reader's, the route, changed since, a lay, a refusal standing, offline, busy. */
export function applyHeld(change: Pick<WorkOrderChange, 'status' | 'mayDecide' | 'kind' | 'workOrder' | 'cells' | 'words'>, facts: DecideFacts): Held | null {
  const number = facts.workOrder?.number ?? change.workOrder?.number ?? ''
  if (change.status !== 'PROPOSED') return { key: `${WOC}.held.decided` }
  if (!change.mayDecide) return { key: `${WOC}.held.noRight` }
  if (facts.workOrder) {
    const route = routeOf(change, facts.workOrder)
    if ('refusal' in route) return { key: `${WOC}.held.${route.refusal}`, params: { number } }
    if (changedCellsOf(change, facts.workOrder) > 0) return { key: `${WOC}.held.CHANGED_SINCE`, params: { number } }
  }
  if (facts.stop) return { key: `${WOC}.held.${facts.stop.code}` }
  if (facts.problem?.holds) return facts.problem.code ? { key: `${WOC}.held.${facts.problem.code}`, params: { number } } : { key: facts.problem.key }
  if (facts.offline) return { key: `${WOC}.held.offline` }
  if (facts.busy) return { key: `${WOC}.held.busy` }
  return null
}

/** Why "Leave as is" waits (the dialog's Send), or null: decided, not this reader's, the words (1 to 300), offline, busy. */
export function declineHeld(change: Pick<WorkOrderChange, 'status' | 'mayDecide'>, words: string | null, state: { readonly offline: boolean; readonly busy: boolean }): Held | null {
  if (change.status !== 'PROPOSED') return { key: `${WOC}.held.decided` }
  if (!change.mayDecide) return { key: `${WOC}.held.noRight` }
  if (words !== null) {
    const text = words.trim()
    if (text === '') return { key: `${WOC}.held.words` }
    if (text.length > MAX_DECISION_NOTE) return { key: `${WOC}.held.long`, params: { max: String(MAX_DECISION_NOTE) } }
  }
  if (state.offline) return { key: `${WOC}.held.offline` }
  if (state.busy) return { key: `${WOC}.held.busy` }
  return null
}

export const DECISION_LIMIT = MAX_DECISION_NOTE

// ---- the inbox row and the address -------------------------------------------------------------------------------------------

/**
 * A waiting change's id from its Home › Approvals row (B-SA-044: Today's row of kind WORK_ORDER_CHANGE, keyed by factory-domain
 * rowKeyOf `WORK_ORDER_CHANGE:<record id>:change:<change id>`), or null — the row then opens its own page as before.
 */
export function changeIdOfRow(row: { readonly source: string; readonly kind: string; readonly item?: { readonly key: string } | undefined }): string | null {
  if (row.source !== 'attention' || row.kind !== WORK_ORDER_CHANGE_KIND || !row.item) return null
  return /:change:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(row.item.key)?.[1] ?? null
}

// ---- the window's model ------------------------------------------------------------------------------------------------------

export type DecideDialog = { readonly kind: 'decline'; readonly words: string; readonly busy: boolean; readonly problem: string | null }

export interface ChangeReviewModel {
  /** What `?open=` names. */
  readonly id: string
  readonly change: Loaded<WorkOrderChange>
  /** The work order as it is now (null: none named — a new draft — or not read for want of workorders.view). */
  readonly workOrder: Loaded<WorkOrder> | null
  /** The work order's cut orders on the change's cells (null: none to read, or no production.cutting.view). */
  readonly lays: Loaded<readonly LayRecord[]> | null
  /** The customer's name as the office reads it on the work order (the leftover outcome's words). */
  readonly customer: string | null
  readonly dialog: DecideDialog | null
  /** The last write's problem, said in the window. */
  readonly problem: ChangeProblem | null
}

export interface ChangeReviewActions {
  onApply?: () => void
  /** Open "Leave as is…" (its words), type them, send them. */
  onDecline?: () => void
  onDeclineWords?: (words: string) => void
  onDeclineSend?: () => void
  onCloseDialog?: () => void
  /** Read the change, its work order and its lays again (a refusal standing is cleared). */
  onRetry?: () => void
}

/** The notice after a decision (keys of approvals-depth `notice.*`; the change named as `{request}`). */
export interface ChangeNotice {
  readonly key: 'notice.changeApplied' | 'notice.changeDeclined'
  readonly tone: 'success'
  readonly request: { readonly kindLabel: Words; readonly record: { readonly type: string; readonly id: string; readonly label: string | null } }
  readonly lines?: readonly Words[]
}

/** The notice of a decision: the change named by its work order's number (a new draft: the order's); a reprint said beside. */
export function decidedNotice(change: Pick<WorkOrderChange, 'id' | 'workOrder' | 'madeWorkOrder' | 'salesOrder'>, decided: 'applied' | 'declined', reprint: Words | null = null): ChangeNotice {
  const label = change.workOrder?.number ?? change.madeWorkOrder?.number ?? change.salesOrder.number
  return { key: decided === 'applied' ? 'notice.changeApplied' : 'notice.changeDeclined', tone: 'success', request: { kindLabel: CHANGE_KIND_WORDS, record: { type: 'WorkOrderChange', id: change.id, label } }, ...(reprint ? { lines: [reprint] } : {}) }
}

/** The extra pieces' outcome in words (null: none chosen — the office's own close: production decides). */
export function outcomeWordsOf(change: Pick<WorkOrderChange, 'extraOutcome'>, customer: string | null): Words | null {
  return change.extraOutcome ? CHANGE_WORDS.extraOutcome(change.extraOutcome, customer ?? '—') : null
}

/** The work order's band notice: the changes waiting on it, the first one's words (the oldest), or null when none waits. */
export function bandNoticeOf(changes: readonly WorkOrderChange[] | null): { readonly count: number; readonly first: WorkOrderChange } | null {
  const waiting = (changes ?? []).filter((change) => change.status === 'PROPOSED').sort((a, b) => a.proposedAt.localeCompare(b.proposedAt) || a.id.localeCompare(b.id))
  return waiting.length > 0 ? { count: waiting.length, first: waiting[0]! } : null
}

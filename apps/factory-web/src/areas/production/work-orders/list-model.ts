import type { LiveState } from '../_shared/hooks'
import type { OpenLines, OrderOption, WorkOrderCounts, WorkOrderRow } from '../_shared/api'
import type { ListView, Phrase, ProductionCan } from '../_shared/model'
import type { ReadinessRow } from './daily/api'
import type { DailyActions, DailyModel } from './daily/model'
import type { BulkValue } from '@nexus/factory-domain/views/bulk/rules'
import type { RelativeDay } from '@nexus/factory-domain/views/quick/relative'
import type { ListMode } from '../../../list-frame/w2b/model'
import type { BulkReleaseModel } from './every-shift/model'
// F-PR-03: the list by risk — its sort, computed filters, customer filter and grouping.
import type { BlockedBy, ListSort, WaitingOn, WorkOrderRisk } from '../_shared/api'
import type { CustomerFilterState } from '../_shared/customer/model'
import type { ListTerms } from './list/model'
// F-PR-21: the production supervisor (Mine, the column, THE assign dialog).
import type { AssignSupervisorActions, AssignSupervisorModel } from '../../_shared/production-supervisor/model'
// F-PR-18: the Customer urgency filter.
import type { CustomerUrgencyState } from '../_shared/api'
// F-PR-22: "Note to N…" and a row's "Office note…" (THE note dialog, areas/production/_shared/notes).
import type { NoteDialogActions, NoteDialogModel, NoteFrom } from '../_shared/notes/model'

/** SCR-069 — the work orders list's view model (WorkOrdersListView draws it and fetches nothing). */
export interface WorkOrdersListModel {
  /** `/w/<company>`. */
  prefix: string
  can: ProductionCan
  view: ListView
  q: string
  /** B-W2b-13: Table · Board · Calendar · Cards (`?mode=`) and the due quick filter (`?due=this-week`), both address terms. */
  mode?: ListMode
  due?: RelativeDay | null
  /** B-W2b-59: the quick filter "Rush" (`?rush=true`). */
  rush?: boolean
  /** The site's day (the calendar's today). */
  today?: string
  rows: { items: WorkOrderRow[] | null; more: boolean; problem: string | null }
  /** The tiles' counts; null while unread or when the read failed (the tiles say "—"). */
  counts: WorkOrderCounts | null
  /** When the rows were read (ISO). */
  asOf: string | null
  live: LiveState
  /** Live changes waiting behind "N updates · Show". */
  updates: number
  notice: { tone: 'success' | 'warning' | 'danger' | 'info'; words: Phrase } | null
  newOrder: NewWorkOrderModel | null
  release: BulkReleaseModel | null
  /** B-W2a-46: the readiness word per row (null while unread or when the read failed: the column says "—"). */
  readiness?: Readonly<Record<string, ReadinessRow>> | null
  /** B-W2a-46: Hold N (one hold over the rows picked): who may, the HOLD reasons, the dialog. */
  daily?: DailyModel
  /** Design cases: the starting selection and focused row, the keys panel. */
  selected?: string[]
  focusRow?: number
  helpOpen?: boolean
  // ── F-PR-03 (the list by risk) ──
  /** The order of the rows (`?sort=`; default risk). */
  sort?: ListSort
  /** The computed filters (`?waitingOn=`, `?risk=`, `?blockedBy=`): the API's, inside the person's customers. */
  waitingOn?: WaitingOn | null
  risk?: WorkOrderRisk | null
  blockedBy?: BlockedBy | null
  /** The one customer filter of the Production pages (`?party=`), its options read for this page. */
  customers?: CustomerFilterState | null
  /** Grouped by customer (`?group=party`). */
  group?: 'party' | null
  /** Each group's figures from the server (by customer id): the counts of its whole production, 'reading' or 'failed'. */
  groupCounts?: Readonly<Record<string, WorkOrderCounts | 'reading' | 'failed'>>
  /** The groups folded shut. */
  collapsed?: readonly string[]
  /** The clock the waiting ages count from (ms): the read's, so the cells do not move between renders. */
  now?: number
  // ── end F-PR-03
  // ── F-PR-21 ──
  /** Mine (`?supervisor=me`). */
  supervisor?: 'me' | null
  /** production.brand.manage: "Assign supervisor…" on a selection (held in words without it). */
  supervisorCan?: { readonly manage: boolean }
  /** THE assign dialog while open. */
  assign?: AssignSupervisorModel | null
  // ── end F-PR-21
  /** F-PR-18: the Customer urgency filter (`?customerUrgency=`). */
  customerUrgency?: CustomerUrgencyState | null
  // ── F-PR-22 ──
  /** threads.post: "Note to N…" and a row's "Office note…" (held in words without it). */
  noteCan?: boolean
  /** THE note dialog while open. */
  note?: NoteDialogModel | null
  // ── end F-PR-22
}

export interface WorkOrdersListActions {
  onView?: (view: ListView) => void
  onSearch?: (q: string) => void
  onMore?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onOpen?: (id: string) => void
  /** B-W2b-13: the mode switch, the due quick filter, a cell or Edit N saved (the row's new values and version). */
  onMode?: (mode: ListMode) => void
  onDue?: (due: RelativeDay | null) => void
  onRush?: (rush: boolean) => void
  onSaved?: (id: string, after: Readonly<Record<string, BulkValue>>, version: number) => void
  onReleaseMany?: (ids: string[]) => void
  onRunRelease?: () => void
  onRetryRelease?: () => void
  onCloseRelease?: () => void
  onDismissNotice?: () => void
  onNew?: (open: boolean) => void
  newOrder?: NewWorkOrderActions
  /** B-W2a-46: Hold N and its dialog. */
  daily?: DailyActions
  // ── F-PR-03 ──
  /** Any of the list's terms changed (sort, a computed filter, the grouping); the page writes the address. */
  onTerms?: (next: Partial<ListTerms>) => void
  /** The customer filter picked (null: every customer). */
  onParty?: (party: string | null) => void
  /** A group folded or opened. */
  onToggleGroup?: (key: string) => void
  /** Read a group's figures again. */
  onRetryGroup?: (partyId: string) => void
  /** The columns on screen (a costly column is read only while shown: the readiness word). */
  onShownColumns?: (ids: readonly string[]) => void
  // ── end F-PR-03
  // ── F-PR-21 ──
  /** "Assign supervisor…" on these selected work orders (their orders; at most ASSIGN_MAX). */
  onAssignSupervisor?: (ids: readonly string[]) => void
  supervisor?: AssignSupervisorActions
  // ── end F-PR-21
  // ── F-PR-22 ──
  /** "Note to N…" on a selection, or a row's "Office note…" (at most NOTE_RECORDS_MAX work orders). */
  onNote?: (ids: readonly string[], from: Exclude<NoteFrom, 'band'>) => void
  note?: NoteDialogActions
  // ── end F-PR-22
}

export type { BulkReleaseModel }

/** The "New work order" dialog (design wo-new): a sales order, its open lines of ONE style, the sizes, a due date. */
export interface NewWorkOrderModel {
  query: string
  orders: OrderOption[] | null
  ordersProblem: string | null
  chosen: OrderOption | null
  lines: OpenLines | null
  linesProblem: string | null
  /** The style the work order makes (its lines only). */
  styleId: string | null
  /** The order lines picked (ids). */
  picked: string[]
  /** line id → size → pieces (default: everything still open). */
  grid: Record<string, Record<string, number>>
  /** YYYY-MM-DD, or '' for the earliest promise of the lines (the API's default). */
  dueDate: string
  busy: boolean
  problem: Phrase | null
}

export interface NewWorkOrderActions {
  onQuery?: (q: string) => void
  onChoose?: (order: OrderOption | null) => void
  onStyle?: (styleId: string) => void
  onPick?: (lineId: string, on: boolean) => void
  onGrid?: (grid: Record<string, Record<string, number>>) => void
  onDueDate?: (value: string) => void
  onCreate?: () => void
}

export const NO_NEW_ORDER: NewWorkOrderModel = { query: '', orders: null, ordersProblem: null, chosen: null, lines: null, linesProblem: null, styleId: null, picked: [], grid: {}, dueDate: '', busy: false, problem: null }

/** The lines of the chosen style that a work order may take (nothing open: nothing to take; B-W2b-368: a made-to-measure unit alone). */
export function linesOfStyle(lines: OpenLines | null, styleId: string | null): OpenLines['lines'] {
  if (!lines || !styleId) return []
  return lines.lines.filter((line) => line.styleId === styleId)
}

/** The styles an order's open lines make, in line order (a work order makes one style). */
export function stylesOf(lines: OpenLines | null): Array<{ id: string; code: string; name: string; open: number }> {
  if (!lines) return []
  const styles = new Map<string, { id: string; code: string; name: string; open: number }>()
  for (const line of lines.lines) {
    const style = styles.get(line.styleId) ?? { id: line.styleId, code: line.styleCode, name: line.styleName, open: 0 }
    // B-W2b-368 (XF1:01): a made-to-measure unit is one open piece of its base size, made on its own work order.
    style.open += line.sizes.reduce((sum, size) => sum + size.open, 0)
    styles.set(line.styleId, style)
  }
  return [...styles.values()]
}

/**
 * B-W2b-368 (XF1:01): the lines picked after one is ticked or unticked — a made-to-measure unit is made on its own work order (one
 * garment for one rider), so ticking it leaves it alone, and ticking a size-grid line leaves out a unit picked before.
 */
export function pickedAfter(lines: OpenLines['lines'], picked: readonly string[], lineId: string, on: boolean): string[] {
  if (!on) return picked.filter((id) => id !== lineId)
  const unit = lines.find((line) => line.id === lineId)?.madeToMeasure === true
  if (unit) return [lineId]
  const units = new Set(lines.filter((line) => line.madeToMeasure).map((line) => line.id))
  return [...new Set([...picked.filter((id) => !units.has(id)), lineId])]
}

/** Every open size of a line, as the grid's default. */
export function openGridOf(line: OpenLines['lines'][number]): Record<string, number> {
  return Object.fromEntries(line.sizes.filter((size) => size.open > 0).map((size) => [size.size, size.open]))
}

/** Cells asked above what is still open on their line (the API refuses them): "BLK 52: at most 3". */
export function overOpen(lines: OpenLines['lines'], picked: readonly string[], grid: Readonly<Record<string, Readonly<Record<string, number>>>>): Array<{ lineId: string; size: string; open: number }> {
  const over: Array<{ lineId: string; size: string; open: number }> = []
  for (const line of lines.filter((entry) => picked.includes(entry.id))) {
    for (const size of line.sizes) {
      const asked = grid[line.id]?.[size.size] ?? 0
      if (asked > size.open) over.push({ lineId: line.id, size: size.size, open: size.open })
    }
  }
  return over
}

/** The pieces the new work order would make. */
export function newPieces(picked: readonly string[], grid: Readonly<Record<string, Readonly<Record<string, number>>>>): number {
  return picked.reduce((sum, lineId) => sum + Object.values(grid[lineId] ?? {}).reduce((acc, value) => acc + value, 0), 0)
}

/** Why "Create draft" waits, or null when it may go. */
export function createHeld(model: NewWorkOrderModel, can: ProductionCan): Phrase | null {
  if (!can.manage) return { key: 'held.noManage' }
  if (!model.chosen) return { key: 'new.held.order' }
  if (model.picked.length === 0) return { key: 'new.held.lines' }
  const lines = linesOfStyle(model.lines, model.styleId)
  if (overOpen(lines, model.picked, model.grid).length > 0) return { key: 'new.held.over' }
  if (newPieces(model.picked, model.grid) === 0) return { key: 'new.held.pieces' }
  if (model.busy) return { key: 'held.busy' }
  return null
}

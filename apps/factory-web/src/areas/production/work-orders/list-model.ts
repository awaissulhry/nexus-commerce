import type { LiveState } from '../_shared/hooks'
import type { OpenLines, OrderOption, ReleaseCheckCode, WorkOrderCounts, WorkOrderRow } from '../_shared/api'
import type { ListView, Phrase, ProductionCan } from '../_shared/model'
import type { ReadinessRow } from './daily/api'
import type { DailyActions, DailyModel } from './daily/model'

/** SCR-069 — the work orders list's view model (WorkOrdersListView draws it and fetches nothing). */
export interface WorkOrdersListModel {
  /** `/w/<company>`. */
  prefix: string
  can: ProductionCan
  view: ListView
  q: string
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
}

export interface WorkOrdersListActions {
  onView?: (view: ListView) => void
  onSearch?: (q: string) => void
  onMore?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onOpen?: (id: string) => void
  onExport?: (ids: string[]) => void
  onReleaseMany?: (ids: string[]) => void
  onRunRelease?: () => void
  onCloseRelease?: () => void
  onDismissNotice?: () => void
  onNew?: (open: boolean) => void
  newOrder?: NewWorkOrderActions
  /** B-W2a-46: Hold N and its dialog. */
  daily?: DailyActions
}

/** "Release N work orders": each is checked again by the API; the ones that pass are released, the others stay drafts. */
export interface BulkReleaseModel {
  rows: Array<{ id: string; number: string; styleCode: string }>
  running: boolean
  done: boolean
  results: Record<string, { state: 'released'; batchNumber: string | null } | { state: 'held'; codes: ReleaseCheckCode[] } | { state: 'failed'; words: Phrase }>
}

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

/** The lines of the chosen style that a work order may take (made-to-measure lines come later; nothing open: nothing to take). */
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
    style.open += line.madeToMeasure ? 0 : line.sizes.reduce((sum, size) => sum + size.open, 0)
    styles.set(line.styleId, style)
  }
  return [...styles.values()]
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

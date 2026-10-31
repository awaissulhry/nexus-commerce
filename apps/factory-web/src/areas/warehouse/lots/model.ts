import type { LiveState } from '../../_shared/buying/hooks'
import type { LotCounts, LotQuery, LotRecord, LotRow } from '../../_shared/stock/api'
import type { StockCan } from '../../_shared/stock/model'
import type { RecordPanelsViewModel } from '../../../record-panels/model'
import type { ReleaseCheck, ReleaseChecklist } from './api'
import type { Loaded, Part } from './shared/model'
import type { MovesPart } from './shared/parts'
import type { DailyCan } from './shared/daily'
import type { PickerReason } from '../../_shared/reasons/api'
import type { Figures, HoldRow, Reservation, Trace } from '../stock/daily/api'
import type { WriteOffActions, WriteOffDialogModel } from '../stock/daily/dialog-model'
import type { TraceFindModel } from './trace/model'
import type { TraceFindActions } from './trace/TraceDialog'
import type { ReleaseActions, ReleaseDialogModel } from './release/model'

/**
 * Warehouse › Lots & traceability (SCR-201 the list, SCR-201-record a lot), pure: the saved views and tiles ⇄ the
 * address and the API's own filters, the record's tabs, each release check in our words (from its code and state), and
 * the trace in one sentence. Holds are reached here (Owner answer Q3 (a)): the tiles In quarantine, Waiting for Cr VI
 * evidence, Cr VI failed and Blocked are saved views.
 */

export const LOT_VIEWS = ['waiting', 'inStock', 'all', 'released', 'rejected', 'quarantine', 'crViPending', 'crViFailed', 'blocked'] as const
export type LotView = (typeof LOT_VIEWS)[number]
/** The views offered in the menu (the tiles' views too: a tile pressed shows its name there). */
export const LOT_MENU_VIEWS: readonly LotView[] = LOT_VIEWS

/** The default view: quality waits for release; everyone else sees the lots that hold stock. */
export const defaultLotView = (can: Pick<StockCan, 'lotsRelease'>): LotView => (can.lotsRelease ? 'waiting' : 'inStock')

export function lotViewOf(params: { get(name: string): string | null } | null, can: Pick<StockCan, 'lotsRelease'>): LotView {
  const asked = params?.get('view') ?? ''
  if ((LOT_VIEWS as readonly string[]).includes(asked)) return asked as LotView
  // The API's own filters in the address (a link from Today or a list route).
  if (params?.get('onHold') === 'true') return 'waiting'
  if (params?.get('quality') === 'BLOCKED') return 'blocked'
  if (params?.get('quality') === 'QUARANTINE') return 'quarantine'
  if (params?.get('crVi') === 'PENDING') return 'crViPending'
  if (params?.get('crVi') === 'FAIL') return 'crViFailed'
  return defaultLotView(can)
}

/** A view as the API's filters. */
export function lotQuery(view: LotView, q: string, siteId: string | null, cursor: string | null = null): LotQuery {
  const base: LotQuery = { siteId, q: q.trim() || null, cursor, limit: 50 }
  switch (view) {
    case 'waiting':
      return { ...base, onHold: true }
    case 'inStock':
      return { ...base, inStock: true }
    case 'released':
      return { ...base, quality: 'RELEASED' }
    case 'rejected':
      return { ...base, quality: 'REJECTED' }
    case 'quarantine':
      return { ...base, quality: 'QUARANTINE' }
    case 'blocked':
      return { ...base, quality: 'BLOCKED' }
    case 'crViPending':
      return { ...base, crVi: 'PENDING' }
    case 'crViFailed':
      return { ...base, crVi: 'FAIL' }
    default:
      return base
  }
}

export interface LotTile {
  id: 'quarantine' | 'crViPending' | 'crViFailed' | 'blocked'
  view: LotView
  count: (counts: LotCounts | null) => number | null
}
export const LOT_TILES: readonly LotTile[] = [
  { id: 'quarantine', view: 'quarantine', count: (counts) => counts?.quarantine ?? null },
  { id: 'crViPending', view: 'crViPending', count: (counts) => counts?.waitingCrVi ?? null },
  { id: 'crViFailed', view: 'crViFailed', count: (counts) => counts?.crViFailed ?? null },
  { id: 'blocked', view: 'blocked', count: (counts) => counts?.blocked ?? null },
]

/** A lot code typed or scanned that is the one hit: open it (a scanned label opens its record, design R7). */
export function exactLot(q: string, rows: readonly Pick<LotRow, 'id' | 'code'>[] | null): string | null {
  const needle = q.trim().toLowerCase()
  if (!needle || !rows) return null
  const hits = rows.filter((row) => row.code.toLowerCase() === needle)
  return hits.length === 1 ? hits[0]!.id : null
}

export interface SiteChoice {
  id: string
  code: string
  name: string
}

export interface LotsListModel {
  prefix: string
  can: StockCan
  view: LotView
  q: string
  sites: readonly SiteChoice[]
  siteId: string | null
  rows: { items: readonly LotRow[] | null; more: boolean; problem: string | null }
  counts: LotCounts | null
  asOf: string | null
  live: LiveState
  updates: number
  timeZone: string
  /** B-W2a-64: release N lots and the Trace dialog. */
  daily: DailyCan
  release: ReleaseDialogModel | null
  find: TraceFindModel | null
  /** Design cases: rows selected, the keys panel open. */
  selected?: readonly string[]
  helpOpen?: boolean
}

export interface LotsListActions {
  onView?: (view: LotView) => void
  onSearch?: (q: string) => void
  onSite?: (siteId: string | null) => void
  onMore?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onOpen?: (id: string) => void
  onExport?: (ids: readonly string[]) => void
  /** B-W2a-64: Release N lots (the selection) and Trace…. */
  onRelease?: (ids: readonly string[]) => void
  release?: ReleaseActions
  onTrace?: () => void
  find?: TraceFindActions
}

// ---- the record ------------------------------------------------------------------------------------------------------------

/** B-W2a-64: Quality status (holds and inspections) after the overview, as the design orders the tabs. */
export const LOT_TABS = ['overview', 'quality', 'trace', 'moves', 'activity'] as const
export type LotTab = (typeof LOT_TABS)[number]
export const lotTabOf = (value: string | null | undefined): LotTab => ((LOT_TABS as readonly string[]).includes(value ?? '') ? (value as LotTab) : 'overview')

/**
 * A release check in our words: a key of `warehouse-lots` per code and state (the API's English is never drawn); an
 * open state check says the lot's state (already released, rejected, blocked, in quarantine).
 */
export const checkKey = (check: Pick<ReleaseCheck, 'code' | 'state'>, status?: LotRow['qualityStatus']): string =>
  check.code === 'STATE' && check.state === 'OPEN' && status ? `lt.check.STATE.is${status}` : `lt.check.${check.code}.${check.state}`

/** The checklist's head in words: released, ready, or held with the count of open checks. */
export function checklistHead(checklist: ReleaseChecklist, status: LotRow['qualityStatus']): { key: string; count: number } {
  const open = checklist.checks.filter((check) => check.state === 'OPEN').length
  if (status === 'RELEASED') return { key: 'lt.release.released', count: 0 }
  if (status === 'REJECTED') return { key: 'lt.release.rejected', count: 0 }
  if (checklist.ready) return { key: checklist.mode === 'UNBLOCK' ? 'lt.release.readyUnblock' : 'lt.release.ready', count: 0 }
  return { key: 'lt.release.open', count: open }
}

/** "Used in 3 work orders · 2 shipments · 2 customers", or that it was not used yet. */
export function traceSummary(trace: LotRecord['trace']['forward']): { key: string; params: Record<string, number> } {
  if (trace.workOrders.length === 0) return { key: 'lt.trace.notUsed', params: {} }
  return { key: 'lt.trace.used', params: { orders: trace.workOrders.length, shipments: trace.shipments.length, customers: trace.customers } }
}

export interface LotRecordModel {
  prefix: string
  can: StockCan
  tab: LotTab
  record: Loaded<LotRecord>
  /** The release checklist (quality.lots.view only; null value + null problem: still loading; absent without it). */
  checklist: Part<ReleaseChecklist> | null
  moves: Part<MovesPart>
  live: LiveState
  asOf: string | null
  changed: { at: string } | null
  dockOpen: boolean
  timeZone: string
  /** B-W2a-64: abilities; the lot's site figures and its ACTIVE reservations (overview); the trace (Trace tab); the holds
   * of the lot and of its hides (Quality status tab; null without quality.holds.view); the HOLD reasons' words. */
  daily: DailyCan
  figures: Part<LotFigures> | null
  trace: Part<Trace> | null
  holds: Part<LotHolds> | null
  holdReasons: readonly PickerReason[]
  writeOff: WriteOffDialogModel | null
  find: TraceFindModel | null
  /** Design cases: the record panels drawn without the API; the trace's "affected customers" on. */
  panelsPreview?: RecordPanelsViewModel | null
  affectedOnly?: boolean
}

/** The lot at its site (reservations hold a site's stock, not a place) and who reserved it. */
export interface LotFigures {
  lot: Figures | null
  reservations: readonly Reservation[]
}

/** The holds that touch a lot: on the lot itself (any status) and on its hides. */
export interface LotHolds {
  lot: readonly HoldRow[]
  hides: readonly HoldRow[]
}

export interface LotRecordActions {
  onRetry?: () => void
  onRetryChecklist?: () => void
  onRetryMoves?: () => void
  onMoreMoves?: () => void
  onReload?: () => void
  onDock?: () => void
  onRetryFigures?: () => void
  onRetryTrace?: () => void
  onRetryHolds?: () => void
  /** Write off the lot's stock at one place (a rejected lot's stock, design lt-reject). */
  onWriteOff?: (locationId: string) => void
  writeOff?: WriteOffActions
  onTrace?: () => void
  find?: TraceFindActions
}

/** Holds of one kind, newest first, with how many are still on (design lt-holds: grouped by kind with counts). */
export function holdGroups(holds: LotHolds): { kind: 'Lot' | 'Hide'; rows: readonly HoldRow[]; active: number }[] {
  const order = (rows: readonly HoldRow[]) => [...rows].sort((a, b) => b.placedAt.localeCompare(a.placedAt))
  return [
    { kind: 'Lot' as const, rows: order(holds.lot), active: holds.lot.filter((hold) => hold.status === 'ACTIVE').length },
    { kind: 'Hide' as const, rows: order(holds.hides), active: holds.hides.filter((hold) => hold.status === 'ACTIVE').length },
  ].filter((group) => group.rows.length > 0)
}

/** A rejected lot that still has stock: what happens to it (return to the supplier or write it off) is asked. */
export const rejectedWithStock = (record: Pick<LotRecord, 'lot' | 'stock'>): boolean => record.lot.qualityStatus === 'REJECTED' && record.stock.some((row) => row.onHand !== '0.0000')

/** The CSV columns of Export N (the header words are the catalogue's `lt.csv.<column>`). */
export const LOT_CSV_COLUMNS = ['code', 'material', 'colour', 'supplier', 'supplierLot', 'dyeBatch', 'shade', 'received', 'receipt', 'quality', 'crVi', 'crViValue', 'evidence', 'documents', 'onHand', 'unit', 'hides', 'issuedTo'] as const

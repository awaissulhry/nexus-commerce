import type { LiveState } from '../../_shared/buying/hooks'
import type { PlanningSite } from '../board/api'
import type { Capacity, CapacityBucket, CellOrders } from './api'
import type { Heatmap, Subcontractors, WorkshopCellJobs } from './depth/api'
import type { CapacityControls, CapacityTile } from './model'

/** A heatmap cell's detail (design: "Click a cell = the same DetailModal"): a lane's orders or a workshop's work. */
export type HeatDetail = { kind: 'lane'; orders: CellOrders } | { kind: 'workshop'; jobs: WorkshopCellJobs }

/**
 * The ONE view model of Planning › Capacity & load (SCR-123) and what it may ask for. The view fetches nothing: the page
 * container (CapacityPage.tsx) reads the API and fills this; the design cases fill it with made-up data.
 */

export type Loaded<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string }

export interface CapacityModel {
  prefix: string
  /** planning.view (the page), planning.settings.manage (Capacity settings is a link either way). */
  canView: boolean
  sites: Loaded<PlanningSite[]>
  siteId: string | null
  controls: CapacityControls
  capacity: Loaded<Capacity>
  /** The open cell's orders (`?cell=`), read when it opens. */
  cell: { key: string; orders: Loaded<CellOrders> } | null
  /** B-W2b-338: the workshops' capacity lines over the same period (the table's workshop rows, the tile). */
  subcontractors?: Loaded<Subcontractors>
  /** The open workshop cell's work (`?cell=WORKSHOP:…`). */
  workshopCell?: { key: string; jobs: Loaded<WorkshopCellJobs> } | null
  /** The load heatmap (lanes down, weeks across). */
  heatmap?: Loaded<Heatmap>
  /** The open heatmap cell (`?heat=`). */
  heatCell?: { key: string; detail: Loaded<HeatDetail> } | null
  live: LiveState
  /** Live changes (a move on the board, a calendar, a work order) read the capacity again: "N updates · Show". */
  updates: number
  dialog: { kind: 'keys' } | null
  /** Design cases: preset selection, focused row, keys panel. */
  selected?: readonly string[]
  focusRow?: number
  keysOpen?: boolean
}

export interface CapacityActions {
  onSite?: (siteId: string) => void
  onPeriod?: (period: { from: string | null; to: string | null }) => void
  onBucket?: (bucket: CapacityBucket) => void
  onTile?: (tile: CapacityTile | null) => void
  /** Open a cell's orders (null: close). */
  onCell?: (key: string | null) => void
  onRetry?: () => void
  onRetryCell?: () => void
  /** Open a heatmap cell (null: close). */
  onHeat?: (key: string | null) => void
  onRetryHeat?: () => void
  onRetryHeatCell?: () => void
  onRetrySubcontractors?: () => void
  onShowUpdates?: () => void
  onExport?: (laneKeys: string[]) => void
  onPrint?: () => void
  onKeys?: () => void
  onCloseDialog?: () => void
}

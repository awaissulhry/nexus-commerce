import type { LiveState } from '../../_shared/buying/hooks'
import type { PlanningSite } from '../board/api'
import type { Capacity, CapacityBucket, CellOrders } from './api'
import type { CapacityControls, CapacityTile } from './model'

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
  onShowUpdates?: () => void
  onExport?: (laneKeys: string[]) => void
  onPrint?: () => void
  onKeys?: () => void
  onCloseDialog?: () => void
}

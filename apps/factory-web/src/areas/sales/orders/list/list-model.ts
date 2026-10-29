import type { OrderBoard, OrderRow } from '../api'
import type { LiveState } from '../hooks'
import type { Lane, Layout, OrderAbilities, Phrase, RowView } from '../model'

/** SCR-038 — the orders list's view model (OrdersListView draws it and fetches nothing). */
export interface OrdersListModel {
  /** `/w/<company>`. */
  prefix: string
  can: OrderAbilities
  /** Today in the site's zone (YYYY-MM-DD): late and overdue words. */
  today: string
  layout: Layout
  rows: RowView
  q: string
  list: { items: OrderRow[] | null; more: boolean; problem: string | null }
  /** The board's lanes (read only for the board layout). */
  lanes: Lane[]
  /** The counts by state and the tiles; null while unread or when the read failed (the tiles say "—"). */
  board: OrderBoard | null
  /** When the rows were read (ISO). */
  asOf: string | null
  live: LiveState
  /** Live changes waiting behind "N updates · Show" (rows never move under the cursor). */
  updates: number
  notice: { tone: 'success' | 'warning' | 'danger' | 'info'; words: Phrase } | null
  /** Design cases: the starting selection, the focused row, the keys panel. */
  selected?: string[]
  focusRow?: number
  helpOpen?: boolean
}

export interface OrdersListActions {
  onRows?: (rows: RowView) => void
  onLayout?: (layout: Layout) => void
  onSearch?: (q: string) => void
  onMore?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onOpen?: (id: string) => void
  onExport?: (ids: string[]) => void
  onDismissNotice?: () => void
}

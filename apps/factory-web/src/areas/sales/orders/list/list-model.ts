import type { CompanyRef } from '../../../../lib/session/session'
import type { PartyDetail, PartyRow } from '../../quotes/api'
import type { OrderBoard, OrderRow } from '../api'
import type { LiveState } from '../hooks'
import type { Lane, Layout, OrderAbilities, Phrase, RowView } from '../model'

/** SCR-038 — the orders list's view model (OrdersListView draws it and fetches nothing). */

/** The New order dialog (design pop:orders.new, B-W2a-50): customer, contact, customer PO, the number it will get. */
export interface NewOrderDialogModel {
  /** The selling companies the person may take orders for (asked only when there are several). */
  companies: readonly CompanyRef[]
  companyId: string
  /** null: not searched yet. */
  results: PartyRow[] | null
  searchProblem: string | null
  /** The customer picked, read in full (contacts, tax identity, warnings). */
  party: PartyDetail | null
  partyProblem: string | null
  contactId: string
  customerRef: string
  /** The number it will get: undefined while read, null when the company has no single active series. */
  number: string | null | undefined
}
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
  /** B-W2a-50: the New order dialog, open; null: closed. */
  newOrder?: NewOrderDialogModel | null
  /** B-W2a-72: each order's margin % as estimated now (undefined: still reading; null: not known); null: the column is not drawn. */
  margins?: ReadonlyMap<string, string | null> | null
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
  // B-W2a-50: New order (the dialog makes a draft on the screen; the order is made by "Confirm order").
  onNewOrder?: (open: boolean) => void
  onNewCompany?: (companyId: string) => void
  onNewSearch?: (query: string) => void
  onNewPick?: (partyId: string | null) => void
  onNewField?: (field: 'contactId' | 'customerRef', value: string) => void
  onNewCreate?: () => void
}

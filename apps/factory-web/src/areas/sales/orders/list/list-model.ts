import type { CompanyRef } from '../../../../lib/session/session'
import type { PartyDetail, PartyRow } from '../../quotes/api'
import type { OrderBoard, OrderRow, OrderSort } from '../api'
import type { LiveState } from '../hooks'
import type { Lane, Layout, OrderAbilities, Phrase, RowView } from '../model'
// ---- B-W2b-323 (orders in depth on screen) ----
import type { ListDepthActions, ListDepthModel } from '../list-depth/use-list-depth'
import type { OrdersImportModel } from '../import/view/OrdersImportView'
import type { OrdersImportActions } from '../import/use-orders-import' // B-TH-293
import type { WeekModel } from '../week/use-promise-week'
// ---- B-TH-225 / B-TH-226 (TH-1a: the Orders sheet and the Customer switcher) ----
import type { PictureLoader } from './sheet/parts'
import type { SwitcherState } from './sheet/model'

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
  /** B-TH-221: the one pointer — a written request goes to Incoming's New request (null: the person makes no request). */
  incomingHref?: string | null
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
  // ---- B-W2b-323 (orders in depth on screen) ----
  /** The Priority and Season columns, the inline priority, Set priority on a selection; null/absent: not drawn. */
  depth?: ListDepthModel | null
  /** By promise week (`?view=week`); null/absent: not read. */
  week?: WeekModel | null
  /** Import orders (band ⋯): why it is held, and the wizard while open. */
  importer?: (OrdersImportModel & { held: string | null }) | null
  /**
   * B-TH-201: the customer the address narrows the list to (`?party=`): its name once known (undefined while it is looked
   * up; null when the person may not open that customer: the chip names no one); null/absent: every customer.
   */
  customer?: { id: string; name: string | null | undefined } | null
  // ---- B-TH-225 / B-TH-226 (TH-1a: the Orders sheet and the Customer switcher) ----
  /** The label on the garment the address narrows the sheet to (`?brand=<party>|own`), and its name once known. */
  brand?: { value: string; name: string | null } | null
  /** The company the address narrows the sheet to (`?company=`): its id and name. */
  company?: { id: string; name: string } | null
  // ---- B-TH-057 (TH-4: the server sort and the custom field filter) ----
  /** The server sort of the address (null: newest first): the header of the column it sorts by shows it. */
  sort?: OrderSort | null
  /** The custom field filter of the address (`?cf=`), shown as a chip (never a hidden filter); null: none. */
  cf?: string | null
  /** The companies the reader sees: the Company column and its funnel only from two on. */
  companies?: ReadonlyArray<{ id: string; name: string }>
  /** The Customer switcher: the reader's customers, their counts, a limited reader (null: not drawn). */
  switcher?: (SwitcherState & { query: string; searching: boolean }) | null
  /** Design cases: each row's picture as an address (the page loads the small previews through `actions.loadPicture`). */
  demoPictures?: Readonly<Record<string, string>>
  /** Design cases: the viewer open on a row, the switcher open, the widths that show the wide columns. */
  viewerOpen?: string | null
  switcherOpen?: boolean
  wide?: boolean
  /** Design cases: the starting selection, the focused row, the keys panel. */
  selected?: string[]
  focusRow?: number
  helpOpen?: boolean
}

export interface OrdersListActions {
  onRows?: (rows: RowView) => void
  onLayout?: (layout: Layout) => void
  onSearch?: (q: string) => void
  /** B-TH-201: the customer chip's ✕ (every customer again). B-TH-226: the switcher's pick (null: every customer). */
  onClearCustomer?: () => void
  onCustomer?: (party: string | null) => void
  /** B-TH-225: Clear all / Clear filters — the search, the view, the customer, the label and the company at once. */
  onClearAll?: () => void
  onCustomerSearch?: (query: string) => void
  onCustomerRetry?: () => void
  /** B-TH-225: the funnels (Brand, Status, Company) and their chips' ✕; null clears. */
  onBrand?: (brand: string | null) => void
  onCompany?: (company: string | null) => void
  /** B-TH-057: a header click or the Sort menu (null: newest first again); the custom field chip's ✕. */
  onSort?: (sort: OrderSort | null) => void
  onClearCf?: () => void
  /** B-TH-225: the small preview of a row's picture (null: the placeholder). */
  loadPicture?: PictureLoader
  /** B-TH-225: the rest of a row opens the order (⌘ / Ctrl: a new tab). */
  onOpenRow?: (id: string, newTab: boolean) => void
  onMore?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onOpen?: (id: string) => void
  onDismissNotice?: () => void
  // B-W2a-50: New order (the dialog makes a draft on the screen; the order is made by "Confirm order").
  onNewOrder?: (open: boolean) => void
  onNewCompany?: (companyId: string) => void
  onNewSearch?: (query: string) => void
  onNewPick?: (partyId: string | null) => void
  onNewField?: (field: 'contactId' | 'customerRef', value: string) => void
  onNewCreate?: () => void
  // ---- B-W2b-323 (orders in depth on screen) ----
  depth?: ListDepthActions
  onImport?: () => void
  importActions?: OrdersImportActions // B-TH-293: + Use them (a customer's remembered columns)
  onWeekSite?: (siteId: string) => void
  onWeekRetry?: () => void
}

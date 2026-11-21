import { isApiError, issuePath } from '../../../lib/api/errors'
import { YES_REFUSALS } from './depth/model' // F-OP-101
import { bannerYesOf, yesDoorOf } from './depth/model' // F-OP-102
import type { Locale } from '../../../lib/i18n/locales'
import {
  BOARD_LANES,
  ORDER_SORT_KEYS, // B-TH-057
  ORDER_STATUSES,
  SETTLEMENT_GAPS,
  type BoardLane,
  type ChainInvoice,
  type DepositRequest,
  type DepositState,
  type Order,
  type OrderAction,
  type OrderBoard,
  type OrderQuery,
  type OrderRow,
  type OrderSort, // B-TH-057
  type OrderSortKey, // B-TH-057
  type OrderStatus,
  type Progress,
  type SdiStateCode,
  type TileKey,
} from './api'
import { CUSTOMER_URGENCIES, INVOICED_STATES, type CustomerUrgency, type InvoicedState } from './api' // B-TH-244
import { PRICE_MATCHES, type PriceMatch } from './api' // F-CP-141: the price check term (the Not equal view)
import type { DockDefault } from '../../_shared/record-frame/model' // F-SA-263
// ---- F-OP-111: Split into new orders… (the API's own limits; the body the split sends) ----
import { ORDERS_DEPTH_LIMITS } from '@nexus/factory-domain/sales/orders-depth/rules'
import { releasedPiecesOf } from '@nexus/factory-domain/sales/orders/orders' // F-OO-112: Mark ready's held counts (B-OO-002's one rule)
import { orderLinkCountsOf } from '@nexus/factory-domain/sales/orders/linked-counts' // F-OO-206: the tabs count as the Linked card (one rule)
// F-OO-142: the curated reasons a promise move shows the customer (B-OO-009 sends the code; the portal reads these words).
import { PROMISE_REASON_CODES, PROMISE_REASON_WORDS, type PromiseReasonCode } from '@nexus/factory-domain/sales/portal-orders/promise'
import type { ApiIssue } from '../../../lib/api/errors'
import type { SplitBody } from './api'

/**
 * The sales order screens' pure rules (SCR-038 list and board, SCR-039 the order studio; B-W1-25 part 2): what a person
 * may do (permissions) and see (grains), the saved rows and the address that holds them, the board's lanes, the next
 * step by state and why it is held, the deposit's steps (requested → bank-details page → paid → TD02 → SDI) and the
 * money in words. No fetching, no React: the tests hold them.
 */

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

/** A message key and its values, translated by the view (`orders` catalogue). */
export interface Phrase {
  key: string
  params?: Record<string, string | number>
}
const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

export interface OrderAbilities {
  view: boolean
  manage: boolean
  /** Close an order that is not settled (with a reason). */
  close: boolean
  /** Record a payment and send the bank-details page. */
  recordPayment: boolean
  viewPayments: boolean
  viewInvoices: boolean
  /** Issue the TD02 (with a fresh step-up) and send an invoice to SDI. */
  issueInvoices: boolean
  /** B-TH-244: make invoice drafts (Finance's From-DDTs dialog: "Invoice shipped goods for N"). */
  manageInvoices: boolean
  viewWorkOrders: boolean
  makeWorkOrders: boolean
  viewQuotes: boolean
  /** Copy an order as a new quote (B-W2a-30). */
  manageQuotes: boolean
  /** Plan a shipment from the order's released garments (Warehouse › Shipments: shipping.manage). */
  createShipment: boolean
  price: boolean
  cost: boolean
  margin: boolean
  /** F-SA-214 / B-SA-020: rider profiles (sales.measurements.view): the riders' names, the review's door, the rider term. */
  measurements: boolean
  /** F-PT-302: raise a nonconformance from the order's final check (quality.ncr.raise; Quality's own New NCR). */
  raiseNcr?: boolean
  /** Lead's W3 extra: decide a gate's sample round for the customer (production.brand.override; Planning's MilestoneDialog). */
  decideForCustomer?: boolean
  /** F-OC-103: ask the customer for an approval and see what was asked (partners.approvals.ask): Changes › "Manage in the thread…". */
  askCustomer?: boolean
}

export function abilitiesOf(permissions: readonly string[]): OrderAbilities {
  const held = new Set(permissions)
  return {
    view: held.has('orders.view'),
    manage: held.has('orders.manage'),
    close: held.has('orders.close'),
    recordPayment: held.has('payments.record'),
    viewPayments: held.has('payments.view'),
    viewInvoices: held.has('invoices.view'),
    issueInvoices: held.has('invoices.issue'),
    manageInvoices: held.has('invoices.manage'), // B-TH-244
    viewWorkOrders: held.has('workorders.view'),
    makeWorkOrders: held.has('workorders.manage'),
    viewQuotes: held.has('quotes.view'),
    manageQuotes: held.has('quotes.manage'),
    createShipment: held.has('shipping.manage'),
    price: held.has('money.price'),
    cost: held.has('money.cost'),
    margin: held.has('money.margin'),
    measurements: held.has('sales.measurements.view'), // F-SA-214
    raiseNcr: held.has('quality.ncr.raise'), // F-PT-302
    decideForCustomer: held.has('production.brand.override'), // W3 extra: Decide for {customer}…
    askCustomer: held.has('partners.approvals.ask'), // F-OC-103
  }
}

// ---- F-OP-303 (order page walk #6): the read-only banner counts every right the page acts on --------------------------------
/**
 * The rights of `abilitiesOf` with which the order page changes something: the order (manage, close), its money (a payment, an
 * invoice issued or drafted), its work orders, its shipments (Create shipment…, Tracking number…, Record a shipment made
 * elsewhere…: shipping.manage) and a copy as a new quote.
 */
export const PAGE_ACT_RIGHTS = ['manage', 'close', 'recordPayment', 'issueInvoices', 'manageInvoices', 'makeWorkOrders', 'createShipment', 'manageQuotes'] as const satisfies readonly (keyof OrderAbilities)[]

/**
 * "Read-only: your role follows orders and changes none." only for a reader who holds none of them, nor the page's other acting
 * rights (assign the supervisor: production.brand.manage; a quality hold on a work order: quality.holds.place). The walk saw it for
 * Warehouse on the very tab where Warehouse creates shipments and types tracking.
 */
export function readOnlyOnPage(can: Pick<OrderAbilities, (typeof PAGE_ACT_RIGHTS)[number]>, more: { readonly assignSupervisor?: boolean; readonly qualityHold?: boolean } = {}): boolean {
  return PAGE_ACT_RIGHTS.every((key) => !can[key]) && !more.assignSupervisor && !more.qualityHold
}
// ---- end F-OP-303

// ---- words and tones ---------------------------------------------------------------------------------------------------

export const STATUS_TONE: Record<OrderStatus, Tone> = {
  CONFIRMED: 'neutral',
  IN_PRODUCTION: 'info',
  READY: 'info',
  PARTLY_SHIPPED: 'warning',
  SHIPPED: 'success',
  CLOSED: 'neutral',
  CANCELLED: 'danger',
  PENDING_APPROVAL: 'warning',
  DELIVERED: 'success',
}

/** The deposit's state as the list shows it: the tone, and "overdue" once its due day passed while open. */
export function depositTone(state: DepositState, dueDate: string | null, today: string): Tone {
  if (state === 'PAID') return 'success'
  if (state === 'MISSING') return 'danger'
  if (state === 'OPEN') return dueDate !== null && dueDate < today ? 'danger' : 'warning'
  return 'neutral'
}

/** Whole days from `today` to `day` (YYYY-MM-DD); negative when past. */
export function daysUntil(day: string, today: string): number {
  return Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000)
}

/** A business day (YYYY-MM-DD) as a date in the person's language, at noon UTC so no zone moves it a day. */
export const dayInstant = (day: string): string => `${day}T12:00:00Z`

// ---- the saved rows, the address, the API query (one filter model) -------------------------------------------------------

// B-W2b-323: + reaccept (a change waits for the customer to accept it: `?reaccept=true`).
// B-TH-244: + uninvoiced (the built-in view "Shipped, not invoiced": `?shippedNotInvoiced=true`, grouped by customer).
export const ROW_VIEWS = ['open', 'late', 'deposit', 'reaccept', 'uninvoiced', ...ORDER_STATUSES, 'all'] as const
export type RowView = (typeof ROW_VIEWS)[number]
// B-W2b-323: + week (By promise week, `?view=week`).
export type Layout = 'list' | 'board' | 'week'

const isStatus = (value: string | null | undefined): value is OrderStatus => !!value && (ORDER_STATUSES as readonly string[]).includes(value)

/**
 * The saved rows from the address. The address names the API's own filters (`?late=true`, `?deposit=OPEN`,
 * `?status=READY`; Home › Today's "See all" links build them so), `?rows=all` every order; nothing: the open ones.
 */
export function rowsFromAddress(params: { get(name: string): string | null } | null): RowView {
  if (!params) return 'open'
  if (params.get('late') === 'true') return 'late'
  if (params.get('deposit') === 'OPEN') return 'deposit'
  if (params.get('reaccept') === 'true') return 'reaccept' // B-W2b-323
  if (params.get('shippedNotInvoiced') === 'true') return 'uninvoiced' // B-TH-244
  const status = params.get('status')
  if (isStatus(status)) return status
  if (params.get('rows') === 'all') return 'all'
  return 'open'
}

export const layoutFromAddress = (params: { get(name: string): string | null } | null): Layout => (params?.get('view') === 'board' ? 'board' : params?.get('view') === 'week' ? 'week' /* B-W2b-323 */ : 'list')

// ── B-TH-201 (SHEET-G11, SHEET-G01): one customer's orders, `?party=<id>` ──
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The customer the address narrows the list to (`?party=<id>`; Sales › Reports' drill sends it), or null. */
export function partyFromAddress(params: { get(name: string): string | null } | null): string | null {
  const value = params?.get('party')?.trim() ?? ''
  return UUID.test(value) ? value.toLowerCase() : null
}

// B-TH-226: the chip "Customer: <name>" of TH-0 went: the sheet's own chips (list/sheet) name every narrowing.

// ── F-SA-221 (sales page plan N7, pick P12; 12-lists-board §4.1): made-to-measure orders, `?kind=mtm` ──
/** The made-to-measure term of the address: `mtm`, or null (another value narrows nothing: the sheet never guesses). */
export const kindFromAddress = (params: { get(name: string): string | null } | null): 'mtm' | null => (params?.get('kind') === 'mtm' ? 'mtm' : null)
// ── end F-SA-221 ──

// ── F-SA-276 (sales page plan R5; the API's B-SA-070): the customer's Work tab's "Waiting on us", `?waiting=us` ──
/** The waiting term of the address: `us` (the keeper says the order waits on us, or a customer request on it is OPEN), or null. */
export const waitingFromAddress = (params: { get(name: string): string | null } | null): 'us' | null => (params?.get('waiting') === 'us' ? 'us' : null)
// ── end F-SA-276 ──

// ── F-SA-222 (sales page plan N7, pick P12; 12-lists-board §4.2): a rider's orders, `?profile=<id>` ──
/** The rider term of the address (a profile id: any revision of the rider's garment profile), or null. */
export function profileFromAddress(params: { get(name: string): string | null } | null): string | null {
  const value = params?.get('profile')?.trim() ?? ''
  return UUID.test(value) ? value.toLowerCase() : null
}
// ── end F-SA-222 ──

// ── B-TH-225: Brand and Company narrow the sheet (`?brand=<party id>|own`, `?company=<id>`) ──
/** The label on the garment the address narrows the sheet to: a brand party's id, `own` (our own collection), or null. */
export function brandFromAddress(params: { get(name: string): string | null } | null): string | null {
  const value = params?.get('brand')?.trim() ?? ''
  if (value === 'own') return 'own'
  return UUID.test(value) ? value.toLowerCase() : null
}

/** The company the address narrows the sheet to (`?company=<id>`), or null. */
export function companyFromAddress(params: { get(name: string): string | null } | null): string | null {
  const value = params?.get('company')?.trim() ?? ''
  return UUID.test(value) ? value.toLowerCase() : null
}

/** What narrows every read beside the rows view and the search: the customer, the label, the company. */
export interface Narrowing {
  readonly brand?: string | null
  readonly companyId?: string | null
  /** B-TH-057: the custom field filter of the address (`?cf=`), applied by the list, its counts and its file alike. */
  readonly cf?: string | null
  /** B-TH-057: the server sort of the address (`?sort=`); the rows read in that order (the counts do not change). */
  readonly sort?: OrderSort | null
  /** B-TH-244: the door terms beside the rows view (a total of the overall view opened exactly its rows). */
  readonly extra?: ExtraTerms | null
  /** B-TH-244: count each row's production progress (the Progress column is shown). */
  readonly progress?: boolean
  /** F-SA-221: made-to-measure orders only (`?kind=mtm`). */
  readonly kind?: 'mtm' | null
  /** F-SA-222: a rider's orders (`?profile=<id>`, the rider list's Open orders door). */
  readonly profile?: string | null
  /** F-SA-275: read each row's production part (a production column is shown). */
  readonly production?: boolean
  /** F-SA-276: the orders waiting on us (`?waiting=us`: the list, the board's counts, the totals and the file alike). */
  readonly waiting?: 'us' | null
}
// ── end B-TH-225 ──

// ── B-TH-057 (threads plan TH-4; SHEET-G15, SHEET-G05, feature SHEET.overall-F05): the server sort and the custom field filter ──
const SORTS: readonly string[] = [...ORDER_SORT_KEYS, ...ORDER_SORT_KEYS.map((key) => `-${key}`)]

/** The server sort the address names (`?sort=promise`, `?sort=-daysLate`), or null: newest first. */
export function sortFromAddress(params: { get(name: string): string | null } | null): OrderSort | null {
  const value = params?.get('sort')?.trim() ?? ''
  return SORTS.includes(value) ? (value as OrderSort) : null
}

/** The custom field filter the address names (`?cf=code:A,B`), or null; the API checks its clauses and refuses a bad one. */
export function cfFromAddress(params: { get(name: string): string | null } | null): string | null {
  const value = params?.get('cf')?.trim() ?? ''
  return value === '' ? null : value.slice(0, 2000)
}

/** The sheet's columns that sort on the server (their header click sorts every page), by the sort's key. */
export const SORT_COLUMNS: Readonly<Record<string, OrderSortKey>> = Object.freeze({ customer: 'customer', brand: 'brand', promised: 'promise', orderDate: 'ordered' })

/** A column header's sort as the grid shows it: `asc` / `desc` on the column the address sorts by, else none. */
export function columnSort(sort: OrderSort | null, colId: string): 'asc' | 'desc' | null {
  if (!sort) return null
  const key = sort.startsWith('-') ? sort.slice(1) : sort
  return SORT_COLUMNS[colId] === key ? (sort.startsWith('-') ? 'desc' : 'asc') : null
}

/** A header click's sort: the column's key the way the grid asks, or none (the grid's third click: newest first again). */
export function sortOfColumn(colId: string, direction: 'asc' | 'desc' | null): OrderSort | null {
  const key = SORT_COLUMNS[colId]
  if (!key || !direction) return null
  return direction === 'desc' ? `-${key}` : key
}

/** The Sort menu's choices ('' = newest first), each with its `orders-sheet` word (`sort.<word>`). */
export const SORT_CHOICES: ReadonlyArray<{ readonly value: OrderSort | ''; readonly word: string }> = Object.freeze([
  { value: '', word: 'newest' },
  { value: 'customer', word: 'customer' },
  { value: '-customer', word: 'customerBack' },
  { value: 'brand', word: 'brand' },
  { value: 'promise', word: 'promise' },
  { value: '-promise', word: 'promiseBack' },
  { value: '-daysLate', word: 'daysLate' },
  { value: 'daysLate', word: 'daysLateBack' },
  { value: 'ordered', word: 'ordered' },
  { value: '-ordered', word: 'orderedBack' },
  { value: '-brand', word: 'brandBack' },
])
// ── end B-TH-057 ──
// ── end B-TH-201 ──

/** The page's address for a saved rows view, a search and a layout (the defaults leave the address clean). */
export function listAddress(path: string, next: { rows: RowView; q: string; layout: Layout; party?: string | null; brand?: string | null; company?: string | null; sort?: OrderSort | null; cf?: string | null /* B-TH-057 */; group?: 'party' | null; extra?: ExtraTerms | null /* B-TH-244 */; kind?: 'mtm' | null /* F-SA-221 */; profile?: string | null /* F-SA-222 */; waiting?: 'us' | null /* F-SA-276 */ }): string {
  const query = new URLSearchParams()
  if (next.layout === 'board') query.set('view', 'board')
  if (next.layout === 'week') query.set('view', 'week') // B-W2b-323
  if (next.rows === 'all') query.set('rows', 'all')
  else if (next.rows === 'late') query.set('late', 'true')
  else if (next.rows === 'deposit') query.set('deposit', 'OPEN')
  else if (next.rows === 'reaccept') query.set('reaccept', 'true') // B-W2b-323
  else if (next.rows === 'uninvoiced') query.set('shippedNotInvoiced', 'true') // B-TH-244
  else if (isStatus(next.rows)) query.set('status', next.rows)
  // B-TH-244: the door terms beside the rows view, and the grouping.
  if (next.extra) for (const [name, value] of extraEntries(next.extra, next.rows)) query.set(name, value)
  if (next.group === 'party' && !next.party) query.set('group', 'party')
  if (next.party) query.set('party', next.party) // B-TH-201
  if (next.brand) query.set('brand', next.brand) // B-TH-225
  if (next.company) query.set('company', next.company) // B-TH-225
  if (next.kind) query.set('kind', next.kind) // F-SA-221
  if (next.profile) query.set('profile', next.profile) // F-SA-222
  if (next.waiting) query.set('waiting', next.waiting) // F-SA-276
  if (next.cf) query.set('cf', next.cf) // B-TH-057
  if (next.sort) query.set('sort', next.sort) // B-TH-057
  if (next.q.trim()) query.set('q', next.q.trim())
  const qs = query.toString()
  return `${path}${qs ? `?${qs}` : ''}`
}

/** The API's query for a saved rows view (and the search; B-TH-201: and the customer of the address). */
export function rowsQuery(rows: RowView, q: string, cursor?: string | null, partyId?: string | null, narrow: Narrowing = {}): OrderQuery {
  const base: OrderQuery = { q, cursor: cursor ?? null, limit: 50, ...(partyId ? { partyId } : {}), ...narrowingOf(narrow) }
  if (rows === 'open') return { ...base, open: true }
  if (rows === 'late') return { ...base, late: true }
  if (rows === 'deposit') return { ...base, deposit: 'OPEN' }
  if (rows === 'reaccept') return { ...base, reaccept: true } // B-W2b-323
  if (rows === 'uninvoiced') return { ...base, shippedNotInvoiced: true } // B-TH-244
  if (isStatus(rows)) return { ...base, status: rows }
  return base
}

/** The tiles (the design's saved-filter tiles), each the saved rows its count stands for. */
export const TILES: ReadonlyArray<{ key: TileKey; rows: RowView }> = Object.freeze([
  { key: 'late', rows: 'late' },
  // F-SA-214 (12-lists-board §3.4): Waiting for approval, second (the board's first lane; PENDING_APPROVAL is a rows view).
  { key: 'waitingForApproval', rows: 'PENDING_APPROVAL' },
  { key: 'waitingForDeposit', rows: 'deposit' },
  { key: 'inProduction', rows: 'IN_PRODUCTION' },
  { key: 'readyToShip', rows: 'READY' },
  // B-W2b-323: Waiting for the customer to accept a change (design sec:orders.tiles#1).
  { key: 'waitingForCustomer', rows: 'reaccept' },
])

/** A tile's count, or null when the board was not read (the tile says "—", never 0). */
export function tileCount(board: OrderBoard | null, key: TileKey): number | null {
  return board?.tiles.find((tile) => tile.key === key)?.count ?? null
}

// ---- the board ----------------------------------------------------------------------------------------------------------

/** The lanes a saved rows view shows: one state only for a state's view; none for closed and cancelled. */
export function boardLanes(rows: RowView): BoardLane[] {
  if (isStatus(rows)) return (BOARD_LANES as readonly string[]).includes(rows) ? [rows as BoardLane] : []
  return [...BOARD_LANES]
}

/** The API query of one lane: its state, with the saved rows' other filter (late, deposit), the search (and the customer). */
export function laneQuery(lane: BoardLane, rows: RowView, q: string, partyId?: string | null, narrow: Narrowing = {}): OrderQuery {
  const own = narrowingOf(narrow) /* B-TH-225 */
  return { ...own, status: lane, late: rows === 'late' || !!own.late, deposit: rows === 'deposit' ? 'OPEN' : (own.deposit ?? null), reaccept: rows === 'reaccept' || !!own.reaccept /* B-W2b-323 */, shippedNotInvoiced: rows === 'uninvoiced' || !!own.shippedNotInvoiced /* B-TH-244 */, q, limit: 50, ...(partyId ? { partyId } : {}) /* B-TH-201 */ }
}

// B-TH-225: only the terms that narrow (an absent one never reaches the API).
// B-TH-057: + the custom field filter and the server sort.
// B-TH-244: + the door terms beside the rows view, and the Progress column's read.
const narrowingOf = (narrow: Narrowing): OrderQuery => ({
  ...(narrow.brand ? { brand: narrow.brand } : {}),
  ...(narrow.companyId ? { companyId: narrow.companyId } : {}),
  ...(narrow.cf ? { cf: narrow.cf } : {}),
  ...(narrow.sort ? { sort: narrow.sort } : {}),
  ...extraQueryOf(narrow.extra ?? null),
  ...(narrow.progress ? { progress: true } : {}),
  ...(narrow.kind ? { kind: narrow.kind } : {}), // F-SA-221
  ...(narrow.profile ? { profile: narrow.profile } : {}), // F-SA-222
  ...(narrow.production ? { production: true } : {}), // F-SA-275
  ...(narrow.waiting ? { waiting: narrow.waiting } : {}), // F-SA-276
})

/**
 * B-TH-225 (band-F01: the honest count): how many orders the rows view holds, from the board's counts — the same filters
 * (customer, label, company, search) and the same definitions — or null while the board is unread.
 */
export function viewCount(board: OrderBoard | null, rows: RowView): number | null {
  if (!board) return null
  const byStatus = (statuses: readonly string[]) => board.byStatus.filter((entry) => statuses.includes(entry.status)).reduce((sum, entry) => sum + entry.count, 0)
  if (rows === 'uninvoiced') return null // B-TH-244: the summary counts it (the board has no such figure)
  if (rows === 'open') return byStatus(OPEN_ORDER_STATUSES)
  if (rows === 'all') return byStatus(board.byStatus.map((entry) => entry.status))
  const tile = TILES.find((entry) => entry.rows === rows)
  if (tile && (rows === 'late' || rows === 'deposit' || rows === 'reaccept')) return tileCount(board, tile.key)
  return byStatus([rows])
}
/** The open orders (not shipped yet), as the API's `open=true` reads them. */
const OPEN_ORDER_STATUSES: readonly OrderStatus[] = ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED']

export interface Lane {
  status: BoardLane
  items: OrderRow[] | null
  more: boolean
  problem: string | null
}

/**
 * A lane's count: the board's own count by state when only the search filters it, else what the lane read (null when
 * more wait: the view says "50+").
 */
export function laneCount(lane: Lane, rows: RowView, board: OrderBoard | null): number | null {
  const plain = rows === 'open' || rows === 'all' || rows === lane.status
  if (plain && board) return board.byStatus.find((entry) => entry.status === lane.status)?.count ?? null
  if (!lane.items) return null
  return lane.more ? null : lane.items.length
}

/** A lane's value (net, price grain), only when every order of the lane was read: never a part shown as the whole. */
export function laneValue(lane: Lane, price: boolean): number | null {
  if (!price || !lane.items || lane.more) return null
  if (lane.items.some((row) => row.netAmount === undefined)) return null
  return lane.items.reduce((sum, row) => sum + (row.netAmount ?? 0), 0)
}

/** Closed, cancelled and (F-SA-214) delivered orders the board does not draw, from the board's counts. */
export function offBoard(board: OrderBoard | null): { closed: number; cancelled: number; delivered: number } | null {
  if (!board) return null
  const count = (status: OrderStatus) => board.byStatus.find((entry) => entry.status === status)?.count ?? 0
  return { closed: count('CLOSED'), cancelled: count('CANCELLED'), delivered: count('DELIVERED') }
}

// ── F-SA-214 (sales page plan N8 / N7, picks P12, P13, P17; 12-lists-board §3.3–§3.5): the waiting lane's reasons, the live re-read ──
/** A waiting order's reason as the card says it (`orders` words `waits.*`) and its door: where it is decided, or null (no door). */
export interface WaitDoor {
  readonly word: 'waits.yes' | 'waits.credit' | 'waits.review'
  readonly href: string | null
}

/**
 * Why a PENDING_APPROVAL card waits, each reason once with its door: a yes asked → Home › Approvals (sales orders); a yes nobody
 * asked yet and the customer's credit → the order (where a yes is asked, or the credit read); the factory review of a
 * made-to-measure unit → Made-to-measure › Riders waiting for the review of this customer, ONLY for a reader of measurements
 * (sales.measurements.view: else the words without a door). An order that waits for nothing says nothing.
 */
export function waitDoorsOf(row: Pick<OrderRow, 'id' | 'partyId' | 'status' | 'waits'>, prefix: string, can: Pick<OrderAbilities, 'measurements'>): WaitDoor[] {
  if (row.status !== 'PENDING_APPROVAL' || !row.waits) return []
  const order = `${prefix}/sales/orders/${encodeURIComponent(row.id)}`
  const out: WaitDoor[] = []
  const add = (door: WaitDoor) => {
    if (!out.some((seen) => seen.word === door.word)) out.push(door)
  }
  for (const reason of row.waits) {
    if (reason === 'REQUEST_PENDING') add({ word: 'waits.yes', href: `${prefix}/home/approvals?kind=SALES_ORDER` })
    else if (reason === 'NO_REQUEST') add({ word: 'waits.yes', href: order })
    else if (reason === 'CREDIT_HOLD') add({ word: 'waits.credit', href: order })
    else if (reason === 'MEASUREMENTS') add({ word: 'waits.review', href: can.measurements ? `${prefix}/sales/made-to-measure?segment=riders&view=waiting&party=${encodeURIComponent(row.partyId)}` : null })
  }
  return out
}

/** The events a new order may follow (an accepted quote makes one, waiting for a yes or confirmed). */
const NEW_ORDER_LANES: readonly BoardLane[] = ['PENDING_APPROVAL', 'CONFIRMED']

/**
 * The lanes a live event re-reads on the board (never all of them for one change): a state that moved re-reads its `from` and `to`
 * lanes (both are live fields of sales_order.status_changed); a new order the lanes it may enter; another order event the lane that
 * holds the order on screen (none: nothing on the board changes, only the counts). Only the lanes the board shows.
 */
export function boardRereadOf(change: { type: string; fields: Readonly<Record<string, unknown>> }, lanes: readonly Pick<Lane, 'status' | 'items'>[]): BoardLane[] {
  const shown = lanes.map((lane) => lane.status)
  const keep = (statuses: readonly unknown[]): BoardLane[] => (BOARD_LANES as readonly BoardLane[]).filter((lane) => shown.includes(lane) && statuses.includes(lane))
  if (change.type === 'sales_order.status_changed') return keep([change.fields.from, change.fields.to])
  if (change.type === 'sales_order.created' || change.type === 'quote.accepted') return keep(NEW_ORDER_LANES)
  // F-SA-221: a rider's review changes the waiting cards' "waiting for review" (and its confirm moves an order: status_changed follows).
  if (change.type.startsWith('measurement_profile.')) return keep(['PENDING_APPROVAL'])
  const named = new Set(idsOf(change.fields))
  return keep(lanes.filter((lane) => (lane.items ?? []).some((row) => named.has(row.id))).map((lane) => lane.status))
}
// ── end F-SA-214 ──

/** How far the order's garments left (shipped of ordered), 0–100. */
export const shippedPercent = (row: Pick<OrderRow, 'units' | 'shippedUnits'>): number => (row.units > 0 ? Math.round((row.shippedUnits / row.units) * 100) : 0)

// ---- the record ---------------------------------------------------------------------------------------------------------

// ---- F-SA-230 (sales page plan N2, picks P2, P3, P15; 10-order-page §2, §4.5): the order's tabs re-cut, nothing lost ----------------
/**
 * The record's tabs, each with one job: Lines (the commercial truth) · Production (the work behind it, its dates) · Changes (one story
 * of requests, amendments, confirmations) · Money (deposits, payment schedule, invoices & credit notes, the margin by its grain) ·
 * Shipments (left to ship, shipments, deliveries, complaints & returns). Overview and Files join with F-SA-232 / F-SA-237. The thread is
 * docked beside every tab (B-TH-214); Margin is a section of Money (#margin), only with the margin grain.
 */
// F-SA-232: + Overview, the new first tab ("where is it now"); no address → Overview.
// F-SA-237: + Files, last (every file of the order by where it comes from).
export const RECORD_TABS = ['overview', 'lines', 'production', 'changes', 'money', 'shipments', 'files'] as const
export type RecordTab = (typeof RECORD_TABS)[number]

/** The tab with no address: Overview (F-SA-232). */
export const FIRST_TAB: RecordTab = 'overview'

/**
 * Every old `?tab=` keeps working (R-8): the tab it now lives in and the section to scroll to (`#anchor`). Margin's anchor only with the
 * margin grain (else Money's top); Activity opens the thread (RecordFrame reads it) beside the first tab.
 */
export const MERGED_TABS: Readonly<Record<string, { readonly tab: RecordTab | null; readonly anchor: string | null }>> = Object.freeze({
  dates: { tab: 'production', anchor: 'dates' },
  invoices: { tab: 'money', anchor: 'invoices' },
  margin: { tab: 'money', anchor: 'margin' },
  documents: { tab: 'changes', anchor: 'confirmation' },
  confirmation: { tab: 'changes', anchor: 'confirmation' },
  activity: { tab: null, anchor: null },
})

/** Where an address lands: one of the tabs (an old id: its new tab and section), else the first tab. Never a name of Object's own. */
export function landingOf(asked: string | null | undefined, can?: Pick<OrderAbilities, 'margin'>): { readonly tab: RecordTab; readonly anchor: string | null; readonly moved: boolean } {
  const value = asked ?? ''
  if ((RECORD_TABS as readonly string[]).includes(value)) return { tab: value as RecordTab, anchor: null, moved: false }
  if (Object.hasOwn(MERGED_TABS, value)) {
    const merged = MERGED_TABS[value]!
    const anchor = merged.anchor === 'margin' && can && !can.margin ? null : merged.anchor
    // Activity stays in the address: the frame opens the thread from it (arrivalOf); the first tab shows beside it.
    return { tab: merged.tab ?? FIRST_TAB, anchor, moved: merged.tab !== null }
  }
  return { tab: FIRST_TAB, anchor: null, moved: false }
}

/** The tab an address asks for (see landingOf). */
export const tabOf = (asked: string | null | undefined, can?: Pick<OrderAbilities, 'margin'>): RecordTab => landingOf(asked, can).tab

/** The tabs a person sees: every tab (each part inside says what its right holds back, never an empty tab with zeros). */
export const recordTabs = (_can?: Pick<OrderAbilities, 'margin'>): readonly RecordTab[] => RECORD_TABS

// ---- F-SA-263 (sales page plan N6, P11; 10-order-page §5): the dock's width when the person chose none, per tab.
// F-OP-301 (walk #5): ONE width per viewport on every tab — the grid rule (a third under 1600 px, where Lines, Production and Shipments
// need the room; 40 % from 1600): the dock never jumps when the page tab changes, and the page tabs fit beside it (Changes was half, and
// Files hid behind ›). A width the person picks holds on every tab too (RecordFrame).
export const DOCK_DEFAULTS: Readonly<Record<RecordTab, DockDefault>> = Object.freeze({
  overview: 'grid',
  lines: 'grid',
  production: 'grid',
  changes: 'grid',
  money: 'grid',
  shipments: 'grid',
  files: 'grid',
})
// ---- end F-SA-263

/** What a tab counts (null draws nothing; 0 is an answer): lines · work orders · amendments · invoices · shipments. */
// F-OP-117 (10-order-page §6, §7, §8; review R-22): Changes counts the ONE waiting list's rows (`changes`: changesBadgeOf of the card,
// null before the production read — never a made-up 0). F-OO-206 (order overview §6; review F5; Owner D8): Production, Shipments and
// Money count what the Linked records card counts — the domain's ONE rule on the order read's chain (orderLinkCountsOf: live records
// only, what was cancelled is said in words on the card); the API sends no badge of its own. Money = issued invoices (credit notes and
// deposit invoices among them) + the deposit requests still open.
export function tabCountOf(tab: RecordTab, order: Pick<Order, 'lines' | 'chain' | 'amendments'>, counts: { readonly changes?: number | null; /* F-OP-306 */ readonly viewInvoices?: boolean } = {}): number | null {
  if (tab === 'lines') return order.lines.length
  if (tab === 'changes') return counts.changes ?? null
  // F-SA-237: the files the reader may open come with the files read (none before it: no number that is not true).
  if (tab !== 'production' && tab !== 'shipments' && tab !== 'money') return null
  const linked = orderLinkCountsOf(order.chain) // F-OO-206
  if (tab === 'production') return linked.workOrders.live
  if (tab === 'shipments') return linked.shipments.live
  // F-OP-306 (walk #21): a reader without invoices.view is shown no invoice, so Money counts only its open deposits.
  return (counts.viewInvoices === false ? 0 : linked.invoices.issued) + linked.depositRequests.open
}

/** The ⋯ menu's groups, in their order (10-order-page §1.3); Cancel comes last, after a rule. */
export const MENU_GROUPS = ['next', 'edit', 'people', 'goTo', 'copy'] as const
export type MenuGroup = (typeof MENU_GROUPS)[number]
export type MenuEntry<T> = T | { readonly id: string; readonly heading: true; readonly label: string } | { readonly id: string; readonly separator: true }

/** The ⋯ menu grouped: each group that holds an item gets its heading (a rule between groups); the danger items last, after a rule. */
export function groupedMenu<T extends { readonly id: string }>(groups: Partial<Record<MenuGroup, readonly T[]>>, danger: readonly T[], headingOf: (group: MenuGroup) => string): MenuEntry<T>[] {
  const out: MenuEntry<T>[] = []
  for (const group of MENU_GROUPS) {
    const items = groups[group] ?? []
    if (items.length === 0) continue
    if (out.length > 0) out.push({ id: `sep-${group}`, separator: true })
    out.push({ id: `head-${group}`, heading: true, label: headingOf(group) }, ...items)
  }
  if (danger.length > 0) {
    if (out.length > 0) out.push({ id: 'sep-danger', separator: true })
    out.push(...danger)
  }
  return out
}

/** The order holds a made-to-measure line: the band's "Made to measure" mark (the list's word). */
export const isMadeToMeasure = (order: Pick<Order, 'lines'>): boolean => order.lines.some((line) => line.kind === 'MADE_TO_MEASURE')
// ---- end F-SA-230

const FINAL: readonly OrderStatus[] = ['CLOSED', 'CANCELLED']
export const isFinal = (order: Pick<Order, 'status'>): boolean => FINAL.includes(order.status)

/** The API's answer for one action (it holds the state's rule; who may is the person's permissions). */
export const actionOf = (order: Pick<Order, 'actions'>, action: OrderAction) => order.actions.find((entry) => entry.action === action) ?? null

/** The deposit gate the work orders' release reads: production waits for a PAID or WAIVED request. */
export type GateState = 'NOT_NEEDED' | 'WAITING' | 'PAID' | 'WAIVED' | 'MISSING'

export function depositGate(order: Pick<Order, 'depositRequired' | 'chain'>): { state: GateState; request: DepositRequest | null } {
  // B-W2a-F2: the balance before shipping has a request of its own; only the deposit's request gates production.
  const requests = order.chain.depositRequests.filter((request) => request.status !== 'CANCELLED' && request.stepKind !== 'BEFORE_SHIPPING')
  if (!order.depositRequired) return { state: 'NOT_NEEDED', request: requests[0] ?? null }
  const paid = requests.find((request) => request.status === 'PAID')
  if (paid) return { state: 'PAID', request: paid }
  const waived = requests.find((request) => request.status === 'WAIVED')
  if (waived) return { state: 'WAIVED', request: waived }
  const open = requests.find((request) => request.status === 'OPEN')
  if (open) return { state: 'WAITING', request: open }
  return { state: 'MISSING', request: null }
}

// F-OP-102: + PENDING_APPROVAL — the approver's Confirm the order (its task), anyone else's Ask for a yes / Take the request back.
export type StepKind = 'makeWorkOrders' | 'changePromise' | 'close' | /* F-OP-121 */ 'createShipment' | 'confirmYes' | 'askYes'

export interface NextStep {
  kind: StepKind | null
  held: Phrase | null
  /** F-OP-102: Confirm the order's task (the order read's open yes, B-OP-020). */
  taskId?: string
}

// F-SA-201: a Delivered order closes as a Shipped one does (the machine: SHIPPED → CLOSED and DELIVERED → CLOSED; the
// API's close and the database accept both). Before, nextStep had no DELIVERED case and closeHeld held it.
const CLOSE_FROM: readonly OrderStatus[] = ['SHIPPED', 'DELIVERED']
/** Shipped in full (Shipped or Delivered): the order's next step is closing it; its dates are no longer late. */
export const isShippedInFull = (order: Pick<Order, 'status'>): boolean => CLOSE_FROM.includes(order.status)
// end F-SA-201

/**
 * The band's primary by state (design "Next step by state"): Confirmed → Make work orders (held while production waits
 * for the deposit); In production, Ready, Partly shipped → Change promise date; Shipped or Delivered → Close order (held
 * until settled unless the person may close an unsettled order with a reason). Ready's "Create shipment" waits for the
 * Warehouse pages (no dead control): its promise is the step meanwhile.
 */
export function nextStep(order: Order, can: OrderAbilities): NextStep {
  // ---- F-OP-102 (10-order-page §2.1): the yes the order waits for — an approver who did not ask confirms it here (F-OP-101's door);
  // anyone else asks for it or takes their request back (the banner's own words say which).
  if (order.status === 'PENDING_APPROVAL') {
    const decide = bannerYesOf(order.openApprovals)
      .filter((task) => task.kind === 'SALES_ORDER')
      .map((task) => yesDoorOf(task))
      .find((door) => door.kind === 'decide')
    if (decide && decide.kind === 'decide') return { kind: 'confirmYes', held: decide.confirmHeld, taskId: decide.task.taskId }
    return { kind: 'askYes', held: can.manage ? null : phrase('held.noManage') }
  }
  // ---- end F-OP-102
  if (order.status === 'CONFIRMED') {
    if (!can.makeWorkOrders) return { kind: 'makeWorkOrders', held: phrase('held.noWorkOrders') }
    const gate = depositGate(order)
    if (gate.state === 'WAITING') return { kind: 'makeWorkOrders', held: phrase('held.deposit', { date: gate.request?.dueDate ?? '' }) }
    if (gate.state === 'MISSING') return { kind: 'makeWorkOrders', held: phrase('held.depositMissing') }
    return { kind: 'makeWorkOrders', held: null }
  }
  if (isShippedInFull(order)) return { kind: 'close', held: closeHeld(order, can) } // F-SA-201
  if (isFinal(order)) return { kind: null, held: null }
  // F-OP-121: ready (or partly shipped) with released garments not shipped yet, and the right to make a shipment: Create shipment….
  if ((order.status === 'READY' || order.status === 'PARTLY_SHIPPED') && mayCreateShipment(order, can)) return { kind: 'createShipment', held: null }
  return { kind: 'changePromise', held: can.manage ? null : phrase('held.noManage') }
}

// ---- F-OP-311 (oo-walk #10): the band follows the Owner's rule "Read-only sees no buttons" (order overview plan §1) ----------------
/** The ⋯ items that change nothing: a door to another page (the quote, the customer's portal, Planning) or the number to the clipboard. */
export const BAND_LOOK_ITEMS = ['quote', 'portal', 'planning', 'copy'] as const
const NO_STEP: NextStep = { kind: null, held: null }
/**
 * The band as this reader sees it. Read-only on the page (readOnlyOnPage: no right that changes anything here) gets no next step
 * and, in the ⋯, only the open doors and the copy that change nothing — no held move, no Cancel. Everyone else keeps every move,
 * a move they may not make held with its words. The walk saw Read-only offered a held Make work orders · Ask for a yes · Change
 * promise date… · Close order… on every order, while the 8 cards already followed the rule.
 */
export const bandStepOf = (order: Order, can: OrderAbilities, readOnly: boolean): NextStep => (readOnly ? NO_STEP : nextStep(order, can))
/** The band's ⋯ for this reader (see bandStepOf): Read-only keeps only BAND_LOOK_ITEMS that are open, and no danger item. */
export function bandMenuFor<T extends { readonly id: string; readonly disabled?: boolean }>(
  readOnly: boolean,
  groups: Partial<Record<MenuGroup, readonly T[]>>,
  danger: readonly T[],
): { groups: Partial<Record<MenuGroup, readonly T[]>>; danger: readonly T[] } {
  if (!readOnly) return { groups, danger }
  const look = (item: T) => (BAND_LOOK_ITEMS as readonly string[]).includes(item.id) && !item.disabled
  const shown: Partial<Record<MenuGroup, readonly T[]>> = {}
  for (const group of MENU_GROUPS) shown[group] = (groups[group] ?? []).filter(look)
  return { groups: shown, danger: [] }
}
// ---- end F-OP-311

/** Why closing waits: no right, or not settled without the right to close it anyway. */
export function closeHeld(order: Order, can: OrderAbilities): Phrase | null {
  if (!isShippedInFull(order)) return phrase('held.closeState') // F-SA-201
  if (order.settlement.settled) return can.manage || can.close ? null : phrase('held.noClose')
  return can.close ? null : phrase('held.notSettled')
}

/** Closing needs a reason: the order is not settled. */
export const closeNeedsReason = (order: Pick<Order, 'settlement'>): boolean => !order.settlement.settled

/** What the settlement still misses, as this app's words (one per code, in the money module's order). */
export function settlementWords(order: Pick<Order, 'settlement'>): string[] {
  const seen: string[] = []
  for (const gap of order.settlement.missing) {
    const code = (SETTLEMENT_GAPS as readonly string[]).includes(gap.code) ? gap.code : 'OTHER'
    if (!seen.includes(code)) seen.push(code)
  }
  return seen.map((code) => `settlement.${code}`)
}

/**
 * Why "Cancel order…" waits (B-W2a-30: confirmed, in production or ready — nothing shipped yet). What else stops it (a
 * draft work order, a shipment being packed, an invoice) is the dialog's impact check, said there in words.
 */
export function cancelHeld(order: Order, can: OrderAbilities): Phrase | null {
  if (!can.manage) return phrase('held.noManage')
  if (isFinal(order)) return phrase('held.final')
  if (!actionOf(order, 'cancel')) return phrase('held.cancelState')
  return null
}

// ---- F-OO-112 (order overview N13, Owner D1; B-OO-002): Mark ready reads the API's markReady — listed while in production, allowed only
// once quality released every piece; held with the counts ("Quality releases the garments: 3 of 7 released. …", held.readyQuality), the
// numbers from the order read's line sizes by the domain's one rule. The signature stays (the customer page lane's row window and bulk
// Mark N ready read it: their row holds Ready by the right only, as Close — the quality hold is the window's, from the read).
export function readyHeld(order: Order, can: OrderAbilities): Phrase | null {
  if (!can.manage) return phrase('held.noManage')
  const action = actionOf(order, 'markReady')
  if (!action) return phrase('held.readyState')
  if (action.allowed) return null
  const pieces = releasedPiecesOf(order.lines.map((line) => ({ kind: line.kind, rows: line.sizes.map((size) => size.progress) })))
  return phrase('held.readyQuality', { n: pieces.released, m: pieces.toRelease })
}
// ---- end F-OO-112

export function promiseHeld(order: Order, can: OrderAbilities): Phrase | null {
  if (!can.manage) return phrase('held.noManage')
  return actionOf(order, 'changePromise') ? null : phrase('held.final')
}

/** Lines may get their own promise only before anything shipped (the API refuses it after). */
export const linePromisesAllowed = (order: Pick<Order, 'status'>): boolean => ['CONFIRMED', 'IN_PRODUCTION', 'READY'].includes(order.status)

/** Problems of a typed promise change, as message keys (the API holds the same rules). */
// F-OO-142 (order overview §4.3; B-OO-009): why is one of the curated reasons the customer reads — picked, never typed ("Pick why"); the
// office's own note is optional (it never reaches the customer).
export function promiseProblems(input: { date: string; reasonCode: string | null; today: string; current: string | null; lineIds: readonly string[]; allLines: boolean }): { date?: string; reasonCode?: string; lines?: string } {
  const problems: { date?: string; reasonCode?: string; lines?: string } = {}
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) problems.date = 'promise.problem.date'
  else if (input.date < input.today) problems.date = 'promise.problem.past'
  else if (input.allLines && input.date === input.current) problems.date = 'promise.problem.same'
  // F-OL-04 (ol-s1, B-OL-004): the reason is optional — none picked: the server writes its automatic words (a code typed wrong still says so).
  if (input.reasonCode !== null && input.reasonCode !== '' && !isPromiseReasonCode(input.reasonCode)) problems.reasonCode = 'promise.problem.code'
  if (!input.allLines && input.lineIds.length === 0) problems.lines = 'promise.problem.lines'
  return problems
}

// ---- F-OO-142 (order overview §4.3; B-OO-009): the promise dialog's reason list — the code the customer reads, the office's own note ----
export const isPromiseReasonCode = (value: string | null | undefined): value is PromiseReasonCode => typeof value === 'string' && (PROMISE_REASON_CODES as readonly string[]).includes(value)

/**
 * The list's choices in the office's language: each curated reason in the words the customer reads (one wording, never a synonym) —
 * except where those words speak TO the customer. Walk follow-up (Z01): "Changed at your request" / "Modifica richiesta da voi" is the
 * customer's own voice, so the office's list says it in office words (`say(PROMISE_REASON_OFFICE_KEYS[code])`, orders catalogue); the
 * customer's words stay in the "The customer reads:" preview (promiseReasonPreview).
 */
export const PROMISE_REASON_OFFICE_KEYS: Readonly<Partial<Record<PromiseReasonCode, string>>> = Object.freeze({ YOUR_CHANGE: 'promise.officeReason.YOUR_CHANGE' })
export const promiseReasonChoices = (locale: Locale, say: (key: string) => string): { value: PromiseReasonCode; label: string }[] =>
  PROMISE_REASON_CODES.map((code) => {
    const office = PROMISE_REASON_OFFICE_KEYS[code]
    return { value: code, label: office ? say(office) : PROMISE_REASON_WORDS[code][locale] }
  })

/**
 * What the customer reads for the picked reason, in Italian AND English (the portal shows each reader's language: review F10), the
 * order's language first; null before a pick. The office's note is never in it.
 */
export function promiseReasonPreview(code: string | null, orderLanguage: string): { locale: Locale; words: string }[] | null {
  if (!isPromiseReasonCode(code)) return null
  const locales: Locale[] = orderLanguage === 'en' ? ['en', 'it'] : ['it', 'en']
  return locales.map((locale) => ({ locale, words: PROMISE_REASON_WORDS[code][locale] }))
}

/** What the dialog hands the band's write: the new day, the picked reason, the office's note (may be empty), the lines (null: the order). */
export interface PromiseInput {
  readonly date: string
  /** F-OL-04: null — no reason picked (optional, B-OL-004). */
  readonly reasonCode: PromiseReasonCode | null
  readonly note: string
  readonly lineIds: readonly string[] | null
}

/** The promise write's body (PUT …/promise, B-OO-009): the order's version, the day, `reasonCode` (what the customer reads) and `reason`
 * (the office's note, trimmed; empty is allowed with a code); `lineIds` only for chosen lines. */
// F-OL-04: the code and the note go only when given (both optional since ol-s1, B-OL-004).
export function promiseBodyOf(input: PromiseInput, version: number): { version: number; promiseDate: string; reasonCode?: PromiseReasonCode; reason?: string; lineIds?: string[] } {
  const note = input.note.trim()
  return { version, promiseDate: input.date, ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}), ...(note ? { reason: note } : {}), ...(input.lineIds ? { lineIds: [...input.lineIds] } : {}) }
}
// ---- end F-OO-142

/** The colour lines of an order grouped by style (one size grid per style, colours as its rows). */
export interface StyleGroup {
  styleId: string
  code: string
  name: string
  revision: { revision: number; status: string } | null
  lines: Order['lines']
}

export function styleGroups(lines: Order['lines']): StyleGroup[] {
  const groups = new Map<string, StyleGroup>()
  for (const line of [...lines].sort((a, b) => a.seq - b.seq)) {
    const group = groups.get(line.styleId) ?? { styleId: line.styleId, code: line.style?.code ?? '—', name: line.style?.name ?? '', revision: line.styleRevision, lines: [] }
    group.lines = [...group.lines, line]
    groups.set(line.styleId, group)
  }
  return [...groups.values()]
}

/**
 * What a size grid shows: the ordered pieces (Lines) or what is still to ship (Shipments). F-SA-231: Lines' layer switch went — what
 * is made is on Overview (the order's own pieces), Production (its work orders) and Shipments (left to ship).
 */
export type GridLayer = 'ordered' | 'toShip'

/** A style group's grid shape and values for one layer (colour rows × the sizes in the style's range order). */
export function gridOf(group: StyleGroup, layer: GridLayer): { sizes: { key: string; label: string }[]; colours: { key: string; label: string; offered: string[] }[]; value: Record<string, Record<string, number>> } {
  const sizes: string[] = []
  for (const line of group.lines) for (const size of line.sizes) if (size.size !== null && !sizes.includes(size.size)) sizes.push(size.size)
  const value: Record<string, Record<string, number>> = {}
  for (const line of group.lines) {
    value[line.id] = Object.fromEntries(line.sizes.filter((size) => size.size !== null).map((size) => [size.size!, size.progress[layer]]))
  }
  return {
    sizes: sizes.map((size) => ({ key: size, label: size })),
    // A colour's sizes the order does not hold are "not offered" (never a 0 that looks like an answer).
    colours: group.lines.map((line) => ({ key: line.id, label: line.colourway ? `${line.colourway.code} · ${line.colourway.name}` : '—', offered: line.sizes.flatMap((size) => (size.size === null ? [] : [size.size])) })),
    value,
  }
}

/** The order's progress in one line of words' figures: ordered, in work orders, released, shipped. */
export function progressFigures(progress: Progress): { ordered: number; inWorkOrders: number; released: number; shipped: number; toShip: number } {
  return { ordered: progress.ordered, inWorkOrders: progress.inWorkOrders, released: progress.released, shipped: progress.shipped, toShip: progress.toShip }
}

/** Lines no work order covers yet ("2 lines not in production"): a size still asks more than its work orders make. */
export const linesNotInProduction = (order: Pick<Order, 'lines'>): number => order.lines.filter((line) => line.progress.inWorkOrders < line.progress.ordered).length

// ---- the deposit card (Q12: an acconto paid by bank transfer) ---------------------------------------------------------------

export type DepositStepState = 'done' | 'current' | 'waiting' | 'notNeeded'

export interface DepositSteps {
  requested: DepositStepState
  page: DepositStepState
  paid: DepositStepState
  invoice: DepositStepState
  sdi: DepositStepState
}

/** The TD02s that bill this request (issued ones first, then drafts). */
export function depositInvoicesOf(request: Pick<DepositRequest, 'id'>, invoices: readonly ChainInvoice[]): ChainInvoice[] {
  return invoices.filter((invoice) => invoice.docType === 'TD02' && invoice.depositRequestId === request.id).sort((a, b) => Number(a.status === 'DRAFT') - Number(b.status === 'DRAFT'))
}

/** What is still to pay on a request (price grain), or null when the amounts are not visible. */
export function stillToPay(request: Pick<DepositRequest, 'amount' | 'paidAmount' | 'status'>): number | null {
  if (request.amount === undefined || request.paidAmount === undefined) return null
  if (request.status !== 'OPEN') return 0
  return Math.max(0, request.amount - request.paidAmount)
}

/**
 * The five steps of the deposit (request at acceptance → the bank-details page → paid → the TD02 when the rule asks
 * one → its SDI state). A cancelled or waived request ends at its first step.
 */
export function depositSteps(request: DepositRequest, invoices: readonly ChainInvoice[], sdi: SdiStateCode | null): DepositSteps {
  const td02 = depositInvoicesOf(request, invoices).find((invoice) => invoice.status !== 'DRAFT') ?? null
  const needsInvoice = request.fiscalDocument === 'TD02'
  const paid = request.status === 'PAID'
  const open = request.status === 'OPEN'
  const sent = request.link !== null
  return {
    requested: 'done',
    page: sent ? 'done' : open ? 'current' : 'notNeeded',
    paid: paid ? 'done' : open ? (sent ? 'current' : 'waiting') : 'notNeeded',
    invoice: !needsInvoice ? 'notNeeded' : td02 ? 'done' : paid || (request.paidAmount ?? 0) > 0 ? 'current' : 'waiting',
    sdi: !needsInvoice ? 'notNeeded' : !td02 ? 'waiting' : sdi === 'DELIVERED' ? 'done' : sdi === null ? 'waiting' : 'current',
  }
}

/** Why "Send the bank-details page" waits, or null. */
export function linkHeld(request: DepositRequest, can: OrderAbilities): Phrase | null {
  if (!can.recordPayment) return phrase('held.noPayments')
  if (request.status !== 'OPEN') return phrase('held.depositNotOpen')
  // B-W2b-16: a typed order's deposit (no quote) has its page too: it goes to the customer's invoices contact.
  return null
}

/** Why "Record the payment" waits, or null. */
export function paymentHeld(request: DepositRequest, can: OrderAbilities): Phrase | null {
  if (!can.recordPayment) return phrase('held.noPayments')
  if (!can.price) return phrase('held.noPrice')
  if (request.status !== 'OPEN') return phrase('held.depositNotOpen')
  return null
}

/** Whether the payment dialog may issue the TD02 now: the request's rule asks one and the person may issue. */
export function mayIssueDepositInvoice(request: Pick<DepositRequest, 'fiscalDocument'>, can: OrderAbilities): boolean {
  return request.fiscalDocument === 'TD02' && can.issueInvoices
}

/** A typed amount in either language's way ("1.872,00", "1872.00", "1872") as minor units, or null. */
export function parseAmount(text: string): number | null {
  const trimmed = text.trim().replace(/\s/g, '').replace(/^€/, '').replace(/€$/, '')
  if (trimmed === '') return null
  const normalised = /,\d{1,2}$/.test(trimmed) ? trimmed.replace(/\./g, '').replace(',', '.') : trimmed.replace(/,/g, '')
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(normalised)) return null
  const minor = Math.round(Number(normalised) * 100)
  return minor > 0 ? minor : null
}

/** Minor units as a plain number to type over ("1872.00" / "1872,00"). */
export const amountText = (minor: number, locale: Locale): string => (minor / 100).toFixed(2).replace('.', locale === 'it' ? ',' : '.')

/** Problems of a typed payment, as message keys. */
export function paymentProblems(input: { amount: string; receivedOn: string; reference: string; today: string; left: number | null }): { amount?: string; receivedOn?: string; reference?: string; over?: boolean } {
  const problems: { amount?: string; receivedOn?: string; reference?: string; over?: boolean } = {}
  const amount = parseAmount(input.amount)
  if (amount === null) problems.amount = 'payment.problem.amount'
  else if (input.left !== null && amount > input.left) problems.over = true
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.receivedOn)) problems.receivedOn = 'payment.problem.date'
  else if (input.receivedOn > input.today) problems.receivedOn = 'payment.problem.future'
  if (input.reference.trim() === '') problems.reference = 'payment.problem.reference'
  return problems
}

/** Why "Send to SDI" waits for this person, or null. */
export function sdiSendHeld(can: OrderAbilities, canSend: boolean): Phrase | null {
  if (!can.issueInvoices) return phrase('held.noIssue')
  return canSend ? null : phrase('held.sdiNotNow')
}

export const SDI_TONE: Record<SdiStateCode, Tone> = {
  DRAFT: 'neutral',
  NOT_SENT: 'warning',
  SENDING: 'info',
  AT_SDI: 'info',
  DELIVERED: 'success',
  NOT_DELIVERED: 'warning',
  REJECTED: 'danger',
  ERROR: 'danger',
}

// ---- problems in this app's words ------------------------------------------------------------------------------------------

/** A failed read as a message key (`orders` catalogue). */
export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'problem.read.internal'
  if (['signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited'].includes(error.kind)) return `problem.read.${error.kind}`
  return 'problem.read.internal'
}

export interface WriteProblem extends Phrase {
  /** The record changed meanwhile: read it again. */
  reload: boolean
}

/** A refused write as words (never the API's English): a moved record, a state that does not allow it, no right… */
export function writeProblem(error: unknown): WriteProblem {
  if (!isApiError(error)) return { key: 'problem.write.internal', reload: false }
  // F-OP-101: the approval engine's refusal of a yes or a no decided here (`refusal/STALE` …): its own words, and the order read again
  // (W39-02's seeded request answers STALE on a yes — its no still clears it).
  // F-OP-116: only the approval engine's own codes — another route's refusal (PRODUCTION_DOES_THIS, CUT_PIECES …) keeps its words.
  const refusal = error.issues.map(issuePath).find((path) => path.startsWith('refusal/'))?.slice('refusal/'.length) ?? null
  if (refusal && YES_REFUSALS.has(refusal)) return { key: `approval.refused.${refusal}`, reload: true }
  if (error.kind === 'conflict') {
    const moved = error.issues.some((issue) => issuePath(issue).split(/[./]/).includes('version'))
    if (moved) return { key: 'problem.write.moved', reload: true }
    if (error.issues.some((issue) => issuePath(issue).includes('externalRef'))) return { key: 'problem.write.reference', reload: false }
    return { key: 'problem.write.state', reload: true }
  }
  if (error.kind === 'invalid') {
    const paths = error.issues.map(issuePath)
    if (paths.some((path) => path.includes('externalRef'))) return { key: 'problem.write.reference', reload: false }
    if (paths.some((path) => path.includes('promiseDate'))) return { key: 'promise.problem.past', reload: false }
    return { key: 'problem.write.invalid', reload: false }
  }
  if (['signed_out', 'forbidden', 'not_found', 'rate_limited', 'unavailable', 'step_up'].includes(error.kind)) return { key: `problem.write.${error.kind}`, reload: error.kind === 'not_found' }
  return { key: 'problem.write.internal', reload: false }
}

// F-SA-239: the record's live rule is the server's watch list (record/live.ts); LIVE_PREFIXES and liveTouches went.

/** Every id a live event's fields name (a string, or a list of strings): the board's lanes read it. */
function idsOf(fields: Readonly<Record<string, unknown>>): string[] {
  return Object.values(fields).flatMap((value) => (typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []))
}

/**
 * Whether a live event changes what the list shows (a new order, a state or promise that moved, a deposit paid or
 * waived): floor scans and invoice events do not, so they never count as "updates".
 */
// F-SA-221: + a rider profile's event (a review moves a row's "waiting for review"; its confirm lets a waiting order go on).
// ── F-SA-276 (rule 37: values in place, rows never jump): an event that changes what a row SHOWS, not where it sits — the keeper's
// stage / health / waiting / supervisor / hold, a customer request, a work-order change — reads only the rows on screen it names. ──
export const valueTouches = (change: { type: string }): boolean =>
  change.type.startsWith('brand_production.') || change.type.startsWith('order_change_request.') || change.type.startsWith('work_order_change.')

/** The order ids an event's live fields name (`orderId`, `orderIds`, `salesOrderId`): matched against the rows on screen, never a party. */
export function orderIdsOfChange(fields: Readonly<Record<string, unknown>>): string[] {
  const out = new Set<string>()
  for (const key of ['orderId', 'salesOrderId']) if (typeof fields[key] === 'string') out.add(fields[key] as string)
  if (Array.isArray(fields.orderIds)) for (const id of fields.orderIds) if (typeof id === 'string') out.add(id)
  return [...out]
}
// ── end F-SA-276 ──

export const listTouches = (change: { type: string }): boolean =>
  change.type.startsWith('sales_order.') || (change.type.startsWith('deposit_request.') && change.type !== 'deposit_request.link_sent') || change.type === 'payment.deposit_paid' || change.type === 'quote.accepted' || change.type.startsWith('measurement_profile.')

/** The ids a record's live events may name: the order and every record of its chain. */
export function knownIds(order: Order): Set<string> {
  return new Set([
    order.id,
    ...order.chain.depositRequests.map((request) => request.id),
    ...order.chain.workOrders.map((workOrder) => workOrder.id),
    ...order.chain.shipments.map((shipment) => shipment.id),
    ...order.chain.invoices.map((invoice) => invoice.id),
    ...(order.chain.quote ? [order.chain.quote.id] : []),
  ])
}

/** Today in Rome (the sites' default zone), as YYYY-MM-DD. */
export function romeToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/** Released garments not shipped yet: Create shipment opens Warehouse's New shipment with this order (the dialog says how many each cell can still take). */
export const mayCreateShipment = (order: Pick<Order, 'status' | 'progress'>, can: Pick<OrderAbilities, 'createShipment'>): boolean =>
  can.createShipment && order.status !== 'CANCELLED' && order.status !== 'CLOSED' && order.progress.released > order.progress.shipped

/** The address of Warehouse's New shipment with the order chosen. */
export const createShipmentHref = (prefix: string, orderId: string): string => `${prefix}/warehouse/shipments?new=1&order=${encodeURIComponent(orderId)}`

// ── B-TH-244 (threads plan TH-4, SHEET-G08; features SHEET.overall-F02 group by customer, -F06, -F11 every total opens its rows) ──
/** The grouping of the address (`?group=party`: the overall view grouped by customer); a customer's sheet is never grouped. */
export const groupFromAddress = (params: { get(name: string): string | null } | null): 'party' | null => (params?.get('group') === 'party' && !partyFromAddress(params) ? 'party' : null)

/**
 * The terms of the address beside its rows view — what a door of the overall view adds (Invoiced Part, At risk, a currency, the
 * customer's mark) and a rows term the rows view does not already say (a door of "In production" that counts its late ones). With
 * them the list reads exactly the rows the door counted.
 */
export interface ExtraTerms {
  readonly status?: OrderStatus | null
  readonly late?: boolean
  readonly deposit?: boolean
  readonly reaccept?: boolean
  readonly shippedNotInvoiced?: boolean
  readonly invoiced?: InvoicedState | null
  readonly atRisk?: boolean
  readonly currency?: string | null
  readonly customerUrgency?: CustomerUrgency | null
  // F-CP-141 (customer page plan C2d; 11-money §3.2): the price check term — the orders whose check reads Equal, Not equal or No
  // customer price yet (`?priceMatch=`: the list, its totals and its file read it; never the board). A price holder's only: the API
  // refuses it in words without the price grain, and the sheet carries it in no read for such a person (it holds the view in words).
  readonly priceMatch?: PriceMatch | null
  // ---- end F-CP-141
}

const CURRENCY = /^[A-Z]{3}$/

/** The extra terms of an address, given the rows view it shows (a term the view already says is not extra). */
export function extraFromAddress(params: { get(name: string): string | null } | null, rows: RowView): ExtraTerms {
  if (!params) return {}
  const status = params.get('status')
  const invoiced = params.get('invoiced')
  const currency = params.get('currency')?.trim() ?? ''
  const urgency = params.get('customerUrgency')
  const priceMatch = params.get('priceMatch') // F-CP-141
  return {
    ...(isStatus(status) && rows !== status ? { status } : {}),
    ...(params.get('late') === 'true' && rows !== 'late' ? { late: true } : {}),
    ...(params.get('deposit') === 'OPEN' && rows !== 'deposit' ? { deposit: true } : {}),
    ...(params.get('reaccept') === 'true' && rows !== 'reaccept' ? { reaccept: true } : {}),
    ...(params.get('shippedNotInvoiced') === 'true' && rows !== 'uninvoiced' ? { shippedNotInvoiced: true } : {}),
    ...(invoiced && (INVOICED_STATES as readonly string[]).includes(invoiced) ? { invoiced: invoiced as InvoicedState } : {}),
    ...(params.get('atRisk') === 'true' ? { atRisk: true } : {}),
    ...(CURRENCY.test(currency) ? { currency } : {}),
    ...(urgency && (CUSTOMER_URGENCIES as readonly string[]).includes(urgency) ? { customerUrgency: urgency as CustomerUrgency } : {}),
    ...(priceMatch && (PRICE_MATCHES as readonly string[]).includes(priceMatch) ? { priceMatch: priceMatch as PriceMatch } : {}), // F-CP-141
  }
}

/** An extra terms object with nothing in it (no chip, no term). */
export const noExtra = (extra: ExtraTerms | null | undefined): boolean => !extra || extraEntries(extra, 'all').length === 0

/** The address terms of the extra terms (the rows view's own left out). */
function extraEntries(extra: ExtraTerms, rows: RowView): Array<[string, string]> {
  const out: Array<[string, string]> = []
  if (extra.status && rows !== extra.status) out.push(['status', extra.status])
  if (extra.late && rows !== 'late') out.push(['late', 'true'])
  if (extra.deposit && rows !== 'deposit') out.push(['deposit', 'OPEN'])
  if (extra.reaccept && rows !== 'reaccept') out.push(['reaccept', 'true'])
  if (extra.shippedNotInvoiced && rows !== 'uninvoiced') out.push(['shippedNotInvoiced', 'true'])
  if (extra.invoiced) out.push(['invoiced', extra.invoiced])
  if (extra.atRisk) out.push(['atRisk', 'true'])
  if (extra.currency) out.push(['currency', extra.currency])
  if (extra.customerUrgency) out.push(['customerUrgency', extra.customerUrgency])
  if (extra.priceMatch) out.push(['priceMatch', extra.priceMatch]) // F-CP-141
  return out
}

/** The extra terms as the API reads them. */
function extraQueryOf(extra: ExtraTerms | null): OrderQuery {
  if (!extra) return {}
  return {
    ...(extra.status ? { status: extra.status } : {}),
    ...(extra.late ? { late: true } : {}),
    ...(extra.deposit ? { deposit: 'OPEN' as const } : {}),
    ...(extra.reaccept ? { reaccept: true } : {}),
    ...(extra.shippedNotInvoiced ? { shippedNotInvoiced: true } : {}),
    ...(extra.invoiced ? { invoiced: extra.invoiced } : {}),
    ...(extra.atRisk ? { atRisk: true } : {}),
    ...(extra.currency ? { currency: extra.currency } : {}),
    ...(extra.customerUrgency ? { customerUrgency: extra.customerUrgency } : {}),
    ...(extra.priceMatch ? { priceMatch: extra.priceMatch } : {}), // F-CP-141: the list and its totals (never the board: boardNarrowOf)
  }
}

/** One extra term less (its chip's ✕). */
export function withoutExtra(extra: ExtraTerms, key: keyof ExtraTerms): ExtraTerms {
  const next = { ...extra }
  delete next[key]
  return next
}

// ── F-CP-141 (customer page plan C4, money wall O1–O3; 10 §5): the price check term is a price holder's only ──
/**
 * The terms a reader's reads carry: without the price grain the price check term goes from every read (a shared saved view or a
 * link that names it reads nothing with it, and writes no address either); `held` says the address asked for it — the sheet then
 * holds the view in ONE line ("Amounts are shown to people who see prices" + Show all orders), never an answer about prices.
 */
export function priceTermOf(extra: ExtraTerms, can: Pick<OrderAbilities, 'price'>): { readonly extra: ExtraTerms; readonly held: boolean } {
  if (!extra.priceMatch || can.price) return { extra, held: false }
  return { extra: withoutExtra(extra, 'priceMatch'), held: true }
}

/**
 * The price check term set or dropped by a person's pick, in ONE write: the cell's funnel narrows the view shown (`view` absent);
 * a view picked with it (the Not equal view: `rows=all` and the term alone) stands alone; null drops it (leaving that view, the
 * next view keeps the other door terms).
 */
export function withPriceMatch(extra: ExtraTerms, match: PriceMatch | null, alone = false): ExtraTerms {
  if (!match) return withoutExtra(extra, 'priceMatch')
  return alone ? { priceMatch: match } : { ...extra, priceMatch: match }
}
// ── end F-CP-141 ──

/**
 * A total's door: the list's address for exactly the rows it counts, from the filter the API gave it (GET /sales/orders/summary;
 * the API's names → the page's: partyId → party, companyId → company). The rows view is the filter's own (`late`, `deposit`,
 * `reaccept`, `shippedNotInvoiced`, a `status`, else the open orders when it says `open`, else every order); the rest are extra.
 */
export function doorAddress(path: string, filter: Readonly<Record<string, string>>): string {
  const query = new URLSearchParams()
  const rowsTerm = filter.late === 'true' || filter.deposit === 'OPEN' || filter.reaccept === 'true' || filter.shippedNotInvoiced === 'true' || isStatus(filter.status)
  if (filter.status && isStatus(filter.status)) query.set('status', filter.status)
  if (filter.late === 'true') query.set('late', 'true')
  if (filter.deposit === 'OPEN') query.set('deposit', 'OPEN')
  if (filter.reaccept === 'true') query.set('reaccept', 'true')
  if (filter.shippedNotInvoiced === 'true') query.set('shippedNotInvoiced', 'true')
  // `open=true` alone is the list's default (the open orders); neither it nor a rows term: every order.
  if (!rowsTerm && filter.open !== 'true') query.set('rows', 'all')
  if (filter.partyId) query.set('party', filter.partyId)
  if (filter.companyId) query.set('company', filter.companyId)
  for (const name of ['brand', 'cf', 'invoiced', 'atRisk', 'currency', 'customerUrgency', 'kind' /* F-SA-221 */, 'profile' /* F-SA-222 */, 'priceMatch' /* F-CP-141 */, 'q'] as const) if (filter[name] && !(name === 'atRisk' && filter[name] !== 'true')) query.set(name, filter[name]!)
  const qs = query.toString()
  return `${path}${qs ? `?${qs}` : ''}`
}
/**
 * What narrows the board's counts and tiles: the customer's label, the company, the custom fields and the door terms that are not
 * rows views (Invoiced, At risk, the currency, the customer's mark, "Shipped, not invoiced" beside another view). The rows view itself
 * stays the tiles' and lanes' own, as before.
 */
export function boardNarrowOf(narrow: Narrowing): { brand: string | null; companyId: string | null; cf: string | null } & Pick<OrderQuery, 'invoiced' | 'atRisk' | 'currency' | 'customerUrgency' | 'shippedNotInvoiced' | 'kind' /* F-SA-221 */ | 'profile' /* F-SA-222 */ | 'waiting' /* F-SA-276 */> {
  const extra = narrow.extra ?? {}
  return { brand: narrow.brand ?? null, companyId: narrow.companyId ?? null, cf: narrow.cf ?? null, invoiced: extra.invoiced ?? null, atRisk: !!extra.atRisk, currency: extra.currency ?? null, customerUrgency: extra.customerUrgency ?? null, shippedNotInvoiced: !!extra.shippedNotInvoiced, kind: narrow.kind ?? null, profile: narrow.profile ?? null, waiting: narrow.waiting ?? null }
}
// ── end B-TH-244 ──

// ---- F-OP-111: Split into new orders… (⋯ Edit; POST /sales/orders/:id/split, orders.manage) ---------------------------------------

/** The orders one split makes at most, and its reason's length (the API's own limits). */
export const SPLIT_LIMITS = Object.freeze({ parts: ORDERS_DEPTH_LIMITS.splitParts, reason: ORDERS_DEPTH_LIMITS.splitReason })
const SPLIT_STATES: readonly OrderStatus[] = ['CONFIRMED', 'IN_PRODUCTION', 'READY']

/** A line a part may take pieces of: each size with what may still move (`open`: not on a work order — the rest stays here). */
export interface SplitLine {
  readonly lineId: string
  readonly seq: number
  readonly style: string
  readonly colour: string
  readonly sizes: readonly { readonly size: string; readonly quantity: number; readonly open: number }[]
}

/** One part as typed: its pieces per line and size, where it ships (null: as this order), its PO and dates (the order's by default). */
export interface SplitPartDraft {
  readonly grid: Readonly<Record<string, Readonly<Record<string, number>>>>
  readonly shipToAddressId: string | null
  readonly customerRef: string
  readonly requestedDate: string
  readonly promiseDate: string
}

/** A refusal of the split at its place: a part of the dialog (its index), or the split as a whole (null). */
export interface SplitRefusal {
  readonly part: number | null
  readonly words: Phrase
}

/**
 * The lines a split may move: size-grid lines not closed short, each size with the pieces not on a work order yet (pieces a work order
 * makes stay with this order: the work order keeps making them for it). A fee, a made-to-measure unit and a line closed short stay.
 */
export function splitLinesOf(order: Pick<Order, 'lines'>): SplitLine[] {
  return order.lines
    .filter((line) => line.kind === 'SIZE_GRID' && !line.closedShort)
    .map((line) => ({
      lineId: line.id,
      seq: line.seq,
      style: line.style?.code ?? '—',
      colour: line.colourway ? `${line.colourway.code} ${line.colourway.name}` : '—',
      sizes: line.sizes.flatMap((size) => (size.size === null ? [] : [{ size: size.size, quantity: size.quantity, open: Math.max(0, size.quantity - size.progress.inWorkOrders) }])),
    }))
    .filter((line) => line.sizes.some((size) => size.open > 0))
}

/** The lines that stay here whatever is split (a fee, a made-to-measure unit, a line closed short). */
export const splitStays = (order: Pick<Order, 'lines'>): number => order.lines.filter((line) => line.kind !== 'SIZE_GRID' || !!line.closedShort).length

/** A new part: nothing moved yet; it ships to, is requested and promised as this order, with its PO. */
export function splitPartOf(order: Pick<Order, 'customerRef' | 'requestedDate' | 'promiseDate'>): SplitPartDraft {
  return { grid: {}, shipToAddressId: null, customerRef: order.customerRef ?? '', requestedDate: order.requestedDate ?? '', promiseDate: order.promiseDate ?? '' }
}

/** Why ⋯ "Split into new orders…" waits: no right, the order's state, nothing that may move. */
export function splitHeld(order: Order, can: OrderAbilities): Phrase | null {
  if (!can.manage) return phrase('held.noManage')
  if (!SPLIT_STATES.includes(order.status)) return phrase('split.held.state')
  if (splitLinesOf(order).length === 0) return phrase('split.held.nothing')
  return null
}

/** What part `index` may still take of a line's size: what may move, less what the other parts take. */
export function splitRoom(line: SplitLine, size: string, parts: readonly SplitPartDraft[], index: number): number {
  const open = line.sizes.find((entry) => entry.size === size)?.open ?? 0
  const others = parts.reduce((sum, part, at) => (at === index ? sum : sum + (part.grid[line.lineId]?.[size] ?? 0)), 0)
  return Math.max(0, open - others)
}

/** The cells of part `index` above what it may take (the grid marks each with its room). */
export function splitOver(lines: readonly SplitLine[], parts: readonly SplitPartDraft[], index: number): { lineId: string; size: string; room: number }[] {
  const part = parts[index]
  if (!part) return []
  return lines.flatMap((line) =>
    line.sizes.flatMap((size) => {
      const asked = part.grid[line.lineId]?.[size.size] ?? 0
      const room = splitRoom(line, size.size, parts, index)
      return asked > room ? [{ lineId: line.lineId, size: size.size, room }] : []
    }),
  )
}

/** The pieces a part moves. */
export const splitPieces = (part: SplitPartDraft): number => Object.values(part.grid).reduce((sum, sizes) => sum + Object.values(sizes).reduce((acc, quantity) => acc + (quantity > 0 ? quantity : 0), 0), 0)

/** Every piece of the order would move: it would keep nothing (the API refuses it). */
export function splitKeepsNothing(order: Pick<Order, 'lines'>, parts: readonly SplitPartDraft[]): boolean {
  return order.lines.every((line) => line.kind === 'SIZE_GRID' && !line.closedShort && line.sizes.every((size) => size.size !== null && parts.reduce((sum, part) => sum + (part.grid[line.id]?.[size.size!] ?? 0), 0) >= size.quantity))
}

/** A date typed for a part that differs from the order's and lies before today (the order's own date is sent as it is: never). */
const pastDay = (typed: string, own: string | null, today: string): boolean => typed !== '' && typed !== (own ?? '') && typed < today

/** Why "Split" waits, the first that holds it (the dialog's held words), or null when it may go. */
export function splitProblem(input: { order: Order; parts: readonly SplitPartDraft[]; reason: string; today: string }): Phrase | null {
  const { order, parts, reason, today } = input
  if (parts.length === 0 || parts.some((part) => splitPieces(part) === 0)) return phrase('split.held.empty')
  if (parts.length > SPLIT_LIMITS.parts) return phrase('split.held.parts', { count: SPLIT_LIMITS.parts })
  const lines = splitLinesOf(order)
  if (parts.some((_, index) => splitOver(lines, parts, index).length > 0)) return phrase('split.held.over')
  if (splitKeepsNothing(order, parts)) return phrase('amend.held.empty')
  if (parts.some((part) => pastDay(part.requestedDate, order.requestedDate, today))) return phrase('issue.requestedDate')
  if (parts.some((part) => pastDay(part.promiseDate, order.promiseDate, today))) return phrase('issue.promiseDate')
  if (reason.trim().length > SPLIT_LIMITS.reason) return phrase('split.problem.reason', { count: SPLIT_LIMITS.reason })
  return null
}

/**
 * The split as the API reads it: each part's lines with the sizes that move (a line of which every piece moves goes whole, with its
 * delivery schedule), and only what differs from the order (a PO cleared: none; a date cleared: none; else the order's own).
 */
export function splitBodyOf(order: Order, parts: readonly SplitPartDraft[], reason: string, version: number): SplitBody {
  const lines = splitLinesOf(order)
  const why = reason.trim()
  return {
    version,
    ...(why ? { reason: why } : {}),
    parts: parts.map((part) => {
      const ref = part.customerRef.trim()
      return {
        lines: lines.flatMap((line) => {
          const sizes = line.sizes.map((size) => ({ size: size.size, quantity: part.grid[line.lineId]?.[size.size] ?? 0 })).filter((size) => size.quantity > 0)
          return sizes.length > 0 ? [{ lineId: line.lineId, sizes }] : []
        }),
        ...(part.shipToAddressId ? { shipToAddressId: part.shipToAddressId } : {}),
        ...(ref !== (order.customerRef ?? '') ? { customerRef: ref || null } : {}),
        ...(part.requestedDate !== (order.requestedDate ?? '') ? { requestedDate: part.requestedDate || null } : {}),
        ...(part.promiseDate !== (order.promiseDate ?? '') ? { promiseDate: part.promiseDate || null } : {}),
      }
    }),
  }
}

/**
 * A refused split in this app's words, each at its place (issueWords pattern: by the path only, never the API's English):
 * `body/parts/1/lines/0/sizes` → part 2, "Line 20 has a delivery schedule or options: it moves whole or stays here". The words name
 * this order's lines and sizes only (another customer's address is "cannot be used", as an unknown one). Each said once.
 */
export function splitRefusals(issues: readonly ApiIssue[], body: SplitBody, order: Pick<Order, 'lines'>): SplitRefusal[] {
  const lineOf = (part: number, line: number) => body.parts[part]?.lines[line]
  const seqOf = (part: number, line: number): number => order.lines.find((entry) => entry.id === lineOf(part, line)?.lineId)?.seq ?? line + 1
  const out: SplitRefusal[] = []
  const seen = new Set<string>()
  const index = (value: string | undefined): number | null => (value !== undefined && /^\d+$/.test(value) ? Number(value) : null)
  for (const issue of issues) {
    const at = issuePath(issue).replace(/^body\/?/, '').split(/[/.]/).filter(Boolean)
    let refusal: SplitRefusal
    const part = at[0] === 'parts' ? index(at[1]) : null
    if (part !== null) {
      const line = at[2] === 'lines' ? index(at[3]) : null
      if (line !== null) {
        const seq = seqOf(part, line)
        const size = index(at[5])
        if (at[4] === 'lineId') refusal = { part, words: phrase('split.problem.stays', { line: seq }) }
        else if (at[4] === 'sizes' && size !== null) refusal = { part, words: phrase(at[6] === 'size' ? 'split.problem.noSize' : 'split.problem.more', { line: seq, size: lineOf(part, line)?.sizes[size]?.size ?? '—' }) }
        else if (at[4] === 'sizes') refusal = { part, words: phrase('split.problem.whole', { line: seq }) }
        else refusal = { part, words: phrase('split.problem.line', { line: seq }) }
      } else if (at[2] === 'lines') refusal = { part, words: phrase('split.problem.empty') }
      else if (at[2] === 'shipToAddressId') refusal = { part, words: phrase('split.problem.shipTo') }
      else if (at[2] === 'requestedDate') refusal = { part, words: phrase('issue.requestedDate') }
      else if (at[2] === 'promiseDate') refusal = { part, words: phrase('issue.promiseDate') }
      else if (at[2] === 'customerRef') refusal = { part, words: phrase('issue.customerRef') }
      else refusal = { part, words: phrase('problem.write.invalid') }
    } else if (at[0] === 'parts') refusal = { part: null, words: phrase('amend.held.empty') }
    else if (at[0] === 'reason') refusal = { part: null, words: phrase('split.problem.reason', { count: SPLIT_LIMITS.reason }) }
    // The order keeps the rest through an amendment: its refusal names its own lines (`body/lines/…`), never a part's.
    else if (at[0] === 'lines') refusal = { part: null, words: phrase('split.problem.inWork') }
    else refusal = { part: null, words: phrase('problem.write.invalid') }
    const id = `${refusal.part}|${refusal.words.key}|${JSON.stringify(refusal.words.params ?? {})}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push(refusal)
  }
  return out
}
// ---- end F-OP-111

// ---- F-OP-102 (10-order-page §2.2): the ⋯'s Make work orders… also while in production with lines not in work orders yet ----
/** Make work orders… in the ⋯: CONFIRMED (when it is not already the primary) and IN_PRODUCTION while a line is not in work orders. */
export function makeInMenu(order: Pick<Order, 'status'>, notInProduction: number): boolean {
  return order.status === 'IN_PRODUCTION' && notInProduction > 0
}
// ---- end F-OP-102

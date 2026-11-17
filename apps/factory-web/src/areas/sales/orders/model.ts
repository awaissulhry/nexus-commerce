import { isApiError, issuePath } from '../../../lib/api/errors'
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
    viewWorkOrders: held.has('workorders.view'),
    makeWorkOrders: held.has('workorders.manage'),
    viewQuotes: held.has('quotes.view'),
    manageQuotes: held.has('quotes.manage'),
    createShipment: held.has('shipping.manage'),
    price: held.has('money.price'),
    cost: held.has('money.cost'),
    margin: held.has('money.margin'),
  }
}

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
export const ROW_VIEWS = ['open', 'late', 'deposit', 'reaccept', ...ORDER_STATUSES, 'all'] as const
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
export function listAddress(path: string, next: { rows: RowView; q: string; layout: Layout; party?: string | null; brand?: string | null; company?: string | null; sort?: OrderSort | null; cf?: string | null /* B-TH-057 */ }): string {
  const query = new URLSearchParams()
  if (next.layout === 'board') query.set('view', 'board')
  if (next.layout === 'week') query.set('view', 'week') // B-W2b-323
  if (next.rows === 'all') query.set('rows', 'all')
  else if (next.rows === 'late') query.set('late', 'true')
  else if (next.rows === 'deposit') query.set('deposit', 'OPEN')
  else if (next.rows === 'reaccept') query.set('reaccept', 'true') // B-W2b-323
  else if (isStatus(next.rows)) query.set('status', next.rows)
  if (next.party) query.set('party', next.party) // B-TH-201
  if (next.brand) query.set('brand', next.brand) // B-TH-225
  if (next.company) query.set('company', next.company) // B-TH-225
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
  if (isStatus(rows)) return { ...base, status: rows }
  return base
}

/** The tiles (the design's saved-filter tiles), each the saved rows its count stands for. */
export const TILES: ReadonlyArray<{ key: TileKey; rows: RowView }> = Object.freeze([
  { key: 'late', rows: 'late' },
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
  return { status: lane, late: rows === 'late', deposit: rows === 'deposit' ? 'OPEN' : null, reaccept: rows === 'reaccept' /* B-W2b-323 */, q, limit: 50, ...(partyId ? { partyId } : {}) /* B-TH-201 */, ...narrowingOf(narrow) /* B-TH-225 */ }
}

// B-TH-225: only the terms that narrow (an absent one never reaches the API).
// B-TH-057: + the custom field filter and the server sort.
const narrowingOf = (narrow: Narrowing): Pick<OrderQuery, 'brand' | 'companyId' | 'cf' | 'sort'> => ({ ...(narrow.brand ? { brand: narrow.brand } : {}), ...(narrow.companyId ? { companyId: narrow.companyId } : {}), ...(narrow.cf ? { cf: narrow.cf } : {}), ...(narrow.sort ? { sort: narrow.sort } : {}) })

/**
 * B-TH-225 (band-F01: the honest count): how many orders the rows view holds, from the board's counts — the same filters
 * (customer, label, company, search) and the same definitions — or null while the board is unread.
 */
export function viewCount(board: OrderBoard | null, rows: RowView): number | null {
  if (!board) return null
  const byStatus = (statuses: readonly string[]) => board.byStatus.filter((entry) => statuses.includes(entry.status)).reduce((sum, entry) => sum + entry.count, 0)
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

/** Closed and cancelled orders the board does not draw, from the board's counts. */
export function offBoard(board: OrderBoard | null): { closed: number; cancelled: number } | null {
  if (!board) return null
  const count = (status: OrderStatus) => board.byStatus.find((entry) => entry.status === status)?.count ?? 0
  return { closed: count('CLOSED'), cancelled: count('CANCELLED') }
}

/** How far the order's garments left (shipped of ordered), 0–100. */
export const shippedPercent = (row: Pick<OrderRow, 'units' | 'shippedUnits'>): number => (row.units > 0 ? Math.round((row.shippedUnits / row.units) * 100) : 0)

// ---- the record ---------------------------------------------------------------------------------------------------------

// ---- B-TH-214: the order's tabs 9 → 5 (O-SAL-ORD-REC.body; tree G.2, P10: no tabs inside tabs, one place per thing) ----
/**
 * The record's five tabs: Lines · Production & dates (Dates & promise + Production, and the brand tech pack in force) · Shipments &
 * invoices (Shipments + Invoices & payments) · Confirmation & changes (Documents' confirmation and acceptance evidence + Changes) ·
 * Margin (only with the margin grain). Activity left: the thread is docked beside every tab and its tools are in the thread's "⋯"
 * (R-ACT); the files are the thread's Files view.
 */
export const RECORD_TABS = ['lines', 'production', 'shipments', 'changes', 'margin'] as const
export type RecordTab = (typeof RECORD_TABS)[number]

/** Every old `?tab=` keeps working (R-8): the tab it merged into; Activity opens the thread beside Lines (RecordFrame reads it). */
export const MERGED_TABS: Readonly<Record<string, RecordTab>> = { dates: 'production', money: 'shipments', documents: 'changes', activity: 'lines' }

/** The tab an address asks for: one of the five, an old one's new home, else Lines (Margin without the margin grain: Lines). */
export function tabOf(asked: string | null | undefined, can?: Pick<OrderAbilities, 'margin'>): RecordTab {
  const value = asked ?? ''
  const tab = (RECORD_TABS as readonly string[]).includes(value) ? (value as RecordTab) : (Object.hasOwn(MERGED_TABS, value) ? MERGED_TABS[value]! : 'lines') // TH-6 part B: never a name of Object's own (?tab=constructor)
  return tab === 'margin' && can && !can.margin ? 'lines' : tab
}

/** The tabs a person sees: Margin only with the margin grain (never an empty tab with zeros). */
export const recordTabs = (can: Pick<OrderAbilities, 'margin'>): readonly RecordTab[] => RECORD_TABS.filter((tab) => tab !== 'margin' || can.margin)

/** A tab whose body is a wide grid (the size grids of Lines): the docked thread takes one third under 1600 px (PL1, R-18). */
export const isWideTab = (tab: RecordTab): boolean => tab === 'lines'

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

export type StepKind = 'makeWorkOrders' | 'changePromise' | 'close'

export interface NextStep {
  kind: StepKind | null
  held: Phrase | null
}

/**
 * The band's primary by state (design "Next step by state"): Confirmed → Make work orders (held while production waits
 * for the deposit); In production, Ready, Partly shipped → Change promise date; Shipped → Close order (held until
 * settled unless the person may close an unsettled order with a reason). Ready's "Create shipment" waits for the
 * Warehouse pages (no dead control): its promise is the step meanwhile.
 */
export function nextStep(order: Order, can: OrderAbilities): NextStep {
  if (order.status === 'CONFIRMED') {
    if (!can.makeWorkOrders) return { kind: 'makeWorkOrders', held: phrase('held.noWorkOrders') }
    const gate = depositGate(order)
    if (gate.state === 'WAITING') return { kind: 'makeWorkOrders', held: phrase('held.deposit', { date: gate.request?.dueDate ?? '' }) }
    if (gate.state === 'MISSING') return { kind: 'makeWorkOrders', held: phrase('held.depositMissing') }
    return { kind: 'makeWorkOrders', held: null }
  }
  if (order.status === 'SHIPPED') return { kind: 'close', held: closeHeld(order, can) }
  if (isFinal(order)) return { kind: null, held: null }
  return { kind: 'changePromise', held: can.manage ? null : phrase('held.noManage') }
}

/** Why closing waits: no right, or not settled without the right to close it anyway. */
export function closeHeld(order: Order, can: OrderAbilities): Phrase | null {
  if (order.status !== 'SHIPPED') return phrase('held.closeState')
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

export function readyHeld(order: Order, can: OrderAbilities): Phrase | null {
  if (!can.manage) return phrase('held.noManage')
  return actionOf(order, 'markReady') ? null : phrase('held.readyState')
}

export function promiseHeld(order: Order, can: OrderAbilities): Phrase | null {
  if (!can.manage) return phrase('held.noManage')
  return actionOf(order, 'changePromise') ? null : phrase('held.final')
}

/** Lines may get their own promise only before anything shipped (the API refuses it after). */
export const linePromisesAllowed = (order: Pick<Order, 'status'>): boolean => ['CONFIRMED', 'IN_PRODUCTION', 'READY'].includes(order.status)

/** Problems of a typed promise change, as message keys (the API holds the same rules). */
export function promiseProblems(input: { date: string; reason: string; today: string; current: string | null; lineIds: readonly string[]; allLines: boolean }): { date?: string; reason?: string; lines?: string } {
  const problems: { date?: string; reason?: string; lines?: string } = {}
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) problems.date = 'promise.problem.date'
  else if (input.date < input.today) problems.date = 'promise.problem.past'
  else if (input.allLines && input.date === input.current) problems.date = 'promise.problem.same'
  if (input.reason.trim() === '') problems.reason = 'promise.problem.reason'
  if (!input.allLines && input.lineIds.length === 0) problems.lines = 'promise.problem.lines'
  return problems
}

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

/** What a size grid shows: ordered, in work orders, released by quality, shipped, or still to ship. */
export const SIZE_LAYERS = ['ordered', 'inWorkOrders', 'released', 'shipped', 'toShip'] as const
export type SizeLayer = (typeof SIZE_LAYERS)[number]

/** A style group's grid shape and values for one layer (colour rows × the sizes in the style's range order). */
export function gridOf(group: StyleGroup, layer: SizeLayer): { sizes: { key: string; label: string }[]; colours: { key: string; label: string; offered: string[] }[]; value: Record<string, Record<string, number>> } {
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

const LIVE_PREFIXES = ['sales_order.', 'deposit_request.', 'payment.', 'invoice.', 'workorder.', 'shipment.', 'order.', 'quote.accepted'] as const

/** Every id a live event's fields name (a string, or a list of strings). */
function idsOf(fields: Readonly<Record<string, unknown>>): string[] {
  return Object.values(fields).flatMap((value) => (typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []))
}

/**
 * Whether a live event concerns the orders (the list: any order, deposit, payment, invoice, work order or shipment
 * event), or this order (the record: one that names the order or a record of its chain). A message is a hint: the page
 * reads again, it never takes data from the message.
 */
export function liveTouches(change: { type: string; fields: Readonly<Record<string, unknown>> }, known?: ReadonlySet<string>): boolean {
  if (!LIVE_PREFIXES.some((prefix) => change.type.startsWith(prefix))) return false
  if (!known) return true
  return idsOf(change.fields).some((id) => known.has(id))
}

/**
 * Whether a live event changes what the list shows (a new order, a state or promise that moved, a deposit paid or
 * waived): floor scans and invoice events do not, so they never count as "updates".
 */
export const listTouches = (change: { type: string }): boolean =>
  change.type.startsWith('sales_order.') || (change.type.startsWith('deposit_request.') && change.type !== 'deposit_request.link_sent') || change.type === 'payment.deposit_paid' || change.type === 'quote.accepted'

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

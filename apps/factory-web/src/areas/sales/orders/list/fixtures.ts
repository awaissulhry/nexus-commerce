import { createElement, useMemo, useRef, useState, type ReactNode } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { BOARD_LANES } from '../api'
import { DEMO_COMPANIES } from '../../../../shell/design-data'
import { at, BOARD, canOf, forRole, inShell, LIST_ROWS, OPEN_ROWS, PARTY, PARTY_ROWS, PREFIX, TODAY, type Role } from '../_demo/fixtures'
import type { Lane } from '../model'
import type { NewOrderDialogModel, OrdersListModel } from './list-model'
import { OrdersListView } from './view/OrdersListView'
import { LIST_MARGINS } from './margin/fixtures'
// ---- B-W2b-323 (orders in depth on screen) ----
import { demoOrdersImport, listDepth, weekModel } from '../depth/demo/fixtures'
import { LIST_ROWS as ALL_ROWS } from '../_demo/fixtures'
// ---- B-TH-225 / B-TH-226 (TH-1a: the Orders sheet and the Customer switcher) ----
import type { OrderCustomer } from '../api'
// ---- B-TH-243 / B-TH-244 (TH-4: Views ▾, the overall view, custom and later columns) ----
import type { OrderSummary, SummaryFigures } from '../api'
import { ListToolsContext, type ListField, type ListFieldValue } from '../../../../list-frame/tools/transport'
import { memoryStore, memoryTransport, type MemoryToolsModel } from '../../../_shared/list-tools/memory'
import type { BulkRowFacts } from '@nexus/factory-domain/views/bulk/rules' // B-TH-245: the cells' bulk rows

/**
 * SCR-038 — Orders (design sales.orders) with made-up data only: every state of the list (loading, error, empty, nothing
 * matching, short, more pages, live updates, no permission), the tiles (saved rows: Late, Waiting for deposit, In
 * production, Ready to ship), the selection and Export N, the board by state (lanes with counts and values, a lane
 * still reading or failed, closed orders off the board), and the roles: Owner, Sales, Finance and the Production
 * manager (read-only, no money). Ticks, the header box, shift-click, j / k / x / Enter / v and ? work for real.
 * B-W2a-50: New order (c) — the customer search, a customer picked, a blocked one, no number series — and the board
 * that follows live (open it in a new tab), a ready card's Create shipment.
 */

interface ListCase {
  role: Role
  list: OrdersListModel
  /** B-TH-243 / B-TH-244: the list tools in memory (Views ▾ with the built-ins, Customise, custom fields, a layout). */
  tools?: MemoryToolsModel
}

const rowsFor = (role: Role, items = OPEN_ROWS) => forRole(items, role)

const lanesOf = (role: Role, rows = LIST_ROWS, over: Partial<Record<(typeof BOARD_LANES)[number], Partial<Lane>>> = {}): Lane[] =>
  BOARD_LANES.map((status) => ({ status, items: rowsFor(role, rows.filter((entry) => entry.status === status)), more: false, problem: null, ...over[status] }))

const base = (role: Role, over: Partial<OrdersListModel> = {}): ListCase => ({
  role,
  list: {
    prefix: PREFIX,
    can: canOf(role),
    today: TODAY,
    layout: 'list',
    rows: 'open',
    q: '',
    list: { items: rowsFor(role), more: false, problem: null },
    lanes: [],
    board: BOARD,
    asOf: at(29, 9, 42),
    live: 'live',
    updates: 0,
    notice: null,
    ...over,
  },
})

const board = (role: Role, over: Partial<OrdersListModel> = {}): ListCase => base(role, { layout: 'board', lanes: lanesOf(role), ...over })

const newOrder = (over: Partial<NewOrderDialogModel> = {}): NewOrderDialogModel => ({
  companies: DEMO_COMPANIES.slice(0, 1),
  companyId: DEMO_COMPANIES[0].id,
  results: PARTY_ROWS,
  searchProblem: null,
  party: null,
  partyProblem: null,
  contactId: '',
  customerRef: '',
  number: 'SO-2026-0089',
  // B-TH-221: the one pointer — a written request goes to Incoming's New request.
  incomingHref: `${PREFIX}/sales/incoming?new=1`,
  ...over,
})

function OrdersDesign({ model }: { model: ListCase }) {
  const view = createElement(OrdersListView, { model: model.list })
  return inShell('/sales/orders', model.tools ? createElement(MemoryTools, { tools: model.tools }, view) : view, model.role)
}

// ── B-TH-243 / B-TH-244: the list tools in memory for the design cases (nothing leaves the page) ──
function MemoryTools({ tools, children }: { tools: MemoryToolsModel; children?: ReactNode }) {
  const [query, setQuery] = useState('')
  const store = useRef(memoryStore(tools))
  const transport = useMemo(() => memoryTransport(tools, store.current, query, setQuery), [tools, query])
  return createElement(ListToolsContext.Provider, { value: transport }, children)
}

const VIEWS_ANSWER: MemoryToolsModel['answer'] = { views: [], roleDefaultId: null, personalDefaultId: null, roles: [{ id: '0190f0e2-7a7a-7000-8000-000000000001', name: 'Account team' }], allRoles: [], can: { save: true, manage: false, export: true }, exports: { formats: ['XLSX', 'CSV'] } }

/** Made-up custom fields of orders: one for every customer, one for the first demo customer only (it shows on its rows alone). */
const FIELDS: ListField[] = [
  { code: 'hang_tag', columnId: 'cf:hang_tag', type: 'TEXT', labelIt: 'Cartellino', labelEn: 'Hang tag', unit: null, companyId: null, partyId: null, options: [] },
  { code: 'alpha_box', columnId: 'cf:alpha_box', type: 'SELECT', labelIt: 'Scatola del cliente', labelEn: 'Customer box', unit: null, companyId: null, partyId: ALL_ROWS[0]!.partyId, options: [{ code: 'GIFT', labelIt: 'Regalo', labelEn: 'Gift box', active: true }] },
]
const FIELD_VALUES: Record<string, Record<string, ListFieldValue>> = Object.fromEntries(
  ALL_ROWS.map((entry, index) => [entry.id, { hang_tag: { value: `HT-${index + 1}`, wordsIt: null, wordsEn: null }, ...(entry.partyId === ALL_ROWS[0]!.partyId ? { alpha_box: { value: 'GIFT', wordsIt: null, wordsEn: null } } : {}) }]),
)
const tools = (over: Partial<MemoryToolsModel> = {}): MemoryToolsModel => ({ pageKey: 'sales.orders', locale: 'en', answer: VIEWS_ANSWER, jobs: [], ...over })

/** Made-up figures of a view ("every order"): the doors as the API makes them (the view's terms + the figure's own). */
function figures(party: string | null, rows: typeof ALL_ROWS, price: boolean): SummaryFigures {
  const view: Record<string, string> = party ? { partyId: party } : {}
  const door = (count: number, extra: Record<string, string> = {}) => ({ count, filter: { ...view, ...extra } })
  const sum = (pick: (entry: (typeof ALL_ROWS)[number]) => number) => rows.reduce((total, entry) => total + pick(entry), 0)
  return {
    orders: door(rows.length),
    pieces: { ordered: door(sum((entry) => entry.units)), shipped: door(sum((entry) => entry.shippedUnits)), open: door(sum((entry) => (['SHIPPED', 'CLOSED', 'CANCELLED'].includes(entry.status) ? 0 : entry.units - entry.shippedUnits)), { open: 'true' }) },
    late: door(rows.filter((entry) => (entry.daysLate ?? 0) > 0).length, { late: 'true' }),
    atRisk: door(1, { atRisk: 'true' }),
    invoiced: { NONE: door(rows.filter((entry) => entry.invoiced?.state === 'NONE').length, { invoiced: 'NONE' }), PART: door(rows.filter((entry) => entry.invoiced?.state === 'PART').length, { invoiced: 'PART' }), ALL: door(rows.filter((entry) => entry.invoiced?.state === 'ALL').length, { invoiced: 'ALL' }) },
    ...(price ? { net: [{ currency: 'EUR', amount: sum((entry) => entry.netAmount ?? 0), filter: { ...view, currency: 'EUR' } }] } : {}),
  }
}
function summaryOf(role: Role): OrderSummary {
  const price = canOf(role).price
  const parties = [...new Map(ALL_ROWS.map((entry) => [entry.partyId, entry.partyName])).entries()]
  return {
    all: figures(null, ALL_ROWS, price),
    groups: parties.map(([partyId, name], index) => ({ partyId, code: `C-${index + 1}`, name, invoiceTiming: index === 1 ? 'MONTHLY' : 'PER_SHIPMENT', figures: figures(partyId, ALL_ROWS.filter((entry) => entry.partyId === partyId), price) })),
    limited: false,
    asOf: at(29, 9, 42),
  }
}
/** The grouped view (Owner, every order): the first customer's group read, the second still reading, the third folded. */
function grouped(role: Role, over: Partial<OrdersListModel> = {}): ListCase {
  const summary = summaryOf(role)
  const [first, second, third] = summary.groups!
  const rowsOfFirst = forRole(ALL_ROWS.filter((entry) => entry.partyId === first!.partyId), role)
  return base(role, {
    rows: 'all',
    group: 'party',
    summary: { value: summary, problem: null },
    groupRows: { [first!.partyId]: { items: rowsOfFirst, cursor: null, more: true, problem: null, loading: false }, [second!.partyId]: { items: null, cursor: null, more: false, problem: null, loading: true } },
    collapsed: [third!.partyId],
    list: { items: rowsOfFirst, more: false, problem: null },
    demoPictures: PICTURES,
    switcher: switcherOf(CUSTOMERS),
    ...over,
  })
}
// ── end B-TH-243 / B-TH-244 ──

// ── B-TH-225 / B-TH-226: the sheet's design data (made up) ──
/** A small made-up garment drawing as each row's picture (the page reads the store's small previews). */
const garment = (fill: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#eef1f5"/><path fill="${fill}" d="M30 18 L42 12 Q50 19 58 12 L70 18 L85 35 L77 45 L70 40 L70 87 L30 87 L30 40 L23 45 L15 35 Z"/><path stroke="#ffffff" stroke-opacity=".5" d="M50 17 V87"/></svg>`)}`
const PICTURES: Readonly<Record<string, string>> = Object.fromEntries(ALL_ROWS.filter((entry) => entry.picture?.small).map((entry, index) => [entry.id, garment(['#36506b', '#8a5a2b', '#2f6b4f'][index % 3]!)]))

const CUSTOMERS: OrderCustomer[] = [...new Map(ALL_ROWS.map((entry) => [entry.partyId, entry.partyName])).entries()].map(([id, name], index) => ({
  id,
  code: `C-${index + 1}`,
  name,
  archived: false,
  orders: ALL_ROWS.filter((entry) => entry.partyId === id).length,
  open: OPEN_ROWS.filter((entry) => entry.partyId === id).length,
  late: OPEN_ROWS.filter((entry) => entry.partyId === id && (entry.daysLate ?? 0) > 0).length,
  lastOrderDate: '2026-10-28',
}))

function switcherOf(customers: OrderCustomer[], over: Partial<NonNullable<OrdersListModel['switcher']>> = {}): NonNullable<OrdersListModel['switcher']> {
  return { customers, total: customers.length, limited: false, problem: null, query: '', searching: false, ...over }
}

function sheet(role: Role, over: Partial<OrdersListModel> = {}): ListCase {
  return base(role, { demoPictures: PICTURES, switcher: switcherOf(CUSTOMERS), companies: DEMO_COMPANIES.slice(0, 1).map((entry) => ({ id: entry.id, name: entry.name })), ...over })
}
// ── end B-TH-225 / B-TH-226 ──

export const designScreen = defineDesignScreen<ListCase>({
  screen: 'SCR-038',
  title: 'Orders (Sales): list and board by state',
  view: OrdersDesign,
  cases: [
    { id: 'open', label: 'Sales: the open orders (the default rows), live', model: base('sales'), note: 'Tick a row: the toolbar swaps to Export N. Press a tile: its saved rows. v switches to the board.' },
    { id: 'owner-all', label: 'Owner: every order (Rows ▾ All orders)', model: base('owner', { rows: 'all', list: { items: rowsFor('owner', LIST_ROWS), more: false, problem: null } }) },
    { id: 'late', label: 'The Late tile pressed (also Home › Today’s “See all”: ?late=true)', model: base('sales', { rows: 'late', list: { items: rowsFor('sales', LIST_ROWS.filter((entry) => (entry.daysLate ?? 0) > 0)), more: false, problem: null } }) },
    // B-TH-057 (TH-4): the server sort (Sort ▾, the Promised header's arrow) and a custom field filter as a chip.
    { id: 'th4-sorted', label: 'Sorted on the server: promise date, soonest first (every page; the Promised header shows the arrow)', model: base('sales', { sort: 'promise', list: { items: rowsFor('sales', [...LIST_ROWS].sort((a, b) => (a.promiseDate ?? '9999').localeCompare(b.promiseDate ?? '9999'))), more: false, problem: null } }), note: 'Sort ▾ and the headers of Customer, Brand, Promised and Ordered sort every page on the server; no other header sorts.' },
    { id: 'th4-custom-filter', label: 'A custom field filter in the address (?cf=): a chip with ✕, applied by the list, its counts and its file', model: base('sales', { cf: 'rush_note:rush', sort: '-daysLate' }) },
    { id: 'deposit', label: 'Waiting for deposit (?deposit=OPEN): one overdue, one due next week', model: base('finance', { rows: 'deposit', list: { items: rowsFor('finance', LIST_ROWS.filter((entry) => entry.deposit.state === 'OPEN')), more: false, problem: null } }) },
    { id: 'selected', label: 'Three orders selected: Export 3 (CSV)', model: base('sales', { selected: OPEN_ROWS.slice(0, 3).map((entry) => entry.id) }) },
    { id: 'live-updates', label: 'Live: 2 changes wait behind Show (a quote was accepted, a deposit was paid)', model: base('sales', { updates: 2 }) },
    { id: 'more', label: 'More pages: Show 50 more in the footer', model: base('sales', { list: { items: rowsFor('sales'), more: true, problem: null } }) },
    { id: 'short', label: 'A short list: two rows, no empty band', model: base('sales', { list: { items: rowsFor('sales', OPEN_ROWS.slice(0, 2)), more: false, problem: null } }) },
    { id: 'no-match', label: 'A search that matches nothing', model: base('sales', { q: 'XYZ-404', list: { items: [], more: false, problem: null } }) },
    { id: 'empty', label: 'No orders yet: they come from accepted quotes', model: base('sales', { list: { items: [], more: false, problem: null }, board: { ...BOARD, byStatus: BOARD.byStatus.map((entry) => ({ ...entry, count: 0 })), tiles: BOARD.tiles.map((tile) => ({ ...tile, count: 0 })) } }) },
    { id: 'loading', label: 'Loading', model: base('sales', { list: { items: null, more: false, problem: null }, board: null, asOf: null, live: 'connecting' }) },
    { id: 'error', label: 'The read failed: in words, with Try again (never drawn as empty); the tiles say —', model: base('sales', { list: { items: null, more: false, problem: 'problem.read.unavailable' }, board: null, live: 'offline' }) },
    { id: 'no-permission', label: 'No permission: the API refused the read (orders.view)', model: base('sales', { list: { items: null, more: false, problem: 'problem.read.forbidden' }, board: null }) },
    { id: 'finance', label: 'Finance: prices, no changes to orders; the deposit column first', model: base('finance') },
    { id: 'manager', label: 'Production manager: no money (no Net column); Make work orders in a confirmed order’s ⋯', model: base('manager') },
    { id: 'help', label: '? the keys of this list', model: base('sales', { helpOpen: true }) },
    { id: 'board', label: 'Board by state (Sales): lanes with counts and values; cards never drag', model: board('sales'), note: 'j / k walk the cards, Enter opens. Closed and cancelled are counted under the board.' },
    { id: 'board-owner', label: 'Board (Owner): a confirmed order with its deposit paid offers Make work orders', model: board('owner') },
    { id: 'board-manager', label: 'Board (Production manager): no values without the price grain', model: board('manager') },
    { id: 'board-late', label: 'Board with Late pressed: the lanes count what they read', model: board('sales', { rows: 'late', lanes: lanesOf('sales', LIST_ROWS.filter((entry) => (entry.daysLate ?? 0) > 0)) }) },
    { id: 'board-more', label: 'Board: a lane with more than 50 orders (no value shown as the whole)', model: board('sales', { rows: 'deposit', lanes: lanesOf('sales', LIST_ROWS, { CONFIRMED: { more: true } }) }) },
    { id: 'board-loading', label: 'Board: lanes reading', model: board('sales', { lanes: BOARD_LANES.map((status) => ({ status, items: null, more: false, problem: null })), asOf: null, live: 'connecting' }) },
    { id: 'board-lane-error', label: 'Board: one lane could not be read (in words, Try again)', model: board('sales', { lanes: lanesOf('sales', LIST_ROWS, { READY: { items: null, problem: 'problem.read.unavailable' } }) }) },
    { id: 'board-closed', label: 'Board with Closed chosen: closed orders are not on the board', model: board('sales', { rows: 'CLOSED', lanes: [] }) },
    { id: 'board-one-state', label: 'Board with In production pressed: that lane only', model: board('sales', { rows: 'IN_PRODUCTION', lanes: lanesOf('sales').filter((lane) => lane.status === 'IN_PRODUCTION') }) },
    { id: 'notice', label: 'A notice above the list', model: base('sales', { notice: { tone: 'danger', words: { key: 'problem.read.unavailable' } } }) },
    // ---- B-W2a-50 ---------------------------------------------------------------------------------------------------------
    { id: 'new-order', label: 'W2a · Sales · New order: search the customer (c opens it); B-TH-221: a written request goes to Incoming (the one pointer)', model: base('sales', { newOrder: newOrder() }), note: 'Pick a customer: the contact and the customer PO come next; Create draft order opens its Lines. A request to answer first goes to Incoming’s New request.' },
    { id: 'new-order-picked', label: 'W2a · Sales · New order: the customer picked, the orders contact chosen, the number it will get', model: base('sales', { newOrder: newOrder({ party: PARTY, contactId: PARTY.contacts[0]!.id, customerRef: 'PO-ESEMPIO-89' }) }) },
    { id: 'new-order-blocked', label: 'W2a · Sales · New order: a blocked customer (Create held with the reason)', model: base('sales', { newOrder: newOrder({ party: { ...PARTY, status: 'BLOCKED' } }) }) },
    { id: 'new-order-companies', label: 'W2a · Owner · New order: two selling companies; no number series yet', model: base('owner', { newOrder: newOrder({ companies: DEMO_COMPANIES, number: null }) }) },
    { id: 'new-order-searching', label: 'W2a · Sales · New order: searching customers', model: base('sales', { newOrder: newOrder({ results: null, number: undefined }) }) },
    { id: 'new-order-held', label: 'W2a · Finance · New order held: taking orders is the sales right', model: base('finance') },
    { id: 'board-live', label: 'W2a · Owner · Board by state (follows live; Board in a new tab); a ready order offers Create shipment', model: board('owner'), note: 'Board in a new tab opens ?view=board: left open on a second screen it reads its lanes again on every change.' },
    // ---- B-W2a-72: Margin % (as estimated now; costing.view + the margin grain) ----
    { id: 'w2a-margin-column', label: 'W2a · Sales · Margin % as estimated now (a negative one in danger; "—" when its cost cannot be told; "…" while read)', model: base('sales', { margins: LIST_MARGINS }) },
    // ---- B-W2b-323: priority and season, Set priority, Print confirmation, Import orders, By promise week ----
    { id: 'w2b-323-priority', label: 'W2b · Sales · Priority (changed in place) and Season columns; the fifth tile', model: base('sales', { depth: listDepth('sales'), week: weekModel(), importer: { held: null, sheet: null } }), note: 'Change a Priority cell: it saves at once (↻ then ✓). URGENT asks its reason. ⋯ on a row: Print confirmation (a new tab). ⋯ in the band: Import orders.' },
    { id: 'w2b-323-inline-saves', label: 'W2b · Sales · Inline priority: one saving, one saved, one refused (the reason on the mark)', model: base('sales', { depth: listDepth('sales', { saves: new Map([[OPEN_ROWS[0]!.id, { state: 'saving' }], [OPEN_ROWS[1]!.id, { state: 'saved' }], [OPEN_ROWS[2]!.id, { state: 'refused', reason: { key: 'problem.write.moved' } }]]) }), week: weekModel(), importer: { held: null, sheet: null } }) },
    { id: 'w2b-323-selected', label: 'W2b · Sales · Three orders selected: Set priority for 3 · Export 3', model: base('sales', { depth: listDepth('sales'), week: weekModel(), importer: { held: null, sheet: null }, selected: OPEN_ROWS.slice(0, 3).map((entry) => entry.id) }) },
    { id: 'w2b-323-set-priority', label: 'W2b · Sales · Set priority for 3: High', model: base('sales', { depth: listDepth('sales', { dialog: { ids: OPEN_ROWS.slice(0, 3).map((entry) => entry.id), single: null, level: 'HIGH', reason: '', busy: false, problem: null, outcome: null } }), week: weekModel(), importer: { held: null, sheet: null } }) },
    { id: 'w2b-323-set-urgent', label: 'W2b · Sales · Urgent asks its reason (held until it is written)', model: base('sales', { depth: listDepth('sales', { dialog: { ids: [OPEN_ROWS[1]!.id], single: { id: OPEN_ROWS[1]!.id, version: 3 }, level: 'URGENT', reason: '', busy: false, problem: null, outcome: null } }), week: weekModel(), importer: { held: null, sheet: null } }) },
    { id: 'w2b-323-set-done', label: 'W2b · Sales · Set priority done: changed, already so, left out (closed or cancelled)', model: base('sales', { depth: listDepth('sales', { dialog: { ids: ALL_ROWS.slice(0, 4).map((entry) => entry.id), single: null, level: 'HIGH', reason: '', busy: false, problem: null, outcome: { priorityLevel: 'HIGH', changed: [ALL_ROWS[1]!.id, ALL_ROWS[2]!.id], unchanged: [ALL_ROWS[0]!.id], skipped: [{ orderId: ALL_ROWS[9]!.id, number: ALL_ROWS[9]!.number }], unknown: 0 } } }), week: weekModel(), importer: { held: null, sheet: null } }) },
    { id: 'w2b-323-reaccept', label: 'W2b · Sales · Waiting for the customer to accept a change (the tile pressed: ?reaccept=true)', model: base('sales', { rows: 'reaccept', list: { items: rowsFor('sales', OPEN_ROWS.slice(1, 2)), more: false, problem: null }, depth: listDepth('sales'), week: weekModel(), importer: { held: null, sheet: null } }) },
    { id: 'w2b-323-waiting-yes', label: 'W2b · Sales · Rows ▾ Waiting for a yes (?status=PENDING_APPROVAL): Print confirmation held', model: base('sales', { rows: 'PENDING_APPROVAL', list: { items: rowsFor('sales', [{ ...OPEN_ROWS[0]!, status: 'PENDING_APPROVAL' }]), more: false, problem: null }, depth: listDepth('sales'), week: weekModel(), importer: { held: null, sheet: null } }) },
    { id: 'w2b-323-manager', label: 'W2b · Production manager · Priority read-only (held: the right to change orders); no Set priority; Import held', model: base('manager', { depth: listDepth('manager'), week: weekModel(), importer: { held: 'import.held.manage', sheet: null } }) },
    { id: 'w2b-323-depth-failed', label: 'W2b · Sales · The priority and season could not be read: the cells say —', model: base('sales', { depth: listDepth('sales', { rows: new Map(), failed: true }), week: weekModel(), importer: { held: null, sheet: null } }) },
    { id: 'w2b-323-week', label: 'W2b · Sales · By promise week: Late first, this week marked, No promise last; cards never drag', model: base('sales', { layout: 'week', depth: listDepth('sales'), week: weekModel(), importer: { held: null, sheet: null } }), note: 'Each card: the order (a real link), its pieces and lines, priority and risk; ⋯ Change promise date… opens its Dates tab.' },
    { id: 'w2b-323-week-sites', label: 'W2b · Owner · By promise week with two sites (the site picker)', model: base('owner', { layout: 'week', depth: listDepth('owner'), week: weekModel(undefined, [{ id: '0190f0e2-1212-7000-8000-000000000001', code: 'PLT', name: 'Stabilimento Demo' }, { id: '0190f0e2-1212-7000-8000-000000000002', code: 'LAB', name: 'Laboratorio Esempio' }]), importer: { held: null, sheet: null } }) },
    { id: 'w2b-323-week-loading', label: 'W2b · By promise week: reading', model: base('sales', { layout: 'week', depth: listDepth('sales'), week: weekModel({ status: 'loading' }), importer: { held: null, sheet: null } }) },
    { id: 'w2b-323-week-error', label: 'W2b · By promise week: the read failed (in words, Try again)', model: base('sales', { layout: 'week', depth: listDepth('sales'), week: weekModel({ status: 'error', problem: 'problem.read.unavailable' }), importer: { held: null, sheet: null } }) },
    { id: 'w2b-323-week-empty', label: 'W2b · By promise week: nothing open to finish', model: base('sales', { layout: 'week', depth: listDepth('sales'), week: weekModel({ status: 'ready', columns: [], complete: true, asOf: at(29, 9, 42), today: TODAY }), importer: { held: null, sheet: null } }) },
    { id: 'w2b-323-week-forbidden', label: 'W2b · Finance · By promise week without the promises right', model: base('finance', { layout: 'week', depth: listDepth('finance'), week: weekModel({ status: 'forbidden' }), importer: { held: 'import.held.manage', sheet: null } }) },
    { id: 'w2b-323-import', label: 'W2b · Sales · Import orders: the dry run (orders it would make, refused rows with their reasons)', model: base('sales', { depth: listDepth('sales'), week: weekModel(), importer: { held: null, sheet: demoOrdersImport('planned'), inline: true } }) },
    // ── B-TH-201 (SHEET-G11, SHEET-G01): Sales › Reports' "Open the list" lands here with ?party=<id> ──
    {
      id: 'th-201-customer',
      label: 'TH-0 · Sales · One customer’s orders (Sales › Reports › Open the list: ?party=…): the chip “Customer: …” clears it',
      model: base('owner', { rows: 'all', customer: { id: LIST_ROWS[0]!.partyId, name: LIST_ROWS[0]!.partyName }, list: { items: rowsFor('owner', LIST_ROWS.filter((entry) => entry.partyId === LIST_ROWS[0]!.partyId)), more: false, problem: null } }),
      note: 'The tiles, the board and By promise week count the same customer; ✕ on the chip shows every customer again.',
    },
    { id: 'th-201-customer-board', label: 'TH-0 · Sales · One customer’s orders on the board', model: board('sales', { customer: { id: LIST_ROWS[0]!.partyId, name: LIST_ROWS[0]!.partyName }, lanes: lanesOf('sales', LIST_ROWS.filter((entry) => entry.partyId === LIST_ROWS[0]!.partyId)) }) },
    {
      id: 'th-201-customer-hidden',
      label: 'TH-0 · A person limited to other customers opens a link to a customer they may not open: no row, and the chip names no one (W27)',
      model: base('sales', { rows: 'all', customer: { id: '0190f0e2-6666-7000-8000-00000000ffff', name: null }, list: { items: [], more: false, problem: null } }),
    },
    // ── end B-TH-201 ──
    // ── B-TH-225 / B-TH-226 (threads plan TH-1a, pictures 23 + 24): the sheet, every cell a door; the Customer switcher ──
    { id: 'th-225-sheet', label: 'TH-1a · Sales · The Orders sheet: Picture, Brand, Invoiced; every value opens its thing', model: sheet('sales'), note: 'Click a number, a customer, Pieces, Promised, Shipped, Invoiced or a quote: a real link (⌘-click: a new tab). Brand and Status narrow the sheet (the funnel). Rest a moment on a number or a customer: the peek card. o opens the focused cell.' },
    { id: 'th-225-wide', label: 'TH-1a · Owner · At 1920 the sheet uses the width: Ordered, Margin %, Priority, Season, From quote', model: sheet('owner', { wide: true, margins: LIST_MARGINS, depth: listDepth('owner') }), note: 'Open it with the Wide 1920 frame: no empty band on the right.' },
    // B-TH-230 (TH-2): New messages — the reader's own; the cell opens the order with its thread at the first new message.
    { id: 'th-230-new-messages', label: 'TH-2 · Sales · New messages: "● 2 new · 10:42" — a door to the order’s thread at the first new one', model: sheet('sales', { unread: { [OPEN_ROWS[0]!.id]: { newCount: 2, lastAt: '2026-11-17T09:42:00.000Z' }, [OPEN_ROWS[2]!.id]: { newCount: 140, lastAt: '2026-11-15T16:05:00.000Z' } } }), note: 'One read for the page (POST /threads/unread, at most 200 rows): a count only on orders you may open; 99+ above 99; empty when nothing is new. The cell is a real link (⌘-click: a new tab) that opens the order with the thread at “New since your last visit”.' },
    { id: 'th-225-manager', label: 'TH-1a · Production manager · Invoiced as a word (no link, the reason on hover), no money columns', model: sheet('manager') },
    { id: 'th-225-selected', label: 'TH-1a · Sales · Three picked: Export 3 goes through the export job (the screen’s columns, those rows)', model: sheet('sales', { selected: OPEN_ROWS.slice(0, 3).map((entry) => entry.id), depth: listDepth('sales') }) },
    { id: 'th-225-viewer', label: 'TH-1a · Sales · The picture large: Open style; an order of 3 styles leads to its lines', model: sheet('sales', { viewerOpen: OPEN_ROWS.find((entry) => entry.styleCount > 1 && entry.picture)?.id ?? null }) },
    { id: 'th-225-filtered', label: 'TH-1a · Sales · Brand and Status narrow the sheet: two chips and Clear all', model: sheet('sales', { rows: 'IN_PRODUCTION', brand: { value: OPEN_ROWS[0]!.partyId, name: OPEN_ROWS[0]!.brands[0]?.name ?? null }, list: { items: rowsFor('sales', OPEN_ROWS.filter((entry) => entry.status === 'IN_PRODUCTION')), more: false, problem: null } }) },
    { id: 'th-225-companies', label: 'TH-1a · Owner · Two companies: the Company column (a funnel) and its chip', model: sheet('owner', { companies: DEMO_COMPANIES.map((entry) => ({ id: entry.id, name: entry.name })), company: { id: DEMO_COMPANIES[0].id, name: DEMO_COMPANIES[0].name } }) },
    { id: 'th-225-more', label: 'TH-1a · Sales · The honest count: 7 of 42 loaded, Show more', model: sheet('sales', { list: { items: rowsFor('sales'), more: true, problem: null }, board: { ...BOARD, byStatus: BOARD.byStatus.map((entry) => (entry.status === 'CONFIRMED' ? { ...entry, count: 38 } : entry)) } }) },
    { id: 'th-225-empty', label: 'TH-1a · No orders yet (where orders come from)', model: sheet('sales', { list: { items: [], more: false, problem: null }, switcher: switcherOf([], { total: 0 }) }) },
    { id: 'th-226-switcher', label: 'TH-1a · Sales · Customer ▾ open: search, All customers, recent first, open and late per customer', model: sheet('sales', { switcherOpen: true }) },
    {
      id: 'th-226-customer',
      label: 'TH-1a · Sales · One customer chosen: the title, the tiles, the rows, the export follow; the chip returns to all',
      model: sheet('sales', { customer: { id: CUSTOMERS[0]!.id, name: CUSTOMERS[0]!.name }, rows: 'all', list: { items: rowsFor('sales', LIST_ROWS.filter((entry) => entry.partyId === CUSTOMERS[0]!.id)), more: false, problem: null } }),
    },
    { id: 'th-226-from-report', label: 'TH-1a · From Sales › Reports: Open the list lands here with that customer and its late orders', model: sheet('sales', { customer: { id: LIST_ROWS[4]!.partyId, name: LIST_ROWS[4]!.partyName }, rows: 'late', list: { items: rowsFor('sales', LIST_ROWS.filter((entry) => entry.partyId === LIST_ROWS[4]!.partyId && (entry.daysLate ?? 0) > 0)), more: false, problem: null } }) },
    { id: 'th-226-limited', label: 'TH-1a · A person limited to some customers: “All my customers (2)”, never the others', model: sheet('sales', { switcher: switcherOf(CUSTOMERS.slice(0, 2), { limited: true }), switcherOpen: true, list: { items: rowsFor('sales', OPEN_ROWS.filter((entry) => CUSTOMERS.slice(0, 2).some((customer) => customer.id === entry.partyId))), more: false, problem: null } }) },
    { id: 'th-226-single', label: 'TH-1a · A person limited to one customer: a fixed label, no menu', model: sheet('sales', { switcher: switcherOf(CUSTOMERS.slice(1, 2), { limited: true }), list: { items: rowsFor('sales', OPEN_ROWS.filter((entry) => entry.partyId === CUSTOMERS[1]!.id)), more: false, problem: null } }) },
    { id: 'th-226-unavailable', label: 'TH-1a · A link to a customer the reader may not open: “not available”, no name, no row (W27)', model: sheet('sales', { customer: { id: '0190f0e2-6666-7000-8000-00000000ffff', name: null }, rows: 'all', list: { items: [], more: false, problem: null } }) },
    { id: 'th-226-reading', label: 'TH-1a · Customer ▾ while the customers are read: — never 0', model: sheet('sales', { switcher: { ...switcherOf(CUSTOMERS), customers: null }, switcherOpen: true }) },
    // ── end B-TH-225 / B-TH-226 ──
    // ── B-TH-243 (threads plan TH-4, picture 25): one Views menu; a customer's own sheet ──
    { id: 'th4-views', label: 'TH-4 · Sales · Views ▾: the built-in views on top (Open, Late, Shipped, not invoiced …), then the saved ones', model: { ...sheet('sales'), tools: tools({ design: { menu: 'columns' } }) }, note: 'One menu of views: the Rows ▾ beside it went. A tile picks the same built-in view.' },
    { id: 'th4-customer-save', label: 'TH-4 · Sales · A customer\'s sheet: Save view as starts from its name ("… — tracking"), share with a role, Pin to Today', model: { ...sheet('sales', { customer: { id: CUSTOMERS[0]!.id, name: CUSTOMERS[0]!.name }, rows: 'all', list: { items: rowsFor('sales', LIST_ROWS.filter((entry) => entry.partyId === CUSTOMERS[0]!.id)), more: false, problem: null } }), tools: tools({ design: { dialog: 'save' } }) } },
    // ── B-TH-241 / B-TH-242 on the sheet: custom columns (a field for one customer shows on its rows only) ──
    { id: 'th4-custom-columns', label: 'TH-4 · Sales · Custom columns shown by a view: Hang tag (every customer) and Customer box (one customer: its rows only)', model: { ...sheet('sales'), tools: tools({ fields: { list: FIELDS, values: FIELD_VALUES }, layout: { columns: { order: ['picture', 'number', 'customer', 'brand', 'status', 'cf:hang_tag', 'cf:alpha_box'], hidden: [], pinned: [] } } }) }, note: 'Customise lists them as "… (custom field)", hidden until a view shows them; Export writes the shown ones.' },
    // ── B-TH-244 (threads plan TH-4, picture 26): the overall view ──
    { id: 'th4-grouped', label: 'TH-4 · Owner · All customers grouped by customer: the server\'s figures per customer (each a door), the grand total pinned', model: grouped('owner'), note: 'Every number opens exactly the rows it counts (⌘-click: a new tab). A customer\'s name opens its sheet. One customer still reading, one folded.' },
    { id: 'th4-grouped-manager', label: 'TH-4 · Production manager · The overall view without amounts (no money anywhere)', model: grouped('manager') },
    { id: 'th4-uninvoiced', label: 'TH-4 · Finance · Shipped, not invoiced — grouped by customer', model: grouped('finance', { rows: 'uninvoiced' }) },
    { id: 'th4-door', label: 'TH-4 · Sales · A total opened: Invoiced in part, at risk — chips with ✕, the count is the total\'s', model: sheet('sales', { extra: { invoiced: 'PART', atRisk: true }, summary: { value: { ...summaryOf('sales'), all: { ...summaryOf('sales').all, orders: { count: 1, filter: { invoiced: 'PART', atRisk: 'true' } } } }, problem: null }, list: { items: rowsFor('sales', LIST_ROWS.filter((entry) => entry.invoiced?.state === 'PART')), more: false, problem: null } }) },
    { id: 'th4-later-columns', label: 'TH-4 · Owner · The later columns shown by a view: Open pcs, Progress, Paid, Balance, Site, Order note, At risk, Customer\'s mark', model: { ...sheet('owner', { list: { items: rowsFor('owner', OPEN_ROWS.map((entry, index) => ({ ...entry, openUnits: entry.units - entry.shippedUnits, progress: index === 0 ? null : { inWork: entry.units, cut: entry.units, sewn: Math.floor(entry.units / 2), finished: null }, paid: index % 2 === 0 ? 120000 : 0, balance: index % 2 === 0 ? 640000 : 761280, sites: [{ id: '0190f0e2-1212-7000-8000-000000000001', code: 'PLT', name: 'Stabilimento Demo' }], internalNote: index === 1 ? 'Call before shipping' : null, atRisk: index === 2 ? { daysLeft: 2, daysBeforePromise: 5 } : null, customerUrgency: index === 3 ? ('URGENT' as const) : null }))), more: false, problem: null } }), tools: tools({ layout: { columns: { order: ['picture', 'number', 'customer', 'status', 'openUnits', 'progress', 'paid', 'balance', 'site', 'note', 'atRisk', 'customerUrgency'], hidden: [], pinned: [] } } }) } },
    { id: 'th4-invoice-drafts', label: 'TH-4 · Finance · Invoice shipped goods for 3: two drafts (one per customer and company), one order waits', model: sheet('finance', { selected: OPEN_ROWS.slice(0, 3).map((entry) => entry.id), invoiceDrafts: { count: 3, problem: null, value: { asOf: TODAY, drafts: [{ partyId: CUSTOMERS[0]!.id, companyId: DEMO_COMPANIES[0].id, code: 'C-1', legalName: CUSTOMERS[0]!.name, month: '2026-11', currency: 'EUR', orders: [{ id: OPEN_ROWS[0]!.id, number: OPEN_ROWS[0]!.number }], ddts: [{ ddtId: '0190f0e2-dd01-7000-8000-000000000001', number: 'DDT-2026-0101' }, { ddtId: '0190f0e2-dd01-7000-8000-000000000002', number: 'DDT-2026-0102' }], garments: '14', valueAmount: 624000, body: { ddtIds: ['0190f0e2-dd01-7000-8000-000000000001', '0190f0e2-dd01-7000-8000-000000000002'] } }, { partyId: CUSTOMERS[1]!.id, companyId: DEMO_COMPANIES[0].id, code: 'C-2', legalName: CUSTOMERS[1]!.name, month: '2026-11', currency: 'EUR', orders: [{ id: OPEN_ROWS[1]!.id, number: OPEN_ROWS[1]!.number }], ddts: [{ ddtId: '0190f0e2-dd01-7000-8000-000000000003', number: 'DDT-2026-0103' }], garments: '6', valueAmount: 270000, body: { ddtIds: ['0190f0e2-dd01-7000-8000-000000000003'] } }], held: [{ orderId: OPEN_ROWS[2]!.id, number: OPEN_ROWS[2]!.number, reason: 'NOTHING_SHIPPED' }] } } }) },
    { id: 'th4-totals-failed', label: 'TH-4 · The figures could not be read: in words with Try again (never 0)', model: base('owner', { rows: 'all', group: 'party', summary: { value: null, problem: 'problem.read.unavailable' }, list: { items: null, more: false, problem: 'problem.read.unavailable' } }) },
    // ── end B-TH-243 / B-TH-244 ──
    // ── B-TH-245 (threads plan TH-4, picture 27): the sheet's cells edit — the order note and the custom values; Edit N ──
    {
      id: 'th4-cells',
      label: 'TH-4 · Sales · Cells that edit: Order note and Hang tag (save mark, version checked); a closed order keeps its cells; Edit 2',
      model: {
        ...sheet('sales', { rows: 'all', list: { items: rowsFor('sales', LIST_ROWS), more: false, problem: null }, selected: OPEN_ROWS.slice(0, 2).map((entry) => entry.id) }),
        tools: tools({
          fields: { list: FIELDS.slice(0, 1), values: FIELD_VALUES },
          layout: { columns: { order: ['picture', 'number', 'customer', 'status', 'note', 'cf:hang_tag'], hidden: [], pinned: [] } },
          bulk: LIST_ROWS.map((entry): BulkRowFacts => ({ id: entry.id, label: entry.number, version: entry.version, values: { note: null, 'cf:hang_tag': FIELD_VALUES[entry.id]?.hang_tag?.value as string | null ?? null }, held: entry.status === 'CLOSED' || entry.status === 'CANCELLED' ? { '*': { code: 'held', status: entry.status } } : {} })),
        }),
      },
      note: 'Double-click a cell or press F2: it saves by itself (↻ then ✓); someone else\'s change meanwhile is refused in words, never overwritten. The pencil cells are the only ones that edit: the rest of the row opens the order.',
    },
    { id: 'th4-cells-manager', label: 'TH-4 · Production manager · Every cell reads only (no right to change orders: said on Edit N)', model: { ...sheet('manager', { selected: OPEN_ROWS.slice(0, 1).map((entry) => entry.id) }), tools: tools({ layout: { columns: { order: ['picture', 'number', 'customer', 'status', 'note'], hidden: [], pinned: [] } } }) } },
    // ── end B-TH-245 ──
  ],
})


import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { BOARD_LANES } from '../api'
import { DEMO_COMPANIES } from '../../../../shell/design-data'
import { at, BOARD, canOf, forRole, inShell, LIST_ROWS, OPEN_ROWS, PARTY, PARTY_ROWS, PREFIX, TODAY, type Role } from '../_demo/fixtures'
import type { Lane } from '../model'
import type { NewOrderDialogModel, OrdersListModel } from './list-model'
import { OrdersListView } from './view/OrdersListView'

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
  ...over,
})

function OrdersDesign({ model }: { model: ListCase }) {
  return inShell('/sales/orders', createElement(OrdersListView, { model: model.list }), model.role)
}

export const designScreen = defineDesignScreen<ListCase>({
  screen: 'SCR-038',
  title: 'Orders (Sales): list and board by state',
  view: OrdersDesign,
  cases: [
    { id: 'open', label: 'Sales: the open orders (the default rows), live', model: base('sales'), note: 'Tick a row: the toolbar swaps to Export N. Press a tile: its saved rows. v switches to the board.' },
    { id: 'owner-all', label: 'Owner: every order (Rows ▾ All orders)', model: base('owner', { rows: 'all', list: { items: rowsFor('owner', LIST_ROWS), more: false, problem: null } }) },
    { id: 'late', label: 'The Late tile pressed (also Home › Today’s “See all”: ?late=true)', model: base('sales', { rows: 'late', list: { items: rowsFor('sales', LIST_ROWS.filter((entry) => (entry.daysLate ?? 0) > 0)), more: false, problem: null } }) },
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
    { id: 'new-order', label: 'W2a · Sales · New order: search the customer (c opens it)', model: base('sales', { newOrder: newOrder() }), note: 'Pick a customer: the contact and the customer PO come next; Create draft order opens its Lines.' },
    { id: 'new-order-picked', label: 'W2a · Sales · New order: the customer picked, the orders contact chosen, the number it will get', model: base('sales', { newOrder: newOrder({ party: PARTY, contactId: PARTY.contacts[0]!.id, customerRef: 'PO-ESEMPIO-89' }) }) },
    { id: 'new-order-blocked', label: 'W2a · Sales · New order: a blocked customer (Create held with the reason)', model: base('sales', { newOrder: newOrder({ party: { ...PARTY, status: 'BLOCKED' } }) }) },
    { id: 'new-order-companies', label: 'W2a · Owner · New order: two selling companies; no number series yet', model: base('owner', { newOrder: newOrder({ companies: DEMO_COMPANIES, number: null }) }) },
    { id: 'new-order-searching', label: 'W2a · Sales · New order: searching customers', model: base('sales', { newOrder: newOrder({ results: null, number: undefined }) }) },
    { id: 'new-order-held', label: 'W2a · Finance · New order held: taking orders is the sales right', model: base('finance') },
    { id: 'board-live', label: 'W2a · Owner · Board by state (follows live; Board in a new tab); a ready order offers Create shipment', model: board('owner'), note: 'Board in a new tab opens ?view=board: left open on a second screen it reads its lanes again on every change.' },
  ],
})

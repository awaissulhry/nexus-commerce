import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { at, canOf, inShell, PREFIX, SITE, SITE_SOUTH, SUPPLIER_LIST, SUPPLIERS, TIME_ZONE, type Role } from '../../../_shared/buying/fixtures'
import { ORDER_ROWS, ORDER_SUMMARY } from '../demo/fixtures'
import { NO_NEW_ORDER, type OrdersListModel } from '../model'
import { OrdersListView } from './view/OrdersListView'

/**
 * SCR-058 — Purchase orders (design purchasing.orders) with made-up orders only: the tiles "Where POs stand", the list
 * (drafts, sent and waiting, not confirmed after 48 h, changes proposed, confirmed by link, partly received, received,
 * declined), each saved view, a search, the selection with Export, New purchase order (an active supplier, a prospect,
 * a blocked one), and the states. Roles: Owner, Buyer, Planner and Warehouse (no money: no value column), Read-only,
 * Sales (none).
 */

export interface OrdersCase {
  role: Role
  model: OrdersListModel
}

const NOW = at(29, 11)

function listCase(role: Role, over: Partial<OrdersListModel> = {}): OrdersCase {
  const can = canOf(role)
  const rows = can.cost ? ORDER_ROWS : ORDER_ROWS.map(({ netAmount: _net, ...row }) => row)
  return {
    role,
    model: { prefix: PREFIX, can, view: 'all', q: '', rows: { items: rows, more: false, problem: null }, summary: ORDER_SUMMARY, sites: [SITE], asOf: NOW, live: 'live', updates: 0, notice: null, newOrder: null, timeZone: TIME_ZONE, now: NOW, ...over },
  }
}

const only = (...statuses: string[]) => ORDER_ROWS.filter((row) => statuses.includes(row.status))

function OrdersDesign({ model }: { model: OrdersCase }) {
  return inShell('/purchasing/orders', createElement(OrdersListView, { model: model.model }), model.role)
}

export const designScreen = defineDesignScreen<OrdersCase>({
  screen: 'SCR-058',
  title: 'Purchase orders',
  view: OrdersDesign,
  cases: [
    { id: 'list', label: 'Every order: the supplier’s answer in words, need and confirmed dates, the value (buyer)', model: listCase('buyer'), note: 'A sent order waits for the supplier’s link; a proposal links to its review.' },
    { id: 'tile-drafts', label: 'Tile: drafts to send', model: listCase('buyer', { view: 'drafts', rows: { items: only('DRAFT'), more: false, problem: null } }) },
    { id: 'tile-late', label: 'Tile: not confirmed after 48 h', model: listCase('buyer', { view: 'late', rows: { items: ORDER_ROWS.filter((row) => row.number === 'PO-2026-0006'), more: false, problem: null } }) },
    { id: 'tile-proposed', label: 'Tile: changes proposed (Today links here)', model: listCase('buyer', { view: 'proposed', rows: { items: only('CHANGES_PROPOSED'), more: false, problem: null } }) },
    { id: 'search', label: 'Search by number', model: listCase('buyer', { q: '0003', rows: { items: ORDER_ROWS.filter((row) => row.number.includes('0003')), more: false, problem: null } }) },
    { id: 'no-match', label: 'Nothing matches the filters', model: listCase('buyer', { q: 'zzz', rows: { items: [], more: false, problem: null } }) },
    { id: 'selection', label: 'Selection: Export N (CSV)', model: listCase('buyer', { selected: ORDER_ROWS.slice(0, 3).map((row) => row.id) }) },
    { id: 'more', label: 'More than a page: Show more in the footer', model: listCase('buyer', { rows: { items: ORDER_ROWS, more: true, problem: null } }) },
    { id: 'live', label: 'Live: 2 updates waiting', model: listCase('buyer', { updates: 2 }) },
    { id: 'keyboard', label: 'Keyboard: j / k on the rows', model: listCase('buyer', { focusRow: 2 }) },
    { id: 'new', label: 'New purchase order: suppliers, the delivery site, a requested date', model: listCase('buyer', { newOrder: { ...NO_NEW_ORDER, suppliers: SUPPLIER_LIST, supplier: SUPPLIERS.tannery, siteId: SITE.id, requestedDate: '2026-11-18' } }) },
    { id: 'new-two-sites', label: 'New purchase order: two sites, none picked yet (held)', model: listCase('buyer', { sites: [SITE, SITE_SOUTH], newOrder: { ...NO_NEW_ORDER, suppliers: SUPPLIER_LIST, supplier: SUPPLIERS.fabric } }) },
    { id: 'new-prospect', label: 'New purchase order: a prospect (drafted, sent once approved)', model: listCase('buyer', { newOrder: { ...NO_NEW_ORDER, query: 'couros', suppliers: [SUPPLIERS.prospect], supplier: SUPPLIERS.prospect, siteId: SITE.id } }) },
    { id: 'new-blocked', label: 'New purchase order: a blocked supplier (held with the reason)', model: listCase('buyer', { newOrder: { ...NO_NEW_ORDER, query: 'blocc', suppliers: [SUPPLIERS.blocked], supplier: SUPPLIERS.blocked, siteId: SITE.id } }) },
    { id: 'new-loading', label: 'New purchase order: suppliers loading', model: listCase('buyer', { newOrder: { ...NO_NEW_ORDER } }) },
    { id: 'shortcuts', label: 'Keyboard shortcuts (?)', model: listCase('buyer', { helpOpen: true }) },
    { id: 'empty', label: 'First day: no purchase order yet', model: listCase('buyer', { rows: { items: [], more: false, problem: null }, summary: { drafts: 0, waiting: 0, notConfirmedAfter48h: 0, changesProposed: 0, declined: 0 } }) },
    { id: 'loading', label: 'Loading', model: listCase('buyer', { rows: { items: null, more: false, problem: null }, summary: null, asOf: null, live: 'connecting' }) },
    { id: 'error', label: "The list couldn't be read", model: listCase('buyer', { rows: { items: null, more: false, problem: 'problem.offline' }, summary: null, asOf: null, live: 'offline' }) },
    { id: 'owner', label: 'Owner: everything', model: listCase('owner') },
    { id: 'planner', label: 'Planner: reads, no money (no value column), New held', model: listCase('planner') },
    { id: 'warehouse', label: 'Warehouse: reads the orders it receives against, no money', model: listCase('warehouse') },
    { id: 'read-only', label: 'Read-only: reads, nothing written', model: listCase('readOnly') },
    { id: 'sales', label: 'Sales: no purchasing.view — the page says so', model: listCase('sales') },
  ],
})

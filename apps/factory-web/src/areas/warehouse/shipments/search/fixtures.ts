import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { at, canOf, inShell, OPEN_ROWS, PREFIX, SITE, TODAY, type Role } from '../_demo/fixtures'
import type { ShipmentsListModel } from '../list/list-model'
import { ShipmentsListView } from '../list/view/ShipmentsListView'
import { tileCounts, type RowView } from '../model'
import type { SearchPage, SearchRow } from '../queue/api'
import type { QueueDepthModel } from '../queue/model'

/**
 * SCR-591 — Shipments › the search (B-W2b-410 on B-W2b-386, LOG-120; design sh-grid "search by order, tracking number, SSCC,
 * customer PO or serial"): every status, what each row was found by (the serials it matched), an SSCC said not kept yet, the
 * history export (Export ▾, list `warehouse.shipments.2`). Drawn inside the W1 list (SCR-066). Made-up data only.
 */

const uid = (n: number) => `0190f0e2-7418-7000-8000-${String(n).padStart(12, '0')}`

const srow = (n: number, over: Partial<SearchRow> = {}): SearchRow => ({
  id: uid(100 + n),
  number: `SH-26-00${String(70 + n)}`,
  status: 'DELIVERED',
  siteCode: 'A1',
  salesOrderId: uid(200 + n),
  salesOrderNumber: 'SO-26-0044',
  customerRef: 'PO-DEMO-44',
  partyName: 'Moto Demo S.r.l.',
  transportBy: 'CARRIER',
  carrierCode: 'demo-express',
  carrierName: 'Demo Express',
  serviceCode: 'standard',
  trackingNumbers: [`DEMO000${String(12340 + n)}`],
  parcels: 2,
  garments: 6,
  ddtNumber: `14${n}/2026`,
  splitFrom: null,
  holdReasons: [],
  createdAt: at(20, 9),
  shippedAt: at(21, 15),
  deliveredAt: at(22, 11),
  cancelledAt: null,
  matchedBy: ['ORDER'],
  matchedSerials: [],
  ...over,
})

const page = (over: Partial<SearchPage> = {}): SearchPage => ({
  term: 'SO-26-0044',
  notKept: [],
  shipments: [srow(1, { matchedBy: ['ORDER', 'CUSTOMER_PO'] }), srow(2, { status: 'SHIPPED', deliveredAt: null, matchedBy: ['ORDER'] }), srow(3, { status: 'PACKED', shippedAt: null, deliveredAt: null, trackingNumbers: [], holdReasons: ['CUSTOMER_REQUEST'], matchedBy: ['ORDER'] })],
  nextCursor: null,
  ...over,
})

const depth = (search: QueueDepthModel['search'], over: Partial<QueueDepthModel> = {}): QueueDepthModel => ({
  grid: 'search',
  sites: null,
  siteId: SITE,
  today: { state: 'loading' },
  atRisk: { state: 'loading' },
  exceptions: { state: 'ready', value: { problems: [], truncated: false } },
  search,
  searchMore: search?.state === 'ready' && search.value.nextCursor !== null,
  carrier: null,
  hold: null,
  mayHold: true,
  mayManage: true,
  viewOrders: true,
  prefix: PREFIX,
  ...over,
})

interface SearchCase {
  readonly role: Role
  readonly list: ShipmentsListModel
}

const view = (role: Role, q: string, search: QueueDepthModel['search'], rows: RowView = 'today', over: Partial<QueueDepthModel> = {}): SearchCase => ({
  role,
  list: {
    prefix: PREFIX,
    can: canOf(role),
    today: TODAY,
    rows,
    q,
    carrier: null,
    list: { items: OPEN_ROWS, more: false, problem: null },
    cards: null,
    tiles: tileCounts(OPEN_ROWS, false, 2),
    asOf: at(29, 9, 42),
    live: 'live',
    updates: 0,
    notice: null,
    create: null,
    depth: depth(search, over),
  },
})

function SearchDesign({ model }: { model: SearchCase }) {
  return inShell('/warehouse/shipments', createElement(ShipmentsListView, { model: model.list }), model.role)
}

export const designScreen = defineDesignScreen<SearchCase>({
  screen: 'SCR-591',
  title: 'Shipments › search by order, tracking number, SSCC, customer PO or serial (any status), the history export',
  view: SearchDesign,
  cases: [
    { id: 'order', label: 'By order: three shipments of every status, found by order and customer PO', model: view('warehouse', 'SO-26-0044', { state: 'ready', value: page() }) },
    { id: 'serial', label: 'By serial: the shipment and the serial it matched', model: view('warehouse', 'DM26-4103', { state: 'ready', value: page({ term: 'DM26-4103', shipments: [srow(4, { matchedBy: ['SERIAL'], matchedSerials: ['DM26-4103'] })] }) }) },
    { id: 'carton', label: 'By a carton label (shipment and carton)', model: view('warehouse', 'SH-26-0074-2', { state: 'ready', value: page({ term: 'SH-26-0074-2', shipments: [srow(4, { matchedBy: ['CARTON'] })] }) }) },
    { id: 'sscc', label: 'An SSCC: not kept yet, said so', model: view('warehouse', '003456789012345678', { state: 'ready', value: page({ term: '003456789012345678', notKept: ['SSCC'], shipments: [] }) }) },
    { id: 'more', label: 'More pages: Show more', model: view('warehouse', 'Moto Demo', { state: 'ready', value: page({ term: 'Moto Demo', nextCursor: uid(9), shipments: page().shipments.map((row) => ({ ...row, matchedBy: ['CUSTOMER' as const] })) }) }) },
    { id: 'status', label: 'Narrowed by a state view (Shipped)', model: view('warehouse', 'SO-26-0044', { state: 'ready', value: page({ shipments: [srow(2, { status: 'SHIPPED', deliveredAt: null })] }) }, 'SHIPPED') },
    { id: 'selected', label: 'Two rows selected: Hold (one left out: not open)', model: view('warehouse', 'SO-26-0044', { state: 'ready', value: page() }, 'today', { selected: [uid(101), uid(103)] }) },
    { id: 'none', label: 'Nothing found', model: view('warehouse', 'XYZ-404', { state: 'ready', value: page({ term: 'XYZ-404', shipments: [] }) }) },
    { id: 'loading', label: 'Searching', model: view('warehouse', 'SO-26-0044', { state: 'loading' }) },
    { id: 'error', label: 'The search failed: Try again', model: view('warehouse', 'SO-26-0044', { state: 'error', problem: { key: 'problem.read.unavailable' } }) },
  ],
})

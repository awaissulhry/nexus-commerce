import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { at, canOf, inShell, OPEN_ROWS, PREFIX, SITE, TODAY, type Role } from '../_demo/fixtures'
import type { BulkHoldModel } from '../holds/model'
import type { ShipmentsListModel } from '../list/list-model'
import { ShipmentsListView } from '../list/view/ShipmentsListView'
import { tileCounts, zonedInstant, zonedToday, type RowView } from '../model'
import type { AtRisk, ProblemList, QueueRow, ShipToday, SiteDay } from './api'
import type { QueueDepthModel } from './model'

/**
 * SCR-590 — Shipments in depth (B-W2b-410 on B-W2b-386 and B-W2b-398; design sh-cutoff, sh-grid "Rows ▾: Ship today
 * (default) · At risk of missing the promise · Open · Shipped · All", sh-metrics "Exceptions", the selection row "Hold"):
 * the site's carrier cut-offs from the queue, Ship today worst first, At risk with the orders not planned, Exceptions, Hold N.
 * Drawn inside the W1 list (SCR-066) as the Office shows it. Made-up data only (customers "Moto Demo", "Esempio Racing").
 */

const uid = (n: number) => `0190f0e2-7417-7000-8000-${String(n).padStart(12, '0')}`
// A cut-off late today on the site's clock (the same instant on the server and in the browser: no hydration drift).
const lateToday = (time: string) => zonedInstant(zonedToday(), time) ?? at(29, 22)

const site = (over: Partial<SiteDay> = {}): SiteDay => ({ siteId: SITE, code: 'A1', name: 'Stabilimento Demo', timeZone: 'Europe/Rome', today: TODAY, open: true, closed: null, nextWorkingDay: null, ...over })

const qrow = (n: number, over: Partial<QueueRow> = {}): QueueRow => ({
  id: uid(100 + n),
  number: `SH-26-01${String(n).padStart(2, '0')}`,
  status: 'PACKED',
  siteId: SITE,
  salesOrderId: uid(200 + n),
  salesOrderNumber: `SO-26-00${String(40 + n)}`,
  customerRef: n % 2 === 0 ? `PO-DEMO-${n}` : null,
  partyCode: n % 2 === 0 ? 'C-MOTO' : 'C-ESEM',
  partyName: n % 2 === 0 ? 'Moto Demo S.r.l.' : 'Esempio Racing S.p.A.',
  carrierKey: 'demo-express',
  transportBy: 'CARRIER',
  carrierCode: 'demo-express',
  carrierName: 'Demo Express',
  serviceCode: 'standard',
  shipTo: { city: n % 2 === 0 ? 'Milano' : 'Bologna', country: 'IT' },
  splitFromId: null,
  garments: 6,
  parcels: 2,
  labelled: 0,
  shipBy: TODAY,
  cutOff: { time: '17:30', at: lateToday('23:30'), source: 'CARRIER', minutesLeft: 75, passed: false },
  risk: 'AT_RISK',
  willMiss: false,
  held: false,
  holdReasons: [],
  ...over,
})

const ROWS: QueueRow[] = [
  qrow(1, { risk: 'LATE', shipBy: '2026-10-27', willMiss: true }),
  qrow(2, { risk: 'HELD', held: true, holdReasons: ['BALANCE_UNPAID'], willMiss: true }),
  qrow(3, { status: 'DRAFT', risk: 'AT_RISK', parcels: 0 }),
  qrow(4, { risk: 'DUE_TODAY', labelled: 2 }),
  qrow(5, { carrierKey: 'SENDER', transportBy: 'SENDER', carrierCode: null, carrierName: null, serviceCode: null, cutOff: { time: '18:00', at: lateToday('23:45'), source: 'SITE', minutesLeft: 105, passed: false }, risk: 'DUE_TODAY', splitFromId: uid(300) }),
  qrow(6, { carrierKey: 'RECIPIENT', transportBy: 'RECIPIENT', carrierCode: null, carrierName: null, serviceCode: null, cutOff: null, risk: 'DUE_TODAY', status: 'DRAFT' }),
]

const today = (over: Partial<ShipToday> = {}): ShipToday => ({
  site: site(),
  now: at(29, 9, 42),
  carriers: [
    { key: 'demo-express', transportBy: 'CARRIER', carrierCode: 'demo-express', carrierName: 'Demo Express', cutOff: { time: '17:30', at: lateToday('23:30'), source: 'CARRIER', minutesLeft: 75, passed: false }, shipments: 4, packed: 3, toPack: 1, labelled: 1, held: 1, willMiss: 2, parcels: 6, garments: 24 },
    { key: 'SENDER', transportBy: 'SENDER', carrierCode: null, carrierName: null, cutOff: { time: '18:00', at: lateToday('23:45'), source: 'SITE', minutesLeft: 105, passed: false }, shipments: 1, packed: 1, toPack: 0, labelled: 0, held: 0, willMiss: 0, parcels: 2, garments: 6 },
    { key: 'RECIPIENT', transportBy: 'RECIPIENT', carrierCode: null, carrierName: null, cutOff: null, shipments: 1, packed: 0, toPack: 1, labelled: 0, held: 0, willMiss: 0, parcels: 0, garments: 6 },
  ],
  tiles: { dueToday: 6, toPack: 2, packed: 4, held: 1, atRisk: 1, willMiss: 2, late: 1, notDue: 3 },
  shipments: ROWS,
  truncated: false,
  ...over,
})

const atRisk = (over: Partial<AtRisk> = {}): AtRisk => ({
  now: at(29, 9, 42),
  sites: [site(), site({ siteId: uid(2), code: 'B2', name: 'Magazzino Demo' })],
  tiles: { late: 1, held: 1, missedCutOff: 0, atRisk: 1, notPlanned: 2 },
  shipments: ROWS.slice(0, 3),
  notPlanned: [
    { salesOrderId: uid(401), number: 'SO-26-0051', customerRef: 'PO-DEMO-77', partyCode: 'C-MOTO', partyName: 'Moto Demo S.r.l.', siteId: SITE, shipBy: TODAY, cutOff: { time: '17:30', at: lateToday('23:30'), source: 'CARRIER', minutesLeft: 75, passed: false }, risk: 'AT_RISK', garments: 12 },
    { salesOrderId: uid(402), number: 'SO-26-0049', customerRef: null, partyCode: 'C-ESEM', partyName: 'Esempio Racing S.p.A.', siteId: SITE, shipBy: '2026-10-28', cutOff: null, risk: 'LATE', garments: 4 },
  ],
  ...over,
})

const exceptions: ProblemList = {
  problems: [
    { id: uid(501), kind: 'NO_SCAN', raisedAt: at(29, 7, 10), resolvedAt: null, shipment: { id: uid(601), number: 'SH-26-0091', status: 'SHIPPED', siteId: SITE, carrierName: 'Demo Express', expectedDeliveryAt: at(28, 16) } },
    { id: uid(502), kind: 'ADDRESS_PROBLEM', raisedAt: at(28, 15, 20), resolvedAt: null, shipment: { id: uid(602), number: 'SH-26-0088', status: 'SHIPPED', siteId: SITE, carrierName: 'Demo Express', expectedDeliveryAt: null } },
  ],
  truncated: false,
}

const depth = (over: Partial<QueueDepthModel> = {}): QueueDepthModel => ({
  grid: 'today',
  sites: atRisk().sites,
  siteId: SITE,
  today: { state: 'ready', value: today() },
  atRisk: { state: 'ready', value: atRisk() },
  exceptions: { state: 'ready', value: exceptions },
  search: null,
  searchMore: false,
  carrier: null,
  hold: null,
  mayHold: true,
  mayManage: true,
  viewOrders: true,
  prefix: PREFIX,
  ...over,
})

interface QueueCase {
  readonly role: Role
  readonly list: ShipmentsListModel
}

const page = (role: Role, rows: RowView, over: Partial<QueueDepthModel> = {}, list: Partial<ShipmentsListModel> = {}): QueueCase => ({
  role,
  list: {
    prefix: PREFIX,
    can: canOf(role),
    today: TODAY,
    rows,
    q: '',
    carrier: over.carrier ?? null,
    list: { items: OPEN_ROWS, more: false, problem: null },
    cards: null,
    tiles: tileCounts(OPEN_ROWS, false, 2),
    asOf: at(29, 9, 42),
    live: 'live',
    updates: 0,
    notice: null,
    create: null,
    depth: depth({ grid: rows === 'today' || rows === 'atRisk' || rows === 'exceptions' ? rows : null, ...over }),
    ...list,
  },
})

const hold = (over: Partial<BulkHoldModel> = {}): BulkHoldModel => ({ picked: ROWS.slice(2, 4).map((row) => ({ id: row.id, number: row.number, status: row.status })), reason: 'CUSTOMER_REQUEST', text: '', busy: false, problem: null, outcome: null, ...over })

function QueueDesign({ model }: { model: QueueCase }) {
  return inShell('/warehouse/shipments', createElement(ShipmentsListView, { model: model.list }), model.role)
}

export const designScreen = defineDesignScreen<QueueCase>({
  screen: 'SCR-590',
  title: 'Shipments in depth: Ship today and At risk from the queue, Exceptions, Hold N',
  view: QueueDesign,
  cases: [
    { id: 'today', label: 'Ship today (default): the carriers\' cut-offs on the site\'s clock, worst first (late, held, at risk, due today)', model: page('warehouse', 'today'), note: 'Press a carrier card: Ship today shows that carrier. Tick rows: Export N, Hold N.' },
    { id: 'carrier', label: 'A carrier card pressed: Demo Express only', model: page('warehouse', 'today', { carrier: 'demo-express' }) },
    { id: 'closed', label: 'The site does not work today: what is due today misses its cut-off', model: page('warehouse', 'today', { today: { state: 'ready', value: today({ site: site({ open: false, closed: { reason: 'HOLIDAY', name: 'Ognissanti' }, nextWorkingDay: '2026-11-02' }), shipments: ROWS.map((row) => ({ ...row, risk: 'MISSED_CUT_OFF', willMiss: true })) }) } }) },
    { id: 'nothing', label: 'Nothing to ship today', model: page('warehouse', 'today', { today: { state: 'ready', value: today({ carriers: [], shipments: [], tiles: { dueToday: 0, toPack: 0, packed: 0, held: 0, atRisk: 0, willMiss: 0, late: 0, notDue: 3 } }) } }) },
    { id: 'at-risk', label: 'At risk of missing the promise: every site; the orders due and not on a shipment yet', model: page('warehouse', 'atRisk') },
    { id: 'at-risk-none', label: 'At risk: nothing at risk', model: page('warehouse', 'atRisk', { atRisk: { state: 'ready', value: atRisk({ shipments: [], notPlanned: [] }) } }) },
    { id: 'exceptions', label: 'Exceptions: the open tracking problems (the tile pressed)', model: page('warehouse', 'exceptions') },
    { id: 'exceptions-none', label: 'Exceptions: none open', model: page('warehouse', 'exceptions', { exceptions: { state: 'ready', value: { problems: [], truncated: false } } }) },
    { id: 'selected', label: 'Two rows selected: Export 2, Hold 2', model: page('warehouse', 'today', { selected: ROWS.slice(2, 4).map((row) => row.id) }) },
    { id: 'hold', label: 'Hold 2: the reason, one command', model: page('warehouse', 'today', { hold: hold() }) },
    { id: 'hold-no-right', label: 'Sales (read-only): Hold held with why, no plan button', model: page('sales', 'today', { mayHold: false, mayManage: false, viewOrders: true, selected: [ROWS[0]!.id] }) },
    { id: 'open', label: 'Open (not left yet): W1\'s list of DRAFT and PACKED, the queue\'s cards above', model: page('warehouse', 'open') },
    { id: 'loading', label: 'Loading', model: page('warehouse', 'today', { today: { state: 'loading' }, atRisk: { state: 'loading' }, exceptions: { state: 'loading' }, sites: null }) },
    { id: 'error', label: 'The queue could not be read: Try again (never drawn as empty)', model: page('warehouse', 'today', { today: { state: 'error', problem: { key: 'problem.read.unavailable' } } }) },
  ],
})

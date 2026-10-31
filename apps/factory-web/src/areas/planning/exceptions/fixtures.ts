import { createElement, type ReactNode } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { permissionCheck } from '../../../lib/session/session'
import { officeNavFor } from '../../../shell/nav/office-nav'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, rolePermissions } from '../../../shell/design-data'
import { OfficeShellView, type OfficeShellViewModel } from '../../../shell/office/view/OfficeShellView'
import { SITES } from '../board/fixtures'
import type { ExceptionList, PlanningException } from './api'
import { exceptionsCan } from './model'
import type { ExceptionsModel } from './view-model'
import { ExceptionsView } from './view/ExceptionsView'

/**
 * SCR-125 Exceptions with made-up data: an invented site, materials ("DEMO-LEA-01 Nappa"), orders ("SO-DEMO-1043"),
 * purchase orders, work orders, a line and office people ("Anna Demo"). Nothing here is a real company, supplier,
 * person or number. Drawn inside the Office shell with the role's navigation; the role decides what is held.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const at = (day: number, hour: number, minute = 0, month = 11) => new Date(Date.UTC(2026, month - 1, day, hour, minute)).toISOString()
export const NOW = Date.parse(at(16, 9, 12))
const SITE = SITES[0]!
const RUN = { id: uid('5501', 14), finishedAt: at(16, 6, 2) }
const ME = { id: uid('3333', 1), name: 'Anna Demo' }
const OTHER = { id: uid('3333', 2), name: 'Marco Esempio' }
const LEATHER = { id: uid('7171', 1), code: 'DEMO-LEA-01', name: 'Nappa bovina 1,2 mm' }
const LINING = { id: uid('7171', 2), code: 'DEMO-FOD-02', name: 'Fodera rete traspirante' }
const PROTECTOR = { id: uid('7171', 3), code: 'DEMO-PRT-03', name: 'Protezione spalla livello 2' }
const BLACK = { id: uid('7272', 1), code: 'BLK', name: 'Nero' }

const row = (n: number, over: Partial<PlanningException>): PlanningException => ({
  id: uid('8801', n),
  siteId: SITE.id,
  kind: 'SHORT',
  occurrence: 1,
  status: 'NEW',
  item: LEATHER,
  colour: BLACK,
  record: null,
  requirementId: uid('5502', n),
  facts: {},
  ordersAffected: 1,
  daysLate: null,
  firstRunId: RUN.id,
  lastRunId: RUN.id,
  firstSeenAt: at(14, 6, 2),
  lastSeenAt: RUN.finishedAt,
  ageDays: 2,
  owner: null,
  mine: false,
  acknowledgedAt: null,
  acknowledgedBy: null,
  snoozed: false,
  snoozedAt: null,
  snoozedUntil: null,
  resolvedAt: null,
  resolution: null,
  resolvedBy: null,
  resolveNote: null,
  version: 1,
  ...over,
})

export const ROWS: PlanningException[] = [
  row(1, {
    record: { type: 'WorkOrder', id: uid('9999', 221), label: 'WO-DEMO-0221' },
    facts: { action: 'BUY', quantity: '200.0000', uom: 'FT2', needDate: '2026-11-14', orderNumber: 'SO-DEMO-1043', workOrderNumber: 'WO-DEMO-0221', earliestArrival: '2026-11-20' },
    daysLate: 6,
  }),
  row(2, {
    kind: 'SUPPLY_LATE',
    item: LINING,
    colour: null,
    record: { type: 'PurchaseOrder', id: uid('5801', 91), label: 'PO-DEMO-0091' },
    facts: { purchaseOrderNumber: 'PO-DEMO-0091', supplyDate: '2026-11-20', needDate: '2026-11-12', quantity: '40.0000', uom: 'M', overdue: false },
    ordersAffected: 2,
    daysLate: 8,
    status: 'ACKNOWLEDGED',
    owner: ME,
    mine: true,
    acknowledgedAt: at(15, 8, 30),
    acknowledgedBy: ME,
    version: 2,
  }),
  row(3, {
    kind: 'LANE_OVERLOADED',
    item: null,
    colour: null,
    requirementId: null,
    record: { type: 'Line', id: uid('4444', 2), label: 'L2' },
    facts: { laneKind: 'LINE', laneCode: 'L2', bucket: '2026-W48', from: '2026-11-23', to: '2026-11-29', loadPct: '112.4', availableMinutes: '15300.0', bookedMinutes: '17200.0' },
    ordersAffected: 0,
    occurrence: 2,
    ageDays: 0,
    firstSeenAt: RUN.finishedAt,
  }),
  row(4, {
    kind: 'PAST_DUE',
    item: null,
    colour: null,
    requirementId: null,
    record: { type: 'SalesOrderLine', id: uid('5152', 3), label: 'SO-DEMO-1038 line 20' },
    facts: { orderNumber: 'SO-DEMO-1038', lineSeq: 20, dueDate: '2026-11-13' },
    daysLate: 3,
    owner: OTHER,
    status: 'ACKNOWLEDGED',
    acknowledgedAt: at(14, 10, 5),
    acknowledgedBy: OTHER,
    version: 2,
  }),
  row(5, {
    kind: 'EXCESS',
    item: PROTECTOR,
    colour: null,
    record: { type: 'PurchaseOrder', id: uid('5801', 93), label: 'PO-DEMO-0093' },
    facts: { purchaseOrderNumber: 'PO-DEMO-0093', supplyDate: '2026-11-25', quantity: '24.0000', uom: 'PCS', needed: '12.0000' },
    ordersAffected: 0,
    ageDays: 5,
    firstSeenAt: at(11, 6, 2),
  }),
  row(6, {
    kind: 'BELOW_SAFETY_STOCK',
    item: PROTECTOR,
    colour: null,
    facts: { safetyStock: '40.0000', projected: '22.0000', uom: 'PCS', date: '2026-11-27' },
    ordersAffected: 0,
  }),
  row(7, {
    kind: 'MOVE_EARLIER',
    facts: { firm: true, supplyDate: '2026-12-02', needDate: '2026-11-26', quantity: '120.0000', uom: 'FT2' },
    ordersAffected: 1,
    daysLate: 6,
    snoozed: true,
    snoozedAt: at(16, 8, 0),
    snoozedUntil: at(16, 15, 0),
    owner: ME,
    mine: true,
    status: 'ACKNOWLEDGED',
    acknowledgedAt: at(16, 8, 0),
    acknowledgedBy: ME,
    version: 3,
  }),
  row(8, {
    kind: 'NEGATIVE_STOCK',
    facts: { quantity: '12.5000', uom: 'FT2' },
    ordersAffected: 0,
  }),
]

const RESOLVED: PlanningException[] = [
  row(11, { kind: 'CANCEL', item: LINING, colour: null, record: { type: 'PurchaseOrder', id: uid('5801', 88), label: 'PO-DEMO-0088' }, facts: { purchaseOrderNumber: 'PO-DEMO-0088', supplyDate: '2026-11-18', quantity: '30.0000', uom: 'M', needed: '0.0000' }, ordersAffected: 0, status: 'RESOLVED', resolution: 'HANDLED', resolvedAt: at(15, 16, 40), resolvedBy: ME, resolveNote: 'Line cancelled with the supplier by phone; PO changed to revision 2.', owner: ME, mine: true, version: 3 }),
  row(12, { kind: 'SHORT', facts: { action: 'BUY', quantity: '52.0000', uom: 'FT2', needDate: '2026-11-30', orderNumber: 'SO-DEMO-1040' }, status: 'RESOLVED', resolution: 'CLEARED', resolvedAt: RUN.finishedAt, version: 2 }),
]

const TILES = { open: 8, new: 4, mine: 2, snoozedUntilToday: 1 }
const LIST: ExceptionList = { siteId: SITE.id, tiles: TILES, latestRun: RUN, exceptions: ROWS, nextCursor: null }
const queue = ROWS.filter((entry) => !entry.snoozed)

export interface ExceptionsCase {
  model: ExceptionsModel
  permissions: readonly string[]
}

function inShell(page: ReactNode, permissions: readonly string[]): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck(permissions)),
    path: '/planning/exceptions',
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path: '/planning/exceptions' },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

function ExceptionsDesign({ model }: { model: ExceptionsCase }) {
  return inShell(createElement(ExceptionsView, { model: model.model }), model.permissions)
}

const PLANNER = rolePermissions('planner')

function make(over: Partial<ExceptionsModel> = {}, permissions: readonly string[] = PLANNER): ExceptionsCase {
  const controls = { site: SITE.id, view: 'queue' as const, kind: null, q: '', open: null, ...(over.controls ?? {}) }
  return {
    permissions,
    model: {
      prefix: '/w/DEMO',
      can: exceptionsCan(permissions),
      sites: { status: 'ready', value: [SITE] },
      siteId: SITE.id,
      list: { status: 'ready', value: LIST },
      rows: queue,
      more: false,
      loadingMore: false,
      endOfToday: at(16, 23, 0),
      live: 'live',
      updates: 0,
      running: false,
      busy: [],
      notice: null,
      detail: null,
      dialog: null,
      now: NOW,
      timeZone: 'Europe/Rome',
      ...over,
      controls,
    },
  }
}

const open = (n: number, list: readonly PlanningException[] = ROWS) => ({ id: uid('8801', n), loaded: { status: 'ready' as const, value: list.find((entry) => entry.id === uid('8801', n))! } })

export const designScreen = defineDesignScreen<ExceptionsCase>({
  screen: 'SCR-125',
  title: 'Exceptions',
  view: ExceptionsDesign,
  cases: [
    { id: 'queue', label: 'The queue to clear (planner)', model: make(), note: 'What the last run could not solve, newest sighting first; a snoozed one waits out of the queue. Enter opens, A acknowledges, S snoozes, R resolves.' },
    { id: 'tile-new', label: 'Tile New pressed', model: make({ controls: { site: SITE.id, view: 'new', kind: null, q: '', open: null }, rows: ROWS.filter((entry) => entry.status === 'NEW') }) },
    { id: 'tile-mine', label: 'Tile Mine pressed (my own)', model: make({ controls: { site: SITE.id, view: 'mine', kind: null, q: '', open: null }, rows: ROWS.filter((entry) => entry.mine) }) },
    { id: 'tile-snoozed', label: 'Tile Snoozed until today pressed', model: make({ controls: { site: SITE.id, view: 'snoozedToday', kind: null, q: '', open: null }, rows: ROWS.filter((entry) => entry.snoozed) }) },
    { id: 'resolved', label: 'Rows ▾ Resolved: by a person with a note, or cleared by a run', model: make({ controls: { site: SITE.id, view: 'resolved', kind: null, q: '', open: null }, rows: RESOLVED }) },
    { id: 'kind', label: 'Type filter: Supply too late', model: make({ controls: { site: SITE.id, view: 'queue', kind: 'SUPPLY_LATE', q: '', open: null }, rows: ROWS.filter((entry) => entry.kind === 'SUPPLY_LATE') }) },
    { id: 'search-empty', label: 'A search that matches nothing', model: make({ controls: { site: SITE.id, view: 'queue', kind: null, q: 'zzz', open: null } }) },
    { id: 'selection', label: 'Selection: Acknowledge 2 (the new ones of 3 ticked), Export 3', model: make({ selected: [uid('8801', 1), uid('8801', 2), uid('8801', 3)] }) },
    { id: 'detail', label: 'Detail: SO-DEMO-1043 will be 6 days late, with its fixes', model: make({ detail: open(1), controls: { site: SITE.id, view: 'queue', kind: null, q: '', open: uid('8801', 1) } }), note: 'Fixes are real links: the line in What to buy & make, the board at the work order, the work order. ⌘-click keeps the queue open.' },
    { id: 'detail-supply', label: 'Detail: a purchase order arrives too late (acknowledged, mine): Chase it', model: make({ detail: open(2), controls: { site: SITE.id, view: 'queue', kind: null, q: '', open: uid('8801', 2) } }) },
    { id: 'detail-lane', label: 'Detail: a lane over capacity, found again', model: make({ detail: open(3), controls: { site: SITE.id, view: 'queue', kind: null, q: '', open: uid('8801', 3) } }) },
    { id: 'detail-resolved', label: 'Detail: resolved with a note (actions held)', model: make({ detail: open(11, RESOLVED), rows: RESOLVED, controls: { site: SITE.id, view: 'resolved', kind: null, q: '', open: uid('8801', 11) } }) },
    { id: 'detail-loading', label: 'Detail: reading', model: make({ detail: { id: uid('8801', 4), loaded: { status: 'loading' } } }) },
    { id: 'snooze', label: 'Snooze until: tomorrow, Monday, a date, or after the next run', model: make({ dialog: { kind: 'snooze', id: uid('8801', 1) } }) },
    { id: 'resolve', label: 'Resolve with a note: held until 3 characters', model: make({ dialog: { kind: 'resolve', id: uid('8801', 5), note: 'ok', busy: false, problem: null } }) },
    { id: 'resolve-refused', label: 'Resolve refused: resolved meanwhile', model: make({ dialog: { kind: 'resolve', id: uid('8801', 5), note: 'Reduced the line to 12 on the PO.', busy: false, problem: 'refusal.resolved' } }) },
    { id: 'acknowledged', label: 'After Acknowledge: the notice', model: make({ notice: { tone: 'success', key: 'notice.acknowledged', params: { count: 2 } } }) },
    { id: 'live-update', label: 'A newer run finished: 1 update · Show', model: make({ updates: 1 }) },
    { id: 'running', label: 'Run plan now is going', model: make({ running: true }) },
    { id: 'keys', label: 'Keyboard shortcuts', model: make({ dialog: { kind: 'keys' } }) },
    { id: 'keyboard', label: 'Keyboard: the keys sit in the footer icon', model: make({ focusRow: 1, keysOpen: true }) },
    { id: 'more', label: 'More than one page: Show 50 more', model: make({ more: true }) },
    { id: 'cleared', label: 'Nothing left to clear', model: make({ list: { status: 'ready', value: { ...LIST, tiles: { open: 0, new: 0, mine: 0, snoozedUntilToday: 0 }, exceptions: [] } }, rows: [] }) },
    { id: 'no-run', label: 'First day: no run at this site yet', model: make({ list: { status: 'ready', value: { ...LIST, latestRun: null, tiles: { open: 0, new: 0, mine: 0, snoozedUntilToday: 0 }, exceptions: [] } }, rows: [] }) },
    { id: 'two-sites', label: 'Two sites: the site is picked in the band', model: make({ sites: { status: 'ready', value: SITES } }) },
    { id: 'loading', label: 'Loading', model: make({ list: { status: 'loading' }, rows: [], live: 'connecting' }) },
    { id: 'error', label: 'Couldn’t load exceptions', model: make({ list: { status: 'error', problem: 'error.offline' }, rows: [], live: 'offline' }), note: 'A failed read is never drawn as an empty queue.' },
    { id: 'read-only', label: 'Read-only: sees the queue; Acknowledge, Snooze, Resolve and Run held with the reason', model: make({ selected: [uid('8801', 1)] }, rolePermissions('read_only')) },
    { id: 'read-only-detail', label: 'Read-only: the detail, actions held', model: make({ detail: open(1), controls: { site: SITE.id, view: 'queue', kind: null, q: '', open: uid('8801', 1) } }, rolePermissions('read_only')) },
    { id: 'no-permission', label: 'Sales: no planning.view — the page says so (the row is hidden in the navigation)', model: make({}, rolePermissions('sales')) },
  ],
})

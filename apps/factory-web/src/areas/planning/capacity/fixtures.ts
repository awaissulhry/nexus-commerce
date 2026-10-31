import { createElement, type ReactNode } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { permissionCheck } from '../../../lib/session/session'
import { officeNavFor } from '../../../shell/nav/office-nav'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, rolePermissions } from '../../../shell/design-data'
import { OfficeShellView, type OfficeShellViewModel } from '../../../shell/office/view/OfficeShellView'
import { SITES } from '../board/fixtures'
import type { Capacity, CapacityCell, CapacityLane, CellOrders } from './api'
import { cellKeyOf } from './model'
import type { CapacityModel } from './view-model'
import { CapacityView } from './view/CapacityView'

/**
 * SCR-123 Capacity & load with made-up data: an invented site, two lines ("Linea 1", "Linea 2"), two work centres
 * ("Taglio", "Cucitura"), work orders and styles. Nothing here is a real company, person or number. Drawn inside the
 * Office shell with the planner's navigation. Minutes per line and work centre only: no person anywhere.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const SITE = SITES[0]!
const TODAY = '2026-11-16'
const plus = (day: string, days: number) => {
  const date = new Date(`${day}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}
const WEEKS = [47, 48, 49, 50, 51].map((week, index) => ({ key: `2026-W${week}`, kind: 'WEEK', from: plus(TODAY, index * 7), to: plus(TODAY, index * 7 + 6) }))
const one = (value: number) => value.toFixed(1)

function cell(bucket: (typeof WEEKS)[number], people: number, minutesPerDay: number, efficiency: number, days: number, booked: number, extra: Partial<CapacityCell> = {}): CapacityCell {
  const available = people * minutesPerDay * (efficiency / 100) * days
  return {
    key: bucket.key,
    from: bucket.from,
    to: bucket.to,
    workingDays: days,
    workingMinutes: one(minutesPerDay * days),
    minutesPerDay: days > 0 ? one(minutesPerDay) : null,
    availableMinutes: one(available),
    bookedMinutes: one(booked),
    scheduledMinutes: one(booked * 0.8),
    loadPct: available > 0 ? ((booked / available) * 100).toFixed(1) : null,
    overMinutes: one(Math.max(0, booked - available)),
    people,
    efficiencyPct: efficiency.toFixed(2),
    closedDays: [],
    noShiftDays: [],
    ...extra,
  }
}

function lane(n: number, kind: CapacityLane['kind'], code: string, name: string, people: number, efficiency: number, booked: readonly number[], over: Partial<CapacityLane> = {}): CapacityLane {
  const cells = WEEKS.map((bucket, index) => {
    const closed = bucket.key === '2026-W50'
    return cell(bucket, people, 450, efficiency, closed ? 4 : 5, booked[index] ?? 0, closed ? { closedDays: [{ date: '2026-12-08', reason: 'HOLIDAY', name: 'Immacolata Concezione' }] } : {})
  })
  const available = cells.reduce((sum, entry) => sum + Number(entry.availableMinutes), 0)
  const bookedAll = cells.reduce((sum, entry) => sum + Number(entry.bookedMinutes), 0)
  return {
    kind,
    id: uid(kind === 'LINE' ? '4444' : '2222', n),
    code,
    name,
    workCentreKind: kind === 'WORK_CENTRE' ? (code === 'CUT' ? 'CUTTING' : 'SEWING') : null,
    stations: people,
    efficiencyPct: efficiency.toFixed(2),
    efficiencySource: kind === 'LINE' ? 'LANE' : 'SITE',
    people,
    peopleSource: kind === 'LINE' ? 'CAPACITY' : 'STATIONS',
    pattern: { id: uid('6060', 1), code: 'DUE-TURNI', name: 'Due turni 6–14 / 14–22', source: 'CALENDAR' },
    calendars: [{ id: uid('6161', 1), scope: 'SITE', name: 'Calendario Stabilimento Demo Nord 2026' }],
    does: null,
    cells,
    overall: { availableMinutes: one(available), bookedMinutes: one(bookedAll), loadPct: available > 0 ? ((bookedAll / available) * 100).toFixed(1) : null, overMinutes: one(Math.max(0, bookedAll - available)) },
    unplaced: { pastDueMinutes: '0.0', undatedMinutes: '0.0' },
    heldWorkOrders: 0,
    ...over,
  }
}

const LANES: CapacityLane[] = [
  lane(1, 'LINE', 'L1', 'Linea 1', 8, 85, [11200, 9800, 6400, 2100, 0], { unplaced: { pastDueMinutes: '640.0', undatedMinutes: '0.0' } }),
  lane(2, 'LINE', 'L2', 'Linea 2', 6, 90, [13800, 12100, 8800, 4200, 1200], { heldWorkOrders: 1 }),
  lane(3, 'WORK_CENTRE', 'CUT', 'Taglio', 3, 100, [5200, 4100, 2600, 900, 0]),
  lane(4, 'WORK_CENTRE', 'SEW', 'Cucitura', 12, 100, [19800, 17200, 14000, 6100, 2200], { efficiencySource: 'DEFAULT', pattern: { id: 'default', code: 'DEFAULT', name: 'Default', source: 'DEFAULT' }, calendars: [] }),
]

export const CAPACITY: Capacity = {
  site: { id: SITE.id, companyId: SITE.companyId, code: SITE.code, name: SITE.name, timeZone: SITE.timeZone },
  from: TODAY,
  to: WEEKS[4]!.to,
  bucket: 'WEEK',
  today: TODAY,
  asOf: '2026-11-16T08:12:00.000Z',
  buckets: WEEKS,
  lanes: LANES,
  tiles: { lanesOverThisWeek: 1, freeMinutesNext4Weeks: { lines: '58730.0', workCentres: '102300.0' }, mostLoadedThisWeek: { kind: 'LINE', id: LANES[1]!.id, code: 'L2', loadPct: '113.6' } },
  workOrdersWithoutLine: 2,
}

const style = (n: number, name: string) => ({ id: uid('6666', n), code: `MOD-${String(n).padStart(3, '0')}`, name })
const ORDERS: CellOrders = {
  lane: { kind: 'LINE', id: LANES[1]!.id, code: 'L2', name: 'Linea 2' },
  from: WEEKS[0]!.from,
  to: WEEKS[0]!.to,
  availableMinutes: LANES[1]!.cells[0]!.availableMinutes,
  bookedMinutes: LANES[1]!.cells[0]!.bookedMinutes,
  loadPct: LANES[1]!.cells[0]!.loadPct,
  orders: [
    { workOrder: { id: uid('9999', 221), number: 'WO-DEMO-0221', status: 'IN_PROGRESS', dueDate: '2026-11-27', style: style(1, 'Giacca Aero') }, operation: { id: uid('7777', 1), seq: 40, code: 'SEW-ASM', name: 'Assemblaggio', standardMinutes: '38.5' }, pieces: 180, minutes: '6930.0', sharePct: '50.2', placedBy: 'SLOT', slot: { id: uid('8888', 1), startAt: '2026-11-16T05:00:00.000Z', endAt: '2026-11-19T13:00:00.000Z' } },
    { workOrder: { id: uid('9999', 222), number: 'WO-DEMO-0222', status: 'RELEASED', dueDate: '2026-11-20', style: style(2, 'Pantalone Strada') }, operation: { id: uid('7777', 2), seq: 30, code: 'SEW-PNL', name: 'Cucitura pannelli', standardMinutes: '22.0' }, pieces: 220, minutes: '4840.0', sharePct: '35.1', placedBy: 'SLOT', slot: { id: uid('8888', 2), startAt: '2026-11-18T05:00:00.000Z', endAt: '2026-11-20T13:00:00.000Z' } },
    { workOrder: { id: uid('9999', 225), number: 'WO-DEMO-0225', status: 'RELEASED', dueDate: '2026-11-22', style: style(3, 'Gilet Tour') }, operation: { id: uid('7777', 3), seq: 20, code: 'SEW-ZIP', name: 'Montaggio zip', standardMinutes: '6.5' }, pieces: 312, minutes: '2028.0', sharePct: '14.7', placedBy: 'DUE_DATE', slot: null },
  ],
}

export interface CapacityCase {
  model: CapacityModel
  permissions: readonly string[]
}

function inShell(page: ReactNode, permissions: readonly string[]): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck(permissions)),
    path: '/planning/capacity',
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path: '/planning/capacity' },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

function CapacityDesign({ model }: { model: CapacityCase }) {
  return inShell(createElement(CapacityView, { model: model.model }), model.permissions)
}

const PLANNER = rolePermissions('planner')
const CONTROLS = { site: SITE.id, from: null, to: null, bucket: 'WEEK' as const, tile: null, cell: null }

function make(over: Partial<CapacityModel> = {}, permissions: readonly string[] = PLANNER): CapacityCase {
  return {
    permissions,
    model: {
      prefix: '/w/DEMO',
      canView: permissions.includes('planning.view'),
      sites: { status: 'ready', value: [SITE] },
      siteId: SITE.id,
      capacity: { status: 'ready', value: CAPACITY },
      cell: null,
      live: 'live',
      updates: 0,
      dialog: null,
      ...over,
      controls: { ...CONTROLS, ...(over.controls ?? {}) },
    },
  }
}

const L2W47 = cellKeyOf(LANES[1]!, '2026-W47')
const DAYS: Capacity = {
  ...CAPACITY,
  bucket: 'DAY',
  to: plus(TODAY, 6),
  buckets: [0, 1, 2, 3, 4, 5, 6].map((index) => ({ key: plus(TODAY, index), kind: 'DAY', from: plus(TODAY, index), to: plus(TODAY, index) })),
  lanes: LANES.map((entry) => ({
    ...entry,
    cells: [0, 1, 2, 3, 4, 5, 6].map((index) => {
      const day = plus(TODAY, index)
      const weekend = index >= 5
      return cell({ key: day, kind: 'DAY', from: day, to: day }, entry.people, 450, Number(entry.efficiencyPct), weekend ? 0 : 1, weekend ? 0 : Number(entry.cells[0]!.bookedMinutes) / 5, weekend ? { noShiftDays: [day] } : {})
    }),
  })),
}

export const designScreen = defineDesignScreen<CapacityCase>({
  screen: 'SCR-123',
  title: 'Capacity & load',
  view: CapacityDesign,
  cases: [
    { id: 'weeks', label: 'Load against capacity, the next five weeks by week (planner)', model: make(), note: 'Linea 2 is over this week: the bar says the minutes over, never colour alone. Week 50 has the 8 Dec holiday. The bar opens the orders; ⓘ says how the capacity is made.' },
    { id: 'days', label: 'Bucket Day: the weekend has no shift', model: make({ capacity: { status: 'ready', value: DAYS }, controls: { ...CONTROLS, bucket: 'DAY' } }) },
    { id: 'tile-over', label: 'Tile pressed: lanes over 100% this week', model: make({ controls: { ...CONTROLS, tile: 'over' } }) },
    { id: 'tile-most', label: 'Tile pressed: the most loaded lane', model: make({ controls: { ...CONTROLS, tile: 'most' } }) },
    { id: 'cell', label: 'A cell’s orders: Linea 2 · week 47 (J / K across cells)', model: make({ controls: { ...CONTROLS, cell: L2W47 }, cell: { key: L2W47, orders: { status: 'ready', value: ORDERS } } }), note: 'Per work order and operation: garments still to do, minutes, share; placed by the board or at the due date. Open on board opens a window of its own.' },
    { id: 'cell-loading', label: 'A cell’s orders: reading', model: make({ controls: { ...CONTROLS, cell: L2W47 }, cell: { key: L2W47, orders: { status: 'loading' } } }) },
    { id: 'cell-error', label: 'A cell’s orders could not be read', model: make({ controls: { ...CONTROLS, cell: L2W47 }, cell: { key: L2W47, orders: { status: 'error', problem: 'error.offline' } } }) },
    { id: 'selection', label: 'Selection: Open 2 on the board, Export 2', model: make({ selected: [`LINE:${LANES[0]!.id}`, `LINE:${LANES[1]!.id}`] }) },
    { id: 'live-update', label: 'A move on the board: 2 updates · Show', model: make({ updates: 2 }) },
    { id: 'keys', label: 'Keyboard shortcuts', model: make({ dialog: { kind: 'keys' } }) },
    { id: 'keyboard', label: 'Keyboard: the keys sit in the footer icon', model: make({ focusRow: 1, keysOpen: true }) },
    { id: 'two-sites', label: 'Two sites: the site is picked in the band', model: make({ sites: { status: 'ready', value: SITES } }) },
    { id: 'period-backwards', label: 'A period that ends before it starts', model: make({ capacity: { status: 'error', problem: 'period.backwards' }, controls: { ...CONTROLS, from: '2026-12-01', to: '2026-11-20' } }) },
    { id: 'empty', label: 'No lanes on this site yet', model: make({ capacity: { status: 'ready', value: { ...CAPACITY, lanes: [], tiles: { lanesOverThisWeek: 0, freeMinutesNext4Weeks: { lines: '0.0', workCentres: '0.0' }, mostLoadedThisWeek: null }, workOrdersWithoutLine: 0 } } }) },
    { id: 'loading', label: 'Loading', model: make({ capacity: { status: 'loading' }, live: 'connecting' }) },
    { id: 'error', label: 'Couldn’t load load against capacity', model: make({ capacity: { status: 'error', problem: 'error.offline' }, live: 'offline' }), note: 'A failed read is never drawn as an empty table; the tiles say —.' },
    { id: 'read-only', label: 'Read-only: the same numbers (nothing is written here)', model: make({}, rolePermissions('read_only')) },
    { id: 'no-permission', label: 'Sales: no planning.view — the page says so', model: make({}, rolePermissions('sales')) },
  ],
})

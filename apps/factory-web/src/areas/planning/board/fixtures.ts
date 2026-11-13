import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { AllocationWorkshops, KitTiming, WorkOrderWorkshops } from '../allocation/depth/api'
import type { Subcontractors } from '../capacity/depth/api'
import type { BarDetail, Board, BoardLane, BoardSlot, BoardWorkOrder, FloorView, PlaceByDueDate, PlanningSite, PublishedVersion, PublishPreview } from './api'
import type { BacklogRun, ChangeEntry, ChangesPage, DaySheetPaper, WhatIf } from './depth/api'
import { DEFAULT_CONTROLS, type BoardControls } from './model'
import { whatIfBoard as whatIfBoardOf } from './depth/model'
import type { BoardDepth, BoardDialog, BoardViewModel, ChangesState } from './view-model'
import { BoardView } from './view/BoardView'

/**
 * SCR-122 Planning board with made-up data: an invented site ("Stabilimento Esempio"), invented lines, styles and work
 * orders, an invented planner ("Marta Esempio"). Nothing here is a real company, person, order or number. Design-only.
 * The week shown starts on Monday 16 November 2026 (today in these cases).
 *
 * B-W2b-337 (the board in depth): every bar has its state on the floor, one bar is pinned, the workshop lane says what it is
 * approved for and its weekly capacity, the problems list has its three W2b kinds, and the Changes feed its made-up moves;
 * the new cases show What-if, Move to a subcontractor, the material check, Print day sheets, Reschedule backlog and Export.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const at = (day: number, hour = 8, minute = 0, month = 11) => new Date(Date.UTC(2026, month - 1, day, hour - 1, minute)).toISOString()
const day = (n: number, month = 11) => `2026-${String(month).padStart(2, '0')}-${String(n).padStart(2, '0')}`
export const TODAY = day(16)
export const NOW = at(16, 9, 42)
export const ME = uid('3333', 1)
export const PREFIX = '/w/DEMO'

const SITE = { id: uid('1111', 1), companyId: uid('1010', 1), code: 'ST1', name: 'Stabilimento Esempio', timeZone: 'Europe/Rome' }
export const SITES: PlanningSite[] = [
  { ...SITE },
  { id: uid('1111', 2), companyId: SITE.companyId, code: 'ST2', name: 'Secondo stabilimento', timeZone: 'Europe/Rome' },
]

const CENTRE = {
  cut: { id: uid('2222', 1), code: 'CUT', name: 'Taglio' },
  sew: { id: uid('2222', 2), code: 'SEW', name: 'Cucito' },
  qc: { id: uid('2222', 3), code: 'QC', name: 'Controllo finale' },
}
const LINE1 = { id: uid('4444', 1), code: 'L1', name: 'Linea 1' }
const LINE2 = { id: uid('4444', 2), code: 'L2', name: 'Linea 2' }
const WORKSHOP = { id: uid('5555', 1), code: 'LAB-B', name: 'Laboratorio Beta' }

const DAYS = Array.from({ length: 14 }, (_, index) => day(16 + index))
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay() % 6 !== 0

/** Capacity cells: people × 450 min × efficiency on weekdays; booked = the bars here + work not on the board. */
function cells(people: number, efficiency: number, booked: Readonly<Record<string, number>>, other: Readonly<Record<string, number>> = {}, closed: Readonly<Record<string, string>> = {}) {
  return DAYS.map((date) => {
    const open = weekday(date) && !closed[date]
    const available = open ? people * 450 * (efficiency / 100) : 0
    const scheduled = booked[date] ?? 0
    const all = scheduled + (other[date] ?? 0)
    return {
      key: date,
      from: date,
      to: date,
      availableMinutes: available.toFixed(1),
      bookedMinutes: all.toFixed(1),
      scheduledMinutes: scheduled.toFixed(1),
      loadPct: available > 0 ? ((all / available) * 100).toFixed(1) : null,
      overMinutes: Math.max(0, all - available).toFixed(1),
      closedDays: closed[date] ? [{ date, reason: 'CLOSURE' as const, name: closed[date]! }] : [],
    }
  })
}

const LANES: BoardLane[] = [
  { kind: 'LINE', ...LINE1, workCentreKind: null, people: 8, efficiencyPct: '85.00', does: [CENTRE.sew.id], cells: cells(8, 85, { [day(17)]: 1800, [day(18)]: 3400 }, { [day(20)]: 900 }) },
  { kind: 'LINE', ...LINE2, workCentreKind: null, people: 6, efficiencyPct: '80.00', does: [CENTRE.sew.id], cells: cells(6, 80, { [day(18)]: 2000 }, {}, { [day(20)]: 'Inventario' }) },
  { kind: 'WORK_CENTRE', ...CENTRE.cut, workCentreKind: 'CUTTING', people: 2, efficiencyPct: '100.00', does: null, cells: cells(2, 100, { [day(16)]: 720 }) },
  { kind: 'WORK_CENTRE', ...CENTRE.qc, workCentreKind: 'INSPECTION', people: 1, efficiencyPct: '100.00', does: null, cells: cells(1, 100, { [day(19)]: 360 }) },
  { kind: 'WORKSHOP', ...WORKSHOP, workCentreKind: null, people: null, efficiencyPct: null, does: null, cells: null },
]

const style = (n: number, name: string) => ({ id: uid('6666', n), code: `MOD-${String(n).padStart(3, '0')}`, name })

function operation(workOrder: number, seq: number, centre: keyof typeof CENTRE, minutesEach: number, pieces: number, lane: { kind: 'LINE' | 'WORK_CENTRE' | 'WORKSHOP'; id: string }, planned: [string, string] | null, slotIds: string[], extra: Partial<BoardWorkOrder['operations'][number]> = {}): BoardWorkOrder['operations'][number] {
  return {
    id: uid('7777', workOrder * 10 + seq / 10),
    seq,
    code: `${centre.toUpperCase()}-${seq}`,
    name: CENTRE[centre].name,
    workCentre: CENTRE[centre],
    standardMinutes: minutesEach.toFixed(3),
    remainingPieces: pieces,
    minutes: (minutesEach * pieces).toFixed(1),
    workingMinutes: Math.round((minutesEach * pieces) / 6),
    lane,
    outside: null,
    latestStart: planned ? planned[0] : null,
    latestFinish: planned ? planned[1] : null,
    plannedStart: planned ? planned[0] : null,
    plannedFinish: planned ? planned[1] : null,
    startsLate: false,
    slotIds,
    ...extra,
  }
}

const slotId = (n: number) => uid('8888', n)
const lineLane = (line: { id: string }) => ({ kind: 'LINE' as const, id: line.id })
const centreLane = (centre: { id: string }) => ({ kind: 'WORK_CENTRE' as const, id: centre.id })

const schedule = (status: BoardWorkOrder['schedule']['status'], reason: BoardWorkOrder['schedule']['reasons'][number]['code'], latestSafeStart: string | null, planned: [string | null, string | null], placed: 'ALL' | 'PART' | 'NONE' = 'ALL') => ({
  status,
  latestSafeStart,
  latestFinish: null,
  earliestFinish: planned[1],
  plannedStart: planned[0],
  plannedFinish: planned[1],
  placed,
  reasons: [{ code: reason }],
})

export const WORK_ORDERS: BoardWorkOrder[] = [
  {
    id: uid('9999', 101),
    number: 'WO-0101',
    status: 'RELEASED',
    kind: 'CUSTOMER',
    priority: 0,
    rush: false,
    version: 4,
    dueDate: day(27),
    style: style(1, 'Giacca Aero'),
    garments: 120,
    line: LINE1,
    holdReason: null,
    booksCapacity: true,
    minutes: '4680.0',
    schedule: schedule('ON_TIME', 'ON_TIME', at(23, 9), [at(16, 8), at(19, 14)]),
    readiness: { word: 'RECEIVED', date: null },
    operations: [
      operation(101, 10, 'cut', 6, 120, centreLane(CENTRE.cut), [at(16, 8), at(16, 14)], [slotId(1)]),
      operation(101, 20, 'sew', 30, 120, lineLane(LINE1), [at(17, 8), at(18, 16)], [slotId(2)]),
      operation(101, 30, 'qc', 3, 120, centreLane(CENTRE.qc), [at(19, 8), at(19, 14)], [slotId(3)]),
    ],
  },
  {
    id: uid('9999', 102),
    number: 'WO-0102',
    status: 'RELEASED',
    kind: 'CUSTOMER',
    priority: 0,
    rush: false,
    version: 2,
    dueDate: day(20),
    style: style(2, 'Pantalone Strada'),
    garments: 80,
    line: LINE2,
    holdReason: null,
    booksCapacity: true,
    minutes: '2000.0',
    schedule: schedule('LATE', 'PLAN_FINISHES_LATE', at(17, 8), [at(18, 8), at(21, 12)]),
    readiness: { word: 'EXPECTED', date: day(18) },
    // B-W2b-337: the leather arrives on Wednesday, the work may start on Thursday (the bar starts on Wednesday: a W2b problem).
    materialStart: { state: 'ARRIVES', arrives: day(18), startDay: day(19), earliestStart: at(19, 8), setBy: { label: 'PEL-CAP-NERO · Pelle bovina nero', arrives: day(18), purchaseOrderNumber: 'PO-ESEMPIO-0007', source: 'PURCHASE_ORDER' }, notCovered: [] },
    operations: [operation(102, 20, 'sew', 25, 80, lineLane(LINE2), [at(18, 8), at(18, 17)], [slotId(4)], { startsLate: true })],
  },
  {
    id: uid('9999', 103),
    number: 'WO-0103',
    status: 'IN_PROGRESS',
    kind: 'CUSTOMER',
    priority: 1,
    rush: true,
    version: 7,
    dueDate: day(24),
    style: style(3, 'Gilet Pista'),
    garments: 40,
    line: LINE1,
    holdReason: null,
    booksCapacity: true,
    minutes: '1600.0',
    schedule: schedule('AT_RISK', 'START_SOON', at(18, 8), [at(18, 8), at(18, 17)]),
    readiness: { word: 'RECEIVED', date: null },
    operations: [operation(103, 20, 'sew', 40, 40, lineLane(LINE1), [at(18, 8), at(18, 17)], [slotId(5)])],
  },
  {
    id: uid('9999', 104),
    number: 'WO-0104',
    status: 'DRAFT',
    kind: 'CUSTOMER',
    priority: 0,
    rush: false,
    version: 1,
    dueDate: day(4, 12),
    style: style(4, 'Giacca Touring'),
    garments: 60,
    line: null,
    holdReason: null,
    booksCapacity: false,
    minutes: '2340.0',
    schedule: schedule('ON_TIME', 'ON_TIME', at(30, 8), [null, null], 'NONE'),
    readiness: { word: 'NOT_PLANNED', date: null },
    operations: [operation(104, 10, 'cut', 6, 60, centreLane(CENTRE.cut), null, []), operation(104, 20, 'sew', 33, 60, lineLane(LINE1), null, [])],
  },
  {
    id: uid('9999', 105),
    number: 'WO-0105',
    status: 'RELEASED',
    kind: 'CUSTOMER',
    priority: 0,
    rush: false,
    version: 3,
    dueDate: day(19),
    style: style(5, 'Tuta Corsa'),
    garments: 30,
    line: LINE2,
    holdReason: null,
    booksCapacity: true,
    minutes: '1050.0',
    schedule: schedule('LATE', 'CANNOT_FINISH_IN_TIME', at(13, 8), [at(17, 8), at(23, 17)], 'PART'),
    readiness: { word: 'NOT_ENOUGH', date: day(23) },
    operations: [operation(105, 20, 'sew', 35, 30, lineLane(LINE2), null, [])],
  },
]

// B-W2b-337: a bar's state on the floor (made-up scans).
const floor = (state: FloorView['state'], done: number, of: number, running = 0, paused = 0, since: string | null = null): FloorView => ({ state, done, of, pct: Math.round((done * 100) / of), runningBundles: running, pausedBundles: paused, since, pauseReasonCode: state === 'PAUSED' ? 'BREAK' : null, lastScanAt: since })
const MARTA = { id: uid('3333', 2), name: 'Marta Esempio' }

const slot = (n: number, workOrder: BoardWorkOrder, operationIndex: number | null, lane: BoardSlot['lane'], start: string, end: string, minutes: number, extra: Partial<BoardSlot> = {}): BoardSlot => ({
  id: slotId(n),
  version: 2,
  lane,
  workOrderId: workOrder.id,
  operationId: operationIndex === null ? null : workOrder.operations[operationIndex]!.id,
  startAt: start,
  endAt: end,
  pieces: null,
  minutes: minutes.toFixed(1),
  overloadReason: null,
  note: null,
  updatedAt: at(13, 17, 20),
  updatedBy: { id: ME, name: 'Anna Esempio' },
  booksCapacity: workOrder.booksCapacity,
  latestStart: start,
  latestFinish: end,
  startsLate: false,
  ...extra,
})

const [WO101, WO102, WO103, WO104, WO105] = WORK_ORDERS as [BoardWorkOrder, BoardWorkOrder, BoardWorkOrder, BoardWorkOrder, BoardWorkOrder]

export const SLOTS: BoardSlot[] = [
  slot(1, WO101, 0, centreLane(CENTRE.cut), at(16, 8), at(16, 14), 720, { floor: floor('RUNNING', 90, 120) }),
  slot(2, WO101, 1, lineLane(LINE1), at(17, 8), at(18, 16), 3600, { floor: floor('RUNNING', 30, 120, 2, 0, at(16, 8, 30)) }),
  slot(3, WO101, 2, centreLane(CENTRE.qc), at(19, 8), at(19, 14), 360, { floor: floor('NOT_STARTED', 0, 120) }),
  slot(4, WO102, 0, lineLane(LINE2), at(18, 8), at(18, 17), 2000, { startsLate: true, floor: floor('PAUSED', 10, 80, 0, 1, at(16, 9, 0)) }),
  slot(5, WO103, 0, lineLane(LINE1), at(18, 8), at(18, 17), 1600, { overloadReason: 'Straordinario di sabato (esempio)', updatedBy: MARTA, updatedAt: at(16, 9, 12), version: 5, pinned: true, pinnedAt: at(16, 9, 14), pinnedBy: MARTA, floor: floor('NOT_STARTED', 0, 40) }),
  slot(6, WO105, null, { kind: 'WORKSHOP', id: WORKSHOP.id }, at(17, 8), at(20, 17), 350, { pieces: 10, floor: floor('DONE', 10, 10) }),
]

export const BOARD: Board = {
  site: SITE,
  from: DAYS[0]!,
  to: DAYS[DAYS.length - 1]!,
  bucket: 'DAY',
  today: TODAY,
  asOf: NOW,
  plan: {
    id: uid('abcd', 1),
    version: 12,
    updatedAt: at(16, 9, 12),
    published: { id: uid('abce', 3), number: 3, coversFrom: day(13), coversTo: day(19), effectiveFrom: at(13, 6), publishedAt: at(12, 17, 30), publishedBy: { id: ME, name: 'Anna Esempio' } },
    changesSincePublished: { moved: 2, added: 3, removed: 1 },
    mayChange: true,
    mayPublish: true,
    publishHeld: null,
  },
  buckets: DAYS.map((date) => ({ key: date, kind: 'DAY' as const, from: date, to: date })),
  lanes: LANES,
  slots: SLOTS,
  workOrders: WORK_ORDERS,
  tray: [
    { workOrderId: WO105.id, unplacedOperations: 1, minutes: '1050.0', latestSafeStart: at(13, 8), chips: ['PAST_LATEST_SAFE_START', 'MATERIAL_NOT_READY'] },
    { workOrderId: WO104.id, unplacedOperations: 2, minutes: '2340.0', latestSafeStart: at(30, 8), chips: ['DRAFT'] },
  ],
  problems: [
    { kind: 'OVERBOOKED', lane: lineLane(LINE1), date: day(18), bucketKey: day(18), overMinutes: '340.0', loadPct: '111.1', workOrderId: null, daysLate: null },
    { kind: 'FINISHES_LATE', lane: null, date: day(20), bucketKey: null, overMinutes: null, loadPct: null, workOrderId: WO102.id, daysLate: 1 },
    { kind: 'FINISHES_LATE', lane: null, date: day(19), bucketKey: null, overMinutes: null, loadPct: null, workOrderId: WO105.id, daysLate: 4 },
  ],
  // B-W2b-337 (B-W2b-312): the problems list's three W2b kinds.
  moreProblems: [
    { kind: 'IN_THE_PAST', lane: centreLane(CENTRE.cut), date: day(16), workOrderId: WO101.id, slotId: slotId(1) },
    { kind: 'MATERIAL_NOT_IN_TIME', lane: lineLane(LINE2), date: day(19), workOrderId: WO102.id, slotId: slotId(4) },
    { kind: 'GATE_NOT_PASSED', lane: lineLane(LINE1), date: day(18), workOrderId: WO103.id, slotId: slotId(5) },
  ],
}

/** The same board in weeks: eight weeks from the Monday. */
function weeks(): Board {
  const keys = ['2026-W47', '2026-W48', '2026-W49', '2026-W50', '2026-W51', '2026-W52', '2026-W53', '2027-W01']
  const buckets = keys.map((key, index) => ({ key, kind: 'WEEK' as const, from: plus(TODAY, index * 7), to: plus(TODAY, index * 7 + 6) }))
  const weekCells = (lane: BoardLane) =>
    lane.cells
      ? buckets.map((bucket) => {
          const inside = lane.cells!.filter((cell) => cell.from >= bucket.from && cell.from <= bucket.to)
          const sum = (field: 'availableMinutes' | 'bookedMinutes' | 'scheduledMinutes') => inside.reduce((total, cell) => total + Number(cell[field]), 0)
          const available = inside.length ? sum('availableMinutes') : (lane.people ?? 0) * 450 * Number(lane.efficiencyPct ?? 100) * 5 / 100
          const booked = sum('bookedMinutes')
          return { key: bucket.key, from: bucket.from, to: bucket.to, availableMinutes: available.toFixed(1), bookedMinutes: booked.toFixed(1), scheduledMinutes: sum('scheduledMinutes').toFixed(1), loadPct: available ? ((booked / available) * 100).toFixed(1) : null, overMinutes: Math.max(0, booked - available).toFixed(1), closedDays: inside.flatMap((cell) => cell.closedDays) }
        })
      : null
  return { ...BOARD, bucket: 'WEEK', from: buckets[0]!.from, to: buckets[buckets.length - 1]!.to, buckets, lanes: LANES.map((lane) => ({ ...lane, cells: weekCells(lane) })), problems: BOARD.problems.filter((problem) => problem.kind === 'FINISHES_LATE') }
}

function plus(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

const BAR: BarDetail = {
  site: SITE,
  asOf: NOW,
  workOrder: WO101,
  sizes: [
    { colourway: 'NERO', size: '46', quantity: 20 },
    { colourway: 'NERO', size: '48', quantity: 40 },
    { colourway: 'NERO', size: '50', quantity: 30 },
    { colourway: 'BLU', size: '48', quantity: 30 },
  ],
  slots: SLOTS.slice(0, 3),
  lanes: LANES.filter((lane) => lane.kind !== 'WORKSHOP').map((lane) => ({ kind: lane.kind, id: lane.id, code: lane.code, name: lane.name, workCentreKind: lane.workCentreKind, people: lane.people, efficiencyPct: lane.efficiencyPct, does: lane.does })),
}

const PREVIEW: PublishPreview = {
  site: SITE,
  asOf: NOW,
  plan: { id: uid('abcd', 1), version: 12 },
  next: 4,
  previous: BOARD.plan.published,
  range: { coversFrom: day(17), coversTo: day(23), effectiveFrom: at(17, 6), workingDays: 5, isDefault: true },
  slots: 6,
  diff: {
    moved: 2,
    added: 3,
    removed: 1,
    byLane: [
      { lane: lineLane(LINE1), code: LINE1.code, name: LINE1.name, moved: 1, added: 2, removed: 0 },
      { lane: lineLane(LINE2), code: LINE2.code, name: LINE2.name, moved: 1, added: 0, removed: 1 },
      { lane: centreLane(CENTRE.qc), code: CENTRE.qc.code, name: CENTRE.qc.name, moved: 0, added: 1, removed: 0 },
    ],
  },
  checks: [
    { code: 'OVERBOOKED', state: 'WARNING', count: 1, items: [{ workOrderId: null, slotId: null, lane: lineLane(LINE1), date: day(18) }] },
    { code: 'IN_THE_PAST', state: 'PASS', count: 0, items: [] },
    { code: 'MATERIAL_NOT_READY', state: 'WARNING', count: 1, items: [{ workOrderId: WO105.id, slotId: slotId(6), lane: null, date: null }] },
  ],
  mayPublish: true,
  heldReason: null,
}

const PLACE: PlaceByDueDate = {
  planVersion: 12,
  applied: false,
  slots: [
    { workOrderId: WO104.id, operationId: WO104.operations[0]!.id, lane: centreLane(CENTRE.cut), startAt: at(30, 8), endAt: at(30, 11), minutes: '360.0', placedBy: 'BACKWARD', over: [] },
    { workOrderId: WO104.id, operationId: WO104.operations[1]!.id, lane: lineLane(LINE1), startAt: at(1, 8, 0, 12), endAt: at(2, 12, 0, 12), minutes: '1980.0', placedBy: 'BACKWARD', over: [] },
    { workOrderId: WO105.id, operationId: WO105.operations[0]!.id, lane: lineLane(LINE2), startAt: at(17, 8), endAt: at(17, 16), minutes: '1050.0', placedBy: 'FORWARD', over: [{ lane: lineLane(LINE2), date: day(17), availableMinutes: '2160.0', bookedMinutes: '2400.0', overMinutes: '240.0', loadPct: '111.1' }] },
  ],
  skipped: [],
  overbooked: 1,
  replayed: false,
}

const VERSIONS: PublishedVersion[] = [
  { ...BOARD.plan.published!, slots: 9 },
  { id: uid('abce', 2), number: 2, coversFrom: day(6), coversTo: day(12), effectiveFrom: at(6, 6), publishedAt: at(5, 17), publishedBy: { id: uid('3333', 2), name: 'Marta Esempio' }, slots: 7 },
  { id: uid('abce', 1), number: 1, coversFrom: day(30, 10), coversTo: day(5), effectiveFrom: at(30, 6, 0, 10), publishedAt: at(29, 18, 0, 10), publishedBy: { id: ME, name: 'Anna Esempio' }, slots: 4 },
]

// ---- B-W2b-337: the board in depth (made-up) ------------------------------------------------------------------------------

const ANNA = { id: ME, name: 'Anna Esempio' }
const laneNamed = (lane: { id: string; code: string; name: string }, kind: 'LINE' | 'WORK_CENTRE' | 'WORKSHOP') => ({ kind, id: lane.id, code: lane.code, name: lane.name })
const changeId = (n: number) => uid('c0c0', n)
const entry = (n: number, over: Partial<ChangeEntry>): ChangeEntry => ({
  id: changeId(n),
  kind: 'MOVE',
  changedAt: at(16, 9, 30),
  changedBy: ANNA,
  slotId: slotId(2),
  onBoard: true,
  workOrder: { id: WO101.id, number: WO101.number },
  operation: { id: WO101.operations[1]!.id, seq: 20, code: 'SEW-20', name: CENTRE.sew.name, onWorkOrder: true },
  from: null,
  to: null,
  reason: null,
  whatIfScenarioId: null,
  publishedVersion: null,
  undoes: null,
  undoneBy: null,
  undo: { may: true, code: null },
  ...over,
})

export const CHANGES: ChangesPage = {
  plan: { id: uid('abcd', 1), version: 12 },
  since: { id: uid('abce', 3), number: 3, publishedAt: at(12, 17, 30) },
  entries: [
    entry(6, { from: { lane: laneNamed(LINE2, 'LINE'), startAt: at(17, 8), endAt: at(18, 16) }, to: { lane: laneNamed(LINE1, 'LINE'), startAt: at(17, 8), endAt: at(18, 16) } }),
    entry(5, { kind: 'PIN', changedAt: at(16, 9, 14), changedBy: MARTA, slotId: slotId(5), workOrder: { id: WO103.id, number: WO103.number }, operation: { id: WO103.operations[0]!.id, seq: 20, code: 'SEW-20', name: CENTRE.sew.name, onWorkOrder: true } }),
    entry(4, { changedAt: at(16, 9, 12), changedBy: MARTA, slotId: slotId(5), workOrder: { id: WO103.id, number: WO103.number }, operation: { id: WO103.operations[0]!.id, seq: 20, code: 'SEW-20', name: CENTRE.sew.name, onWorkOrder: true }, from: { lane: laneNamed(LINE2, 'LINE'), startAt: at(19, 8), endAt: at(19, 17) }, to: { lane: laneNamed(LINE1, 'LINE'), startAt: at(18, 8), endAt: at(18, 17) }, reason: 'Straordinario di sabato (esempio)', undo: { may: false, code: 'CHANGED_SINCE' } }),
    entry(3, { kind: 'UNDO', changedAt: at(13, 17, 50), slotId: slotId(3), operation: { id: WO101.operations[2]!.id, seq: 30, code: 'QC-30', name: CENTRE.qc.name, onWorkOrder: true }, from: { lane: laneNamed(CENTRE.qc, 'WORK_CENTRE'), startAt: at(20, 8), endAt: at(20, 14) }, to: { lane: laneNamed(CENTRE.qc, 'WORK_CENTRE'), startAt: at(19, 8), endAt: at(19, 14) }, undoes: { id: changeId(2), kind: 'MOVE' }, undo: { may: false, code: 'NOT_UNDOABLE' } }),
    entry(2, { changedAt: at(13, 17, 40), slotId: slotId(3), operation: { id: WO101.operations[2]!.id, seq: 30, code: 'QC-30', name: CENTRE.qc.name, onWorkOrder: true }, from: { lane: laneNamed(CENTRE.qc, 'WORK_CENTRE'), startAt: at(19, 8), endAt: at(19, 14) }, to: { lane: laneNamed(CENTRE.qc, 'WORK_CENTRE'), startAt: at(20, 8), endAt: at(20, 14) }, undoneBy: { id: changeId(3), changedAt: at(13, 17, 50), changedBy: ANNA }, undo: { may: false, code: 'ALREADY_UNDONE' } }),
    entry(1, { kind: 'PLACE', changedAt: at(13, 17, 20), changedBy: MARTA, slotId: slotId(6), workOrder: { id: WO105.id, number: WO105.number }, operation: null, to: { lane: laneNamed(WORKSHOP, 'WORKSHOP'), startAt: at(17, 8), endAt: at(20, 17) } }),
  ],
  next: 'older',
}

const changesState = (over: Partial<ChangesState> = {}): ChangesState => ({ read: { status: 'ready', value: CHANGES }, since: 'PUBLISHED', kinds: [], planner: null, planners: [ANNA, MARTA], ...over })

const WORKSHOPS: AllocationWorkshops = {
  site: SITE,
  today: TODAY,
  asOf: NOW,
  window: { from: TODAY, to: day(13, 12) },
  workshops: [
    {
      id: WORKSHOP.id,
      code: WORKSHOP.code,
      name: WORKSHOP.name,
      location: { id: uid('7171', 1), code: 'SUB-BETA' },
      active: true,
      supplierProblem: null,
      durc: { checked: true, state: 'MET', expiresOn: '2027-06-30' },
      capacity: [{ workCentreKind: 'SEWING', unit: 'MINUTES', available: '9600.0', booked: '350.0', proposed: '0.0', loadPct: '3.6', over: false }],
      qualifications: [
        { workCentreKind: 'SEWING', qualified: true, standing: 'QUALIFIED', words: 'Qualified.' },
        { workCentreKind: 'CUTTING', qualified: false, standing: 'NONE', words: 'Not qualified.' },
      ],
    },
  ],
  workOrders: [],
}

const SUBCONTRACTORS: Subcontractors = {
  site: SITE,
  from: DAYS[0]!,
  to: DAYS[DAYS.length - 1]!,
  bucket: 'DAY',
  today: TODAY,
  asOf: NOW,
  buckets: DAYS.map((date) => ({ key: date, kind: 'DAY', from: date, to: date })),
  lanes: [
    {
      kind: 'WORKSHOP',
      id: WORKSHOP.id,
      code: WORKSHOP.code,
      name: WORKSHOP.name,
      location: { id: uid('7171', 1), code: 'SUB-BETA' },
      workCentreKind: 'SEWING',
      unit: 'MINUTES',
      known: true,
      capacity: [{ id: uid('7272', 1), perWeek: 2400, validFrom: '2026-01-01', validTo: null }],
      cells: DAYS.map((date) => {
        const open = weekday(date)
        const booked = date >= day(17) && date <= day(20) ? 87.5 : 0
        return { key: date, from: date, to: date, available: open ? '480.0' : '0.0', booked: booked.toFixed(1), proposed: '0.0', loadPct: open ? ((booked / 480) * 100).toFixed(1) : null, over: false, openDays: open ? 1 : 0, closedDays: open ? 0 : 1 }
      }),
      overall: { available: '4800.0', booked: '350.0', proposed: '0.0', loadPct: '7.3', over: false },
    },
  ],
  tiles: { subcontractorsOverThisWeek: 0, workshopsWithoutCapacity: 0 },
}

export const DEPTH: BoardDepth = {
  may: { pin: true, outsource: true, order: true, export: true },
  whatIf: null,
  changes: changesState(),
  workshops: { status: 'ready', value: WORKSHOPS },
  subcontractors: { status: 'ready', value: SUBCONTRACTORS },
}

const WHAT_IF_ID = uid('d0d0', 1)
export const WHAT_IF: WhatIf = {
  id: WHAT_IF_ID,
  siteId: SITE.id,
  name: null,
  status: 'DRAFT',
  version: 3,
  basedAt: at(16, 9, 35),
  planChanged: false,
  planVersion: 12,
  moves: [
    { kind: 'MOVE', slotId: slotId(4), slotVersion: 2, workOrderId: WO102.id, number: WO102.number, operationId: WO102.operations[0]!.id, operation: { seq: 20, code: 'SEW-20', name: CENTRE.sew.name }, from: { lane: lineLane(LINE2), startAt: at(18, 8), endAt: at(18, 17) }, to: { lane: lineLane(LINE1), startAt: at(19, 8), endAt: at(19, 17) }, conflict: null, material: { state: 'ARRIVES', startAt: at(19, 8), inTime: true, earliestStart: at(19, 8), snapTo: null } },
    { kind: 'PLACE', slotId: null, slotVersion: null, workOrderId: WO105.id, number: WO105.number, operationId: WO105.operations[0]!.id, operation: { seq: 20, code: 'SEW-20', name: CENTRE.sew.name }, from: null, to: { lane: lineLane(LINE2), startAt: at(17, 8), endAt: at(17, 16) }, conflict: null, material: { state: 'ARRIVES', startAt: at(17, 8), inTime: false, earliestStart: at(24, 8), snapTo: at(24, 8) } },
  ],
  conflicts: 0,
  effect: {
    lateOrders: { before: 2, after: 1 },
    overMinutes: { before: '340.0', after: '0.0' },
    window: { from: TODAY, to: day(13, 12) },
    lanes: [
      { lane: lineLane(LINE1), code: LINE1.code, name: LINE1.name, from: day(18), to: day(19), beforePct: '111.1', afterPct: '98.0' },
      { lane: lineLane(LINE2), code: LINE2.code, name: LINE2.name, from: day(17), to: day(18), beforePct: '52.1', afterPct: '88.5' },
    ],
    orders: [
      { workOrderId: WO102.id, number: WO102.number, before: { status: 'LATE', plannedStart: at(18, 8), plannedFinish: at(21, 12) }, after: { status: 'ON_TIME', plannedStart: at(19, 8), plannedFinish: at(19, 17) } },
      { workOrderId: WO105.id, number: WO105.number, before: { status: 'LATE', plannedStart: null, plannedFinish: null }, after: { status: 'LATE', plannedStart: at(17, 8), plannedFinish: at(20, 17) } },
    ],
  },
}

const BACKLOG: BacklogRun = {
  planVersion: 12,
  applied: false,
  moves: [
    { workOrderId: WO101.id, number: WO101.number, operationId: WO101.operations[0]!.id, operation: { seq: 10, code: 'CUT-10', name: CENTRE.cut.name }, slotId: slotId(1), lane: centreLane(CENTRE.cut), from: { startAt: at(16, 8), endAt: at(16, 14) }, to: { startAt: at(16, 10), endAt: at(16, 16) }, minutes: '720.0', why: 'PAST', over: [] },
    { workOrderId: WO101.id, number: WO101.number, operationId: WO101.operations[1]!.id, operation: { seq: 20, code: 'SEW-20', name: CENTRE.sew.name }, slotId: slotId(2), lane: lineLane(LINE1), from: { startAt: at(17, 8), endAt: at(18, 16) }, to: { startAt: at(17, 9), endAt: at(18, 17) }, minutes: '3600.0', why: 'PUSHED', over: [{ lane: lineLane(LINE1), date: day(18) }] },
  ],
  orders: [{ workOrderId: WO101.id, number: WO101.number, dueDate: day(27), finish: at(19, 15), daysLate: null, moves: 2 }],
  kept: [{ workOrderId: WO103.id, operationId: WO103.operations[0]!.id, slotId: slotId(5), code: 'PINNED_IN_THE_PAST' }],
  skipped: [],
  overbooked: 1,
}

export const PAPER: DaySheetPaper = {
  language: 'it',
  title: 'Fogli del giorno',
  columns: ['Inizio', 'Fine', 'Ordine di lavoro', 'Modello', 'Operazione', 'Pezzi', 'Min', 'Consegna', 'Stato', 'Fatto'],
  sheets: [
    {
      heading: 'Linea L1 · Linea 1',
      facts: [
        { label: 'Stabilimento', value: 'ST1 · Stabilimento Esempio' },
        { label: 'Giorno', value: 'mar 17 nov 2026' },
        { label: 'Piano', value: 'v3, pubblicata 2026-11-12 17:30' },
      ],
      banner: null,
      rows: [{ rush: false, pinned: false, cells: ['08:00', '16:00 (mer 18)', 'WO-0101', 'MOD-001 Giacca Aero', 'Op 20 Cucito', '120', '3600', '27 nov', 'In corso 30/120', ''] }],
      empty: null,
      footer: 'Totale: 120 pezzi · 3600 min · carico 58,8% (1800 / 3060 min)',
    },
    {
      heading: 'Linea L2 · Linea 2',
      facts: [
        { label: 'Stabilimento', value: 'ST1 · Stabilimento Esempio' },
        { label: 'Giorno', value: 'mar 17 nov 2026' },
        { label: 'Piano', value: 'v3, pubblicata 2026-11-12 17:30' },
      ],
      banner: null,
      rows: [],
      empty: 'Niente in programma su questa linea in questo giorno.',
      footer: 'Totale: 0 pezzi · 0 min · carico 0% (0 / 2160 min)',
    },
  ],
  foot: 'Stampato dal tabellone di pianificazione · Stabilimento Esempio',
  pageLabel: 'Pagina',
  fileName: 'fogli-giorno-2026-11-17.pdf',
}
const PAPER_WORKING: DaySheetPaper = { ...PAPER, sheets: PAPER.sheets.map((sheet) => ({ ...sheet, facts: sheet.facts.map((fact) => (fact.label === 'Piano' ? { ...fact, value: 'Piano di lavoro, non pubblicato' } : fact)), banner: 'Piano di lavoro, non ancora pubblicato: il reparto lavora con la v3.' })) }

const SUB_WORKSHOPS: WorkOrderWorkshops = {
  workOrder: { id: WO101.id, number: WO101.number, status: WO101.status, version: WO101.version, garments: 120, style: WO101.style.code },
  asOf: NOW,
  operations: [{ id: WO101.operations[1]!.id, seq: 20, code: 'SEW-20', name: CENTRE.sew.name, workCentreKind: 'SEWING', outsourced: false, subcontractOrderId: null, outsideStep: false, version: 4 }],
  mayOutsource: true,
  workshops: [
    { id: WORKSHOP.id, code: WORKSHOP.code, name: WORKSHOP.name, location: { id: uid('7171', 1), code: 'SUB-BETA' }, active: true, supplierProblem: null, durc: { checked: true, state: 'MET', expiresOn: '2027-06-30' }, capacity: WORKSHOPS.workshops[0]!.capacity, routing: false, offered: true, held: [], warnings: [], operations: [{ operationId: WO101.operations[1]!.id, qualified: true, standing: 'QUALIFIED', words: 'Qualified.' }] },
    {
      id: uid('5555', 2),
      code: 'LAB-G',
      name: 'Laboratorio Gamma',
      location: { id: uid('7171', 2), code: 'SUB-GAMMA' },
      active: true,
      supplierProblem: null,
      durc: { checked: true, state: 'EXPIRED', expiresOn: '2026-11-05' },
      capacity: [],
      routing: false,
      offered: false,
      held: [{ code: 'NO_VALID_DURC', words: 'No valid DURC: it expired on 2026-11-05.' }, { code: 'NOT_QUALIFIED', words: 'Not approved for sewing (Op 20 Cucito): being reviewed: not qualified yet.' }],
      warnings: [],
      operations: [{ operationId: WO101.operations[1]!.id, qualified: false, standing: 'IN_REVIEW', words: 'Being reviewed.' }],
    },
  ],
}

const SUB_KIT: KitTiming = {
  workOrder: { id: WO101.id, number: WO101.number, status: WO101.status, garments: 120 },
  workshop: { id: WORKSHOP.id, code: WORKSHOP.code, name: WORKSHOP.name },
  operations: [{ id: WO101.operations[1]!.id, seq: 20, code: 'SEW-20', name: CENTRE.sew.name, workCentreKind: 'SEWING' }],
  pieces: 120,
  start: day(17),
  startSource: 'SCHEDULE',
  transportDays: 1,
  transportSource: 'WORKSHOP',
  kitShipOn: day(16),
  kitDueAt: at(16, 8),
  late: false,
  workDays: 3,
  workDaysSource: 'CAPACITY',
  backOn: day(20),
  closedDaysSkipped: 0,
  kit: {
    note: null,
    lines: [
      { item: { id: uid('3131', 1), code: 'PEL-CAP-NERO', name: 'Pelle bovina nero' }, colour: { id: uid('3232', 1), code: 'NERO' }, quantity: '86.400', uom: 'DM2' },
      { item: { id: uid('3131', 2), code: 'FOD-MESH', name: 'Fodera rete' }, colour: null, quantity: '13.230', uom: 'M' },
    ],
  },
  laterOperations: [{ id: WO101.operations[2]!.id, seq: 30, name: CENTRE.qc.name, earliestStart: day(23), latestStart: day(23), finishesLate: false }],
  finishesLate: false,
}

const subcontract = (over: Partial<Extract<BoardDialog, { kind: 'subcontract' }>> = {}): BoardDialog => ({ kind: 'subcontract', slotId: slotId(2), workOrderId: WO101.id, operationId: WO101.operations[1]!.id, partyId: WORKSHOP.id, start: null, pieces: 120, workshops: { status: 'ready', value: SUB_WORKSHOPS }, timing: { status: 'ready', value: SUB_KIT }, ...over })
const print = (over: Partial<Extract<BoardDialog, { kind: 'print' }>> = {}): BoardDialog => ({ kind: 'print', lanes: [`LINE:${LINE1.id}`, `LINE:${LINE2.id}`], date: day(17), language: 'it', plan: 'PUBLISHED', paper: { status: 'ready', value: PAPER }, ...over })
const EXPORT_JOB = { id: uid('e0e0', 1), listKey: 'planning.board', format: 'XLSX' as const, status: 'RUNNING' as const, title: 'Tabellone di pianificazione', viewName: null, columns: [], omitted: [], rowsDone: 4, rowCount: 6, failureReason: null, file: null, createdAt: at(16, 9, 40), startedAt: at(16, 9, 40), finishedAt: null, expiresAt: null }

const base = (over: Partial<BoardViewModel> = {}, controls: Partial<BoardControls> = {}): BoardViewModel => ({
  prefix: PREFIX,
  me: ME,
  sites: SITES,
  controls: { ...DEFAULT_CONTROLS, site: SITE.id, ...controls },
  read: { status: 'ready', value: BOARD },
  offline: false,
  save: { state: 'saved', at: at(16, 9, 30) },
  dialog: null,
  notice: null,
  focus: null,
  depth: DEPTH,
  ...over,
})
const depthCase = (depth: Partial<BoardDepth>, over: Partial<BoardViewModel> = {}, controls: Partial<BoardControls> = {}): BoardViewModel => base({ depth: { ...DEPTH, ...depth }, ...over }, controls)
// The what-if board: the working plan with the scenario's moves (the container does this; the design draws it the same way).
const whatIfRead = (scenario: WhatIf): BoardViewModel['read'] => ({ status: 'ready', value: whatIfBoardOf(BOARD, scenario) })

const readOnly: Board = { ...BOARD, plan: { ...BOARD.plan, mayChange: false, mayPublish: false, publishHeld: 'Publishing needs planning.schedule.publish at this site.' } }
const held: Board = { ...BOARD, plan: { ...BOARD.plan, changesSincePublished: { moved: 0, added: 0, removed: 0 }, publishHeld: 'Nothing changed since v3 was published for Tue 17 Nov to Mon 23 Nov.' } }
const empty: Board = { ...BOARD, plan: { ...BOARD.plan, id: null, version: null, published: null, changesSincePublished: null, publishHeld: 'The working plan has nothing on Tue 17 Nov to Mon 23 Nov to publish.' }, slots: [], workOrders: [], tray: [], problems: [], lanes: LANES.map((lane) => ({ ...lane, cells: lane.cells ? cells(lane.people ?? 0, Number(lane.efficiencyPct), {}) : null })) }
const dialogCase = (dialog: BoardDialog): BoardViewModel => base({ dialog })

export const designScreen = defineDesignScreen<BoardViewModel>({
  screen: 'SCR-122',
  title: 'Planning board',
  view: BoardView,
  cases: [
    { id: 'days', label: 'Two weeks in days (planner)', model: base(), note: 'Resources view: lines, work centres and a workshop with the load per day above each; Line 1 is over on Wed 18; Line 2 closed on Fri 20; the tray holds a late order without material and a draft. Moves work in this view only.' },
    { id: 'orders', label: 'Orders view', model: base({}, { view: 'orders' }), note: 'One lane per work order with its operations; a bar moves in time only (another order is held with the reason).' },
    { id: 'weeks', label: 'Eight weeks', model: base({ read: { status: 'ready', value: weeks() } }, { zoom: 'WEEK' }), note: 'Week buckets with their day ranges.' },
    { id: 'filtered', label: 'Filters and search', model: base({}, { lanes: [`LINE:${LINE1.id}`, `LINE:${LINE2.id}`], q: 'WO-01', material: false, late: true, materialMark: true, statuses: ['RELEASED', 'IN_PROGRESS'] }), note: 'Two lines, released and in-progress orders, an order number searched; every choice is in the address.' },
    { id: 'bar', label: 'Bar detail', model: dialogCase({ kind: 'bar', workOrderId: WO101.id, slotId: slotId(2), detail: { status: 'ready', value: BAR } }), note: 'Pop:bar — sizes, operations with their lanes and times, material, promise date, latest safe start; Open work order (Enter) and Send back to the tray.' },
    { id: 'bar-loading', label: 'Bar detail being read', model: dialogCase({ kind: 'bar', workOrderId: WO101.id, slotId: slotId(2), detail: { status: 'loading' } }) },
    { id: 'drop-warning', label: 'Drop over capacity', model: dialogCase({ kind: 'drop', cardLabel: 'WO-0103', laneName: LINE1.name, days: [{ where: day(18), laneId: `LINE:${LINE1.id}`, booked: 3400, available: 3060 }], source: 'board', next: true }), note: 'Pop:drop-warning — the numbers after the drop; Keep with a reason (held until a reason is given) · Move to the next free day · Cancel.' },
    { id: 'publish', label: 'Publish v4', model: dialogCase({ kind: 'publish', range: 'default', from: day(17), to: day(23), preview: { status: 'ready', value: PREVIEW } }), note: 'Pop:publish — the days, the changes since v3 per line, the checks with Show, what happens on the floor.' },
    { id: 'publish-done', label: 'Published', model: dialogCase({ kind: 'publish', range: 'default', from: day(17), to: day(23), preview: { status: 'ready', value: PREVIEW }, done: { ...PREVIEW.previous!, id: uid('abce', 4), number: 4, coversFrom: day(17), coversTo: day(23), effectiveFrom: at(17, 6), publishedAt: NOW } }) },
    { id: 'publish-held', label: 'Nothing changed since v3', model: base({ read: { status: 'ready', value: held } }), note: 'Publish to floor is held with the reason (focusable).' },
    { id: 'place', label: 'Place all by due date', model: dialogCase({ kind: 'place', preview: { status: 'ready', value: PLACE } }), note: 'Backward scheduling preview: each bar at its latest start, one from now and over capacity — a reason is asked before applying.' },
    { id: 'conflict', label: 'Moved by another planner', model: base({ save: { state: 'failed', refusal: { code: 'MOVED_BY', name: 'Marta Esempio', at: at(16, 9, 12) } } }), note: 'A 409 on a move: who moved it and when; the board was read again.' },
    { id: 'saving', label: 'Saving a move', model: base({ save: { state: 'saving' } }) },
    { id: 'legend', label: 'Legend', model: dialogCase({ kind: 'legend' }) },
    { id: 'versions', label: 'Published versions', model: dialogCase({ kind: 'versions', versions: { status: 'ready', value: VERSIONS } }) },
    { id: 'keys', label: 'Keyboard shortcuts', model: dialogCase({ kind: 'keys' }) },
    { id: 'read-only', label: 'Read-only (production manager)', model: base({ read: { status: 'ready', value: readOnly }, save: { state: 'idle' } }), note: 'Bars cannot be moved: the reason shows at rest and on the first drag attempt; Publish and Place are held with the missing permission in words.' },
    { id: 'offline', label: 'Offline', model: base({ offline: true, save: { state: 'idle' } }), note: 'Moves are held until the live channel returns.' },
    { id: 'empty', label: 'Nothing on the board', model: base({ read: { status: 'ready', value: empty }, save: { state: 'idle' } }), note: 'No work orders in this window; no working plan yet.' },
    { id: 'loading', label: 'Loading', model: base({ read: { status: 'loading' }, save: { state: 'idle' } }) },
    { id: 'error', label: 'Could not load', model: base({ read: { status: 'error', problem: 'failed' }, save: { state: 'idle' } }), note: 'A failed read is never drawn as an empty board.' },
    { id: 'no-permission', label: 'No permission', model: base({ read: { status: 'error', problem: 'forbidden' }, save: { state: 'idle' } }) },
    // ---- B-W2b-337 ----
    { id: 'whatif', label: 'What-if on (planner)', model: depthCase({ whatIf: { read: { status: 'ready', value: WHAT_IF } } }, { read: whatIfRead(WHAT_IF) }, { whatIf: WHAT_IF_ID }), note: 'Design sec:whatif — the banner across the board, the deltas (late orders 2 → 1 · overtime 6 h → 0 h · L1 111% → 98% …), the tried moves and the orders that move; WO-0102 tried on Line 1 and WO-0105 placed on Line 2 (before its material). Publish and Place are held while what-if is on; w turns it off.' },
    { id: 'whatif-empty', label: 'What-if just started', model: depthCase({ whatIf: { read: { status: 'ready', value: { ...WHAT_IF, moves: [], effect: { ...WHAT_IF.effect, lanes: [], orders: [] } } } } }, {}, { whatIf: WHAT_IF_ID }), note: 'No move tried yet: Apply is held with the reason.' },
    { id: 'whatif-changed', label: 'What-if: the plan changed meanwhile', model: depthCase({ whatIf: { read: { status: 'ready', value: { ...WHAT_IF, planChanged: true, conflicts: 1, moves: [{ ...WHAT_IF.moves[0]!, conflict: { code: 'SLOT_MOVED' } }, WHAT_IF.moves[1]!] } } } }, { read: whatIfRead(WHAT_IF) }, { whatIf: WHAT_IF_ID }) },
    { id: 'whatif-conflicts', label: 'Apply refused: conflicts', model: depthCase({ whatIf: { read: { status: 'ready', value: WHAT_IF } } }, { read: whatIfRead(WHAT_IF), dialog: { kind: 'whatifConflicts', conflicts: [{ index: 0, code: 'SLOT_MOVED' }] } }, { whatIf: WHAT_IF_ID }), note: 'ReviewChangesModal: the moves that clash with the working plan now; Apply the other move.' },
    { id: 'whatif-loading', label: 'What-if being read', model: depthCase({ whatIf: { read: { status: 'loading' } } }, {}, { whatIf: WHAT_IF_ID }) },
    { id: 'whatif-error', label: 'What-if could not load', model: depthCase({ whatIf: { read: { status: 'error', problem: 'failed' } } }, {}, { whatIf: WHAT_IF_ID }) },
    { id: 'material', label: 'Drop before the material', model: dialogCase({ kind: 'material', answer: { workOrder: { id: WO102.id, number: WO102.number }, materialStart: WO102.materialStart!, check: { state: 'ARRIVES', startAt: at(17, 8), inTime: false, earliestStart: at(19, 8), snapTo: at(19, 8) } } }), note: 'Material-aware drop: Snap to the earliest start with material · Keep my date · Cancel (never refused); the words from the material and its dates.' },
    { id: 'bar-pinned', label: 'Bar detail: pinned bar', model: dialogCase({ kind: 'bar', workOrderId: WO103.id, slotId: slotId(5), detail: { status: 'ready', value: { ...BAR, workOrder: WO103, slots: [SLOTS[4]!] } } }), note: 'The bar’s W2b part: its floor state, pinned by whom and when, Unpin · Pin the whole order · Move to a subcontractor.' },
    { id: 'pin-refused', label: 'Move of a pinned bar refused', model: base({ save: { state: 'failed', refusal: { code: 'PINNED' } } }), note: 'A drag of a pinned bar: the DS refuses it at once; the API’s 409 PINNED says it in our words.' },
    { id: 'subcontract', label: 'Move to a subcontractor', model: dialogCase(subcontract()), note: 'Pop:subcontract-move — approved workshops only, Laboratorio Gamma held (no valid DURC, not approved for sewing); the kit leaves the day before the start, the kit list from the bill of materials; Move and plan the kit.' },
    { id: 'subcontract-loading', label: 'Move to a subcontractor: reading', model: dialogCase(subcontract({ workshops: { status: 'loading' }, timing: null, partyId: null })) },
    { id: 'subcontract-error', label: 'Move to a subcontractor: could not load', model: dialogCase(subcontract({ workshops: { status: 'error', problem: 'failed' }, timing: null, partyId: null })) },
    { id: 'subcontract-held', label: 'Move to a subcontractor: no permission', model: depthCase({ may: { ...DEPTH.may, outsource: false, order: false } }, { dialog: subcontract() }), note: 'Held with the missing permission in words.' },
    { id: 'subcontract-done', label: 'Moved to a subcontractor', model: dialogCase(subcontract({ done: { answer: { operation: { id: WO101.operations[1]!.id, seq: 20, name: CENTRE.sew.name, version: 5, outsourced: true, subcontractOrderId: uid('5151', 1) }, workshop: { id: WORKSHOP.id, code: WORKSHOP.code, name: WORKSHOP.name }, order: { id: uid('5151', 1), number: 'SC-ESEMPIO-0001', status: 'DRAFT', kitDueAt: at(16, 8) }, orderWords: null, timing: { start: day(17), kitShipOn: day(16), kitDueAt: at(16, 8), late: false, backOn: day(20) }, warnings: [] }, stayed: null } })) },
    { id: 'print', label: 'Print day sheets', model: dialogCase(print()), note: 'Pop:print — Lines (MultiSelect), the day, the sheets’ language and which plan; the preview says what the PDF says; Open PDF opens it in a new tab.' },
    { id: 'print-working', label: 'Print the working plan', model: dialogCase(print({ plan: 'WORKING', paper: { status: 'ready', value: PAPER_WORKING } })) },
    { id: 'print-no-version', label: 'Print: no published version that day', model: dialogCase(print({ date: day(28), paper: { status: 'noVersion' } })), note: 'Held with the reason: publish first, or print the working plan.' },
    { id: 'print-loading', label: 'Print: reading the sheets', model: dialogCase(print({ paper: { status: 'loading' } })) },
    { id: 'backlog', label: 'Reschedule backlog', model: dialogCase({ kind: 'backlog', preview: { status: 'ready', value: BACKLOG } }), note: 'ReviewChangesModal: each bar from → to with why it moves; the pinned bar left in the past stays; a reason is asked because a lane goes over.' },
    { id: 'backlog-nothing', label: 'Reschedule backlog: nothing to move', model: dialogCase({ kind: 'backlog', preview: { status: 'nothing' } }) },
    { id: 'backlog-loading', label: 'Reschedule backlog: reading', model: dialogCase({ kind: 'backlog', preview: { status: 'loading' } }) },
    { id: 'export', label: 'Export board (XLSX)', model: dialogCase({ kind: 'export', job: EXPORT_JOB, problem: null }), note: 'The list frame’s export job (planning.board): its progress, then the file.' },
    { id: 'changes-all', label: 'Changes: the whole log, one planner', model: depthCase({ changes: changesState({ since: 'ALL', planner: MARTA.id, kinds: ['MOVE', 'PIN'] }) }) },
    { id: 'changes-empty', label: 'Changes: no moves since v3', model: depthCase({ changes: changesState({ read: { status: 'ready', value: { ...CHANGES, entries: [], next: null } } }) }) },
    { id: 'changes-loading', label: 'Changes being read', model: depthCase({ changes: changesState({ read: { status: 'loading' } }) }) },
    { id: 'changes-error', label: 'Changes could not load', model: depthCase({ changes: changesState({ read: { status: 'error', problem: 'failed' } }) }) },
    { id: 'undo-refused', label: 'Undo refused', model: depthCase({ changes: changesState({ error: { code: 'CHANGED_SINCE' } }) }, { save: { state: 'failed', refusal: { code: 'CHANGED_SINCE' } } }), note: 'A 409 CHANGED_SINCE on Undo, in our words.' },
    { id: 'workshops-checking', label: 'Workshops being checked', model: depthCase({ workshops: { status: 'loading' }, subcontractors: { status: 'loading' } }), note: 'While the approvals are read, a drop on the workshop lane from another lane is held with the reason.' },
  ],
})

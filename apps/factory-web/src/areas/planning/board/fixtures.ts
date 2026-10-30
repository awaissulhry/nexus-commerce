import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { BarDetail, Board, BoardLane, BoardSlot, BoardWorkOrder, PlaceByDueDate, PlanningSite, PublishedVersion, PublishPreview } from './api'
import { DEFAULT_CONTROLS, type BoardControls } from './model'
import type { BoardDialog, BoardViewModel } from './view-model'
import { BoardView } from './view/BoardView'

/**
 * SCR-122 Planning board with made-up data: an invented site ("Stabilimento Esempio"), invented lines, styles and work
 * orders, an invented planner ("Marta Esempio"). Nothing here is a real company, person, order or number. Design-only.
 * The week shown starts on Monday 16 November 2026 (today in these cases).
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
    readiness: { word: 'EXPECTED', date: day(17) },
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
  slot(1, WO101, 0, centreLane(CENTRE.cut), at(16, 8), at(16, 14), 720),
  slot(2, WO101, 1, lineLane(LINE1), at(17, 8), at(18, 16), 3600),
  slot(3, WO101, 2, centreLane(CENTRE.qc), at(19, 8), at(19, 14), 360),
  slot(4, WO102, 0, lineLane(LINE2), at(18, 8), at(18, 17), 2000, { startsLate: true }),
  slot(5, WO103, 0, lineLane(LINE1), at(18, 8), at(18, 17), 1600, { overloadReason: 'Straordinario di sabato (esempio)', updatedBy: { id: uid('3333', 2), name: 'Marta Esempio' }, updatedAt: at(16, 9, 12), version: 5 }),
  slot(6, WO105, null, { kind: 'WORKSHOP', id: WORKSHOP.id }, at(17, 8), at(20, 17), 350, { pieces: 10 }),
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
  ...over,
})

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
  ],
})

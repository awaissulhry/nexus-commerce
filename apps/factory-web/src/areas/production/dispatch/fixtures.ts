import { createElement } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { permissionCheck } from '../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER } from '../../../shell/design-data'
import { officeNavFor } from '../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../shell/office/view/OfficeShellView'
import type { DispatchBoard, DispatchCard, DispatchLine, LaneOperator, OperatorPicker, StationLane } from './api'
import { dispatchCanOf, type DispatchAddress } from './model'
import type { DispatchDialog, DispatchNotice, DispatchViewModel, Loaded } from './view-model'
import { DispatchView } from './view/DispatchView'

/**
 * Design cases of SCR-138 — Production › Dispatch (B-W2b-56; design production.dispatch). Made-up data only: an invented site
 * "STAB-N", lines L1 and L2, stations SEW-01 … QC-01, work orders WO-0142 …, invented floor names at a site whose records name
 * workers. Roles from factory-domain's templates: the floor supervisor (runs the board), the planner (looks), sales (no
 * permission). No figure stands for a person: load per line, queued minutes per station.
 */

const PREFIX = '/w/DEMO'
const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const DAY = '2026-11-16'
const AS_OF = new Date(Date.UTC(2026, 10, 16, 9, 42)).toISOString()
const SITE = { id: uid('3131', 1), code: 'STAB-N', name: 'Stabilimento Demo Nord', timeZone: 'Europe/Rome' }
const SEWING = uid('4141', 1)
const FINISH = uid('4141', 2)
const CUT = uid('4141', 3)

const operator = (n: number, name: string, level: LaneOperator['level'], over: Partial<LaneOperator> = {}): LaneOperator => ({
  assignmentId: uid('5151', n),
  version: 1,
  kind: 'STATION_OPERATOR',
  workerId: uid('5252', n),
  name,
  level,
  trainee: false,
  overridden: false,
  presence: null,
  reassign: false,
  ...over,
})

const card = (n: number, number: string, style: string, op: { seq: number; name: string; centre?: string }, pieces: number, minutes: string, over: Partial<DispatchCard> = {}): DispatchCard => ({
  id: uid('6161', n),
  key: `station:${n}|all`,
  workOrder: { id: uid('7171', n), number, rush: false, dueDate: '2026-11-20', style: { code: `MOD-${100 + n}`, name: style }, holdReason: null },
  operation: { id: uid('8181', n), seq: op.seq, name: op.name, workCentreId: op.centre ?? SEWING },
  previous: null,
  stationId: null,
  lineId: null,
  bundles: [],
  whole: true,
  pieces,
  standardMinutes: '6.5',
  minutes,
  state: 'READY',
  sequence: { rule: 'WARN', state: 'CLEAR' },
  material: { state: 'IN_STOCK', date: null },
  order: null,
  counted: true,
  movable: true,
  operators: [],
  reassign: false,
  ...over,
})

const bundles = (n: number, count: number) => Array.from({ length: count }, (_, index) => ({ id: uid('9191', n * 10 + index), code: `BN-00${4200 + n * 10 + index}`, garments: 20 }))

const station = (n: number, code: string, name: string, lineId: string | null, cards: readonly DispatchCard[], over: Partial<StationLane> = {}): StationLane => ({
  id: uid('3333', n),
  code,
  name,
  lineId,
  workCentreId: SEWING,
  operators: [],
  queuedMinutes: cards.filter((entry) => entry.counted).reduce((sum, entry) => sum + Number(entry.minutes), 0).toFixed(1),
  cards: cards.map((entry) => ({ ...entry, stationId: uid('3333', n), lineId })),
  reassign: false,
  ...over,
})

const L1 = uid('3232', 1)
const L2 = uid('3232', 2)

const load = (queued: number, available: number, over: Partial<DispatchLine['load']> = {}): DispatchLine['load'] => ({
  queuedMinutes: queued,
  availableMinutes: available,
  overMinutes: Math.max(0, queued - available),
  spareMinutes: Math.max(0, available - queued),
  source: 'PLANNED',
  people: 8,
  efficiencyPct: '85',
  absent: null,
  ...over,
})

const C142 = card(1, 'WO-0142', 'Giacca Aero', { seq: 20, name: 'Cucitura maniche' }, 80, '520.0', { bundles: bundles(1, 4), previous: { seq: 10, name: 'Taglio' }, workOrder: { id: uid('7171', 1), number: 'WO-0142', rush: true, dueDate: '2026-11-18', style: { code: 'MOD-101', name: 'Giacca Aero' }, holdReason: null } })
const C143 = card(2, 'WO-0143', 'Pantalone Strada', { seq: 30, name: 'Assemblaggio' }, 60, '390.0', { bundles: bundles(2, 3), whole: false, state: 'WAITING_FOR_PREVIOUS', previous: { seq: 20, name: 'Cucitura tasche' }, sequence: { rule: 'WARN', state: 'WARN' }, material: { state: 'ON_THE_WAY', date: '2026-11-18' } })
const C144 = card(3, 'WO-0144', 'Gilet Pista', { seq: 20, name: 'Cucitura fianchi' }, 40, '260.0', { material: { state: 'MISSING', date: null }, workOrder: { id: uid('7171', 3), number: 'WO-0144', rush: false, dueDate: '2026-11-13', style: { code: 'MOD-103', name: 'Gilet Pista' }, holdReason: null } })
const C145 = card(4, 'WO-0145', 'Tuta Corsa', { seq: 40, name: 'Controllo finale', centre: FINISH }, 30, '95.0', { bundles: bundles(4, 2) })
const NOT1 = card(5, 'WO-0146', 'Giacca Touring', { seq: 20, name: 'Cucitura maniche' }, 120, '780.0', { key: 'REST', lineId: L1, bundles: bundles(5, 6), whole: false })
const NOT2 = card(6, 'WO-0147', 'Giubbino Città', { seq: 10, name: 'Taglio', centre: CUT }, 50, '125.0', { key: 'REST', lineId: L2, whole: false })
const DRAFT = card(7, 'WO-0148', 'Giacca Aero', { seq: 20, name: 'Cucitura maniche' }, 30, '195.0', { key: 'REST', lineId: L1, whole: false, state: 'NOT_RELEASED', counted: false, movable: false, material: null, workOrder: { id: uid('7171', 7), number: 'WO-0148', rush: false, dueDate: null, style: { code: 'MOD-101', name: 'Giacca Aero' }, holdReason: null } })

const GIULIA = operator(1, 'Giulia', 'EXPERT')
const MARCO = operator(2, 'Marco', 'CAN_DO', { overridden: true })
const NINA = operator(3, 'Nina', 'LEARNING', { trainee: true })

const BOARD: DispatchBoard = {
  site: SITE,
  day: DAY,
  today: DAY,
  past: false,
  asOf: AS_OF,
  version: { number: 12 },
  rules: { sequence: 'WARN', qualification: 'WARN', namesWorkers: true },
  attendance: { open: false },
  lines: [
    {
      id: L1,
      code: 'L1',
      name: 'Linea 1 · Giacche',
      load: load(2410, 2160),
      stations: [station(1, 'SEW-01', 'Cucitura 1', L1, [C142], { operators: [GIULIA] }), station(2, 'SEW-02', 'Cucitura 2', L1, [C143, C144], { operators: [MARCO, NINA] }), station(3, 'SEW-03', 'Cucitura 3', L1, [])],
    },
    {
      id: L2,
      code: 'L2',
      name: 'Linea 2 · Pantaloni',
      load: load(95, 3240),
      stations: [station(4, 'QC-01', 'Controllo finale', L2, [C145], { workCentreId: FINISH, operators: [operator(4, 'Aldo', 'TRAINER')] })],
    },
  ],
  otherStations: [station(5, 'CUT-01', 'Taglio 1', null, [], { workCentreId: CUT })],
  notAssigned: [NOT1, NOT2, DRAFT],
  mayManage: true,
}

/** B-W2b-88: WO-0144's sides and sleeves run side by side (one parallel group) at SEW-02 and SEW-03. */
const SIDES = { ...C144, parallel: { group: 1, with: [{ seq: 30, name: 'Cucitura maniche' }] } }
const SLEEVES = card(8, 'WO-0144', 'Gilet Pista', { seq: 30, name: 'Cucitura maniche' }, 40, '240.0', { parallel: { group: 1, with: [{ seq: 20, name: 'Cucitura fianchi' }] }, material: { state: 'IN_STOCK', date: null }, workOrder: C144.workOrder })
const SIDE_BY_SIDE: DispatchBoard = {
  ...BOARD,
  lines: BOARD.lines.map((line) => (line.id !== L1 ? line : { ...line, stations: [line.stations[0]!, station(2, 'SEW-02', 'Cucitura 2', L1, [C143, SIDES], { operators: [MARCO, NINA] }), station(3, 'SEW-03', 'Cucitura 3', L1, [SLEEVES])] })),
}

const GATE_OPEN: DispatchBoard = {
  ...BOARD,
  attendance: { open: true },
  lines: BOARD.lines.map((line, index) =>
    index === 0
      ? {
          ...line,
          load: load(2410, 1890, { source: 'CLOCKED_IN', people: 7, absent: 2 }),
          stations: line.stations.map((row, at) => (at === 1 ? { ...row, reassign: true, operators: [{ ...MARCO, presence: 'NOT_IN' as const, reassign: true }, { ...NINA, presence: 'OFF' as const, reassign: true }], cards: row.cards.map((entry) => ({ ...entry, reassign: true })) } : at === 0 ? { ...row, operators: [{ ...GIULIA, presence: 'ON_BREAK' as const }] } : row)),
        }
      : { ...line, load: load(95, 3240, { people: null, absent: null }) },
  ),
}

const NO_NAMES: DispatchBoard = {
  ...BOARD,
  rules: { ...BOARD.rules, namesWorkers: false },
  lines: BOARD.lines.map((line) => ({ ...line, stations: line.stations.map((row) => ({ ...row, operators: [] })) })),
}

const LOOKING: DispatchBoard = { ...BOARD, mayManage: false }
const PAST: DispatchBoard = { ...BOARD, day: '2026-11-13', past: true, lines: BOARD.lines.map((line) => ({ ...line, load: load(line.load.queuedMinutes, 0) })) }
const LATER: DispatchBoard = { ...BOARD, day: '2026-11-17', notAssigned: [] }
const EMPTY: DispatchBoard = { ...BOARD, notAssigned: [], otherStations: [], lines: BOARD.lines.map((line) => ({ ...line, load: load(0, line.load.availableMinutes), stations: line.stations.map((row) => ({ ...row, cards: [], queuedMinutes: '0.0' })) })) }
const NO_PLAN: DispatchBoard = { ...EMPTY, version: null }
const MANY: DispatchBoard = {
  ...BOARD,
  lines: [
    ...BOARD.lines,
    {
      id: uid('3232', 3),
      code: 'L3',
      name: 'Linea 3 · Tute',
      load: load(1260, 1800),
      stations: Array.from({ length: 9 }, (_, index) => station(20 + index, `SEW-${String(11 + index).padStart(2, '0')}`, `Cucitura ${11 + index}`, uid('3232', 3), index < 4 ? [card(30 + index, `WO-0${160 + index}`, 'Tuta Corsa', { seq: 20 + index, name: 'Cucitura' }, 30, '195.0')] : [])),
    },
  ],
}

const PICKER: OperatorPicker = {
  clockedOnly: true,
  operators: [
    { workerId: uid('5252', 1), name: 'Giulia', level: 'EXPERT', trainee: false, onBreak: false, decision: 'ALLOW', overridable: false },
    { workerId: uid('5252', 3), name: 'Nina', level: 'LEARNING', trainee: true, onBreak: true, decision: 'WARN', overridable: true },
    { workerId: uid('5252', 5), name: 'Pietro', level: null, trainee: false, onBreak: false, decision: 'HOLD', overridable: false },
  ],
  complete: true,
}

const ASSIGN_TARGET = { kind: 'station' as const, stationId: uid('3333', 3), operationId: null, place: 'L1 › SEW-03' }
const assign = (over: Partial<Extract<DispatchDialog, { kind: 'assign' }>>): DispatchDialog => ({ kind: 'assign', target: ASSIGN_TARGET, picker: { status: 'ready', value: PICKER }, workerId: null, reason: '', askReason: false, problem: null, ...over })

type Role = 'floor_supervisor' | 'planner' | 'sales'

interface DispatchCase {
  readonly model: DispatchViewModel
  readonly role: Role
}

const ADDRESS: DispatchAddress = { site: null, line: null, date: null }

function model(read: Loaded<DispatchBoard>, role: Role, over: Partial<DispatchViewModel> = {}): DispatchCase {
  const permissions = templateOf(role)?.permissions ?? []
  return { role, model: { prefix: PREFIX, can: dispatchCanOf(permissions), address: ADDRESS, sites: [], read, aliases: new Map(), live: 'live', offline: false, changedAt: null, notice: null, dialog: null, reasonFor: null, busy: false, ...over } }
}

const ready = (board: DispatchBoard, over: Partial<DispatchViewModel> = {}, role: Role = 'floor_supervisor') => model({ status: 'ready', value: board }, role, over)
const notice = (value: DispatchNotice): Partial<DispatchViewModel> => ({ notice: value })

function InShell({ model: value }: { model: DispatchCase }) {
  const permissions = templateOf(value.role)?.permissions ?? []
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck(permissions)),
    path: `${PREFIX}/production/dispatch`,
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path: `${PREFIX}/production/dispatch` },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, createElement(DispatchView, { model: value.model }))
}

export const designScreen = defineDesignScreen<DispatchCase>({
  screen: 'SCR-138',
  title: 'Dispatch board (Production)',
  view: InShell,
  cases: [
    { id: 'board', label: 'The day: a line over, a line with room, Not assigned', model: ready(BOARD), note: 'Clock-in off at this site: available minutes from the planned people, nobody is said to be in or out. Moves stay in this view.' },
    { id: 'attendance', label: 'Clock-in on: who is not in, Reassign', model: ready(GATE_OPEN), note: 'Only with the ATTENDANCE gate open and only to who runs the board: a word, never why. Absent is a line count, hidden under the minimum group.' },
    { id: 'moving', label: 'A keyboard move under way', model: ready(BOARD, { moving: { cardId: NOT1.id, laneId: uid('3333', 3) } }), note: 'Space picks up, ← → choose a station, the column shows its queue after the move.' },
    { id: 'held-drop', label: 'A held drop: a station that does not do the work', model: ready(BOARD, { moving: { cardId: NOT1.id, laneId: uid('3333', 4) } }) },
    { id: 'side-by-side', label: 'W2b: two operations side by side', model: ready(SIDE_BY_SIDE), note: 'WO-0144 Op 20 on SEW-02 and Op 30 on SEW-03 are one parallel group: each card says "Side by side with Op …"; neither waits for the other.' },
    { id: 'many', label: 'Three lines, a dozen stations: the columns wrap', model: ready(MANY) },
    { id: 'line', label: 'One line chosen (?line=)', model: ready(BOARD, { address: { ...ADDRESS, line: L1 } }) },
    { id: 'no-names', label: 'A site whose records name the station', model: ready(NO_NAMES) },
    { id: 'tomorrow', label: 'A later day: All assigned ✓', model: ready(LATER) },
    { id: 'past', label: 'A day that is over: read-only', model: ready(PAST) },
    { id: 'empty', label: 'Nothing queued for this shift', model: ready(EMPTY) },
    { id: 'no-plan', label: 'Nothing published yet', model: ready(NO_PLAN) },
    { id: 'read-only', label: 'The planner looks (no manage)', model: ready(LOOKING, {}, 'planner') },
    { id: 'offline', label: 'Offline: moves held', model: ready(BOARD, { offline: true, live: 'offline' }) },
    { id: 'changed', label: 'List changed + a warning after a move', model: ready(BOARD, { changedAt: AS_OF, ...notice({ tone: 'warning', words: { key: 'notice.sequence' } }) }) },
    { id: 'moved', label: 'Bundles moved, with Undo', model: ready(BOARD, { changedAt: AS_OF, ...notice({ tone: 'success', words: { key: 'notice.movedBundles', params: { count: 3, place: 'L1 › SEW-02' } }, undo: { workOrderOperationId: NOT1.operation.id, from: 'x', to: { unplaced: true } } }) }) },
    { id: 'refused', label: 'A refused move, in words', model: ready(BOARD, notice({ tone: 'danger', words: { key: 'refusal.SEQUENCE_ORDER' } })) },
    { id: 'card', label: 'A card: facts, Move bundles, the queue', model: ready(GATE_OPEN, { dialog: { kind: 'card', cardId: C143.id } }) },
    { id: 'card-draft', label: 'A draft card: every verb held', model: ready(BOARD, { dialog: { kind: 'card', cardId: DRAFT.id } }) },
    { id: 'assign', label: 'Assign operator: people clocked in', model: ready(GATE_OPEN, { dialog: assign({}) }) },
    { id: 'assign-loading', label: 'Assign operator: reading', model: ready(GATE_OPEN, { dialog: assign({ picker: { status: 'loading' } }) }) },
    { id: 'assign-warn', label: 'Assign operator: below the level, a reason asked', model: ready(GATE_OPEN, { dialog: assign({ workerId: uid('5252', 3) }) }) },
    { id: 'assign-hold', label: 'Assign operator: held, not authorised', model: ready(GATE_OPEN, { dialog: assign({ workerId: uid('5252', 5) }) }) },
    { id: 'assign-nobody', label: 'Assign operator: nobody clocked in yet', model: ready(GATE_OPEN, { dialog: assign({ picker: { status: 'ready', value: { ...PICKER, operators: [] } } }) }) },
    { id: 'assign-everyone', label: 'Assign operator: clock-in off, everybody active', model: ready(BOARD, { dialog: assign({ picker: { status: 'ready', value: { ...PICKER, clockedOnly: false } } }) }) },
    { id: 'reassign', label: 'Reassign this work', model: ready(GATE_OPEN, { dialog: assign({ target: { kind: 'reassign', assignmentId: MARCO.assignmentId, version: 1, operationId: C143.operation.id, from: 'Marco', place: 'L1 › SEW-02' } }) }) },
    { id: 'move-bundles', label: 'Move bundles', model: ready(BOARD, { dialog: { kind: 'move', cardId: NOT1.id, picked: NOT1.bundles.slice(0, 3).map((row) => row.id), target: `station:${uid('3333', 3)}`, problem: null } }) },
    { id: 'move-refused', label: 'Move bundles: refused in words', model: ready(BOARD, { dialog: { kind: 'move', cardId: NOT1.id, picked: [NOT1.bundles[0]!.id], target: `line:${L2}`, problem: { key: 'refusal.LINE_DOES_NOT_DO' } } }) },
    { id: 'reason', label: 'Keep with a reason', model: ready(BOARD, { reasonFor: 'WO-0146' }) },
    { id: 'keys', label: 'Keyboard shortcuts', model: ready(BOARD, { dialog: { kind: 'keys' } }) },
    { id: 'loading', label: 'Loading', model: model({ status: 'loading' }, 'floor_supervisor') },
    { id: 'error', label: 'The read failed', model: model({ status: 'error', problem: 'error.read' }, 'floor_supervisor') },
    { id: 'no-permission', label: 'No permission (sales)', model: model({ status: 'loading' }, 'sales') },
  ],
})

export { BOARD as DISPATCH_BOARD, NOT1, C142, C143, DRAFT, PICKER, SIDE_BY_SIDE }

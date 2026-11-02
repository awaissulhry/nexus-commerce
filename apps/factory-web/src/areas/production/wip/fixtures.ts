import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { at, canOf, COUNTS, inShell, LIST_ROWS, PREFIX, SITE_WIP, type Role } from '../_shared/fixtures'
// B-W2a-38: the Lines section (fn-lines).
import { LINE_CARDS, LINES } from '../reports/demo/fixtures'
import type { HeatmapAnswer, HourlyAnswer, TrackedBundle } from './api'
import { targetDraft, type FloorBoardsCan } from './model'
import { FloorNowView, type FloorBoardsModel, type FloorNowModel } from './view/FloorNowView'

/**
 * SCR-073 — Floor now (design production.floor; MES-167, MES-305) with made-up data only: the tiles, every open work
 * order with its operations (waiting · done; the operation with the most waiting marked in words), the late work orders,
 * and the states (loading, error, nothing on the floor, no late work order, no permission). Roles: Owner, Production
 * manager, Team leader (the supervisor's tablet in the Office, A2 decision 7), Sales (read-only). B-W2a-38: each line at a
 * glance (Running / Waiting / No work, output against the plan, its work orders, where most pieces wait, per station only
 * "nobody signed in" and machines down: Owner F2), a line card setting the line scope, and the section's own states.
 * B-W2b-66: the tiles for stuck bundles and open help calls, Open line TV, the heat map with a cell's bundles, hour by hour
 * with the lead's reasons and "Why was 08:00–09:00 short?", Set targets, the stuck bundles, each with its states and
 * the role cases (line lead, office without the reason, no permission).
 */

// ---- B-W2b-66: made-up boards ----------------------------------------------------------------------------------------
const place = (n: number, code: string, name: string) => ({ id: `0190f0e2-0000-7000-9073-${String(n).padStart(12, '0')}`, code, name })
const site = { ...place(1, 'A1', 'Stabilimento dimostrativo'), timeZone: 'Europe/Rome' }
const words = (code: string, labelIt: string, labelEn: string, needsDetail = false) => ({ code, labelIt, labelEn, labelI18n: { it: labelIt, en: labelEn }, icon: null, colour: null, needsDetail })
const REASONS = [words('BREAKDOWN', 'Guasto macchina', 'Machine breakdown'), words('MATERIAL', 'Attesa materiale', 'Waiting for material'), words('OTHER', 'Altro', 'Other', true)]

const hour = (h: number, done: number, target: number | null, state: 'OVER' | 'RUNNING' | 'LATER', note?: { code: number; note: string | null }, calls = 0): HourlyAnswer['lines'][number]['hours'][number] => ({
  hour: h,
  label: `${String(h).padStart(2, '0')}:00–${String(h + 1).padStart(2, '0')}:00`,
  start: at(29, h - 1, 0),
  end: at(29, h, 0),
  state,
  workingMinutes: 60,
  done,
  target: target === null ? null : { id: place(100 + h, 'x', 'x').id, targetPieces: target, version: 1 },
  short: state === 'OVER' && target !== null && done < target,
  calls,
  reason: note ? { ...REASONS[note.code]!, note: note.note, at: at(29, h, 5) } : null,
})

const L1 = place(11, 'L1', 'Linea giacche')
const L2 = place(12, 'L2', 'Linea pantaloni')
const HOURLY: HourlyAnswer = {
  asOf: at(29, 9, 42),
  site,
  day: '2026-10-29',
  today: '2026-10-29',
  reasons: REASONS,
  lines: [
    {
      line: L1,
      shift: { label: 'Mattina', start: at(29, 6, 0), end: at(29, 14, 0) },
      canGiveReason: true,
      totals: { done: 65, target: 192, targetSoFar: 86, pace: 'BEHIND', paceLook: { icon: 'trending-down', tone: 'warning' }, shortHours: 2 },
      hours: [hour(8, 24, 24, 'OVER'), hour(9, 16, 24, 'OVER', { code: 0, note: 'Tagliacuci ferma 20 minuti.' }, 1), hour(10, 18, 24, 'OVER', undefined, 2), hour(11, 7, 24, 'RUNNING'), hour(12, 0, 24, 'LATER'), hour(13, 0, 24, 'LATER')],
    },
    {
      line: L2,
      shift: { label: 'Mattina', start: at(29, 6, 0), end: at(29, 14, 0) },
      canGiveReason: true,
      totals: { done: 31, target: null, targetSoFar: null, pace: 'NO_TARGET', paceLook: { icon: 'minus', tone: 'neutral' }, shortHours: 0 },
      hours: [hour(8, 10, null, 'OVER'), hour(9, 11, null, 'OVER'), hour(10, 10, null, 'OVER'), hour(11, 0, null, 'RUNNING')],
    },
  ],
}

const cell = (code: string, bundles: number, pieces: number, stuck: number, level: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH', pile = false) => ({ code, bundles, pieces, stuck, level, pile })
const HEAT: HeatmapAnswer = {
  asOf: at(29, 9, 42),
  site,
  columns: [
    { code: 'CUC-PRE', name: 'Preparazione' },
    { code: 'CUC-ASS', name: 'Cucitura assemblaggio' },
    { code: 'RIF', name: 'Rifinitura' },
    { code: 'CQ', name: 'Controllo' },
  ],
  rows: [
    { line: L1, bundles: 21, pieces: 188, stuck: 2, cells: [cell('CUC-PRE', 4, 36, 0, 'MEDIUM'), cell('CUC-ASS', 12, 108, 2, 'HIGH', true), cell('RIF', 5, 44, 0, 'LOW'), cell('CQ', 0, 0, 0, 'NONE')] },
    { line: L2, bundles: 6, pieces: 54, stuck: 0, cells: [cell('CUC-PRE', 2, 18, 0, 'LOW'), cell('CUC-ASS', 3, 27, 0, 'LOW'), cell('RIF', 1, 9, 0, 'LOW'), cell('CQ', 0, 0, 0, 'NONE')] },
    { line: null, bundles: 2, pieces: 16, stuck: 0, cells: [cell('CUC-PRE', 2, 16, 0, 'LOW'), cell('CUC-ASS', 0, 0, 0, 'NONE'), cell('RIF', 0, 0, 0, 'NONE'), cell('CQ', 0, 0, 0, 'NONE')] },
  ],
  max: 12,
  stuckLimitHours: 4,
  capped: false,
}

const op = (code: string, name: string) => ({ code, name })
const bundle = (n: number, workingHours: number, station: string | null): TrackedBundle => ({
  id: place(200 + n, 'x', 'x').id,
  code: `B-${String(1200 + n)}`,
  siteId: site.id,
  workOrder: { id: LIST_ROWS[0]!.id, number: LIST_ROWS[0]!.number },
  size: ['46', '48', '50'][n % 3]!,
  quantity: 9,
  place: 'LINE',
  next: op('CUC-ASS', 'Cucitura assemblaggio'),
  operation: op('CUC-PRE', 'Preparazione'),
  lastScan: station ? { at: at(29, 3, 10 + n), operation: op('CUC-PRE', 'Preparazione'), station: { code: station, name: `Cucitura ${station}` } } : null,
  stuck: { stuck: true, workingHours, limitHours: 4 },
})
const STUCK = [bundle(1, 6.5, 'CUC-03'), bundle(2, 4.2, 'CUC-04'), bundle(3, 4, null)]

const ALL_CAN: FloorBoardsCan = { boards: true, targets: true, bundles: true, calls: true }
const CAN_OF: Readonly<Record<Role, FloorBoardsCan>> = {
  owner: ALL_CAN,
  manager: ALL_CAN,
  teamLeader: { boards: true, targets: false, bundles: false, calls: true },
  sales: { boards: true, targets: false, bundles: false, calls: false },
}

const boards = (role: Role, over: Partial<FloorBoardsModel> = {}): FloorBoardsModel => ({
  can: CAN_OF[role],
  hourly: { value: [HOURLY], problem: null },
  heat: { value: [HEAT], problem: null },
  stuck: { value: STUCK, problem: null },
  stuckCapped: false,
  tiles: { stuck: 3, stuckLimitHours: 4 },
  openCalls: 2,
  ...over,
})

const noReason: HourlyAnswer = { ...HOURLY, lines: HOURLY.lines.map((line) => ({ ...line, canGiveReason: false })) }
const pickCell = { siteId: site.id, lineId: L1.id, lineLabel: 'L1', code: 'CUC-ASS', operation: 'Cucitura assemblaggio' }
const TARGET_ROWS = targetDraft({
  line: L1,
  site,
  day: '2026-10-29',
  today: '2026-10-29',
  past: false,
  total: 96,
  canSet: true,
  hours: [8, 9, 10, 11].map((h) => ({ hour: h, label: `${String(h).padStart(2, '0')}:00–${String(h + 1).padStart(2, '0')}:00`, workingMinutes: 60, target: { id: place(300 + h, 'x', 'x').id, targetPieces: 24, version: 1 }, reasonGiven: h === 9 })),
})

interface FloorCase {
  role: Role
  floor: FloorNowModel
}

const late = LIST_ROWS.filter((row) => (row.daysLate ?? 0) > 0)
const floor = (role: Role, over: Partial<FloorNowModel> = {}): FloorCase => ({
  role,
  floor: { prefix: PREFIX, can: canOf(role), wip: { value: SITE_WIP, problem: null }, counts: COUNTS, late: { items: late, problem: null }, asOf: at(29, 9, 42), live: 'live', lines: { value: LINES, problem: null }, lineScope: null, boards: boards(role), ...over },
})

function FloorDesign({ model }: { model: FloorCase }) {
  return inShell('/production/floor', createElement(FloorNowView, { model: model.floor }), model.role)
}

export const designScreen = defineDesignScreen<FloorCase>({
  screen: 'SCR-073',
  title: 'Floor now (Production)',
  view: FloorDesign,
  cases: [
    { id: 'floor', label: 'Production manager: the floor at a glance, live', model: floor('manager'), note: 'An operation opens the bundles waiting there (the work order’s Bundles tab).' },
    { id: 'owner', label: 'Owner', model: floor('owner') },
    { id: 'team-leader', label: 'Team leader (the supervisor’s tablet in the Office)', model: floor('teamLeader') },
    { id: 'sales', label: 'Sales (read-only)', model: floor('sales') },
    { id: 'no-late', label: 'No late work order', model: floor('manager', { late: { items: [], problem: null }, counts: { ...COUNTS, late: 0 } }) },
    { id: 'empty', label: 'Nothing on the floor right now', model: floor('manager', { wip: { value: { workOrders: [] }, problem: null }, late: { items: [], problem: null }, counts: { draft: 2, released: 0, inProgress: 0, completed: 0, open: 2, late: 0 } }) },
    { id: 'loading', label: 'Loading', model: floor('manager', { wip: { value: null, problem: null }, late: { items: null, problem: null }, counts: null, asOf: null, live: 'connecting' }) },
    { id: 'error', label: 'The read failed: in words, with Try again', model: floor('manager', { wip: { value: null, problem: 'error.offline' }, late: { items: null, problem: 'error.offline' }, counts: null, live: 'offline' }) },
    { id: 'no-permission', label: 'No permission (workorders.view): the API refused the read', model: floor('sales', { wip: { value: null, problem: 'error.forbidden' }, late: { items: null, problem: 'error.forbidden' }, counts: null, lines: { value: null, problem: 'error.forbidden' } }) },
    { id: 'line-scope', label: 'Lines: L1 picked — only its work orders below ([ and ] step through)', model: floor('manager', { lineScope: LINE_CARDS[0]!.id }), note: 'The picked card is pressed; All lines clears the scope.' },
    { id: 'lines-loading', label: 'Lines: still being read', model: floor('manager', { lines: { value: null, problem: null } }) },
    { id: 'lines-error', label: 'Lines: the read failed, with Try again', model: floor('manager', { lines: { value: null, problem: 'error.offline' } }) },
    { id: 'lines-none', label: 'Lines: no line at the sites', model: floor('manager', { lines: { value: { ...LINES, lines: [] }, problem: null } }) },
    // B-W2b-66.
    { id: 'reason-open', label: 'The lead: “Why was 10:00–11:00 short?”', model: floor('teamLeader', { boards: boards('teamLeader', { openReason: '10:00–11:00' }) }), note: 'Reason code + note, Save reason held until a code is chosen; Esc closes.' },
    { id: 'reason-no-permission', label: 'Hour by hour without the reason (the planner reads, the lead writes)', model: floor('sales', { boards: boards('sales', { hourly: { value: [noReason], problem: null } }) }) },
    { id: 'targets', label: 'Set targets: one row per hour, an hour with a reason keeps its target', model: floor('manager', { boards: boards('manager', { targets: { line: L1, rows: TARGET_ROWS, problem: null } }) }) },
    { id: 'targets-loading', label: 'Set targets: still being read', model: floor('manager', { boards: boards('manager', { targets: { line: L1, rows: null, problem: null } }) }) },
    { id: 'targets-error', label: 'Set targets: the read failed', model: floor('manager', { boards: boards('manager', { targets: { line: L1, rows: null, problem: 'error.offline' } }) }) },
    { id: 'hourly-loading', label: 'Hour by hour: still being read', model: floor('manager', { boards: boards('manager', { hourly: { value: null, problem: null } }) }) },
    { id: 'hourly-error', label: 'Hour by hour: the read failed, with Try again', model: floor('manager', { boards: boards('manager', { hourly: { value: null, problem: 'error.offline' } }) }) },
    { id: 'hourly-none', label: 'Hour by hour: no line at the site', model: floor('manager', { boards: boards('manager', { hourly: { value: [{ ...HOURLY, lines: [] }], problem: null } }) }) },
    { id: 'heat-cell', label: 'Heat map: the bundles behind a cell', model: floor('manager', { boards: boards('manager', { cell: { pick: pickCell, bundles: STUCK, problem: null } }) }), note: 'Esc closes and the focus returns to the cell.' },
    { id: 'heat-cell-loading', label: 'Heat map: a cell’s bundles being read', model: floor('manager', { boards: boards('manager', { cell: { pick: pickCell, bundles: null, problem: null } }) }) },
    { id: 'heat-empty', label: 'Heat map: nothing waiting', model: floor('manager', { boards: boards('manager', { heat: { value: [{ ...HEAT, max: 0 }], problem: null } }) }) },
    { id: 'heat-error', label: 'Heat map: the read failed, with Try again', model: floor('manager', { boards: boards('manager', { heat: { value: null, problem: 'error.offline' } }) }) },
    { id: 'stuck-none', label: 'Stuck bundles: None ✓', model: floor('manager', { boards: boards('manager', { stuck: { value: [], problem: null } }) }) },
    { id: 'stuck-error', label: 'Stuck bundles: the read failed', model: floor('manager', { boards: boards('manager', { stuck: { value: null, problem: 'error.offline' } }) }) },
    { id: 'no-boards', label: 'No permission for the boards: the sections are not drawn', model: floor('sales', { boards: boards('sales', { can: { boards: false, targets: false, bundles: false, calls: false } }) }) },
  ],
})

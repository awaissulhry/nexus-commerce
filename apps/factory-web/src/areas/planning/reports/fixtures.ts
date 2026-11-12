import { createElement } from 'react'
import { defaultSectionLayout } from '@nexus/ui/patterns'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { DEMO_COMPANIES, DEMO_SITES, rolePermissions } from '../../../shell/design-data'
import { scopeOf } from '../../../shell/scope/scope-model'
import { inShell, PREFIX, uid } from '../../quality/_shared/fixtures'
import type { Adherence, AdherenceFigures, AdherenceRows, Cover, CoverRow, Utilisation, UtilisationCell, UtilisationLane, UtilisationRows } from './api'
import { reportsAddressOf, reportsCan, sectionSpecs } from './model'
import { ReportsView, type Read, type ReportsModel } from './view/ReportsView'
import { coverRowId } from './view/types'

/**
 * SCR-254 — Planning reports with made-up lines, work orders, materials and figures only ("Demo" names, DEMO- numbers, invented
 * minutes and quantities): November so far with its schedule adherence (two lines and a work order on no line), the utilisation
 * trend with four weeks ahead (the plant, a line, two work centres, a workshop), the material cover (short now, running out, below
 * safety stock, covered); a line picked, a lane picked, no load ahead, the work orders behind a bar and behind a point (and while
 * read, failed), materials selected, Draft PO held for a planner without the purchasing right, each panel's states (loading, one
 * failed while the others stand, nothing finished, no load, no demand), All sites in the top bar, Arrange, half widths, the keys,
 * offline, no right, no site.
 */

const SITE = { id: DEMO_SITES[0].id, companyId: DEMO_COMPANIES[0].id, code: 'DN', name: DEMO_SITES[0].name, timeZone: 'Europe/Rome' }
const FROM = '2026-11-01'
const TO = '2026-11-12'
export const NOW = '2026-11-12T07:42:00.000Z'
const head = { site: SITE, from: FROM, to: TO, today: TO, asOf: NOW }
const SCOPE_ONE = scopeOf({ company: DEMO_COMPANIES[0], sites: DEMO_SITES, chosen: SITE.id })
const SCOPE_ALL = scopeOf({ company: DEMO_COMPANIES[0], sites: DEMO_SITES, chosen: null })

const L1 = { id: uid('3491', 1), code: 'L1', name: 'Linea Demo 1' }
const L2 = { id: uid('3491', 2), code: 'L2', name: 'Linea Demo 2' }
const CUT = uid('3492', 1)
const QC = uid('3492', 2)
const WORKSHOP = uid('3493', 1)

const WEEKS = [
  { key: '2026-W44', from: '2026-11-01', to: '2026-11-01' },
  { key: '2026-W45', from: '2026-11-02', to: '2026-11-08' },
  { key: '2026-W46', from: '2026-11-09', to: '2026-11-12' },
]

const fig = (onTime: number, late: number, notPlanned = 0, meanFinish: string | null = null, startedLate = 0): AdherenceFigures => {
  const planned = onTime + late
  return {
    finished: planned + notPlanned,
    planned,
    onTime,
    late,
    notPlanned,
    onTimePct: planned > 0 ? ((onTime / planned) * 100).toFixed(1) : null,
    startedLate,
    meanFinishDays: planned > 0 ? (meanFinish ?? '0.0') : null,
    meanStartDays: planned > 0 ? '0.5' : null,
  }
}
const NONE = fig(0, 0)

export const ADHERENCE: Adherence = {
  ...head,
  weeks: [
    { ...WEEKS[0]!, figures: NONE },
    { ...WEEKS[1]!, figures: fig(5, 2, 1, '0.6', 2) },
    { ...WEEKS[2]!, figures: fig(3, 1, 0, '0.3', 1) },
  ],
  lines: [
    {
      line: L1,
      figures: fig(5, 1, 0, '0.2', 1),
      weeks: [
        { key: '2026-W44', figures: NONE },
        { key: '2026-W45', figures: fig(3, 1, 0, '0.3', 1) },
        { key: '2026-W46', figures: fig(2, 0, 0, '-0.5') },
      ],
    },
    {
      line: L2,
      figures: fig(3, 2, 0, '0.8', 2),
      weeks: [
        { key: '2026-W44', figures: NONE },
        { key: '2026-W45', figures: fig(2, 1, 0, '0.7', 1) },
        { key: '2026-W46', figures: fig(1, 1, 0, '1.0', 1) },
      ],
    },
    { line: null, figures: fig(0, 0, 1), weeks: [{ key: '2026-W44', figures: NONE }, { key: '2026-W45', figures: fig(0, 0, 1) }, { key: '2026-W46', figures: NONE }] },
  ],
  all: fig(8, 3, 1, '0.5', 3),
  complete: true,
}

const UWEEKS: Utilisation['weeks'] = [
  { key: '2026-W44', from: '2026-11-01', to: '2026-11-01', actual: true, ahead: false, actualDays: { from: '2026-11-01', to: '2026-11-01' } },
  { key: '2026-W45', from: '2026-11-02', to: '2026-11-08', actual: true, ahead: false, actualDays: { from: '2026-11-02', to: '2026-11-08' } },
  { key: '2026-W46', from: '2026-11-09', to: '2026-11-15', actual: true, ahead: true, actualDays: { from: '2026-11-09', to: '2026-11-12' } },
  { key: '2026-W47', from: '2026-11-16', to: '2026-11-22', actual: false, ahead: true, actualDays: null },
  { key: '2026-W48', from: '2026-11-23', to: '2026-11-29', actual: false, ahead: true, actualDays: null },
  { key: '2026-W49', from: '2026-11-30', to: '2026-12-06', actual: false, ahead: true, actualDays: null },
]
const band = (pct: string | null): UtilisationCell['band'] => (pct === null ? 'UNKNOWN' : Number(pct) > 100 ? 'OVER' : Number(pct) >= 90 ? 'HIGH' : Number(pct) >= 70 ? 'MEDIUM' : 'LOW')
const ucell = (key: string, used: [string, string] | null, load: [string, string] | null): UtilisationCell => {
  const utilisationPct = used && Number(used[1]) > 0 ? ((Number(used[0]) / Number(used[1])) * 100).toFixed(1) : null
  const loadPct = load ? ((Number(load[0]) / Number(load[1])) * 100).toFixed(1) : null
  return { key, earnedMinutes: used?.[0] ?? null, availableMinutes: used?.[1] ?? null, utilisationPct, booked: load?.[0] ?? null, capacity: load?.[1] ?? null, loadPct, band: band(loadPct) }
}
const lane = (kind: UtilisationLane['kind'], id: string | null, code: string | null, name: string | null, cells: UtilisationCell[], extra: Partial<UtilisationLane> = {}): UtilisationLane => ({ kind, id, code, name, workCentreKind: null, unit: 'MINUTES', plannedEfficiencyPct: null, cells, ...extra })

export const UTILISATION: Utilisation = {
  ...head,
  weeks: UWEEKS,
  lanes: [
    lane('PLANT', null, null, null, [
      ucell('2026-W44', ['0.0', '0.0'], null),
      ucell('2026-W45', ['14820.0', '22800.0'], null),
      ucell('2026-W46', ['10140.0', '18240.0'], ['21400.0', '23500.0']),
      ucell('2026-W47', null, ['24900.0', '23500.0']),
      ucell('2026-W48', null, ['16300.0', '23500.0']),
      ucell('2026-W49', null, ['7800.0', '23500.0']),
    ]),
    lane(
      'LINE',
      L1.id,
      L1.code,
      L1.name,
      [
        ucell('2026-W44', ['0.0', '0.0'], null),
        ucell('2026-W45', ['11040.0', '15600.0'], null),
        ucell('2026-W46', ['7560.0', '12480.0'], ['15100.0', '16000.0']),
        ucell('2026-W47', null, ['17800.0', '16000.0']),
        ucell('2026-W48', null, ['11200.0', '16000.0']),
        ucell('2026-W49', null, ['5200.0', '16000.0']),
      ],
      { plannedEfficiencyPct: '85.00' },
    ),
    lane(
      'WORK_CENTRE',
      CUT,
      'CUT',
      'Taglio Demo',
      [
        ucell('2026-W44', ['0.0', '0.0'], null),
        ucell('2026-W45', ['2380.0', '4800.0'], null),
        ucell('2026-W46', ['1620.0', '3840.0'], ['4100.0', '4300.0']),
        ucell('2026-W47', null, ['4800.0', '4300.0']),
        ucell('2026-W48', null, ['3100.0', '4300.0']),
        ucell('2026-W49', null, ['1600.0', '4300.0']),
      ],
      { workCentreKind: 'CUTTING', plannedEfficiencyPct: '90.00' },
    ),
    lane(
      'WORK_CENTRE',
      QC,
      'QC',
      'Controllo Demo',
      [
        ucell('2026-W44', ['0.0', '0.0'], null),
        ucell('2026-W45', ['1400.0', '2400.0'], null),
        ucell('2026-W46', ['960.0', '1920.0'], ['2200.0', '3200.0']),
        ucell('2026-W47', null, ['2300.0', '3200.0']),
        ucell('2026-W48', null, ['2000.0', '3200.0']),
        ucell('2026-W49', null, ['1000.0', '3200.0']),
      ],
      { workCentreKind: 'INSPECTION', plannedEfficiencyPct: '100.00' },
    ),
    lane(
      'WORKSHOP',
      WORKSHOP,
      'DEMO-TER-01',
      'Laboratorio Demo Esterno',
      [ucell('2026-W44', null, null), ucell('2026-W45', null, null), ucell('2026-W46', null, ['1800.0', '2400.0']), ucell('2026-W47', null, ['2600.0', '2400.0']), ucell('2026-W48', null, ['900.0', '2400.0']), ucell('2026-W49', null, ['0.0', '2400.0'])],
      { workCentreKind: 'SEWING', unit: 'MINUTES' },
    ),
  ],
}

const crow = (n: number, code: string, name: string, over: Partial<CoverRow>): CoverRow => ({
  item: { id: uid('3494', n), code, name, kind: 'LEATHER', baseUom: 'FT2' },
  colour: null,
  action: 'BUY',
  onHand: '120.0000',
  safetyStock: null,
  demand: '0.0000',
  receipts: '0.0000',
  projectedEnd: '120.0000',
  stockOutOn: null,
  belowSafetyOn: null,
  daysOfCover: null,
  state: 'COVERED',
  firstShort: null,
  uncovered: '0.0000',
  openPurchases: { orders: 0, lines: 0, quantity: '0.0000', next: null },
  ...over,
})

export const COVER_ROWS: CoverRow[] = [
  crow(1, 'DEMO-PEL-NERO', 'Pelle bovina Demo nera', { colour: { id: uid('3495', 1), code: 'NER', name: 'Nero' }, onHand: '51.8000', demand: '553.2800', receipts: '315.0000', projectedEnd: '-186.4800', stockOutOn: TO, daysOfCover: 0, state: 'SHORT_NOW', firstShort: 'PAST', uncovered: '186.4800', openPurchases: { orders: 1, lines: 1, quantity: '315.0000', next: { day: '2026-11-24', purchaseOrderId: uid('3496', 1), number: 'DEMO-PO-0101', quantity: '315.0000' } } }),
  crow(2, 'DEMO-FOD-RETE', 'Fodera Demo in rete', { item: { id: uid('3494', 2), code: 'DEMO-FOD-RETE', name: 'Fodera Demo in rete', kind: 'TEXTILE', baseUom: 'M' }, onHand: '40.0000', demand: '62.5000', receipts: '0.0000', projectedEnd: '-22.5000', stockOutOn: '2026-11-19', daysOfCover: 7, state: 'STOCK_OUT', firstShort: '2026-W47', uncovered: '22.5000' }),
  crow(3, 'DEMO-PROT-SPALLA', 'Protezione Demo spalla', { item: { id: uid('3494', 3), code: 'DEMO-PROT-SPALLA', name: 'Protezione Demo spalla', kind: 'PROTECTOR', baseUom: 'PCS' }, action: 'MAKE', onHand: '30.0000', safetyStock: '20.0000', demand: '16.0000', receipts: '0.0000', projectedEnd: '14.0000', belowSafetyOn: '2026-11-26', state: 'BELOW_SAFETY' }),
  crow(4, 'DEMO-ZIP-60', 'Cerniera Demo 60 cm', { item: { id: uid('3494', 4), code: 'DEMO-ZIP-60', name: 'Cerniera Demo 60 cm', kind: 'HARDWARE', baseUom: 'PCS' }, onHand: '400.0000', demand: '38.0000', receipts: '200.0000', projectedEnd: '562.0000', openPurchases: { orders: 1, lines: 1, quantity: '200.0000', next: { day: '2026-11-20', purchaseOrderId: uid('3496', 2), number: 'DEMO-PO-0102', quantity: '200.0000' } } }),
]
export const COVER: Cover = {
  site: SITE,
  today: TO,
  asOf: NOW,
  horizon: { from: '2026-11-09', to: '2027-02-07', weeks: 13, days: 91 },
  counts: { materials: 4, shortNow: 1, stockOut: 1, belowSafety: 1, covered: 1 },
  rows: COVER_ROWS,
  more: 0,
}

const DRILL_ADHERENCE: AdherenceRows = {
  ...head,
  line: L1,
  week: WEEKS[1]!,
  figures: fig(3, 1, 0, '0.3', 1),
  rows: [
    { workOrder: { id: uid('3497', 1), number: 'DEMO-WO-0412', kind: 'PRODUCTION', status: 'COMPLETED', dueDate: '2026-11-10', rush: false, style: { id: uid('3498', 1), code: 'DEMO-GIA-01', name: 'Giacca Demo Strada' } }, line: L1, planned: { source: 'PUBLISHED', number: 12, startAt: '2026-11-02T07:00:00.000Z', endAt: '2026-11-04T16:00:00.000Z' }, actual: { startAt: '2026-11-03T08:10:00.000Z', finishAt: '2026-11-06T14:20:00.000Z' }, state: 'LATE', startDays: 1, finishDays: 2 },
    { workOrder: { id: uid('3497', 2), number: 'DEMO-WO-0415', kind: 'PRODUCTION', status: 'CLOSED', dueDate: '2026-11-12', rush: true, style: { id: uid('3498', 2), code: 'DEMO-PAN-02', name: 'Pantalone Demo Pista' } }, line: L1, planned: { source: 'PUBLISHED', number: 12, startAt: '2026-11-04T07:00:00.000Z', endAt: '2026-11-06T16:00:00.000Z' }, actual: { startAt: '2026-11-04T07:30:00.000Z', finishAt: '2026-11-06T11:00:00.000Z' }, state: 'ON_TIME', startDays: 0, finishDays: 0 },
    { workOrder: { id: uid('3497', 3), number: 'DEMO-WO-0419', kind: 'PRODUCTION', status: 'COMPLETED', dueDate: '2026-11-13', rush: false, style: { id: uid('3498', 1), code: 'DEMO-GIA-01', name: 'Giacca Demo Strada' } }, line: L1, planned: { source: 'WORKING', number: null, startAt: '2026-11-05T07:00:00.000Z', endAt: '2026-11-07T12:00:00.000Z' }, actual: { startAt: '2026-11-05T07:05:00.000Z', finishAt: '2026-11-06T17:00:00.000Z' }, state: 'ON_TIME', startDays: 0, finishDays: -1 },
    { workOrder: { id: uid('3497', 4), number: 'DEMO-WO-0421', kind: 'PRODUCTION', status: 'COMPLETED', dueDate: '2026-11-14', rush: false, style: { id: uid('3498', 3), code: 'DEMO-GUA-03', name: 'Guanto Demo Estivo' } }, line: L1, planned: { source: 'PUBLISHED', number: 12, startAt: '2026-11-06T07:00:00.000Z', endAt: '2026-11-06T16:00:00.000Z' }, actual: { startAt: '2026-11-06T09:00:00.000Z', finishAt: '2026-11-06T15:40:00.000Z' }, state: 'ON_TIME', startDays: 0, finishDays: 0 },
  ],
  more: 0,
}
const wo = (n: number, number: string) => ({ id: uid('3497', n), number, status: 'IN_PROGRESS', style: { id: uid('3498', 1), code: 'DEMO-GIA-01', name: 'Giacca Demo Strada' } })
const DRILL_UTILISATION: UtilisationRows = {
  ...head,
  lane: { kind: 'LINE', id: L1.id, code: L1.code, name: L1.name },
  week: UWEEKS[2]!,
  earned: {
    minutes: '7560.0',
    rows: [
      { workOrder: wo(5, 'DEMO-WO-0430'), operation: { id: uid('3499', 1), seq: 20, code: 'DEMO-CUC', name: 'Cucitura corpo' }, lane: { kind: 'LINE', code: 'L1' }, garments: 48, minutes: '4632.0' },
      { workOrder: wo(6, 'DEMO-WO-0431'), operation: { id: uid('3499', 2), seq: 20, code: 'DEMO-CUC', name: 'Cucitura corpo' }, lane: { kind: 'LINE', code: 'L1' }, garments: 30, minutes: '2928.0' },
    ],
    more: 0,
  },
  booked: {
    minutes: '15100.0',
    rows: [
      { workOrder: wo(6, 'DEMO-WO-0431'), operation: { id: uid('3499', 2), seq: 20, code: 'DEMO-CUC', name: 'Cucitura corpo' }, lane: { kind: 'LINE', code: 'L1' }, pieces: 70, minutes: '6755.0', placedBy: 'SLOT' },
      { workOrder: wo(7, 'DEMO-WO-0433'), operation: { id: uid('3499', 3), seq: 20, code: 'DEMO-CUC', name: 'Cucitura corpo' }, lane: { kind: 'LINE', code: 'L1' }, pieces: 86, minutes: '8345.0', placedBy: 'DUE_DATE' },
    ],
    more: 0,
  },
}

const ready = <T>(value: T): Read<T> => ({ status: 'ready', value })
const loading = <T>(): Read<T> => ({ status: 'loading' })
const failed = <T>(): Read<T> => ({ status: 'error', problem: 'problem.read' })

export const PLANNER = [...rolePermissions('planner'), 'planning.reports.view', 'planning.view', 'purchasing.manage']
export const PLANNER_NO_BUY = rolePermissions('planner').filter((name) => name !== 'purchasing.manage')
const specs = sectionSpecs((id) => id)

function model(over: Partial<ReportsModel> = {}, permissions: readonly string[] = PLANNER, search = ''): ReportsModel {
  return {
    prefix: PREFIX,
    can: reportsCan(permissions),
    address: reportsAddressOf(new URLSearchParams(search)),
    scope: SCOPE_ONE,
    site: { id: SITE.id, name: SITE.name },
    range: { from: FROM, to: TO },
    today: TO,
    adherence: ready(ADHERENCE),
    utilisation: ready(UTILISATION),
    cover: ready(COVER),
    adherenceLine: null,
    live: 'live',
    asOf: NOW,
    layout: defaultSectionLayout(specs),
    specs,
    arranging: false,
    drill: null,
    selected: [],
    ...over,
  }
}

function ReportsDesign({ model: value }: { model: ReportsModel }) {
  return inShell('/planning/reports', createElement(ReportsView, { model: value }), 'owner')
}

const halfLayout = { order: ['adherence', 'utilisation', 'cover'], widths: { adherence: 'half' as const, utilisation: 'half' as const, cover: 'full' as const } }
const emptyAdherence: Adherence = { ...ADHERENCE, weeks: ADHERENCE.weeks.map((week) => ({ ...week, figures: NONE })), lines: [], all: NONE }
const emptyUtilisation: Utilisation = { ...UTILISATION, lanes: UTILISATION.lanes.map((entry) => ({ ...entry, cells: entry.cells.map((cell) => ({ ...cell, earnedMinutes: cell.earnedMinutes === null ? null : '0.0', booked: cell.booked === null ? null : '0.0', utilisationPct: cell.utilisationPct === null ? null : '0.0', loadPct: cell.loadPct === null ? null : '0.0', band: cell.loadPct === null ? cell.band : 'LOW' })) })) }
const noAhead: Utilisation = { ...UTILISATION, weeks: UWEEKS.slice(0, 3).map((week) => ({ ...week, ahead: false, to: week.actualDays!.to })), lanes: UTILISATION.lanes.filter((entry) => entry.kind !== 'WORKSHOP').map((entry) => ({ ...entry, cells: entry.cells.slice(0, 3).map((cell) => ({ ...cell, booked: null, capacity: null, loadPct: null, band: 'UNKNOWN' as const })) })) }

export const designScreen = defineDesignScreen<ReportsModel>({
  screen: 'SCR-254',
  title: 'Planning reports (Planning)',
  view: ReportsDesign,
  holdsPage: true,
  cases: [
    { id: 'report', label: 'November so far (planner)', model: model(), note: 'Schedule adherence by week and line, the utilisation trend with four weeks of load ahead, the materials by how soon they run out.' },
    { id: 'line', label: 'Adherence of one line', model: model({ adherenceLine: L2.id }) },
    { id: 'lane', label: 'Utilisation of line L1 (its planned efficiency beside it)', model: model({}, PLANNER, `lane=LINE:${L1.id}`) },
    { id: 'workshop', label: 'Utilisation of a workshop (its weeks open on Capacity & load)', model: model({}, PLANNER, `lane=WORKSHOP:${WORKSHOP}:SEWING`) },
    { id: 'no-ahead', label: 'No load ahead', model: model({ utilisation: ready(noAhead) }, PLANNER, 'ahead=0') },
    { id: 'drill', label: 'Work orders behind a bar (L1, week 45)', model: model({ drill: { target: { section: 'adherence', lineKey: L1.id, week: '2026-W45' }, read: ready(DRILL_ADHERENCE) } }), note: 'Each with the plan it is measured against (a published version or the working plan) and what happened; J / K open the next and previous week.' },
    { id: 'drill-point', label: 'Work orders behind a point (L1, this week)', model: model({ drill: { target: { section: 'utilisation', laneKey: `LINE:${L1.id}`, week: '2026-W46' }, read: ready(DRILL_UTILISATION) } }, PLANNER, `lane=LINE:${L1.id}`) },
    { id: 'drill-loading', label: 'Work orders behind a bar: reading', model: model({ drill: { target: { section: 'adherence', lineKey: null, week: '2026-W46' }, read: loading<AdherenceRows>() } }) },
    { id: 'drill-error', label: 'Work orders behind a bar: failed', model: model({ drill: { target: { section: 'adherence', lineKey: null, week: null }, read: failed<AdherenceRows>() } }) },
    { id: 'selected', label: 'Materials selected: Export 2 (CSV)', model: model({ selected: [coverRowId(COVER_ROWS[0]!), coverRowId(COVER_ROWS[1]!)] }) },
    { id: 'draft-held', label: 'Draft PO held (no purchasing right)', model: model({}, PLANNER_NO_BUY), note: 'The ⋯ menu holds Draft PO and says why; the note under the grid says it too.' },
    { id: 'loading', label: 'Loading (skeletons with the axes named)', model: model({ adherence: loading(), utilisation: loading(), cover: loading(), asOf: null }) },
    { id: 'error', label: 'One panel failed, the others stand', model: model({ utilisation: failed() }), note: 'The panel says what failed and Try again; a failed read is never drawn as empty.' },
    { id: 'empty', label: 'Nothing finished, no load, no demand', model: model({ adherence: ready(emptyAdherence), utilisation: ready(emptyUtilisation), cover: ready({ ...COVER, rows: [], counts: { materials: 0, shortNow: 0, stockOut: 0, belowSafety: 0, covered: 0 } }) }) },
    { id: 'all-sites', label: 'All sites in the top bar (the first site shown)', model: model({ scope: SCOPE_ALL }) },
    { id: 'arrange', label: 'Arrange panels', model: model({ arranging: true }) },
    { id: 'half-widths', label: 'Two panels at half width', model: model({ layout: halfLayout }) },
    { id: 'keys', label: 'Keyboard shortcuts', model: model({ keysOpen: true }) },
    { id: 'offline', label: 'Offline (live off)', model: model({ live: 'offline' }) },
    { id: 'buyer', label: 'Buyer (Draft PO opens What to buy & make)', model: model({}, rolePermissions('buyer')) },
    { id: 'no-site', label: 'Planning not in the role', model: model({}, ['home.view', 'planning.reports.view']), note: 'The reports read a site’s plan: without planning.view the page says so.' },
    { id: 'no-permission', label: 'No right (sales)', model: model({}, rolePermissions('sales')) },
  ],
})

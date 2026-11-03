import { createElement } from 'react'
import { defaultSectionLayout } from '@nexus/ui/patterns'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { DEMO_COMPANIES } from '../../../shell/design-data'
import { scopeOf } from '../../../shell/scope/scope-model'
import { inShell, PREFIX, ROLE_PERMISSIONS, uid, type RoleCase } from '../_shared/fixtures'
import type { Compare, Dimension, Incoming, Kpis, Rate, Trend, TrendWeek } from './api'
import { reportsAddressOf, reportsCan, sectionSpecs } from './model'
import { ReportsView, type Read, type ReportsModel } from './view/ReportsView'

/**
 * SCR-147 — Quality reports with made-up lines, operations, suppliers and styles only (invented numbers; no person anywhere,
 * by design): the owner's whole report, each panel's states (loading as skeletons, a failed panel while the others stay, an
 * empty period said "—"), what the minimum group hides, the four comparisons, the roles (floor supervisor: in-process only;
 * buyer: incoming only; no right), Arrange, the keys, a week's pop-over, offline, compare off, one line's trend.
 */

const SITE_N = { id: uid('3801', 1), code: 'STAB-N', name: 'Stabilimento Nord' }
const SITE_S = { id: uid('3801', 2), code: 'STAB-S', name: 'Stabilimento Sud' }
const SCOPE_ONE = scopeOf({ company: DEMO_COMPANIES[0], sites: [SITE_N, SITE_S], chosen: SITE_N.id })
const SCOPE_ALL = scopeOf({ company: DEMO_COMPANIES[0], sites: [SITE_N, SITE_S], chosen: null })
const LINE_A = { id: uid('3802', 1), code: 'L-A', name: 'Linea giacche' }
const LINE_B = { id: uid('3802', 2), code: 'L-B', name: 'Linea pantaloni' }
const LINE_C = { id: uid('3802', 3), code: 'L-C', name: 'Linea guanti' }
const FROM = '2026-10-05'
const TO = '2026-11-03'
const NOW = '2026-11-03T09:42:00.000Z'
const head = { site: { ...SITE_N, timeZone: 'Europe/Rome' }, sites: [SITE_N, SITE_S], from: FROM, to: TO, today: TO, asOf: NOW, minimumGroupSize: 3 }
const SIGHT_ALL = { inprocess: true, inspections: true, ncr: true, capa: true, holds: true, incoming: true, lots: true }
const SIGHT_NONE = { inprocess: false, inspections: false, ncr: false, capa: false, holds: false, incoming: false, lots: false }

const WEEKS = [
  { week: '2026-W41', from: '2026-10-05', to: '2026-10-11' },
  { week: '2026-W42', from: '2026-10-12', to: '2026-10-18' },
  { week: '2026-W43', from: '2026-10-19', to: '2026-10-25' },
  { week: '2026-W44', from: '2026-10-26', to: '2026-11-01' },
  { week: '2026-W45', from: '2026-11-02', to: '2026-11-03' },
]
const sparkWeeks = (values: readonly (string | null)[]): Rate['weeks'] => WEEKS.map((week, index) => ({ ...week, tooFew: values[index] === null, value: values[index] ?? null }))
const rate = (value: string, part: number, whole: number, checks: number, previous: string | null, change: Rate['change'], weeks: readonly (string | null)[]): Rate => ({ tooFew: false, value, part, whole, checks, previous: previous === null ? null : { tooFew: false, value: previous }, change, weeks: sparkWeeks(weeks) })
const HIDDEN: Rate = { tooFew: true, value: null, part: null, whole: null, checks: null, previous: { tooFew: true, value: null }, change: null, weeks: sparkWeeks([null, null, null, null, null]) }

const KPIS: Kpis = {
  ...head,
  previous: { from: '2026-09-05', to: '2026-10-04' },
  sight: SIGHT_ALL,
  kpis: {
    fpy: rate('96.4', 1928, 2000, 64, '95.2', { direction: 'UP', by: '1.2', better: true }, ['95.8', '96.1', '96.9', '96.6', '97.0']),
    dhu: rate('4.6', 92, 2000, 64, '5.9', { direction: 'DOWN', by: '1.3', better: true }, ['5.1', '4.9', '4.2', '4.5', '4.0']),
    aqlPass: rate('91.7', 22, 24, 24, '95.0', { direction: 'DOWN', by: '3.3', better: false }, ['100.0', '85.7', '100.0', '83.3', null]),
    ncrOpen: { value: 7, averageAgeDays: '12.4', previous: { value: 5, averageAgeDays: '9.0' }, change: { direction: 'UP', by: '2.0', better: false } },
    capaOnTime: rate('80.0', 8, 10, 10, '75.0', { direction: 'UP', by: '5.0', better: true }, []),
    holdsOld: { value: 2, averageAgeDays: null, previous: { value: 2, averageAgeDays: null }, change: { direction: 'SAME', by: '0.0', better: null } },
  },
  amendments: { signed: 2 },
}

const week = (index: number, over: Partial<TrendWeek> = {}): TrendWeek => ({
  ...WEEKS[index]!,
  tooFew: false,
  fpy: ['95.8', '96.1', '96.9', '96.6', '97.0'][index]!,
  dhu: ['5.1', '4.9', '4.2', '4.5', '4.0'][index]!,
  pieces: [420, 460, 480, 440, 200][index]!,
  defects: [21, 23, 20, 20, 8][index]!,
  checks: [14, 15, 15, 14, 6][index]!,
  aql: { passed: [5, 6, 5, 5, 1][index]!, decided: [5, 7, 5, 6, 1][index]!, pct: ['100.0', '85.7', '100.0', '83.3', '100.0'][index]! },
  aqlTooFew: false,
  capaClosed: { count: index === 2 ? 1 : index === 3 ? 2 : 0, capas: index === 2 ? [{ id: uid('3803', 1), number: 'CAPA-2026-0003' }] : index === 3 ? [{ id: uid('3803', 2), number: 'CAPA-2026-0004' }, { id: uid('3803', 3), number: 'CAPA-2026-0005' }] : [] },
  ...over,
})
const TREND: Trend = { ...head, sight: SIGHT_ALL, lineId: null, lines: [LINE_A, LINE_B, LINE_C], weeks: [0, 1, 2, 3, 4].map((index) => week(index)) }

const row = (key: string, ref: Compare['rows'][number]['ref'], inspected: number, defects: number, dhu: string, aql: Compare['rows'][number]['aql'], ncrs: number | null): Compare['rows'][number] => ({ key, ref, tooFew: false, inspected, defects, dhu, aql, ncrs })
const hiddenRow = (key: string, ref: Compare['rows'][number]['ref']): Compare['rows'][number] => ({ key, ref, tooFew: true, inspected: null, defects: null, dhu: null, aql: null, ncrs: null })
const COMPARE: Record<Dimension, Compare> = {
  line: {
    ...head,
    by: 'line',
    sight: { counts: true, aql: true, ncrs: true },
    rows: [row(LINE_A.id, LINE_A, 1200, 62, '5.2', { passed: 13, decided: 14, pct: '92.9' }, 4), row(LINE_B.id, LINE_B, 800, 30, '3.8', { passed: 9, decided: 10, pct: '90.0' }, 2), hiddenRow(LINE_C.id, LINE_C)],
    hidden: 1,
  },
  operation: {
    ...head,
    by: 'operation',
    sight: { counts: true, aql: false, ncrs: false },
    rows: [
      row('op-sew', { id: uid('3804', 1), code: 'CUC-01', name: 'Cucitura maniche' }, 1980, 41, '2.1', null, null),
      row('op-arm', { id: uid('3804', 2), code: 'PRT-02', name: 'Tasche protezioni' }, 1960, 18, '0.9', null, null),
      row('op-zip', { id: null, code: 'ZIP-03', name: 'Cerniera' }, 1950, 9, '0.5', null, null),
      hiddenRow('op-cut', { id: uid('3804', 4), code: 'TAG-01', name: 'Taglio pelle' }),
    ],
    hidden: 1,
  },
  supplier: {
    ...head,
    by: 'supplier',
    sight: { counts: true, aql: true, ncrs: true },
    rows: [
      row(uid('3805', 1), { id: uid('3805', 1), code: 'FOR-001', name: 'Conceria Demo Srl' }, 96, 7, '7.3', { passed: 9, decided: 11, pct: '81.8' }, 2),
      row(uid('3805', 2), { id: uid('3805', 2), code: 'FOR-002', name: 'Tessuti Esempio Spa' }, 60, 1, '1.7', { passed: 6, decided: 6, pct: '100.0' }, 0),
      row(uid('3805', 3), { id: uid('3805', 3), code: 'TER-001', name: 'Laboratorio Prova' }, 40, 3, '7.5', { passed: 2, decided: 3, pct: '66.7' }, 1),
    ],
    hidden: 0,
  },
  style: {
    ...head,
    by: 'style',
    sight: { counts: true, aql: true, ncrs: true },
    rows: [
      row(uid('3806', 1), { id: uid('3806', 1), code: 'GIA-100', name: 'Giacca Demo' }, 260, 14, '5.4', { passed: 15, decided: 16, pct: '93.8' }, 3),
      row(uid('3806', 2), { id: uid('3806', 2), code: 'PAN-200', name: 'Pantalone Demo' }, 140, 5, '3.6', { passed: 7, decided: 8, pct: '87.5' }, 1),
      hiddenRow(uid('3806', 3), { id: uid('3806', 3), code: 'GUA-300', name: 'Guanto Demo' }),
    ],
    hidden: 1,
  },
}

const INCOMING: Incoming = {
  ...head,
  sight: { incoming: true, lots: true },
  suppliers: [
    { party: { id: uid('3805', 1), code: 'FOR-001', name: 'Conceria Demo Srl' }, workshop: false, lotsReceived: 12, rejected: 1, crViFails: 1, averageQuarantineDays: '3.4', inQuarantine: 2, inspections: 11, inspectionsFailed: 2 },
    { party: { id: uid('3805', 3), code: 'TER-001', name: 'Laboratorio Prova' }, workshop: true, lotsReceived: 0, rejected: 0, crViFails: 0, averageQuarantineDays: null, inQuarantine: 0, inspections: 3, inspectionsFailed: 1 },
    { party: { id: uid('3805', 2), code: 'FOR-002', name: 'Tessuti Esempio Spa' }, workshop: false, lotsReceived: 6, rejected: 0, crViFails: 0, averageQuarantineDays: '1.2', inQuarantine: 0, inspections: 6, inspectionsFailed: 0 },
  ],
}

export { KPIS, TREND, COMPARE, INCOMING }

const ready = <T>(value: T): Read<T> => ({ status: 'ready', value })
const failed = <T>(): Read<T> => ({ status: 'error', problem: 'problem.unavailable' })
const loading = <T>(): Read<T> => ({ status: 'loading' })
const specs = sectionSpecs((id) => id)

function model(over: Partial<ReportsModel> = {}, role: RoleCase = 'owner', address = ''): ReportsModel {
  const parsed = reportsAddressOf(new URLSearchParams(address))
  return {
    prefix: PREFIX,
    scope: SCOPE_ONE,
    can: reportsCan([...ROLE_PERMISSIONS[role], 'quality.reports.view', 'quality.capa.view', 'parties.view', 'workorders.view', 'product.styles.view', 'product.routing.view']),
    address: parsed,
    range: { from: FROM, to: TO },
    kpis: ready(KPIS),
    trend: ready(TREND),
    compare: ready(COMPARE[parsed.by]),
    incoming: ready(INCOMING),
    live: 'live',
    asOf: NOW,
    layout: defaultSectionLayout(specs),
    specs,
    arranging: false,
    ...over,
  }
}

const EMPTY_RATE = (weeks: number): Rate => ({ tooFew: false, value: null, part: 0, whole: 0, checks: 0, previous: null, change: null, weeks: sparkWeeks(Array.from({ length: weeks }, () => null)).map((entry) => ({ ...entry, tooFew: false })) })
const EMPTY_KPIS: Kpis = { ...KPIS, previous: null, kpis: { fpy: EMPTY_RATE(5), dhu: EMPTY_RATE(5), aqlPass: EMPTY_RATE(5), ncrOpen: { value: 0, averageAgeDays: null, previous: null, change: null }, capaOnTime: { ...EMPTY_RATE(0), weeks: [] }, holdsOld: { value: 0, averageAgeDays: null, previous: null, change: null } }, amendments: { signed: 0 } }
const EMPTY_TREND: Trend = { ...TREND, weeks: TREND.weeks.map((entry) => ({ ...entry, fpy: null, dhu: null, pieces: 0, defects: 0, checks: 0, aql: { passed: 0, decided: 0, pct: null }, capaClosed: { count: 0, capas: [] } })) }
const SMALL_KPIS: Kpis = { ...KPIS, kpis: { ...KPIS.kpis, fpy: HIDDEN, dhu: HIDDEN, aqlPass: HIDDEN, capaOnTime: { ...HIDDEN, weeks: [] } } }
const SMALL_TREND: Trend = { ...TREND, weeks: TREND.weeks.map((entry, index) => (index === 2 ? entry : { ...entry, tooFew: true, fpy: null, dhu: null, pieces: null, defects: null, checks: null, aql: null, aqlTooFew: true })) }
const floorKpis: Kpis = { ...KPIS, sight: { ...SIGHT_NONE, inprocess: true }, kpis: { ...KPIS.kpis, aqlPass: null, ncrOpen: null, capaOnTime: null, holdsOld: null }, amendments: { signed: 2 } }
const buyerKpis: Kpis = { ...KPIS, sight: { ...SIGHT_NONE, incoming: true, lots: true }, kpis: { fpy: null, dhu: null, aqlPass: null, ncrOpen: null, capaOnTime: null, holdsOld: null }, amendments: { signed: 2 } }

function ReportsDesign({ model: value }: { model: ReportsModel }) {
  return inShell('/quality/reports', createElement(ReportsView, { model: value }))
}

export const designScreen = defineDesignScreen<ReportsModel>({
  screen: 'SCR-147',
  title: 'Quality reports (Quality)',
  view: ReportsDesign,
  holdsPage: true,
  cases: [
    { id: 'report', label: 'The report (owner)', model: model(), note: 'Six KPIs with the previous 30 days in words, the trend per week with each week in a pop-over and the CAPAs closed, the comparison by line (L-C hidden: too few people), incoming quality per supplier.' },
    { id: 'loading', label: 'Loading (skeletons)', model: model({ kpis: loading(), trend: loading(), compare: loading(), incoming: loading(), asOf: null }) },
    { id: 'error', label: 'Two panels failed, two stand', model: model({ kpis: failed(), trend: failed() }), note: 'Each panel says what failed and Try again; the rest of the page stays usable.' },
    { id: 'empty', label: 'Nothing signed in the period', model: model({ kpis: ready(EMPTY_KPIS), trend: ready(EMPTY_TREND), compare: ready({ ...COMPARE.line, rows: [], hidden: 0 }), incoming: ready({ ...INCOMING, suppliers: [] }) }), note: '"—", never 0.' },
    { id: 'small-groups', label: 'Too few people behind the figures (ANA-075)', model: model({ kpis: ready(SMALL_KPIS), trend: ready(SMALL_TREND) }), note: 'No figure and no headcount for a group under the company minimum; said in words.' },
    { id: 'by-operation', label: 'Compared by operation', model: model({}, 'owner', 'by=operation'), note: 'Per operation, never by who did it; a one-person operation shows no figure.' },
    { id: 'by-supplier', label: 'Compared by supplier', model: model({}, 'owner', 'by=supplier') },
    { id: 'by-style', label: 'Compared by style', model: model({}, 'owner', 'by=style') },
    { id: 'line-trend', label: 'The trend of one line', model: model({ trend: ready({ ...TREND, lineId: LINE_A.id }) }, 'owner', `line=${LINE_A.id}`) },
    { id: 'compare-off', label: 'Compare to previous: off', model: model({}, 'owner', 'compare=0') },
    { id: 'week-popover', label: 'A week\'s figures (pop-over)', model: model({ openWeek: '2026-W44' }) },
    { id: 'arrange', label: 'Arrange panels', model: model({ arranging: true }) },
    { id: 'keys', label: 'Keyboard shortcuts', model: model({ keysOpen: true }) },
    { id: 'offline', label: 'Offline (live off)', model: model({ live: 'offline' }) },
    { id: 'role-floor', label: 'Floor supervisor: in-process figures only', model: model({ kpis: ready(floorKpis), incoming: ready({ ...INCOMING, sight: { incoming: false, lots: false }, suppliers: [] }), compare: ready({ ...COMPARE.line, sight: { counts: true, aql: false, ncrs: false }, rows: COMPARE.line.rows.map((entry) => ({ ...entry, aql: null, ncrs: null })) }) }, 'supervisor'), note: 'Every other figure says "Not in your role".' },
    { id: 'role-buyer', label: 'Buyer: incoming quality only', model: model({ kpis: ready(buyerKpis), trend: ready({ ...TREND, sight: { ...SIGHT_NONE, incoming: true, lots: true }, weeks: TREND.weeks.map((entry) => ({ ...entry, tooFew: false, fpy: null, dhu: null, pieces: null, defects: null, checks: null, aql: null, capaClosed: null })) }) }, 'readOnly', 'by=supplier') },
    { id: 'all-sites', label: 'All sites: choose one', model: model({ scope: SCOPE_ALL, kpis: { status: 'idle' }, trend: { status: 'idle' }, compare: { status: 'idle' }, incoming: { status: 'idle' }, asOf: null }) },
    { id: 'no-permission', label: 'No right (sales)', model: { ...model({}, 'sales'), can: reportsCan(ROLE_PERMISSIONS.sales) } },
  ],
})

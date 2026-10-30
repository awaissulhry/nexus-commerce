import { createElement, type ReactNode } from 'react'
import { permissionCheck } from '../../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, OWNER_PERMISSIONS } from '../../../../shell/design-data'
import { officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import { SITE_WIP } from '../../_shared/fixtures'
import type { DailyLane, DailyReport, LineCard, LinesOverview, Recipient, Subscription } from '../api'
import { reportsCanOf, type ReportsCan } from '../model'

/**
 * Made-up data for the design cases of SCR-240 (Production reports, its e-mail dialog and print page) and of Floor now's
 * Lines (SCR-073 fn-lines): an invented site ("Stabilimento Demo Nord"), lines, work centres, styles ("DEMO-JKT-01"),
 * people ("Bea Esempio", "Carlo Prova") and machine tags; every figure worked out by hand (the sums are in the comments).
 * Nothing here is a real company, person or number. Design-only (a fixtures file: only fixtures and tests import it); it
 * exports no `designScreen`, so the design index skips it.
 */

export const PREFIX = '/w/DEMO'
const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
export const SITE = { id: uid('2222', 1), code: 'STAB-N', name: 'Stabilimento Demo Nord' }
const SITE_SUD = { id: uid('2222', 2), code: 'STAB-S', name: 'Stabilimento Demo Sud' }
const JKT = { id: uid('7777', 1), code: 'DEMO-JKT-01', name: 'Giacca pelle demo' }
const PNT = { id: uid('7777', 2), code: 'DEMO-PNT-02', name: 'Pantalone demo' }
export const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString()
export const NOW = Date.parse(at(30, 8, 40))

// ---- roles -------------------------------------------------------------------------------------------------------------------

const BASE = ['home.view', 'threads.read', 'threads.post', 'files.read']
export const ROLES = {
  owner: [...OWNER_PERMISSIONS, 'workorders.view', 'production.reports.view', 'production.reports.subscribe'],
  manager: [...BASE, 'workorders.view', 'workorders.manage', 'workorders.release', 'production.reports.view', 'production.reports.subscribe'],
  supervisor: [...BASE, 'workorders.view', 'production.scan.correct', 'production.reports.view', 'production.reports.subscribe'],
  inspector: [...BASE, 'quality.inspections.view', 'production.reports.view'],
  sales: [...BASE, 'workorders.view', 'orders.view'],
} as const
export type Role = keyof typeof ROLES
export const canAs = (role: Role): ReportsCan => reportsCanOf(ROLES[role])

/** The Office shell around a page at this address (the role's navigation). */
export function inShell(path: string, page: ReactNode, role: Role = 'manager'): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck(ROLES[role])),
    path,
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

// ---- the daily report (Thursday 29 October 2026) -------------------------------------------------------------------------------

const row = (style: typeof JKT, size: string, good: number, scrap: number, rework: number) => ({ style, size, good, scrap, rework })
const line = (n: number, code: string, name: string, extra: Partial<DailyLane>): DailyLane => ({
  kind: 'LINE',
  id: uid('3131', n),
  code,
  name,
  good: 0,
  scrap: 0,
  rework: 0,
  earnedMinutes: '0.0',
  availableMinutes: '0.0',
  efficiencyPct: null,
  people: 0,
  workingMinutes: 0,
  rows: [],
  ...extra,
})
const centre = (n: number, code: string, name: string, extra: Partial<DailyLane>): DailyLane => ({
  kind: 'WORK_CENTRE',
  id: uid('3232', n),
  code,
  name,
  good: 0,
  scrap: 0,
  rework: 0,
  earnedMinutes: null,
  availableMinutes: null,
  efficiencyPct: null,
  people: null,
  workingMinutes: null,
  rows: [],
  ...extra,
})

/**
 * L1: 10 + 14 + 12 + 6 = 42 good, 2 scrap, 3 rework; earned 3,318 of 8 × 480 = 3,840 minutes = 86.4 %.
 * L2: 8 + 10 = 18 good, 1 rework; earned 1,512 of 4 × 480 = 1,920 = 78.8 %. The inspection bench: 30 + 25 = 55 good,
 * 1 scrap, 2 rework. Totals 115 · 3 · 6; the lines together 4,830 of 5,760 = 83.9 %.
 */
export const LANES: DailyLane[] = [
  line(1, 'L1', 'Linea giacche', {
    good: 42,
    scrap: 2,
    rework: 3,
    earnedMinutes: '3318.0',
    availableMinutes: '3840.0',
    efficiencyPct: '86.4',
    people: 8,
    workingMinutes: 480,
    rows: [row(JKT, '48', 10, 0, 1), row(JKT, '50', 14, 1, 1), row(JKT, '52', 12, 1, 1), row(JKT, '54', 6, 0, 0)],
  }),
  line(2, 'L2', 'Linea pantaloni', { good: 18, rework: 1, earnedMinutes: '1512.0', availableMinutes: '1920.0', efficiencyPct: '78.8', people: 4, workingMinutes: 480, rows: [row(PNT, '46', 8, 0, 0), row(PNT, '48', 10, 0, 1)] }),
  centre(1, 'QC', 'Collaudo finale', { good: 55, scrap: 1, rework: 2, rows: [row(JKT, '50', 30, 1, 1), row(PNT, '48', 25, 0, 1)] }),
]

export const DAILY: DailyReport = {
  site: { ...SITE, timeZone: 'Europe/Rome' },
  sites: [SITE],
  day: '2026-10-29',
  today: '2026-10-30',
  previousWorkingDay: '2026-10-28',
  nextDay: '2026-10-30',
  workingDay: true,
  asOf: at(30, 8, 38),
  lanes: LANES,
  totals: { good: 115, scrap: 3, rework: 6 },
}

/** Today so far (Friday 30 October, 09:40 at the plant): L1 9 good (earned 711 so far), L2 nothing yet. */
export const TODAY: DailyReport = {
  ...DAILY,
  day: '2026-10-30',
  previousWorkingDay: '2026-10-29',
  nextDay: null,
  lanes: [
    line(1, 'L1', 'Linea giacche', { good: 9, earnedMinutes: '711.0', availableMinutes: '3840.0', efficiencyPct: '18.5', people: 8, workingMinutes: 480, rows: [row(JKT, '50', 9, 0, 0)] }),
    line(2, 'L2', 'Linea pantaloni', { availableMinutes: '1920.0', efficiencyPct: '0.0', people: 4, workingMinutes: 480 }),
  ],
  totals: { good: 9, scrap: 0, rework: 0 },
}

export const EMPTY_DAY: DailyReport = {
  ...DAILY,
  day: '2026-10-27',
  previousWorkingDay: '2026-10-26',
  nextDay: '2026-10-28',
  lanes: [line(1, 'L1', 'Linea giacche', { availableMinutes: '3840.0', efficiencyPct: '0.0', people: 8, workingMinutes: 480 }), line(2, 'L2', 'Linea pantaloni', { availableMinutes: '1920.0', efficiencyPct: '0.0', people: 4, workingMinutes: 480 })],
  totals: { good: 0, scrap: 0, rework: 0 },
}

/** Sunday 25 October: a closed day, nothing planned. */
export const CLOSED_DAY: DailyReport = { ...DAILY, day: '2026-10-25', previousWorkingDay: '2026-10-23', nextDay: '2026-10-26', workingDay: false, lanes: [], totals: { good: 0, scrap: 0, rework: 0 } }

export const TWO_SITES: DailyReport = { ...DAILY, sites: [SITE, SITE_SUD] }

// ---- the e-mail ----------------------------------------------------------------------------------------------------------------

export const ME = { id: uid('1111', 1), name: DEMO_USER.displayName }
const COLLEAGUE = { id: uid('1111', 2), name: 'Carlo Prova' }
const OTHER = { id: uid('1111', 3), name: 'Bea Esempio' }

const subscription = (user: { id: string; name: string }, extra: Partial<Subscription> = {}): Subscription => ({
  id: uid('5353', user === ME ? 1 : user === COLLEAGUE ? 2 : 3),
  reportKey: 'production.daily',
  user,
  mine: user === ME,
  site: SITE,
  sendTime: '07:00',
  weekdays: [1, 2, 3, 4, 5],
  locale: 'it',
  active: true,
  lastSentAt: at(30, 6, 0),
  version: 2,
  ...extra,
})
export const MINE = subscription(ME)
export const FOR_COLLEAGUE = subscription(COLLEAGUE, { sendTime: '06:30' })

export const PEOPLE: Recipient[] = [
  { id: ME.id, name: ME.name, me: true, subscribed: true },
  { id: COLLEAGUE.id, name: COLLEAGUE.name, me: false, subscribed: true },
  { id: OTHER.id, name: OTHER.name, me: false, subscribed: false },
]

// ---- Floor now: the lines (Friday 30 October, 09:40) -------------------------------------------------------------------------

const wo = (index: number) => {
  const row = SITE_WIP.workOrders[index]!
  return { id: row.workOrder.id, number: row.workOrder.number, status: row.workOrder.status, style: { id: JKT.id, code: row.style.code, name: row.style.name } }
}
const station = (n: number, code: string, name: string, signedIn: boolean, machinesDown: LineCard['stations'][number]['machinesDown'] = []) => ({ id: uid('3434', n), code, name, signedIn, machinesDown })

export const LINE_CARDS: LineCard[] = [
  {
    id: uid('3131', 1),
    code: 'L1',
    name: 'Linea giacche',
    site: { id: SITE.id, code: SITE.code },
    state: 'RUNNING',
    lastScanAt: at(30, 8, 36),
    workOrders: [wo(0), wo(1)],
    // 14 of 20 planned = 70 %.
    plannedToday: 20,
    plan: { number: 7 },
    output: 14,
    outputPct: 70,
    bottleneck: { workOrderId: wo(0).id, workOrderNumber: wo(0).number, operationId: uid('4141', 82), seq: 30, code: 'CUC-ASS', name: 'Cucitura assemblaggio', waiting: 6 },
    stations: [station(1, 'CUC-01', 'Cucitura 1', true), station(2, 'CUC-02', 'Cucitura 2', false), station(3, 'CUC-03', 'Cucitura 3', true, [{ assetNumber: 'MAC-DEMO-07', status: 'DOWN' }])],
  },
  {
    id: uid('3131', 2),
    code: 'L2',
    name: 'Linea pantaloni',
    site: { id: SITE.id, code: SITE.code },
    state: 'WAITING',
    lastScanAt: null,
    workOrders: [wo(2)],
    plannedToday: null,
    plan: null,
    output: 0,
    outputPct: null,
    bottleneck: { workOrderId: wo(2).id, workOrderNumber: wo(2).number, operationId: uid('4141', 92), seq: 20, code: 'CUC-PRE', name: 'Preparazione', waiting: 4 },
    stations: [station(4, 'CUC-11', 'Cucitura 11', false), station(5, 'CUC-12', 'Cucitura 12', false)],
  },
  {
    id: uid('3131', 3),
    code: 'L3',
    name: 'Linea campionario',
    site: { id: SITE.id, code: SITE.code },
    state: 'NO_WORK',
    lastScanAt: null,
    workOrders: [],
    plannedToday: 0,
    plan: { number: 7 },
    output: 0,
    outputPct: null,
    bottleneck: null,
    stations: [],
  },
]

export const LINES: LinesOverview = { asOf: at(30, 8, 40), sites: [{ ...SITE, timeZone: 'Europe/Rome', today: '2026-10-30' }], lines: LINE_CARDS }

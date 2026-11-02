import { createElement } from 'react'
import { defaultSectionLayout } from '@nexus/ui/patterns'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { COMPANY, inShell, PEOPLE_ROLES, PREFIX, SCOPE_ALL, SCOPE_ONE, SITE_N } from '../_shared/fixtures'
import type { AttendanceReport, DayRecord, Differences, EarningsReport, EarningsWorkers, GroupFigures } from './api'
import { NEW_SEND, reportsAddressOf, reportsCan, sectionSpecs, type ReportsCan } from './model'
import { ReportsView, type ReportRead, type ReportsModel } from './view/ReportsView'

/**
 * SCR-264 — People reports with made-up lines, teams and amounts only: HR, the owner with the pay grain, the right to open earnings
 * per worker, the match check's four states, the differences and one closed day's record ("Paolo Prova" only there and in the
 * worker list that the right opens), the sections' states, Send report held with why.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const figures = (ordinary: number, over: Partial<GroupFigures> = {}): GroupFigures => ({ ordinaryMinutes: ordinary, presentMinutes: ordinary + 600, nightMinutes: 0, holidayMinutes: 0, overtimeDayMinutes: 600, overtimeNightMinutes: 120, overtimeHolidayMinutes: 0, absenceMinutes: 960, absences: [{ code: 'FER', minutes: 480 }, { code: 'MAL', minutes: 480 }], ...over })

const REPORT: AttendanceReport = {
  siteId: SITE_N.id,
  month: '2026-10',
  groupBy: 'line',
  groups: [
    { id: uid('6201', 1), code: 'L-A', name: 'Linea giacche', people: 8, tooFew: false, figures: figures(76800) },
    { id: uid('6201', 2), code: 'L-B', name: 'Linea pantaloni', people: 5, tooFew: false, figures: figures(48000, { nightMinutes: 240 }) },
    { id: uid('6201', 3), code: 'L-C', name: 'Linea guanti', people: null, tooFew: true, figures: null },
  ],
  summary: null,
  match: { state: 'MATCHES', cells: 0 },
  final: true,
}
const WITH_TOTAL: AttendanceReport = { ...REPORT, groups: REPORT.groups.slice(0, 2), summary: { people: 13, figures: figures(124800) } }

const DIFFERENCES: Differences = {
  siteId: SITE_N.id,
  month: '2026-10',
  cells: [
    { dayId: uid('6202', 1), date: '2026-10-14', kind: 'ORDINARY', absenceCode: null },
    { dayId: uid('6202', 2), date: '2026-10-21', kind: 'ABSENCE', absenceCode: 'FER' },
  ],
}
const cells = (ordinary: number): DayRecord['closedFigures'] => ({ presentMinutes: ordinary, ordinaryMinutes: ordinary, nightMinutes: 0, holidayMinutes: 0, overtimeDayMinutes: 0, overtimeNightMinutes: 0, overtimeHolidayMinutes: 0, absences: [] })
const DAY: DayRecord = {
  dayId: uid('6202', 1),
  date: '2026-10-14',
  person: { employeeId: uid('6203', 1), name: 'Paolo Prova', employeeCode: 'D-0002' },
  closedFigures: cells(450),
  figuresNow: cells(420),
  differs: true,
  corrections: [{ id: uid('6204', 1), kind: 'ORDINARY', absenceCode: null, minutesBefore: 450, minutesAfter: 420, reason: 'Uscita anticipata non registrata.', at: '2026-11-02T09:00:00.000Z', by: 'Anna Esempio' }],
}

const EARNINGS: EarningsReport = {
  companyId: COMPANY,
  from: '2026-10',
  to: '2026-10',
  lines: [
    { line: { id: uid('6201', 1), code: 'L-A', name: 'Linea giacche' }, people: 8, pieces: '4120', earnings: 1845000, makeUp: 92500, makeUpSharePct: '5.0', tooFew: false },
    { line: { id: uid('6201', 2), code: 'L-B', name: 'Linea pantaloni' }, people: 5, pieces: '2210', earnings: 1103000, makeUp: 210000, makeUpSharePct: '19.0', tooFew: false },
    { line: { id: uid('6201', 3), code: 'L-C', name: 'Linea guanti' }, people: null, pieces: null, earnings: null, makeUp: null, makeUpSharePct: null, tooFew: true },
  ],
  months: [{ month: '2026-10', people: 15, pieces: '6980', earnings: 3120000, makeUp: 330000, makeUpSharePct: '10.6', tooFew: false }],
  asOf: '2026-11-02T09:42:00.000Z',
}
const WORKERS: EarningsWorkers = {
  workers: [
    { employeeId: uid('6203', 2), name: 'Giulia Esempio', code: 'D-0001', pieces: '812', earnings: 412000, makeUp: 0, makeUpSharePct: '0.0' },
    { employeeId: uid('6203', 1), name: 'Paolo Prova', code: 'D-0002', pieces: '640', earnings: 338000, makeUp: 22000, makeUpSharePct: '6.5' },
  ],
}

const ready = <T,>(value: T): ReportRead<T> => ({ status: 'ready', value })
const failed: ReportRead<never> = { status: 'error', problem: { ns: 'people', words: { key: 'problem.unavailable' } } }
const specs = sectionSpecs((id) => id)

const OWNER: ReportsCan = reportsCan([...PEOPLE_ROLES.hr, 'people.attendance.view', 'people.earnings.view', 'money.pay', 'people.privacy.view'])
const PAY_HR: ReportsCan = reportsCan([...PEOPLE_ROLES.hr, 'people.attendance.view', 'people.earnings.view', 'people.earnings.records', 'money.pay'])
const NO_PAY: ReportsCan = reportsCan(['people.attendance.view', 'people.earnings.view'])

const base = (over: Partial<ReportsModel> = {}): ReportsModel => ({
  prefix: PREFIX,
  scope: SCOPE_ONE,
  can: OWNER,
  address: reportsAddressOf(null),
  month: '2026-10',
  today: '2026-11',
  monthWords: 'ottobre 2026',
  sight: ready({ siteId: SITE_N.id, open: true, minimumGroupSize: 3 }),
  attendance: ready(REPORT),
  earnings: ready(EARNINGS),
  workers: { status: 'idle' },
  teams: [],
  asOf: '2026-11-02T09:42:00.000Z',
  dialog: null,
  layout: defaultSectionLayout(specs),
  specs,
  arranging: false,
  ...over,
})

function ReportsDesign({ model }: { model: ReportsModel }) {
  return inShell('/people/reports', createElement(ReportsView, { model }), 'hr')
}

export const designScreen = defineDesignScreen<ReportsModel>({
  screen: 'SCR-264',
  title: 'People reports (People)',
  view: ReportsDesign,
  cases: [
    { id: 'owner', label: 'Both reports, a hidden line, no total', model: base(), note: 'A row is a group, so it opens nothing.' },
    { id: 'with-total', label: 'Every group shown: a total', model: base({ attendance: ready(WITH_TOTAL) }) },
    { id: 'match-open', label: 'Match: month not closed', model: base({ attendance: ready({ ...REPORT, final: false, match: { state: 'NOT_CLOSED', cells: 0 } }) }) },
    { id: 'match-unsealed', label: 'Match: closed, not sealed', model: base({ attendance: ready({ ...REPORT, match: { state: 'NOT_SEALED', cells: 0 } }) }) },
    { id: 'match-differs', label: 'Match: differs in 2 cells · Show', model: base({ attendance: ready({ ...REPORT, match: { state: 'DIFFERS', cells: 2 } }) }) },
    { id: 'differences', label: 'The cells that differ: no figure, no person', model: base({ attendance: ready({ ...REPORT, match: { state: 'DIFFERS', cells: 2 } }), dialog: { kind: 'differences', read: ready(DIFFERENCES) } }) },
    { id: 'differences-loading', label: 'Differences loading', model: base({ dialog: { kind: 'differences', read: { status: 'loading' } } }) },
    { id: 'differences-error', label: 'Differences failed', model: base({ dialog: { kind: 'differences', read: failed } }) },
    { id: 'day', label: 'One closed day: one record', model: base({ dialog: { kind: 'day', read: ready(DAY) } }) },
    { id: 'day-error', label: 'A day failed', model: base({ dialog: { kind: 'day', read: failed } }) },
    { id: 'by-team', label: 'Grouped by team', model: base({ address: { ...reportsAddressOf(null), group: 'team' }, teams: [{ id: uid('6205', 1), label: 'A1 · Squadra A1' }], attendance: ready({ ...REPORT, groupBy: 'team' }) }) },
    { id: 'by-month', label: 'Earnings by month', model: base({ address: { ...reportsAddressOf(null), earnings: 'month' } }) },
    { id: 'gate-off', label: 'Attendance off at this site: held in words, nothing read', model: base({ sight: ready({ siteId: SITE_N.id, open: false, minimumGroupSize: 3 }), attendance: { status: 'idle' } }) },
    { id: 'all-sites', label: 'All sites: attendance needs one site', model: base({ scope: SCOPE_ALL, sight: { status: 'idle' }, attendance: { status: 'idle' } }) },
    { id: 'no-pay', label: 'No pay grain: the earnings report says so', model: base({ can: NO_PAY, earnings: { status: 'idle' } }) },
    { id: 'no-attendance', label: 'Earnings only: no attendance right', model: base({ can: reportsCan(['people.earnings.view', 'money.pay']), attendance: { status: 'idle' }, sight: { status: 'idle' } }) },
    { id: 'no-permission', label: 'No right to this page', model: base({ can: reportsCan([]) }) },
    { id: 'right', label: 'HR with the right: Open per worker', model: base({ can: PAY_HR }) },
    { id: 'workers', label: 'Per worker: opened, recorded, by name, on this page only', model: base({ can: PAY_HR, workers: ready(WORKERS) }) },
    { id: 'workers-loading', label: 'Per worker: being opened', model: base({ can: PAY_HR, workers: { status: 'loading' } }) },
    { id: 'workers-error', label: 'Per worker: refused', model: base({ can: PAY_HR, workers: failed }) },
    { id: 'loading', label: 'Loading', model: base({ attendance: { status: 'loading' }, earnings: { status: 'loading' }, asOf: null }) },
    { id: 'error', label: 'Each report failed on its own', model: base({ attendance: failed, earnings: failed, asOf: null }) },
    { id: 'empty', label: 'Nothing in the month', model: base({ attendance: ready({ ...REPORT, groups: [], summary: null, match: { state: 'NOT_CLOSED', cells: 0 }, final: false }), earnings: ready({ ...EARNINGS, lines: [], months: [] }) }) },
    { id: 'send', label: 'Send report: "Send link" held with why', model: base({ dialog: { kind: 'send', draft: NEW_SEND } }) },
    { id: 'send-csv', label: 'Send report: CSV', model: base({ dialog: { kind: 'send', draft: { ...NEW_SEND, format: 'CSV', recipient: 'consulente@example.com' } } }) },
    { id: 'send-earnings', label: 'Send report: earnings never go by link', model: base({ dialog: { kind: 'send', draft: { ...NEW_SEND, report: 'earnings' } } }) },
    { id: 'arrange', label: 'Arrange', model: base({ arranging: true }) },
  ],
})

export { EARNINGS, REPORT, WORKERS }

import { COMPANY, LINE_A, LINE_B, PEOPLE, SITE_N, SITE_S, TODAY } from '../../_shared/fixtures'
import type { CloseMonth, DayCorrections, DayRecord, DayRow, EmployeeDays, EntryRecord, EntryRow, LulOpened, MonthPanel, PersonMonth, RollCall, TimesheetRecord, TimesheetRow, WhoIsIn, AbsenceCode } from '../api'
import type { TeamRef } from '../view-model'

/**
 * Made-up attendance for the Attendance design cases and tests (SCR-157, the roll call, the LUL calendar tab, a timesheet, the
 * employee's Attendance tab): the People fixtures' invented company, sites, lines and people. Nothing here is a real person,
 * shift, hour, fingerprint or law case. Exports no `designScreen`.
 */

const uid = (block: string, n: number) => `0190f0e2-${block.padStart(4, '0').slice(-4)}-7000-8000-${String(n).padStart(12, '0')}`
const at = (date: string, time: string) => `${date}T${time}:00.000Z`

export const MONTH = '2026-10'
export const TEAMS: TeamRef[] = [
  { id: uid('3303', 1), code: 'A1', name: 'Cucitura A', lineId: LINE_A.id },
  { id: uid('3303', 2), code: 'B1', name: 'Pantaloni B', lineId: LINE_B.id },
]
export const LINES = [LINE_A, LINE_B]

const MORNING = { label: 'Mattino', startMinute: 360, endMinute: 840, minutes: 450 }

const row = (n: number, date: string, over: Partial<DayRow> = {}): DayRow => ({
  id: uid('6101', n),
  date,
  siteId: SITE_N.id,
  teamId: TEAMS[n % 2]!.id,
  lineId: (n % 2 === 0 ? LINE_A : LINE_B).id,
  status: 'OPEN',
  planned: MORNING,
  presence: true,
  anomalies: { open: 0, kinds: [] },
  manual: false,
  absence: 'NONE',
  approvedAt: null,
  version: 2,
  ...over,
})

export const DAY_ROWS: DayRow[] = [
  row(1, '2026-10-30', { status: 'NEEDS_FIX', anomalies: { open: 1, kinds: ['MISSING_CLOCK_OUT'] } }),
  row(2, '2026-10-30'),
  row(3, '2026-10-30', { presence: false, absence: 'MISSING' }),
  row(4, '2026-10-29', { status: 'NEEDS_FIX', anomalies: { open: 2, kinds: ['DOUBLE_CLOCK_IN', 'NO_BREAK'] } }),
  row(5, '2026-10-29', { manual: true }),
  row(6, '2026-10-29', { presence: false, absence: 'CODED' }),
  row(7, '2026-10-28', { status: 'APPROVED', approvedAt: at('2026-10-29', '08:12') }),
  row(8, '2026-10-28', { status: 'APPROVED', approvedAt: at('2026-10-29', '08:12'), planned: null, anomalies: { open: 0, kinds: [] } }),
  row(9, '2026-10-27', { status: 'CLOSED', approvedAt: at('2026-10-28', '08:12') }),
]

export const CODES: AbsenceCode[] = [
  { id: uid('6201', 1), code: 'FER', labelI18n: { it: 'Ferie', en: 'Holiday' }, category: 'HOLIDAY', lulCode: null, documentRequired: false, status: 'ACTIVE' },
  { id: uid('6201', 2), code: 'MAL', labelI18n: { it: 'Malattia', en: 'Sickness' }, category: 'SICKNESS', lulCode: null, documentRequired: true, status: 'ACTIVE' },
]

const event = (n: number, kind: DayRecord['events'][number]['kind'], time: string, over: Partial<DayRecord['events'][number]> = {}): DayRecord['events'][number] => ({
  id: uid('6301', n),
  kind,
  source: 'BADGE',
  occurredAt: at('2026-10-30', time),
  siteId: SITE_N.id,
  flags: [],
  reason: null,
  offSite: false,
  voidsEventId: null,
  voided: false,
  ...over,
})

export const DAY_RECORD: DayRecord = {
  id: DAY_ROWS[0]!.id,
  date: '2026-10-30',
  siteId: SITE_N.id,
  companyId: COMPANY,
  status: 'NEEDS_FIX',
  version: 3,
  person: { employeeId: PEOPLE.paolo.id, name: PEOPLE.paolo.name, displayName: PEOPLE.paolo.displayName, employeeCode: PEOPLE.paolo.employeeCode },
  planned: MORNING,
  figures: { firstInAt: at('2026-10-30', '04:58'), lastOutAt: at('2026-10-30', '13:15'), presentMinutes: 470, breakMinutes: 30, ordinaryMinutes: 450, overtimeMinutes: 15, nightMinutes: 0, holidayMinutes: 0, absenceMinutes: 0 },
  computedAt: at('2026-10-30', '13:30'),
  manual: false,
  approvedAt: null,
  events: [event(1, 'IN', '04:58'), event(2, 'BREAK_OUT', '09:00', { source: 'NAME_PIN', flags: ['FORGOT_BADGE'] }), event(3, 'BREAK_IN', '09:30'), event(4, 'OUT', '13:15', { source: 'AUTO', reason: null })],
  anomalies: [{ id: uid('6401', 1), kind: 'MISSING_CLOCK_OUT', ruleKey: 'people.autoClockOutAfterMinutes', clockEventId: uid('6301', 4), raisedAt: at('2026-10-30', '13:16'), resolution: null, resolvedAt: null, resolutionNote: null }],
  absences: [],
  holds: [{ code: 'ANOMALIES_OPEN' }],
  actions: { approve: false, fix: true, reopen: false },
}

export const DAY_CLEAN: DayRecord = { ...DAY_RECORD, status: 'OPEN', anomalies: [], holds: [], actions: { approve: true, fix: true, reopen: false } }
export const DAY_APPROVED: DayRecord = { ...DAY_CLEAN, status: 'APPROVED', approvedAt: at('2026-10-31', '08:00'), holds: [{ code: 'ALREADY_APPROVED' }], actions: { approve: false, fix: false, reopen: true } }
export const DAY_CLOSED: DayRecord = { ...DAY_CLEAN, status: 'CLOSED', holds: [{ code: 'CLOSED' }], actions: { approve: false, fix: false, reopen: false } }
export const DAY_ABSENT: DayRecord = {
  ...DAY_CLEAN,
  figures: { ...DAY_CLEAN.figures, firstInAt: null, lastOutAt: null, presentMinutes: 0, breakMinutes: 0, ordinaryMinutes: 0, overtimeMinutes: 0, absenceMinutes: 450 },
  events: [],
  absences: [{ id: uid('6501', 1), codeId: CODES[1]!.id, code: 'MAL', label: CODES[1]!.labelI18n, category: 'SICKNESS', lulCode: null, minutes: 450, documentRef: 'PROT-0001', version: 1 }],
}

const cells = { presentMinutes: 470, ordinaryMinutes: 450, nightMinutes: 0, holidayMinutes: 0, overtimeDayMinutes: 15, overtimeNightMinutes: 0, overtimeHolidayMinutes: 0, absences: [] }
export const CORRECTIONS: DayCorrections = {
  dayId: DAY_RECORD.id,
  date: '2026-10-30',
  siteId: SITE_N.id,
  status: 'CLOSED',
  closeId: uid('6601', 1),
  person: { employeeId: PEOPLE.paolo.id, name: PEOPLE.paolo.name, displayName: PEOPLE.paolo.displayName, employeeCode: PEOPLE.paolo.employeeCode },
  closedFigures: cells,
  figuresNow: { ...cells, ordinaryMinutes: 420 },
  differs: true,
  corrections: [{ id: uid('6701', 1), kind: 'ORDINARY', absenceCode: null, minutesBefore: 450, minutesAfter: 420, reason: 'Errore del tablet', at: at('2026-11-01', '09:00'), by: PEOPLE.giulia.name }],
  actions: { correct: true },
}

const entry = (n: number, over: Partial<EntryRow> = {}): EntryRow => ({
  id: uid('6801', n),
  date: '2026-10-28',
  siteId: SITE_N.id,
  teamId: TEAMS[0]!.id,
  lineId: LINE_A.id,
  class: 'DAY',
  status: 'PENDING',
  requestId: null,
  checks: [
    { rule: 'OVERTIME_YEARLY_CAP', state: 'OK', level: 'WARN' },
    { rule: 'DAILY_REST', state: 'OK', level: 'WARN' },
    { rule: 'WEEKLY_AVERAGE', state: 'OK', level: 'WARN' },
  ],
  version: 1,
  ...over,
})

export const ENTRY_ROWS: EntryRow[] = [
  entry(1, { requestId: uid('6901', 1) }),
  entry(2, { date: '2026-10-27', class: 'NIGHT', checks: [{ rule: 'OVERTIME_YEARLY_CAP', state: 'NEAR', level: 'WARN' }, { rule: 'DAILY_REST', state: 'OVER', level: 'WARN' }, { rule: 'WEEKLY_AVERAGE', state: 'OK', level: 'WARN' }] }),
  entry(3, { date: '2026-10-26', class: 'HOLIDAY', checks: [{ rule: 'OVERTIME_YEARLY_CAP', state: 'OVER', level: 'BLOCK' }, { rule: 'DAILY_REST', state: 'OK', level: 'WARN' }, { rule: 'WEEKLY_AVERAGE', state: 'NEAR', level: 'WARN' }] }),
]

export const ENTRY_RECORD: EntryRecord = {
  id: ENTRY_ROWS[1]!.id,
  date: '2026-10-27',
  siteId: SITE_N.id,
  companyId: COMPANY,
  class: 'NIGHT',
  minutes: 90,
  status: 'PENDING',
  version: 1,
  person: { employeeId: PEOPLE.paolo.id, name: PEOPLE.paolo.name, displayName: PEOPLE.paolo.displayName, employeeCode: PEOPLE.paolo.employeeCode },
  day: { id: DAY_ROWS[8]!.id, status: 'APPROVED', overtimeMinutes: 90, nightMinutes: 60, holidayMinutes: 0, manual: false },
  request: { id: uid('6901', 1), date: '2026-10-27', minutes: 60, status: 'APPROVED' },
  beyondRequestMinutes: 30,
  decision: { approvedAt: null, approvedBy: null, rejectedAt: null, rejectedBy: null, rejectReason: null },
  checks: [
    { rule: 'OVERTIME_YEARLY_CAP', state: 'NEAR', level: 'WARN', date: '2026-10-27', law: 'D.Lgs. 66/2003 art. 5', values: { year: '2026', usedMinutes: 13800, limitMinutes: 15000 } },
    { rule: 'DAILY_REST', state: 'OVER', level: 'WARN', date: '2026-10-27', law: 'D.Lgs. 66/2003 art. 7', values: { restMinutes: 600, limitMinutes: 660, from: '22:00', fromDate: '2026-10-26', to: '08:00' } },
    { rule: 'WEEKLY_AVERAGE', state: 'OK', level: 'WARN', date: '2026-10-27', law: 'D.Lgs. 66/2003 art. 4', values: { averageMinutes: 2460, weekMinutes: 2500, weeks: 17, limitMinutes: 2880, referenceMonths: 4, periodFrom: '2026-07-06' } },
  ],
  holds: [],
  actions: { approve: true, reject: true, reopen: false },
}
export const ENTRY_BLOCKED: EntryRecord = { ...ENTRY_RECORD, checks: [{ ...ENTRY_RECORD.checks[0]!, state: 'OVER', level: 'BLOCK' }, ...ENTRY_RECORD.checks.slice(1)] }
export const ENTRY_HELD: EntryRecord = { ...ENTRY_RECORD, holds: [{ code: 'DAY_NOT_APPROVED' }], actions: { approve: false, reject: false, reopen: false } }
export const ENTRY_DECIDED: EntryRecord = { ...ENTRY_RECORD, status: 'REJECTED', decision: { approvedAt: null, approvedBy: null, rejectedAt: at('2026-10-29', '09:00'), rejectedBy: PEOPLE.giulia.name, rejectReason: 'Non autorizzato' }, actions: { approve: false, reject: false, reopen: true } }

const sheet = (n: number, over: Partial<TimesheetRow> = {}): TimesheetRow => ({ id: uid('7001', n), periodStart: '2026-10-01', periodEnd: '2026-10-31', status: 'PENDING', stage: 'LEAD', teamId: TEAMS[n % 2]!.id, lineId: (n % 2 === 0 ? LINE_A : LINE_B).id, ready: true, returned: false, version: 1, ...over })
export const TIMESHEET_ROWS: TimesheetRow[] = [sheet(1), sheet(2, { ready: false }), sheet(3, { status: 'LEAD_APPROVED', stage: 'HR' }), sheet(4, { status: 'APPROVED', stage: 'DONE', ready: true }), sheet(5, { returned: true })]

const CLOSE_ID = uid('6601', 1)
const phrases = { en: 'close October 2026', it: 'chiudi ottobre 2026' }
const TO_CONFIRM = ['1', '2', '3', '4', '5', '6', '7']

export const PANEL_OPEN: MonthPanel = {
  companyId: COMPANY,
  month: MONTH,
  state: 'OPEN',
  closeId: null,
  monthOver: true,
  due: { by: '2026-11-30', daysLeft: 28 },
  checklist: [
    { item: 'DAYS_APPROVED', left: 46, done: false },
    { item: 'ANOMALIES_CLEARED', left: 3, done: false },
    { item: 'ABSENCE_CODES', left: 2, done: false },
    { item: 'PRODUCTION_DAYS', left: 0, done: true },
    { item: 'MANUAL_REVIEWED', left: 1, done: false },
    { item: 'OVERTIME_DECIDED', left: 3, done: false },
  ],
  notes: [{ note: 'TIMESHEETS_NOT_APPROVED' }, { note: 'CODES_WITHOUT_LUL' }],
  holds: [{ code: 'DAYS_APPROVED' }, { code: 'ANOMALIES_CLEARED' }, { code: 'ABSENCE_CODES' }, { code: 'MANUAL_REVIEWED' }, { code: 'OVERTIME_DECIDED' }],
  days: 880,
  sites: [{ siteId: SITE_N.id, code: SITE_N.code, name: SITE_N.name, gateOpen: true }],
  corrections: 0,
  seal: null,
  confirm: { phrases },
  toConfirm: TO_CONFIRM,
  actions: { close: false, seal: false, openLul: false },
}
export const PANEL_READY: MonthPanel = { ...PANEL_OPEN, checklist: PANEL_OPEN.checklist.map((entry) => ({ ...entry, left: 0, done: true })), holds: [], actions: { close: true, seal: false, openLul: false } }
export const PANEL_NOT_OVER: MonthPanel = { ...PANEL_OPEN, month: '2026-11', monthOver: false, due: { by: '2026-12-31', daysLeft: 59 }, holds: [{ code: 'MONTH_NOT_OVER' }, ...PANEL_OPEN.holds], confirm: { phrases: { en: 'close November 2026', it: 'chiudi novembre 2026' } } }
export const PANEL_CLOSED: MonthPanel = {
  ...PANEL_READY,
  state: 'CLOSED',
  closeId: CLOSE_ID,
  corrections: 1,
  seal: { closedAt: at('2026-11-02', '09:12'), closedBy: PEOPLE.giulia.name, sealed: true, sha256: 'ab12cd34'.repeat(8), fileId: uid('7101', 1) },
  actions: { close: false, seal: false, openLul: true },
}
export const PANEL_UNSEALED: MonthPanel = { ...PANEL_CLOSED, seal: { ...PANEL_CLOSED.seal!, sealed: false, sha256: null, fileId: null }, actions: { close: false, seal: true, openLul: false } }
export const PANEL_LATE: MonthPanel = { ...PANEL_OPEN, due: { by: '2026-10-31', daysLeft: -2 } }

export const WHO: WhoIsIn = {
  asOf: at('2026-11-02', '09:42'),
  people: 18,
  tooFew: false,
  areas: [
    { areaId: uid('7201', 1), code: 'CUC', name: 'Cucitura', people: 16, tooFew: false, lines: [{ lineId: LINE_A.id, code: LINE_A.code, name: LINE_A.name, people: 10, tooFew: false }, { lineId: LINE_B.id, code: LINE_B.code, name: LINE_B.name, people: 6, tooFew: false }] },
    { areaId: uid('7201', 2), code: 'TAG', name: 'Taglio', people: null, tooFew: true, lines: [{ lineId: null, code: null, name: null, people: null, tooFew: true }] },
  ],
}

export const ROLL: RollCall = {
  asOf: at('2026-11-02', '09:42'),
  people: 4,
  groups: [
    { areaId: WHO.areas[0]!.areaId, areaName: 'Cucitura', lineId: LINE_A.id, lineName: LINE_A.name, people: [{ employeeId: PEOPLE.giulia.id, name: PEOPLE.giulia.name, onBreak: false }, { employeeId: PEOPLE.paolo.id, name: PEOPLE.paolo.name, onBreak: true }] },
    { areaId: WHO.areas[0]!.areaId, areaName: 'Cucitura', lineId: LINE_B.id, lineName: LINE_B.name, people: [{ employeeId: PEOPLE.ion.id, name: PEOPLE.ion.name, onBreak: false }] },
    { areaId: null, areaName: null, lineId: null, lineName: null, people: [{ employeeId: PEOPLE.marta.id, name: PEOPLE.marta.name, onBreak: false }] },
  ],
}

const sheetDay = (n: number, date: string, over: Partial<TimesheetRecord['days'][number]> = {}): TimesheetRecord['days'][number] => ({
  id: uid('7301', n),
  date,
  status: 'APPROVED',
  plannedLabel: 'Mattino',
  presence: true,
  absent: false,
  anomaliesOpen: 0,
  manual: false,
  figures: { firstInAt: at(date, '05:00'), lastOutAt: at(date, '13:00'), presentMinutes: 450, ordinaryMinutes: 450, nightMinutes: 0, holidayMinutes: 0, absenceMinutes: 0 },
  absences: [],
  overtime: [],
  ...over,
})

export const TIMESHEET: TimesheetRecord = {
  id: TIMESHEET_ROWS[2]!.id,
  periodStart: '2026-10-01',
  periodEnd: '2026-10-31',
  status: 'LEAD_APPROVED',
  stage: 'HR',
  version: 2,
  person: { employeeId: PEOPLE.paolo.id, name: PEOPLE.paolo.name, displayName: PEOPLE.paolo.displayName, employeeCode: PEOPLE.paolo.employeeCode, siteId: SITE_N.id },
  lead: { approvedAt: at('2026-11-01', '10:00'), approvedBy: PEOPLE.giulia.name },
  hr: { approvedAt: null, approvedBy: null },
  returned: null,
  figuresShown: true,
  days: [
    sheetDay(1, '2026-10-29'),
    sheetDay(2, '2026-10-30', { manual: true, overtime: [{ class: 'DAY', minutes: 30, status: 'APPROVED' }] }),
    sheetDay(3, '2026-10-31', { presence: false, absent: true, figures: { firstInAt: null, lastOutAt: null, presentMinutes: 0, ordinaryMinutes: 0, nightMinutes: 0, holidayMinutes: 0, absenceMinutes: 450 }, absences: [{ code: 'FER', category: 'HOLIDAY', minutes: 450 }] }),
  ],
  summary: { daysPresent: 2, presentMinutes: 900, ordinaryMinutes: 900, nightMinutes: 0, holidayMinutes: 0, absenceMinutes: 450, overtimeApprovedMinutes: 30, overtimePendingMinutes: 0, overtimeRejectedMinutes: 0 },
  holds: { lead: [{ code: 'WRONG_STAGE' }], hr: [] },
  changedSince: false,
  actions: { leadApprove: false, hrApprove: true, sendBack: true },
}

/** A lead's view: each day's state, no minutes, no absence code (B-W2b-42). */
export const TIMESHEET_LEAD: TimesheetRecord = {
  ...TIMESHEET,
  status: 'PENDING',
  stage: 'LEAD',
  lead: { approvedAt: null, approvedBy: null },
  figuresShown: false,
  days: TIMESHEET.days.map((day) => ({ ...day, figures: null, absences: null, overtime: null })),
  summary: null,
  holds: { lead: [], hr: [{ code: 'WRONG_STAGE' }] },
  actions: { leadApprove: true, hrApprove: false, sendBack: false },
}

export const CLOSE_MONTH: CloseMonth = { closeId: CLOSE_ID, month: MONTH, state: 'CLOSED', closedAt: at('2026-11-02', '09:12'), sealed: true }
export const LUL_OPENED: LulOpened = { closeId: CLOSE_ID, format: 'PDF', fileName: 'lul-2026-10.pdf', sha256: 'ab12cd34'.repeat(8), download: { method: 'GET', url: '/local-files?token=demo', headers: {}, expiresAt: at('2026-11-02', '09:43') } }

const employeeDay = (n: number, date: string, over: Partial<EmployeeDays['days'][number]> = {}): EmployeeDays['days'][number] => ({
  id: uid('7401', n),
  date,
  siteId: SITE_N.id,
  status: 'APPROVED',
  planned: MORNING,
  figures: { firstInAt: at(date, '05:00'), lastOutAt: at(date, '13:00'), presentMinutes: 450, breakMinutes: 30, ordinaryMinutes: 450, overtimeMinutes: 0, nightMinutes: 0, holidayMinutes: 0, absenceMinutes: 0 },
  manual: false,
  anomaliesOpen: 0,
  absences: [],
  version: 2,
  ...over,
})

export const EMPLOYEE_DAYS: EmployeeDays = {
  person: { employeeId: PEOPLE.paolo.id, name: PEOPLE.paolo.name, displayName: PEOPLE.paolo.displayName, siteId: SITE_N.id },
  from: '2026-10-01',
  to: '2026-10-31',
  days: [
    employeeDay(1, '2026-10-28'),
    employeeDay(2, '2026-10-29', { status: 'NEEDS_FIX', anomaliesOpen: 1 }),
    employeeDay(3, '2026-10-30', { manual: true, figures: { ...employeeDay(0, '2026-10-30').figures, overtimeMinutes: 60 } }),
    employeeDay(4, '2026-10-31', { status: 'OPEN', absences: [{ code: 'FER', category: 'HOLIDAY', minutes: 450 }], figures: { ...employeeDay(0, '2026-10-31').figures, firstInAt: null, lastOutAt: null, presentMinutes: 0, breakMinutes: 0, ordinaryMinutes: 0, absenceMinutes: 450 } }),
  ],
}

export const PERSON_MONTH: PersonMonth = { month: MONTH, monthState: 'OPEN', closedAt: null, figures: { ordinaryMinutes: 9000, presentMinutes: 9150, nightMinutes: 0, holidayMinutes: 0, overtimeDayMinutes: 60, overtimeNightMinutes: 0, overtimeHolidayMinutes: 0, absenceMinutes: 450 }, differs: false }
export const PERSON_CLOSED: PersonMonth = { ...PERSON_MONTH, monthState: 'CLOSED', closedAt: at('2026-11-02', '09:12'), differs: true }

export { SITE_S, TODAY }

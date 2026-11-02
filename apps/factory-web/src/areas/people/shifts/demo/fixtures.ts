import { eachDay } from '@nexus/factory-domain/calendars/dates'
import { LINE_A, LINE_B, LINE_S, PEOPLE, SITE_N, SITE_S, TODAY } from '../../_shared/fixtures'
import type { LimitWarning, OvertimeListed, OvertimeRecord, PlanPreview, Ref, Roster, RosterCell, RosterRow, RosterValue, ShiftChoice } from '../api'
import type { DayRange } from '../model'

/**
 * Made-up roster for the Shifts design cases and tests (SCR-263): the People fixtures' invented company, sites, lines and
 * people. Nothing here is a real person, shift or law case. Exports no `designScreen`.
 */

const uid = (block: string, n: number) => `0190f0e2-${block.padStart(4, '0').slice(-4)}-7000-8000-${String(n).padStart(12, '0')}`

export const RANGE: DayRange = { from: '2026-11-02', to: '2026-11-08', custom: false }
export const MONTH: DayRange = { from: '2026-11-01', to: '2026-11-30', custom: false }
const PATTERN = uid('5101', 1)
const DAY_PATTERN = uid('5101', 2)

export const LINE_A_REF: Ref = { id: LINE_A.id, code: LINE_A.code, name: LINE_A.name }
export const LINE_B_REF: Ref = { id: LINE_B.id, code: LINE_B.code, name: LINE_B.name }
export const LINE_S_REF: Ref = { id: LINE_S.id, code: LINE_S.code, name: LINE_S.name }
export const TEAM_A: Ref & { lineId: string | null } = { id: uid('3303', 1), code: 'T-A1', name: 'Squadra giacche', lineId: LINE_A.id }
export const TEAM_B: Ref & { lineId: string | null } = { id: uid('3303', 2), code: 'T-B1', name: 'Squadra pantaloni', lineId: LINE_B.id }

export const MORNING: ShiftChoice = { patternId: PATTERN, patternCode: '2T', patternName: 'Due turni', label: 'Morning', startMinute: 360, endMinute: 840, breakMinutes: 30, weekdays: [1, 2, 3, 4, 5], key: 'M' }
export const AFTERNOON: ShiftChoice = { patternId: PATTERN, patternCode: '2T', patternName: 'Due turni', label: 'Afternoon', startMinute: 840, endMinute: 1320, breakMinutes: 30, weekdays: [1, 2, 3, 4, 5], key: 'A' }
export const DAY: ShiftChoice = { patternId: DAY_PATTERN, patternCode: 'GIO', patternName: 'Giornaliero', label: 'Day', startMinute: 480, endMinute: 1020, breakMinutes: 60, weekdays: [1, 2, 3, 4, 5], key: 'D' }
export const CHOICES: ShiftChoice[] = [MORNING, DAY, AFTERNOON]

const work = (choice: ShiftChoice): RosterValue => ({ kind: 'WORK', patternId: choice.patternId, shift: { label: choice.label, startMinute: choice.startMinute, endMinute: choice.endMinute, breakMinutes: choice.breakMinutes } })
const OFF: RosterValue = { kind: 'OFF', shift: null, patternId: null }

const isWeekend = (date: string) => {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay()
  return day === 0 || day === 6
}

const baseCell = (date: string, choice: ShiftChoice): RosterCell => {
  const closed = isWeekend(date)
  const value = closed ? OFF : work(choice)
  return { date, source: 'DEFAULT', value, issue: null, entry: null, fallback: value, open: !closed, overtime: [], absence: null, warnings: [] }
}

export const REST_WARNING: LimitWarning = { rule: 'DAILY_REST', level: 'WARN', date: '2026-11-04', law: 'D.Lgs. 66/2003 art. 7', values: { restMinutes: 480, limitMinutes: 660, from: '22:00', fromDate: '2026-11-03', to: '06:00' }, isNew: false }
export const REST_BLOCK: LimitWarning = { ...REST_WARNING, level: 'BLOCK', date: '2026-11-05' }
export const WEEK_WARNING: LimitWarning = { rule: 'WEEKLY_AVERAGE', level: 'WARN', date: '2026-11-06', law: 'D.Lgs. 66/2003 art. 4', values: { weekMinutes: 3180, averageMinutes: 2940, weeks: 4, limitMinutes: 2880, referenceMonths: 4, week: '2026-11-02', periodFrom: '2026-10-12' }, isNew: false }
export const CAP_WARNING: LimitWarning = { rule: 'OVERTIME_YEARLY_CAP', level: 'WARN', date: '2026-11-06', law: 'D.Lgs. 66/2003 art. 5', values: { plannedMinutes: 15120, limitMinutes: 15000, year: '2026' }, isNew: true }

function row(person: { id: string; name: string; displayName: string }, line: Ref | null, team: Ref | null, choice: ShiftChoice, over: Partial<RosterRow> = {}, site: Ref = SITE_N, dates = eachDay(RANGE.from, RANGE.to), patch: Record<string, Partial<RosterCell>> = {}): RosterRow {
  return {
    employeeId: person.id,
    name: person.name,
    displayName: person.displayName,
    site,
    line,
    team,
    isLead: false,
    defaultPattern: { id: choice.patternId, code: choice.patternCode, name: choice.patternName },
    lastWorkingDay: null,
    canEdit: true,
    cells: dates.map((date) => ({ ...baseCell(date, choice), ...patch[date] })),
    ...over,
  }
}

const entry = (status: 'DRAFT' | 'PUBLISHED', n: number) => ({ id: uid('5202', n), status, version: 1, note: null })

export function rosterRows(dates = eachDay(RANGE.from, RANGE.to)): RosterRow[] {
  const has = (date: string) => dates.includes(date)
  const patch = (date: string, cell: Partial<RosterCell>) => (has(date) ? { [date]: cell } : {})
  return [
    row(PEOPLE.giulia, LINE_A_REF, TEAM_A, MORNING, { isLead: true }, SITE_N, dates, {
      ...patch('2026-11-03', { source: 'ROSTER', value: work(AFTERNOON), entry: entry('PUBLISHED', 1) }),
      ...patch('2026-11-04', { source: 'ROSTER', value: work(MORNING), entry: entry('DRAFT', 2), warnings: [REST_WARNING] }),
    }),
    row(PEOPLE.paolo, LINE_A_REF, TEAM_A, MORNING, {}, SITE_N, dates, {
      ...patch('2026-11-04', { overtime: [{ requestId: uid('5303', 1), agreementId: uid('5304', 1), startMinute: 840, minutes: 120, stage: 'APPROVED', answer: 'AGREED' }] }),
      ...patch('2026-11-05', { overtime: [{ requestId: uid('5303', 2), agreementId: uid('5304', 2), startMinute: 840, minutes: 90, stage: 'ASKED', answer: 'PENDING' }] }),
    }),
    row(PEOPLE.sara, LINE_A_REF, TEAM_A, MORNING, {}, SITE_N, dates, {
      ...patch('2026-11-05', { absence: { kind: 'HOLIDAY', code: 'FER', minutes: 480 } }),
      ...patch('2026-11-06', { absence: { kind: 'ABSENT', code: null, minutes: 480 } }),
    }),
    row(PEOPLE.ion, LINE_B_REF, TEAM_B, AFTERNOON, {}, SITE_N, dates, {
      ...patch('2026-11-05', { source: 'ROSTER', value: work(MORNING), entry: entry('DRAFT', 3), warnings: [REST_BLOCK] }),
      ...patch('2026-11-06', { source: 'ROSTER', value: OFF, entry: entry('PUBLISHED', 4) }),
    }),
    row(PEOPLE.elena, LINE_B_REF, TEAM_B, AFTERNOON, {}, SITE_N, dates, { ...patch('2026-11-06', { warnings: [WEEK_WARNING] }) }),
    row(PEOPLE.marta, LINE_B_REF, TEAM_B, DAY, { lastWorkingDay: '2026-11-05', canEdit: true }, SITE_N, dates, {
      ...patch('2026-11-06', { source: 'NONE', value: null, issue: 'AFTER_LAST_DAY', fallback: null }),
    }),
    row(PEOPLE.luca, null, null, DAY, { defaultPattern: null }, SITE_N, dates, Object.fromEntries(dates.filter((date) => !isWeekend(date)).map((date) => [date, { source: 'NONE' as const, value: null, issue: 'NO_DEFAULT' as const, fallback: null }]))),
  ]
}

const footer = (rows: readonly RosterRow[], site: Ref, line: Ref | null, dates: readonly string[]): Roster['footer'] =>
  dates.map((date) => {
    const cells = rows.filter((entry) => entry.site.id === site.id && (entry.line?.id ?? null) === (line?.id ?? null)).map((entry) => entry.cells.find((cell) => cell.date === date)!)
    const shifts = new Map<string, { label: string | null; startMinute: number; endMinute: number; people: number }>()
    for (const cell of cells) {
      if (cell.value?.kind !== 'WORK' || !cell.value.shift) continue
      const { label, startMinute, endMinute } = cell.value.shift
      const key = `${label}|${startMinute}`
      shifts.set(key, { label, startMinute, endMinute, people: (shifts.get(key)?.people ?? 0) + 1 })
    }
    return { siteId: site.id, lineId: line?.id ?? null, date, shifts: [...shifts.values()], off: cells.filter((cell) => cell.value?.kind === 'OFF').length, none: cells.filter((cell) => cell.value === null).length }
  })

export function rosterOf(range: DayRange, rows: RosterRow[], over: Partial<Roster> = {}): Roster {
  const dates = eachDay(range.from, range.to)
  const lines: Array<[Ref, Ref | null]> = [...new Map(rows.map((entry) => [`${entry.site.id}|${entry.line?.id ?? ''}`, [entry.site, entry.line] as [Ref, Ref | null]])).values()]
  const sites = [...new Map(rows.map((entry) => [entry.site.id, entry.site])).values()]
  return {
    from: range.from,
    to: range.to,
    today: TODAY,
    sites: (sites.length > 0 ? sites : [SITE_N]).map((site) => ({
      site,
      timeZone: 'Europe/Rome',
      days: dates.map((date) => ({ date, weekday: ((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7) + 1, open: !isWeekend(date), reason: isWeekend(date) ? ('WEEK' as const) : ('WORKING' as const), name: null })),
      rules: [],
      absences: { shown: true },
    })),
    choices: CHOICES,
    rows,
    footer: lines.flatMap(([site, line]) => footer(rows, site, line, dates)),
    canEdit: 'ALL',
    ...over,
  }
}

export const DEMO_ROWS = rosterRows()
export const DEMO_ROSTER = rosterOf(RANGE, DEMO_ROWS)
export const MONTH_ROSTER = rosterOf(MONTH, rosterRows(eachDay(MONTH.from, MONTH.to)))
export const SOUTH_ROW = row({ id: uid('6101', 1), name: 'Dario Fittizio', displayName: 'Dario' }, LINE_S_REF, null, DAY, {}, SITE_S)

const request = (n: number, over: Partial<OvertimeListed> = {}): OvertimeListed => ({
  id: uid('5303', n),
  companyId: uid('1001', 1),
  site: SITE_N,
  line: LINE_A_REF,
  date: '2026-11-05',
  startMinute: 840,
  minutes: 120,
  reason: 'Consegna giacche invernali (esempio)',
  status: 'ASKED',
  stage: 'ASKED',
  counts: { asked: 4, agreed: 0, declined: 0, pending: 4 },
  askedAt: '2026-11-02T08:30:00.000Z',
  askedBy: 'Anna Esempio',
  approvedAt: null,
  approvedBy: null,
  doneAt: null,
  cancelledAt: null,
  cancelReason: null,
  createdBy: 'Anna Esempio',
  version: 2,
  checks: { warn: 0, block: 0 },
  ...over,
})

export const REQUESTS: OvertimeListed[] = [
  request(1, { date: '2026-11-04', status: 'APPROVED', stage: 'APPROVED', counts: { asked: 3, agreed: 2, declined: 1, pending: 0 }, approvedAt: '2026-11-02T09:00:00.000Z', approvedBy: 'Anna Esempio', version: 5 }),
  request(2, { status: 'ASKED', stage: 'AGREED', counts: { asked: 4, agreed: 2, declined: 1, pending: 1 }, checks: { warn: 1, block: 0 } }),
  request(3, { date: '2026-11-06', line: LINE_B_REF, minutes: 90, startMinute: null, reason: 'Recupero ritardo pantaloni (esempio)', checks: { warn: 0, block: 1 } }),
  request(4, { date: '2026-11-07', status: 'DRAFT', stage: 'DRAFT', line: null, counts: { asked: 2, agreed: 0, declined: 0, pending: 2 }, askedAt: null, askedBy: null, version: 1, reason: 'Sabato inventario (esempio)' }),
  request(5, { date: '2026-10-30', status: 'CANCELLED', stage: 'CANCELLED', counts: { asked: 3, agreed: 0, declined: 0, pending: 3 }, cancelledAt: '2026-10-29T12:00:00.000Z', cancelReason: 'Ordine spostato (esempio)' }),
]

const asked = (over: Partial<OvertimeRecord['people'][number]> & { employeeId: string; name: string }): OvertimeRecord['people'][number] => ({ agreementId: `${over.employeeId}-a`, displayName: over.name.split(' ')[0]!, answer: 'PENDING', answeredAt: null, via: null, recordedBy: null, version: 1, checks: [], ...over })

const peopleAsked = [
  asked({ employeeId: PEOPLE.giulia.id, name: PEOPLE.giulia.name, answer: 'AGREED', answeredAt: '2026-11-02T09:10:00.000Z', via: 'FLOOR' }),
  asked({ employeeId: PEOPLE.paolo.id, name: PEOPLE.paolo.name, answer: 'AGREED', answeredAt: '2026-11-02T09:25:00.000Z', via: 'OFFICE', recordedBy: 'Anna Esempio', checks: [{ ...REST_WARNING, isNew: true }] }),
  asked({ employeeId: PEOPLE.sara.id, name: PEOPLE.sara.name, answer: 'DECLINED', answeredAt: '2026-11-02T09:30:00.000Z', via: 'FLOOR' }),
  asked({ employeeId: PEOPLE.ion.id, name: PEOPLE.ion.name, checks: [{ ...CAP_WARNING }] }),
]

export function recordOf(listed: OvertimeListed, over: Partial<OvertimeRecord> = {}): OvertimeRecord {
  const { checks: _checks, ...requestOnly } = listed
  return { request: requestOnly, people: peopleAsked, canManage: true, canApprove: true, today: TODAY, ...over }
}

export const PREVIEW: PlanPreview = {
  changes: [
    { employeeId: PEOPLE.paolo.id, name: PEOPLE.paolo.name, date: '2026-11-03', from: work(MORNING), fromSource: 'DEFAULT', to: work(AFTERNOON), toSource: 'ROSTER' },
    { employeeId: PEOPLE.paolo.id, name: PEOPLE.paolo.name, date: '2026-11-04', from: work(MORNING), fromSource: 'DEFAULT', to: work(AFTERNOON), toSource: 'ROSTER' },
    { employeeId: PEOPLE.sara.id, name: PEOPLE.sara.name, date: '2026-11-03', from: work(MORNING), fromSource: 'DEFAULT', to: work(AFTERNOON), toSource: 'ROSTER' },
  ],
  skipped: [
    { employeeId: PEOPLE.sara.id, name: PEOPLE.sara.name, date: '2026-11-05', why: 'ABSENT' },
    { employeeId: PEOPLE.paolo.id, name: PEOPLE.paolo.name, date: '2026-11-07', why: 'CLOSED' },
  ],
  warnings: [{ employeeId: PEOPLE.paolo.id, name: PEOPLE.paolo.name, warning: { ...REST_WARNING, isNew: true } }],
  blocked: 0,
  people: 2,
  absences: { shown: true },
}

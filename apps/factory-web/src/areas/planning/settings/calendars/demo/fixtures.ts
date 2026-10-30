import { createElement, type ReactNode } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { permissionCheck } from '../../../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, OWNER_PERMISSIONS } from '../../../../../shell/design-data'
import { officeNavFor } from '../../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../../shell/office/view/OfficeShellView'
import type { Calendar, CalendarDayRow, CalendarScope, OwnerRef, Pattern, PlanningSite, SiteLanes, WorkingTime } from '../../api'
import { settingsCan, type SettingsCan } from '../../model'

/**
 * Made-up data for the design cases of Calendars & shifts (SCR-124) and its print (SCR-124-print): an invented company
 * "Atelier Demo Srl" with two plants, two lines and two workshops, four shift patterns, the Italian public holidays of
 * 2026 on the company calendar, the August and Christmas closures on Plant 1, and Line 2's own days (Saturday mornings,
 * an overhaul, a short day, open on the Immacolata for a rush order). Never real business data. `workingTimeOf` resolves
 * the days the way the calendars service does (the most specific calendar with a day decides; else the week of the most
 * specific calendar; the pattern of the day, else the first calendar with one, else the default).
 */

export const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const AT = '2026-10-20T08:30:00.000Z'
export const PREFIX = '/w/DEMO'
export const COMPANY = DEMO_COMPANIES[0].id
export const COMPANY_NAME = 'Atelier Demo Srl'

export const PLANT_1: PlanningSite = { id: uid('5901', 1), companyId: COMPANY, code: 'P1', name: 'Plant 1', kind: 'PLANT', timeZone: 'Europe/Rome' }
export const PLANT_2: PlanningSite = { id: uid('5901', 2), companyId: COMPANY, code: 'P2', name: 'Plant 2', kind: 'PLANT', timeZone: 'Europe/Rome' }

const lane = (kind: 'LINE' | 'WORK_CENTRE', n: number, code: string, name: string, stations: number) => ({
  kind,
  id: uid(kind === 'LINE' ? '5902' : '5903', n),
  code,
  name,
  workCentreKind: kind === 'LINE' ? null : code === 'CUT' ? 'CUTTING' : 'FINISHING',
  stations,
  capacity: null,
  effective: { efficiencyPct: '85.00', efficiencySource: 'SITE' as const, people: stations, peopleSource: 'STATIONS' as const },
  actual: null,
})
export const LANES: SiteLanes = {
  site: PLANT_1,
  defaultEfficiencyPct: '85.00',
  defaultEfficiencySource: 'SITE',
  lines: [lane('LINE', 1, 'L1', 'Line 1', 8), lane('LINE', 2, 'L2', 'Line 2', 6)],
  workCentres: [lane('WORK_CENTRE', 1, 'CUT', 'Cutting', 3), lane('WORK_CENTRE', 2, 'FIN', 'Finishing', 2)],
}
export const [LINE_1, LINE_2] = LANES.lines as [SiteLanes['lines'][number], SiteLanes['lines'][number]]

// ---- shift patterns -------------------------------------------------------------------------------------------------

type Seg = [weekday: number, kind: 'SHIFT' | 'BREAK', label: string | null, start: number, end: number]
const hm = (minute: number) => `${String(Math.floor((minute % 1440) / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
function pattern(n: number, code: string, name: string, segs: Seg[], calendars: number, companyId: string | null = null): Pattern {
  const segments = segs.map(([weekday, kind, label, start, end], index) => ({ id: uid('5904', n * 100 + index), weekday, kind, label, startMinute: start, endMinute: end, start: hm(start), end: hm(end) }))
  const weekdays = [1, 2, 3, 4, 5, 6, 7].flatMap((weekday) => {
    const shifts = segments.filter((segment) => segment.weekday === weekday && segment.kind === 'SHIFT')
    if (shifts.length === 0) return []
    const breaks = segments.filter((segment) => segment.weekday === weekday && segment.kind === 'BREAK').reduce((sum, segment) => sum + segment.endMinute - segment.startMinute, 0)
    const total = shifts.reduce((sum, segment) => sum + segment.endMinute - segment.startMinute, 0) - breaks
    return [{ weekday, minutes: total, shifts: shifts.map((shift) => ({ label: shift.label, startMinute: shift.startMinute, endMinute: shift.endMinute, minutes: shift.endMinute - shift.startMinute })) }]
  })
  return {
    id: uid('5905', n),
    companyId,
    code,
    name,
    description: null,
    status: 'ACTIVE',
    segments,
    weekdays,
    weeklyMinutes: weekdays.reduce((sum, day) => sum + day.minutes, 0),
    shiftEnds: [...new Set(segments.filter((segment) => segment.kind === 'SHIFT').map((segment) => hm(segment.endMinute)))],
    calendars,
    version: 2,
    updatedAt: AT,
  }
}
const weekdays5 = [1, 2, 3, 4, 5]
export const ONE_SHIFT = pattern(1, 'ONE-SHIFT', 'One shift', weekdays5.flatMap((d): Seg[] => [[d, 'SHIFT', null, 480, 1020], [d, 'BREAK', 'Lunch', 720, 780]]), 0)
export const TWO_SHIFTS = pattern(2, 'TWO-SHIFTS', 'Two shifts', weekdays5.flatMap((d): Seg[] => [[d, 'SHIFT', 'Morning', 360, 840], [d, 'SHIFT', 'Afternoon', 840, 1320], [d, 'BREAK', null, 600, 615], [d, 'BREAK', null, 1080, 1095]]), 1, COMPANY)
export const SATURDAY = pattern(3, 'SAT-MORNING', 'Saturday morning', [[6, 'SHIFT', 'Morning', 360, 720]], 0, COMPANY)
export const SHORT = pattern(4, 'SHORT-DAY', 'Short day', weekdays5.map((d): Seg => [d, 'SHIFT', 'Morning', 360, 660]), 0, COMPANY)
export const PATTERNS: Pattern[] = [ONE_SHIFT, TWO_SHIFTS, SATURDAY, SHORT]

// ---- calendars and their days -----------------------------------------------------------------------------------------

const ref = (p: Pattern) => ({ id: p.id, code: p.code, name: p.name, status: p.status })
function calendar(n: number, scope: CalendarScope, owner: { code: string; name: string }, ids: Partial<Calendar>, shiftPattern: Pattern | null, exceptions: number): Calendar {
  return { id: uid('5906', n), scope, companyId: COMPANY, siteId: null, lineId: null, workCentreId: null, partyId: null, owner, name: owner.name, workingWeekdays: weekdays5, shiftPattern: shiftPattern ? ref(shiftPattern) : null, status: 'ACTIVE', exceptions, version: 4, updatedAt: AT, ...ids }
}

let dayN = 0
const day = (date: string, kind: CalendarDayRow['kind'], name: string, p: Pattern | null = null, set: string | null = null, note: string | null = null): CalendarDayRow => ({ id: uid('5907', ++dayN), date, kind, name, shiftPattern: p ? ref(p) : null, note, holidaySet: set, version: 1, updatedAt: AT })
const span = (from: number, to: number, month: string, name: string, skip: number[] = []) => Array.from({ length: to - from + 1 }, (_, i) => from + i).filter((d) => !skip.includes(d)).map((d) => day(`2026-${month}-${String(d).padStart(2, '0')}`, 'CLOSURE', name))

const HOLIDAYS_2026: [string, string][] = [
  ['2026-01-01', 'Capodanno'],
  ['2026-01-06', 'Epifania'],
  ['2026-04-05', 'Pasqua'],
  ['2026-04-06', "Lunedì dell'Angelo"],
  ['2026-04-25', 'Festa della Liberazione'],
  ['2026-05-01', 'Festa del Lavoro'],
  ['2026-06-02', 'Festa della Repubblica'],
  ['2026-08-15', 'Ferragosto'],
  ['2026-10-04', 'San Francesco'],
  ['2026-11-01', 'Ognissanti'],
  ['2026-12-08', 'Immacolata Concezione'],
  ['2026-12-25', 'Natale'],
  ['2026-12-26', 'Santo Stefano'],
]
export const COMPANY_DAYS: CalendarDayRow[] = [...HOLIDAYS_2026.map(([date, name]) => day(date, 'HOLIDAY', name, null, 'IT')), day('2026-06-13', 'HOLIDAY', 'Santo patrono')]
export const SITE_DAYS: CalendarDayRow[] = [...span(10, 21, '08', 'Chiusura estiva', [15, 16]), ...span(24, 31, '12', 'Chiusura natalizia', [25, 26, 27])]
export const LINE_2_DAYS: CalendarDayRow[] = [
  day('2026-08-07', 'WORKING', 'Pomeriggio di inventario', SHORT),
  day('2026-09-15', 'CLOSURE', 'Revisione macchine'),
  day('2026-09-26', 'WORKING', 'Sabato mattina', SATURDAY),
  day('2026-11-07', 'WORKING', 'Picco ordini invernali', SATURDAY),
  day('2026-12-08', 'WORKING', 'Ordine urgente', null, null, 'Agreed with the RSU on 2 Nov.'),
]

export const COMPANY_CAL = calendar(1, 'COMPANY', { code: 'DEMO', name: COMPANY_NAME }, {}, null, COMPANY_DAYS.length)
export const SITE_CAL = calendar(2, 'SITE', { code: PLANT_1.code, name: PLANT_1.name }, { siteId: PLANT_1.id }, TWO_SHIFTS, SITE_DAYS.length)
export const LINE_2_CAL = calendar(3, 'LINE', { code: LINE_2.code, name: LINE_2.name }, { siteId: PLANT_1.id, lineId: LINE_2.id }, null, LINE_2_DAYS.length)
export const CALENDARS: Calendar[] = [COMPANY_CAL, SITE_CAL, LINE_2_CAL]
const DAYS_OF: Record<string, CalendarDayRow[]> = { [COMPANY_CAL.id]: COMPANY_DAYS, [SITE_CAL.id]: SITE_DAYS, [LINE_2_CAL.id]: LINE_2_DAYS }

// ---- the resolver (the service's rules, for made-up data) ---------------------------------------------------------------

const DEFAULT_PATTERN = { id: 'DEFAULT', code: 'DEFAULT', name: 'Planning default', source: 'DEFAULT' as const, calendarId: null }
const isoWeekday = (date: string) => ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1
/** Europe/Rome in 2026: summer time from 29 March to 25 October. */
const offsetOf = (date: string) => (date >= '2026-03-29' && date < '2026-10-25' ? '+02:00' : '+01:00')
const instant = (date: string, minute: number) => {
  const next = minute >= 1440
  const base = next ? new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : date
  return new Date(`${base}T${hm(minute)}:00${offsetOf(base)}`).toISOString()
}

/** The chain of an owner among the made-up calendars, most specific first. */
export function chainFor(owner: OwnerRef, calendars: readonly Calendar[] = CALENDARS): Calendar[] {
  const company = calendars.find((entry) => entry.scope === 'COMPANY' && entry.status === 'ACTIVE')
  const site = calendars.find((entry) => entry.scope === 'SITE' && entry.siteId === PLANT_1.id && entry.status === 'ACTIVE')
  const own = calendars.find((entry) => entry.status === 'ACTIVE' && entry.scope === owner.scope && (entry.lineId ?? entry.workCentreId ?? entry.siteId ?? entry.companyId) === owner.id)
  const above = owner.scope === 'COMPANY' ? [] : owner.scope === 'SITE' ? [company] : [site, company]
  return [own, ...above].filter((entry, index, list): entry is Calendar => !!entry && list.indexOf(entry) === index)
}

export function workingTimeOf(owner: OwnerRef, year = 2026, calendars: readonly Calendar[] = CALENDARS, daysOf: Readonly<Record<string, CalendarDayRow[]>> = DAYS_OF): WorkingTime {
  const chain = chainFor(owner, calendars)
  const withPattern = chain.find((entry) => entry.shiftPattern)
  const basePattern = withPattern ? PATTERNS.find((entry) => entry.id === withPattern.shiftPattern!.id)! : ONE_SHIFT
  const days: WorkingTime['days'] = []
  for (let time = Date.UTC(year, 0, 1); time <= Date.UTC(year, 11, 31); time += 86_400_000) {
    const date = new Date(time).toISOString().slice(0, 10)
    const weekday = isoWeekday(date)
    const decided = chain.map((entry) => ({ entry, row: (daysOf[entry.id] ?? []).find((row) => row.date === date) })).find((hit) => hit.row)
    const week = chain[0]?.workingWeekdays ?? weekdays5
    const reason = decided ? (decided.row!.kind === 'WORKING' ? 'WORKING' : decided.row!.kind) : week.includes(weekday) ? 'WEEK' : 'DAY_OFF'
    const open = reason === 'WEEK' || reason === 'WORKING'
    const own = decided?.row?.shiftPattern ? PATTERNS.find((entry) => entry.id === decided.row!.shiftPattern!.id)! : null
    const usePattern = own ?? basePattern
    const shiftsOfDay = usePattern.weekdays.find((entry) => entry.weekday === weekday) ?? (reason === 'WORKING' ? usePattern.weekdays[0] : undefined)
    const minutes = open && shiftsOfDay ? shiftsOfDay.minutes : 0
    days.push({
      date,
      weekday,
      open,
      working: open && minutes > 0,
      reason,
      name: decided?.row?.name ?? null,
      decidedBy: decided ? { calendarId: decided.entry.id, scope: decided.entry.scope } : null,
      pattern: open ? (own ? { id: own.id, code: own.code, name: own.name, source: 'DAY', calendarId: decided!.entry.id } : withPattern ? { id: basePattern.id, code: basePattern.code, name: basePattern.name, source: 'CALENDAR', calendarId: withPattern.id } : DEFAULT_PATTERN) : null,
      minutes: open ? minutes : 0,
      shifts: open && shiftsOfDay ? shiftsOfDay.shifts.map((shift) => ({ label: shift.label, start: instant(date, shift.startMinute), end: instant(date, shift.endMinute), minutes: shift.minutes })) : [],
      issue: open && !shiftsOfDay && reason === 'WEEK' ? 'NO_SHIFTS' : null,
    })
  }
  return {
    owner: { scope: owner.scope, id: owner.id, code: '', name: '', companyId: COMPANY, siteId: owner.scope === 'COMPANY' ? null : PLANT_1.id, timeZone: 'Europe/Rome', calendars: chain.map((entry) => ({ id: entry.id, scope: entry.scope, name: entry.name })) },
    from: `${year}-01-01`,
    to: `${year}-12-31`,
    workingDays: days.filter((entry) => entry.working).length,
    minutes: days.reduce((sum, entry) => sum + (entry.minutes ?? 0), 0),
    days,
  }
}

export const detailOf = (calendar: Calendar, calendars: readonly Calendar[] = CALENDARS) => ({ calendar, above: chainFor({ scope: calendar.scope as OwnerRef['scope'], id: calendar.lineId ?? calendar.workCentreId ?? calendar.siteId ?? calendar.companyId! }, calendars).slice(1), from: '2026-01-01', to: '2026-12-31', days: DAYS_OF[calendar.id] ?? [] })

// ---- roles and the shell -----------------------------------------------------------------------------------------------

const template = (key: string): string[] => [...(templateOf(key)?.permissions ?? []), 'home.view']
export const ROLES = {
  planner: [...template('planner'), 'audit.read'],
  owner: [...OWNER_PERMISSIONS, ...template('planner'), 'audit.read'],
  buyer: template('buyer'),
  production: template('production_manager'),
  readOnly: [...(templateOf('read_only')?.permissions ?? []), 'home.view'],
} as const
export type Role = keyof typeof ROLES
export const canOf = (role: Role): SettingsCan => settingsCan(ROLES[role])

export function inShell(page: ReactNode, role: Role, path = '/planning/settings'): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck([...ROLES[role]])),
    path,
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

import { eachDay, isoWeekday } from '../../calendars/dates'
import type { BusinessDate } from '../../core/time'
import { monthLabel } from '../../accounting/periods'
import { csvText } from '../../views/exports'
import { monthPeriod } from '../overtime/timesheets'
import type { OvertimeClass } from '../overtime/rules'

/**
 * The LUL attendance calendar of a closed month (B-W2b-48; MES-231; design people.attendance new tab "LUL calendar (PDF)"), in
 * its GENERIC form. D.L. 112/2008 art. 39 c.2 asks, for each worker and each day, the hours worked, the overtime, the
 * absences (paid or not), the holidays and the rest days. The labour consultant keeps the Libro Unico; Nexus gives the
 * calendar of presence. Pure: what it says is decided here, apps/factory-api paints the PDF and stores the CSV.
 *
 * Italian only: one sealed document, for the consultant. Hours are decimal hours with a comma, per day and in sum (the sum
 * adds the minutes, never the rounded hours). The same facts give the same document, so a seal can be checked.
 *
 * WHAT THE LABOUR CONSULTANT MUST CONFIRM (GATE-PAYROLL), all in `LUL_TO_CONFIRM`.
 */

export const LUL_TO_CONFIRM: readonly string[] = Object.freeze([
  'The layout of the calendar, PDF and CSV (this one is generic).',
  'Their absence code per absence (AbsenceCode.lulCode): until then the calendar prints our own code.',
  'How a rest day is marked: R stands on any day with no presence, no absence and no planned shift.',
  'Decimal hours (7,50) rather than hours and minutes.',
  'That approved overtime goes by class (day, night, holiday), with night and holiday hours shown as "of which".',
  'Whether agency and external people belong on this calendar (they are marked, not left out).',
  'How long our copy is kept (five years here).',
])

export interface LulDay {
  readonly date: BusinessDate
  readonly plannedWork: boolean
  readonly presence: boolean
  /** Entered or fixed by hand: marked for good (MES-238). */
  readonly manual: boolean
  readonly ordinaryMinutes: number
  readonly nightMinutes: number
  readonly holidayMinutes: number
  /** APPROVED overtime only. */
  readonly overtime: Readonly<Record<OvertimeClass, number>>
  readonly absences: readonly { readonly code: string; readonly lulCode: string | null; readonly minutes: number }[]
}

export interface LulPerson {
  readonly employeeCode: string | null
  readonly name: string
  readonly kind: 'EMPLOYEE' | 'AGENCY' | 'EXTERNAL'
  readonly days: readonly LulDay[]
}

export interface LulFacts {
  readonly company: { readonly code: string; readonly legalName: string; readonly vatNumber: string | null }
  readonly month: string
  readonly closedAt: Date
  readonly closedOn: BusinessDate
  readonly closedBy: string | null
  /** In the order they print: by name, then code. */
  readonly people: readonly LulPerson[]
}

export interface LulRow {
  readonly label: string
  /** One cell per day of the month. */
  readonly cells: readonly string[]
  readonly sum: string
}

export interface LulBlock {
  readonly title: string
  readonly note: string | null
  readonly rows: readonly LulRow[]
}

export interface LulCalendar {
  readonly title: string
  readonly heading: string
  readonly facts: readonly string[]
  readonly days: readonly { readonly day: string; readonly weekday: string }[]
  readonly blocks: readonly LulBlock[]
  readonly legend: string
  readonly foot: string
  readonly pageLabel: string
  readonly fileName: string
  readonly createdAt: Date
}

const WEEKDAYS = ['L', 'M', 'M', 'G', 'V', 'S', 'D'] as const
const KIND_NOTES: Readonly<Record<LulPerson['kind'], string | null>> = Object.freeze({ EMPLOYEE: null, AGENCY: 'somministrato', EXTERNAL: 'esterno' })
const OVERTIME_ROWS: readonly (readonly [OvertimeClass, string, string])[] = [
  ['DAY', 'Straord. diurno', 'STRAORDINARIO_DIURNO'],
  ['NIGHT', 'Straord. notturno', 'STRAORDINARIO_NOTTURNO'],
  ['HOLIDAY', 'Straord. festivo', 'STRAORDINARIO_FESTIVO'],
]

/** Minutes as decimal hours with a comma (450 → "7,50"); nothing for no minutes. */
export function hoursText(minutes: number): string {
  if (minutes === 0) return ''
  const hundredths = Math.round((minutes * 100) / 60)
  return `${Math.trunc(hundredths / 100)},${String(hundredths % 100).padStart(2, '0')}`
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0)

const monthDays = (month: string): BusinessDate[] => {
  const period = monthPeriod(month)
  return period ? eachDay(period.periodStart, period.periodEnd) : []
}

const absenceKey = (absence: { readonly code: string; readonly lulCode: string | null }): string => absence.lulCode ?? absence.code

function blockOf(person: LulPerson, dates: readonly BusinessDate[]): LulBlock {
  const byDate = new Map(person.days.map((day) => [day.date, day]))
  const row = (label: string, minutesOf: (day: LulDay) => number): LulRow => {
    const minutes = dates.map((date) => { const day = byDate.get(date); return day ? minutesOf(day) : 0 })
    return { label, cells: minutes.map(hoursText), sum: hoursText(sum(minutes)) }
  }
  const ordinaryCells = dates.map((date) => {
    const day = byDate.get(date)
    if (day && day.ordinaryMinutes > 0) return hoursText(day.ordinaryMinutes)
    // Rest: nothing recorded and nothing planned (the consultant confirms this mark).
    return !day || (!day.plannedWork && !day.presence && day.absences.length === 0) ? 'R' : ''
  })
  const rows: LulRow[] = [{ label: 'Ore ordinarie', cells: ordinaryCells, sum: hoursText(sum(person.days.map((day) => day.ordinaryMinutes))) }]
  for (const [kind, label] of OVERTIME_ROWS) if (person.days.some((day) => day.overtime[kind] > 0)) rows.push(row(label, (day) => day.overtime[kind]))
  if (person.days.some((day) => day.nightMinutes > 0)) rows.push(row('di cui notturne', (day) => day.nightMinutes))
  if (person.days.some((day) => day.holidayMinutes > 0)) rows.push(row('di cui festive', (day) => day.holidayMinutes))
  const codes = [...new Set(person.days.flatMap((day) => day.absences.map(absenceKey)))].sort()
  for (const code of codes) rows.push(row(`Assenza ${code}`, (day) => sum(day.absences.filter((absence) => absenceKey(absence) === code).map((absence) => absence.minutes))))
  if (person.days.some((day) => day.manual)) rows.push({ label: 'Note', cells: dates.map((date) => (byDate.get(date)?.manual ? 'M' : '')), sum: '' })
  return { title: `${person.name}${person.employeeCode ? ` (matr. ${person.employeeCode})` : ''}`, note: KIND_NOTES[person.kind], rows }
}

const monthWords = (month: string): string => monthLabel(month, 'it')
const italianDay = (date: BusinessDate): string => `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`

/** The calendar as the PDF prints it. */
export function lulCalendar(facts: LulFacts): LulCalendar {
  const dates = monthDays(facts.month)
  return {
    title: 'Calendario delle presenze',
    heading: `${facts.company.legalName} · ${monthWords(facts.month)}`,
    facts: [
      ...(facts.company.vatNumber ? [`P. IVA ${facts.company.vatNumber}`] : []),
      `Mese chiuso il ${italianDay(facts.closedOn)}${facts.closedBy ? ` da ${facts.closedBy}` : ''}`,
      `Persone: ${facts.people.length}`,
    ],
    days: dates.map((date) => ({ day: String(Number(date.slice(8, 10))), weekday: WEEKDAYS[isoWeekday(date) - 1]! })),
    blocks: facts.people.map((person) => blockOf(person, dates)),
    legend: 'R = riposo o giorno non lavorato (nessuna presenza né assenza registrata). M = giorno con inserimento manuale. Ore in centesimi. Straordinario: solo quello approvato.',
    foot: 'Calendario delle presenze per il Libro Unico del Lavoro (D.L. 112/2008 art. 39). Formato generico, da confermare con il consulente del lavoro.',
    pageLabel: 'Pagina {page} di {pages}',
    fileName: `LUL_${facts.company.code}_${facts.month}.pdf`.replace(/[^A-Za-z0-9._-]+/g, '-'),
    createdAt: facts.closedAt,
  }
}

export const LUL_CSV_HEADER = ['Matricola', 'Lavoratore', 'Tipo', 'Data', 'Voce', 'Codice', 'Ore', 'Minuti', 'Manuale'] as const

const OVERTIME_VOICES = new Map(OVERTIME_ROWS.map(([kind, , voice]) => [kind, voice]))

/** One row per person, day and voice that has minutes. */
export function lulCsvRows(facts: LulFacts): string[][] {
  return facts.people.flatMap((person) =>
    [...person.days]
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      .flatMap((day) => {
        const line = (voice: string, code: string, minutes: number): string[] => [person.employeeCode ?? '', person.name, person.kind, day.date, voice, code, hoursText(minutes), String(minutes), day.manual ? 'SI' : 'NO']
        return [
          ...(day.ordinaryMinutes > 0 ? [line('ORDINARIE', '', day.ordinaryMinutes)] : []),
          ...[...OVERTIME_VOICES].flatMap(([kind, voice]) => (day.overtime[kind] > 0 ? [line(voice, '', day.overtime[kind])] : [])),
          ...(day.nightMinutes > 0 ? [line('DI_CUI_NOTTURNE', '', day.nightMinutes)] : []),
          ...(day.holidayMinutes > 0 ? [line('DI_CUI_FESTIVE', '', day.holidayMinutes)] : []),
          ...day.absences.filter((absence) => absence.minutes > 0).map((absence) => line('ASSENZA', absenceKey(absence), absence.minutes)),
        ]
      }),
  )
}

/** The CSV of the calendar (a UTF-8 BOM, `;`, the decimal comma; one note line above the header). */
export function lulCsv(facts: LulFacts): { readonly text: string; readonly fileName: string; readonly rows: number } {
  const rows = lulCsvRows(facts)
  const note = `${facts.company.code} ${facts.company.legalName} · ${monthWords(facts.month)} · calendario delle presenze · formato generico (da confermare con il consulente del lavoro)`
  return { text: csvText({ locale: 'it', header: LUL_CSV_HEADER, rows, note }), fileName: `LUL_${facts.company.code}_${facts.month}.csv`.replace(/[^A-Za-z0-9._-]+/g, '-'), rows: rows.length }
}

import type { SectionSpec } from '@nexus/ui/patterns'
import { isApiError, issuePath } from '../../../lib/api/errors'
import { formatNumber } from '../../../lib/i18n/format'
import { INTL_LOCALE, type Locale } from '../../../lib/i18n/locales'
import { hoursText, problemOf, type Words } from '../_shared/model'
import type { AttendanceReport, DayCells, DayRecord, DifferenceCell, EarningsReport, EarningsWorkers, GroupFigures, GroupRow, MatchState, ReportGroup } from './api'

/**
 * The pure rules of People › People reports (B-W2b-64, SCR-264): what this person may do, the address, months, the rows of the
 * two reports, the match check in words, and the files. Lines, teams and months; the earnings per worker is the one list
 * that names people: it needs the right, every opening is recorded by the API, it stays in the page's state, and it goes
 * into no address, no file and no print.
 */

// ---- rights ------------------------------------------------------------------------------------------------------------------

export interface ReportsCan {
  /** people.attendance.view: the attendance report. */
  attendance: boolean
  /** people.earnings.view: the earnings report's page part. */
  earnings: boolean
  /** money.pay: the figures of the earnings report (the design's wages grain). */
  pay: boolean
  /** people.earnings.records + money.pay: per worker. */
  records: boolean
  /** people.privacy.view: People settings (the gates, the minimum group size). */
  settings: boolean
}

export function reportsCan(permissions: readonly string[]): ReportsCan {
  const held = new Set(permissions)
  const pay = held.has('money.pay')
  return { attendance: held.has('people.attendance.view'), earnings: held.has('people.earnings.view'), pay, records: pay && held.has('people.earnings.records'), settings: held.has('people.privacy.view') }
}

// ---- the address -------------------------------------------------------------------------------------------------------------

export const EARNINGS_VIEWS = ['line', 'month', 'worker'] as const
export type EarningsView = (typeof EARNINGS_VIEWS)[number]

export interface ReportsAddress {
  month: string | null
  /** The earnings report's last month (default: the same month). */
  to: string | null
  group: ReportGroup
  teamId: string | null
  /** "worker" is not an address term: it is a recorded opening, made by a click. */
  earnings: Exclude<EarningsView, 'worker'>
}

const monthOr = (value: string | null | undefined): string | null => (value && /^\d{4}-\d{2}$/.test(value) ? value : null)

export function reportsAddressOf(params: { get(name: string): string | null } | null): ReportsAddress {
  return {
    month: monthOr(params?.get('month')),
    to: monthOr(params?.get('to')),
    group: params?.get('group') === 'team' ? 'team' : 'line',
    teamId: params?.get('team') || null,
    earnings: params?.get('earnings') === 'month' ? 'month' : 'line',
  }
}

export function reportsAddressText(address: ReportsAddress): string {
  const terms = new URLSearchParams()
  if (address.month) terms.set('month', address.month)
  if (address.to) terms.set('to', address.to)
  if (address.group !== 'line') terms.set('group', address.group)
  if (address.teamId) terms.set('team', address.teamId)
  if (address.earnings !== 'line') terms.set('earnings', address.earnings)
  const text = terms.toString()
  return text ? `?${text}` : ''
}

export const reportsPrintHref = (prefix: string, address: ReportsAddress): string => `${prefix}/people/reports/print${reportsAddressText(address)}`

// ---- sections (Arrange) ------------------------------------------------------------------------------------------------------

export const REPORT_SECTIONS = ['privacy', 'attendance', 'earnings'] as const
export type ReportSection = (typeof REPORT_SECTIONS)[number]
export const LAYOUT_KEY = 'people.reports.layout'
export const sectionSpecs = (label: (id: string) => string): SectionSpec[] => REPORT_SECTIONS.map((id) => ({ id, label: label(id), defaultWidth: 'full', ...(id === 'privacy' ? { locked: true } : {}) }))

// ---- months ------------------------------------------------------------------------------------------------------------------

export const monthOf = (now: Date): string => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

/** This month and the `count - 1` before it, newest first. */
export function monthChoices(today: string, count = 24): string[] {
  const [year, month] = today.split('-').map(Number) as [number, number]
  return Array.from({ length: count }, (_, back) => {
    const at = new Date(Date.UTC(year, month - 1 - back, 1))
    return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`
  })
}

export const monthText = (month: string, locale: Locale): string => new Intl.DateTimeFormat(INTL_LOCALE[locale], { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-15T12:00:00Z`))

/** The earnings range: never backwards. */
export const earningsRange = (month: string, to: string | null): { from: string; to: string } => ({ from: month, to: to && to >= month ? to : month })

// ---- the attendance report ---------------------------------------------------------------------------------------------------

export const groupLabel = (row: Pick<GroupRow, 'code' | 'name'>): string | null => (row.code || row.name ? [row.code, row.name].filter(Boolean).join(' · ') : null)

/** `/` searches inside the report's grid: its row names, as typed. */
export const matches = (label: string | null, q: string): boolean => (label ?? '').toLowerCase().includes(q.trim().toLowerCase())

/** Every absence code of the shown groups, in code order: a column each. */
export const absenceCodes = (groups: readonly Pick<GroupRow, 'figures'>[]): string[] => [...new Set(groups.flatMap((row) => row.figures?.absences.map((entry) => entry.code) ?? []))].sort()

export const absenceMinutes = (figures: GroupFigures | null, code: string): number | null => (figures ? (figures.absences.find((entry) => entry.code === code)?.minutes ?? 0) : null)

export const hours = (minutes: number | null | undefined, locale: Locale): string => (minutes === null || minutes === undefined ? '—' : (hoursText(minutes, locale) ?? '—'))

export type MatchTone = 'success' | 'warning' | 'neutral'
export const MATCH_TONE: Readonly<Record<MatchState, MatchTone>> = { NOT_CLOSED: 'neutral', NOT_SEALED: 'warning', MATCHES: 'success', DIFFERS: 'warning' }

export const matchWords = (match: AttendanceReport['match'], month: string, locale: Locale): Words => ({ key: `match.${match.state}`, params: { month: monthText(month, locale), count: match.cells } })

/** The cells that differ, day by day: the row opens that day's record. */
export const differenceKey = (cell: DifferenceCell): string => `${cell.dayId}:${cell.kind}:${cell.absenceCode ?? ''}`

/** A kind of cell of a closed day, closed and now (the record shows only what differs, and what the design names). */
export function cellMinutes(cells: DayCells, kind: DifferenceCell['kind'], code: string | null): number {
  switch (kind) {
    case 'PRESENT':
      return cells.presentMinutes
    case 'ORDINARY':
      return cells.ordinaryMinutes
    case 'NIGHT':
      return cells.nightMinutes
    case 'HOLIDAY':
      return cells.holidayMinutes
    case 'OVERTIME_DAY':
      return cells.overtimeDayMinutes
    case 'OVERTIME_NIGHT':
      return cells.overtimeNightMinutes
    case 'OVERTIME_HOLIDAY':
      return cells.overtimeHolidayMinutes
    case 'ABSENCE':
      return cells.absences.find((entry) => entry.code === code)?.minutes ?? 0
  }
}

/** Each cell a day's corrections touched, once (a cell corrected twice shows closed → now one time). */
export const changedCells = (day: Pick<DayRecord, 'corrections'>): { kind: DifferenceCell['kind']; absenceCode: string | null }[] => [...new Map(day.corrections.map((entry) => [`${entry.kind}:${entry.absenceCode ?? ''}`, { kind: entry.kind, absenceCode: entry.absenceCode }])).values()]

// ---- the earnings report -----------------------------------------------------------------------------------------------------

export interface EarningsRow {
  id: string
  label: string | null
  people: number | null
  pieces: string | null
  earnings: number | null
  makeUp: number | null
  share: string | null
  tooFew: boolean
}

export const lineRows = (report: EarningsReport): EarningsRow[] =>
  report.lines.map((row) => ({ id: row.line?.id ?? 'none', label: row.line ? `${row.line.code} · ${row.line.name}` : null, people: row.people, pieces: row.pieces, earnings: row.earnings, makeUp: row.makeUp, share: row.makeUpSharePct, tooFew: row.tooFew }))

export const monthRows = (report: EarningsReport, locale: Locale): EarningsRow[] =>
  report.months.map((row) => ({ id: row.month, label: monthText(row.month, locale), people: row.people, pieces: row.pieces, earnings: row.earnings, makeUp: row.makeUp, share: row.makeUpSharePct, tooFew: row.tooFew }))

/** Per worker: by name as the API gives them, one person a row; nothing here sorts or ranks. */
export const workerRows = (answer: EarningsWorkers): EarningsRow[] =>
  answer.workers.map((row) => ({ id: row.employeeId, label: row.code ? `${row.name} · ${row.code}` : row.name, people: null, pieces: row.pieces, earnings: row.earnings, makeUp: row.makeUp, share: row.makeUpSharePct, tooFew: false }))

/** Minor units as an amount. The report names no currency, so none is drawn (a gap of the API, named in the notes). */
export const amountText = (minor: number | null | undefined, locale: Locale): string => (minor === null || minor === undefined ? '—' : formatNumber(minor / 100, locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }))

export const shareText = (value: string | null | undefined, locale: Locale): string => {
  if (value === null || value === undefined || value === '') return '—'
  const number = Number(value)
  return Number.isFinite(number) ? `${formatNumber(number, locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %` : '—'
}

export const piecesText = (value: string | null | undefined, locale: Locale): string => {
  if (value === null || value === undefined || value === '') return '—'
  const number = Number(value)
  return Number.isFinite(number) ? formatNumber(number, locale, { maximumFractionDigits: 2 }) : '—'
}

// ---- Send report -------------------------------------------------------------------------------------------------------------

export const SEND_FORMATS = ['PDF', 'CSV'] as const
export type SendFormat = (typeof SEND_FORMATS)[number]
export const SEND_EXPIRY_DAYS = [7, 14, 30] as const

export interface SendDraft {
  report: 'attendance' | 'earnings'
  recipient: string
  expiryDays: (typeof SEND_EXPIRY_DAYS)[number]
  format: SendFormat
}

export const NEW_SEND: SendDraft = { report: 'attendance', recipient: '', expiryDays: 7, format: 'PDF' }

/**
 * Why "Send link" waits (a message key). The link itself does not exist yet: B-W2b-54 brings the first secure file link for
 * the payroll file, and no link may carry a report today. Pay figures never reach a link (factory-domain links/purposes), so
 * the earnings report says that first, whatever the API later offers.
 */
export function sendHeld(draft: SendDraft): string {
  if (draft.report === 'earnings') return 'send.heldPay'
  return 'send.heldNoLink'
}

// ---- refusals and files ------------------------------------------------------------------------------------------------------

export interface ReportsProblem {
  ns: 'people-reports' | 'people'
  words: Words
}

const pathOf = (error: unknown, start: string): string | null => {
  if (!isApiError(error)) return null
  for (const issue of error.issues) {
    const path = issuePath(issue)
    if (path.startsWith(start)) return path.slice(start.length)
  }
  return null
}

export function reportsProblem(error: unknown): ReportsProblem {
  if (pathOf(error, 'gate/')) return { ns: 'people-reports', words: { key: 'attendance.gateOff' } }
  return { ns: 'people', words: problemOf(error) }
}

/** The attendance report's file: the rows the page shows, a hidden group empty with no figure to subtract. */
export function attendanceCsvRows(report: AttendanceReport, codes: readonly string[], words: { noGroup: string; tooFew: string }, locale: Locale): (string | null)[][] {
  return report.groups.map((row) => [
    groupLabel(row) ?? words.noGroup,
    row.tooFew ? words.tooFew : String(row.people ?? ''),
    ...(row.figures
      ? [hours(row.figures.ordinaryMinutes, locale), hours(row.figures.overtimeDayMinutes, locale), hours(row.figures.overtimeNightMinutes, locale), hours(row.figures.overtimeHolidayMinutes, locale), hours(row.figures.nightMinutes, locale), hours(row.figures.holidayMinutes, locale), ...codes.map((code) => hours(absenceMinutes(row.figures, code), locale))]
      : Array.from({ length: 6 + codes.length }, () => null)),
  ])
}

/** The earnings report's file: lines or months only. A list of people is never written to a file from here. */
export function earningsCsvRows(rows: readonly EarningsRow[], words: { noLine: string; tooFew: string }, locale: Locale): (string | null)[][] {
  return rows.map((row) => [row.label ?? words.noLine, row.tooFew ? words.tooFew : row.people === null ? null : String(row.people), row.tooFew ? null : piecesText(row.pieces, locale), row.tooFew ? null : amountText(row.earnings, locale), row.tooFew ? null : amountText(row.makeUp, locale), row.tooFew ? null : shareText(row.share, locale)])
}

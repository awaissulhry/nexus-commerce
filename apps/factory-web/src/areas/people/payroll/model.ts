import { PEOPLE_CHECKS } from '@nexus/factory-domain/people/payroll/checks'
import { CODE_MEANINGS, codeOrder, isFixedCode } from '@nexus/factory-domain/people/payroll/codes'
import { COLUMN_KEYS, definitionProblems, DELIMITERS, LAYOUT_LIMITS, PAYROLL_TO_CONFIRM, printsProviderCode } from '@nexus/factory-domain/people/payroll/layouts'
import { PAYROLL_LINK_TERMS, PAYROLL_REFUSALS } from '@nexus/factory-domain/people/payroll/rules'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { Locale } from '../../../lib/i18n/locales'
import { fieldOf, type Words } from '../_shared/model'
import type { ChangeRow, Check, CheckCode, CheckPlace, CodeKind, CodeRow, ColumnKey, DefinitionBody, ExportFile, ExportRecord, ExportRow, Layout, LayoutColumn, PayrollFormat, PayrollMonth, PayrollValues, PersonRow, SendBody, ValueCell } from './api'

export type { Words } from '../_shared/model'

/**
 * The pure rules of People › Payroll export (SCR-159; B-W2b-63): who may do what (from the session; the API asks again), the
 * address, the five steps and what holds each one, the month's pill, a check in words and where "Show me" goes, which layout
 * is in use and the words of one a consultant has not confirmed, the preview per employee code, the Send and CSV columns
 * drafts, and a refusal in words. Nexus does not run payroll: it makes a file for the labour consultant. By employee code,
 * never by name; a name only in "Show me", the fix list of a check, which opens with the right and is recorded.
 */

export const NAMESPACE = 'people-payroll'

// ---- rights ----------------------------------------------------------------------------------------------------------------------

export interface PayrollCan {
  /** people.payroll.view: the month, its checks as counts, the mapping, the layouts, the past exports. */
  view: boolean
  /** people.payroll.records: the values per employee code, the files, the names behind a check. */
  records: boolean
  /** people.payroll.manage: the mapping and layouts, an export, a correction, the secure link. */
  manage: boolean
  /** money.pay: amounts on the preview and the files that carry them. */
  pay: boolean
  /** people.view: "Show me" names open the employee's record. */
  people: boolean
}

export function payrollCan(permissions: readonly string[]): PayrollCan {
  const held = new Set(permissions)
  return { view: held.has('people.payroll.view'), records: held.has('people.payroll.records'), manage: held.has('people.payroll.manage'), pay: held.has('money.pay'), people: held.has('people.view') }
}

// ---- the address -----------------------------------------------------------------------------------------------------------------

export const STEPS = ['period', 'checks', 'mapping', 'preview', 'send'] as const
export type Step = (typeof STEPS)[number]

export interface PayrollAddress {
  /** `?new=1`, or a month or step in the address: the wizard is open. */
  wizard: boolean
  step: Step
  /** `?month=2026-10`; null: the month the API proposes (the one before). */
  month: string | null
  /** `?layout=<id>`: the format chosen. */
  layoutId: string | null
  /** `?year=2026`: the Exports of one year. */
  year: number | null
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/

export function payrollAddressOf(params: URLSearchParams | null): PayrollAddress {
  const month = params?.get('month') ?? null
  const step = params?.get('step') ?? null
  const year = Number(params?.get('year') ?? '')
  const known = month && MONTH.test(month) ? month : null
  return {
    wizard: params?.get('new') === '1' || known !== null || (STEPS as readonly string[]).includes(step ?? ''),
    step: (STEPS as readonly string[]).includes(step ?? '') ? (step as Step) : 'period',
    month: known,
    layoutId: params?.get('layout') || null,
    year: Number.isInteger(year) && year >= 2000 && year <= 2100 ? year : null,
  }
}

export const payrollHref = (prefix: string, year?: number | null): string => `${prefix}/people/payroll${year ? `?year=${year}` : ''}`

export function wizardHref(prefix: string, month: string | null, step: Step = 'period', layoutId?: string | null): string {
  const terms = new URLSearchParams()
  if (month) terms.set('month', month)
  else terms.set('new', '1')
  if (step !== 'period') terms.set('step', step)
  if (layoutId) terms.set('layout', layoutId)
  return `${prefix}/people/payroll?${terms.toString()}`
}

export const recordHref = (prefix: string, exportId: string): string => `${prefix}/people/payroll/${encodeURIComponent(exportId)}`
export type FileKind = 'summary' | 'data'
export const fileHref = (prefix: string, exportId: string, kind: FileKind): string => `${recordHref(prefix, exportId)}/file?kind=${kind}`
export const fileKindOf = (params: URLSearchParams | null): FileKind => (params?.get('kind') === 'data' ? 'data' : 'summary')

// ---- months ----------------------------------------------------------------------------------------------------------------------

const instantOf = (month: string): Date => new Date(`${month}-15T12:00:00.000Z`)

/** "ottobre 2026". */
export const monthWords = (month: string, locale: Locale): string => new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(instantOf(month))
/** "ottobre", for the button's words. */
export const monthName = (month: string, locale: Locale): string => new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', { month: 'long', timeZone: 'UTC' }).format(instantOf(month))

export function monthBefore(month: string): string {
  const [year = 2000, number = 1] = month.split('-').map(Number)
  const date = new Date(Date.UTC(year, number - 2, 1))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

/** The months offered in step 1: this one and the twelve before, newest first; a month in the address stays offered. */
export function monthChoices(today: string, chosen: string | null, count = 13): string[] {
  const out: string[] = []
  let month = today.slice(0, 7)
  for (let index = 0; index < count; index += 1) {
    out.push(month)
    month = monthBefore(month)
  }
  return chosen && !out.includes(chosen) ? [...out, chosen].sort().reverse() : out
}

/** The month's pill: what the band says about the file. */
export function monthPill(month: PayrollMonth): { tone: 'neutral' | 'success' | 'warning'; words: 'pill.NOT_EXPORTED' | 'pill.EXPORTED' | 'pill.CORRECTION_PENDING' } {
  if (month.state === 'NOT_EXPORTED') return { tone: 'neutral', words: 'pill.NOT_EXPORTED' }
  return month.state === 'EXPORTED' ? { tone: 'success', words: 'pill.EXPORTED' } : { tone: 'warning', words: 'pill.CORRECTION_PENDING' }
}

/** The band's main button. */
export function primaryOf(month: PayrollMonth | null): 'start' | 'correct' | 'open' {
  if (!month || month.state === 'NOT_EXPORTED') return 'start'
  return month.state === 'CORRECTION_PENDING' ? 'correct' : 'open'
}

// ---- checks ----------------------------------------------------------------------------------------------------------------------

export type ShowKind = 'people' | 'codes' | 'place'

/** What "Show me" opens: people (recorded), the codes with no provider code, or the page that fixes it. */
export const showKindOf = (code: CheckCode): ShowKind => ((PEOPLE_CHECKS as readonly string[]).includes(code) ? 'people' : code === 'CODES_MAPPED' ? 'codes' : 'place')

export const checkState = (check: Pick<Check, 'passed' | 'blocking'>): 'pass' | 'warning' | 'fail' => (check.passed ? 'pass' : check.blocking ? 'fail' : 'warning')

/** A check in words: the name, and what it found (`check.<CODE>.done` / `.left`, `.warn` where it passes as a warning). */
export function checkWords(check: Pick<Check, 'code' | 'passed' | 'blocking' | 'count'>, month: string, locale: Locale): { name: string; detail: Words } {
  const name = `check.${check.code}.name`
  const params = { count: check.count, month: monthWords(month, locale) }
  if (check.passed) return { name, detail: { key: `check.${check.code}.done`, params } }
  if (check.code === 'CODES_MAPPED' && !check.blocking) return { name, detail: { key: 'check.CODES_MAPPED.warn', params } }
  return { name, detail: { key: `check.${check.code}.left`, params } }
}

/** Blocking checks first, then the warnings, each in the design's order (the API's order); what passes last in its group. */
export const orderedChecks = <T extends Pick<Check, 'blocking' | 'passed'>>(checks: readonly T[]): T[] => [...checks.filter((check) => check.blocking), ...checks.filter((check) => !check.blocking)]

/** Where a check's fix lives: a page in a new tab, or a step of this wizard. A page not built yet gives nothing: said in words. */
export type Place = { kind: 'page'; href: string; words: string } | { kind: 'step'; step: Step; words: string } | { kind: 'notBuilt'; words: string }

export function placeOf(place: CheckPlace, prefix: string, month: string, pages: ReadonlySet<string>): Place {
  const page = (path: string, address: string, words: string): Place => (pages.has(path) ? { kind: 'page', href: `${prefix}${address}`, words } : { kind: 'notBuilt', words })
  switch (place) {
    case 'ATTENDANCE':
      return page('/people/attendance', `/people/attendance?month=${month}`, 'place.ATTENDANCE')
    case 'EMPLOYEES':
      return page('/people/employees', '/people/employees?rows=MISSING_DATA', 'place.EMPLOYEES')
    case 'PRODUCTION_LABOUR':
      return page('/production/labour', '/production/labour', 'place.PRODUCTION_LABOUR')
    case 'PIECE_RATES':
      return page('/people/piecerates', '/people/piecerates', 'place.PIECE_RATES')
    case 'CODE_MAPPING':
      return { kind: 'step', step: 'mapping', words: 'place.CODE_MAPPING' }
    default:
      return { kind: 'step', step: 'send', words: 'place.LAYOUTS' }
  }
}

// ---- the steps -------------------------------------------------------------------------------------------------------------------

export interface StepFacts {
  readonly month: PayrollMonth | null
  readonly can: PayrollCan
}

const closed = (month: PayrollMonth | null): boolean => month?.close.state === 'CLOSED'

/** What holds Continue on a step (the design's words: the month, the count of blocking checks), or null. */
export function continueHeld(step: Step, facts: StepFacts): Words | null {
  const { month } = facts
  if (!month) return { key: 'held.notRead' }
  if (step === 'period') return closed(month) ? null : { key: 'held.notClosed', params: { month: month.month } }
  if (step === 'checks' || step === 'mapping') return month.blocking > 0 ? { key: 'held.blocking', params: { count: month.blocking } } : null
  return null
}

/** Which steps the stepper may open: done ones, and Code mapping once the month is read (a company's mapping, not a month's). */
export function stepOpen(step: Step, current: Step, facts: StepFacts): boolean {
  const { month } = facts
  if (STEPS.indexOf(step) <= STEPS.indexOf(current)) return true
  if (!month) return false
  if (step === 'checks') return closed(month)
  if (step === 'mapping') return true
  return closed(month) && month.blocking === 0
}

/** The file's version as the wizard would make it. */
export const nextRevision = (month: PayrollMonth | null): number => (month?.latest?.revision ?? 0) + 1

/** What holds "Make the file" of a first export, or a correction once the month has one. */
export function makeHeld(facts: StepFacts & { readonly layout: Layout | null; readonly busy: boolean }): Words | null {
  const { month, can, layout, busy } = facts
  if (!can.manage) return { key: 'held.noManage' }
  if (!month) return { key: 'held.notRead' }
  if (busy) return { key: 'held.busy' }
  if (month.state === 'EXPORTED') return { key: 'held.nothingChanged', params: { version: month.latest?.revision ?? 1 } }
  if (!closed(month)) return { key: 'held.notClosed', params: { month: month.month } }
  if (month.blocking > 0) return { key: 'held.blocking', params: { count: month.blocking } }
  if (!layout) return { key: 'held.noLayout' }
  if (month.carriesPay && !can.pay) return { key: 'held.noPay' }
  return month.actions.export.allowed ? null : { key: 'held.noReach' }
}

/** What holds a correction in its dialog. */
export function correctHeld(facts: StepFacts & { readonly busy: boolean }): Words | null {
  const { month, can, busy } = facts
  if (!can.manage) return { key: 'held.noManage' }
  if (!month) return { key: 'held.notRead' }
  if (busy) return { key: 'held.busy' }
  if (!month.latest) return { key: 'held.noExportYet' }
  if (month.carriesPay && !can.pay) return { key: 'held.noPay' }
  if (month.state !== 'CORRECTION_PENDING' || !month.actions.correct.allowed) return { key: 'held.nothingChanged', params: { version: month.latest.revision } }
  return null
}

// ---- layouts ---------------------------------------------------------------------------------------------------------------------

export const activeLayouts = (layouts: readonly Layout[]): Layout[] => layouts.filter((layout) => layout.status === 'ACTIVE')

/** The layout in use: the one in the address, else the one the month's last file used, else the first generic one, else the first. */
export function chosenLayout(layouts: readonly Layout[], addressId: string | null, latestId: string | null): Layout | null {
  const active = activeLayouts(layouts)
  return active.find((layout) => layout.id === addressId) ?? active.find((layout) => layout.id === latestId) ?? active.find((layout) => layout.provider === null) ?? active[0] ?? null
}

/** A provider layout nobody confirmed: a warning on every screen that shows the layout (GATE-PAYROLL). */
export const layoutUnconfirmed = (layout: Pick<Layout, 'confirmed'> | Pick<ExportRow['layout'], 'confirmed'> | null): boolean => layout !== null && !layout.confirmed

/** The twelve things the labour consultant must confirm, as message keys (their words live in the catalogue, by position). */
export const toConfirmKeys = (): string[] => PAYROLL_TO_CONFIRM.map((_, index) => `confirm.item.${index + 1}`)

export interface ConfirmDraft {
  by: string
  on: string
}

export function confirmHeld(draft: ConfirmDraft, can: PayrollCan, busy: boolean): Words | null {
  if (!can.manage) return { key: 'held.noManage' }
  if (busy) return { key: 'held.busy' }
  if (!draft.by.trim()) return { key: 'confirm.held.by' }
  if (draft.by.trim().length > LAYOUT_LIMITS.confirmedBy) return { key: 'confirm.held.by' }
  return /^\d{4}-\d{2}-\d{2}$/.test(draft.on) ? null : { key: 'confirm.held.on' }
}

// ---- CSV columns -----------------------------------------------------------------------------------------------------------------

export interface ColumnDraft {
  /** Stable while the row is moved (the ordered list's identity). */
  id: string
  key: ColumnKey
  header: string
  width: string
  format: string
  value: string
}

export interface ColumnsDraft {
  name: string
  format: PayrollFormat
  columns: ColumnDraft[]
  delimiter: string
  decimalSeparator: string
  dateFormat: string
  encoding: string
  headerRow: boolean
  companyCode: string
}

const columnDraft = (column: LayoutColumn, index: number): ColumnDraft => ({ id: `c${index + 1}`, key: column.key, header: column.header ?? '', width: column.width === undefined ? '' : String(column.width), format: column.format ?? '', value: column.value ?? '' })

export function columnsDraftOf(layout: Layout): ColumnsDraft {
  const definition = layout.definition
  return {
    name: layout.name,
    format: layout.format,
    columns: definition.columns.map(columnDraft),
    delimiter: definition.delimiter ?? ';',
    decimalSeparator: definition.decimalSeparator ?? ',',
    dateFormat: definition.dateFormat ?? 'DD/MM/YYYY',
    encoding: definition.encoding ?? 'UTF-8',
    headerRow: definition.headerRow !== false,
    companyCode: definition.companyCode ?? '',
  }
}

/** A new row's id: never one the list holds. */
export function newColumn(columns: readonly ColumnDraft[], key: ColumnKey): ColumnDraft {
  const used = new Set(columns.map((column) => column.id))
  let index = columns.length + 1
  while (used.has(`c${index}`)) index += 1
  return { id: `c${index}`, key, header: '', width: '', format: '', value: '' }
}

export function columnsBody(draft: ColumnsDraft): DefinitionBody {
  const fixed = draft.format === 'FIXED_WIDTH'
  const spreadsheet = draft.format === 'SPREADSHEET'
  const company = draft.companyCode.trim()
  return {
    columns: draft.columns.map((column): LayoutColumn => {
      const header = column.header.trim()
      const width = Number(column.width)
      return {
        key: column.key,
        ...(header ? { header } : {}),
        ...(fixed && column.width.trim() ? { width } : {}),
        ...(column.format ? { format: column.format } : {}),
        ...(column.key === 'constant' ? { value: column.value } : {}),
      }
    }),
    ...(fixed || spreadsheet ? {} : { delimiter: draft.delimiter }),
    ...(spreadsheet ? {} : { decimalSeparator: draft.decimalSeparator }),
    dateFormat: draft.dateFormat,
    ...(spreadsheet ? {} : { encoding: draft.encoding }),
    headerRow: fixed ? false : draft.headerRow,
    ...(company ? { companyCode: company } : {}),
  }
}

/** A delimiter in words (a tab has no glyph). */
export const delimiterKey = (delimiter: string): string => `columns.delimiter.${DELIMITERS.indexOf(delimiter as (typeof DELIMITERS)[number])}`

/** What holds "Save layout": the first problem of the definition, the rules being the API's own. */
export function columnsHeld(draft: ColumnsDraft, can: PayrollCan, busy: boolean): Words | null {
  if (!can.manage) return { key: 'held.noManage' }
  if (busy) return { key: 'held.busy' }
  if (!draft.name.trim()) return { key: 'columns.held.name' }
  const body = columnsBody(draft)
  const first = definitionProblems(draft.format, body)[0]
  if (!first) return null
  const parts = first.path.split('/')
  const index = Number(parts[2])
  const field = parts[3]
  if (Number.isInteger(index) && field) return { key: `columns.held.${field}`, params: { number: index + 1 } }
  return { key: draft.columns.length === 0 ? 'columns.held.none' : 'columns.held.other' }
}

/** A format a column may have: numbers, dates, or none. */
export function formatChoices(key: ColumnKey): string[] {
  if (key === 'quantity' || key === 'minutes' || key === 'amount') return ['', 'number:0', 'number:1', 'number:2', 'number:3', 'implied:2', 'implied:3']
  if (key === 'periodStart' || key === 'periodEnd' || key === 'lastDay' || key === 'month') return ['', 'date:DD/MM/YYYY', 'date:YYYY-MM-DD', 'date:YYYYMMDD', 'date:MMYYYY', 'date:MM/YYYY']
  return ['']
}

/** A format choice in words: a date format reads as itself. */
export function formatWords(format: string): Words | string {
  if (format === '') return { key: 'columns.formatDefault' }
  const [kind = '', value = ''] = format.split(':')
  return kind === 'date' ? value : { key: `columns.${kind}`, params: { count: Number(value) } }
}

/** Keep a column's format when its key changes only if the new key may have it. */
export const withKey = (column: ColumnDraft, key: ColumnKey): ColumnDraft => ({ ...column, key, format: formatChoices(key).includes(column.format) ? column.format : '', ...(key === 'constant' ? {} : { value: '' }) })

export { COLUMN_KEYS }

/** The file prints the provider's code (so a blank mapping holds it). */
export const layoutPrintsProviderCode = (layout: Layout): boolean => printsProviderCode({ columns: layout.definition.columns })

// ---- the preview -----------------------------------------------------------------------------------------------------------------

export interface PreviewColumn {
  id: string
  kind: CodeKind
  code: string
  meaning: string
  money: boolean
}

export interface PreviewRow {
  id: string
  employeeCode: string | null
  lastDay: string | null
  /** The month's cells, by column. */
  cells: Readonly<Record<string, ValueCell>>
  /** What differs from the file before, by column. */
  changes: Readonly<Record<string, ChangeRow>>
  /** How many values of this person differ, the amounts a person may not see included. */
  changed: number
}

const columnId = (kind: CodeKind, code: string): string => `${kind}|${code}`

/** A code's meaning in the page's language: ours for a fixed code, as typed for an absence code. */
export function meaningOf(kind: CodeKind, code: string, meaning: string, locale: Locale): string {
  return kind !== 'ABSENCE' && isFixedCode(code) ? CODE_MEANINGS[code][locale === 'it' ? 'it' : 'en'] : meaning
}

/** One column per code the month carries, in the file's order. Earnings are amounts: without the pay grain they are not drawn. */
export function previewColumns(values: PayrollValues, locale: Locale): PreviewColumn[] {
  const seen = new Map<string, PreviewColumn>()
  const add = (kind: CodeKind, code: string, meaning: string) => {
    if (kind === 'EARNING' && !values.payShown) return
    if (!seen.has(columnId(kind, code))) seen.set(columnId(kind, code), { id: columnId(kind, code), kind, code, meaning: meaningOf(kind, code, meaning, locale), money: kind === 'EARNING' })
  }
  for (const person of values.people) for (const cell of person.cells) add(cell.kind, cell.code, cell.meaning)
  for (const row of values.changes?.rows ?? []) add(row.kind, row.code, row.meaning)
  return [...seen.values()].sort(codeOrder)
}

const rowOf = (person: PersonRow): PreviewRow => ({
  id: person.employeeCode ?? person.employeeId ?? 'none',
  employeeCode: person.employeeCode,
  lastDay: person.lastDay,
  cells: Object.fromEntries(person.cells.map((cell) => [columnId(cell.kind, cell.code), cell])),
  changes: {},
  changed: 0,
})

/** The rows per employee code; a person a correction removed from the file still has a row (their values go away). */
export function previewRows(values: PayrollValues, onlyChanged: boolean): PreviewRow[] {
  const rows = new Map(values.people.map((person) => [person.employeeCode ?? person.employeeId ?? 'none', rowOf(person)]))
  for (const change of values.changes?.rows ?? []) {
    const row = rows.get(change.employeeCode) ?? { id: change.employeeCode, employeeCode: change.employeeCode, lastDay: null, cells: {}, changes: {}, changed: 0 }
    rows.set(change.employeeCode, { ...row, changes: { ...row.changes, [columnId(change.kind, change.code)]: change }, changed: row.changed + 1 })
  }
  const all = [...rows.values()]
  return onlyChanged ? all.filter((row) => row.changed > 0) : all
}

export const moneyText = (minor: number, currency: string | null, locale: Locale): string =>
  new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', currency ? { style: 'currency', currency } : { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(minor / 100)

/** "168,50": hours and pieces in the page's language. */
export const quantityText = (quantity: string, locale: Locale): string => new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(quantity))

/** A value as a cell shows it: the amount where there is one (and the grain gave it), else the quantity, else nothing. */
export function valueText(value: { readonly quantity: string | null; readonly amount?: number | null | undefined; readonly currency: string | null } | undefined, locale: Locale): string | null {
  if (!value) return null
  if (typeof value.amount === 'number') return moneyText(value.amount, value.currency, locale)
  return value.quantity === null ? null : quantityText(value.quantity, locale)
}

/** A change's two sides as a cell shows them (null: no value on that side). */
export function changeSides(change: ChangeRow, locale: Locale): { from: string | null; to: string | null } {
  const side = (quantity: string | null, amount: number | null | undefined) => valueText({ quantity, amount, currency: change.currency }, locale)
  return { from: side(change.fromQuantity, change.fromAmount), to: side(change.toQuantity, change.toAmount) }
}

// ---- files -----------------------------------------------------------------------------------------------------------------------

export const fileOf = (record: Pick<ExportRecord, 'files'>, kind: FileKind): ExportFile | null => record.files.find((file) => file.kind === (kind === 'data' ? 'DATA' : 'SUMMARY')) ?? null

/** What holds opening a file. Amounts ask the pay grain; the data file and the summary alike. The API has the last word: its reach is per site. */
export function fileHeld(record: Pick<ExportRecord, 'status' | 'carriesPay' | 'actions'>, can: PayrollCan): Words | null {
  if (!can.records) return { key: 'held.noRecords' }
  if (record.status !== 'EXPORTED') return { key: 'held.notExported' }
  if (record.carriesPay && !can.pay) return { key: 'held.noPay' }
  return record.actions.open.allowed ? null : { key: 'held.noReach' }
}

/** A short form of a seal for a table cell. */
export const sealShort = (seal: string): string => `${seal.slice(0, 8)}…${seal.slice(-4)}`

export const isLatest = (row: Pick<ExportRow, 'status' | 'correctedById'>): boolean => row.status === 'EXPORTED' && row.correctedById === null

/** A row's "Make correction": held with why (only the month's latest file is corrected). */
export function rowCorrectHeld(row: Pick<ExportRow, 'status' | 'correctedById'>, can: PayrollCan): Words | null {
  if (!can.manage) return { key: 'held.noManage' }
  if (row.status !== 'EXPORTED') return { key: 'held.notExported' }
  return row.correctedById ? { key: 'held.replaced' } : null
}

/** A row's or record's Send: held with why. */
export function sendRowHeld(row: Pick<ExportRow, 'status' | 'correctedById'>, can: PayrollCan): Words | null {
  if (!can.manage) return { key: 'held.noManage' }
  if (row.status !== 'EXPORTED') return { key: 'held.notExported' }
  return row.correctedById ? { key: 'held.replaced' } : null
}

export const csvRow = (row: ExportRow, words: { readonly status: string; readonly format: string; readonly month: string }, when: (at: string | null) => string): string[] => [
  words.month,
  `${row.company.code} ${row.company.legalName}`,
  words.format,
  `v${row.revision}`,
  row.number ?? '',
  words.status,
  row.madeBy?.name ?? '',
  when(row.exportedAt ?? row.createdAt),
  row.sentTo.join(', '),
  when(row.downloadedAt),
  row.seal ?? '',
]

// ---- send ------------------------------------------------------------------------------------------------------------------------

export interface SendDraft {
  email: string
  days: string
  uses: string
  message: string
  language: 'it' | 'en'
}

export const sendDraftOf = (locale: Locale, email = ''): SendDraft => ({ email, days: String(PAYROLL_LINK_TERMS.expiryDays.default), uses: String(PAYROLL_LINK_TERMS.uses.default), message: '', language: locale === 'en' ? 'en' : 'it' })

const wholeIn = (text: string, max: number): boolean => /^\d+$/.test(text.trim()) && Number(text) >= 1 && Number(text) <= max
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** What holds "Send link". */
export function sendHeld(draft: SendDraft, can: PayrollCan, busy: boolean): Words | null {
  if (!can.manage) return { key: 'held.noManage' }
  if (busy) return { key: 'held.busy' }
  if (!EMAIL.test(draft.email.trim())) return { key: 'send.held.email' }
  if (!wholeIn(draft.days, PAYROLL_LINK_TERMS.expiryDays.max)) return { key: 'send.held.days', params: { max: PAYROLL_LINK_TERMS.expiryDays.max } }
  if (!wholeIn(draft.uses, PAYROLL_LINK_TERMS.uses.max)) return { key: 'send.held.uses', params: { max: PAYROLL_LINK_TERMS.uses.max } }
  return null
}

export function sendBody(draft: SendDraft): SendBody {
  const message = draft.message.trim()
  return { email: draft.email.trim(), expiresInDays: Number(draft.days), maxUses: Number(draft.uses), ...(message ? { message } : {}), language: draft.language }
}

// ---- words of API answers --------------------------------------------------------------------------------------------------------

/** The month is closed to everyone: no site of the company has the ATTENDANCE gate on (the page explains, nothing is read). */
export const isGateClosed = (error: unknown): boolean => isApiError(error) && error.issues.some((issue) => issuePath(issue).startsWith('gate/'))

export function refusalCodeOf(error: unknown): (typeof PAYROLL_REFUSALS)[number] | null {
  if (!isApiError(error)) return null
  for (const issue of error.issues) {
    const path = issuePath(issue)
    if (path.startsWith('refusal/') && (PAYROLL_REFUSALS as readonly string[]).includes(path.slice(8))) return path.slice(8) as (typeof PAYROLL_REFUSALS)[number]
  }
  return null
}

/** The checks a CHECKS_OPEN refusal named (`check/<CODE>`). */
export function refusedChecks(error: unknown): string[] {
  if (!isApiError(error)) return []
  return error.issues.map(issuePath).flatMap((path) => (path.startsWith('check/') ? [path.slice(6)] : []))
}

/** The words of a failed call: a refusal by its code, the gate, else the kind of failure. */
export function payrollProblem(error: unknown): Words {
  if (isGateClosed(error)) return { key: 'problem.gate' }
  const refusal = refusalCodeOf(error)
  if (refusal) return { key: `refusal.${refusal}`, ...(refusal === 'CHECKS_OPEN' ? { params: { count: Math.max(1, refusedChecks(error).length) } } : {}) }
  if (!isApiError(error)) return { key: 'problem.unavailable' }
  switch (error.kind) {
    case 'invalid': {
      const field = fieldOf(error)
      return { key: field === 'email' ? 'problem.email' : field === 'definition' ? 'problem.definition' : 'problem.invalid' }
    }
    case 'signed_out':
      return { key: 'problem.signedOut' }
    case 'forbidden':
    case 'step_up':
      return { key: 'problem.forbidden' }
    case 'not_found':
      return { key: 'problem.notFound' }
    case 'conflict':
      return { key: 'problem.conflict' }
    case 'rate_limited':
      return { key: 'problem.rateLimited' }
    default:
      return { key: 'problem.unavailable' }
  }
}

/** A code's row key, for marks and the grid. */
export const codeKey = (row: Pick<CodeRow, 'kind' | 'ourCode'>): string => columnId(row.kind, row.ourCode)

/** The address one mapping row sends: null clears it, none when nothing changed. */
export function mappingChange(row: CodeRow, typed: string): string | null | undefined {
  const value = typed.trim()
  const next = value === '' ? null : value
  return next === row.providerCode ? undefined : next
}

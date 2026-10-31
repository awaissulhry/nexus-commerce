import { isApiError } from '../../../lib/api/errors'
import { formatDate, formatNumber } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import { REPORT_AREAS, type Grain, type LibraryReport, type ReportAbout, type ReportArea, type ReportColumn, type ResultGroup, type ResultRow } from './api'

/**
 * Home › Reports' rules (SCR-104; B-W2a-79; design home.reports): the library's address and filters, a report's
 * address (tab, filters, grouping), how a cell is said, the CSV of a result, the rights banner, the held reasons and
 * "last run by me" (from the server). Pure: the containers load, the views draw.
 */

export type Translate = (key: string, params?: Record<string, string | number>) => string

export const REPORTS_VIEW = 'home.reports.view'
export const REPORT_TABS = ['results', 'schedule', 'about'] as const
export type ReportTab = (typeof REPORT_TABS)[number]

export interface ReportsAbilities {
  readonly view: boolean
}
export const reportsCanOf = (permissions: readonly string[]): ReportsAbilities => ({ view: permissions.includes(REPORTS_VIEW) })

/** A report's words in the person's language: `report.<area>.<name>.<part>` (the catalogue `home-reports`). */
export const reportWordKey = (key: string, part: string): string => `report.${key}.${part}`

// ---- the library --------------------------------------------------------------------------------------------------------

export interface LibraryAddress {
  readonly q: string
  readonly area: ReportArea | null
  /** Also list the reports that read lists outside the person's role (off by default). */
  readonly outside: boolean
}

type Params = { get(name: string): string | null } | null

export function libraryAddressOf(params: Params): LibraryAddress {
  const area = params?.get('area') ?? ''
  return { q: (params?.get('q') ?? '').trim().slice(0, 100), area: (REPORT_AREAS as readonly string[]).includes(area) ? (area as ReportArea) : null, outside: params?.get('outside') === '1' }
}

export function libraryHref(prefix: string, address: LibraryAddress): string {
  const query = new URLSearchParams()
  if (address.q) query.set('q', address.q)
  if (address.area) query.set('area', address.area)
  if (address.outside) query.set('outside', '1')
  const qs = query.toString()
  return `${prefix}/home/reports${qs ? `?${qs}` : ''}`
}

const fold = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

/** The library's rows under the address: the search over the words the person reads, the area chip, outside-role ones. */
export function libraryRows(reports: readonly LibraryReport[], address: LibraryAddress, words: (report: LibraryReport) => { title: string; question: string }): LibraryReport[] {
  const needle = fold(address.q)
  return reports.filter((report) => {
    if (!address.outside && report.state === 'NO_ACCESS') return false
    if (address.area && report.area !== address.area) return false
    if (!needle) return true
    const { title, question } = words(report)
    return fold(`${title} ${question}`).includes(needle)
  })
}

export const outsideCount = (reports: readonly LibraryReport[]): number => reports.filter((report) => report.state === 'NO_ACCESS').length

/** The library row's state in words (null: ready to run). */
export function stateWords(report: Pick<LibraryReport, 'state' | 'grain'>, t: Translate): string | null {
  if (report.state === 'NEEDS_GRAIN') return t('state.needsGrain', { grain: t(`grain.${report.grain ?? 'price'}`) })
  if (report.state === 'NO_ACCESS') return t('state.noAccess')
  return null
}

// ---- a report ---------------------------------------------------------------------------------------------------------------

export interface ReportAddress {
  readonly tab: ReportTab
  /** The report's own filters as the address names them (absent: the server's default). */
  readonly filters: Readonly<Record<string, string>>
  /** `none`: not grouped; null: the report's own grouping. */
  readonly group: string | null
}

const RESERVED = new Set(['tab', 'group'])

export function reportAddressOf(params: Params & { forEach?: (fn: (value: string, key: string) => void) => void }): ReportAddress {
  const tab = params?.get('tab') ?? ''
  const filters: Record<string, string> = {}
  params?.forEach?.((value, key) => {
    if (!RESERVED.has(key) && /^[a-z][a-zA-Z0-9]*$/.test(key) && value) filters[key] = value.slice(0, 200)
  })
  return { tab: (REPORT_TABS as readonly string[]).includes(tab) ? (tab as ReportTab) : 'results', filters, group: params?.get('group') || null }
}

/** Only the filters the report has (an old link's other terms are dropped). */
export function knownFilters(about: Pick<ReportAbout, 'filters'>, filters: Readonly<Record<string, string>>): Record<string, string | null> {
  return Object.fromEntries(about.filters.map((filter) => [filter.key, filters[filter.key] ?? null]))
}

function queryOf(address: ReportAddress, withTab: boolean): string {
  const query = new URLSearchParams()
  if (withTab && address.tab !== 'results') query.set('tab', address.tab)
  for (const [key, value] of Object.entries(address.filters).sort()) query.set(key, value)
  if (address.group) query.set('group', address.group)
  return query.toString()
}

export function reportHref(prefix: string, key: string, address: ReportAddress = { tab: 'results', filters: {}, group: null }): string {
  const qs = queryOf(address, true)
  return `${prefix}/home/reports/${encodeURIComponent(key)}${qs ? `?${qs}` : ''}`
}

/** The print tab of a run (the same filters and grouping). */
export function printHref(prefix: string, key: string, address: ReportAddress): string {
  const qs = queryOf(address, false)
  return `${prefix}/home/reports/${encodeURIComponent(key)}/print${qs ? `?${qs}` : ''}`
}

/** A report a person may not run: the message key that says why (null: they may). */
export function heldOf(about: Pick<ReportAbout, 'state' | 'grain'>): { key: string; grain: Grain | null } | null {
  if (about.state === 'NO_ACCESS') return { key: 'held.noAccess', grain: null }
  if (about.state === 'NEEDS_GRAIN') return { key: 'held.needsGrain', grain: about.grain }
  return null
}

/** A failed read as a message key. */
export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'error.read'
  if (error.kind === 'forbidden') return 'error.forbidden'
  if (error.kind === 'not_found') return 'error.notFound'
  if (error.kind === 'invalid') return 'error.invalid'
  if (error.kind === 'unavailable') return 'error.offline'
  return 'error.read'
}

// ---- cells ------------------------------------------------------------------------------------------------------------------

export type CellValue = string | number | null | undefined

/** A cell as the screen says it. */
export function cellText(column: Pick<ReportColumn, 'kind'>, value: CellValue, currency: string | null, t: Translate, locale: Locale): string {
  if (value === null || value === undefined || value === '') return ''
  switch (column.kind) {
    case 'code':
      return t(`code.${String(value)}`)
    case 'number':
      return formatNumber(Number(value), locale)
    case 'day':
      return formatDate(`${String(value).slice(0, 10)}T12:00:00Z`, { locale })
    case 'money':
      return currency ? formatNumber(Number(value) / 100, locale, { style: 'currency', currency }) : formatNumber(Number(value) / 100, locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    case 'percent':
      return `${formatNumber(Number(value), locale, { maximumFractionDigits: 1 })} %`
    default:
      return String(value)
  }
}

/** A column's heading in the person's language. */
export const columnLabel = (reportKey: string, column: Pick<ReportColumn, 'key'>, t: Translate): string => t(reportWordKey(reportKey, `col.${column.key}`))

/** A group's value in words (null: "None"). */
export function groupValueText(column: Pick<ReportColumn, 'kind'> | undefined, value: ResultGroup['value'], t: Translate, locale: Locale): string {
  if (value === null) return t('results.groupNone')
  return column ? cellText(column, value, null, t, locale) : String(value)
}

// ---- the CSV of a result (the rows the person sees: the API sent only what their rights reach) -------------------------------

const csvEscape = (text: string, separator: string) => (text.includes(separator) || text.includes('"') || text.includes('\n') ? `"${text.replaceAll('"', '""')}"` : text)

/** Plain numbers in the file (`;` and a decimal comma in Italian, `,` and a point in English), codes and days in words. */
export function csvOf(reportKey: string, columns: readonly ReportColumn[], rows: readonly ResultRow[], t: Translate, locale: Locale): string {
  const separator = locale === 'it' ? ';' : ','
  const plain = (column: ReportColumn, value: CellValue): string => {
    if (value === null || value === undefined) return ''
    if (column.kind === 'money') return (Number(value) / 100).toFixed(2).replace('.', locale === 'it' ? ',' : '.')
    if (column.kind === 'percent' || column.kind === 'number') return String(value).replace('.', locale === 'it' ? ',' : '.')
    if (column.kind === 'code') return t(`code.${String(value)}`)
    return String(value)
  }
  const money = columns.some((column) => column.kind === 'money')
  const head = [...columns.map((column) => columnLabel(reportKey, column, t)), ...(money ? [t('results.currency')] : [])]
  const lines = rows.map((row) => [...columns.map((column) => plain(column, row.cells[column.key])), ...(money ? [row.currency ?? ''] : [])])
  return `﻿${[head, ...lines].map((line) => line.map((cell) => csvEscape(cell, separator)).join(separator)).join('\r\n')}\r\n`
}

/** The file name of a result's CSV: `<title>-<day>.csv`, letters and digits only. */
export const csvName = (title: string, day: string): string => `${fold(title).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'report'}-${day}.csv`

// ---- the rights banner ------------------------------------------------------------------------------------------------------

/** "What you see": the lines of the banner (empty: no banner). */
export function rightsLines(rights: { readonly leftOut: readonly Grain[]; readonly hiddenGroups: number } | null, t: Translate): string[] {
  if (!rights) return []
  const lines: string[] = []
  if (rights.leftOut.length > 0) lines.push(t('rights.leftOut', { grains: rights.leftOut.map((grain) => t(`grain.${grain}`)).join(', ') }))
  if (rights.hiddenGroups > 0) lines.push(t('rights.smallGroups', { count: rights.hiddenGroups }))
  return lines
}

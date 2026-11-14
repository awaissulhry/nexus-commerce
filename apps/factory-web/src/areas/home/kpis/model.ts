import { draftProblems } from '@nexus/factory-domain/insights/kpis/checks'
import { MEASURES } from '@nexus/factory-domain/insights/kpis/measures'
import { isApiError, issuePath, type ApiError } from '../../../lib/api/errors'
import { formatDate, formatNumber } from '../../../lib/i18n/format'
import { INTL_LOCALE, type Locale } from '../../../lib/i18n/locales'
import { listAddress } from '../../../lib/records/record-links'
import { recordsHref } from './drills'
import type { KpiCalculation, KpiGrain, KpiItem, KpiPeriod, KpiRecord, KpiUnit, KpiUse, KpiValue, KpiVersion, KpiWords, PeriodKind, VersionFields } from './api'
import { PERIOD_KINDS } from './api'

/**
 * Home › Insights › KPI library's rules (SCR-249 the library, SCR-470 a KPI, SCR-471 the records behind it; B-W2b-433 on
 * B-W2b-428's metric layer): the addresses, a KPI's words in the reader's language, its state, how its value and period are
 * said, where it is used and where that opens, the records behind it, the CSV of the definitions, the comparison of two
 * versions, the owner's version form and the refusals in words. Pure: the containers load, the views draw.
 */

export type Translate = (key: string, params?: Record<string, string | number>) => string

const KPIS_VIEW = 'home.kpis.view'
const KPIS_MANAGE = 'home.kpis.manage'
const ROLES_VIEW = 'roles.view'

export interface KpisAbilities {
  /** Reads the library (home.kpis.view). */
  readonly view: boolean
  /** Writes, edits, puts in force, withdraws and deletes versions; installs the standard KPIs (home.kpis.manage: the owner). */
  readonly manage: boolean
  /** May pick another owner role (roles.view lists them). */
  readonly roles: boolean
}

export const kpisCanOf = (permissions: readonly string[]): KpisAbilities => ({
  view: permissions.includes(KPIS_VIEW),
  manage: permissions.includes(KPIS_MANAGE),
  roles: permissions.includes(ROLES_VIEW),
})

/** The areas a KPI key starts with (`delivery.otif` → delivery); any other key is "other". */
export const KPI_AREAS = ['sales', 'delivery', 'production', 'purchasing', 'quality', 'warehouse', 'finance'] as const
export type KpiArea = (typeof KPI_AREAS)[number] | 'other'

export function areaOf(key: string): KpiArea {
  const head = key.split('.')[0] ?? ''
  return (KPI_AREAS as readonly string[]).includes(head) ? (head as KpiArea) : 'other'
}

type Params = { get(name: string): string | null } | null

/** The live hints that make a KPI page read again: the facts rebuilt, a version written or put in force, the uses changed. */
export const KPI_LIVE_EVENTS: readonly string[] = ['facts.rebuilt', 'kpi.changed', 'kpi.uses_changed']

const fold = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

// ---- words ------------------------------------------------------------------------------------------------------------------

export interface Said {
  readonly name: string
  readonly definition: string
  readonly formula: string
}

/** Words of a version (or the standard words) in the reader's language. */
export function said(words: Pick<KpiWords, keyof KpiWords>, locale: Locale): Said {
  return locale === 'it'
    ? { name: words.nameIt, definition: words.definitionIt, formula: words.formulaIt }
    : { name: words.nameEn, definition: words.definitionEn, formula: words.formulaEn }
}

/** A KPI's words: those of the version it is shown by, else the standard words the install writes as version 1. */
export function wordsOf(item: Pick<KpiItem, 'shown' | 'standardWords' | 'key'>, locale: Locale): Said {
  const source = item.shown ?? item.standardWords
  return source ? said(source, locale) : { name: item.key, definition: '', formula: '' }
}

/** The office role templates a KPI may be owned by (factory-domain auth/roles/templates, audience office). */
export const OFFICE_ROLE_KEYS = [
  'owner',
  'admin',
  'finance',
  'sales',
  'planner',
  'buyer',
  'warehouse',
  'production_manager',
  'quality_inspector',
  'floor_supervisor',
  'maintenance',
  'hr',
  'safety_officer',
  'company_doctor',
  'read_only',
] as const

/** The owner role in words: a ready-made role by its key (the catalogue), a custom role by its own name. */
export function ownerText(owner: { readonly key: string | null; readonly name: string | null } | null, t: Translate): string {
  if (owner?.key && (OFFICE_ROLE_KEYS as readonly string[]).includes(owner.key)) return t(`role.${owner.key}`)
  return owner?.name ?? t('owner.unknown')
}

/** The owner of an item: its version's, else (not installed) the role template its calculation names. */
export const ownerOf = (item: Pick<KpiItem, 'shown' | 'calculation'>) => item.shown?.owner ?? (item.calculation ? { key: item.calculation.ownerRole, name: null } : null)

// ---- the state of a KPI ---------------------------------------------------------------------------------------------------

export type KpiStatus =
  | { readonly kind: 'IN_FORCE'; readonly version: number; readonly drafts: number }
  | { readonly kind: 'DRAFT_ONLY'; readonly version: number; readonly drafts: number }
  | { readonly kind: 'WITHDRAWN'; readonly version: number }
  | { readonly kind: 'NOT_INSTALLED' }

export function statusOf(item: Pick<KpiItem, 'shown' | 'inForce' | 'drafts'>): KpiStatus {
  if (item.inForce) return { kind: 'IN_FORCE', version: item.inForce.kpiVersion, drafts: item.drafts }
  if (item.shown?.state === 'DRAFT') return { kind: 'DRAFT_ONLY', version: item.shown.kpiVersion, drafts: item.drafts }
  if (item.shown) return { kind: 'WITHDRAWN', version: item.shown.kpiVersion }
  return { kind: 'NOT_INSTALLED' }
}

/** The status in words (a tag's text) and its tone. */
export function statusWords(status: KpiStatus, t: Translate): { text: string; tone: 'success' | 'warning' | 'neutral' | 'info' } {
  switch (status.kind) {
    case 'IN_FORCE':
      return { text: t('status.inForce', { version: status.version }), tone: 'success' }
    case 'DRAFT_ONLY':
      return { text: t('status.draftOnly', { version: status.version }), tone: 'warning' }
    case 'WITHDRAWN':
      return { text: t('status.withdrawn', { version: status.version }), tone: 'neutral' }
    default:
      return { text: t('status.notInstalled'), tone: 'info' }
  }
}

/** The KPIs the install would write (no version yet, a standard calculation). */
export const notInstalled = (items: readonly KpiItem[]): KpiItem[] => items.filter((item) => item.shown === null && item.standardWords !== null)

// ---- the library's address ------------------------------------------------------------------------------------------------

export interface LibraryAddress {
  readonly q: string
  readonly area: KpiArea | null
}

export function libraryAddressOf(params: Params): LibraryAddress {
  const area = params?.get('area') ?? ''
  return { q: (params?.get('q') ?? '').trim().slice(0, 100), area: ([...KPI_AREAS, 'other'] as readonly string[]).includes(area) ? (area as KpiArea) : null }
}

export function libraryHref(prefix: string, address: LibraryAddress): string {
  const query = new URLSearchParams()
  if (address.q) query.set('q', address.q)
  if (address.area) query.set('area', address.area)
  const qs = query.toString()
  return `${prefix}/home/kpis${qs ? `?${qs}` : ''}`
}

/** The library's rows under the address: the search reads the words the person sees (name, definition, formula). */
export function libraryRows(items: readonly KpiItem[], address: LibraryAddress, locale: Locale): KpiItem[] {
  const needle = fold(address.q)
  return items.filter((item) => {
    if (address.area && areaOf(item.key) !== address.area) return false
    if (!needle) return true
    const words = wordsOf(item, locale)
    return fold(`${words.name} ${words.definition} ${words.formula}`).includes(needle)
  })
}

/** The area chips: the areas the library has, in KPI_AREAS order, with their counts. */
export function areaChips(items: readonly KpiItem[]): { area: KpiArea; count: number }[] {
  const counts = new Map<KpiArea, number>()
  for (const item of items) counts.set(areaOf(item.key), (counts.get(areaOf(item.key)) ?? 0) + 1)
  return ([...KPI_AREAS, 'other'] as KpiArea[]).filter((area) => counts.has(area)).map((area) => ({ area, count: counts.get(area)! }))
}

// ---- a KPI's address ------------------------------------------------------------------------------------------------------

/** The KPI record's tabs (Targets is W3: not drawn, no empty tab and no dead door). */
export const KPI_TABS = ['definition', 'used-in', 'history'] as const
export type KpiTab = (typeof KPI_TABS)[number]

export interface KpiAddress {
  readonly tab: KpiTab
  /** The period kind the value is read over; null = the KPI's own. */
  readonly period: PeriodKind | null
  /** History: the two versions compared (by number), else the last two. */
  readonly compare: readonly [number, number] | null
}

export const DEFAULT_KPI_ADDRESS: KpiAddress = { tab: 'definition', period: null, compare: null }

export function kpiAddressOf(params: Params): KpiAddress {
  const tab = params?.get('tab') ?? ''
  const period = params?.get('period') ?? ''
  const compare = /^(\d{1,4})-(\d{1,4})$/.exec(params?.get('compare') ?? '')
  return {
    tab: (KPI_TABS as readonly string[]).includes(tab) ? (tab as KpiTab) : 'definition',
    period: (PERIOD_KINDS as readonly string[]).includes(period) ? (period as PeriodKind) : null,
    compare: compare ? [Number(compare[1]), Number(compare[2])] : null,
  }
}

export function kpiHref(prefix: string, key: string, address: KpiAddress = DEFAULT_KPI_ADDRESS): string {
  const query = new URLSearchParams()
  if (address.tab !== 'definition') query.set('tab', address.tab)
  if (address.period) query.set('period', address.period)
  if (address.compare && address.tab === 'history') query.set('compare', `${address.compare[0]}-${address.compare[1]}`)
  const qs = query.toString()
  return `${prefix}/home/kpis/${encodeURIComponent(key)}${qs ? `?${qs}` : ''}`
}

/** The period kinds a person may read a value over: the fiscal ones only with a company (its fiscal year). */
export const periodChoices = (withCompany: boolean): PeriodKind[] => PERIOD_KINDS.filter((kind) => withCompany || !kind.startsWith('FISCAL_'))

// ---- values -----------------------------------------------------------------------------------------------------------------

const DECIMALS: Readonly<Record<KpiUnit, number>> = { PERCENT: 1, COUNT: 0, PIECES: 0, MONEY: 2, DAYS: 1, HOURS: 1, MINUTES: 0, RATIO: 2 }

/** A value as a number on the KPI's own scale (money in major units), or null. */
export function valueNumber(unit: KpiUnit, value: string | null): number | null {
  if (value === null || value.trim() === '') return null
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  return unit === 'MONEY' ? number / 100 : number
}

/** A value as the screen says it: `93.5 %`, `1.240 pezzi`, `12.400,00 €`, `4,5 giorni`. Null: the caller says why. */
export function valueText(unit: KpiUnit, value: string | null, currency: string | null, t: Translate, locale: Locale): string | null {
  const number = valueNumber(unit, value)
  if (number === null) return null
  if (unit === 'MONEY') {
    return currency ? formatNumber(number, locale, { style: 'currency', currency }) : formatNumber(number, locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }
  const text = formatNumber(number, locale, { maximumFractionDigits: DECIMALS[unit], minimumFractionDigits: unit === 'PERCENT' || unit === 'DAYS' ? 1 : 0 })
  return t(`valueOf.${unit}`, { value: text, count: number })
}

/** The change from the period before, in the KPI's terms (percent points for a percent), or null. Never good or bad by colour. */
export function deltaText(unit: KpiUnit, current: string | null, previous: string | null, currency: string | null, t: Translate, locale: Locale): string | null {
  const a = valueNumber(unit, current)
  const b = valueNumber(unit, previous)
  if (a === null || b === null) return null
  const change = a - b
  if (change === 0) return null
  const sign = change > 0 ? '+' : '−'
  const size = Math.abs(change)
  if (unit === 'PERCENT') return t('delta.points', { sign, value: formatNumber(size, locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 }) })
  if (unit === 'MONEY') {
    const amount = currency ? formatNumber(size, locale, { style: 'currency', currency }) : formatNumber(size, locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    return t('delta.by', { sign, value: amount })
  }
  return t('delta.by', { sign, value: valueText(unit, String(size), null, t, locale) ?? '' })
}

/** The line under the value: the change on the period before, or "the same as" it; null when either has no value. */
export function changeLine(unit: KpiUnit, current: string | null, previous: { readonly value: string | null; readonly label: string }, currency: string | null, t: Translate, locale: Locale): string | null {
  const a = valueNumber(unit, current)
  const b = valueNumber(unit, previous.value)
  if (a === null || b === null) return null
  const change = deltaText(unit, current, previous.value, currency, t, locale)
  return change ? t('now.vsBefore', { change, period: previous.label }) : t('now.sameAs', { period: previous.label })
}

/** Why a KPI shows no value (a message key and its params), or null when it has one. */
export function problemOf(value: Pick<KpiValue, 'problem' | 'value'>, grain: KpiGrain | null): { key: string; params?: Record<string, string> } | null {
  if (value.problem === 'NEEDS_GRAIN') return { key: 'problem.NEEDS_GRAIN', params: { grain: (grain ?? 'PRICE').toLowerCase() } }
  if (value.problem) return { key: `problem.${value.problem}` }
  if (value.value === null) return { key: 'problem.NO_VALUE' }
  return null
}

/** The problem in words (the grain said by its own word). */
export function problemText(problem: { key: string; params?: Record<string, string> }, t: Translate): string {
  return problem.params?.grain ? t(problem.key, { grain: t(`grain.${problem.params.grain}`) }) : t(problem.key)
}

/** The 12 periods as numbers for the sparkline (money in major units; a missing value keeps its place). */
export const sparkValues = (unit: KpiUnit, value: Pick<KpiValue, 'periods'>): (number | null)[] => value.periods.map((period) => valueNumber(unit, period.value))

const MONTH_KEY = /^(\d{4})-(\d{2})$/
const WEEK_KEY = /^(\d{4})-W(\d{2})$/
const QUARTER_KEY = /^(\d{4})-Q([1-4])$/
const FISCAL_KEY = /^FY(\d{4})(?:-Q([1-4]))?$/

/** A period in words: `14/11/2026`, `Settimana 46 · 2026`, `novembre 2026`, `T4 2026`, `2026`, `Esercizio 2026 · T2`. */
export function periodText(period: Pick<KpiPeriod, 'kind' | 'key' | 'from'>, t: Translate, locale: Locale): string {
  switch (period.kind) {
    case 'DAY':
      return formatDate(`${period.key}T12:00:00Z`, { locale })
    case 'WEEK': {
      const match = WEEK_KEY.exec(period.key)
      return match ? t('period.week', { week: Number(match[2]), year: match[1]! }) : period.key
    }
    case 'MONTH': {
      const match = MONTH_KEY.exec(period.key)
      return match ? new Intl.DateTimeFormat(INTL_LOCALE[locale], { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${period.key}-15T12:00:00Z`)) : period.key
    }
    case 'QUARTER': {
      const match = QUARTER_KEY.exec(period.key)
      return match ? t('period.quarter', { quarter: Number(match[2]), year: match[1]! }) : period.key
    }
    case 'FISCAL_YEAR':
    case 'FISCAL_QUARTER': {
      const match = FISCAL_KEY.exec(period.key)
      if (!match) return period.key
      return match[2] ? t('period.fiscalQuarter', { quarter: Number(match[2]), year: match[1]! }) : t('period.fiscalYear', { year: match[1]! })
    }
    default:
      return period.key
  }
}

// ---- measures, records and where they open ---------------------------------------------------------------------------------

/** Every measure the metric layer builds (its words are `measure.<key>`). */
const MEASURE_KEYS: readonly string[] = MEASURES.map((measure) => measure.key)
export const isKnownMeasure = (key: string): boolean => MEASURE_KEYS.includes(key)

/** The records KPIs are computed from, each with the list that shows them (when that page is built). */
const SOURCE_LISTS: Readonly<Record<string, string>> = Object.freeze({
  SalesOrder: '/sales/orders',
  SalesOrderLine: '/sales/orders',
  PromiseRecord: '/sales/orders',
  Quote: '/sales/quotes',
  QuoteVersion: '/sales/quotes',
  Shipment: '/warehouse/shipments',
  ShipmentLine: '/warehouse/shipments',
  WorkOrder: '/production/work-orders',
  WorkOrderSize: '/production/work-orders',
  WorkOrderCostEntry: '/production/work-orders',
  OperationScan: '/production/reports',
  OperationScanDefect: '/production/reports',
  ReworkOrder: '/production/reports',
  CutLog: '/production/cutting',
  CutLogPiece: '/production/cutting',
  Hide: '/warehouse/hides',
  GoodsReceipt: '/warehouse/receipts',
  GoodsReceiptLine: '/warehouse/receipts',
  PurchaseOrderLine: '/purchasing/orders',
  CostOfSalesEntry: '/finance/margins',
})

export const SOURCE_RECORDS: readonly string[] = Object.keys(SOURCE_LISTS)

/** The company-free list a source record opens at, or null (unknown record, page not built). */
export function sourceListOf(record: string, built: ReadonlySet<string>): string | null {
  const page = SOURCE_LISTS[record]
  return page && built.has(page) ? page : null
}

/** A record type in words, or null when this app has none (the caller shows the model name as data). */
export const recordWordKey = (record: string): string | null => (SOURCE_RECORDS.includes(record) ? `record.${record}` : null)

/** The dashboards a use may name (B-W2b-434's; Today is W1's), each with its words `use.dashboard.<key>`. */
export const DASHBOARD_KEYS = ['today', 'owner-group', 'plant-manager', 'sales', 'planner', 'buyer', 'quality', 'finance', 'line-leader'] as const

export interface UseSaid {
  readonly kind: KpiUse['usedIn']
  /** The message key of its name (with the namespace that holds it), or null: the key itself is shown as a reference. */
  readonly word: { readonly namespace: 'home-kpis' | 'home-reports'; readonly key: string } | null
  readonly href: string | null
}

/** How a use is said and where it opens (only a page that is built: never a dead door). */
export function useOf(use: Pick<KpiUse, 'usedIn' | 'useKey'>, built: ReadonlySet<string>, ruleKinds: readonly string[]): UseSaid {
  switch (use.usedIn) {
    case 'DASHBOARD': {
      const known = (DASHBOARD_KEYS as readonly string[]).includes(use.useKey)
      const href = use.useKey === 'today' ? (built.has('/home/today') ? '/home/today' : null) : built.has('/home/dashboards') ? `/home/dashboards?board=${encodeURIComponent(use.useKey)}` : null
      return { kind: use.usedIn, word: known ? { namespace: 'home-kpis', key: `use.dashboard.${use.useKey}` } : null, href }
    }
    case 'REPORT':
      return { kind: use.usedIn, word: { namespace: 'home-reports', key: `report.${use.useKey}.title` }, href: built.has('/home/reports/[key]') ? `/home/reports/${encodeURIComponent(use.useKey)}` : null }
    case 'ALERT': {
      const known = ruleKinds.includes(use.useKey)
      return { kind: use.usedIn, word: known ? { namespace: 'home-kpis', key: `use.alert.${use.useKey}` } : null, href: known && built.has('/home/alerts') ? `/home/alerts?kind=${encodeURIComponent(use.useKey)}` : null }
    }
    default:
      return { kind: use.usedIn, word: null, href: null }
  }
}

export interface RecordsLink {
  readonly kind: 'report' | 'records' | 'list'
  /** Company-free. */
  readonly href: string
}

/** The drill's API path's name (`/insights/kpis/drills/otif` → otif), or null. */
export const drillNameOf = (api: string | null): string | null => (api && /^\/insights\/kpis\/drills\/[a-z-]+$/.test(api) ? api.split('/').at(-1)! : null)

/**
 * Where the records behind a KPI open, over the period shown: a report of the pack with its filters, the KPI's own records
 * page (B-W2b-429's drills, SCR-471) with the period, or an area list with its filters. Null: no page shows them yet.
 */
export function recordsLinkOf(key: string, calculation: Pick<KpiCalculation, 'drill'> | null, period: Pick<KpiPeriod, 'from' | 'to'> | null, built: ReadonlySet<string>): RecordsLink | null {
  const drill = calculation?.drill
  if (!drill) return null
  if (drill.kind === 'REPORT' && drill.key) {
    if (!built.has('/home/reports/[key]')) return null
    const qs = new URLSearchParams(drill.terms).toString()
    return { kind: 'report', href: `/home/reports/${encodeURIComponent(drill.key)}${qs ? `?${qs}` : ''}` }
  }
  if (drillNameOf(drill.api)) {
    if (!built.has('/home/kpis/[key]/records')) return null
    return { kind: 'records', href: recordsHref('', key, { from: period?.from ?? null, to: period?.to ?? null }) }
  }
  const href = listAddress(drill.api, drill.terms, built)
  return href ? { kind: 'list', href } : null
}

// ---- the CSV of the definitions ---------------------------------------------------------------------------------------------

const csvEscape = (text: string, separator: string) => (text.includes(separator) || text.includes('"') || /[\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text)

/** Every definition the person sees, in their language: `;` in Italian, `,` in English; codes in words. */
export function definitionsCsv(items: readonly KpiItem[], t: Translate, locale: Locale): string {
  const separator = locale === 'it' ? ';' : ','
  const head = ['key', 'name', 'definition', 'formula', 'area', 'unit', 'owner', 'version', 'state', 'period', 'records', 'facts', 'usedIn'].map((column) => t(`csv.${column}`))
  const lines = items.map((item) => {
    const words = wordsOf(item, locale)
    const status = statusOf(item)
    const records = item.shown?.sourceRecords ?? []
    const facts = item.shown?.measureKeys ?? item.calculation?.measures ?? []
    return [
      item.key,
      words.name,
      words.definition,
      words.formula,
      t(`area.${areaOf(item.key)}`),
      t(`unit.${item.shown?.unit ?? item.calculation?.unit ?? 'COUNT'}`),
      ownerText(ownerOf(item), t),
      status.kind === 'NOT_INSTALLED' ? '' : String(status.version),
      statusWords(status, t).text,
      item.calculation ? t(`periodKind.${item.calculation.period}`) : '',
      records.map((record) => (recordWordKey(record) ? t(recordWordKey(record)!) : record)).join(' · '),
      facts.map((fact) => (isKnownMeasure(fact) ? t(`measure.${fact}`) : fact)).join(' · '),
      String(item.uses),
    ]
  })
  return `﻿${[head, ...lines].map((line) => line.map((cell) => csvEscape(cell, separator)).join(separator)).join('\r\n')}\r\n`
}

/** `indicatori-2026-11-14.csv` */
export const csvName = (title: string, day: string): string => `${fold(title).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'kpis'}-${day}.csv`

// ---- versions: history and comparison ---------------------------------------------------------------------------------------

/** What happened to a version, newest first: written, put in force, superseded or withdrawn. */
export interface VersionEvent {
  readonly key: string
  readonly kpiVersion: number
  readonly what: 'WRITTEN' | 'IN_FORCE' | 'SUPERSEDED' | 'RETIRED'
  readonly at: string
  readonly by: string | null
  readonly note: string | null
  readonly state: KpiVersion['state']
}

export function versionEvents(versions: readonly KpiVersion[]): VersionEvent[] {
  const events: VersionEvent[] = []
  for (const version of versions) {
    events.push({ key: `${version.id}:w`, kpiVersion: version.kpiVersion, what: 'WRITTEN', at: version.createdAt, by: version.createdBy, note: version.changeNote, state: version.state })
    if (version.activatedAt) events.push({ key: `${version.id}:a`, kpiVersion: version.kpiVersion, what: 'IN_FORCE', at: version.activatedAt, by: version.activatedBy, note: null, state: version.state })
    if (version.endedAt) events.push({ key: `${version.id}:e`, kpiVersion: version.kpiVersion, what: version.state === 'RETIRED' ? 'RETIRED' : 'SUPERSEDED', at: version.endedAt, by: version.endedBy, note: null, state: version.state })
  }
  // Newest first; at the same instant, the end before the start that replaced it reads naturally from the top.
  return events.sort((a, b) => b.at.localeCompare(a.at) || b.kpiVersion - a.kpiVersion)
}

/** The pair compared by default: the newest version and the one before it (the latest change). Null with fewer than two. */
export function defaultCompare(versions: readonly KpiVersion[]): readonly [number, number] | null {
  const numbers = versions.map((version) => version.kpiVersion).sort((a, b) => a - b)
  return numbers.length < 2 ? null : [numbers.at(-2)!, numbers.at(-1)!]
}

const COMPARED_FIELDS = ['name', 'definition', 'formula', 'sourceRecords', 'measureKeys', 'unit', 'grain', 'owner'] as const
export type ComparedField = (typeof COMPARED_FIELDS)[number]

export interface FieldChange {
  readonly field: ComparedField
  readonly before: string
  readonly after: string
}

/** The fields two versions differ in, said in the reader's language (both languages of the words compared). */
export function versionChanges(before: KpiVersion, after: KpiVersion, t: Translate, locale: Locale): FieldChange[] {
  const both = (version: KpiVersion, field: 'name' | 'definition' | 'formula') => {
    const own = field === 'name' ? (locale === 'it' ? version.nameIt : version.nameEn) : field === 'definition' ? (locale === 'it' ? version.definitionIt : version.definitionEn) : locale === 'it' ? version.formulaIt : version.formulaEn
    const other = field === 'name' ? (locale === 'it' ? version.nameEn : version.nameIt) : field === 'definition' ? (locale === 'it' ? version.definitionEn : version.definitionIt) : locale === 'it' ? version.formulaEn : version.formulaIt
    return { own, other }
  }
  const text = (version: KpiVersion, field: ComparedField): string => {
    switch (field) {
      case 'name':
      case 'definition':
      case 'formula': {
        const words = both(version, field)
        return `${words.own}\n${t(`lang.${locale === 'it' ? 'en' : 'it'}`)}: ${words.other}`
      }
      case 'sourceRecords':
        return version.sourceRecords.map((record) => (recordWordKey(record) ? t(recordWordKey(record)!) : record)).join(' · ')
      case 'measureKeys':
        return version.measureKeys.map((key) => (isKnownMeasure(key) ? t(`measure.${key}`) : key)).join(' · ') || t('history.none')
      case 'unit':
        return t(`unit.${version.unit}`)
      case 'grain':
        return version.grain ? t(`grain.${version.grain.toLowerCase()}`) : t('grain.none')
      default:
        return ownerText(version.owner, t)
    }
  }
  return COMPARED_FIELDS.flatMap((field) => {
    const a = text(before, field)
    const b = text(after, field)
    return a === b ? [] : [{ field, before: a, after: b }]
  })
}

// ---- the owner's version form -------------------------------------------------------------------------------------------------

export const FORM_FIELDS = ['nameIt', 'nameEn', 'definitionIt', 'definitionEn', 'formulaIt', 'formulaEn', 'sourceRecords', 'ownerRoleId', 'changeNote'] as const
export type FormField = (typeof FORM_FIELDS)[number]

export interface VersionDraft {
  readonly nameIt: string
  readonly nameEn: string
  readonly definitionIt: string
  readonly definitionEn: string
  readonly formulaIt: string
  readonly formulaEn: string
  readonly sourceRecords: readonly string[]
  readonly ownerRoleId: string
  readonly changeNote: string
}

/** The form opened on a version: its words, records and owner; what changed empty for a new version, the draft's own when editing. */
export function draftOf(version: KpiVersion, mode: 'new' | 'edit'): VersionDraft {
  return {
    nameIt: version.nameIt,
    nameEn: version.nameEn,
    definitionIt: version.definitionIt,
    definitionEn: version.definitionEn,
    formulaIt: version.formulaIt,
    formulaEn: version.formulaEn,
    sourceRecords: [...version.sourceRecords],
    ownerRoleId: version.owner.roleId,
    changeNote: mode === 'edit' ? (version.changeNote ?? '') : '',
  }
}

/** What the version names that its calculation sets (the facts, unit and grain): a version names exactly its calculation's. */
export const calculationFields = (version: Pick<KpiVersion, 'measureKeys' | 'unit' | 'grain'>, calculation: Pick<KpiCalculation, 'measures' | 'unit' | 'grain'> | null) =>
  calculation
    ? { measureKeys: [...calculation.measures], unit: calculation.unit, grain: calculation.grain }
    : { measureKeys: [...version.measureKeys], unit: version.unit, grain: version.grain }

/** Whether the version names other facts, unit or grain than its calculation (the form writes the calculation's). */
export function differsFromCalculation(version: Pick<KpiVersion, 'measureKeys' | 'unit' | 'grain'>, calculation: Pick<KpiCalculation, 'measures' | 'unit' | 'grain'> | null): boolean {
  if (!calculation) return false
  const same = version.measureKeys.length === calculation.measures.length && calculation.measures.every((key) => version.measureKeys.includes(key))
  return !same || version.unit !== calculation.unit || version.grain !== calculation.grain
}

/** The form's problems by field (message keys), from factory-domain's own draft rules (the API checks the same). */
export function formProblems(draft: VersionDraft, base: KpiVersion, calculation: KpiCalculation | null, mode: 'new' | 'edit'): Partial<Record<FormField, string>> {
  const fixed = calculationFields(base, calculation)
  const issues = draftProblems({ ...draft, ...fixed, changeNote: mode === 'new' ? draft.changeNote : draft.changeNote || null }, new Set(['measureKeys']))
  const out: Partial<Record<FormField, string>> = {}
  for (const issue of issues) {
    const field = issue.path.replace(/^body\//, '') as FormField
    if ((FORM_FIELDS as readonly string[]).includes(field) && !out[field]) out[field] = `form.problem.${field}`
  }
  if (mode === 'new' && draft.changeNote.trim() === '') out.changeNote = 'form.problem.changeNote'
  return out
}

/** Whether the person changed anything (a new version needs a change or a fix of the calculation's facts). */
export function draftChanged(draft: VersionDraft, base: KpiVersion): boolean {
  const start = draftOf(base, 'new')
  return (['nameIt', 'nameEn', 'definitionIt', 'definitionEn', 'formulaIt', 'formulaEn', 'ownerRoleId'] as const).some((field) => draft[field].trim() !== start[field].trim()) || draft.sourceRecords.join('|') !== start.sourceRecords.join('|')
}

/** The body a save sends: only what differs from the version it starts from, plus the calculation's facts when the version differs. */
export function bodyOf(draft: VersionDraft, base: KpiVersion, calculation: KpiCalculation | null, mode: 'new' | 'edit'): VersionFields {
  const start = draftOf(base, 'edit')
  const body: VersionFields = {}
  for (const field of ['nameIt', 'nameEn', 'definitionIt', 'definitionEn', 'formulaIt', 'formulaEn'] as const) if (draft[field] !== start[field]) body[field] = draft[field]
  if (draft.sourceRecords.join('|') !== start.sourceRecords.join('|')) body.sourceRecords = [...draft.sourceRecords]
  if (draft.ownerRoleId !== start.ownerRoleId) body.ownerRoleId = draft.ownerRoleId
  if (differsFromCalculation(base, calculation)) Object.assign(body, calculationFields(base, calculation))
  if (mode === 'new' || draft.changeNote.trim() !== (base.changeNote ?? '').trim()) body.changeNote = draft.changeNote.trim()
  return body
}

// ---- refusals and read problems -----------------------------------------------------------------------------------------------

/** The known refusal codes of the KPI writes (factory-domain KPI_REFUSALS and the database's own words). */
export const WRITE_REFUSALS = ['UNKNOWN_MEASURE', 'MEASURES_DIFFER', 'UNIT_DIFFERS', 'GRAIN_DIFFERS', 'NOT_DRAFT', 'NOT_IN_FORCE', 'BASED_ON_OTHER_KPI', 'IN_FORCE', 'ENDED', 'KEPT', 'STATE', 'FACTS'] as const

/** A refused write in words: a message key (`refusal.<CODE>`, a field's problem, stale, offline …). */
export function writeProblem(error: unknown): { key: string; field: FormField | null } {
  if (!isApiError(error)) return { key: 'refusal.failed', field: null }
  const paths = (error as ApiError).issues.map(issuePath)
  const refusal = paths.map((path) => /^refusal[/.]([A-Z_]+)$/.exec(path)?.[1]).find((code): code is string => !!code && (WRITE_REFUSALS as readonly string[]).includes(code))
  if (refusal) return { key: `refusal.${refusal}`, field: null }
  const field = paths.map((path) => path.replace(/^body[/.]/, '')).find((path): path is FormField => (FORM_FIELDS as readonly string[]).includes(path))
  if (field) return { key: `form.problem.${field}`, field }
  if (paths.some((path) => /^body[/.](measureKeys|unit|grain|words)$/.test(path))) return { key: 'refusal.STATE', field: null }
  if (error.kind === 'conflict') return { key: 'refusal.stale', field: null }
  if (error.kind === 'forbidden') return { key: 'refusal.forbidden', field: null }
  if (error.kind === 'step_up') return { key: 'refusal.stepUp', field: null }
  if (error.kind === 'not_found') return { key: 'refusal.gone', field: null }
  if (error.kind === 'unavailable') return { key: 'refusal.offline', field: null }
  if (error.kind === 'invalid') return { key: 'refusal.invalid', field: null }
  return { key: 'refusal.failed', field: null }
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

/** The version a KPI's owner works on: the draft waiting (newest), and the base a new version starts from (in force, else shown). */
export function versionsAtHand(record: Pick<KpiRecord, 'versions' | 'shown'>): { draft: KpiVersion | null; base: KpiVersion | null; inForce: KpiVersion | null } {
  const inForce = record.versions.find((version) => version.state === 'ACTIVE') ?? null
  const draft = record.versions.filter((version) => version.state === 'DRAFT').sort((a, b) => b.kpiVersion - a.kpiVersion)[0] ?? null
  return { draft, base: inForce ?? record.shown ?? record.versions[0] ?? null, inForce }
}

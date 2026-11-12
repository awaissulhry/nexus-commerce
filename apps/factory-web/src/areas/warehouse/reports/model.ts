import type { SectionSpec } from '@nexus/ui/patterns'
import { formatNumber } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import type { Uom } from '../../_shared/stock/api'
import { csvOf, decimalValue, money, quantity, WAREHOUSE_PAGES } from '../../_shared/stock/model'
import { AGE_BUCKETS, LEATHER_MEASURES, type AgeBucket, type Ageing, type AgeingArticle, type AgeingType, type BucketFigures, type Leather, type LeatherArticle, type LeatherFigures, type LeatherLot, type LeatherMeasure, type LeatherQuantities, type UnitQuantity } from './api'

/**
 * The pure rules of Warehouse › Reports (B-W2b-356, SCR-257 and its print view SCR-353): what this person may open (from the
 * session's permissions; the API checks each figure again), the address (`?from=&to=`; the site is the top bar's), the panels
 * (Arrange), the words of the figures, the chart rows, where each number leads (a list's page only once built, else nothing),
 * and the CSV files. Quantities are never summed across units; nothing here names a person.
 */

export { csvOf }

// ---- rights ------------------------------------------------------------------------------------------------------------------

export interface ReportsCan {
  /** inventory.reports.view: the page. */
  view: boolean
  /** inventory.stock.view: the stock behind every figure (and the lists the figures open). */
  stock: boolean
  /** money.cost: the value series and columns. */
  cost: boolean
}

export function reportsCan(permissions: readonly string[]): ReportsCan {
  const held = new Set(permissions)
  return { view: held.has('inventory.reports.view'), stock: held.has('inventory.stock.view'), cost: held.has('money.cost') }
}

// ---- the address -------------------------------------------------------------------------------------------------------------

export interface ReportsAddress {
  from: string | null
  to: string | null
}

const dayOr = (value: string | null | undefined): string | null => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null)

export function reportsAddressOf(params: { get(name: string): string | null } | null | undefined): ReportsAddress {
  return { from: dayOr(params?.get('from')), to: dayOr(params?.get('to')) }
}

export function reportsAddressText(address: ReportsAddress): string {
  const terms = new URLSearchParams()
  if (address.from) terms.set('from', address.from)
  if (address.to) terms.set('to', address.to)
  const text = terms.toString()
  return text ? `?${text}` : ''
}

/** A business day as the date picker's local day, and back. */
export const dateOfDay = (day: string): Date => new Date(`${day}T12:00:00`)
export const dayOfDate = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

/** Today in Rome as YYYY-MM-DD (the API's "today": a period never ends after it). */
export const romeToday = (now: Date = new Date()): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)

/** This month so far (the API's default: the monthly stock review). */
export const thisMonth = (today: string): { from: string; to: string } => ({ from: `${today.slice(0, 7)}-01`, to: today })

/** The calendar month before today's. */
export function lastMonth(today: string): { from: string; to: string } {
  const [year, month] = today.split('-').map(Number) as [number, number]
  const end = new Date(Date.UTC(year, month - 1, 0))
  const to = end.toISOString().slice(0, 10)
  return { from: `${to.slice(0, 7)}-01`, to }
}

/** The period on show: the address's, else what the API answered, else this month so far. */
export function rangeShown(address: ReportsAddress, answer: { from: string; to: string } | null, today: string): { from: string; to: string } {
  const fallback = thisMonth(today)
  return { from: address.from ?? answer?.from ?? fallback.from, to: address.to ?? answer?.to ?? fallback.to }
}

/** The quick periods of the scope row. */
export const QUICK_PERIODS = ['thisMonth', 'lastMonth'] as const
export type QuickPeriod = (typeof QUICK_PERIODS)[number]
export const quickRange = (quick: QuickPeriod, today: string) => (quick === 'thisMonth' ? thisMonth(today) : lastMonth(today))

/** The print view's address (a new tab; the browser prints it or saves the PDF), with the period on show. */
export const printAddress = (prefix: string, range: { from: string; to: string }): string => `${prefix}/warehouse/reports/print${reportsAddressText(range)}`

// ---- sections (Arrange) ------------------------------------------------------------------------------------------------------

/** The design's W2b sections (wr-ageing, wr-leather), in its order; delivery and cover come with their waves. */
export const REPORT_SECTIONS = ['ageing', 'leather'] as const
export type ReportSection = (typeof REPORT_SECTIONS)[number]
export const LAYOUT_KEY = 'warehouse.reports.layout'

/** Every panel full width at first (no dead space on the right); Arrange changes the order, what shows and the widths. */
export const sectionSpecs = (label: (id: string) => string): SectionSpec[] => REPORT_SECTIONS.map((id) => ({ id, label: label(id), defaultWidth: 'full' as const }))

// ---- words -------------------------------------------------------------------------------------------------------------------

/** "130 m · 12 pz": per unit, never across units; nothing → "—". */
export function quantitiesText(rows: readonly UnitQuantity[], unitWord: (uom: Uom) => string, locale: Locale): string {
  const parts = rows.filter((row) => (decimalValue(row.quantity) ?? 0) !== 0).map((row) => `${quantity(row.quantity, locale)} ${unitWord(row.uom)}`.trim())
  return parts.length > 0 ? parts.join(' · ') : '—'
}

/** A share as "41,7 %"; unknown "—". */
export function shareText(share: string | null | undefined, locale: Locale): string {
  const value = decimalValue(share)
  return value === null ? '—' : `${formatNumber(value, locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`
}

/** Days with one decimal ("203,2"); unknown "—". */
export function daysText(days: string | number | null | undefined, locale: Locale): string {
  const value = typeof days === 'number' ? days : decimalValue(days)
  return value === null ? '—' : formatNumber(value, locale, { maximumFractionDigits: 1 })
}

/** A value with its currency, only when it is known (the cost grain): "—" otherwise. */
export const valueText = (minor: number | null | undefined, currency: string | null | undefined, locale: Locale): string => money(minor, currency, locale)

/** Who holds the cost grain gets the value series; everyone else the share of quantity. */
export const AGEING_SERIES = ['share', 'value'] as const
export type AgeingSeries = (typeof AGEING_SERIES)[number]

// ---- the ageing chart and table ------------------------------------------------------------------------------------------------

export interface AgeingChartRow {
  [key: string]: string | number
  type: string
}

/**
 * One row per material type: each bucket's share of its quantity (the share series), or its value in the currency's units (the
 * value series); the average age in days (the line). A type over several units has no share and no average: left out of the
 * share chart (the table says its quantities).
 */
export function ageingChartRows(types: readonly AgeingType[], series: AgeingSeries, typeWord: (type: AgeingType['type']) => string): AgeingChartRow[] {
  return types.flatMap((row) => {
    const parts = Object.fromEntries(
      AGE_BUCKETS.map((bucket) => {
        const figures = row.buckets[bucket]
        const value = series === 'value' ? (figures.value ?? null) : decimalValue(figures.share)
        return [bucket, value === null ? null : series === 'value' ? value / 100 : value]
      }),
    ) as Record<AgeBucket, number | null>
    if (AGE_BUCKETS.some((bucket) => parts[bucket] === null)) return []
    return [{ type: typeWord(row.type), ...(parts as Record<AgeBucket, number>), averageDays: decimalValue(row.averageDays) ?? 0 }]
  })
}

/** Types the share chart leaves out (several units: the table says them). */
export const typesWithoutShare = (types: readonly AgeingType[]): AgeingType['type'][] => types.filter((row) => row.whole.quantities.length > 1).map((row) => row.type)

/** A bucket's cell: its quantities and its share (and its value with the cost grain). */
export function bucketCell(figures: BucketFigures, unitWord: (uom: Uom) => string, locale: Locale): string {
  const amount = quantitiesText(figures.quantities, unitWord, locale)
  if (amount === '—') return '—'
  return figures.share === null ? amount : `${amount} (${shareText(figures.share, locale)})`
}

/** Where an article of the ageing table leads: Stock searched by its code (once built), and its moves (the ledger). */
export function articleHrefs(prefix: string, article: Pick<AgeingArticle, 'item' | 'colour'>): { stock: string | null; moves: string | null } {
  const built = (page: string) => OFFICE_PAGES.has(page)
  const moves = new URLSearchParams({ item: article.item.id })
  if (article.colour) moves.set('colour', article.colour.id)
  return {
    stock: built(WAREHOUSE_PAGES.stock) ? `${prefix}${WAREHOUSE_PAGES.stock}?${new URLSearchParams({ q: article.item.code }).toString()}` : null,
    moves: built(WAREHOUSE_PAGES.moves) ? `${prefix}${WAREHOUSE_PAGES.moves}?${moves.toString()}` : null,
  }
}

// ---- leather use ---------------------------------------------------------------------------------------------------------------

/** The quantities shown: m² when the article is in an area unit, else its own unit. */
export function leatherQuantities(figures: LeatherFigures): { values: LeatherQuantities; uom: Uom } | null {
  if (figures.m2) return { values: figures.m2, uom: 'M2' }
  if (figures.base && figures.uom) return { values: figures.base, uom: figures.uom }
  return null
}

/** A leather measure of a group, as a number (null when the group has no quantity in one unit). */
export function measureOf(figures: LeatherFigures, measure: LeatherMeasure): number | null {
  const shown = leatherQuantities(figures)
  return shown ? decimalValue(shown.values[measure]) : null
}

/** Where a leather bar or lot leads: Hides filtered by the article (and colour), or by the lot (once built). */
export function hidesHref(prefix: string, filter: { itemId?: string; colourId?: string | null; lotId?: string | null }): string | null {
  if (!OFFICE_PAGES.has(WAREHOUSE_PAGES.hides)) return null
  const terms = new URLSearchParams({ view: 'all' })
  if (filter.lotId) terms.set('lot', filter.lotId)
  else {
    if (filter.itemId) terms.set('item', filter.itemId)
    if (filter.colourId) terms.set('colour', filter.colourId)
  }
  return `${prefix}${WAREHOUSE_PAGES.hides}?${terms.toString()}`
}

/** An article's name: code · name · colour. */
export const articleLabel = (article: Pick<LeatherArticle, 'item' | 'colour'>): string => [`${article.item.code} · ${article.item.name}`, article.colour?.name ?? null].filter(Boolean).join(' · ')

/** A supplier lot's name: our lot code, the tannery's lot, the supplier. */
export function lotLabel(lot: LeatherLot, noLot: string): string {
  return [lot.lot?.code ?? noLot, lot.supplierLotRef, lot.supplier?.name ?? null].filter(Boolean).join(' · ')
}

export { LEATHER_MEASURES }

// ---- files -------------------------------------------------------------------------------------------------------------------

export interface CsvWords {
  header: string[]
  unitWord: (uom: Uom) => string
  typeWord: (type: AgeingType['type']) => string
  noLot: string
  locale: Locale
  /** Values are written only with the cost grain. */
  cost: boolean
}

/** The ageing panel's rows: one per material type, then one per article (the type's name first). */
export function ageingCsvRows(answer: Ageing, words: CsvWords): (string | number | null)[][] {
  const row = (type: string, article: string, figures: Pick<AgeingType, 'buckets' | 'whole' | 'averageDays' | 'oldestDays' | 'currency'>) => [
    type,
    article,
    ...AGE_BUCKETS.flatMap((bucket) => [quantitiesText(figures.buckets[bucket].quantities, words.unitWord, words.locale), shareText(figures.buckets[bucket].share, words.locale), ...(words.cost ? [valueText(figures.buckets[bucket].value, figures.currency, words.locale)] : [])]),
    quantitiesText(figures.whole.quantities, words.unitWord, words.locale),
    ...(words.cost ? [valueText(figures.whole.value, figures.currency, words.locale)] : []),
    daysText(figures.averageDays, words.locale),
    figures.oldestDays,
  ]
  return answer.types.flatMap((type) => [row(words.typeWord(type.type), '', type), ...type.articles.map((article) => row(words.typeWord(type.type), articleLabel(article), article))])
}

/** The leather panel's rows: one per article, then one per supplier lot. */
export function leatherCsvRows(answer: Leather, words: CsvWords): (string | number | null)[][] {
  const row = (article: string, lot: string, figures: LeatherFigures) => {
    const shown = leatherQuantities(figures)
    const q = (key: keyof LeatherQuantities) => (shown ? quantity(shown.values[key], words.locale) : '—')
    return [
      article,
      lot,
      shown ? words.unitWord(shown.uom) : '',
      q('start'),
      q('received'),
      q('cut'),
      q('remnant'),
      q('scrapped'),
      q('other'),
      q('end'),
      figures.hidesReceived,
      figures.hidesOnHand,
      ...(words.cost ? [valueText(figures.values.received, figures.currency, words.locale), valueText(figures.values.cut, figures.currency, words.locale), valueText(figures.values.scrapped, figures.currency, words.locale), valueText(figures.values.end, figures.currency, words.locale)] : []),
    ]
  }
  return answer.articles.flatMap((article) => [row(articleLabel(article), '', article.figures), ...article.lots.map((lot) => row(articleLabel(article), lotLabel(lot, words.noLot), lot.figures))])
}

/** A file's name: the panel and the period. */
export const csvName = (panel: ReportSection, range: { from: string; to: string }): string => `warehouse-${panel}-${range.from}-${range.to}.csv`

// ---- live --------------------------------------------------------------------------------------------------------------------

/** Design: "panels refresh on inventory.moved with their own AsOf, at most once a minute". */
export const LIVE_TYPES = ['inventory.moved'] as const
export const LIVE_EVERY_MS = 60_000

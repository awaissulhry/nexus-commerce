import type { SectionSpec } from '@nexus/ui/patterns'
import type { TimelineStep } from '@nexus/ui/components'
import type { Locale } from '../../../lib/i18n/locales'
import { recordAddress } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { csvOf, money } from '../../_shared/stock/model'
import { dateOfDay, dayOfDate, lastMonth, QUICK_PERIODS, quickRange, romeToday, thisMonth, type QuickPeriod } from '../../warehouse/reports/model'
import { EXPEDITE_REASONS, SPEND_GROUPS, type ExpediteReason, type LateRow, type Spend, type SpendFigures, type SpendGroup, type SpendGroupRow, type SpendLine, type SpendLines } from './api'

/**
 * The pure rules of Purchasing › Reports (B-W2b-350, SCR-255 and its print view SCR-372): what this person may open (from the
 * session's permissions; the API checks each figure again), the address (`?from=&to=&by=&reason=`; the site is the top bar's),
 * the panels (Arrange), the words of the figures, the bars, the pivot table, where each number leads (a record's page only once
 * built), what a late line holds up as a chain (supplier → PO line → work orders → customer orders), which rows a chase may take,
 * and the CSV files. Amounts are never summed across currencies; nothing here names a person.
 */

export { csvOf, dateOfDay, dayOfDate, lastMonth, QUICK_PERIODS, quickRange, romeToday, thisMonth, type QuickPeriod }

// ---- rights ------------------------------------------------------------------------------------------------------------------

export interface ReportsCan {
  /** purchasing.reports.view: the page. */
  view: boolean
  /** purchasing.view: the orders behind every figure (and the late lines). */
  orders: boolean
  /** money.cost: the amounts. */
  cost: boolean
  /** purchasing.send: chasing a supplier. */
  send: boolean
}

export function reportsCan(permissions: readonly string[]): ReportsCan {
  const held = new Set(permissions)
  return { view: held.has('purchasing.reports.view'), orders: held.has('purchasing.view'), cost: held.has('money.cost'), send: held.has('purchasing.send') }
}

// ---- the address -------------------------------------------------------------------------------------------------------------

export interface ReportsAddress {
  from: string | null
  to: string | null
  /** What the spend is grouped by (default supplier). */
  by: SpendGroup
  /** The late lines' reason (null: every line on the worklist). */
  reason: ExpediteReason | null
}

const dayOr = (value: string | null | undefined): string | null => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null)

export function reportsAddressOf(params: { get(name: string): string | null } | null | undefined): ReportsAddress {
  const by = params?.get('by')
  const reason = params?.get('reason')
  return {
    from: dayOr(params?.get('from')),
    to: dayOr(params?.get('to')),
    by: by && (SPEND_GROUPS as readonly string[]).includes(by) ? (by as SpendGroup) : 'supplier',
    reason: reason && (EXPEDITE_REASONS as readonly string[]).includes(reason) ? (reason as ExpediteReason) : null,
  }
}

export function reportsAddressText(address: Partial<ReportsAddress>): string {
  const terms = new URLSearchParams()
  if (address.from) terms.set('from', address.from)
  if (address.to) terms.set('to', address.to)
  if (address.by && address.by !== 'supplier') terms.set('by', address.by)
  if (address.reason) terms.set('reason', address.reason)
  const text = terms.toString()
  return text ? `?${text}` : ''
}

/** The period on show: the address's, else what the API answered, else this month so far. */
export function rangeShown(address: Pick<ReportsAddress, 'from' | 'to'>, answer: { from: string; to: string } | null, today: string): { from: string; to: string } {
  const fallback = thisMonth(today)
  return { from: address.from ?? answer?.from ?? fallback.from, to: address.to ?? answer?.to ?? fallback.to }
}

/** The print view's address (a new tab; the browser prints it or saves the PDF), with the period and the grouping on show. */
export const printAddress = (prefix: string, range: { from: string; to: string }, by: SpendGroup): string => `${prefix}/purchasing/reports/print${reportsAddressText({ ...range, by })}`

// ---- sections (Arrange) ------------------------------------------------------------------------------------------------------

/** The design's sections (sec spend, sec late), in its order. */
export const REPORT_SECTIONS = ['spend', 'late'] as const
export type ReportSection = (typeof REPORT_SECTIONS)[number]
export const LAYOUT_KEY = 'purchasing.reports.layout'

/** Every panel full width at first (no dead space on the right); Arrange changes the order, what shows and the widths. */
export const sectionSpecs = (label: (id: string) => string): SectionSpec[] => REPORT_SECTIONS.map((id) => ({ id, label: label(id), defaultWidth: 'full' as const }))

// ---- the spend -----------------------------------------------------------------------------------------------------------------

/** What the bars show: an amount only with the cost grain; counts for everyone. */
export const SPEND_MEASURES = ['production', 'samples', 'orders', 'lines'] as const
export type SpendMeasure = (typeof SPEND_MEASURES)[number]
export const measuresFor = (cost: boolean): SpendMeasure[] => (cost ? ['production', 'samples', 'orders'] : ['orders', 'lines'])
export const defaultMeasure = (cost: boolean): SpendMeasure => (cost ? 'production' : 'orders')

/** A group's number for a measure (minor units for an amount); null when it cannot be said (several currencies, no grain). */
export function measureOf(figures: Pick<SpendFigures, 'production' | 'samples' | 'orders' | 'lines' | 'sampleOrders' | 'mixedCurrencies'>, measure: SpendMeasure): number | null {
  switch (measure) {
    case 'production':
      return figures.mixedCurrencies ? null : (figures.production ?? null)
    case 'samples':
      return figures.mixedCurrencies ? null : (figures.samples ?? null)
    case 'orders':
      return figures.orders
    case 'lines':
      return figures.lines
  }
}

/** An amount in its currency; several currencies: each one ("€ 1.200 · $ 300"); unknown "—". */
export function amountText(figures: Pick<SpendFigures, 'byCurrency' | 'currency' | 'mixedCurrencies' | 'production' | 'samples'>, kind: 'production' | 'samples', locale: Locale): string {
  if (figures.mixedCurrencies) {
    const parts = figures.byCurrency.flatMap((entry) => (typeof entry[kind] === 'number' ? [money(entry[kind], entry.currency, locale)] : []))
    return parts.length > 0 ? parts.join(' · ') : '—'
  }
  return money(figures[kind] ?? null, figures.currency, locale)
}

/** A month (YYYY-MM) in words ("novembre 2026"). */
export const monthText = (month: string, locale: Locale): string => new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-15T12:00:00Z`))

export interface GroupWords {
  /** A category's words (the material's kind). */
  category: (kind: string) => string
  locale: Locale
}

/** A group's name: a supplier, material or company by code and name; a category or a month in words. */
export function groupLabel(group: Pick<SpendGroupRow, 'key' | 'code' | 'name'>, by: SpendGroup, words: GroupWords): string {
  if (by === 'category') return words.category(group.key)
  if (by === 'month') return monthText(group.key, words.locale)
  return group.code ? `${group.code} · ${group.name}` : group.name
}

/** The pivot's month columns: shown when the period spans more than one month and the rows are not months already. */
export const pivotMonths = (answer: Pick<Spend, 'months' | 'by'>): string[] => (answer.by === 'month' || answer.months.length < 2 ? [] : [...answer.months])

/** A group's figures of one month (zero when the group spent nothing then). */
export function monthOf(group: Pick<SpendGroupRow, 'months'>, month: string) {
  return group.months.find((entry) => entry.month === month) ?? null
}

/** A share as "41,7 %"; unknown "—". */
export function shareText(share: string | null | undefined, locale: Locale): string {
  if (!share) return '—'
  const value = Number(share)
  return Number.isFinite(value) ? `${new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value)} %` : '—'
}

/** Where a group leads besides its drill: a supplier's or a material's own page (once built). */
export function groupHref(prefix: string, by: SpendGroup, key: string): string | null {
  if (by === 'supplier' && OFFICE_PAGES.has('/purchasing/suppliers/[partyId]')) return `${prefix}/purchasing/suppliers/${encodeURIComponent(key)}`
  if (by === 'material' && OFFICE_PAGES.has('/products/materials/[id]')) return `${prefix}/products/materials/${encodeURIComponent(key)}`
  return null
}

/** A purchase order's own page. */
export const orderHref = (prefix: string, orderId: string, number?: string): string => `${prefix}${recordAddress({ type: 'PurchaseOrder', id: orderId, ...(number ? { label: number } : {}) }, OFFICE_PAGES)}`

/** The drill's neighbours (J / K): the group before and after the one open, in the bars' order. */
export function neighbourOf(groups: readonly Pick<SpendGroupRow, 'key'>[], key: string, step: 1 | -1): string | null {
  const index = groups.findIndex((group) => group.key === key)
  if (index < 0) return null
  return groups[index + step]?.key ?? null
}

// ---- the late lines ------------------------------------------------------------------------------------------------------------

/** The order states a chase goes to (factory-domain expediting chaseProblem). */
const CHASEABLE = ['SENT', 'CONFIRMED', 'CHANGES_PROPOSED', 'PARTLY_RECEIVED']

/** Why a late line cannot be selected for a chase (words), or null when it can. */
export function chaseHeldOf(row: Pick<LateRow, 'status'>, can: Pick<ReportsCan, 'send'>, words: { send: string; status: string }): string | null {
  if (!can.send) return words.send
  if (!CHASEABLE.includes(row.status)) return words.status
  return null
}

export interface ChaseGroup {
  orderId: string
  number: string
  supplierName: string
  version: number
  lineIds: string[]
  seqs: number[]
}

/** The selected late lines by order: one chase per order, for its chosen lines. */
export function chaseGroupsOf(rows: readonly LateRow[], selected: readonly string[]): ChaseGroup[] {
  const groups = new Map<string, ChaseGroup>()
  for (const row of rows) {
    if (!selected.includes(row.lineId)) continue
    const group = groups.get(row.purchaseOrderId) ?? { orderId: row.purchaseOrderId, number: row.number, supplierName: row.supplierName, version: row.version, lineIds: [], seqs: [] }
    group.lineIds.push(row.lineId)
    group.seqs.push(row.seq)
    groups.set(row.purchaseOrderId, group)
  }
  return [...groups.values()]
}

/** The work orders and customer orders a line holds up (each once, the latest day first lost), late ones first. */
export function blockedOf(row: Pick<LateRow, 'blocks'>) {
  const workOrders = new Map<string, { id: string; number: string; dueDate: string | null; lateBy: number }>()
  const salesOrders = new Map<string, { id: string; number: string; promiseDate: string | null; lateBy: number }>()
  for (const entry of row.blocks.entries) {
    if (entry.workOrder) {
      const seen = workOrders.get(entry.workOrder.id)
      workOrders.set(entry.workOrder.id, { id: entry.workOrder.id, number: entry.workOrder.number, dueDate: entry.workOrder.dueDate, lateBy: Math.max(seen?.lateBy ?? 0, entry.lateBy) })
    }
    if (entry.salesOrder) {
      const seen = salesOrders.get(entry.salesOrder.id)
      salesOrders.set(entry.salesOrder.id, { id: entry.salesOrder.id, number: entry.salesOrder.number, promiseDate: entry.salesOrder.promiseDate, lateBy: Math.max(seen?.lateBy ?? 0, entry.lateBy) })
    }
  }
  const order = <T extends { lateBy: number; number: string }>(list: T[]) => list.sort((a, b) => b.lateBy - a.lateBy || a.number.localeCompare(b.number))
  return { workOrders: order([...workOrders.values()]), salesOrders: order([...salesOrders.values()]) }
}

/** A record's page (a work order, a customer order) once built. */
export const recordHref = (prefix: string, type: 'WorkOrder' | 'SalesOrder' | 'PurchaseOrder', id: string, label?: string): string => `${prefix}${recordAddress({ type, id, ...(label ? { label } : {}) }, OFFICE_PAGES)}`

export interface ChainWords {
  supplier: (name: string) => string
  line: (number: string, seq: number, item: string) => string
  lineDetail: (row: LateRow) => string
  workOrder: (number: string) => string
  workOrderDetail: (dueDate: string | null, lateBy: number) => string
  salesOrder: (number: string) => string
  salesOrderDetail: (promiseDate: string | null, lateBy: number) => string
  nothing: string
}

/**
 * The chain of one late line (design CauseChain: "order ← work order ← material ← PO ← supplier", with a reason at each step):
 * the supplier, the PO line and when it is expected, then each work order and customer order it holds up with how late — a
 * danger step when late, a quiet one when still in time. Composed with the DS Timeline (no times: its steps are causes).
 */
export function chainOf(row: LateRow, words: ChainWords): TimelineStep[] {
  const blocked = blockedOf(row)
  const lineTone = row.daysLate > 0 || row.confirmedLaterBy > 0 ? 'warning' : 'neutral'
  const steps: TimelineStep[] = [
    { key: 'supplier', label: words.supplier(row.supplierName), tone: 'neutral' },
    { key: 'line', label: words.line(row.number, row.seq, `${row.item.code} ${row.item.name}${row.colour ? ` · ${row.colour.name}` : ''}`), tone: lineTone, detail: words.lineDetail(row) },
    ...blocked.workOrders.map((entry): TimelineStep => ({ key: `wo:${entry.id}`, label: words.workOrder(entry.number), tone: entry.lateBy > 0 ? 'danger' : 'success', detail: words.workOrderDetail(entry.dueDate, entry.lateBy) })),
    ...blocked.salesOrders.map((entry): TimelineStep => ({ key: `so:${entry.id}`, label: words.salesOrder(entry.number), tone: entry.lateBy > 0 ? 'danger' : 'success', detail: words.salesOrderDetail(entry.promiseDate, entry.lateBy) })),
  ]
  if (blocked.workOrders.length + blocked.salesOrders.length === 0) steps.push({ key: 'none', label: words.nothing, tone: 'neutral' })
  return steps
}

// ---- files -------------------------------------------------------------------------------------------------------------------

export interface SpendCsvWords {
  header: string[]
  group: (row: SpendGroupRow) => string
  month: (month: string) => string
  locale: Locale
  /** Amounts are written only with the cost grain. */
  cost: boolean
}

/** The spend panel's rows: one per group (its months first when the pivot shows them), then the total. */
export function spendCsvRows(answer: Spend, words: SpendCsvWords, total: string): (string | number | null)[][] {
  const months = pivotMonths(answer)
  const row = (name: string, figures: SpendFigures & { share?: string | null | undefined; months?: SpendGroupRow['months'] }) => [
    name,
    ...(words.cost ? months.map((month) => { const entry = figures.months?.find((item) => item.month === month); return entry ? money(entry.production ?? null, entry.currency, words.locale) : '' }) : []),
    ...(words.cost ? [amountText(figures, 'production', words.locale), amountText(figures, 'samples', words.locale)] : []),
    figures.orders,
    figures.lines,
    figures.sampleOrders,
    ...(words.cost ? [shareText(figures.share, words.locale)] : []),
  ]
  return [...answer.groups.map((group) => row(words.group(group), group)), row(total, answer.all)]
}

/** The lines behind one bar as a file. */
export function drillCsvRows(answer: SpendLines, words: { kind: (kind: SpendLine['kind']) => string; locale: Locale; cost: boolean }): (string | number | null)[][] {
  return answer.lines.map((line) => [line.number, line.seq, line.placedOn, words.kind(line.kind), `${line.supplier.code} ${line.supplier.name}`, `${line.item.code} ${line.item.name}`, line.colour?.name ?? '', line.quantity, line.uom, ...(words.cost ? [money(line.spend ?? null, line.currency, words.locale)] : [])])
}

/** The late lines as a file: each row with what it holds up. */
export function lateCsvRows(rows: readonly LateRow[], words: { reason: (reason: ExpediteReason) => string }): (string | number | null)[][] {
  return rows.map((row) => {
    const blocked = blockedOf(row)
    return [
      row.number,
      row.seq,
      row.supplierName,
      `${row.item.code} ${row.item.name}`,
      row.needDate,
      row.expectedDate,
      row.daysLate,
      row.reasons.map(words.reason).join(', '),
      blocked.workOrders.map((entry) => entry.number).join(' '),
      blocked.salesOrders.map((entry) => `${entry.number}${entry.promiseDate ? ` (${entry.promiseDate})` : ''}`).join(' '),
    ]
  })
}

/** A file's name: the panel and the period. */
export const csvName = (panel: ReportSection | 'drill', range: { from: string; to: string }): string => `purchasing-${panel}-${range.from}-${range.to}.csv`

// ---- live --------------------------------------------------------------------------------------------------------------------

/** Design: "purchasing.po.*, inventory.receipt.posted → panels refresh with their own AsOf" (at most once a minute). */
export const LIVE_TYPES = ['purchase_order.', 'inventory.receipt_posted', 'supplier.status_changed'] as const
export const LIVE_EVERY_MS = 60_000

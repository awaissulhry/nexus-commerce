import { isApiError, issuePath } from '../../../lib/api/errors'
import { formatDate, formatNumber } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import type { DrillAnswer, DrillName, DrillRecord, DrillRef } from './api'
import { DRILL_NAMES } from './api'
import type { Translate } from './model'

/**
 * The records behind a KPI (SCR-471; B-W2b-429's drills, KP2:01 "each KPI's drill opens its list with the filters it
 * needs"), pure: which drill a KPI reads and with what terms, the period asked, and each answer as one view — its overall
 * (which equals the KPI's value over the same period), its groups (customer, site and month; product family; line and stage;
 * grade, lot and style; customer and style; supplier, shortages and cover) and its rows, each row opening its record. Codes
 * in words (`home-kpis`); money by grain (a figure the person may not see is absent, and so is its column).
 */

export const isDrillName = (name: string | null): name is DrillName => name !== null && (DRILL_NAMES as readonly string[]).includes(name)

/** The drills that read a company (the others read sites). */
const COMPANY_DRILLS: readonly DrillName[] = ['otif', 'lead-times', 'margin']
/** The drills over a period (WIP is now). */
export const PERIOD_DRILLS: readonly DrillName[] = ['otif', 'lead-times', 'leather-yield', 'margin', 'supply']

const DAY = /^\d{4}-\d{2}-\d{2}$/
const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / 86_400_000

export interface DrillSpan {
  readonly from: string | null
  readonly to: string | null
}

/** The period in the address, when it is a real span (a day each, from before to, at most 366 days). */
export function spanOf(params: { get(name: string): string | null } | null): DrillSpan {
  const from = params?.get('from') ?? ''
  const to = params?.get('to') ?? ''
  if (!DAY.test(from) || !DAY.test(to) || Number.isNaN(dayNumber(from)) || Number.isNaN(dayNumber(to))) return { from: null, to: null }
  if (dayNumber(to) < dayNumber(from) || dayNumber(to) - dayNumber(from) > 365) return { from: null, to: null }
  return { from, to }
}

/** Why a span cannot be read (a message key), or null. */
export function spanProblem(from: string, to: string): string | null {
  if (!DAY.test(from) || !DAY.test(to)) return 'records.span.day'
  if (dayNumber(to) < dayNumber(from)) return 'records.span.backwards'
  if (dayNumber(to) - dayNumber(from) > 365) return 'records.span.long'
  return null
}

/** The drill's query: the KPI's terms, the period read and the company of the address (for the drills that read one). */
export function drillQuery(name: DrillName, terms: Readonly<Record<string, string>>, span: DrillSpan, companyId: string | null): Record<string, string> {
  const query: Record<string, string> = { ...terms }
  if (PERIOD_DRILLS.includes(name) && span.from && span.to) {
    query.from = span.from
    query.to = span.to
  }
  if (companyId && COMPANY_DRILLS.includes(name)) query.companyId = companyId
  return query
}

export function recordsHref(prefix: string, key: string, span: DrillSpan): string {
  const query = new URLSearchParams()
  if (span.from && span.to) {
    query.set('from', span.from)
    query.set('to', span.to)
  }
  const qs = query.toString()
  return `${prefix}/home/kpis/${encodeURIComponent(key)}/records${qs ? `?${qs}` : ''}`
}

/** A refused drill in words: a missing permission or money right names it; else the read's problem. */
export function drillProblem(error: unknown): { key: string; params?: Record<string, string> } {
  if (!isApiError(error)) return { key: 'error.read' }
  for (const path of error.issues.map(issuePath)) {
    const grain = /^grain[/.]([a-z]+)$/.exec(path)?.[1]
    if (grain) return { key: 'records.needsGrain', params: { grain } }
    const permission = /^permission[/.]([a-z.]+)$/.exec(path)?.[1]
    if (permission) return { key: 'records.needsPermission', params: { permission } }
  }
  if (error.kind === 'forbidden') return { key: 'error.forbidden' }
  if (error.kind === 'invalid') return { key: 'records.span.invalid' }
  if (error.kind === 'unavailable') return { key: 'error.offline' }
  if (error.kind === 'not_found') return { key: 'error.notFound' }
  return { key: 'error.read' }
}

// ---- one view of any drill --------------------------------------------------------------------------------------------------

export interface DrillColumn {
  readonly id: string
  readonly label: string
  readonly align?: 'right'
}

export interface DrillRow {
  readonly id: string
  readonly record: DrillRecord
  readonly cells: Readonly<Record<string, string>>
}

export interface DrillGroup {
  readonly id: string
  readonly title: string
  readonly columns: readonly string[]
  readonly align: readonly ('left' | 'right')[]
  readonly rows: readonly { id: string; cells: readonly string[] }[]
  /** Said instead of an empty table. */
  readonly empty?: string
}

export interface DrillView {
  readonly asOf: string
  readonly period: { readonly from: string; readonly to: string } | null
  readonly metrics: readonly { readonly label: string; readonly value: string; readonly hint?: string }[]
  readonly notes: readonly string[]
  readonly groups: readonly DrillGroup[]
  readonly columns: readonly DrillColumn[]
  readonly rows: readonly DrillRow[]
  readonly more: number
}

const dash = '—'

export function drillView(answer: DrillAnswer, t: Translate, locale: Locale): DrillView {
  const n = (value: number | null) => (value === null ? dash : formatNumber(value, locale))
  const dec = (value: string | null, digits = 1) => (value === null ? dash : formatNumber(Number(value), locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }))
  const pct = (value: string | null) => (value === null ? dash : `${dec(value)} %`)
  const day = (value: string | null) => (value === null ? dash : formatDate(`${value}T12:00:00Z`, { locale }))
  const days = (value: number | string | null) => (value === null ? dash : t('valueOf.DAYS', { value: typeof value === 'number' ? formatNumber(value, locale) : dec(value), count: Number(value) }))
  const area = (value: string | null) => (value === null ? dash : t('records.m2', { value: dec(value, 2) }))
  const name = (ref: DrillRef | null) => (ref ? `${ref.code} · ${ref.name}` : t('records.none'))
  const code = (prefix: string, value: string | null) => (value === null ? t('records.none') : t(`${prefix}.${value}`))

  switch (answer.name) {
    case 'otif': {
      const data = answer.data
      const rateRow = (id: string, label: string, rate: { due: number; onTime: number; pct: string | null }) => ({ id, cells: [label, n(rate.due), n(rate.onTime), pct(rate.pct)] })
      const rateColumns = (first: string) => [first, t('records.col.due'), t('records.col.onTime'), t('records.col.pct')]
      return {
        asOf: data.asOf,
        period: data.period,
        metrics: [
          { label: t('records.metric.otif'), value: pct(data.overall.pct), hint: t(`records.promise.${data.promise}`) },
          { label: t('records.metric.linesDue'), value: n(data.overall.due) },
          { label: t('records.metric.onTime'), value: n(data.overall.onTime) },
          { label: t('records.metric.late'), value: n(data.overall.late) },
        ],
        notes: [],
        groups: [
          { id: 'customer', title: t('records.group.byCustomer'), columns: rateColumns(t('records.col.customer')), align: ['left', 'right', 'right', 'right'], rows: data.byCustomer.map((row, i) => rateRow(`c${i}`, name(row.customer), row)) },
          { id: 'site', title: t('records.group.bySite'), columns: rateColumns(t('records.col.site')), align: ['left', 'right', 'right', 'right'], rows: data.bySite.map((row, i) => rateRow(`s${i}`, name(row.site), row)) },
          { id: 'month', title: t('records.group.byMonth'), columns: rateColumns(t('records.col.month')), align: ['left', 'right', 'right', 'right'], rows: data.byMonth.map((row) => rateRow(row.month, row.month, row)) },
        ],
        columns: [
          { id: 'line', label: t('records.col.orderLine') },
          { id: 'customer', label: t('records.col.customer') },
          { id: 'style', label: t('records.col.style') },
          { id: 'site', label: t('records.col.site') },
          { id: 'priority', label: t('records.col.priority') },
          { id: 'due', label: t('records.col.pieces'), align: 'right' },
          { id: 'promise', label: t('records.col.promise') },
          { id: 'completeOn', label: t('records.col.completeOn') },
          { id: 'outcome', label: t('records.col.outcome') },
          { id: 'lateDays', label: t('records.col.lateDays'), align: 'right' },
        ],
        rows: data.rows.map((row) => ({
          id: row.lineId,
          record: row.record,
          cells: {
            line: `${row.order.number}/${row.seq}`,
            customer: name(row.customer),
            style: name(row.style),
            site: name(row.site),
            priority: code('priority', row.priority),
            due: n(row.due),
            promise: day(row.promise),
            completeOn: day(row.completeOn),
            outcome: code('outcome', row.outcome),
            lateDays: row.lateDays > 0 ? days(row.lateDays) : dash,
          },
        })),
        more: data.more,
      }
    }
    case 'lead-times': {
      const data = answer.data
      return {
        asOf: data.asOf,
        period: data.period,
        metrics: [
          { label: t('records.metric.average'), value: days(data.overall.averageDays), hint: t(`leadKind.${data.kind}`) },
          { label: t('records.metric.median'), value: days(data.overall.medianDays) },
          { label: t('records.metric.spread'), value: data.overall.p25Days === null ? dash : t('records.middleHalf', { from: dec(data.overall.p25Days), to: dec(data.overall.p75Days) }) },
          { label: t('records.metric.orders'), value: n(data.overall.orders) },
        ],
        notes: [t('records.note.median')],
        groups: [
          {
            id: 'family',
            title: t('records.group.byFamily'),
            columns: [t('records.col.family'), t('records.col.orders'), t('records.col.median'), t('records.col.middleHalf'), t('records.col.average')],
            align: ['left', 'right', 'right', 'right', 'right'],
            rows: data.families.map((row, i) => ({
              id: `f${i}`,
              cells: [code('family', row.family), n(row.orders), days(row.medianDays), row.p25Days === null ? dash : t('records.middleHalf', { from: dec(row.p25Days), to: dec(row.p75Days) }), days(row.averageDays)],
            })),
          },
        ],
        columns: [
          { id: 'order', label: t('records.col.order') },
          { id: 'customer', label: t('records.col.customer') },
          { id: 'family', label: t('records.col.family') },
          { id: 'priority', label: t('records.col.priority') },
          { id: 'from', label: t('records.col.fromDay') },
          { id: 'to', label: t('records.col.toDay') },
          { id: 'days', label: t('records.col.days'), align: 'right' },
        ],
        rows: data.rows.map((row) => ({
          id: row.order.id,
          record: row.record,
          cells: { order: row.order.number, customer: name(row.customer), family: code('family', row.family), priority: code('priority', row.priority), from: day(row.fromDay), to: day(row.toDay), days: days(row.days) },
        })),
        more: data.more,
      }
    }
    case 'wip': {
      const data = answer.data
      const money = (value: number | null, currency: string | null) => (value === null ? dash : currency ? formatNumber(value / 100, locale, { style: 'currency', currency }) : formatNumber(value / 100, locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
      const withValue = data.overall.value !== null
      return {
        asOf: data.asOf,
        period: null,
        metrics: [
          { label: t('records.metric.workOrders'), value: n(data.overall.workOrders) },
          { label: t('records.metric.pieces'), value: n(data.overall.pieces) },
          { label: t('records.metric.waiting'), value: n(data.overall.waiting) },
          ...(withValue ? [{ label: t('records.metric.wipValue'), value: money(data.overall.value, data.overall.currency) }] : []),
        ],
        notes: [t('records.note.wipNow')],
        groups: [
          {
            id: 'stages',
            title: t('records.group.byStage'),
            columns: [t('records.col.line'), t('records.col.operation'), t('records.col.workOrders'), t('records.col.waiting'), ...(['D0_2', 'D3_5', 'D6_10', 'D11_PLUS'] as const).map((band) => t(`band.${band}`))],
            align: ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right'],
            rows: data.stages.map((row, i) => ({ id: `st${i}`, cells: [row.line ? name(row.line) : t('records.noLine'), `${row.operation.code} · ${row.operation.name}`, n(row.workOrders), n(row.waiting), n(row.ageing.D0_2), n(row.ageing.D3_5), n(row.ageing.D6_10), n(row.ageing.D11_PLUS)] })),
          },
        ],
        columns: [
          { id: 'workOrder', label: t('records.col.workOrder') },
          { id: 'site', label: t('records.col.site') },
          { id: 'line', label: t('records.col.line') },
          { id: 'style', label: t('records.col.style') },
          { id: 'released', label: t('records.col.released') },
          { id: 'pieces', label: t('records.col.pieces'), align: 'right' },
          { id: 'age', label: t('records.col.age'), align: 'right' },
          { id: 'waited', label: t('records.col.waited'), align: 'right' },
          { id: 'band', label: t('records.col.band') },
          ...(withValue ? [{ id: 'value', label: t('records.col.valueCost'), align: 'right' as const }] : []),
        ],
        rows: data.rows.map((row) => ({
          id: row.workOrder.id,
          record: row.record,
          cells: {
            workOrder: row.workOrder.number,
            site: name(row.site),
            line: row.line ? name(row.line) : t('records.noLine'),
            style: name(row.style),
            released: day(row.releasedOn),
            pieces: n(row.pieces),
            age: days(row.ageDays),
            waited: days(row.waitedDays),
            band: code('band', row.band),
            value: money(row.value, row.currency),
          },
        })),
        more: data.more,
      }
    }
    case 'leather-yield': {
      const data = answer.data
      const areaColumns = (first: string) => [first, t('records.col.cut'), t('records.col.pattern'), t('records.col.waste'), t('records.col.yield'), t('records.col.hides')]
      const areaRow = (id: string, label: string, row: { cutM2: string; patternM2: string; wasteM2: string; yieldPct: string | null; hides: number }) => ({ id, cells: [label, area(row.cutM2), area(row.patternM2), area(row.wasteM2), pct(row.yieldPct), n(row.hides)] })
      const align = ['left', 'right', 'right', 'right', 'right', 'right'] as const
      return {
        asOf: data.asOf,
        period: data.period,
        metrics: [
          { label: t('records.metric.yield'), value: pct(data.overall.yieldPct) },
          { label: t('records.metric.cut'), value: area(data.overall.cutM2) },
          { label: t('records.metric.pattern'), value: area(data.overall.patternM2) },
          { label: t('records.metric.waste'), value: area(data.overall.wasteM2), hint: data.overall.wastePct === null ? undefined : pct(data.overall.wastePct) },
        ],
        notes: [],
        groups: [
          { id: 'grade', title: t('records.group.byGrade'), columns: areaColumns(t('records.col.grade')), align, rows: data.byGrade.map((row, i) => areaRow(`g${i}`, row.grade ?? t('records.none'), row)) },
          { id: 'lot', title: t('records.group.byLot'), columns: areaColumns(t('records.col.lot')), align, rows: data.byLot.map((row, i) => areaRow(`l${i}`, `${row.lot.code}${row.supplier ? ` · ${row.supplier.name}` : ''}`, row)) },
          { id: 'style', title: t('records.group.byStyle'), columns: areaColumns(t('records.col.style')), align, rows: data.byStyle.map((row, i) => areaRow(`y${i}`, name(row.style), row)) },
        ],
        columns: [
          { id: 'hide', label: t('records.col.hide') },
          { id: 'lot', label: t('records.col.lot') },
          { id: 'supplier', label: t('records.col.supplier') },
          { id: 'workOrder', label: t('records.col.workOrder') },
          { id: 'style', label: t('records.col.style') },
          { id: 'lastCut', label: t('records.col.lastCut') },
          { id: 'cut', label: t('records.col.cut'), align: 'right' },
          { id: 'pattern', label: t('records.col.pattern'), align: 'right' },
          { id: 'yield', label: t('records.col.yield'), align: 'right' },
        ],
        rows: data.rows.map((row) => ({
          id: `${row.hide.id}:${row.workOrder.id}`,
          record: row.record,
          cells: { hide: row.hide.code, lot: row.lot.code, supplier: name(row.supplier), workOrder: row.workOrder.number, style: name(row.style), lastCut: day(row.lastCutOn), cut: area(row.cutM2), pattern: area(row.patternM2), yield: pct(row.yieldPct) },
        })),
        more: data.more,
      }
    }
    case 'margin': {
      const data = answer.data
      const money = (value: number | null) => (value === null ? dash : data.currency ? formatNumber(value / 100, locale, { style: 'currency', currency: data.currency }) : formatNumber(value / 100, locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
      const pts = (value: string | null) => (value === null ? dash : t('records.points', { value: `${Number(value) > 0 ? '+' : ''}${dec(value)}` }))
      const withValue = data.overall.value !== null
      const withAmounts = data.overall.quotedMargin !== null
      const head = (first: string) => [first, t('records.col.garments'), ...(withValue ? [t('records.col.valuePrice')] : []), ...(withAmounts ? [t('records.col.quotedMargin'), t('records.col.actualMargin')] : []), t('records.col.quotedPct'), t('records.col.actualPct'), t('records.col.change')]
      const line = (id: string, label: string, row: typeof data.overall | (typeof data.byStyle)[number]) => ({
        id,
        cells: [label, n(row.garments), ...(withValue ? [money(row.value)] : []), ...(withAmounts ? [money(row.quotedMargin), money(row.actualMargin)] : []), pct(row.quotedPct), pct(row.actualPct), pts(row.changePts)],
      })
      const align = head('').map((_, i) => (i === 0 ? 'left' : 'right') as 'left' | 'right')
      return {
        asOf: data.asOf,
        period: data.period,
        metrics: [
          { label: t('records.metric.quoted'), value: pct(data.overall.quotedPct) },
          { label: t('records.metric.actual'), value: pct(data.overall.actualPct), hint: pts(data.overall.changePts) },
          { label: t('records.metric.orders'), value: n(data.overall.orders) },
          { label: t('records.metric.garments'), value: n(data.overall.garments) },
        ],
        notes: [
          ...(data.converted.length > 0 ? [t('now.converted', { currencies: data.converted.join(', ') })] : []),
          ...(data.unconverted > 0 ? [t('records.note.unconverted', { count: data.unconverted })] : []),
          ...(!withAmounts ? [t('records.note.amountsHidden')] : []),
        ],
        groups: [
          { id: 'customer', title: t('records.group.byCustomer'), columns: head(t('records.col.customer')), align, rows: data.byCustomer.map((row, i) => line(`c${i}`, name(row.customer), row)) },
          { id: 'style', title: t('records.group.byStyle'), columns: head(t('records.col.style')), align, rows: data.byStyle.map((row, i) => line(`y${i}`, name(row.style), row)) },
        ],
        columns: [
          { id: 'order', label: t('records.col.order') },
          { id: 'customer', label: t('records.col.customer') },
          { id: 'shipped', label: t('records.col.lastShipped') },
          { id: 'garments', label: t('records.col.garments'), align: 'right' },
          ...(withValue ? [{ id: 'value', label: t('records.col.valuePrice'), align: 'right' as const }] : []),
          { id: 'quotedPct', label: t('records.col.quotedPct'), align: 'right' },
          { id: 'actualPct', label: t('records.col.actualPct'), align: 'right' },
          { id: 'change', label: t('records.col.change'), align: 'right' },
        ],
        rows: data.rows.map((row) => ({
          id: row.order.id,
          record: row.record,
          cells: { order: row.order.number, customer: name(row.customer), shipped: day(row.lastShippedOn), garments: n(row.garments), value: money(row.value), quotedPct: pct(row.quotedPct), actualPct: pct(row.actualPct), change: pts(row.changePts) },
        })),
        more: data.more,
      }
    }
    default: {
      const data = answer.data
      const groups: DrillGroup[] = [
        {
          id: 'supplier',
          title: t('records.group.bySupplier'),
          columns: [t('records.col.supplier'), t('records.col.received'), t('records.col.onTime'), t('records.col.pct'), t('records.col.worstLate')],
          align: ['left', 'right', 'right', 'right', 'right'],
          rows: data.bySupplier.map((row, i) => ({ id: `s${i}`, cells: [name(row.supplier), n(row.received), n(row.onTime), pct(row.pct), row.worstLateDays > 0 ? days(row.worstLateDays) : dash] })),
        },
        {
          id: 'shortages',
          title: t('records.group.shortages'),
          columns: [t('records.col.workOrder'), t('records.col.site'), t('records.col.style'), t('records.col.shortages'), t('records.col.neededBy')],
          align: ['left', 'left', 'left', 'right', 'left'],
          rows: (data.shortages?.workOrders ?? []).map((row) => ({ id: row.workOrder.id, cells: [row.workOrder.number, name(row.site), name(row.style), n(row.shortages), day(row.neededBy)] })),
          empty: data.shortages ? t('records.noShortages') : t('records.shortagesHidden'),
        },
        {
          id: 'cover',
          title: t('records.group.cover', { days: data.cover?.windowDays ?? 30 }),
          columns: [t('records.col.item'), t('records.col.site'), t('records.col.onHand'), t('records.col.perDay'), t('records.col.cover'), t('records.col.oldestLot')],
          align: ['left', 'left', 'right', 'right', 'right', 'right'],
          rows: (data.cover?.rows ?? []).map((row, i) => ({
            id: `v${i}`,
            cells: [`${name(row.item)}${row.colour ? ` · ${row.colour.name}` : ''}`, name(row.site), `${dec(row.onHand, 2)} ${row.uom}`, `${dec(row.perDay, 2)} ${row.uom}`, days(row.coverDays), row.oldestLotDays === null ? dash : days(row.oldestLotDays)],
          })),
          empty: data.cover ? t('records.noCover') : t('records.coverHidden'),
        },
      ]
      return {
        asOf: data.asOf,
        period: data.period,
        metrics: [
          { label: t('records.metric.supplierOnTime'), value: pct(data.overall.pct) },
          { label: t('records.metric.received'), value: n(data.overall.received) },
          { label: t('records.metric.onTime'), value: n(data.overall.onTime) },
          { label: t('records.metric.late'), value: n(data.overall.late) },
        ],
        notes: data.shortages && data.shortages.materials > 0 ? [t('records.note.materialsShort', { count: data.shortages.materials })] : [],
        groups,
        columns: [
          { id: 'po', label: t('records.col.poLine') },
          { id: 'receipt', label: t('records.col.receipt') },
          { id: 'supplier', label: t('records.col.supplier') },
          { id: 'item', label: t('records.col.item') },
          { id: 'category', label: t('records.col.category') },
          { id: 'due', label: t('records.col.dueDay') },
          { id: 'posted', label: t('records.col.posted') },
          { id: 'outcome', label: t('records.col.outcome') },
          { id: 'lateDays', label: t('records.col.lateDays'), align: 'right' },
        ],
        rows: data.rows.map((row) => ({
          id: `${row.receipt.id}:${row.purchaseOrder.id}:${row.seq}`,
          record: row.record,
          cells: {
            po: `${row.purchaseOrder.number}/${row.seq}`,
            receipt: row.receipt.number,
            supplier: name(row.supplier),
            item: name(row.item),
            category: code('category', row.category),
            due: day(row.due),
            posted: day(row.postedOn),
            outcome: t(row.onTime ? 'outcome.ON_TIME' : 'outcome.LATE'),
            lateDays: row.lateDays > 0 ? days(row.lateDays) : dash,
          },
        })),
        more: data.more,
      }
    }
  }
}

import type { PiecesColourway } from '../../../../../lib/production/model'
import type { Order } from '../../api'
import { daysUntil } from '../../model' // F-OO-121: a late line's days
import { groupMadeToMeasure, unitsOf } from '../../mtm-groups'
import type { Dates, OrderProduction, ProductionLine } from './api'

/**
 * F-OO-100 (order overview lane: one file per section) — "Progress by line", its rules moved out of model.ts unchanged (F-SA-232:
 * the order's OWN pieces per line: Ordered · Cut and bundled · Sewn · Checked · Packed · Shipped; "Not counted here" where a site
 * does not count a step, never 0), whose row opens the line's sizes. Every figure is the production read's (B-SA-031).
 *
 * F-OO-121 (10-design §2.2): the line cell is clean — no stage word per line (the order's stage is "Where it is now"), at most two
 * pills in a fixed order (the rest in the line's window), a line with no work order "—" with no sub (office only: the portal's
 * own rule, portal-orders/progress.ts, is untouched), and the made-extra pill in the API's words (B-OO-015).
 */

// ---- O2 "Progress by line" -----------------------------------------------------------------------------------------------------

/** The columns, in their order (the shared catalogue's words: `parts.pieces.stages.*`, + Shipped). */
export const LINE_COLUMNS = ['ordered', 'cut', 'sewn', 'checked', 'packed', 'shipped'] as const
export type LineColumn = (typeof LINE_COLUMNS)[number]

/** A figure: a count, or "not counted here" (null: the site does not count that step — never 0). */
export type Figure = number | null

export interface LineRow {
  /** The row's key: the line's id, or the made-to-measure group's. */
  readonly id: string
  /** The line ids the row stands for (a made-to-measure group: one per unit). */
  readonly lineIds: readonly string[]
  readonly seq: number
  readonly style: { readonly code: string; readonly name: string } | null
  readonly colourway: { readonly code: string; readonly name: string } | null
  /** The style id and colourway id (the line's picture). */
  readonly styleId: string | null
  readonly colourwayId: string | null
  readonly mtm: { readonly units: number } | null
  readonly figures: Readonly<Record<LineColumn, Figure>>
  readonly notInWorkOrders: boolean
  /** F-OO-121: no work order makes the line yet — its steps say "—" alone (never 0, never "Not counted here"; office only). */
  readonly quiet: boolean
  /** F-OO-121: the line's pieces in work orders ("In work orders: 4 of 7"). */
  readonly inWorkOrders: number
  /** Office only: pieces cut beyond what the line now wants (a change lowered it after cutting). */
  readonly madeExtra: number
}

const sumOf = (values: readonly Figure[]): Figure => (values.every((value) => value === null) ? null : values.reduce<number>((sum, value) => sum + (value ?? 0), 0))

/**
 * The rows of "Progress by line": one per colour line in the order's own figures; the made-to-measure units of one style × colourway
 * are ONE row (R9). Fees are left out (no pieces). The order read's lines give the ids of the style and colourway (the picture).
 */
export function lineRowsOf(lines: readonly ProductionLine[], order: Pick<Order, 'lines'>): LineRow[] {
  const ofOrder = new Map(order.lines.map((line) => [line.id, line]))
  const goods = [...lines].filter((line) => line.kind !== 'FEE').sort((a, b) => a.seq - b.seq)
  return groupMadeToMeasure(goods, (line) => line.lineId).map((entry) => {
    const members = entry.kind === 'line' ? [entry.line] : [...entry.lines]
    const first = members[0]!
    const figures = Object.fromEntries(LINE_COLUMNS.map((column) => [column, column === 'ordered' || column === 'shipped' ? members.reduce((sum, line) => sum + line[column], 0) : sumOf(members.map((line) => line[column]))])) as Record<LineColumn, Figure>
    const notInWorkOrders = members.every((line) => line.notInWorkOrders)
    const source = ofOrder.get(first.lineId)
    return {
      id: entry.key,
      lineIds: members.map((line) => line.lineId),
      seq: first.seq,
      style: first.style,
      colourway: first.colourway,
      styleId: source?.styleId ?? null,
      colourwayId: source?.colourwayId ?? null,
      mtm: entry.kind === 'mtm' ? { units: unitsOf(members) } : null,
      figures,
      notInWorkOrders,
      quiet: notInWorkOrders,
      inWorkOrders: members.reduce((sum, line) => sum + line.inWorkOrders, 0),
      madeExtra: members.reduce((sum, line) => sum + line.madeExtra, 0),
    }
  })
}

/** The total row: each column summed over the rows (null when no row counts it). */
export function totalOf(rows: readonly LineRow[]): Record<LineColumn, Figure> {
  return Object.fromEntries(LINE_COLUMNS.map((column) => [column, sumOf(rows.map((row) => row.figures[column]))])) as Record<LineColumn, Figure>
}

// ---- F-OO-121: what a figure cell draws, the line's pills, its picture --------------------------------------------------------

/** A figure cell: the count; "—" alone (a quiet line: nothing counted yet); or "—" with "Not counted here" (a site counts no such step). */
export type FigureFace = { readonly kind: 'count'; readonly value: number } | { readonly kind: 'none' } | { readonly kind: 'notCounted' }

/**
 * A quiet line (no work order yet) draws "—" with no sub for a step at 0 or not counted; Ordered is always its count. The total row is
 * quiet when every line is. Anything counted (a piece shipped from stock) stays its number.
 */
export function figureFaceOf(value: Figure, quiet: boolean, column: LineColumn): FigureFace {
  if (quiet && column !== 'ordered' && (value === null || value === 0)) return { kind: 'none' }
  return value === null ? { kind: 'notCounted' } : { kind: 'count', value }
}

/** One size's pieces made beyond what it now wants (the API's B-OO-015 floor: cut or planned to cut). */
export interface MadeExtraSize {
  readonly size: string | null
  readonly count: number
}

/** A line's pills, in their order: closed short, on hold, not (or partly) in work orders, made extra, late. */
export type LinePill =
  | { readonly kind: 'closedShort'; readonly count: number }
  | { readonly kind: 'onHold' }
  | { readonly kind: 'notInWorkOrders' }
  | { readonly kind: 'inWork'; readonly done: number; readonly total: number }
  | { readonly kind: 'madeExtra'; readonly sizes: readonly MadeExtraSize[] }
  | { readonly kind: 'late'; readonly days: number | null }

/** The line cell shows two pills at most; the line's window shows every one. */
export const LINE_PILLS_SHOWN = 2

export interface LinePillInput {
  readonly order: Pick<Order, 'lines' | 'promiseDate'>
  /** The production read (null: not read yet — no pill it would give is claimed). */
  readonly read: Pick<OrderProduction, 'lines' | 'work' | 'dates'> | null
  /** Today in the site's zone (YYYY-MM-DD): the days a late line is past its promise. */
  readonly today: string
}

/** The sizes of a row made beyond what they want, in the read's size order (a made-to-measure unit: its count alone). */
export function madeExtraSizesOf(row: Pick<LineRow, 'lineIds'>, lines: readonly ProductionLine[]): MadeExtraSize[] {
  return lines.filter((line) => row.lineIds.includes(line.lineId)).flatMap((line) => line.sizes.filter((size) => size.madeExtra > 0).map((size) => ({ size: size.size, count: size.madeExtra })))
}

/** "1 48 · 2 50": the sizes part of the made-extra words ("… more than ordered: cut or planned to cut", the API's own words). */
export const madeExtraSizesText = (sizes: readonly MadeExtraSize[]): string => sizes.map((entry) => (entry.size ? `${entry.count} ${entry.size}` : String(entry.count))).join(' · ')

/**
 * A row's pills, in their order — closed short (the order read's own line), on hold (a held work order makes one of its cells), not
 * in work orders yet or only some of its pieces (not said for a line closed short: its pill says it), made extra (per size), late
 * (the finish forecast says LATE; the days past the line's own promise, else the order's). `cap` = how many the place shows.
 */
export function linePillsOf(row: LineRow, input: LinePillInput, cap: number = LINE_PILLS_SHOWN): LinePill[] {
  const own = input.order.lines.filter((line) => row.lineIds.includes(line.id))
  const pills: LinePill[] = []
  const closed = own.reduce((sum, line) => sum + (line.closedShort?.quantity ?? 0), 0)
  if (closed > 0) pills.push({ kind: 'closedShort', count: closed })
  const held = (input.read?.work?.workOrders ?? []).some((workOrder) => workOrder.held && (workOrder.cells ?? []).some((cell) => row.lineIds.includes(cell.salesOrderLineId)))
  if (held) pills.push({ kind: 'onHold' })
  if (row.notInWorkOrders) pills.push({ kind: 'notInWorkOrders' })
  else if (closed === 0 && row.inWorkOrders < (row.figures.ordered ?? 0)) pills.push({ kind: 'inWork', done: row.inWorkOrders, total: row.figures.ordered ?? 0 })
  const extra = madeExtraSizesOf(row, input.read?.lines ?? [])
  if (extra.length > 0) pills.push({ kind: 'madeExtra', sizes: extra })
  if ((input.read?.dates?.forecast ?? []).some((entry) => row.lineIds.includes(entry.lineId) && entry.risk === 'LATE')) {
    const promise = own.find((line) => line.promiseDate)?.promiseDate ?? input.order.promiseDate
    pills.push({ kind: 'late', days: promise ? Math.max(0, -daysUntil(promise, input.today)) : null })
  }
  return pills.slice(0, cap)
}

/** A pill's tone: what stops or runs late warns; a plain fact is neutral. */
export const pillToneOf = (pill: LinePill): 'neutral' | 'warning' | 'danger' => (pill.kind === 'late' ? 'danger' : pill.kind === 'onHold' || pill.kind === 'madeExtra' ? 'warning' : 'neutral')

/** The style page where a line's missing picture is added (product.styles.manage). */
export const stylePictureHref = (prefix: string, styleId: string): string => `${prefix}/products/styles/${encodeURIComponent(styleId)}`
// ---- end F-OO-121

// ---- the line's sizes (a centred window; J / K walk the lines) -----------------------------------------------------------------

export interface LineSizes {
  /** The PiecesGrid's colourway (the order's own cells per size): Ordered · Cut and bundled · Sewn · Checked · Packed. */
  readonly colourway: PiecesColourway
  /** Per size: shipped, the finish forecast (planning.promise.view; null without it), cut beyond what the size wants. */
  readonly sizes: readonly { readonly size: string; readonly shipped: number; readonly finish: string | null; readonly madeExtra: number }[]
  /** A made-to-measure group: its units, no size grid. */
  readonly units: number | null
}

/** A row's sizes for the window (its first line's; a made-to-measure group lists its units instead). */
export function lineSizesOf(row: LineRow, lines: readonly ProductionLine[], dates: Dates | null | undefined, label: string): LineSizes {
  const members = lines.filter((line) => row.lineIds.includes(line.lineId))
  const forecast = dates?.forecast ?? null
  if (row.mtm) return { colourway: { id: row.id, label, sizes: [] }, sizes: [], units: row.mtm.units }
  const line = members[0]
  const finishOf = (size: string | null) => forecast?.find((entry) => entry.lineId === line?.lineId)?.sizes.find((entry) => entry.size === size)?.finish ?? null
  const sizes = (line?.sizes ?? []).map((size) => ({ size: size.size ?? '—', ordered: size.ordered, cut: size.cut, sewn: size.sewn, inspected: size.checked, packed: size.packed }))
  return {
    colourway: { id: row.id, label, sizes },
    sizes: (line?.sizes ?? []).map((size) => ({ size: size.size ?? '—', shipped: size.shipped, finish: finishOf(size.size), madeExtra: size.madeExtra })),
    units: null,
  }
}

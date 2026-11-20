import type { PiecesColourway, PlainStage } from '../../../../../lib/production/model'
import type { Order } from '../../api'
import { groupMadeToMeasure, unitsOf } from '../../mtm-groups'
import type { Dates, ProductionLine } from './api'

/**
 * F-OO-100 (order overview lane: one file per section) — "Progress by line", its rules moved out of model.ts unchanged (F-SA-232:
 * the order's OWN pieces per line: Ordered · Cut and bundled · Sewn · Checked · Packed · Shipped; "Not counted here" where a site
 * does not count a step, never 0), whose row opens the line's sizes. Every figure is the production read's (B-SA-031).
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
  /** Where the line is: its plain stage from its own counts; null: not in work orders yet. */
  readonly stage: PlainStage | null
  readonly notInWorkOrders: boolean
  /** Office only: pieces cut beyond what the line now wants (a change lowered it after cutting). */
  readonly madeExtra: number
}

const sumOf = (values: readonly Figure[]): Figure => (values.every((value) => value === null) ? null : values.reduce<number>((sum, value) => sum + (value ?? 0), 0))

/** A line's plain stage from its own counts: the first step not done (a step not counted is passed over); nothing cut: Preparing. */
export function lineStageOf(figures: Readonly<Record<LineColumn, Figure>>): PlainStage {
  const ordered = figures.ordered ?? 0
  if (ordered <= 0) return 'PREPARING'
  if ((figures.cut ?? 0) === 0 && figures.cut !== null) return 'PREPARING'
  const steps: readonly [LineColumn, PlainStage][] = [
    ['cut', 'CUTTING'],
    ['sewn', 'SEWING'],
    ['checked', 'QUALITY'],
    ['packed', 'READY'],
  ]
  for (const [column, stage] of steps) {
    const value = figures[column]
    if (value !== null && value < ordered) return stage
  }
  return 'READY'
}

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
      stage: notInWorkOrders ? null : lineStageOf(figures),
      notInWorkOrders,
      madeExtra: members.reduce((sum, line) => sum + line.madeExtra, 0),
    }
  })
}

/** The total row: each column summed over the rows (null when no row counts it). */
export function totalOf(rows: readonly LineRow[]): Record<LineColumn, Figure> {
  return Object.fromEntries(LINE_COLUMNS.map((column) => [column, sumOf(rows.map((row) => row.figures[column]))])) as Record<LineColumn, Figure>
}

/** Nothing of the order is cut yet (counted and zero, or not counted at all): "Nothing cut yet". */
export const nothingCutYet = (rows: readonly LineRow[]): boolean => rows.length > 0 && rows.every((row) => (row.figures.cut ?? 0) === 0)

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

/** J / K: the next or the previous row (it wraps). */
export function walkOf(rows: readonly LineRow[], current: string | null, step: 1 | -1): string | null {
  if (rows.length === 0) return null
  const at = rows.findIndex((row) => row.id === current)
  if (at === -1) return rows[0]!.id
  return rows[(at + step + rows.length) % rows.length]!.id
}

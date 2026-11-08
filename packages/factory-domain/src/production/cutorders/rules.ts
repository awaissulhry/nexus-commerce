import type { Issue } from '../../core/errors'
import { isLengthUom, lengthIn, numberText, type Language, type LengthUom } from '../../inventory/rolls/rolls'
import { Dec, type Decimal } from '../../tax/decimal'

/**
 * Cut orders (B-W2b-112; MES-034 "Cut order plan"; design production.cutting "Cut orders", pop "New cut order", record tab "Lay
 * or hides" › "Lays"), pure. A cut order cuts work orders of ONE material (and colour) together at one table: its lines are work
 * order cells (colourway and size), each with the garments it cuts for the cell.
 *
 *   LEATHER  hides cut one by one (the cut log, W1): a line is the garments of a cell; no marker, no lays; one ticket.
 *   FABRIC   one marker (its name, length, usable width) cut on plies of fabric spread in lays: a line is the marker's garments
 *            of the cell in ONE ply (its size ratio, "48:2"), and every line takes the cut order's plies — every ply of a lay
 *            is cut by the whole marker, so each size of the marker gets the same plies; ratio × plies = the line's garments.
 *            The plies are split into lays (the table's length and the knife's height), each with its own ticket.
 *
 * A cell's garments on live cut orders of the same material (every status but CANCELLED) never exceed the cell: what is left
 * may go on another cut order. The plan changes only while PLANNED; a release freezes it (tickets are printed from it).
 * Nothing here carries money or names a person.
 */

export const CUT_ORDER_KINDS = ['LEATHER', 'FABRIC'] as const
export type CutOrderKind = (typeof CUT_ORDER_KINDS)[number]

export const CUT_ORDER_STATUSES = ['PLANNED', 'RELEASED', 'IN_PROGRESS', 'CUT', 'RECONCILED', 'CANCELLED'] as const
export type CutOrderStatus = (typeof CUT_ORDER_STATUSES)[number]
/** A cut order whose garments count against its cells (every status but CANCELLED). */
export const LIVE_CUT_ORDER_STATUSES = ['PLANNED', 'RELEASED', 'IN_PROGRESS', 'CUT', 'RECONCILED'] as const satisfies readonly CutOrderStatus[]
/** Not yet cut: work may still be planned, started or cancelled. */
export const OPEN_CUT_ORDER_STATUSES = ['PLANNED', 'RELEASED', 'IN_PROGRESS'] as const satisfies readonly CutOrderStatus[]
/** Released to the table: its tickets start, its lays are spread. */
export const AT_TABLE_STATUSES = ['RELEASED', 'IN_PROGRESS'] as const satisfies readonly CutOrderStatus[]

export const LAY_STATUSES = ['PLANNED', 'SPREADING', 'CHECKED', 'CUT', 'CANCELLED'] as const
export type LayStatus = (typeof LAY_STATUSES)[number]
/** A lay still to cut. */
export const OPEN_LAY_STATUSES = ['PLANNED', 'SPREADING', 'CHECKED'] as const satisfies readonly LayStatus[]

export const CUT_TICKET_STATUSES = ['OPEN', 'STARTED', 'DONE', 'VOID'] as const
export type CutTicketStatus = (typeof CUT_TICKET_STATUSES)[number]
export const CUT_TICKET_KINDS = ['CUT', 'RECUT'] as const
export type CutTicketKind = (typeof CUT_TICKET_KINDS)[number]

export const PLY_RUN_STATUSES = ['PLANNED', 'PRINTED', 'VOID'] as const
export type PlyRunStatus = (typeof PLY_RUN_STATUSES)[number]

export const isOneOf = <T extends string>(list: readonly T[], value: string): value is T => (list as readonly string[]).includes(value)

export const CUT_ORDER_LIMITS = Object.freeze({
  /** Cells on one cut order. */
  lines: 60,
  /** Lays of one cut order. */
  lays: 40,
  /** Plies of one cut order, and of one lay. */
  plies: 1000,
  pliesPerLay: 300,
  /** Garments of one cell in one ply of the marker. */
  ratio: 50,
  markerName: 80,
  /** The marker's length, in metres. */
  markerMetres: 50,
  markerWidthCm: 600,
  note: 1000,
  reason: 500,
  /** The extra length per ply at the lay's ends, in centimetres. */
  allowanceCm: 100,
})

export const CUT_ORDER_REFUSALS = [
  'NOT_PLANNED',
  'NOT_AT_TABLE',
  'NOT_OPEN',
  'TICKET_SCANNED',
  'NO_LINE',
  'NO_MARKER',
  'LAYS_PLIES',
  'WORK_ORDER_NOT_OPEN',
  'WORK_ORDER_ON_HOLD',
  'WORK_ORDER_OTHER_SITE',
  'NOT_THE_MATERIAL',
  'NOT_A_CUT_MATERIAL',
  'CELL_FULL',
] as const
export type CutOrderRefusalCode = (typeof CUT_ORDER_REFUSALS)[number]

export interface CutOrderRefusal {
  readonly code: CutOrderRefusalCode
  readonly message: string
}

// ---- the plan -------------------------------------------------------------------------------------------------------------

export interface MarkerDraft {
  readonly name: string
  /** Above 0, in `uom`. */
  readonly length: string
  readonly uom: LengthUom
  readonly widthCm?: string | null | undefined
  readonly fileId?: string | null | undefined
}

export interface LineDraft {
  readonly workOrderSizeId: string
  /** LEATHER: the garments of the cell. FABRIC: none (ratio × the cut order's plies), or the same number. */
  readonly quantity?: number | undefined
  /** FABRIC: the cell's garments in one ply of the marker. LEATHER: none. */
  readonly ratio?: number | undefined
}

export interface PlanDraft {
  readonly kind: CutOrderKind
  readonly marker?: MarkerDraft | null | undefined
  /** FABRIC: the plies every line takes. */
  readonly plies?: number | undefined
  /** FABRIC: the plies of each lay, in order (default: one lay of every ply); they add up to `plies`. */
  readonly lays?: readonly number[] | undefined
  readonly lines: readonly LineDraft[]
}

const whole = (value: unknown, min: number, max: number): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
const DECIMAL = /^\d{1,14}(\.\d{1,4})?$/

/** The marker's problems (paths under `marker/`); a marker of a leather cut order is one problem. */
export function markerProblems(marker: MarkerDraft): Issue[] {
  const problems: Issue[] = []
  const name = marker.name.trim()
  if (name === '' || name.length > CUT_ORDER_LIMITS.markerName) problems.push({ path: 'marker/name', message: `The marker's name, 1 to ${CUT_ORDER_LIMITS.markerName} characters.` })
  if (!isLengthUom(marker.uom)) problems.push({ path: 'marker/uom', message: 'The marker is measured in M, CM or MM.' })
  else if (!DECIMAL.test(marker.length.trim()) || new Dec(marker.length.trim()).lessThanOrEqualTo(0)) problems.push({ path: 'marker/length', message: 'The marker is longer than 0 (at most four decimals).' })
  else if (lengthIn(marker.length.trim(), marker.uom, 'M').greaterThan(CUT_ORDER_LIMITS.markerMetres)) problems.push({ path: 'marker/length', message: `A marker is at most ${CUT_ORDER_LIMITS.markerMetres} m long.` })
  const width = marker.widthCm?.trim()
  if (width && (!DECIMAL.test(width) || new Dec(width).lessThanOrEqualTo(0) || new Dec(width).greaterThan(CUT_ORDER_LIMITS.markerWidthCm))) {
    problems.push({ path: 'marker/widthCm', message: `The marker's usable width in cm, above 0 and at most ${CUT_ORDER_LIMITS.markerWidthCm}.` })
  }
  return problems
}

/** The plan's own problems, before any cell is read (paths relative to the body). */
export function planProblems(plan: PlanDraft): Issue[] {
  const problems: Issue[] = []
  if (plan.lines.length === 0 || plan.lines.length > CUT_ORDER_LIMITS.lines) problems.push({ path: 'lines', message: `From 1 to ${CUT_ORDER_LIMITS.lines} cells.` })
  const seen = new Set<string>()
  plan.lines.forEach((line, index) => {
    if (seen.has(line.workOrderSizeId)) problems.push({ path: `lines/${index}/workOrderSizeId`, message: 'A cell is on a cut order once.' })
    seen.add(line.workOrderSizeId)
  })
  if (plan.kind === 'LEATHER') {
    if (plan.marker) problems.push({ path: 'marker', message: 'A leather cut order is cut hide by hide: it has no marker.' })
    if (plan.plies !== undefined) problems.push({ path: 'plies', message: 'A leather cut order has no plies.' })
    if (plan.lays !== undefined) problems.push({ path: 'lays', message: 'A leather cut order has no lays.' })
    plan.lines.forEach((line, index) => {
      if (!whole(line.quantity, 1, 100_000)) problems.push({ path: `lines/${index}/quantity`, message: 'The garments of the cell, from 1.' })
      if (line.ratio !== undefined) problems.push({ path: `lines/${index}/ratio`, message: 'A leather line has no ratio.' })
    })
    return problems
  }
  if (plan.marker) problems.push(...markerProblems(plan.marker))
  if (!whole(plan.plies, 1, CUT_ORDER_LIMITS.plies)) {
    problems.push({ path: 'plies', message: `The plies of the marker, from 1 to ${CUT_ORDER_LIMITS.plies}.` })
    return problems
  }
  const plies = plan.plies as number
  plan.lines.forEach((line, index) => {
    if (!whole(line.ratio, 1, CUT_ORDER_LIMITS.ratio)) problems.push({ path: `lines/${index}/ratio`, message: `The cell's garments in one ply of the marker, from 1 to ${CUT_ORDER_LIMITS.ratio}.` })
    else if (line.quantity !== undefined && line.quantity !== (line.ratio as number) * plies) {
      problems.push({ path: `lines/${index}/quantity`, message: `Ratio ${line.ratio} × ${plies} plies is ${(line.ratio as number) * plies} garments.` })
    }
  })
  const lays = plan.lays ?? [plies]
  if (lays.length === 0 || lays.length > CUT_ORDER_LIMITS.lays) problems.push({ path: 'lays', message: `From 1 to ${CUT_ORDER_LIMITS.lays} lays.` })
  lays.forEach((value, index) => {
    if (!whole(value, 1, CUT_ORDER_LIMITS.pliesPerLay)) problems.push({ path: `lays/${index}`, message: `The plies of a lay, from 1 to ${CUT_ORDER_LIMITS.pliesPerLay}.` })
  })
  if (lays.every((value) => whole(value, 1, CUT_ORDER_LIMITS.pliesPerLay)) && lays.reduce((sum, value) => sum + value, 0) !== plies) {
    problems.push({ path: 'lays', message: `The lays' plies add up to ${lays.reduce((sum, value) => sum + value, 0)}; the marker takes ${plies}.` })
  }
  return problems
}

/** A fabric line's garments: the cell's garments in one ply × the plies. */
export const fabricGarments = (ratio: number, plies: number): number => ratio * plies

/** `total` plies in `count` lays, as even as can be, the bigger ones first: 61 in 2 → [31, 30]. */
export function splitPlies(total: number, count: number): number[] {
  if (!Number.isSafeInteger(total) || total < 1 || !Number.isSafeInteger(count) || count < 1 || count > total) throw new RangeError(`${total} plies do not split in ${count} lays.`)
  const base = Math.floor(total / count)
  return Array.from({ length: count }, (_, index) => base + (index < total % count ? 1 : 0))
}

/** What a cell still gives a new cut order of the material: its garments less what live cut orders already cut of it. */
export const cellLeft = (cellQuantity: number, onLiveCutOrders: number): number => Math.max(0, cellQuantity - onLiveCutOrders)

/** The marker's size ratio as the table reads it: "46:1 · 48:2 · 50:2" (a size on several lines adds up, in line order). */
export function ratioText(lines: readonly { readonly size: string; readonly ratio: number | null }[]): string {
  const sizes = new Map<string, number>()
  for (const line of lines) if (line.ratio !== null) sizes.set(line.size, (sizes.get(line.size) ?? 0) + line.ratio)
  return [...sizes].map(([size, ratio]) => `${size}:${ratio}`).join(' · ')
}

/** Garments one ply of the marker gives (the ratios added up). */
export const garmentsPerPly = (lines: readonly { readonly ratio: number | null }[]): number => lines.reduce((sum, line) => sum + (line.ratio ?? 0), 0)

/** The length one ply takes off a roll, in the roll's unit: the marker and the allowance at the lay's ends. */
export function perPlyLength(marker: { readonly length: string; readonly uom: LengthUom }, rollUom: LengthUom, allowanceCm = 0): Decimal {
  return lengthIn(marker.length, marker.uom, rollUom).plus(lengthIn(String(allowanceCm), 'CM', rollUom))
}

// ---- refusals in words ------------------------------------------------------------------------------------------------------

export const notPlanned = (number: string, status: CutOrderStatus): CutOrderRefusal => ({
  code: 'NOT_PLANNED',
  message: `Cut order ${number} is ${status.toLowerCase().replace('_', ' ')}: its plan changes only while it is planned${status === 'RELEASED' ? ' (send it back to planning first)' : ''}.`,
})

export function workOrderRefusal(workOrder: { readonly number: string; readonly status: string; readonly holdReason: string | null }): CutOrderRefusal | null {
  if (workOrder.status === 'ON_HOLD') return { code: 'WORK_ORDER_ON_HOLD', message: `Work order ${workOrder.number} is on hold${workOrder.holdReason ? ` (${workOrder.holdReason})` : ''}: nothing is cut for it.` }
  if (workOrder.status !== 'RELEASED' && workOrder.status !== 'IN_PROGRESS') {
    return { code: 'WORK_ORDER_NOT_OPEN', message: `Work order ${workOrder.number} is ${workOrder.status.toLowerCase().replace('_', ' ')}: a cut order takes released or running work orders.` }
  }
  return null
}

export function cellFullRefusal(cell: { readonly workOrderNumber: string; readonly size: string; readonly colourway: string; readonly quantity: number; readonly elsewhere: number }, asked: number): CutOrderRefusal {
  const left = cellLeft(cell.quantity, cell.elsewhere)
  return {
    code: 'CELL_FULL',
    message: `${cell.workOrderNumber} ${cell.colourway} ${cell.size} makes ${cell.quantity}; other cut orders of this material cut ${cell.elsewhere}, so ${left} ${left === 1 ? 'is' : 'are'} left, not ${asked}.`,
  }
}

/** Why a release stops (null: it may go): a line, the marker, the lays' plies. */
export function releaseRefusal(order: {
  readonly number: string
  readonly kind: CutOrderKind
  readonly status: CutOrderStatus
  readonly lines: number
  readonly marker: boolean
  readonly plies: number | null
  readonly layPlies: readonly number[]
}): CutOrderRefusal | null {
  if (order.status !== 'PLANNED') return notPlanned(order.number, order.status)
  if (order.lines === 0) return { code: 'NO_LINE', message: `Cut order ${order.number} has no cell: add the work orders' cells it cuts first.` }
  if (order.kind === 'FABRIC') {
    if (!order.marker) return { code: 'NO_MARKER', message: `Cut order ${order.number} has no marker: a fabric cut order is released with its marker (name and length).` }
    const spread = order.layPlies.reduce((sum, value) => sum + value, 0)
    if (order.layPlies.length === 0 || spread !== order.plies) {
      return { code: 'LAYS_PLIES', message: `Cut order ${order.number}: its lays plan ${spread} plies, its marker takes ${order.plies ?? 0}. Plan the lays again.` }
    }
  }
  return null
}

// ---- words ------------------------------------------------------------------------------------------------------------------------

/** "2 lays · 60 plies · 360 garments" (it "2 materassi · 60 strati · 360 capi"); leather: "12 garments". */
export function planWords(plan: { readonly kind: CutOrderKind; readonly lays: number; readonly plies: number | null; readonly garments: number }, language: Language): string {
  const it = language === 'it'
  const garments = `${numberText(String(plan.garments), language)} ${it ? (plan.garments === 1 ? 'capo' : 'capi') : plan.garments === 1 ? 'garment' : 'garments'}`
  if (plan.kind === 'LEATHER') return garments
  const lays = `${plan.lays} ${it ? (plan.lays === 1 ? 'materasso' : 'materassi') : plan.lays === 1 ? 'lay' : 'lays'}`
  const plies = `${plan.plies ?? 0} ${it ? (plan.plies === 1 ? 'strato' : 'strati') : plan.plies === 1 ? 'ply' : 'plies'}`
  return `${lays} · ${plies} · ${garments}`
}

import { daysFrom, plusDays } from '../../calendars/dates'
import { isBusinessDate, type BusinessDate } from '../../core/time'
import { uniformBuckets, weekStart, type Bucket } from '../settings/buckets'

/**
 * One demand view (B-W2b-319; PLN-017 one demand view across all order types, PLN-040 made-to-measure units, PLN-041 sample and
 * proto demand, PLN-042 remake and rework demand; design planning.demand SCR-201 "Demand at a glance", "Demand over time", "Demand
 * rows"), pure. Every piece somebody waits for at a site, in one place, by layer and by week, so the planner sees that samples and
 * remakes take the same machines as the orders (W1 planning sees order lines only):
 *
 *   ORDERS    the open pieces of confirmed order lines (CONFIRMED, IN_PRODUCTION, READY, PARTLY_SHIPPED): ordered, less what
 *             left on a shipment (SHIPPED, DELIVERED), spread over the line's delivery schedule (SAL-151) — the earliest delivery
 *             ships first; the pieces no delivery names wait on the line's date. A line closed short waits for nothing more.
 *   QUOTES    the lines of quotes likely to win: SENT, still valid (validUntil today or later), the version the customer has.
 *             Never bought for and never in the firm total: a quote is not won yet (there is no win chance before W3).
 *   MTM       made-to-measure units on confirmed orders (PLN-040): one unit each, no size. Empty until made-to-measure starts.
 *   SAMPLES   the cells of sample rounds still to make (REQUESTED, IN_MAKING; PLN-041): a proto, fit, salesman, pre-production,
 *             CE test or brand sample, internal or for a brand, by the round's due day.
 *   REMAKES   what is made again (PLN-042): garments sent back to an operation (rework, from a scan, an inspection or an NCR's
 *             decision), garments (or a part) cut again after scrap (a RECUT), the replacement order of a return (REPLACE,
 *             SIZE_EXCHANGE: its order lines count here, never also as ORDERS) and a return line decided REMAKE.
 *   BRANDS, FORECAST  W3 (Nexus Commerce brand demand, the forecast): their tiles say "not known yet", never 0.
 *
 * Rows are a style in a colourway (a sample cell of "any colourway" has a row of its own), opened to sizes; a made-to-measure unit
 * is a size row of no size. Cells are buckets of a horizon from this week's Monday: weeks (ISO, Monday to Sunday) or months, the
 * first and last clipped to it; demand dated before it is PAST (late), after it LATER (outside the grid, counted in its tile),
 * without a day NONE. Pieces only: no money in this view, and no person.
 */

export const DEMAND_LAYERS = ['ORDERS', 'QUOTES', 'MTM', 'SAMPLES', 'REMAKES'] as const
export type DemandLayer = (typeof DEMAND_LAYERS)[number]
/** The design's two W3 tiles: shown, never as 0 (`pieces: null`). */
export const LATER_LAYERS = ['BRANDS', 'FORECAST'] as const
export type LaterLayer = (typeof LATER_LAYERS)[number]
/** The layers that take the machines: the firm total. QUOTES is shown apart (not won yet). */
export const FIRM_LAYERS = ['ORDERS', 'MTM', 'SAMPLES', 'REMAKES'] as const satisfies readonly DemandLayer[]

export const DEMAND_KINDS = ['ORDER_LINE', 'QUOTE_LINE', 'MTM_UNIT', 'SAMPLE_ROUND', 'REWORK', 'RECUT', 'RETURN_REPLACEMENT', 'RETURN_REMAKE'] as const
export type DemandKind = (typeof DEMAND_KINDS)[number]

export const LAYER_OF_KIND: Readonly<Record<DemandKind, DemandLayer>> = Object.freeze({
  ORDER_LINE: 'ORDERS',
  QUOTE_LINE: 'QUOTES',
  MTM_UNIT: 'MTM',
  SAMPLE_ROUND: 'SAMPLES',
  REWORK: 'REMAKES',
  RECUT: 'REMAKES',
  RETURN_REPLACEMENT: 'REMAKES',
  RETURN_REMAKE: 'REMAKES',
})
export const layerOf = (kind: DemandKind): DemandLayer => LAYER_OF_KIND[kind]

type Words = { readonly en: string; readonly it: string }
export const LAYER_WORDS: Readonly<Record<DemandLayer | LaterLayer, Words>> = Object.freeze({
  ORDERS: { en: 'Confirmed orders', it: 'Ordini confermati' },
  QUOTES: { en: 'Quotes likely to win', it: 'Offerte probabili' },
  MTM: { en: 'Made-to-measure units', it: 'Capi su misura' },
  SAMPLES: { en: 'Samples and protos', it: 'Campioni e prototipi' },
  REMAKES: { en: 'Remakes', it: 'Rifacimenti' },
  BRANDS: { en: 'Brand demand', it: 'Domanda dei marchi' },
  FORECAST: { en: 'Forecast', it: 'Previsione' },
})
/** One source, and several ("3 orders, 1 remake"). */
export const KIND_WORDS: Readonly<Record<DemandKind, { readonly en: readonly [string, string]; readonly it: readonly [string, string] }>> = Object.freeze({
  ORDER_LINE: { en: ['order', 'orders'], it: ['ordine', 'ordini'] },
  QUOTE_LINE: { en: ['quote', 'quotes'], it: ['offerta', 'offerte'] },
  MTM_UNIT: { en: ['made-to-measure unit', 'made-to-measure units'], it: ['capo su misura', 'capi su misura'] },
  SAMPLE_ROUND: { en: ['sample round', 'sample rounds'], it: ['giro campioni', 'giri campioni'] },
  REWORK: { en: ['rework', 'reworks'], it: ['rilavorazione', 'rilavorazioni'] },
  RECUT: { en: ['recut', 'recuts'], it: ['ritaglio', 'ritagli'] },
  RETURN_REPLACEMENT: { en: ['replacement for a return', 'replacements for returns'], it: ['sostituzione di un reso', 'sostituzioni di resi'] },
  RETURN_REMAKE: { en: ['remake for a return', 'remakes for returns'], it: ['rifacimento di un reso', 'rifacimenti di resi'] },
})

export const DEMAND_BUCKETS = ['WEEK', 'MONTH'] as const
export type DemandBucketKind = (typeof DEMAND_BUCKETS)[number]
/** Bucket keys besides the horizon's own (`2026-W47`, `2026-11`). */
export const PAST = 'PAST'
export const LATER = 'LATER'
export const UNDATED = 'NONE'
export const SPECIAL_BUCKETS = [PAST, UNDATED, LATER] as const

export const DEMAND_LIMITS = Object.freeze({
  weeks: { min: 1, max: 104 },
  /** Style-colour rows in one answer (the busiest first are not chosen: by code; `truncated` says more exist). */
  rows: 400,
  /** Demand rows in one page of the list. */
  page: { default: 100, max: 500 },
  /** Ids in one filter. */
  ids: 200,
})

// ---- the horizon ------------------------------------------------------------------------------------------------------------

export interface DemandHorizon {
  readonly kind: DemandBucketKind
  /** This week's Monday, and the Sunday that ends week `weeks`. */
  readonly from: BusinessDate
  readonly to: BusinessDate
  readonly weeks: number
  readonly buckets: readonly Bucket[]
}

/** The view's buckets: `weeks` ISO weeks from the Monday of `today`'s week, as weeks or as months (the first and last clipped). */
export function demandHorizon(today: BusinessDate, weeks: number, kind: DemandBucketKind = 'WEEK'): DemandHorizon {
  if (!isBusinessDate(today)) throw new RangeError(`not a calendar day: ${String(today)}`)
  if (!Number.isSafeInteger(weeks) || weeks < DEMAND_LIMITS.weeks.min || weeks > DEMAND_LIMITS.weeks.max) throw new RangeError(`the horizon is ${DEMAND_LIMITS.weeks.min} to ${DEMAND_LIMITS.weeks.max} weeks`)
  const from = weekStart(today)
  const to = plusDays(from, weeks * 7 - 1)
  return { kind, from, to, weeks, buckets: uniformBuckets(from, to, kind) }
}

/** The bucket a day falls in: a horizon key, PAST (before it), LATER (after it) or NONE (no day). */
export function bucketKeyOf(horizon: Pick<DemandHorizon, 'from' | 'to' | 'buckets'>, date: BusinessDate | null): string {
  if (date === null) return UNDATED
  if (date < horizon.from) return PAST
  if (date > horizon.to) return LATER
  for (const bucket of horizon.buckets) if (date >= bucket.from && date <= bucket.to) return bucket.key
  return LATER
}

/** Days late on `today` (0 when not late, null without a day). */
export const daysLate = (date: BusinessDate | null, today: BusinessDate): number | null => (date === null ? null : Math.max(0, daysFrom(date, today)))

// ---- what an order line still waits for ----------------------------------------------------------------------------------

export interface OrderLineFacts {
  /** The line's own day (its promise, else its request, else the order's): where pieces no delivery names wait. */
  readonly dueDate: BusinessDate | null
  /** Per size: ordered and shipped. A made-to-measure unit is one entry of size null. */
  readonly sizes: readonly { readonly size: string | null; readonly ordered: number; readonly shipped: number }[]
  /** The line's delivery schedule (SAL-151): per day, the pieces per size (null: a made-to-measure unit's `quantity`). */
  readonly deliveries: readonly { readonly date: BusinessDate; readonly sizeQuantities: Readonly<Record<string, number>> | null; readonly quantity: number }[]
}

export interface OpenPart {
  readonly size: string | null
  readonly date: BusinessDate | null
  readonly pieces: number
}

const byDay = (a: BusinessDate | null, b: BusinessDate | null): number => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1)

/**
 * The pieces a line still waits for, per size and day: each size's deliveries in date order (never more than ordered), the rest on
 * the line's day; what shipped is taken from the earliest first. Parts of 0 are left out.
 */
export function openParts(line: OrderLineFacts): OpenPart[] {
  const out: OpenPart[] = []
  const deliveries = [...line.deliveries].sort((a, b) => byDay(a.date, b.date))
  for (const entry of line.sizes) {
    const ordered = Math.max(0, Math.trunc(entry.ordered))
    let scheduledLeft = ordered
    const slots: { date: BusinessDate | null; pieces: number }[] = []
    for (const delivery of deliveries) {
      const asked = entry.size === null ? (delivery.sizeQuantities === null ? delivery.quantity : 0) : Math.max(0, Math.trunc(delivery.sizeQuantities?.[entry.size] ?? 0))
      const pieces = Math.min(asked, scheduledLeft)
      if (pieces <= 0) continue
      slots.push({ date: delivery.date, pieces })
      scheduledLeft -= pieces
    }
    if (scheduledLeft > 0) slots.push({ date: line.dueDate, pieces: scheduledLeft })
    slots.sort((a, b) => byDay(a.date, b.date))
    let shippedLeft = Math.max(0, Math.trunc(entry.shipped))
    for (const slot of slots) {
      const taken = Math.min(slot.pieces, shippedLeft)
      shippedLeft -= taken
      const pieces = slot.pieces - taken
      if (pieces > 0) out.push({ size: entry.size, date: slot.date, pieces })
    }
  }
  return out
}

/** A round's (or any) cells per colourway and size, a cell named twice added up; 0 and below are left out. */
export function mergedCells(cells: readonly { readonly colourwayId: string | null; readonly size: string; readonly quantity: number }[]): { colourwayId: string | null; size: string; pieces: number }[] {
  const merged = new Map<string, { colourwayId: string | null; size: string; pieces: number }>()
  for (const cell of cells) {
    if (!(cell.quantity > 0)) continue
    const key = `${cell.colourwayId ?? '-'}|${cell.size}`
    const entry = merged.get(key) ?? { colourwayId: cell.colourwayId, size: cell.size, pieces: 0 }
    merged.set(key, { ...entry, pieces: entry.pieces + Math.trunc(cell.quantity) })
  }
  return [...merged.values()]
}

// ---- the grid -------------------------------------------------------------------------------------------------------------

/** One piece of demand: a source's pieces of one style, colourway and size, on one day. */
export interface DemandPiece {
  readonly kind: DemandKind
  /** The source record (an order line, a quote line, a round, a rework, a recut, a return line): counts sources. */
  readonly sourceId: string
  readonly styleId: string
  /** null: a sample cell of any colourway. */
  readonly colourwayId: string | null
  /** null: a made-to-measure unit. */
  readonly size: string | null
  readonly date: BusinessDate | null
  readonly pieces: number
  /**
   * Today's material plan (MRP, B-W1-29 / B-W2a-22) buys for it: an order line of a CONFIRMED or IN_PRODUCTION order placed at the
   * site (a made-to-measure unit as one base-size unit, PLN-063). Everything else takes machines but no material is planned for it.
   */
  readonly planned: boolean
}

export type LayerCounts = { [Layer in DemandLayer]: number }
export interface DemandCell extends LayerCounts {
  readonly bucket: string
  /** The layers that take the machines (all but QUOTES). */
  readonly firm: number
}
export interface DemandTotals extends LayerCounts {
  readonly firm: number
}
export interface DemandSizeRow {
  readonly size: string | null
  readonly totals: DemandTotals
  readonly cells: readonly DemandCell[]
}
export interface DemandGridRow {
  /** `<styleId>:<colourwayId or ->`. */
  readonly key: string
  readonly styleId: string
  readonly colourwayId: string | null
  readonly totals: DemandTotals
  readonly cells: readonly DemandCell[]
  readonly sizes: readonly DemandSizeRow[]
}
export interface DemandTile {
  readonly layer: DemandLayer
  /** Pieces shown: past due, in the horizon and without a day (never those after it). */
  readonly pieces: number
  /** The sources behind them (order lines, quote lines, rounds, reworks …). */
  readonly sources: number
  readonly pastDue: number
  readonly undated: number
  /** Pieces dated after the horizon: not in the grid. */
  readonly later: number
  /** Of `pieces`, those the material plan does not buy for (see DemandPiece.planned). */
  readonly unplanned: number
}

const zero = (): Record<DemandLayer, number> => ({ ORDERS: 0, QUOTES: 0, MTM: 0, SAMPLES: 0, REMAKES: 0 })
const firmOf = (counts: LayerCounts): number => FIRM_LAYERS.reduce((sum, layer) => sum + counts[layer], 0)
export const rowKeyOf = (styleId: string, colourwayId: string | null): string => `${styleId}:${colourwayId ?? '-'}`

/** The order of the cells: PAST, the horizon's buckets, NONE. */
export function bucketOrder(horizon: Pick<DemandHorizon, 'buckets'>): string[] {
  return [PAST, ...horizon.buckets.map((bucket) => bucket.key), UNDATED]
}

class Tally {
  readonly totals = zero()
  readonly cells = new Map<string, Record<DemandLayer, number>>()
  add(bucket: string, layer: DemandLayer, pieces: number): void {
    this.totals[layer] += pieces
    const cell = this.cells.get(bucket) ?? zero()
    cell[layer] += pieces
    this.cells.set(bucket, cell)
  }
  cellsIn(order: readonly string[]): DemandCell[] {
    return order.flatMap((bucket) => {
      const cell = this.cells.get(bucket)
      return cell ? [{ bucket, ...cell, firm: firmOf(cell) }] : []
    })
  }
  totalsOf(): DemandTotals {
    return { ...this.totals, firm: firmOf(this.totals) }
  }
}

/**
 * The tiles and the time-phased rows of the pieces (sparse cells: a bucket with no piece is left out). Sizes follow
 * `sizeOrder(styleId)` (the style's range), other sizes after them by code, the made-to-measure row last. Rows come in
 * (styleId, colourwayId) order; the reader sorts them by code.
 */
export function demandGrid(pieces: readonly DemandPiece[], horizon: Pick<DemandHorizon, 'from' | 'to' | 'buckets'>, sizeOrder: (styleId: string) => readonly string[] = () => []): { tiles: DemandTile[]; rows: DemandGridRow[] } {
  const order = bucketOrder(horizon)
  const tiles = new Map<DemandLayer, { pieces: number; sources: Set<string>; pastDue: number; undated: number; later: number; unplanned: number }>(DEMAND_LAYERS.map((layer) => [layer, { pieces: 0, sources: new Set(), pastDue: 0, undated: 0, later: 0, unplanned: 0 }]))
  const rows = new Map<string, { styleId: string; colourwayId: string | null; tally: Tally; sizes: Map<string, { size: string | null; tally: Tally }> }>()
  for (const piece of pieces) {
    if (!(piece.pieces > 0)) continue
    const layer = layerOf(piece.kind)
    const bucket = bucketKeyOf(horizon, piece.date)
    const tile = tiles.get(layer)!
    if (bucket === LATER) {
      tile.later += piece.pieces
      continue
    }
    tile.pieces += piece.pieces
    tile.sources.add(`${piece.kind}:${piece.sourceId}`)
    if (bucket === PAST) tile.pastDue += piece.pieces
    if (bucket === UNDATED) tile.undated += piece.pieces
    if (!piece.planned) tile.unplanned += piece.pieces
    const key = rowKeyOf(piece.styleId, piece.colourwayId)
    const row = rows.get(key) ?? { styleId: piece.styleId, colourwayId: piece.colourwayId, tally: new Tally(), sizes: new Map() }
    rows.set(key, row)
    row.tally.add(bucket, layer, piece.pieces)
    const sizeKey = piece.size ?? '\u0000mtm'
    const size = row.sizes.get(sizeKey) ?? { size: piece.size, tally: new Tally() }
    row.sizes.set(sizeKey, size)
    size.tally.add(bucket, layer, piece.pieces)
  }
  const sizeRank = (styleId: string) => {
    const range = sizeOrder(styleId)
    const rank = new Map(range.map((size, index) => [size, index]))
    return (a: string | null, b: string | null): number => {
      if (a === b) return 0
      if (a === null) return 1
      if (b === null) return -1
      const ra = rank.get(a)
      const rb = rank.get(b)
      if (ra !== undefined && rb !== undefined) return ra - rb
      if (ra !== undefined) return -1
      if (rb !== undefined) return 1
      return a < b ? -1 : 1
    }
  }
  const gridRows = [...rows.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, row]) => {
      const compare = sizeRank(row.styleId)
      return {
        key,
        styleId: row.styleId,
        colourwayId: row.colourwayId,
        totals: row.tally.totalsOf(),
        cells: row.tally.cellsIn(order),
        sizes: [...row.sizes.values()].sort((a, b) => compare(a.size, b.size)).map((size) => ({ size: size.size, totals: size.tally.totalsOf(), cells: size.tally.cellsIn(order) })),
      }
    })
  return {
    tiles: DEMAND_LAYERS.map((layer) => {
      const tile = tiles.get(layer)!
      return { layer, pieces: tile.pieces, sources: tile.sources.size, pastDue: tile.pastDue, undated: tile.undated, later: tile.later, unplanned: tile.unplanned }
    }),
    rows: gridRows,
  }
}

// ---- what makes a number ----------------------------------------------------------------------------------------------------

export interface KindCount {
  readonly kind: DemandKind
  readonly sources: number
  readonly pieces: number
}

/** Per kind, in DEMAND_KINDS order: how many sources and pieces ("3 orders, 1 remake"). */
export function kindCounts(rows: readonly Pick<DemandPiece, 'kind' | 'sourceId' | 'pieces'>[]): KindCount[] {
  const by = new Map<DemandKind, { sources: Set<string>; pieces: number }>()
  for (const row of rows) {
    const entry = by.get(row.kind) ?? { sources: new Set<string>(), pieces: 0 }
    entry.sources.add(row.sourceId)
    entry.pieces += row.pieces
    by.set(row.kind, entry)
  }
  return DEMAND_KINDS.flatMap((kind) => {
    const entry = by.get(kind)
    return entry ? [{ kind, sources: entry.sources.size, pieces: entry.pieces }] : []
  })
}

/** "3 orders, 1 remake for a return" / "3 ordini, 1 rifacimento di un reso"; empty: "nothing" / "niente". */
export function kindCountWords(counts: readonly KindCount[], language: 'en' | 'it' = 'en'): string {
  if (counts.length === 0) return language === 'it' ? 'niente' : 'nothing'
  return counts.map((count) => `${count.sources} ${KIND_WORDS[count.kind][language][count.sources === 1 ? 0 : 1]}`).join(', ')
}

import type { Order } from '../../api'
import { styleGroups, type StyleGroup } from '../../model'
import { MTM_KIND } from '../../mtm-groups'
import type { Deliveries } from './delivered/api'
import { word, wordOf, type ShipWord } from './word'

/**
 * F-OS-102 (order SHIPMENTS tab, 10-design §4; research H1; 13-backend B-OS-002) — section 1 "Where every garment is" (#left), pure:
 * every garment of the order in ONE bucket, and the buckets add up to what was ordered —
 *
 *   Shipped (left: SHIPPED, DELIVERED) · On a packed shipment · On a draft shipment · Came back, not yet received · Ready now ·
 *   Still to be made or released · Closed short  =  Ordered
 *
 * Counted, never typed: the numbers are the order read's (`shipped`, `closedShort`, `toShip`, and — B-OS-002 — `planned` and
 * `readyNow`, the SAME rule Warehouse's backorder reads), so Overview, Lines, Production and this tab agree. Packed and draft are
 * told apart by each shipment's contents (B-OS-001); came back by the deliveries read (B-OS-003: not received yet). Until the
 * server sends `planned` and `readyNow` the section draws today's figure line (never a made-up 0). Made-to-measure is counted in
 * units (H1-B1); fee lines are never drawn (they never ship, H1-B2). "Still to ship" = ready now + still to be made or released +
 * came back: garments on a draft or packed shipment are no longer "to ship" (H2-B2).
 */

export type ShipmentRow = Order['chain']['shipments'][number]
type Line = Order['lines'][number]
type SizeProgress = Line['progress']

/**
 * The buckets in the bar's order. `planned`: on a shipment not left, told apart into packed / draft only when every contents is read.
 * owb-ss3 (design plan § 5n "Where every garment is", the word "At our warehouse"): `atWarehouse` — left the factory on a shipment that
 * went to our own warehouse first, arrived there and is not sent on yet (the legs read, `GET /shipping/warehouse-legs`); counted out of
 * Shipped (the order read counts it shipped), so the buckets still add up to what was ordered. 0 while the legs are not read.
 */
export const BUCKETS = ['shipped', 'atWarehouse', 'packed', 'draft', 'planned', 'back', 'ready', 'making', 'closed'] as const
export type Bucket = (typeof BUCKETS)[number]
export type Buckets = Readonly<Record<Bucket, number>>

const NONE: Buckets = Object.freeze({ shipped: 0, atWarehouse: 0, packed: 0, draft: 0, planned: 0, back: 0, ready: 0, making: 0, closed: 0 })

/** owb-ss3: the shipments whose garments sit at our warehouse now (arrived, not sent on: legs/model.ts atWarehouseIds); null: not read. */
export type AtWarehouse = ReadonlySet<string>

/** Per shipment that came back with the carrier: whether its garments were received back into stock (the deliveries read). */
export type Received = ReadonlyMap<string, boolean>

/** The deliveries read's "came back" per shipment (B-OS-003); null: not read (nothing is said about came back then). */
export const receivedOf = (deliveries: Pick<Deliveries, 'shipments'> | null): Received | null =>
  deliveries ? new Map(deliveries.shipments.flatMap((row): [string, boolean][] => (row.returned ? [[row.id, row.returned.received]] : []))) : null

/** One size of a goods line (a made-to-measure line, or a line without sizes, is one cell). */
export interface CellCount {
  readonly lineId: string
  readonly size: string | null
  readonly ordered: number
  /** Ready now + still to be made or released + came back (today: what the order read calls left to ship). */
  readonly stillToShip: number
  readonly buckets: Buckets
}

/** A shipment as a door of the section ("SEED-SH-0011 · 40 ›"): its pieces of THIS order when its contents are read. */
export interface ShipRef {
  readonly id: string
  readonly number: string
  readonly status: string
  readonly pieces: number | null
}

/** A colour's sizes ("Black 52 ×4, 54 ×2"), or its units for made to measure. */
export interface ColourCells {
  readonly colour: string
  readonly sizes: readonly { readonly size: string; readonly pieces: number }[]
  /** Made to measure: the units (no sizes). */
  readonly units: number | null
}

export type Fact =
  | { readonly kind: 'ready'; readonly cells: readonly ColourCells[] }
  | { readonly kind: 'shipment'; readonly ref: ShipRef; readonly colours: readonly { readonly colour: string; readonly pieces: number }[]; readonly received: boolean | null }
  | { readonly kind: 'making'; readonly pieces: number }
  | { readonly kind: 'closed'; readonly cells: readonly ColourCells[]; readonly reason: string | null; readonly at: string | null }
  | { readonly kind: 'figures'; readonly ordered: number; readonly released: number; readonly shipped: number; readonly toShip: number }
  | { readonly kind: 'nothingOn' }

/** The size grid of what is still to ship (the DS SizeGridView's shape: one row per colour line, the style's sizes in order). */
export interface StillGrid {
  readonly sizes: { key: string; label: string }[]
  readonly colours: { key: string; label: string; offered: string[] }[]
  readonly value: Record<string, Record<string, number>>
}

export interface StyleCard {
  readonly styleId: string
  readonly code: string
  readonly name: string
  readonly lineIds: readonly string[]
  readonly seqs: readonly number[]
  readonly mtm: boolean
  readonly ordered: number
  readonly stillToShip: number
  readonly closed: number
  /** The earliest promise of its lines still to ship (else the order's); null: nothing left, or no promise. */
  readonly promise: string | null
  /** Null: made to measure (units, no grid), or nothing of it is left to ship. */
  readonly grid: StillGrid | null
  readonly facts: readonly Fact[]
}

export interface WhereModel {
  /** `counted`: the server sends `planned` + `readyNow` (B-OS-002); `today`: only today's figures (ordered · released · shipped · left). */
  readonly mode: 'counted' | 'today'
  /** The order's state says it in one line instead (waits for a yes, cancelled, fees only). */
  readonly state: 'goods' | 'pending' | 'cancelled' | 'feesOnly'
  /** Packed and draft told apart (every shipment's contents are read). */
  readonly split: boolean
  readonly ordered: number
  readonly stillToShip: number
  readonly totals: Buckets
  /** Every garment shipped or closed short, and something shipped: the section folds to one line. */
  readonly allOut: boolean
  /** The shipments that left (for "Everything shipped: … on N shipments"). */
  readonly left: number
  /** The doors under each bucket of the legend. owb-ss3: `atWarehouse` — the shipments at our warehouse now. */
  readonly doors: Readonly<Record<'shipped' | 'atWarehouse' | 'packed' | 'draft' | 'planned' | 'back', readonly ShipRef[]>>
  readonly cards: readonly StyleCard[]
}

const LEFT = new Set(['SHIPPED', 'DELIVERED'])
const NOT_LEFT = new Set(['DRAFT', 'PACKED'])
const max0 = (value: number): number => (value > 0 ? value : 0)
const sumOf = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0)

/** The goods of the order (a fee line never ships). */
export const goodsOf = (order: Pick<Order, 'lines'>): Line[] => order.lines.filter((line) => line.kind !== 'FEE')

/** The server counts what is planned and ready now (B-OS-002); else the tab says today's figures only. */
export const countedOf = (order: Pick<Order, 'progress'>): boolean => order.progress.planned !== undefined && order.progress.readyNow !== undefined

/** Every shipment that is not cancelled names what it carries of this order (B-OS-001). */
export const contentsRead = (rows: readonly ShipmentRow[]): boolean => rows.every((row) => row.status === 'CANCELLED' || row.contents !== undefined)

/** A line counted as one cell: made to measure, no size rows, or one size row without a size. */
const oneCell = (line: Line): boolean => line.kind === MTM_KIND || line.sizes.length === 0 || (line.sizes.length === 1 && line.sizes[0]!.size === null)

/** The pieces of one cell on the shipments `pick` chooses (this order's contents only). */
function piecesOn(rows: readonly ShipmentRow[], line: Line, size: string | null, pick: (row: ShipmentRow) => boolean): number {
  const whole = oneCell(line)
  let total = 0
  for (const row of rows) {
    if (row.status === 'CANCELLED' || !pick(row)) continue
    for (const entry of row.contents ?? []) if (entry.lineId === line.id && (whole || entry.size === size)) total += entry.pieces
  }
  return total
}

/** The pieces of this order a shipment carries (null: its contents are not read yet). */
export const piecesOf = (row: ShipmentRow): number | null => (row.contents ? sumOf(row.contents.map((entry) => entry.pieces)) : null)

/** The cells of a line with their progress (one cell for made to measure or a line without sizes). */
function cellsOfLine(line: Line): { size: string | null; progress: SizeProgress }[] {
  return oneCell(line) ? [{ size: null, progress: line.progress }] : line.sizes.map((entry) => ({ size: entry.size, progress: entry.progress }))
}

/** Every goods cell in its bucket (the buckets of a cell add up to its ordered pieces). */
export function cellsOf(order: Pick<Order, 'lines' | 'progress'>, rows: readonly ShipmentRow[], received: Received | null, atWarehouse: AtWarehouse | null = null): CellCount[] {
  const counted = countedOf(order)
  const split = contentsRead(rows)
  return goodsOf(order).flatMap((line) =>
    cellsOfLine(line).map(({ size, progress }): CellCount => {
      // owb-ss3: the garments of this cell at our warehouse now, out of what left (never more than left; 0 without the legs read).
      const atWh = atWarehouse && atWarehouse.size > 0 ? Math.min(piecesOn(rows, line, size, (row) => row.status === 'SHIPPED' && atWarehouse.has(row.id)), progress.shipped) : 0
      const shipped = progress.shipped - atWh
      const closed = progress.closedShort ?? 0
      const toShip = progress.toShip
      if (!counted) return { lineId: line.id, size, ordered: progress.ordered, stillToShip: toShip, buckets: { ...NONE, shipped, atWarehouse: atWh, closed } }
      // A line closed short sends nothing more: whatever is not shipped is closed (the domain's rule), so nothing of it is planned.
      const planned = Math.min(max0(progress.planned ?? 0), toShip)
      const ready = Math.min(max0(progress.readyNow ?? 0), toShip - planned)
      let rest = planned
      let packed = 0
      let draft = 0
      if (split) {
        packed = Math.min(piecesOn(rows, line, size, (row) => row.status === 'PACKED'), rest)
        rest -= packed
        draft = Math.min(piecesOn(rows, line, size, (row) => row.status === 'DRAFT'), rest)
        rest -= draft
      }
      // Came back, not yet received: only where the deliveries read says so (unknown: they stay "still to be made or released").
      const back = received ? Math.min(piecesOn(rows, line, size, (row) => row.status === 'RETURNED' && received.get(row.id) === false), toShip - planned - ready) : 0
      const making = toShip - planned - ready - back
      return { lineId: line.id, size, ordered: progress.ordered, stillToShip: toShip - planned, buckets: { shipped, atWarehouse: atWh, packed, draft, planned: rest, back, ready, making, closed } }
    }),
  )
}

const add = (cells: readonly CellCount[]): Buckets => {
  const out: Record<Bucket, number> = { ...NONE }
  for (const cell of cells) for (const bucket of BUCKETS) out[bucket] += cell.buckets[bucket]
  return out
}

const colourOf = (line: Line): string => line.colourway?.name ?? line.colourway?.code ?? '—'

/** A bucket of a style's cells by colour line: "Black 52 ×4, 54 ×2" (made to measure: its units). */
function colourCells(lines: readonly Line[], cells: readonly CellCount[], bucket: Bucket): ColourCells[] {
  return lines.flatMap((line): ColourCells[] => { // os-fx1: one return type (end check 45005254988, TS2345)
    const own = cells.filter((cell) => cell.lineId === line.id && cell.buckets[bucket] > 0)
    if (own.length === 0) return []
    if (oneCell(line)) return [{ colour: colourOf(line), sizes: [], units: sumOf(own.map((cell) => cell.buckets[bucket])) }]
    return [{ colour: colourOf(line), sizes: own.map((cell) => ({ size: cell.size ?? '—', pieces: cell.buckets[bucket] })), units: null }]
  })
}

/** What each shipment that is not cancelled carries of a style, by colour ("On SEED-SH-0012 (packed): Black 8 · Red 16"). */
function shipmentFacts(lines: readonly Line[], rows: readonly ShipmentRow[], received: Received | null): Fact[] {
  return rows.flatMap((row): Fact[] => {
    if (row.status === 'CANCELLED' || !row.contents) return []
    const colours = lines.flatMap((line) => {
      const pieces = sumOf(row.contents!.filter((entry) => entry.lineId === line.id).map((entry) => entry.pieces))
      return pieces > 0 ? [{ colour: colourOf(line), pieces }] : []
    })
    if (colours.length === 0) return []
    const ref: ShipRef = { id: row.id, number: row.number, status: row.status, pieces: sumOf(colours.map((entry) => entry.pieces)) }
    return [{ kind: 'shipment', ref, colours, received: row.status === 'RETURNED' ? (received?.get(row.id) ?? null) : null }]
  })
}

/** The style's grid of what is still to ship (made to measure has none). */
function stillGridOf(group: StyleGroup, cells: readonly CellCount[]): StillGrid {
  const sizes: string[] = []
  for (const line of group.lines) for (const entry of line.sizes) if (entry.size !== null && !sizes.includes(entry.size)) sizes.push(entry.size)
  const value: Record<string, Record<string, number>> = {}
  for (const line of group.lines) value[line.id] = Object.fromEntries(cells.filter((cell) => cell.lineId === line.id && cell.size !== null).map((cell) => [cell.size!, cell.stillToShip]))
  return {
    sizes: sizes.map((size) => ({ key: size, label: size })),
    // A colour's sizes the order does not hold are "not offered" (never a 0 that looks like an answer).
    colours: group.lines.map((line) => ({ key: line.id, label: line.colourway ? `${line.colourway.code} · ${line.colourway.name}` : '—', offered: line.sizes.flatMap((entry) => (entry.size === null ? [] : [entry.size])) })),
    value,
  }
}

function cardOf(group: StyleGroup, order: Pick<Order, 'promiseDate'>, cells: readonly CellCount[], rows: readonly ShipmentRow[], received: Received | null, counted: boolean): StyleCard {
  const own = cells.filter((cell) => group.lines.some((line) => line.id === cell.lineId))
  const mtm = group.lines.every((line) => line.kind === MTM_KIND)
  const stillToShip = sumOf(own.map((cell) => cell.stillToShip))
  const totals = add(own)
  const open = group.lines.filter((line) => own.some((cell) => cell.lineId === line.id && cell.stillToShip > 0))
  const promises = open.map((line) => line.promiseDate).filter((day): day is string => !!day).sort()
  const facts: Fact[] = []
  if (counted) {
    const ready = colourCells(group.lines, own, 'ready')
    if (ready.length > 0) facts.push({ kind: 'ready', cells: ready })
    facts.push(...shipmentFacts(group.lines, rows, received))
    if (totals.making > 0) facts.push({ kind: 'making', pieces: totals.making })
  } else {
    const progress = group.lines.map((line) => line.progress)
    facts.push({ kind: 'figures', ordered: sumOf(progress.map((p) => p.ordered)), released: sumOf(progress.map((p) => p.released)), shipped: sumOf(progress.map((p) => p.shipped)), toShip: sumOf(progress.map((p) => p.toShip)) })
  }
  if (totals.closed > 0) {
    const short = group.lines.find((line) => line.closedShort)?.closedShort ?? null
    facts.push({ kind: 'closed', cells: colourCells(group.lines, own, 'closed'), reason: short?.reason ?? null, at: short?.at ?? null })
  }
  if (facts.length === 0) facts.push({ kind: 'nothingOn' })
  return {
    styleId: group.styleId,
    code: group.code,
    name: group.name,
    lineIds: group.lines.map((line) => line.id),
    seqs: group.lines.map((line) => line.seq),
    mtm,
    ordered: sumOf(own.map((cell) => cell.ordered)),
    stillToShip,
    closed: totals.closed,
    promise: stillToShip > 0 ? (promises[0] ?? order.promiseDate ?? null) : null,
    grid: mtm || stillToShip === 0 ? null : stillGridOf(group, own),
    facts,
  }
}

/**
 * The section's model from the order read, its shipments and (when read) which returned shipments were received back. owb-ss3: and
 * (when the legs are read) which shipments sit at our warehouse now.
 */
export function whereOf(order: Pick<Order, 'status' | 'lines' | 'progress' | 'promiseDate' | 'chain'>, received: Received | null, atWarehouse: AtWarehouse | null = null): WhereModel {
  const rows = order.chain.shipments
  const counted = countedOf(order)
  const split = counted && contentsRead(rows)
  const goods = goodsOf(order)
  const cells = cellsOf(order, rows, received, atWarehouse)
  const totals = add(cells)
  const ordered = sumOf(cells.map((cell) => cell.ordered))
  const stillToShip = sumOf(cells.map((cell) => cell.stillToShip))
  const live = rows.filter((row) => row.status !== 'CANCELLED')
  const refOf = (row: ShipmentRow): ShipRef => ({ id: row.id, number: row.number, status: row.status, pieces: piecesOf(row) })
  const onShipments = totals.packed + totals.draft + totals.planned
  const state: WhereModel['state'] = order.status === 'PENDING_APPROVAL' ? 'pending' : order.status === 'CANCELLED' ? 'cancelled' : goods.length === 0 ? 'feesOnly' : 'goods'
  return {
    mode: counted ? 'counted' : 'today',
    state,
    split,
    ordered,
    stillToShip,
    totals,
    allOut: goods.length > 0 && totals.shipped + totals.atWarehouse > 0 && stillToShip === 0 && onShipments === 0,
    left: live.filter((row) => LEFT.has(row.status)).length,
    doors: {
      shipped: live.filter((row) => LEFT.has(row.status) && !(atWarehouse?.has(row.id) ?? false)).map(refOf),
      atWarehouse: live.filter((row) => row.status === 'SHIPPED' && (atWarehouse?.has(row.id) ?? false)).map(refOf),
      packed: live.filter((row) => row.status === 'PACKED').map(refOf),
      draft: live.filter((row) => row.status === 'DRAFT').map(refOf),
      planned: live.filter((row) => NOT_LEFT.has(row.status)).map(refOf),
      back: live.filter((row) => row.status === 'RETURNED' && received?.get(row.id) === false).map(refOf),
    },
    cards: styleGroups(goods).map((group) => cardOf(group, order, cells, rows, received, counted)),
  }
}

/** The buckets the legend draws: each one that holds a garment (Shipped always, "nothing has left yet"). */
export const shownBuckets = (where: Pick<WhereModel, 'totals'>): Bucket[] => BUCKETS.filter((bucket) => bucket === 'shipped' || where.totals[bucket] > 0)

/** "40 + 24 + 12 + 6 + 28 + 4 = 114 ordered" (every bucket that holds a garment). */
export function sumWord(where: Pick<WhereModel, 'totals' | 'ordered'>): ShipWord {
  const parts = BUCKETS.filter((bucket) => where.totals[bucket] > 0).map((bucket) => where.totals[bucket])
  return word('where.eq', { sum: parts.length > 0 ? parts.join(' + ') : '0', ordered: where.ordered })
}

/** The section's one answer (10-design §4). */
export function whereAnswer(where: WhereModel, order: Pick<Order, 'progress'>): ShipWord[] {
  if (where.state === 'pending') return [word('where.state.pending')]
  if (where.state === 'cancelled') return [word('where.state.cancelled')]
  if (where.state === 'feesOnly') return [word('where.state.feesOnly')]
  if (where.allOut) {
    const out = word('where.allOut', undefined, { words: { garments: word('where.garments', { count: where.totals.shipped + where.totals.atWarehouse }), shipments: word('where.shipments', { count: where.left }) } })
    return where.totals.closed > 0 ? [out, word('where.closedPart', { count: where.totals.closed })] : [out]
  }
  if (where.mode === 'today') return [wordOf('orders', 'ship.figures', { ordered: order.progress.ordered, released: order.progress.released, shipped: order.progress.shipped, toShip: order.progress.toShip })]
  const onShipments = where.totals.packed + where.totals.draft + where.totals.planned
  return [
    word('where.answer.toShip', { count: where.stillToShip }),
    where.totals.ready > 0 ? word('where.answer.ready', { count: where.totals.ready }) : word('where.answer.nothingReady'),
    ...(where.totals.back > 0 ? [word('where.answer.back', { count: where.totals.back })] : []),
    ...(onShipments > 0 ? [word('where.answer.onShip', { count: onShipments })] : []),
  ]
}

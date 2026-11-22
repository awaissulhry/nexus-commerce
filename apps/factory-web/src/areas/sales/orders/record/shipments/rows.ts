import { MONEY_HOLD_REASONS } from '@nexus/factory-domain/shipping/holds/holds'
import type { Order } from '../../api'
import { MTM_KIND } from '../../mtm-groups'
import { rowAnchor } from '../dock/discuss'
import type { DeliveryRow } from './delivered/api'
import { proofFileOf } from './delivered/model'
import { madeElsewhereChip } from './elsewhere/model'
import { alsoCarries, carrierOf, trackingDoorOf, trackingOf, typedLinkOf } from './model'
import { piecesOf, type ShipmentRow } from './where'
import { word, wordOf, type ShipWord } from './word'

/**
 * F-OS-103 (order SHIPMENTS tab, 10-design §5; research H2, H3; 13-backend B-OS-001, B-OS-003) — section 2 "Shipments" (#shipments),
 * one row per shipment, pure. The old Deliveries card's columns are in each row (no date shown twice, no second "Nothing shipped yet":
 * L5 keeps its READ, its card went):
 *
 *   Shipment        number (opens it in Warehouse) · "Also carries SEED-SO-0003" · "Split from …" · "Merged into …" · "DDT 144/2026" ·
 *                   "Made elsewhere · DDT …" · "Travels without a DDT · Set by hand"
 *   What it carries "24 pcs · 2 styles", one line per style and colour, "+ 18 pcs of SEED-SO-0003", By size › (a read-only window)
 *   State           the pill (Warehouse's tone) · each hold in force (who placed it, since when, who releases it) · open tracking
 *                   problems · came back (received or not) · the cancel's reason · "Next: … ›" — a link into the Warehouse step
 *   How it travels  the carrier ("Not shown to your role" when withheld, never a bare "—"), the typed number or the first label
 *                   number (Copy · Track ›), "3 parcels · 3 tracked", the Parcels (n) fold, Tracking number… where it may be typed
 *   Dates           Packed · Left · Expected (from the carrier / set by hand) · Delivered (from the carrier / typed by the office /
 *                   collected by the customer / set by hand + its reason) · the carrier's later word · Proof › · Came back
 *
 * Every new field is optional (the server's S1 runs beside this): what is not there yet is not drawn (15-steps "the web never waits").
 */

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

/** Warehouse's tones for a shipment's state (10-design §2: shipped and travelling warm, delivered DS blue, came back danger). */
export const STATE_TONE: Readonly<Record<string, Tone>> = Object.freeze({ DRAFT: 'neutral', PACKED: 'info', SHIPPED: 'warning', DELIVERED: 'success', RETURNED: 'danger', CANCELLED: 'neutral' })

export type Chip =
  | { readonly kind: 'also'; readonly id: string; readonly number: string }
  | { readonly kind: 'splitFrom'; readonly id: string; readonly number: string }
  | { readonly kind: 'mergedInto'; readonly id: string; readonly number: string }
  | { readonly kind: 'ddt'; readonly number: string }
  | { readonly kind: 'elsewhere'; readonly words: ShipWord }
  | { readonly kind: 'noDdt' }

export interface CarriesLine {
  readonly lineId: string
  readonly style: string
  readonly colour: string
  readonly pieces: number
  readonly mtm: boolean
}

export interface CarriesGrid {
  readonly styleId: string
  readonly code: string
  readonly name: string
  readonly sizes: { key: string; label: string }[]
  readonly colours: { key: string; label: string; offered: string[] }[]
  readonly value: Record<string, Record<string, number>>
}

export interface Carries {
  readonly pieces: number
  readonly styles: number
  readonly lines: readonly CarriesLine[]
  /** The pieces of the other orders it carries (all of this customer's), with their numbers. */
  readonly other: { readonly pieces: number; readonly orders: readonly string[] } | null
  /** By size: one grid per style with sizes (made to measure is counted in units in `lines`). */
  readonly grids: readonly CarriesGrid[]
}

export interface HoldView {
  readonly reason: string
  readonly words: string | null
  readonly bySystem: boolean
  readonly placedAt: string
  /** A money hold or one the system placed: finance releases it (Warehouse's own banner rule). */
  readonly finance: boolean
}

/** The Warehouse step a row's "Next: … ›" opens (the step stays in Warehouse: one path), or the holds that block it. */
export type NextStep = { readonly kind: 'step'; readonly step: 'pack' | 'ddt' | 'labels' | 'hand'; readonly tab: 'lines' | 'documents' | 'carrier' } | { readonly kind: 'held' }

export interface StateCell {
  readonly status: string
  readonly tone: Tone
  readonly holds: readonly HoldView[]
  /** Open tracking problems (the deliveries read; 0: none, or not read). */
  readonly problems: number
  /** A shipment that came back: received back or not (null: not said yet). */
  readonly cameBack: { readonly received: boolean | null } | null
  /** Cancelled, with its reason when the read sends it. */
  readonly cancelled: { readonly reason: string | null } | null
  readonly next: NextStep | null
}

export interface TravelsCell {
  /** Who carries it; null: withheld from this reader (`withheld`) or nobody chosen yet. */
  readonly carrier: ShipWord | null
  readonly withheld: boolean
  /** A number typed for a carrier booked by hand (no live tracking), with its link (https only). */
  readonly typed: { readonly number: string; readonly url: string | null } | null
  /** Its labels' parcel numbers: the first, its carrier page, how many more. */
  readonly labels: { readonly first: string; readonly url: string | null; readonly more: number } | null
  readonly hints: readonly ShipWord[]
  /** "3 parcels · 3 tracked" (B-OS-001; with shipping.view). */
  readonly parcels: { readonly count: number; readonly tracked: number } | null
  /** Tracking number… is drawn: the read lets this reader type it here (never held: hidden without the right, P0-B3). */
  readonly trackingDoor: boolean
}

export type ProofFile = { readonly id: string; readonly name: string; readonly contentType: string; readonly sizeBytes: number }

export type DateLine =
  | { readonly kind: 'notPacked' }
  | { readonly kind: 'packed'; readonly at: string }
  | { readonly kind: 'left'; readonly at: string }
  | { readonly kind: 'expected'; readonly at: string; readonly how: 'carrier' | 'hand' | null }
  | { readonly kind: 'delivered'; readonly at: string; readonly how: 'CARRIER' | 'TYPED' | 'COLLECTED' | 'HAND' | null; readonly reason: string | null }
  | { readonly kind: 'carrierLater'; readonly status: string }
  | { readonly kind: 'proof'; readonly signedBy: string | null; readonly file: ProofFile | null; readonly download: boolean }
  | { readonly kind: 'cameBack'; readonly at: string | null }
  | { readonly kind: 'noStatus' }

export interface RowModel {
  readonly id: string
  readonly number: string
  readonly status: string
  readonly anchor: string
  readonly chips: readonly Chip[]
  /** Null: what it carries is not read yet (the cell says "Open in Warehouse ›" only). */
  readonly carries: Carries | null
  readonly state: StateCell
  readonly travels: TravelsCell
  readonly dates: readonly DateLine[]
  /** The Parcels (n) fold may open (its parcels are known, and Warehouse's cartons read is this reader's). */
  readonly fold: number | null
}

const MONEY = new Set<string>(MONEY_HOLD_REASONS)
const sumOf = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0)
const colourOf = (line: Order['lines'][number]): string => line.colourway?.name ?? line.colourway?.code ?? '—'

/** The number, its chips: the other orders it carries, split from / merged into, its DDT (Nexus or paper), no DDT by hand. */
export function chipsOf(row: ShipmentRow, orderId: string): Chip[] {
  const chips: Chip[] = alsoCarries(row, orderId).map((other): Chip => ({ kind: 'also', id: other.id, number: other.number }))
  if (row.splitFrom) chips.push({ kind: 'splitFrom', id: row.splitFrom.id, number: row.splitFrom.number })
  if (row.mergedInto) chips.push({ kind: 'mergedInto', id: row.mergedInto.id, number: row.mergedInto.number })
  if (row.ddt) chips.push({ kind: 'ddt', number: row.ddt.number })
  const elsewhere = madeElsewhereChip(row)
  if (elsewhere) chips.push({ kind: 'elsewhere', words: wordOf('orders', elsewhere.key, elsewhere.params) })
  else if (row.ddtRequired === false && row.status !== 'CANCELLED') chips.push({ kind: 'noDdt' })
  return chips
}

/** What it carries of this order: pieces, styles, one line per colour line, the other orders' pieces, a grid per style. */
export function carriesOf(row: ShipmentRow, order: Pick<Order, 'id' | 'lines'>): Carries | null {
  if (!row.contents) return null
  const contents = row.contents
  const lines: CarriesLine[] = order.lines.flatMap((line) => {
    const pieces = sumOf(contents.filter((entry) => entry.lineId === line.id).map((entry) => entry.pieces))
    return pieces > 0 ? [{ lineId: line.id, style: line.style?.code ?? '—', colour: colourOf(line), pieces, mtm: line.kind === MTM_KIND }] : []
  })
  const styleIds = [...new Set(order.lines.filter((line) => lines.some((entry) => entry.lineId === line.id)).map((line) => line.styleId))]
  const grids: CarriesGrid[] = styleIds.flatMap((styleId) => {
    const own = order.lines.filter((line) => line.styleId === styleId && line.kind !== MTM_KIND && lines.some((entry) => entry.lineId === line.id))
    if (own.length === 0) return []
    const sizes: string[] = []
    for (const line of own) for (const entry of contents) if (entry.lineId === line.id && entry.size !== null && !sizes.includes(entry.size)) sizes.push(entry.size)
    // The style's own size order (the order line's), then any size the shipment names that the line does not.
    const ordered = [...own.flatMap((line) => line.sizes.flatMap((entry) => (entry.size !== null && sizes.includes(entry.size) ? [entry.size] : []))), ...sizes]
    const range = [...new Set(ordered)]
    const value: Record<string, Record<string, number>> = {}
    for (const line of own) value[line.id] = Object.fromEntries(range.map((size) => [size, sumOf(contents.filter((entry) => entry.lineId === line.id && entry.size === size).map((entry) => entry.pieces))]))
    const first = own[0]!
    return [{ styleId, code: first.style?.code ?? '—', name: first.style?.name ?? '', sizes: range.map((size) => ({ key: size, label: size })), colours: own.map((line) => ({ key: line.id, label: line.colourway ? `${line.colourway.code} · ${line.colourway.name}` : '—', offered: range })), value }]
  })
  const others = alsoCarries(row, order.id)
  const otherPieces = row.otherPieces ?? 0
  return {
    pieces: piecesOf(row) ?? 0,
    styles: styleIds.length,
    lines,
    other: otherPieces > 0 ? { pieces: otherPieces, orders: others.map((entry) => entry.number) } : null,
    grids,
  }
}

/** Warehouse's next step, worded as its own `step.*` (H2 pick A): DRAFT pack it; PACKED the DDT, the labels, hand it over; a hold first. */
export function nextOf(row: ShipmentRow): NextStep | null {
  if (row.status === 'DRAFT') return (row.holds ?? []).length > 0 ? { kind: 'held' } : { kind: 'step', step: 'pack', tab: 'lines' }
  if (row.status !== 'PACKED') return null
  if ((row.holds ?? []).length > 0) return { kind: 'held' }
  // A Nexus shipment leaves with a DDT unless a person said it travels without one (B-OS-001 `ddtRequired`; absent: a DDT is needed).
  if (row.origin !== 'ELSEWHERE' && row.ddtRequired !== false && !row.ddt) return { kind: 'step', step: 'ddt', tab: 'documents' }
  // A carrier's labels still to buy: a parcel without its number, the carrier not booked by hand (no typed number on it).
  const parcels = row.parcels ?? null
  const typedHere = row.tracking?.source === 'TYPED' || (parcels ?? []).some((parcel) => parcel.source === 'TYPED')
  if (row.transportBy === 'CARRIER' && parcels && !typedHere && parcels.some((parcel) => parcel.number === null)) return { kind: 'step', step: 'labels', tab: 'carrier' }
  return { kind: 'step', step: 'hand', tab: 'carrier' }
}

/** The State cell: pill and tone, holds, tracking problems, came back, cancelled, next. */
export function stateOf(row: ShipmentRow, delivery: DeliveryRow | null): StateCell {
  const holds = (row.holds ?? []).map((hold): HoldView => ({ reason: hold.reason, words: hold.words, bySystem: hold.bySystem, placedAt: hold.placedAt, finance: hold.bySystem || MONEY.has(hold.reason) }))
  const final = row.status === 'CANCELLED' || row.status === 'DELIVERED' || row.status === 'RETURNED'
  return {
    status: row.status,
    tone: STATE_TONE[row.status] ?? 'neutral',
    holds: row.status === 'DRAFT' || row.status === 'PACKED' ? holds : [],
    problems: delivery && !final ? delivery.openProblems : 0,
    cameBack: row.status === 'RETURNED' ? { received: delivery?.returned ? delivery.returned.received : null } : null,
    cancelled: row.status === 'CANCELLED' ? { reason: row.cancelReason ?? null } : null,
    next: nextOf(row),
  }
}

/** The How it travels cell. */
export function travelsOf(row: ShipmentRow): TravelsCell {
  const carrier = carrierOf(row)
  const withheld = (row.withheld ?? []).length > 0
  const tracking = trackingOf(row)
  const labels = tracking && !tracking.typed && tracking.parcels.length > 0 ? { first: tracking.parcels[0]!.number, url: tracking.parcels[0]!.url, more: tracking.parcels.length - 1 } : null
  const parcels = row.parcels ?? null
  const hints: ShipWord[] = []
  if (row.origin === 'ELSEWHERE') hints.push(word('ships.travels.elsewhere'))
  else if (row.transportBy === 'SENDER' && !tracking && (parcels === null || parcels.length === 0)) hints.push(word('ships.travels.ownVan'))
  if (row.status === 'DRAFT' && row.origin !== 'ELSEWHERE') hints.push(word('ships.travels.draft'))
  return {
    carrier: carrier ? wordOf('orders', carrier.key, carrier.params) : null,
    withheld: carrier === null && withheld,
    typed: tracking?.typed ? { number: tracking.typed, url: typedLinkOf(row) } : null,
    labels,
    hints,
    parcels: parcels && parcels.length > 0 ? { count: parcels.length, tracked: parcels.filter((parcel) => parcel.number !== null).length } : null,
    trackingDoor: trackingDoorOf(row).kind === 'open',
  }
}

/** How a delivery is known: from the carrier, typed by the office, collected by the customer, or set by hand over the carrier. */
function deliveredHow(delivery: DeliveryRow | null): 'CARRIER' | 'TYPED' | 'COLLECTED' | 'HAND' | null {
  if (!delivery) return null
  if (delivery.byHand?.overrode) return 'HAND'
  const via = delivery.deliveredVia
  return via === 'CARRIER' || via === 'TYPED' || via === 'COLLECTED' ? via : null
}

/** The Dates cell, top to bottom (no date shown twice). */
export function datesOf(row: ShipmentRow, delivery: DeliveryRow | null): DateLine[] {
  const lines: DateLine[] = []
  const left = !!row.shippedAt
  if (row.status === 'DRAFT') lines.push({ kind: 'notPacked' })
  if (row.packedAt && !left) lines.push({ kind: 'packed', at: row.packedAt })
  if (row.shippedAt) lines.push({ kind: 'left', at: row.shippedAt })
  const expected = delivery?.expectedDeliveryAt ?? row.expectedDeliveryAt ?? null
  if (expected && row.status === 'SHIPPED') lines.push({ kind: 'expected', at: expected, how: delivery?.etaByHand === true ? 'hand' : delivery?.etaByHand === false && (row.tracking?.live ?? false) ? 'carrier' : null })
  if (row.deliveredAt && row.status === 'DELIVERED') lines.push({ kind: 'delivered', at: row.deliveredAt, how: deliveredHow(delivery), reason: delivery?.byHand?.reason ?? null })
  if (delivery?.carrierLater) lines.push({ kind: 'carrierLater', status: delivery.carrierLater })
  if (delivery?.pod) lines.push({ kind: 'proof', signedBy: delivery.pod.signedBy, file: proofFileOf(delivery), download: delivery.pod.image && delivery.mayOpen })
  if (row.status === 'RETURNED') lines.push({ kind: 'cameBack', at: delivery?.returned?.at ?? null })
  if (row.status === 'SHIPPED' && row.transportBy === 'SENDER' && !expected) lines.push({ kind: 'noStatus' })
  return lines
}

/** One row of the section. `delivery`: the deliveries read's row for it (null: not read, or it has not left). */
export function rowOf(row: ShipmentRow, order: Pick<Order, 'id' | 'lines'>, delivery: DeliveryRow | null): RowModel {
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    anchor: rowAnchor('Shipment', row.id),
    chips: chipsOf(row, order.id),
    carries: carriesOf(row, order),
    state: stateOf(row, delivery),
    travels: travelsOf(row),
    dates: datesOf(row, delivery),
    fold: row.parcels && row.parcels.length > 0 && (row.withheld ?? []).length === 0 ? row.parcels.length : null,
  }
}

/** The order of the answer's states (most advanced first). */
const ANSWER_ORDER = ['DELIVERED', 'SHIPPED', 'RETURNED', 'PACKED', 'DRAFT'] as const

/** "3 shipments · 1 shipped · 1 packed · 1 draft · SEED-SH-0011 expected 14 Nov · 1 cancelled" (empty: the section's empty line). */
export function shipmentsAnswer(rows: readonly ShipmentRow[]): ShipWord[] {
  const live = rows.filter((row) => row.status !== 'CANCELLED')
  const cancelled = rows.length - live.length
  if (live.length === 0) return cancelled > 0 ? [word('ships.answer.status.CANCELLED', { count: cancelled })] : []
  const parts: ShipWord[] = [word('ships.answer.count', { count: live.length })]
  for (const status of ANSWER_ORDER) {
    const count = live.filter((row) => row.status === status).length
    if (count > 0) parts.push(word(`ships.answer.status.${status}`, { count }))
  }
  for (const row of live) if (row.status === 'SHIPPED' && row.expectedDeliveryAt) parts.push(word('ships.answer.expected', { number: row.number }, { instants: { day: row.expectedDeliveryAt } }))
  if (cancelled > 0) parts.push(word('ships.answer.status.CANCELLED', { count: cancelled }))
  return parts
}

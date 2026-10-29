import type { Issue } from '../core/errors'
import { fitsDecimal } from '../core/money'
import { defineMachine } from '../state/machine'
import { parseDecimal } from '../tax/decimal'

/**
 * Shipments (B-W1-46; features LOG-001, LOG-002, LOG-039, GAP-002, PLT-097; A1 §2.5 "Shipment"; Reg. (EU) 2016/425
 * art. 8: only released garments leave). Pure rules; apps/factory-api's modules/shipping loads the facts and writes
 * through command(), and the …_quality_shipping_guards triggers hold the same rules for every login.
 *
 *   status     DRAFT → PACKED → SHIPPED → DELIVERED | RETURNED; PACKED → DRAFT (unpacked); CANCELLED from DRAFT or
 *              PACKED. SHIPPED needs a live DDT (B-W1-47), DELIVERED and RETURNED come from tracking (B-W1-48).
 *   a cell     (a work order's colourway x size) ships at most what quality released, less the reversals, over every
 *              shipment that is not CANCELLED: `shippable`.
 *   a line     garments of one cell of a work order that makes a line of the shipment's sales order, for the
 *              shipment's party, made at the shipment's site; changed only while the shipment is a DRAFT.
 *   a parcel   a place from 1, a weight (kg, Decimal(18,4)) and sizes (cm, Decimal(10,2)) above 0 when given.
 *   packed     lines, each in a parcel; parcels, each weighed and holding garments; a serial-tracked line holds a serial
 *              for each garment (Q31).
 */

export const SHIPMENT_STATUSES = ['DRAFT', 'PACKED', 'SHIPPED', 'DELIVERED', 'RETURNED', 'CANCELLED'] as const
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number]

/** Who carries the goods (DPR 472/1996 "trasporto a cura del"): the sender's van, the customer, a carrier. */
export const TRANSPORT_BY = ['SENDER', 'RECIPIENT', 'CARRIER'] as const
export type TransportBy = (typeof TRANSPORT_BY)[number]

/** The statuses whose lines count against a cell's released garments (every one but CANCELLED). */
export const HOLDING_STATUSES: readonly ShipmentStatus[] = Object.freeze(['DRAFT', 'PACKED', 'SHIPPED', 'DELIVERED', 'RETURNED'])

/** Most lines one request adds; most parcels a shipment has. */
export const MAX_LINES_PER_REQUEST = 100
export const MAX_PARCELS = 99

// ---- what a cell can still ship (LOG-001, LOG-002) ---------------------------------------------------------------

/** A cell's garments: released by quality, taken back by reversals, and on shipments that are not CANCELLED. */
export interface CellCount {
  readonly released: number
  readonly reversed: number
  readonly onShipments: number
}

/** Released less reversed: what quality lets leave the factory. */
export const netReleased = (cell: CellCount): number => cell.released - cell.reversed

/** What a cell can still put on a shipment (never below 0). */
export const shippable = (cell: CellCount): number => Math.max(0, netReleased(cell) - cell.onShipments)

/**
 * Why `more` garments of a cell cannot go on a shipment now (empty: they can). Only released garments ship (QHS-058,
 * LOG-002): the cell's lines over every shipment that is not CANCELLED never pass its releases less their reversals.
 */
export function shippableProblems(cell: CellCount & { readonly label: string }, more: number): string[] {
  if (more <= shippable(cell)) return []
  return [
    `Only released garments ship: ${cell.label} has ${netReleased(cell)} released (less reversals) and ${cell.onShipments} on shipments, so ${shippable(cell)} can still ship; ${more} asked.`,
  ]
}

// ---- lines ------------------------------------------------------------------------------------------------------

/** What a new line needs of its cell (read from the work order cell, its order line and its work order). */
export interface LineCell {
  readonly siteId: string
  readonly partyId: string
  /** The sales order of the cell's order line. */
  readonly salesOrderId: string
}

/** The shipment a line is added to. */
export interface LineShipment {
  readonly siteId: string
  readonly partyId: string
  readonly salesOrderId: string
  readonly status: ShipmentStatus
}

/**
 * Why a cell's garments cannot be a line of this shipment (empty: they can): the same party and sales order as the
 * shipment, made at the shipment's site (the goods leave from where they were made), the shipment a DRAFT, from 1
 * garment.
 */
export function lineProblems(shipment: LineShipment, cell: LineCell, quantity: number, at: string): Issue[] {
  const problems: Issue[] = []
  if (shipment.status !== 'DRAFT') problems.push({ path: at, message: `The shipment is ${shipment.status}; its lines change only while it is a DRAFT.` })
  if (!Number.isSafeInteger(quantity) || quantity < 1) problems.push({ path: `${at}/quantity`, message: 'A line ships at least one garment.' })
  if (cell.partyId !== shipment.partyId || cell.salesOrderId !== shipment.salesOrderId) {
    problems.push({ path: `${at}/workOrderSizeId`, message: "These garments are not of the shipment's sales order." })
  } else if (cell.siteId !== shipment.siteId) {
    problems.push({ path: `${at}/workOrderSizeId`, message: 'These garments are made at another site; a shipment sends the goods of its own site.' })
  }
  return problems
}

/** A line as packing sees it. */
export interface PackLine {
  readonly id: string
  readonly workOrderSizeId: string
  readonly parcelId: string | null
  readonly quantity: number
  /** The serials packed into it. */
  readonly serials: number
  /** Its style traces each garment by serial (Q31 (b)). */
  readonly serialTracked: boolean
}

/** A new quantity for a line (the office): from 1, never below the serials it holds. */
export function lineQuantityProblems(line: PackLine, quantity: number): string[] {
  if (!Number.isSafeInteger(quantity) || quantity < 1) return ['A line ships at least one garment; remove it instead.']
  if (quantity < line.serials) return [`The line holds ${line.serials} serial(s); unpack ${line.serials - quantity} of them first.`]
  return []
}

/**
 * How `quantity` garments of a line get into a parcel (or out of every parcel, `parcelId` null), keeping one line per
 * cell and parcel:
 *
 *   none    they are there already
 *   move    the whole line moves (no line of its cell is in the target)
 *   merge   into the target's line of the same cell: the source shrinks (or goes, with its serials moved over)
 *   split   part of the line moves: the source shrinks, a new line in the target takes the rest
 *
 * A line that holds serials moves whole: its serials go with it (pack and unpack serials one by one otherwise).
 */
export type Placement =
  | { readonly kind: 'none' }
  | { readonly kind: 'move'; readonly lineId: string; readonly parcelId: string | null }
  | { readonly kind: 'merge'; readonly fromLineId: string; readonly intoLineId: string; readonly quantity: number; readonly removesSource: boolean; readonly movesSerials: boolean }
  | { readonly kind: 'split'; readonly fromLineId: string; readonly keeps: number; readonly quantity: number; readonly parcelId: string | null }

export type PlacementResult = { readonly ok: true; readonly placement: Placement } | { readonly ok: false; readonly problem: string }

export function placementOf(line: PackLine, parcelId: string | null, quantity: number, lines: readonly PackLine[]): PlacementResult {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > line.quantity) {
    return { ok: false, problem: `Move from 1 to ${line.quantity} garment(s) of this line.` }
  }
  if (line.parcelId === parcelId) return { ok: true, placement: { kind: 'none' } }
  const whole = quantity === line.quantity
  if (!whole && line.serials > 0) {
    return { ok: false, problem: `The line holds ${line.serials} serial(s): move it whole, or unpack its serials and pack them one by one.` }
  }
  const target = lines.find((other) => other.id !== line.id && other.workOrderSizeId === line.workOrderSizeId && other.parcelId === parcelId)
  if (target) {
    return { ok: true, placement: { kind: 'merge', fromLineId: line.id, intoLineId: target.id, quantity, removesSource: whole, movesSerials: whole && line.serials > 0 } }
  }
  if (whole) return { ok: true, placement: { kind: 'move', lineId: line.id, parcelId } }
  return { ok: true, placement: { kind: 'split', fromLineId: line.id, keeps: line.quantity - quantity, quantity, parcelId } }
}

// ---- parcels (LOG-039) ------------------------------------------------------------------------------------------

/** A parcel's measures as sent: decimal strings, null to clear, undefined to keep. */
export interface ParcelMeasures {
  readonly grossWeightKg?: string | null | undefined
  readonly lengthCm?: string | null | undefined
  readonly widthCm?: string | null | undefined
  readonly heightCm?: string | null | undefined
}

const positive = (value: string, precision: number, scale: number): boolean => fitsDecimal(value, precision, scale) && (parseDecimal(value)?.greaterThan(0) ?? false)

/** A weight in kilograms above 0 (Decimal(18,4)); sizes in centimetres above 0 (Decimal(10,2)). */
export function parcelMeasureProblems(measures: ParcelMeasures, at = 'body'): Issue[] {
  const problems: Issue[] = []
  const weight = measures.grossWeightKg
  if (weight !== null && weight !== undefined && !positive(weight, 18, 4)) problems.push({ path: `${at}/grossWeightKg`, message: 'Expected a weight in kilograms above 0, with at most 4 decimals.' })
  for (const key of ['lengthCm', 'widthCm', 'heightCm'] as const) {
    const value = measures[key]
    if (value !== null && value !== undefined && !positive(value, 10, 2)) problems.push({ path: `${at}/${key}`, message: 'Expected centimetres above 0, with at most 2 decimals.' })
  }
  return problems
}

/** The place a new parcel takes: one after the highest. */
export const nextParcelSeq = (parcels: readonly { readonly seq: number }[]): number => parcels.reduce((highest, parcel) => Math.max(highest, parcel.seq), 0) + 1

/** The parcels' new places after one is removed: 1, 2, 3 … in their order (only the ones that move). */
export function renumberedParcels(parcels: readonly { readonly id: string; readonly seq: number }[]): { readonly id: string; readonly seq: number }[] {
  return [...parcels]
    .sort((a, b) => a.seq - b.seq)
    .map((parcel, index) => ({ id: parcel.id, seq: index + 1, was: parcel.seq }))
    .filter((parcel) => parcel.seq !== parcel.was)
    .map(({ id, seq }) => ({ id, seq }))
}

// ---- packing complete (DRAFT → PACKED), unpacking and cancelling -------------------------------------------------

/** A parcel as packing sees it. */
export interface PackParcel {
  readonly id: string
  readonly seq: number
  readonly grossWeightKg: string | null
  /** A carrier label was bought for it (B-W1-48). */
  readonly labelled: boolean
}

export interface ShipmentFacts {
  readonly lines: readonly PackLine[]
  readonly parcels: readonly PackParcel[]
  /** DDTs of the shipment that no cancellation names (B-W1-47). */
  readonly liveDdts: number
}

/**
 * What a shipment still needs before it is PACKED (empty: nothing), in words for the packer (PLT-097): lines, each in a
 * parcel; parcels, each weighed and holding garments (an empty box is not a package); a serial for each garment of a
 * serial-tracked line (Q31).
 */
export function packingProblems(facts: Pick<ShipmentFacts, 'lines' | 'parcels'>): string[] {
  const problems: string[] = []
  if (facts.lines.length === 0) problems.push('at least one line of released garments')
  const unpacked = facts.lines.filter((line) => line.parcelId === null).reduce((garments, line) => garments + line.quantity, 0)
  if (unpacked > 0) problems.push(`every garment in a parcel (${unpacked} not packed)`)
  if (facts.parcels.length === 0) problems.push('at least one parcel')
  const sorted = [...facts.parcels].sort((a, b) => a.seq - b.seq)
  const unweighed = sorted.filter((parcel) => parcel.grossWeightKg === null).map((parcel) => parcel.seq)
  if (unweighed.length > 0) problems.push(`every parcel weighed (parcel ${unweighed.join(', ')} not weighed)`)
  const filled = new Set(facts.lines.map((line) => line.parcelId))
  const empty = sorted.filter((parcel) => !filled.has(parcel.id)).map((parcel) => parcel.seq)
  if (empty.length > 0) problems.push(`garments in every parcel (parcel ${empty.join(', ')} is empty: remove it)`)
  const missing = facts.lines.filter((line) => line.serialTracked && line.serials < line.quantity).reduce((garments, line) => garments + line.quantity - line.serials, 0)
  if (missing > 0) problems.push(`a serial for each garment of a serial-tracked style (${missing} missing)`)
  return problems
}

/** Labels and a live DDT tie the packed goods to what was declared: undo them before the shipment changes. */
function declaredProblems(facts: Pick<ShipmentFacts, 'parcels' | 'liveDdts'>): string[] {
  const problems: string[] = []
  const labelled = facts.parcels.filter((parcel) => parcel.labelled).length
  if (labelled > 0) problems.push(`no carrier label (${labelled} parcel(s) labelled: void the labels first)`)
  if (facts.liveDdts > 0) problems.push('no live DDT (cancel the DDT first)')
  return problems
}

/** What unpacking (PACKED → DRAFT) needs: no carrier label and no live DDT. */
export const unpackProblems = (facts: Pick<ShipmentFacts, 'parcels' | 'liveDdts'>): string[] => declaredProblems(facts)

/** What cancelling (from DRAFT or PACKED) needs: no carrier label and no live DDT. */
export const cancelProblems = (facts: Pick<ShipmentFacts, 'parcels' | 'liveDdts'>): string[] => declaredProblems(facts)

/**
 * The shipment's state machine (A1 §2.5; the …_quality_shipping_guards trigger holds the same moves). Guards: PACKED
 * (packing complete), DRAFT from PACKED (unpacking), CANCELLED. SHIPPED (with its DDT, B-W1-47), DELIVERED and RETURNED
 * (tracking, B-W1-48) get their guards with their steps.
 */
export const shipmentMachine = defineMachine<ShipmentStatus, ShipmentFacts>({
  name: 'shipment',
  states: SHIPMENT_STATUSES,
  transitions: {
    DRAFT: ['PACKED', 'CANCELLED'],
    PACKED: ['DRAFT', 'SHIPPED', 'CANCELLED'],
    SHIPPED: ['DELIVERED', 'RETURNED'],
  },
  guards: {
    PACKED: (facts) => packingProblems(facts),
    DRAFT: (facts) => unpackProblems(facts),
    CANCELLED: (facts) => cancelProblems(facts),
  },
})

/** The statuses a shipment's lines and parcels may be added to, removed from or moved in. */
export const isPackable = (status: ShipmentStatus): boolean => status === 'DRAFT'

/** A parcel's weight and sizes change until the shipment leaves (DRAFT or PACKED); a PACKED parcel keeps a weight. */
export function parcelChangeProblems(status: ShipmentStatus, measures: ParcelMeasures): string[] {
  if (status !== 'DRAFT' && status !== 'PACKED') return [`The shipment is ${status}; its parcels change only until it leaves.`]
  if (status === 'PACKED' && measures.grossWeightKg === null) return ['The shipment is PACKED: every parcel keeps a weight (unpack it first).']
  return []
}

// ---- the ready-to-ship list (SCR-066) -----------------------------------------------------------------------------

/** One cell with its counts, as the ready-to-ship list reads it. */
export interface ReadyCell extends CellCount {
  readonly workOrderSizeId: string
  readonly salesOrderId: string
}

/** The cells that can still ship something, grouped by sales order (orders in the given order, cells as given). */
export function readyBySalesOrder<Cell extends ReadyCell>(cells: readonly Cell[]): { readonly salesOrderId: string; readonly cells: readonly (Cell & { readonly shippable: number })[] }[] {
  const groups = new Map<string, (Cell & { readonly shippable: number })[]>()
  for (const cell of cells) {
    const can = shippable(cell)
    if (can <= 0) continue
    const group = groups.get(cell.salesOrderId) ?? []
    group.push({ ...cell, shippable: can })
    groups.set(cell.salesOrderId, group)
  }
  return [...groups.entries()].map(([salesOrderId, entries]) => ({ salesOrderId, cells: entries }))
}

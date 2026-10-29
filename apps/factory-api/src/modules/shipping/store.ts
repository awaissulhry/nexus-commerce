import type { Prisma } from '@nexus/factory-db'
import { InvalidStateError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { packingProblems, type PackLine, type PackParcel, type ShipmentFacts, type ShipmentStatus } from '@nexus/factory-domain/shipping/shipments'
import type { CommandTools, CommandTx } from '../../core/command'

/**
 * The shipping module's reads (every read names its columns) and the views its answers share. A reader takes the
 * command's transaction or a scoped client (`request.withClient`): row-level security decides what it finds.
 */

export const SHIPMENT_HEADER = {
  id: true,
  companyId: true,
  siteId: true,
  partyId: true,
  salesOrderId: true,
  number: true,
  status: true,
  shipToAddressId: true,
  shipTo: true,
  transportBy: true,
  carrierCode: true,
  carrierName: true,
  serviceCode: true,
  carrierShipmentId: true,
  ddtRequired: true,
  packedAt: true,
  shippedAt: true,
  deliveredAt: true,
  returnedAt: true,
  cancelledAt: true,
  cancelReason: true,
  internalNote: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.ShipmentSelect

export type ShipmentHeader = Prisma.ShipmentGetPayload<{ select: typeof SHIPMENT_HEADER }>

/** The shipment's header, or null (missing, or out of the caller's scope). */
export async function readShipment(db: CommandTx, shipmentId: string): Promise<ShipmentHeader | null> {
  if (!isUuid(shipmentId)) return null
  return db.shipment.findUnique({ where: { id: shipmentId }, select: SHIPMENT_HEADER })
}

const LINE_SELECT = {
  id: true,
  parcelId: true,
  workOrderId: true,
  workOrderSizeId: true,
  salesOrderLineId: true,
  size: true,
  quantity: true,
  version: true,
  workOrderSize: {
    select: {
      colourway: { select: { id: true, code: true, name: true } },
      workOrder: { select: { number: true, batchNumber: true, style: { select: { id: true, code: true, name: true, garmentTracking: true } } } },
    },
  },
  serials: { select: { id: true, serial: true }, orderBy: { serial: 'asc' } },
} as const satisfies Prisma.ShipmentLineSelect

const PARCEL_SELECT = {
  id: true,
  seq: true,
  grossWeightKg: true,
  lengthCm: true,
  widthCm: true,
  heightCm: true,
  trackingNumber: true,
  labelledAt: true,
  version: true,
} as const satisfies Prisma.ParcelSelect

type LineRow = Prisma.ShipmentLineGetPayload<{ select: typeof LINE_SELECT }>
type ParcelRow = Prisma.ParcelGetPayload<{ select: typeof PARCEL_SELECT }>

const decimal = (value: Prisma.Decimal | null, places: number): string | null => (value === null ? null : value.toFixed(places))

export const lineView = (line: LineRow) => ({
  id: line.id,
  version: line.version,
  parcelId: line.parcelId,
  workOrderId: line.workOrderId,
  workOrderNumber: line.workOrderSize.workOrder.number,
  batchNumber: line.workOrderSize.workOrder.batchNumber,
  workOrderSizeId: line.workOrderSizeId,
  salesOrderLineId: line.salesOrderLineId,
  styleId: line.workOrderSize.workOrder.style.id,
  styleCode: line.workOrderSize.workOrder.style.code,
  styleName: line.workOrderSize.workOrder.style.name,
  colourwayId: line.workOrderSize.colourway.id,
  colourwayCode: line.workOrderSize.colourway.code,
  colourwayName: line.workOrderSize.colourway.name,
  size: line.size,
  quantity: line.quantity,
  serialTracked: line.workOrderSize.workOrder.style.garmentTracking === 'SERIAL',
  serials: line.serials,
})

export const parcelView = (parcel: ParcelRow, lines: readonly LineRow[]) => ({
  id: parcel.id,
  version: parcel.version,
  seq: parcel.seq,
  grossWeightKg: decimal(parcel.grossWeightKg, 4),
  lengthCm: decimal(parcel.lengthCm, 2),
  widthCm: decimal(parcel.widthCm, 2),
  heightCm: decimal(parcel.heightCm, 2),
  trackingNumber: parcel.trackingNumber,
  labelledAt: parcel.labelledAt ? toUtcIso(parcel.labelledAt) : null,
  garments: lines.filter((line) => line.parcelId === parcel.id).reduce((garments, line) => garments + line.quantity, 0),
})

export type LineView = ReturnType<typeof lineView>
export type ParcelView = ReturnType<typeof parcelView>

/** The shipment's lines (by style, colourway, size) and parcels (by place), as read now. */
export async function readContents(db: CommandTx, shipmentId: string): Promise<{ lines: LineRow[]; parcels: ParcelRow[] }> {
  const [lines, parcels] = await Promise.all([
    db.shipmentLine.findMany({ where: { shipmentId }, select: LINE_SELECT, orderBy: { id: 'asc' } }),
    db.parcel.findMany({ where: { shipmentId }, select: PARCEL_SELECT, orderBy: { seq: 'asc' } }),
  ])
  lines.sort(
    (a, b) =>
      a.workOrderSize.workOrder.style.code.localeCompare(b.workOrderSize.workOrder.style.code) ||
      a.workOrderSize.colourway.code.localeCompare(b.workOrderSize.colourway.code) ||
      a.size.localeCompare(b.size, undefined, { numeric: true }) ||
      (a.parcelId ?? '').localeCompare(b.parcelId ?? '') ||
      a.id.localeCompare(b.id),
  )
  return { lines, parcels }
}

/** The facts the shipment machine's guards need (packing complete, labels, live DDTs). */
export async function shipmentFacts(db: CommandTx, shipmentId: string, contents?: { lines: LineRow[]; parcels: ParcelRow[] }): Promise<ShipmentFacts> {
  const [{ lines, parcels }, liveDdts] = await Promise.all([
    contents ?? readContents(db, shipmentId),
    db.ddt.count({ where: { shipmentId, cancellations: { none: {} } } }),
  ])
  return { lines: lines.map(packLineOf), parcels: parcels.map(packParcelOf), liveDdts }
}

export const packLineOf = (line: LineRow): PackLine => ({
  id: line.id,
  workOrderSizeId: line.workOrderSizeId,
  parcelId: line.parcelId,
  quantity: line.quantity,
  serials: line.serials.length,
  serialTracked: line.workOrderSize.workOrder.style.garmentTracking === 'SERIAL',
})

export const packParcelOf = (parcel: ParcelRow): PackParcel => ({
  id: parcel.id,
  seq: parcel.seq,
  grossWeightKg: decimal(parcel.grossWeightKg, 4),
  labelled: parcel.trackingNumber !== null || parcel.labelledAt !== null,
})

/** What packing still needs, the lines and parcels: the part of a shipment's answer every packer sees. */
export async function contentsView(db: CommandTx, shipmentId: string) {
  const contents = await readContents(db, shipmentId)
  const facts = { lines: contents.lines.map(packLineOf), parcels: contents.parcels.map(packParcelOf) }
  return {
    lines: contents.lines.map(lineView),
    parcels: contents.parcels.map((parcel) => parcelView(parcel, contents.lines)),
    garments: contents.lines.reduce((garments, line) => garments + line.quantity, 0),
    packingProblems: packingProblems(facts),
  }
}

/**
 * Inside a command on the shipment (its row locked by the version bump): its status now, which must be one of
 * `allowed` (else 409 saying what it is).
 */
export async function lockedStatus(tools: Pick<CommandTools, 'tx'>, shipmentId: string, allowed: readonly ShipmentStatus[], doing: string): Promise<ShipmentHeader> {
  const shipment = await readShipment(tools.tx, shipmentId)
  if (!shipment) throw new InvalidStateError('The shipment is gone.')
  if (!allowed.includes(shipment.status)) {
    throw new InvalidStateError(`The shipment is ${shipment.status}; ${doing} only while it is ${allowed.join(' or ')}.`)
  }
  return shipment
}

/** The scalars of a shipment's header as JSON (dates as UTC strings). */
export function headerView(shipment: ShipmentHeader) {
  const at = (value: Date | null) => (value ? toUtcIso(value) : null)
  return {
    ...shipment,
    shipTo: shipment.shipTo as Record<string, unknown>,
    packedAt: at(shipment.packedAt),
    shippedAt: at(shipment.shippedAt),
    deliveredAt: at(shipment.deliveredAt),
    returnedAt: at(shipment.returnedAt),
    cancelledAt: at(shipment.cancelledAt),
    createdAt: toUtcIso(shipment.createdAt),
    updatedAt: toUtcIso(shipment.updatedAt),
  }
}

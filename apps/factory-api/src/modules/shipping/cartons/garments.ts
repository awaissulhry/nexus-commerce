import { ConflictError, DomainError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { holdReasonWords } from '@nexus/factory-domain/shipping/cartons/refusals'
import { cartonRefusal, refusalPath, type CartonRefusal, type ScannedPiece } from '@nexus/factory-domain/shipping/cartons/rules'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { SHIPPING_PACK } from '@nexus/factory-domain/shipping/permissions'
import type { CommandCaller, CommandTools, CommandTx } from '../../../core/command'
import { assertMay, shippingContextOf, type ShippingContext } from '../access'
import { readShipment, type ShipmentHeader } from '../store'
import { holdInForce, type BenchLine } from './store'

/**
 * The packing bench's shared steps (B-W2b-384): who may work on a shipment, a refusal in words with its code, the hold
 * check, what a scanned code is, and the moves of one garment between a cell's lines and a carton's contents. Every write
 * here runs inside a command on the Shipment (its version bump locks the row; the cell's shipping lock follows).
 */

/** Refuses with the words and the code (`refusal/<CODE>`: the screens word it, floor-sync keeps it as the module's own). */
export function refused(refusal: CartonRefusal): never {
  throw new DomainError('conflict', refusal.message, [{ path: refusalPath(refusal.code), message: refusal.message }])
}

/** The shipment the caller may see (`see`) and work on (`permission`): the office's within its grants, a floor device's at its own site. */
export async function benchShipment(caller: CommandCaller, shipmentId: string, see: Permission = SHIPPING_PACK, permission: Permission = SHIPPING_PACK): Promise<{ context: ShippingContext; shipment: ShipmentHeader }> {
  const context = shippingContextOf(caller)
  const shipment = await caller.withClient((client) => readShipment(client, shipmentId))
  assertMay(context, see, permission, shipment)
  return { context, shipment: shipment! }
}

/** Inside the command: nothing goes into a held shipment's cartons (the database refuses it too). */
export async function refuseIfHeld(tx: CommandTx, shipmentId: string): Promise<void> {
  const hold = await holdInForce(tx, shipmentId)
  if (hold) refused(cartonRefusal('ON_HOLD', { reason: holdReasonWords(hold.reason) }))
}

/** Who did it: the office user or the floor worker. */
export const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' || tools.context.audience === 'floor' ? tools.context.actorId : null)

/** A code as scanned or typed, and its upper-case form (labels print codes in capitals). */
const forms = (code: string): string[] => [...new Set([code.trim(), code.trim().toUpperCase()])]

/**
 * What a scanned code is: a garment serial, a SKU or barcode (GTIN) of the colour × size matrix, or a batch (or work
 * order) number of a batch label — preferring the work order on this shipment — with the cell the packer chose. Null:
 * nothing of this factory has it.
 */
export async function pieceOf(tx: CommandTx, code: string, cellId: string | null, lines: readonly BenchLine[]): Promise<ScannedPiece | null> {
  const codes = forms(code)
  const serial = await tx.garmentSerial.findFirst({
    where: { serial: { in: codes } },
    select: {
      id: true,
      serial: true,
      status: true,
      shipmentLineId: true,
      parcelId: true,
      workOrderSizeId: true,
      workOrderSize: { select: { salesOrderLineId: true, size: true, colourway: { select: { id: true, code: true } }, workOrder: { select: { style: { select: { id: true, code: true } } } } } },
    },
  })
  if (serial) {
    return {
      kind: 'SERIAL',
      serialId: serial.id,
      serial: serial.serial,
      cellId: serial.workOrderSizeId,
      styleId: serial.workOrderSize.workOrder.style.id,
      styleCode: serial.workOrderSize.workOrder.style.code,
      colourwayId: serial.workOrderSize.colourway.id,
      colourwayCode: serial.workOrderSize.colourway.code,
      size: serial.workOrderSize.size,
      status: serial.status,
      forOrder: serial.workOrderSize.salesOrderLineId !== null,
      shipmentLineId: serial.shipmentLineId,
      onThisShipment: serial.shipmentLineId !== null && lines.some((line) => line.id === serial.shipmentLineId),
      parcelId: serial.parcelId,
    }
  }
  const variant = await tx.variant.findFirst({ where: { OR: [{ sku: { in: codes } }, { gtin: { in: codes } }] }, select: { size: true, colourway: { select: { id: true, code: true, style: { select: { id: true, code: true } } } } } })
  if (variant) {
    return { kind: 'SKU', code: code.trim(), styleId: variant.colourway.style.id, styleCode: variant.colourway.style.code, colourwayId: variant.colourway.id, colourwayCode: variant.colourway.code, size: variant.size }
  }
  const orders = await tx.workOrder.findMany({ where: { OR: [{ batchNumber: { in: codes } }, { number: { in: codes } }] }, select: { id: true }, take: 20 })
  const order = orders.find((entry) => lines.some((line) => line.workOrderId === entry.id)) ?? orders[0]
  return order ? { kind: 'BATCH', code: code.trim(), workOrderId: order.id, cellId: cellId !== null && isUuid(cellId) ? cellId : null } : null
}

/** The carton contents of a line in its carton changed by `by` garments (made, grown, shrunk or removed). */
export async function changeContents(tools: CommandTools, shipment: ShipmentHeader, line: { readonly id: string; readonly parcelId: string; readonly size: string }, by: 1 | -1): Promise<void> {
  const row = await tools.tx.parcelLine.findFirst({ where: { shipmentLineId: line.id, parcelId: line.parcelId }, select: { id: true, quantity: true } })
  if (!row) {
    if (by < 0) throw new ConflictError('This line has no garment in that carton.')
    await tools.tx.parcelLine.create({
      data: { id: newId(), siteId: shipment.siteId, partyId: shipment.partyId, shipmentId: shipment.id, parcelId: line.parcelId, shipmentLineId: line.id, size: line.size, quantity: 1, createdById: actorIdOf(tools) },
      select: { id: true },
    })
  } else if (row.quantity + by === 0) {
    await tools.tx.parcelLine.delete({ where: { id: row.id }, select: { id: true } })
  } else {
    await tools.tx.parcelLine.update({ where: { id: row.id }, data: { quantity: row.quantity + by, version: { increment: 1 } }, select: { id: true } })
  }
}

/**
 * One garment of `from` moves to `toParcelId` (a carton, or null: loose): the line itself (`whole`), onto the cell's line
 * there (`into`), or as a new line of one garment. The source shrinks or goes first (the cell's caps are counted over the
 * lines). Answers the line that now holds the garment. Its contents and serial are the caller's.
 */
export async function moveGarment(tools: CommandTools, shipment: ShipmentHeader, from: BenchLine, into: BenchLine | null, toParcelId: string | null, whole: boolean): Promise<{ readonly id: string; readonly parcelId: string | null; readonly size: string }> {
  if (whole) {
    await tools.tx.shipmentLine.update({ where: { id: from.id }, data: { parcelId: toParcelId, version: { increment: 1 } }, select: { id: true } })
    return { id: from.id, parcelId: toParcelId, size: from.size }
  }
  if (from.quantity === 1) await tools.tx.shipmentLine.delete({ where: { id: from.id }, select: { id: true } })
  else await tools.tx.shipmentLine.update({ where: { id: from.id }, data: { quantity: from.quantity - 1, version: { increment: 1 } }, select: { id: true } })
  if (into) {
    await tools.tx.shipmentLine.update({ where: { id: into.id }, data: { quantity: into.quantity + 1, version: { increment: 1 } }, select: { id: true } })
    return { id: into.id, parcelId: toParcelId, size: into.size }
  }
  const id = newId()
  await tools.tx.shipmentLine.create({
    data: {
      id,
      siteId: shipment.siteId,
      partyId: shipment.partyId,
      shipmentId: shipment.id,
      parcelId: toParcelId,
      workOrderId: from.workOrderId,
      workOrderSizeId: from.workOrderSizeId,
      salesOrderLineId: from.salesOrderLineId,
      size: from.size,
      quantity: 1,
      createdById: actorIdOf(tools),
    },
    select: { id: true },
  })
  return { id, parcelId: toParcelId, size: from.size }
}

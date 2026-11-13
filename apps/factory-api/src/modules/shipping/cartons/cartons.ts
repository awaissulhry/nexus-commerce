import { DomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { cartonRefusal, cellsOfPiece, takeOutOf } from '@nexus/factory-domain/shipping/cartons/rules'
import { isParcelPackaging, overweight } from '@nexus/factory-domain/shipping/packaging/rules'
import { SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import { parcelMeasureProblems } from '@nexus/factory-domain/shipping/shipments'
import { command, type CommandCaller } from '../../../core/command'
import { lockCells, tenantOf } from '../cells'
import { readShipment } from '../store'
import { benchShipment, changeContents, moveGarment, pieceOf, refused, refuseIfHeld } from './garments'
import { printMarks } from './marks'
import { benchView, cartonLinesOf, cartonParcelsOf, defaultCartonFor, readBench, renumberCartons, scannedOf } from './store'

/**
 * The packing bench's cartons (B-W2b-384; LOG-007, LOG-010, LOG-013, LOG-008; design floor.pack "Scan into the carton",
 * "Close carton", warehouse.shipments "Cartons", "Carton 2 of 3"):
 *
 *   getBench            the bench's view (shipping.pack; office and the site's floor): the size grid, the cartons and
 *                       their contents with serials and batches, the open carton, the packaging to choose and the default
 *   getShipmentCartons  the same for the office's shipment record (shipping.view)
 *   takeOut             one garment out of a carton (its serial, SKU, barcode or batch label): back to its cell's loose line,
 *                       its serial out of the shipment; a closed carton opens again
 *   closeCarton         stores the carton's contents: every garment of it scanned, its packaging (the one chosen, its own,
 *                       or the default for its garments; a carton, box or pallet in use of the shipment's company), its gross
 *                       weight when given, its number "n of N" (the other closed cartons take the count); then prints its
 *                       marks on the site's label printer unless asked not to (cartons/marks.ts)
 *
 * Every write is one command on the Shipment while it is a DRAFT and not held. The scan itself is packing/scan.ts.
 */

export async function getBench(caller: CommandCaller, shipmentId: string) {
  const { shipment } = await benchShipment(caller, shipmentId)
  return caller.withClient((client) => benchView(client, shipment))
}

export async function getShipmentCartons(caller: CommandCaller, shipmentId: string) {
  const { shipment } = await benchShipment(caller, shipmentId, SHIPPING_VIEW, SHIPPING_VIEW)
  return caller.withClient((client) => benchView(client, shipment))
}

/** shipping.pack: one scanned garment out of the carton. */
export async function takeOut(caller: CommandCaller, shipmentId: string, parcelId: string, body: { version?: number | undefined; code: string; cellId?: string | undefined }, idempotencyKey?: string) {
  const { shipment } = await benchShipment(caller, shipmentId)
  const { result } = await command(caller, { name: 'shipping.takeOutOfCarton', idempotencyKey, input: { shipmentId, parcelId, ...body }, record: { type: 'Shipment', id: shipment.id, expectedVersion: body.version } }, async (tools) => {
    const current = (await readShipment(tools.tx, shipment.id))!
    if (current.status !== 'DRAFT') refused(cartonRefusal('NOT_DRAFT', { status: current.status }))
    const bench = await readBench(tools.tx, current.id)
    const parcels = cartonParcelsOf(bench)
    const carton = parcels.find((parcel) => parcel.id === parcelId)
    if (!carton) throw new NotFoundError('Carton not found in this shipment.')
    if (carton.labelled) refused(cartonRefusal('CARTON_LABELLED', { seq: carton.seq }))
    const lines = cartonLinesOf(bench)
    const piece = await pieceOf(tools.tx, body.code, body.cellId ?? null, bench.lines)
    if (!piece) refused({ code: 'UNKNOWN_CODE', message: `Code ${body.code.trim()} is not a garment label of this factory: no serial, SKU, barcode or batch has it.` })
    // A serial in this carton is taken out whatever its state now; any other piece must be one this shipment carries.
    const inThisCarton = piece.kind === 'SERIAL' && piece.onThisShipment && piece.parcelId === carton.id
    const cells = inThisCarton ? { ok: true as const, cellIds: [piece.cellId] } : cellsOfPiece(piece, lines, (id) => parcels.find((parcel) => parcel.id === id)?.seq ?? null)
    if (!cells.ok) refused(cells.refusal)
    const decided = takeOutOf(lines, cells.cellIds, carton.id, piece.kind === 'SERIAL' ? { serialLineId: piece.shipmentLineId, serialParcelId: piece.parcelId } : { serialLineId: null, serialParcelId: null }, piece.kind === 'SERIAL' ? `Serial ${piece.serial}` : `Code ${body.code.trim()}`)
    if (!decided.ok) refused(decided.refusal)
    const line = bench.lines.find((entry) => entry.id === decided.out.lineId)!
    await lockCells(tools.tx, tenantOf(tools.context), [line.workOrderSizeId])
    // Its contents and its serial first (a line is removed only without contents), then the garment back to the loose line.
    await changeContents(tools, current, { id: line.id, parcelId: carton.id, size: line.size }, -1)
    if (piece.kind === 'SERIAL') await tools.tx.garmentSerial.update({ where: { id: piece.serialId }, data: { shipmentLineId: null, version: { increment: 1 } }, select: { id: true } })
    const into = decided.out.intoLineId ? bench.lines.find((entry) => entry.id === decided.out.intoLineId)! : null
    const holder = await moveGarment(tools, current, line, into, null, decided.out.whole)
    // A closed carton opens again: its contents changed, so its number and marks no longer say what it holds.
    const reopened = carton.closed
    if (reopened) await tools.tx.parcel.update({ where: { id: carton.id }, data: { cartonNumber: null, cartonCount: null, marksPrintedAt: null, version: { increment: 1 } }, select: { id: true } })
    tools.audit({
      action: 'shipping.takeOutOfCarton',
      recordType: 'Shipment',
      recordId: current.id,
      companyId: current.companyId,
      siteId: current.siteId,
      after: { code: body.code.trim(), kind: piece.kind, parcelId: carton.id, cartonSeq: carton.seq, fromLineId: line.id, toLineId: holder.id, serialId: piece.kind === 'SERIAL' ? piece.serialId : null, reopened },
    })
    tools.emit({ type: 'shipment.packing_changed', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { shipmentId: current.id, number: current.number, status: current.status, change: piece.kind === 'SERIAL' ? 'serials' : 'lines' } })
    const after = (await readShipment(tools.tx, current.id))!
    return { takenOut: { parcelId: carton.id, cartonSeq: carton.seq, cellId: line.workOrderSizeId, serialId: piece.kind === 'SERIAL' ? piece.serialId : null, reopened }, bench: await benchView(tools.tx, after) }
  })
  return result
}

export interface CloseBody {
  readonly version?: number | undefined
  readonly packagingTypeId?: string | undefined
  readonly grossWeightKg?: string | undefined
  /** Print its marks on the site's label printer (or the one named) after closing it; default yes. */
  readonly print?: boolean | undefined
  readonly printerId?: string | undefined
  readonly copies?: number | undefined
}

/** shipping.pack: closes a carton (its contents, packaging, weight and "n of N"), then prints its marks. */
export async function closeCarton(callers: { caller: CommandCaller; system: (tenantId: string) => CommandCaller }, shipmentId: string, parcelId: string, body: CloseBody, idempotencyKey?: string) {
  const caller = callers.caller
  if (body.grossWeightKg !== undefined) {
    const problems = parcelMeasureProblems({ grossWeightKg: body.grossWeightKg })
    if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  }
  const { shipment } = await benchShipment(caller, shipmentId)
  const { result } = await command(
    caller,
    { name: 'shipping.closeCarton', idempotencyKey, input: { shipmentId, parcelId, ...body }, record: { type: 'Shipment', id: shipment.id, expectedVersion: body.version } },
    async (tools) => {
      const current = (await readShipment(tools.tx, shipment.id))!
      if (current.status !== 'DRAFT') refused(cartonRefusal('NOT_DRAFT', { status: current.status }))
      await refuseIfHeld(tools.tx, current.id)
      const bench = await readBench(tools.tx, current.id)
      const parcel = bench.parcels.find((entry) => entry.id === parcelId)
      if (!parcel) throw new NotFoundError('Carton not found in this shipment.')
      if (parcel.trackingNumber !== null || parcel.labelledAt !== null) refused(cartonRefusal('CARTON_LABELLED', { seq: parcel.seq }))
      const inCarton = bench.lines.filter((line) => line.parcelId === parcel.id)
      const garments = bench.contents.filter((content) => content.parcelId === parcel.id).reduce((sum, content) => sum + content.quantity, 0)
      if (garments === 0) refused(cartonRefusal('EMPTY_CARTON', { seq: parcel.seq }))
      const unscanned = inCarton.filter((line) => scannedOf(bench, line.id) < line.quantity)
      if (unscanned.length > 0) {
        const what = unscanned.map((line) => `${line.quantity - scannedOf(bench, line.id)} × ${line.workOrderSize.workOrder.style.code} ${line.workOrderSize.colourway.code} ${line.size}`).join(', ')
        refused({ code: 'NOT_SCANNED', message: `Carton ${parcel.seq} holds garments not scanned (${what}): scan them, or take them out of the carton.` })
      }

      const typeId = body.packagingTypeId ?? parcel.packagingTypeId ?? (await defaultCartonFor(tools.tx, current.companyId, inCarton[0]))
      if (!typeId) refused(cartonRefusal('PACKAGING_NEEDED'))
      const type = await tools.tx.packagingType.findUnique({ where: { id: typeId }, select: { id: true, companyId: true, kind: true, active: true, maxWeightKg: true, name: true } })
      if (!type || type.companyId !== current.companyId) throw new NotFoundError('Packaging type not found.')
      if (!isParcelPackaging(type.kind)) refused(cartonRefusal('PACKAGING_NOT_PARCEL'))
      if (!type.active && type.id !== parcel.packagingTypeId) refused(cartonRefusal('PACKAGING_OFF'))

      const count = bench.parcels.length
      const gross = body.grossWeightKg ?? parcel.grossWeightKg?.toFixed(4) ?? null
      const changes = {
        packagingTypeId: type.id,
        cartonNumber: parcel.seq,
        cartonCount: count,
        ...(body.grossWeightKg !== undefined ? { grossWeightKg: body.grossWeightKg } : {}),
      }
      const same = parcel.packagingTypeId === type.id && parcel.cartonNumber === parcel.seq && parcel.cartonCount === count && (body.grossWeightKg === undefined || body.grossWeightKg === parcel.grossWeightKg?.toFixed(4))
      // Marks printed for what the carton was stay true only when nothing they show moved.
      await tools.tx.parcel.update({ where: { id: parcel.id }, data: { ...changes, ...(same ? {} : { marksPrintedAt: null }), version: { increment: 1 } }, select: { id: true } })
      const renumberedIds = await renumberCartons(tools, current.id)
      tools.audit({
        action: 'shipping.closeCarton',
        recordType: 'Parcel',
        recordId: parcel.id,
        companyId: current.companyId,
        siteId: current.siteId,
        before: { packagingTypeId: parcel.packagingTypeId, cartonNumber: parcel.cartonNumber, cartonCount: parcel.cartonCount, grossWeightKg: parcel.grossWeightKg?.toFixed(4) ?? null },
        after: { ...changes, garments, renumbered: renumberedIds },
      })
      tools.emit({ type: 'shipping.carton_packed', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { shipmentId: current.id, number: current.number, parcelId: parcel.id, cartonNumber: parcel.seq, cartonCount: count, garments } })
      tools.emit({ type: 'shipment.packing_changed', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { shipmentId: current.id, number: current.number, status: current.status, change: 'parcels' } })
      return { closed: { parcelId: parcel.id, cartonNumber: parcel.seq, cartonCount: count, packagingTypeId: type.id, garments, warnings: overweight(gross, type.maxWeightKg?.toFixed(4) ?? null) ? ['OVERWEIGHT' as const] : [] } }
    },
  )
  // Close carton prints its marks (the bench's one tap); a carton closed without them says why, and prints them later.
  let marks: { printed: boolean; jobIds: string[]; problem: { code: string; message: string } | null } = { printed: false, jobIds: [], problem: null }
  if (body.print !== false) {
    try {
      const printed = await printMarks(callers, shipmentId, { parcelIds: [parcelId], ...(body.printerId ? { printerId: body.printerId } : {}), ...(body.copies ? { copies: body.copies } : {}) }, idempotencyKey ? `${idempotencyKey}.marks` : undefined)
      marks = { printed: true, jobIds: printed.jobs.map((job) => job.jobId), problem: null }
    } catch (error) {
      if (!(error instanceof DomainError)) throw error
      marks = { printed: false, jobIds: [], problem: { code: error.code, message: error.message } }
    }
  }
  const after = await caller.withClient((client) => readShipment(client, shipment.id))
  return { ...result, marks, bench: await caller.withClient((client) => benchView(client, after!)) }
}

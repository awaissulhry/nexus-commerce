import { ConflictError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { believedTime } from '@nexus/factory-domain/production/offstandard/rules'
import { cartonRefusal, cellsOfPiece, openCarton, takeInto, type CartonParcel } from '@nexus/factory-domain/shipping/cartons/rules'
import { MAX_PARCELS, nextParcelSeq } from '@nexus/factory-domain/shipping/shipments'
import { command, type CommandCaller } from '../../../core/command'
import { holdOnPacking } from '../../quality/holds/checks'
import { lockCells, tenantOf } from '../cells'
import { readShipment } from '../store'
import { actorIdOf, benchShipment, changeContents, moveGarment, pieceOf, refused, refuseIfHeld } from '../cartons/garments'
import { benchView, cartonLinesOf, cartonParcelsOf, readBench, renumberCartons } from '../cartons/store'

/**
 * Scan into the carton (B-W2b-384; LOG-007, LOG-003, LOG-010; design floor.pack "Scan into the carton"): each garment the
 * packer scans — its serial label, its SKU or barcode, or its batch label (with the colour and size chosen on the grid when
 * the batch has more than one left) — goes into the carton named, else the bench's open carton, else a new carton. It is
 * counted per size against the shipment's lines; a wrong style, colour or size, an extra piece, a garment not released, a
 * serial packed elsewhere, a held shipment are refused in words with their code (`refusal/<CODE>`, factory-domain
 * shipping/cartons/rules). A serial goes into its line and its carton with when (the tablet's time when believable) and
 * who (LOG-003: the serial traces back to its lots and operators and forward to its carton, shipment and customer).
 *
 * Office and floor (shipping.pack; a floor device at its own site), one command on the Shipment; the floor's offline queue
 * applies the same command (platform/floor-sync kind `shipping.carton.scan`, its key `<device>.<client event id>`).
 */

export interface ScanBody {
  readonly version?: number | undefined
  /** The serial, SKU, barcode or batch label as scanned. */
  readonly code: string
  /** The cell chosen on the size grid (a batch label names no size). */
  readonly cellId?: string | undefined
  /** The carton; default the bench's open carton, else a new one. */
  readonly parcelId?: string | undefined
  /** When the tablet scanned it (a queued scan). */
  readonly occurredAt?: string | undefined
}

export async function scanIntoCarton(caller: CommandCaller, shipmentId: string, body: ScanBody, idempotencyKey?: string) {
  const { shipment } = await benchShipment(caller, shipmentId)
  const { result } = await command(
    caller,
    { name: 'shipping.scanIntoCarton', idempotencyKey, input: { shipmentId, ...body }, record: { type: 'Shipment', id: shipment.id, expectedVersion: body.version } },
    async (tools) => {
      const current = (await readShipment(tools.tx, shipment.id))!
      if (current.status !== 'DRAFT') refused(cartonRefusal('NOT_DRAFT', { status: current.status }))
      await refuseIfHeld(tools.tx, current.id)
      const bench = await readBench(tools.tx, current.id)
      const lines = cartonLinesOf(bench)
      const parcels = cartonParcelsOf(bench)
      const seqOf = (parcelId: string) => parcels.find((parcel) => parcel.id === parcelId)?.seq ?? null

      const piece = await pieceOf(tools.tx, body.code, body.cellId ?? null, bench.lines)
      if (!piece) refused({ code: 'UNKNOWN_CODE', message: `Code ${body.code.trim()} is not a garment label of this factory: no serial, SKU, barcode or batch has it.` })
      const cells = cellsOfPiece(piece, lines, seqOf)
      if (!cells.ok) refused(cells.refusal)

      const serialLineId = piece.kind === 'SERIAL' && piece.onThisShipment ? piece.shipmentLineId : null
      // A serial whose garment is counted in its line's carton without it goes into that carton, open or closed (its
      // contents, and so its marks, stay as they are).
      const own = lines.find((line) => line.id === serialLineId)
      const countedIn = own && own.parcelId !== null && own.scanned > own.serialsInCarton ? (parcels.find((parcel) => parcel.id === own.parcelId) ?? null) : null
      let carton: CartonParcel | null
      if (countedIn && (body.parcelId === undefined || body.parcelId === countedIn.id)) {
        carton = countedIn
      } else if (body.parcelId !== undefined) {
        carton = parcels.find((parcel) => parcel.id === body.parcelId) ?? null
        if (!carton) throw new NotFoundError('Carton not found in this shipment.')
        if (carton.labelled) refused(cartonRefusal('CARTON_LABELLED', { seq: carton.seq }))
        if (carton.closed) refused(cartonRefusal('CARTON_CLOSED', { seq: carton.seq }))
      } else {
        carton = openCarton(parcels)
      }
      const cartonId = carton?.id ?? newId()
      const decided = takeInto(lines, cells.cellIds, parcels, cartonId, { serial: piece.kind === 'SERIAL', serialLineId })
      if (!decided.ok) refused(decided.refusal)
      const take = decided.take
      const sourceId = take.kind === 'MOVE' ? take.fromLineId : take.lineId
      const source = bench.lines.find((line) => line.id === sourceId)!

      // W2a B-W2a-26: goods on a quality hold are not packed (the hold's own words).
      const serialIds = piece.kind === 'SERIAL' ? [piece.serialId] : []
      const quality = await holdOnPacking(tools.tx, tools.context, { shipmentId: current.id, parcelIds: carton ? [carton.id] : [], workOrderIds: [source.workOrderId], serialIds })
      if (quality) refused({ code: 'QUALITY_HOLD', message: quality })
      await lockCells(tools.tx, tenantOf(tools.context), [source.workOrderSizeId])

      if (!carton) {
        const existing = await tools.tx.parcel.findMany({ where: { shipmentId: current.id }, select: { seq: true } })
        if (existing.length >= MAX_PARCELS) refused(cartonRefusal('TOO_MANY_CARTONS', { max: MAX_PARCELS }))
        await tools.tx.parcel.create({ data: { id: cartonId, siteId: current.siteId, partyId: current.partyId, shipmentId: current.id, seq: nextParcelSeq(existing), createdById: actorIdOf(tools) }, select: { id: true } })
      }

      // A serial on the line that gives up its garment leaves it first (its carton clears with it), then follows the garment.
      if (piece.kind === 'SERIAL' && serialLineId !== null && take.kind === 'MOVE' && !take.whole) {
        await tools.tx.garmentSerial.update({ where: { id: piece.serialId }, data: { shipmentLineId: null, version: { increment: 1 } }, select: { id: true } })
      }
      const holder =
        take.kind === 'MOVE'
          ? await moveGarment(tools, current, source, take.intoLineId ? bench.lines.find((line) => line.id === take.intoLineId)! : null, cartonId, take.whole)
          : { id: source.id, parcelId: cartonId, size: source.size }
      // An ATTACH only gives the serial its carton: the garment is counted there already.
      if (take.kind !== 'ATTACH') await changeContents(tools, current, { id: holder.id, parcelId: cartonId, size: holder.size }, 1)
      if (piece.kind === 'SERIAL') {
        const packedAt = believedTime(body.occurredAt ? new Date(body.occurredAt) : null, tools.now)
        await tools.tx.garmentSerial.update({ where: { id: piece.serialId }, data: { shipmentLineId: holder.id, parcelId: cartonId, packedAt, packedById: actorIdOf(tools), version: { increment: 1 } }, select: { id: true } })
      }
      // A new carton changes N: the closed cartons take the new count (their marks to print again).
      const renumberedIds = carton ? [] : await renumberCartons(tools, current.id)

      const after = (await readShipment(tools.tx, current.id))!
      const seq = carton?.seq ?? (await tools.tx.parcel.findUnique({ where: { id: cartonId }, select: { seq: true } }))?.seq
      if (seq === undefined) throw new ConflictError('The carton is gone.')
      tools.audit({
        action: 'shipping.scanIntoCarton',
        recordType: 'Shipment',
        recordId: current.id,
        companyId: current.companyId,
        siteId: current.siteId,
        after: { code: body.code.trim(), kind: piece.kind, cellId: source.workOrderSizeId, parcelId: cartonId, cartonSeq: seq, shipmentLineId: holder.id, serialId: piece.kind === 'SERIAL' ? piece.serialId : null, newCarton: carton === null, renumbered: renumberedIds },
      })
      tools.emit({ type: 'shipment.packing_changed', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { shipmentId: current.id, number: current.number, status: after.status, change: piece.kind === 'SERIAL' ? 'serials' : 'lines' } })
      return {
        scan: { kind: piece.kind, cellId: source.workOrderSizeId, parcelId: cartonId, cartonSeq: seq, shipmentLineId: holder.id, serialId: piece.kind === 'SERIAL' ? piece.serialId : null, newCarton: carton === null },
        bench: await benchView(tools.tx, after),
      }
    },
  )
  return result
}

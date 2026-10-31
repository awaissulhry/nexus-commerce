import type { PeriodLockOverride } from '@nexus/factory-domain/accounting/contracts'
import { InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { SHIPPING_MANAGE } from '@nexus/factory-domain/shipping/permissions'
import { carrierReturnNote, carrierReturnProblems, carrierReturnState } from '@nexus/factory-domain/shipping/shipments/stock'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { defaultPlaceOf, finishedItemFor, finishedPlaces, readSkus, skuKey, standardCostFor } from '../../inventory/finished/post'
import { postMoves, type MoveDraft } from '../../inventory/ledger/post-moves'
import { readShipment, type ShipmentHeader } from '../store'
import { officeShipment } from './shipments'
import { CARRIER_RETURN_KEY, shippedCells, type ShippedCell } from './stock'

/**
 * A shipment the carrier brought back, back into finished goods (B-W2b-19; the B-W2a-48 gap "a carrier-RETURNED
 * shipment's garments are not put back into finished goods"; factory-domain shipping/shipments/stock). Office only.
 *
 *   GET  /shipping/shipments/:shipmentId/carrier-return   shipping.view: where it stands (NOT_RETURNED, AWAITED once the
 *                                                          carrier's tracking says RETURNED, RECEIVED), its cells and
 *                                                          garments, the site's finished-goods places
 *   POST /shipping/shipments/:shipmentId/carrier-return   shipping.manage: the warehouse has the parcels back; ONE command
 *                                                          on the Shipment (its version bump locks the row): RETURNED and
 *                                                          not received yet (409 in words), a finished-goods place of its
 *                                                          site (400), then per cell ONE ADJUSTMENT INTO that place (the
 *                                                          SKU's FINISHED item, made when the SKU has none; the cell's work
 *                                                          order; reference the shipment's number; the note in words; key
 *                                                          `shipping.carrierReturn:<shipment id>:<n>`; valued at the item's
 *                                                          frozen standard, B-W2a-F7) through postMoves (a SOFT-locked month
 *                                                          takes `periodLockOverride`), the audit row and the event
 *
 * The status RETURNED itself comes from the carrier's tracking (labels/tracking.ts): the person confirms the garments
 * are back at the dock. The shipment's lines stay as they are (its history): see shipments/stock.ts for how the garments
 * then count in stock. B-W2b-F1: the same command writes Shipment.carrierReturnReceivedAt, so the shipment no longer
 * holds its garments against its cells' releases (cells.ts and the …_followups_f1_w2b_guards cap): the same cells ship
 * them again; and its SHIPPED serials go back to RELEASED, unpacked (the audit row names them), to be packed again.
 */

const RECEIVED_ACTION = 'shipping.carrierReturnReceived'

async function returnMovesOf(db: CommandTx, shipmentId: string) {
  return db.stockMove.findMany({
    where: { reason: 'ADJUSTMENT', idempotencyKey: { startsWith: `${CARRIER_RETURN_KEY}:${shipmentId}:` }, reversalOfId: null },
    select: { id: true, toLocationId: true, createdAt: true, createdById: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
}

/** Where a shipment's carrier return stands (also the answer of the write). */
export async function carrierReturnView(db: CommandTx, shipment: ShipmentHeader) {
  const cells = await shippedCells(db, shipment.id)
  const moves = await returnMovesOf(db, shipment.id)
  const places = await finishedPlaces(db, shipment.siteId)
  const garments = cells.reduce((sum, cell) => sum + cell.garments, 0)
  const received = moves.length > 0
  return {
    shipmentId: shipment.id,
    number: shipment.number,
    status: shipment.status,
    version: shipment.version,
    returnedAt: shipment.returnedAt ? toUtcIso(shipment.returnedAt) : null,
    state: carrierReturnState(shipment.status, received),
    garments,
    cells: cells.map((cell) => ({ cellId: cell.cellId, label: cell.label, garments: cell.garments })),
    receivedAt: received ? toUtcIso(moves[0]!.createdAt) : null,
    receivedById: received ? moves[0]!.createdById : null,
    locationId: received ? moves[0]!.toLocationId : null,
    moveIds: moves.map((move) => move.id),
    places: places.map((place) => ({ id: place.id, code: place.code, name: place.name })),
    defaultLocationId: defaultPlaceOf(places)?.id ?? null,
  }
}

/** GET /shipping/shipments/:shipmentId/carrier-return */
export async function getCarrierReturn(caller: CommandCaller, shipmentId: string) {
  const shipment = await officeShipment(caller, shipmentId)
  return { carrierReturn: await caller.withClient((client) => carrierReturnView(client, shipment)) }
}

export interface CarrierReturnBody {
  readonly version?: number | undefined
  /** A finished-goods place of the shipment's site; default its one finished-goods location. */
  readonly locationId?: string | undefined
  readonly note?: string | null | undefined
  readonly periodLockOverride?: PeriodLockOverride | undefined
}

/** The FINISHED item of each cell's SKU (made now when the SKU has none: a garment that left from the release). */
async function itemsFor(tools: CommandTools, cells: readonly ShippedCell[]): Promise<Map<string, string>> {
  const { tx } = tools
  const items = new Map<string, string>()
  for (const styleId of [...new Set(cells.map((cell) => cell.styleId))]) {
    const ofStyle = cells.filter((cell) => cell.styleId === styleId)
    const style = await tx.style.findUniqueOrThrow({ where: { id: styleId }, select: { code: true, name: true, companyId: true, garmentTracking: true } })
    const skus = await readSkus(tx, styleId, ofStyle)
    for (const [index, cell] of ofStyle.entries()) {
      const sku = skus.get(skuKey(cell.colourwayId, cell.size))
      if (!sku) throw new ValidationError(`${cell.label} has no SKU: generate the style's SKU matrix (Product › Styles) first.`, [{ path: `cells/${index}`, message: `Style ${style.code} has no SKU for ${cell.label}.` }])
      const colourway = await tx.colourway.findUnique({ where: { id: cell.colourwayId }, select: { name: true } })
      items.set(cell.cellId, await finishedItemFor(tools, sku, { styleName: style.name, colourwayName: colourway?.name ?? sku.sku, garmentTracking: style.garmentTracking, companyId: style.companyId }))
    }
  }
  return items
}

/** POST /shipping/shipments/:shipmentId/carrier-return: the garments back into finished goods (see the file's comment). */
export async function receiveCarrierReturn(caller: CommandCaller, shipmentId: string, body: CarrierReturnBody, idempotencyKey?: string) {
  const shipment = await officeShipment(caller, shipmentId, SHIPPING_MANAGE)
  const note = body.note?.trim() ? body.note.trim() : null
  const { result } = await command(
    caller,
    { name: RECEIVED_ACTION, idempotencyKey, input: { shipmentId, ...body }, record: { type: 'Shipment', id: shipment.id, expectedVersion: body.version } },
    async (tools) => {
      const { tx } = tools
      const current = await readShipment(tx, shipment.id)
      if (!current) throw new NotFoundError('Shipment not found.')
      const cells = await shippedCells(tx, current.id)
      const garments = cells.reduce((sum, cell) => sum + cell.garments, 0)
      const received = (await returnMovesOf(tx, current.id)).length > 0
      const problems = carrierReturnProblems({ number: current.number, status: current.status, received, garments })
      if (problems.length > 0) throw new InvalidStateError(problems.join(' '))

      const places = await finishedPlaces(tx, current.siteId)
      const siteCode = (await tx.site.findUnique({ where: { id: current.siteId }, select: { code: true } }))?.code ?? current.siteId
      if (places.length === 0) throw new InvalidStateError(`Site ${siteCode} has no finished-goods location: an administrator adds one (Warehouse › Locations) first.`)
      const place = body.locationId ? places.find((entry) => entry.id === body.locationId) : defaultPlaceOf(places)
      if (!place) {
        throw new ValidationError(
          body.locationId ? `Not a finished-goods place of site ${siteCode}.` : `Name the place: site ${siteCode} has several finished-goods locations.`,
          [{ path: 'body/locationId', message: body.locationId ? 'Expected a FINISHED_GOODS location of the site, or a place inside one, not archived.' : 'Required: the site has several finished-goods locations.' }],
        )
      }

      const items = await itemsFor(tools, cells)
      const day = businessDate(tools.now)
      const drafts: MoveDraft[] = []
      for (const cell of cells) {
        const itemId = items.get(cell.cellId)!
        const cost = await standardCostFor(tx, current.companyId, itemId, day)
        drafts.push({
          siteId: current.siteId,
          reason: 'ADJUSTMENT',
          itemId,
          itemColourId: null,
          lotId: null,
          hideId: null,
          fromLocationId: null,
          toLocationId: place.id,
          quantity: String(cell.garments),
          uom: 'PCS',
          workOrderId: cell.workOrderId,
          reference: current.number,
          note: carrierReturnNote(current.number, cell.label, note),
          ...(cost ? { cost } : {}),
        })
      }
      const moves = await postMoves(tools, drafts, { key: `${CARRIER_RETURN_KEY}:${current.id}`, issuePath: () => 'shipment', periodLockOverride: body.periodLockOverride })
      // B-W2b-F1: received back (first: the serial trigger reads it), then its serials released again, unpacked.
      await tx.shipment.update({ where: { id: current.id }, data: { carrierReturnReceivedAt: tools.now }, select: { id: true } })
      const serialIds = (await tx.garmentSerial.findMany({ where: { status: 'SHIPPED', shipmentLine: { shipmentId: current.id } }, select: { id: true }, orderBy: { id: 'asc' } })).map((serial) => serial.id)
      if (serialIds.length > 0) await tx.garmentSerial.updateMany({ where: { id: { in: serialIds } }, data: { status: 'RELEASED', shipmentLineId: null, version: { increment: 1 } } })
      tools.audit({
        action: RECEIVED_ACTION,
        recordType: 'Shipment',
        recordId: current.id,
        companyId: current.companyId,
        siteId: current.siteId,
        after: { locationId: place.id, garments, cells: cells.map((cell) => ({ cellId: cell.cellId, label: cell.label, garments: cell.garments })), moveIds: moves.map((move) => move.id), serialIds },
        ...(note ? { reason: note } : {}),
      })
      tools.emit({ type: 'shipment.carrier_return_received', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { shipmentId: current.id, number: current.number, garments, locationId: place.id } })
      return { carrierReturn: await carrierReturnView(tx, (await readShipment(tx, current.id))!), valued: moves.every((move) => move.valued) }
    },
  )
  return result
}

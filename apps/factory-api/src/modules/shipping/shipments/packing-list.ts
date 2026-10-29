import { InvalidStateError } from '@nexus/factory-domain/core/errors'
import { businessDate } from '@nexus/factory-domain/core/time'
import { isDocumentLanguage, type DocumentLanguage, type PostalAddress } from '@nexus/factory-domain/documents/model'
import { packingListDocument } from '@nexus/factory-domain/shipping/packing-list'
import { SHIPPING_PACK } from '@nexus/factory-domain/shipping/permissions'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { storeDocumentPdf, type StoredDocument } from '../../../platform/documents/documents'
import type { FilesRuntime } from '../../../platform/files/service'
import { readContents } from '../store'
import { officeShipment } from './shipments'

/**
 * A shipment's packing list (B-W1-46; LOG-039; A2 SCR-067): the PACKING_LIST document (factory-domain documents and
 * shipping/packing-list) with the company's legal data from its Company row, stored as a file of the shipment through
 * platform/documents (kind DOCUMENT; shared with the floor of the shipment's site, which prints it at the packing
 * station). Office only (shipping.pack): the floor cannot store a file. Every garment must be in a parcel.
 */
export async function packingList(files: FilesRuntime, caller: CommandCaller, shipmentId: string, body: { language?: DocumentLanguage | undefined }, idempotencyKey?: string): Promise<StoredDocument> {
  const shipment = await officeShipment(caller, shipmentId, SHIPPING_PACK)
  const facts = await caller.withClient(async (client) => {
    const [contents, order, party, company] = await Promise.all([
      readContents(client, shipment.id),
      client.salesOrder.findUnique({ where: { id: shipment.salesOrderId }, select: { number: true, customerRef: true, language: true } }),
      client.party.findUnique({ where: { id: shipment.partyId }, select: { legalName: true } }),
      client.company.findUnique({ where: { id: shipment.companyId }, select: { currency: true } }),
    ])
    return { contents, order, party, company }
  })
  const { contents, order, party, company } = facts
  if (contents.lines.length === 0) throw new InvalidStateError('The shipment has no lines yet; a packing list lists packed garments.')
  const unpacked = contents.lines.filter((line) => line.parcelId === null).reduce((garments, line) => garments + line.quantity, 0)
  if (unpacked > 0) throw new InvalidStateError(`A packing list says which parcel each garment is in: ${unpacked} garment(s) are not in a parcel yet.`)
  const language: DocumentLanguage = body.language ?? (isDocumentLanguage(order?.language) ? order.language : 'it')
  const shipTo = shipment.shipTo as (PostalAddress & { name?: string | null }) | null
  const document = packingListDocument({
    number: shipment.number,
    date: businessDate(serverClock.now()),
    language,
    currency: company?.currency ?? 'EUR',
    party: { name: party?.legalName ?? '', address: null },
    shipTo: shipTo && typeof shipTo === 'object' && typeof shipTo.line1 === 'string' ? shipTo : null,
    salesOrderNumber: order?.number ?? '',
    customerRef: order?.customerRef ?? null,
    parcels: contents.parcels.map((parcel) => ({ id: parcel.id, seq: parcel.seq, grossWeightKg: parcel.grossWeightKg === null ? null : parcel.grossWeightKg.toFixed(4) })),
    lines: contents.lines.map((line) => ({
      parcelId: line.parcelId!,
      styleCode: line.workOrderSize.workOrder.style.code,
      styleName: line.workOrderSize.workOrder.style.name,
      colourway: line.workOrderSize.colourway.name,
      size: line.size,
      quantity: line.quantity,
      batchNumber: line.workOrderSize.workOrder.batchNumber,
      serials: line.serials.map((serial) => serial.serial),
    })),
  })
  return storeDocumentPdf(files, caller, {
    companyId: shipment.companyId,
    recordType: 'Shipment',
    recordId: shipment.id,
    document,
    visibility: ['FLOOR'],
    floorSiteId: shipment.siteId,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  })
}

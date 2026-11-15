import { DomainError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import {
  collectionProblems,
  collectionRefusalPath,
  collectorOf,
  incotermFit,
  leaveRefusal,
  missingParts,
  plateOf,
  recordRefusal,
  type CollectionFacts,
  type CollectionRefusalCode,
} from '@nexus/factory-domain/shipping/collection/rules'
import { SHIPPING_MANAGE, SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import type { ShipmentStatus, TransportBy } from '@nexus/factory-domain/shipping/shipments'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { presignedView, storeCall } from '../../../platform/files/files'
import { attachmentDisposition, DOWNLOAD_URL_SECONDS } from '../../../platform/files/rules'
import type { FilesRuntime } from '../../../platform/files/service'
import { liveDdtOf } from '../ddt/store'
import { officeShipment } from '../shipments/shipments'
import type { ShipmentHeader } from '../store'

/**
 * The customer's own carrier collects (B-W2b-395; LOG-053; rules factory-domain shipping/collection; factory-db
 * Shipment.collectedByName, vehiclePlate, collectionSignatureFileId and their guard). Office only:
 *
 *   GET  …/collection             shipping.view: whether the customer collects, the order's Incoterms rule and whether it
 *                                 fits, who collected, the plate, the signed DDT (its file), what is still missing, the
 *                                 live DDT, what may change now (each refusal in words)
 *   PUT  …/collection             shipping.manage, one command on the Shipment (its version), while it waits PACKED: who
 *                                 collected, the plate (kept in capitals), the signed DDT (a file of the shipment, uploaded
 *                                 first through the files routes); a field left out stays, null clears it
 *   GET  …/collection/signature   shipping.view: the signed DDT, a presigned GET of 60 seconds
 *   leaving                       W1's leaving command calls assertCollectedInCommand (shipments/leave.ts): a shipment the
 *                                 customer collects leaves only with all three (409 refusal/INCOMPLETE in words)
 *   delivered                     its collection IS its delivery (EXW / FCA at our premises): the worker moves it DELIVERED at
 *                                 the time it left, once it left (delivered.ts)
 *
 * The driver's name is the customer's carrier's person, read in this one shipment only.
 */

const COLLECTION_SELECT = { collectedByName: true, vehiclePlate: true, collectionSignatureFileId: true, salesOrderId: true, partyId: true } as const

const refused = (code: CollectionRefusalCode, message: string): never => {
  throw new DomainError('conflict', message, [{ path: collectionRefusalPath(code), message }])
}

async function factsOf(db: CommandTx, shipment: Pick<ShipmentHeader, 'id' | 'status' | 'transportBy'>): Promise<CollectionFacts & { readonly salesOrderId: string; readonly partyId: string }> {
  const row = await db.shipment.findUniqueOrThrow({ where: { id: shipment.id }, select: COLLECTION_SELECT })
  return {
    status: shipment.status as ShipmentStatus,
    transportBy: shipment.transportBy as TransportBy,
    collectedByName: row.collectedByName,
    vehiclePlate: row.vehiclePlate,
    signatureFileId: row.collectionSignatureFileId,
    salesOrderId: row.salesOrderId,
    partyId: row.partyId,
  }
}

const allowance = (refusal: { code: CollectionRefusalCode; message: string } | null) => ({ allowed: refusal === null, refusal })

async function collectionView(db: CommandTx, shipment: ShipmentHeader) {
  const facts = await factsOf(db, shipment)
  const order = await db.salesOrder.findUnique({ where: { id: facts.salesOrderId }, select: { incoterm: true, incotermPlace: true } })
  const party = order?.incoterm ? null : await db.party.findUnique({ where: { id: facts.partyId }, select: { incoterm: true } })
  const incoterm = order?.incoterm ?? party?.incoterm ?? null
  const file = facts.signatureFileId ? await db.storedFile.findUnique({ where: { id: facts.signatureFileId }, select: { id: true, originalName: true, contentType: true, sizeBytes: true } }) : null
  const ddt = await liveDdtOf(db, shipment.id)
  const applies = facts.transportBy === 'RECIPIENT'
  return {
    shipment: { id: shipment.id, number: shipment.number, status: shipment.status, version: shipment.version, transportBy: shipment.transportBy, shippedAt: shipment.shippedAt ? toUtcIso(shipment.shippedAt) : null, deliveredAt: shipment.deliveredAt ? toUtcIso(shipment.deliveredAt) : null },
    /** The customer's own carrier collects (transportBy RECIPIENT). */
    applies,
    incoterm: { code: incoterm, place: order?.incoterm ? (order.incotermPlace ?? null) : null, from: order?.incoterm ? ('ORDER' as const) : incoterm ? ('CUSTOMER' as const) : null, ...incotermFit(incoterm) },
    collectedByName: facts.collectedByName,
    vehiclePlate: facts.vehiclePlate,
    signature: file ? { id: file.id, name: file.originalName, contentType: file.contentType, sizeBytes: Number(file.sizeBytes) } : null,
    missing: applies ? missingParts(facts) : [],
    ddt,
    may: { record: allowance(recordRefusal(facts)), leave: allowance(applies ? leaveRefusal(facts) : null) },
  }
}

/** GET …/collection. */
export async function getCollection(caller: CommandCaller, shipmentId: string) {
  const shipment = await officeShipment(caller, shipmentId)
  return caller.withClient((client) => collectionView(client, shipment))
}

export interface CollectionBody {
  readonly version?: number | undefined
  readonly collectedByName?: string | null | undefined
  readonly vehiclePlate?: string | null | undefined
  readonly signatureFileId?: string | null | undefined
}

/** PUT …/collection (see the file's comment). */
export async function recordCollection(caller: CommandCaller, shipmentId: string, body: CollectionBody, idempotencyKey?: string) {
  const shipment = await officeShipment(caller, shipmentId, SHIPPING_MANAGE)
  const problems: Issue[] = collectionProblems(body)
  const read = await caller.withClient(async (db) => {
    const facts = await factsOf(db, shipment)
    const file = typeof body.signatureFileId === 'string' && isUuid(body.signatureFileId) ? await db.storedFile.findUnique({ where: { id: body.signatureFileId }, select: { id: true, recordType: true, recordId: true, companyId: true, status: true } }) : null
    return { facts, file }
  })
  if (typeof body.signatureFileId === 'string' && (!read.file || read.file.recordType !== 'Shipment' || read.file.recordId !== shipment.id || read.file.companyId !== shipment.companyId || read.file.status !== 'AVAILABLE')) {
    problems.push({ path: 'body/signatureFileId', message: 'The signed DDT must be an available file of this shipment: upload it on the shipment first.' })
  }
  const state = recordRefusal(read.facts)
  if (state) refused(state.code, state.message)
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The collection is not valid.', problems)
  const data: { collectedByName?: string | null; vehiclePlate?: string | null; collectionSignatureFileId?: string | null } = {}
  if (body.collectedByName !== undefined) data.collectedByName = body.collectedByName === null ? null : collectorOf(body.collectedByName)
  if (body.vehiclePlate !== undefined) data.vehiclePlate = body.vehiclePlate === null ? null : plateOf(body.vehiclePlate)
  if (body.signatureFileId !== undefined) data.collectionSignatureFileId = body.signatureFileId
  await command(caller, { name: 'shipping.recordCollection', idempotencyKey, input: { shipmentId, ...body }, record: { type: 'Shipment', id: shipment.id, expectedVersion: body.version } }, async (tools) => {
    const current = await tools.tx.shipment.findUniqueOrThrow({ where: { id: shipment.id }, select: { status: true, transportBy: true, number: true, companyId: true, siteId: true, ...COLLECTION_SELECT } })
    const again = recordRefusal({ status: current.status as ShipmentStatus, transportBy: current.transportBy as TransportBy })
    if (again) refused(again.code, again.message)
    await tools.tx.shipment.update({ where: { id: shipment.id }, data, select: { id: true } })
    tools.audit({
      action: 'shipping.recordCollection',
      recordType: 'Shipment',
      recordId: shipment.id,
      companyId: current.companyId,
      siteId: current.siteId,
      before: { collectedByName: current.collectedByName !== null, vehiclePlate: current.vehiclePlate, signatureFileId: current.collectionSignatureFileId },
      after: { collectedByName: (data.collectedByName === undefined ? current.collectedByName : data.collectedByName) !== null, vehiclePlate: data.vehiclePlate === undefined ? current.vehiclePlate : data.vehiclePlate, signatureFileId: data.collectionSignatureFileId === undefined ? current.collectionSignatureFileId : data.collectionSignatureFileId },
    })
    tools.emit({ type: 'shipment.packing_changed', subject: shipment.id, companyId: current.companyId, siteId: current.siteId, payload: { shipmentId: shipment.id, number: current.number, status: current.status, change: 'details' } })
    return { shipmentId: shipment.id }
  })
  return getCollection(caller, shipment.id)
}

/** GET …/collection/signature: the signed DDT, presigned for 60 seconds. */
export async function downloadCollectionSignature(files: FilesRuntime, caller: CommandCaller, shipmentId: string) {
  const header = await officeShipment(caller, shipmentId, SHIPPING_VIEW)
  const file = await caller.withClient(async (db) => {
    const shipment = await db.shipment.findUniqueOrThrow({ where: { id: header.id }, select: { collectionSignatureFileId: true } })
    return shipment.collectionSignatureFileId ? db.storedFile.findUnique({ where: { id: shipment.collectionSignatureFileId }, select: { id: true, status: true, storeAccountId: true, storageKey: true, contentType: true, originalName: true } }) : null
  })
  if (!file || file.status !== 'AVAILABLE') throw new NotFoundError('The shipment has no signed DDT of its collection.')
  const download = await storeCall(() =>
    files.storage.presignDownload(caller, file.storeAccountId, { key: file.storageKey, contentType: file.contentType, disposition: attachmentDisposition(file.originalName), expiresInSeconds: DOWNLOAD_URL_SECONDS, now: files.clock.now() }),
  )
  return { fileId: file.id, name: file.originalName, download: presignedView(download) }
}

/**
 * Inside W1's leaving command (shipments/leave.ts whenShipped, after the goods left): a shipment the customer collects leaves
 * only with who collected, the plate and the signed DDT (409 refusal/INCOMPLETE in words: the whole command rolls back). Its
 * delivery at that moment follows by the worker (delivered.ts). Any other shipment: nothing.
 */
export async function assertCollectedInCommand(tools: Pick<CommandTools, 'tx'>, shipment: Pick<ShipmentHeader, 'id' | 'transportBy'>): Promise<void> {
  if (shipment.transportBy !== 'RECIPIENT') return
  const row = await tools.tx.shipment.findUniqueOrThrow({ where: { id: shipment.id }, select: { status: true, ...COLLECTION_SELECT } })
  const refusal = leaveRefusal({ status: row.status as ShipmentStatus, transportBy: 'RECIPIENT', collectedByName: row.collectedByName, vehiclePlate: row.vehiclePlate, signatureFileId: row.collectionSignatureFileId })
  if (refusal) refused(refusal.code, refusal.message)
}

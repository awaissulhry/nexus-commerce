import { createHash } from 'node:crypto'
import { InvalidStateError } from '@nexus/factory-domain/core/errors'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { isDocumentLanguage, type DocumentLanguage, type PostalAddress } from '@nexus/factory-domain/documents/model'
import { packingListDocument } from '@nexus/factory-domain/shipping/packing-list'
import { contentsKey, nextPackingList, packingListNumber, packingListProblems, type PackingListVersion } from '@nexus/factory-domain/shipping/packing/versions'
import { SHIPPING_PACK } from '@nexus/factory-domain/shipping/permissions'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { storeDocumentPdf, type StoredDocument } from '../../../platform/documents/documents'
import { getFile } from '../../../platform/files/files'
import type { FilesRuntime } from '../../../platform/files/service'
import { readContents } from '../store'
import { officeShipment } from './shipments'

/**
 * A shipment's packing list (B-W1-46; LOG-039; A2 SCR-067): the PACKING_LIST document (factory-domain documents and
 * shipping/packing-list) with the company's legal data from its Company row, stored as a file of the shipment through
 * platform/documents (kind DOCUMENT; shared with the floor of the shipment's site, which prints it at the packing
 * station). Office only (shipping.pack): the floor cannot store a file. Every garment must be in a parcel.
 *
 * B-W2a-48 (LOG-012; design "Other documents: packing list … generated documents with versions"): a version per
 * packing (factory-domain shipping/packing/versions): the same contents and language answer the stored file again; new
 * contents make version n + 1, numbered `<shipment>/<n>` from 2 on. Each version is recorded by an audit row of the
 * shipment (`shipping.packingListVersion`: file, version, language, the contents' fingerprint, parcels, garments), so
 * `GET …/packing-lists` lists them and says which one matches the shipment now. Not for a CANCELLED shipment.
 */

const VERSION_ACTION = 'shipping.packingListVersion'

type Contents = Awaited<ReturnType<typeof readContents>>

const fingerprintOf = (contents: Contents): string =>
  createHash('sha256')
    .update(
      contentsKey({
        parcels: contents.parcels.map((parcel) => ({
          id: parcel.id,
          seq: parcel.seq,
          grossWeightKg: parcel.grossWeightKg?.toFixed(4) ?? null,
          lengthCm: parcel.lengthCm?.toFixed(2) ?? null,
          widthCm: parcel.widthCm?.toFixed(2) ?? null,
          heightCm: parcel.heightCm?.toFixed(2) ?? null,
        })),
        lines: contents.lines.map((line) => ({ parcelId: line.parcelId, workOrderSizeId: line.workOrderSizeId, quantity: line.quantity, serials: line.serials.map((serial) => serial.serial) })),
      }),
    )
    .digest('hex')

interface VersionRow extends PackingListVersion {
  readonly number: string
  readonly layout: string
  readonly parcels: number
  readonly garments: number
  readonly at: Date
}

/** The packing list versions recorded for a shipment, oldest first. */
async function versionsOf(db: CommandTx, shipmentId: string): Promise<VersionRow[]> {
  const rows = await db.auditLog.findMany({ where: { recordType: 'Shipment', recordId: shipmentId, action: VERSION_ACTION }, select: { at: true, after: true }, orderBy: [{ at: 'asc' }, { id: 'asc' }] })
  return rows.flatMap((row) => {
    const after = row.after as { fileId?: unknown; version?: unknown; fingerprint?: unknown; language?: unknown; number?: unknown; layout?: unknown; parcels?: unknown; garments?: unknown } | null
    if (typeof after?.fileId !== 'string' || typeof after.version !== 'number' || typeof after.fingerprint !== 'string' || !isDocumentLanguage(after.language)) return []
    return [{ fileId: after.fileId, version: after.version, fingerprint: after.fingerprint, language: after.language, number: typeof after.number === 'string' ? after.number : '', layout: typeof after.layout === 'string' ? after.layout : 'PACKING_LIST/1', parcels: typeof after.parcels === 'number' ? after.parcels : 0, garments: typeof after.garments === 'number' ? after.garments : 0, at: row.at }]
  })
}

export async function packingList(
  files: FilesRuntime,
  caller: CommandCaller,
  shipmentId: string,
  body: { language?: DocumentLanguage | undefined },
  idempotencyKey?: string,
): Promise<StoredDocument & { version: number; number: string; reused: boolean }> {
  const shipment = await officeShipment(caller, shipmentId, SHIPPING_PACK)
  // One query after another (B-W2a-48): a scoped client's transaction has one connection.
  const facts = await caller.withClient(async (client) => {
    const contents = await readContents(client, shipment.id)
    const order = await client.salesOrder.findUnique({ where: { id: shipment.salesOrderId }, select: { number: true, customerRef: true, language: true } })
    const party = await client.party.findUnique({ where: { id: shipment.partyId }, select: { legalName: true } })
    const company = await client.company.findUnique({ where: { id: shipment.companyId }, select: { currency: true } })
    const versions = await versionsOf(client, shipment.id)
    return { contents, order, party, company, versions }
  })
  const { contents, order, party, company, versions } = facts
  const unpacked = contents.lines.filter((line) => line.parcelId === null).reduce((garments, line) => garments + line.quantity, 0)
  const problems = packingListProblems(shipment.status, contents.lines.length, unpacked)
  if (problems.length > 0) throw new InvalidStateError(problems.join(' '))
  const language: DocumentLanguage = body.language ?? (isDocumentLanguage(order?.language) ? order.language : 'it')
  const fingerprint = fingerprintOf(contents)
  const next = nextPackingList(versions, fingerprint, language)
  const number = packingListNumber(shipment.number, next.version)
  if (next.reuse) {
    const file = await getFile(caller, next.reuse.fileId).catch(() => null)
    if (file && file.status === 'AVAILABLE') return { file, layout: next.reuse.layout, version: next.version, number, reused: true }
  }
  const shipTo = shipment.shipTo as (PostalAddress & { name?: string | null }) | null
  const document = packingListDocument({
    number,
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
  const stored = await storeDocumentPdf(files, caller, {
    companyId: shipment.companyId,
    recordType: 'Shipment',
    recordId: shipment.id,
    document,
    visibility: ['FLOOR'],
    floorSiteId: shipment.siteId,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  })
  const garments = contents.lines.reduce((sum, line) => sum + line.quantity, 0)
  await command(caller, { name: VERSION_ACTION, ...(idempotencyKey ? { idempotencyKey: `${idempotencyKey}:version` } : {}), input: { shipmentId, fileId: stored.file.id, version: next.version, language } }, async (tools) => {
    const known = await tools.tx.auditLog.findFirst({ where: { recordType: 'Shipment', recordId: shipment.id, action: VERSION_ACTION, after: { path: ['fileId'], equals: stored.file.id } }, select: { id: true } })
    tools.audit({
      action: known ? 'shipping.packingListAgain' : VERSION_ACTION,
      recordType: 'Shipment',
      recordId: shipment.id,
      companyId: shipment.companyId,
      siteId: shipment.siteId,
      after: { fileId: stored.file.id, version: next.version, number, language, layout: stored.layout, fingerprint, parcels: contents.parcels.length, garments, shipmentVersion: shipment.version },
    })
    return { version: next.version }
  })
  return { ...stored, version: next.version, number, reused: false }
}

/** GET /shipping/shipments/:shipmentId/packing-lists: every version, newest first, and which one matches the shipment now. */
export async function packingLists(caller: CommandCaller, shipmentId: string) {
  const shipment = await officeShipment(caller, shipmentId)
  return caller.withClient(async (client) => {
    const versions = await versionsOf(client, shipment.id)
    const contents = await readContents(client, shipment.id)
    const now = fingerprintOf(contents)
    const stored = versions.length > 0 ? await client.storedFile.findMany({ where: { id: { in: versions.map((entry) => entry.fileId) }, status: 'AVAILABLE' }, select: { id: true } }) : []
    const alive = new Set(stored.map((file) => file.id))
    return {
      shipmentId: shipment.id,
      number: shipment.number,
      packingLists: versions
        .filter((entry) => alive.has(entry.fileId))
        .reverse()
        .map((entry) => ({ fileId: entry.fileId, version: entry.version, number: entry.number, language: entry.language, current: entry.fingerprint === now && shipment.status !== 'CANCELLED', parcels: entry.parcels, garments: entry.garments, createdAt: toUtcIso(entry.at) })),
    }
  })
}

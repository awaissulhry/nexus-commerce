import { createHash } from 'node:crypto'
import { InvalidStateError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { isDocumentLanguage, type DocumentLanguage, type PostalAddress } from '@nexus/factory-domain/documents/model'
import { packingListDocument } from '@nexus/factory-domain/shipping/packing-list'
import { contentsKey, currentPackingList, nextPackingList, packingListNumber, packingListProblems, type PackingListVersion } from '@nexus/factory-domain/shipping/packing/versions'
import { SHIPPING_PACK } from '@nexus/factory-domain/shipping/permissions'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { storeDocumentPdf, type StoredDocument } from '../../../platform/documents/documents'
import { getFile } from '../../../platform/files/files'
import type { FilesRuntime } from '../../../platform/files/service'
import { tenantOf } from '../cells'
import { readContents } from '../store'
import { officeShipment } from './shipments'

/**
 * A shipment's packing list (B-W1-46; LOG-039; A2 SCR-067): the PACKING_LIST document (factory-domain documents and
 * shipping/packing-list) with the company's legal data from its Company row, stored as a file of the shipment through
 * platform/documents (kind DOCUMENT; shared with the floor of the shipment's site, which prints it at the packing
 * station). Office only (shipping.pack): the floor cannot store a file. Every garment must be in a parcel.
 *
 * B-W2a-48 (LOG-012; design "Other documents: packing list … generated documents with versions"): a version per
 * packing (factory-domain shipping/packing/versions), numbered `<shipment>/<n>` from 2 on. Not for a CANCELLED shipment.
 *
 * W2b (B-W2b-19): each version is a GeneratedDocument row (kind PACKING_LIST, recordType Shipment: version, the
 * contents' fingerprint, language, layout, the printed number, the file), append-only, so the NEWEST row is the current
 * packing list: the newest version's contents and language answer its file again (no row); contents back to an older
 * version's make a new row with that version's file (`reused`); anything else a new file and row. The rows' versions are
 * counted under one transaction lock per shipment (`factory.packing-list`), so two prints never take one version. Its
 * parcels and garments are kept in the version's audit row (`shipping.packingListVersion`; no column holds them).
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
  readonly id: string
  readonly number: string
  readonly layout: string
  readonly at: Date
}

/** The packing list versions of a shipment (its GeneratedDocument rows), oldest first. */
async function versionsOf(db: CommandTx, shipmentId: string): Promise<VersionRow[]> {
  const rows = await db.generatedDocument.findMany({
    where: { recordType: 'Shipment', recordId: shipmentId, kind: 'PACKING_LIST' },
    select: { id: true, version: true, fingerprint: true, language: true, layout: true, number: true, fileId: true, createdAt: true },
    orderBy: { version: 'asc' },
  })
  return rows.flatMap((row) =>
    isDocumentLanguage(row.language) ? [{ id: row.id, fileId: row.fileId, version: row.version, fingerprint: row.fingerprint, language: row.language, number: row.number ?? '', layout: row.layout ?? 'PACKING_LIST/1', at: row.createdAt }] : [],
  )
}

/** Each version's parcels and garments, from its audit row (by the GeneratedDocument's id). */
async function countsOf(db: CommandTx, shipmentId: string): Promise<Map<string, { parcels: number; garments: number }>> {
  const rows = await db.auditLog.findMany({ where: { recordType: 'Shipment', recordId: shipmentId, action: VERSION_ACTION }, select: { after: true } })
  const counts = new Map<string, { parcels: number; garments: number }>()
  for (const row of rows) {
    const after = row.after as { documentId?: unknown; parcels?: unknown; garments?: unknown } | null
    if (typeof after?.documentId === 'string') counts.set(after.documentId, { parcels: typeof after.parcels === 'number' ? after.parcels : 0, garments: typeof after.garments === 'number' ? after.garments : 0 })
  }
  return counts
}

/**
 * The file of the shipment's current packing list for the packers and the documents' read: the newest version's
 * (available), else the newest packing list file of the shipment (one printed before W2b recorded versions as rows).
 */
export async function currentPackingListFile(db: CommandTx, shipmentId: string): Promise<{ readonly id: string; readonly printedAt: Date } | null> {
  const newest = await db.generatedDocument.findFirst({ where: { recordType: 'Shipment', recordId: shipmentId, kind: 'PACKING_LIST' }, select: { fileId: true, createdAt: true }, orderBy: { version: 'desc' } })
  if (newest) {
    const file = await db.storedFile.findFirst({ where: { id: newest.fileId, status: 'AVAILABLE' }, select: { id: true } })
    if (file) return { id: file.id, printedAt: newest.createdAt }
  }
  const older = await db.storedFile.findFirst({
    where: { recordType: 'Shipment', recordId: shipmentId, kind: 'DOCUMENT', status: 'AVAILABLE', contentType: 'application/pdf', visibility: { has: 'FLOOR' } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, createdAt: true },
  })
  return older ? { id: older.id, printedAt: older.createdAt } : null
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
  if (next.again) {
    const file = await getFile(caller, next.again.fileId).catch(() => null)
    if (file && file.status === 'AVAILABLE') return { file, layout: next.again.layout, version: next.again.version, number: next.again.number, reused: true }
  }
  // An older version's file printed again as the new version (its number as printed), else a new file.
  const reusedFile = next.reuse ? await getFile(caller, next.reuse.fileId).catch(() => null) : null
  const reuse = next.reuse && reusedFile && reusedFile.status === 'AVAILABLE' ? { file: reusedFile, layout: next.reuse.layout, number: next.reuse.number } : null
  const number = reuse?.number ?? packingListNumber(shipment.number, next.version)
  const stored: StoredDocument = reuse
    ? { file: reuse.file, layout: reuse.layout }
    : await storeDocumentPdf(files, caller, {
        companyId: shipment.companyId,
        recordType: 'Shipment',
        recordId: shipment.id,
        document: packingDocumentOf(shipment, contents, { number, language, currency: company?.currency ?? 'EUR', partyName: party?.legalName ?? '', order }),
        visibility: ['FLOOR'],
        floorSiteId: shipment.siteId,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      })
  const garments = contents.lines.reduce((sum, line) => sum + line.quantity, 0)
  const { result } = await command(caller, { name: VERSION_ACTION, ...(idempotencyKey ? { idempotencyKey: `${idempotencyKey}:version` } : {}), input: { shipmentId, fileId: stored.file.id, version: next.version, language } }, async (tools) => {
    const { tx } = tools
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.packing-list', ${tenantOf(tools.context)}::uuid, ${shipment.id}::uuid), 0))`
    // Under the lock: another print may have recorded a version meanwhile.
    const now = await versionsOf(tx, shipment.id)
    const newest = now[now.length - 1]
    if (newest && newest.fingerprint === fingerprint && newest.language === language && newest.fileId === stored.file.id) return { version: newest.version, number: newest.number }
    const version = (newest?.version ?? 0) + 1
    const documentId = newId()
    await tx.generatedDocument.create({
      data: {
        id: documentId,
        companyId: shipment.companyId,
        siteId: shipment.siteId,
        recordType: 'Shipment',
        recordId: shipment.id,
        kind: 'PACKING_LIST',
        version,
        fingerprint,
        language,
        layout: stored.layout,
        number,
        fileId: stored.file.id,
        createdById: tools.context.audience === 'office' ? tools.context.actorId : null,
      },
      select: { id: true },
    })
    tools.audit({
      action: VERSION_ACTION,
      recordType: 'Shipment',
      recordId: shipment.id,
      companyId: shipment.companyId,
      siteId: shipment.siteId,
      after: { documentId, fileId: stored.file.id, version, number, language, layout: stored.layout, fingerprint, reused: reuse !== null, parcels: contents.parcels.length, garments, shipmentVersion: shipment.version },
    })
    return { version, number }
  })
  return { ...stored, version: result.version, number: result.number, reused: reuse !== null }
}

/** The packing list document of the shipment's contents now. */
function packingDocumentOf(
  shipment: Awaited<ReturnType<typeof officeShipment>>,
  contents: Contents,
  facts: { number: string; language: DocumentLanguage; currency: string; partyName: string; order: { number: string; customerRef: string | null } | null },
) {
  const shipTo = shipment.shipTo as (PostalAddress & { name?: string | null }) | null
  return packingListDocument({
    number: facts.number,
    date: businessDate(serverClock.now()),
    language: facts.language,
    currency: facts.currency,
    party: { name: facts.partyName, address: null },
    shipTo: shipTo && typeof shipTo === 'object' && typeof shipTo.line1 === 'string' ? shipTo : null,
    salesOrderNumber: facts.order?.number ?? '',
    customerRef: facts.order?.customerRef ?? null,
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
}

/** GET /shipping/shipments/:shipmentId/packing-lists: every version, newest first; the newest is current while it matches. */
export async function packingLists(caller: CommandCaller, shipmentId: string) {
  const shipment = await officeShipment(caller, shipmentId)
  return caller.withClient(async (client) => {
    const versions = await versionsOf(client, shipment.id)
    const counts = await countsOf(client, shipment.id)
    const contents = await readContents(client, shipment.id)
    const current = currentPackingList(versions, fingerprintOf(contents), shipment.status)
    const stored = versions.length > 0 ? await client.storedFile.findMany({ where: { id: { in: versions.map((entry) => entry.fileId) }, status: 'AVAILABLE' }, select: { id: true } }) : []
    const alive = new Set(stored.map((file) => file.id))
    return {
      shipmentId: shipment.id,
      number: shipment.number,
      packingLists: versions
        .filter((entry) => alive.has(entry.fileId))
        .reverse()
        .map((entry) => ({
          fileId: entry.fileId,
          version: entry.version,
          number: entry.number,
          language: entry.language,
          current: current?.id === entry.id,
          parcels: counts.get(entry.id)?.parcels ?? 0,
          garments: counts.get(entry.id)?.garments ?? 0,
          createdAt: toUtcIso(entry.at),
        })),
    }
  })
}

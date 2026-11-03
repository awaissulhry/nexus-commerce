import type { FastifyRequest } from 'fastify'
import { DomainError, ForbiddenError, InvalidStateError, type Issue } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { legalProblems } from '@nexus/factory-domain/documents/legal'
import { QUALITY_INSPECTIONS_VIEW } from '@nexus/factory-domain/quality/final/permissions'
import { QUALITY_DOCUMENTS_MAKE, QUALITY_DOCUMENTS_SHARE } from '@nexus/factory-domain/quality/inspection-docs/permissions'
import { SHIPPING_MANAGE, SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { companyLegalOf } from '../../../platform/documents/documents'
import type { EmailRuntime } from '../../../platform/email-out/service'
import { prepareFileCopy, recordGeneratedFile } from '../../../platform/files/files'
import type { FilesRuntime } from '../../../platform/files/service'
import { mayOn as shipmentMay, officeContextOf } from '../../shipping/access'
import { tenantOf } from '../../shipping/cells'
import { attachStateProblem } from '../../shipping/documents/attach'
import { sendFromOffice } from '../../shipping/documents/office'
import { lockShipmentDocuments } from '../../shipping/documents/read'
import { officeShipment } from '../../shipping/shipments/shipments'
import { readShipment, type ShipmentHeader } from '../../shipping/store'
import { namesOf } from '../amendments/records'
import { mayOn as inspectionMay } from '../final/access'
import { inspectionFor } from '../final/inspections'
import type { Reader } from '../final/store'
import { certificateFacts, certificateRecordOf, CERTIFICATE_KIND } from './certificate'
import { REPORT_KIND, reportRecordOf, signedInspection } from './report'
import { readVersions, versionView, type DocumentKind, type DocumentRecord } from './versions'

/**
 * A kept version with the customer (B-W2b-123; QHS-055 "share link through the existing document link"; design row verb
 * "Share report link"). No new kind of link: the copy goes on a Shipment as a DOCUMENT shared with the shipment's party
 * (PARTNER, LINK), and the shipment's existing DOCUMENT_VIEW link (modules/shipping/documents, B-W1-49) lists every file of
 * the shipment shared with its party's links (beside the DDT, the DoC and the leaflet: as "other" with its file name).
 * Customers ask for the report with the goods: an inspection's report goes on a shipment that carries garments of its
 * work order; the certificate on its own shipment.
 *
 *   share   quality.documents.share over the record (inspection or shipment), shipping.view over the shipment; the
 *           shipment PACKED or later (shipping's attach rule); the version named, else the newest (none kept: 409 in
 *           words). Outside any transaction the version's file is copied (prepareFileCopy: its bytes checked against its
 *           SHA-256) unless a live copy is there already; then ONE command under the shipment's documents lock (the
 *           office's attach and the ship handler take it too): the copy recorded, every copy of an OLDER version of the
 *           same document on the shipment withdrawn from the link (visibility OFFICE: it stays as evidence, the customer
 *           never keeps an outdated report silently), one audit row on the record, one event. Nothing new: nothing written.
 *   send    optional, after the commit: the shipment's existing documents link mailed (shipping's sendFromOffice:
 *           shipping.manage, checked before anything is copied), as "Send link" on the shipment does.
 *
 * No pay or cost figure is on either document; the link session reads only the files shared with its party.
 */

export interface ShareBody {
  /** The shipment the report goes on (the certificate's is its own). */
  readonly shipmentId?: string | undefined
  /** The version to share; default the newest. */
  readonly version?: number | undefined
  /** Mail the shipment's documents link after (shipping.manage): to these contacts, else the party's orders and quality contacts. */
  readonly send?: { readonly contactIds?: readonly string[] | undefined; readonly expiresInDays?: number | undefined } | null | undefined
}

class NothingToShare extends Error {}

/** A step the record's state does not take now: 409 with `held/<CODE>` and the words. */
const held = (code: string, message: string) => new DomainError('invalid_state', message, [{ path: `held/${code}`, message }])

interface ShareRequest {
  readonly files: FilesRuntime
  readonly email: EmailRuntime
  readonly request: FastifyRequest
  readonly record: DocumentRecord
  readonly kind: DocumentKind
  readonly shipment: ShipmentHeader
  readonly body: ShareBody
  readonly idempotencyKey: string | undefined
  readonly event: (tools: CommandTools, shared: { readonly fileId: string; readonly version: number; readonly withdrawn: number }) => void
}

/** The copies of a document's versions on shipments (by SHA-256: a copy has its version's bytes), live ones shared with the link. */
async function copiesOf(db: Reader, shipmentIds: readonly string[], versions: readonly { readonly version: number; readonly fileId: string }[]) {
  if (shipmentIds.length === 0 || versions.length === 0) return []
  const sources = await db.storedFile.findMany({ where: { id: { in: versions.map((version) => version.fileId) } }, select: { id: true, sha256: true } })
  const versionOfSha = new Map(sources.map((file) => [file.sha256, versions.find((version) => version.fileId === file.id)!.version]))
  const copies = await db.storedFile.findMany({
    // A certificate's own version files are files of its shipment too: they are the versions, never a copy.
    where: { recordType: 'Shipment', recordId: { in: [...shipmentIds] }, status: 'AVAILABLE', sha256: { in: [...versionOfSha.keys()] }, id: { notIn: versions.map((version) => version.fileId) } },
    select: { id: true, recordId: true, sha256: true, visibility: true, createdAt: true, version: true, companyId: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  return copies.map((copy) => ({ ...copy, documentVersion: versionOfSha.get(copy.sha256)!, live: copy.visibility.includes('LINK') }))
}

async function shareVersion(input: ShareRequest) {
  const { files, email, request, record, kind, shipment, body } = input
  const context = officeContextOf(request)
  const problem = attachStateProblem(shipment.status as never)
  if (problem) throw new InvalidStateError(problem)
  if (body.send && !shipmentMay(context, SHIPPING_MANAGE, shipment)) throw new ForbiddenError('Mailing the shipment\'s documents link needs shipping.manage over the shipment.')
  const versions = await request.withClient((db) => readVersions(db, record, kind))
  const chosen = body.version === undefined ? versions[0] : versions.find((version) => version.version === body.version)
  if (!chosen) throw body.version === undefined ? held('NO_VERSION', 'No version is kept yet: keep one first, then share it.') : held('NO_SUCH_VERSION', `Version ${body.version} is not kept.`)
  const before = await request.withClient((db) => copiesOf(db, [shipment.id], versions))
  const copyName = `${chosen.number ?? record.number} ${kind === REPORT_KIND ? 'inspection report' : 'certificate of conformity'} v${chosen.version} (${chosen.language}).pdf`.replace(/[\\/]/g, '-')
  const prepared = before.some((copy) => copy.live && copy.documentVersion === chosen.version)
    ? null
    : await prepareFileCopy(files, request, chosen.fileId, { companyId: shipment.companyId, recordType: 'Shipment', recordId: shipment.id, kind: 'DOCUMENT', originalName: copyName, visibility: ['PARTNER', 'LINK'], partyId: shipment.partyId })

  let shared: { fileId: string; version: number; copied: boolean; withdrawn: number }
  try {
    shared = (
      await command(request, { name: kind === REPORT_KIND ? 'quality.shareInspectionReport' : 'quality.shareConformityCertificate', idempotencyKey: input.idempotencyKey, input: { recordId: record.recordId, shipmentId: shipment.id, version: chosen.version } }, async (tools) => {
        const { tx, now } = tools
        await lockShipmentDocuments(tx, tenantOf(tools.context), shipment.id)
        const current = await readShipment(tx, shipment.id)
        const stateProblem = current ? attachStateProblem(current.status as never) : 'The shipment is gone.'
        if (stateProblem) throw new InvalidStateError(stateProblem)
        const copies = await copiesOf(tx, [shipment.id], versions)
        const live = copies.find((copy) => copy.live && copy.documentVersion === chosen.version)
        let fileId = live?.id ?? null
        let copied = false
        if (!fileId && prepared) {
          fileId = (await recordGeneratedFile(tools, prepared, { action: 'quality.shareDocument', details: { documentType: kind, number: record.number, version: chosen.version, shipmentId: shipment.id, sourceFileId: chosen.fileId } })).id
          copied = true
        }
        if (!fileId) throw new InvalidStateError('The copy for the link was not prepared: share it again.')
        const older = copies.filter((copy) => copy.live && copy.documentVersion !== chosen.version)
        for (const copy of older) {
          await tx.storedFile.update({ where: { id: copy.id }, data: { visibility: ['OFFICE'], partyId: null, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
          tools.audit({ action: 'files.setVisibility', recordType: 'StoredFile', recordId: copy.id, companyId: copy.companyId, before: { visibility: copy.visibility, partyId: shipment.partyId }, after: { visibility: ['OFFICE'], partyId: null }, reason: `Version ${chosen.version} replaces version ${copy.documentVersion} on the shipment's documents link.` })
        }
        if (!copied && older.length === 0) throw new NothingToShare()
        tools.audit({ action: kind === REPORT_KIND ? 'quality.shareInspectionReport' : 'quality.shareConformityCertificate', recordType: record.recordType, recordId: record.recordId, companyId: record.companyId, siteId: record.siteId, after: { shipmentId: shipment.id, version: chosen.version, fileId, copied, withdrawn: older.map((copy) => copy.id) } })
        input.event(tools, { fileId, version: chosen.version, withdrawn: older.length })
        return { fileId, version: chosen.version, copied, withdrawn: older.length }
      })
    ).result
  } catch (error) {
    if (!(error instanceof NothingToShare)) throw error
    const live = (await request.withClient((db) => copiesOf(db, [shipment.id], versions))).find((copy) => copy.live && copy.documentVersion === chosen.version)!
    shared = { fileId: live.id, version: chosen.version, copied: false, withdrawn: 0 }
  }

  let link: Pick<Awaited<ReturnType<typeof sendFromOffice>>, 'links' | 'skipped'> | null = null
  if (body.send) {
    const sent = await sendFromOffice(files, email, request, shipment.id, { contactIds: body.send.contactIds, expiresInDays: body.send.expiresInDays }, input.idempotencyKey ? `${input.idempotencyKey}:link` : undefined)
    link = { links: sent.links, skipped: sent.skipped }
  }
  return { shared: { shipmentId: shipment.id, shipmentNumber: shipment.number, ...shared }, link }
}

/** POST /quality/inspections/:inspectionId/reports/share {shipmentId, version?, send?} */
export async function shareReport(files: FilesRuntime, email: EmailRuntime, request: FastifyRequest, inspectionId: string, body: ShareBody, idempotencyKey: string | undefined) {
  const { inspection, header } = await signedInspection(request, inspectionId)
  await inspectionFor(request, inspectionId, QUALITY_DOCUMENTS_SHARE)
  if (!body.shipmentId) throw held('NO_SHIPMENT', 'Name the shipment that carries the goods: the report goes on its documents link.')
  const shipment = await officeShipment(request, body.shipmentId, SHIPPING_VIEW)
  const carries = await request.withClient((db) => db.shipmentLine.count({ where: { shipmentId: shipment.id, workOrderId: inspection.workOrderId } }))
  if (carries === 0) throw held('NOT_ON_SHIPMENT', `Shipment ${shipment.number} carries no garment of ${header.number}: the report goes with the goods it judged.`)
  const record = reportRecordOf(inspection, header.number)
  return shareVersion({
    files,
    email,
    request,
    record,
    kind: REPORT_KIND,
    shipment,
    body,
    idempotencyKey,
    event: (tools, shared) => tools.emit({ type: 'inspection_report.shared', subject: inspection.id, companyId: shipment.companyId, siteId: shipment.siteId, payload: { inspectionId: inspection.id, number: record.number, shipmentId: shipment.id, ...shared } }),
  })
}

/** POST /quality/shipments/:shipmentId/certificates/share {version?, send?} */
export async function shareCertificate(files: FilesRuntime, email: EmailRuntime, request: FastifyRequest, shipmentId: string, body: ShareBody, idempotencyKey: string | undefined) {
  const shipment = await officeShipment(request, shipmentId, QUALITY_DOCUMENTS_SHARE)
  // Shared only while it still stands: goods of a reversed release are never certified on a link.
  const facts = await request.withClient((db) => certificateFacts(db, shipment))
  const blocking = facts.problems.filter((message) => !message.startsWith('The shipment is'))
  if (blocking.length > 0) throw held('NOT_CERTIFIABLE', blocking[0]!)
  const record = certificateRecordOf(shipment)
  return shareVersion({
    files,
    email,
    request,
    record,
    kind: CERTIFICATE_KIND,
    shipment,
    body: { ...body, shipmentId },
    idempotencyKey,
    event: (tools, shared) => tools.emit({ type: 'conformity_certificate.shared', subject: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, payload: { number: record.number, shipmentId: shipment.id, ...shared } }),
  })
}

// ---- reads -------------------------------------------------------------------------------------------------------------------

const shareView = (copy: Awaited<ReturnType<typeof copiesOf>>[number], numbers: ReadonlyMap<string, string>) => ({
  shipmentId: copy.recordId,
  shipmentNumber: numbers.get(copy.recordId) ?? null,
  fileId: copy.id,
  version: copy.documentVersion,
  live: copy.live,
  sharedAt: toUtcIso(copy.createdAt),
})

/** GET /quality/inspections/:inspectionId/reports: the versions, the shipments of the goods and where each version is shared. */
export async function reportsOf(caller: CommandCaller, inspectionId: string) {
  const context = officeContextOf(caller)
  const { inspection, header } = await inspectionFor(caller, inspectionId, QUALITY_INSPECTIONS_VIEW)
  const signed = inspection.status === 'PASSED' || inspection.status === 'FAILED'
  const legal = legalProblems(await companyLegalOf(caller, inspection.companyId))
  return caller.withClient(async (db) => {
    const versions = await readVersions(db, { recordType: 'Inspection', recordId: inspection.id }, REPORT_KIND)
    const names = await namesOf(db, versions.map((version) => version.createdById))
    const shipmentIds = [...new Set((await db.shipmentLine.findMany({ where: { workOrderId: inspection.workOrderId }, select: { shipmentId: true } })).map((line) => line.shipmentId))]
    const shipments = (shipmentIds.length === 0 ? [] : await db.shipment.findMany({ where: { id: { in: shipmentIds } }, select: { id: true, number: true, status: true, companyId: true, siteId: true, partyId: true }, orderBy: [{ number: 'asc' }] })).filter((shipment) =>
      shipmentMay(context, SHIPPING_VIEW, shipment),
    )
    const parties = new Map((shipments.length === 0 ? [] : await db.party.findMany({ where: { id: { in: shipments.map((shipment) => shipment.partyId) } }, select: { id: true, legalName: true } })).map((party) => [party.id, party.legalName]))
    const numbers = new Map(shipments.map((shipment) => [shipment.id, shipment.number]))
    const copies = await copiesOf(db, shipments.map((shipment) => shipment.id), versions)
    const holds: Issue[] = [...(signed ? [] : [{ path: 'held/NOT_SIGNED', message: `This inspection is ${inspection.status}: a report is made of a signed result.` }]), ...legal]
    return {
      inspection: { id: inspection.id, number: inspection.number ?? `${header.number} · inspection`, status: inspection.status, workOrderId: inspection.workOrderId, signed },
      versions: versions.map((version) => versionView(version, names)),
      shipments: shipments.map((shipment) => ({ id: shipment.id, number: shipment.number, status: shipment.status, customer: parties.get(shipment.partyId) ?? null, shareable: attachStateProblem(shipment.status as never) === null, problem: attachStateProblem(shipment.status as never) })),
      shares: copies.map((copy) => shareView(copy, numbers)),
      ready: { ok: holds.length === 0, held: holds },
      may: { make: signed && inspectionMay(context, QUALITY_DOCUMENTS_MAKE, inspection), share: signed && versions.length > 0 && inspectionMay(context, QUALITY_DOCUMENTS_SHARE, inspection) },
      asOf: toUtcIso(serverClock.now()),
    }
  })
}

/** GET /quality/shipments/:shipmentId/certificates: the versions, where they are shared, what holds a new one. */
export async function certificatesOf(caller: CommandCaller, shipmentId: string) {
  const context = officeContextOf(caller)
  const shipment = await officeShipment(caller, shipmentId, SHIPPING_VIEW)
  const legal = legalProblems(await companyLegalOf(caller, shipment.companyId))
  return caller.withClient(async (db) => {
    const versions = await readVersions(db, { recordType: 'Shipment', recordId: shipment.id }, CERTIFICATE_KIND)
    const names = await namesOf(db, versions.map((version) => version.createdById))
    const copies = await copiesOf(db, [shipment.id], versions)
    const facts = await certificateFacts(db, shipment)
    const holds: Issue[] = [...facts.problems.map((message) => ({ path: 'held/NOT_CERTIFIABLE', message })), ...legal]
    return {
      shipment: { id: shipment.id, number: shipment.number, status: shipment.status },
      versions: versions.map((version) => versionView(version, names)),
      shares: copies.map((copy) => shareView(copy, new Map([[shipment.id, shipment.number]]))),
      lines: facts.lines.map((line) => ({ ...line, style: { ...line.style }, inspections: [...line.inspections], releases: [...line.releases] })),
      ready: { ok: holds.length === 0, held: holds },
      may: { make: holds.length === 0 && shipmentMay(context, QUALITY_DOCUMENTS_MAKE, shipment), share: versions.length > 0 && shipmentMay(context, QUALITY_DOCUMENTS_SHARE, shipment) },
      asOf: toUtcIso(serverClock.now()),
    }
  })
}

import type { FastifyRequest } from 'fastify'
import { FILES_READ, FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { SAFETY_INCIDENTS_MANAGE, SAFETY_INCIDENTS_PEOPLE, SAFETY_INCIDENTS_VIEW } from '@nexus/factory-domain/safety/incidents/permissions'
import { floorPhotoRefusal, refusalOf } from '@nexus/factory-domain/safety/incidents/rules'
import type { CommandTx } from '../../../core/command'
import { completeUpload, downloadFile, requestUpload, systemCallerOf } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { asTenantSystem } from '../../production/serials/facts'
import { anonymousKey, assertMay, assertMayWrite, floorOf, officeOf, placeCaller, refuse, type Placed } from './access'

/**
 * An incident's files (B-W2b-125; design plant.incidents record "photos" (MediaStrip), pop-up "Report an incident … photo",
 * "Record INAIL filing … receipt"; floor.incident "A photo ('no faces')"). Every one is OFFICE ONLY (a photo may show an injury
 * or a face; INAIL's receipt names the injured person: the database keeps a file of an Incident or an InailFiling to the office,
 * …_protected_safety_w2b_guards), and its module's own (platform/files/owned.ts: no generic upload, no generic read). The bytes
 * go through platform/files (types, size, presigned PUT, the store's check, the virus scan) as the tenant's system caller
 * holding exactly files.upload (files.read to look) over the incident's company and site, after this module's checks — the
 * office system caller the lead names, as B-W2a-76's kit task and B-W2b-96's request photos do:
 *
 *   POST /safety/incidents/:id/photos (+ /:fileId/complete)             office, safety.incidents.manage (or report, its own report)
 *   GET  /safety/incidents/:id/photos/:fileId/download                  office, safety.incidents.view
 *   POST /safety/floor/incidents/:id/photos (+ /:fileId/complete)       the tablet that sent the report (or any tablet of the site
 *                                                                       for one sent without a name, by its id), within 30 minutes
 *                                                                       of the report, up to 4; written as the system actor (an
 *                                                                       anonymous report's photo names no tablet either)
 *   POST /safety/incidents/:id/filings/:filingId/receipt (+ complete)  office, safety.incidents.people: INAIL's receipt
 *                                                                       (never the medical certificate); its opening is
 *                                                                       ./protected.ts (a COPY view recorded)
 */

export interface AnnounceBody {
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
}

/** The photos an incident shows (AVAILABLE PHOTO files of the row, oldest first). */
export async function photosOf(db: Pick<CommandTx, 'storedFile'>, incidentId: string) {
  const rows = await db.storedFile.findMany({ where: { recordType: 'Incident', recordId: incidentId, kind: 'PHOTO', status: 'AVAILABLE' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, originalName: true, contentType: true, sizeBytes: true, availableAt: true } })
  return rows.map((row) => ({ id: row.id, name: row.originalName, contentType: row.contentType, sizeBytes: row.sizeBytes, availableAt: row.availableAt?.toISOString() ?? null }))
}

async function officeIncident(request: FastifyRequest, incidentId: string) {
  if (!isUuid(incidentId)) throw new NotFoundError('Incident not found.')
  const row = await request.withClient((db) => db.incident.findUnique({ where: { id: incidentId }, select: { id: true, companyId: true, siteId: true, status: true, reportedById: true } }))
  if (!row) throw new NotFoundError('Incident not found.')
  return row
}

const photoUpload = (request: FastifyRequest, tenantId: string, place: Placed, incidentId: string, body: AnnounceBody, key: string | undefined, requestId?: string) =>
  requestUpload(
    processFiles(),
    placeCaller(request, tenantId, place, [FILES_UPLOAD], requestId),
    { companyId: place.companyId, recordType: 'Incident', recordId: incidentId, kind: 'PHOTO', originalName: body.originalName, contentType: body.contentType, sizeBytes: body.sizeBytes, sha256: body.sha256, visibility: ['OFFICE'] },
    key,
    { viaModule: true },
  )

/** POST /safety/incidents/:id/photos. */
export async function announcePhoto(request: FastifyRequest, incidentId: string, body: AnnounceBody, idempotencyKey?: string) {
  const context = officeOf(request)
  const row = await officeIncident(request, incidentId)
  assertMay(context, SAFETY_INCIDENTS_VIEW, row)
  // The safety roles add photos; whoever reported it from the office adds to their own report.
  if (row.reportedById !== context.actorId) assertMayWrite(context, SAFETY_INCIDENTS_MANAGE, row, 'Photos of an incident are added by the safety roles (safety.incidents.manage) or by whoever reported it.')
  if (row.status === 'CANCELLED') refuse(refusalOf('NOT_OPEN'))
  return photoUpload(request, context.tenantId, row, row.id, body, idempotencyKey)
}

/** POST /safety/incidents/:id/photos/:fileId/complete. */
export async function completePhoto(request: FastifyRequest, incidentId: string, fileId: string, idempotencyKey?: string) {
  const context = officeOf(request)
  const row = await officeIncident(request, incidentId)
  assertMay(context, SAFETY_INCIDENTS_VIEW, row)
  if (row.reportedById !== context.actorId) assertMayWrite(context, SAFETY_INCIDENTS_MANAGE, row, 'Photos of an incident are added by the safety roles (safety.incidents.manage) or by whoever reported it.')
  return completeOne(request, context.tenantId, row, 'Incident', row.id, fileId, 'PHOTO', idempotencyKey)
}

async function completeOne(request: FastifyRequest, tenantId: string, place: Placed, recordType: 'Incident' | 'InailFiling', recordId: string, fileId: string, kind: 'PHOTO' | 'DOCUMENT', idempotencyKey: string | undefined, requestId?: string) {
  const uploader = placeCaller(request, tenantId, place, [FILES_UPLOAD], requestId)
  const file = isUuid(fileId) ? await uploader.withClient((db) => db.storedFile.findFirst({ where: { id: fileId, recordType, recordId, kind }, select: { id: true } })) : null
  if (!file) throw new NotFoundError('File not found.')
  return { file: await completeUpload(processFiles(), uploader, fileId, idempotencyKey, { viaModule: true }) }
}

/** GET /safety/incidents/:id/photos/:fileId/download. */
export async function downloadPhoto(request: FastifyRequest, incidentId: string, fileId: string) {
  const context = officeOf(request)
  const row = await officeIncident(request, incidentId)
  assertMay(context, SAFETY_INCIDENTS_VIEW, row)
  const file = isUuid(fileId) ? await request.withClient((db) => db.storedFile.findFirst({ where: { id: fileId, recordType: 'Incident', recordId: row.id, kind: 'PHOTO', status: 'AVAILABLE' }, select: { id: true } })) : null
  if (!file) throw new NotFoundError('File not found.')
  const reader = placeCaller(request, context.tenantId, row, [FILES_READ])
  return { download: await downloadFile(processFiles(), { caller: reader, system: systemCallerOf(request) }, file.id, { viaModule: true }) }
}

/** The tablet's own report (read as the system: the floor reads no incident), within its photo window, or a 404 / a refusal. */
async function floorIncident(request: FastifyRequest, incidentId: string) {
  const context = floorOf(request)
  if (!isUuid(incidentId)) throw new NotFoundError('Report not found.')
  const now = new Date()
  const found = await asTenantSystem(request).withClient(async (db) => {
    const row = await db.incident.findFirst({ where: { id: incidentId, siteId: context.siteId, reportedVia: 'FLOOR', OR: [{ deviceId: context.deviceId }, { reporterAnonymous: true }] }, select: { id: true, companyId: true, siteId: true, reportedAt: true, reporterAnonymous: true, status: true } })
    if (!row) return null
    const photos = await db.storedFile.count({ where: { recordType: 'Incident', recordId: row.id, kind: 'PHOTO', status: { in: ['PENDING_UPLOAD', 'AVAILABLE', 'QUARANTINED'] } } })
    return { row, photos }
  })
  if (!found) throw new NotFoundError('Report not found.')
  return { context, row: found.row, photos: found.photos, now }
}

/** POST /safety/floor/incidents/:id/photos. */
export async function announceFloorPhoto(request: FastifyRequest, incidentId: string, body: AnnounceBody, idempotencyKey: string | undefined) {
  const { context, row, photos, now } = await floorIncident(request, incidentId)
  refuse(floorPhotoRefusal({ reportedAt: row.reportedAt, photos, now }))
  if (row.status === 'CANCELLED') refuse(refusalOf('NOT_OPEN'))
  // A report without a name: its photo's rows name no tablet (a fresh request id, the key hashed as the report's).
  const key = idempotencyKey && row.reporterAnonymous ? anonymousKey(context, idempotencyKey) : idempotencyKey
  return photoUpload(request, context.tenantId, row, row.id, body, key, row.reporterAnonymous ? newId() : undefined)
}

/** POST /safety/floor/incidents/:id/photos/:fileId/complete. */
export async function completeFloorPhoto(request: FastifyRequest, incidentId: string, fileId: string, idempotencyKey: string | undefined) {
  const { context, row, now } = await floorIncident(request, incidentId)
  // Within the window (a little longer: the bytes were going up), never later.
  if (now.getTime() - row.reportedAt.getTime() > 2 * 30 * 60_000) refuse(refusalOf('PHOTO_WINDOW'))
  const key = idempotencyKey && row.reporterAnonymous ? anonymousKey(context, idempotencyKey) : idempotencyKey
  return completeOne(request, context.tenantId, row, 'Incident', row.id, fileId, 'PHOTO', key, row.reporterAnonymous ? newId() : undefined)
}

async function filingPlace(request: FastifyRequest, incidentId: string, filingId: string) {
  const context = officeOf(request)
  const row = await officeIncident(request, incidentId)
  assertMay(context, SAFETY_INCIDENTS_VIEW, row)
  assertMayWrite(context, SAFETY_INCIDENTS_PEOPLE, row, 'INAIL’s receipt is kept by the safety roles and HR (safety.incidents.people).')
  const filing = isUuid(filingId) ? await request.withClient((db) => db.inailFiling.findFirst({ where: { id: filingId, incidentId }, select: { id: true } })) : null
  if (!filing) throw new NotFoundError('Filing not found.')
  return { context, row, filing }
}

/** POST /safety/incidents/:id/filings/:filingId/receipt: INAIL's receipt (a DOCUMENT of the filing, office only). */
export async function announceReceipt(request: FastifyRequest, incidentId: string, filingId: string, body: AnnounceBody, idempotencyKey?: string) {
  const { context, row, filing } = await filingPlace(request, incidentId, filingId)
  return requestUpload(
    processFiles(),
    placeCaller(request, context.tenantId, row, [FILES_UPLOAD]),
    { companyId: row.companyId, recordType: 'InailFiling', recordId: filing.id, kind: 'DOCUMENT', originalName: body.originalName, contentType: body.contentType, sizeBytes: body.sizeBytes, sha256: body.sha256, visibility: ['OFFICE'] },
    idempotencyKey,
    { viaModule: true },
  )
}

/** POST /safety/incidents/:id/filings/:filingId/receipt/:fileId/complete. */
export async function completeReceipt(request: FastifyRequest, incidentId: string, filingId: string, fileId: string, idempotencyKey?: string) {
  const { context, row, filing } = await filingPlace(request, incidentId, filingId)
  return completeOne(request, context.tenantId, row, 'InailFiling', filing.id, fileId, 'DOCUMENT', idempotencyKey)
}


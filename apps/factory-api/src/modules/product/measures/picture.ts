import type { FastifyRequest } from 'fastify'
import { FILES_READ, FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ForbiddenError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import type { PomPictureBody, PomView } from '@nexus/factory-domain/product/measures/contracts'
import { PRODUCT_STYLES_MANAGE } from '@nexus/factory-domain/product/styles/permissions'
import { command, type CommandCaller } from '../../../core/command'
import { SYSTEM_ACTOR_ID, type SystemContext } from '../../../core/context'
import { completeUpload, downloadFile, requestUpload, systemCallerOf } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { getPom, pomViewInTx } from './points'
import { assertMayWrite, contextOf, readPomFor, type PomRowData } from './store'

/**
 * A point of measure's how-to picture (B-W2b-224; PRD-062; design sizes.poms "Picture upload per row", sizes.howTo
 * "Picture and text"). B-W2b-210's database takes as a point's picture only an AVAILABLE PHOTO file of the point
 * (StoredFile recordType "PointOfMeasure", recordId = the point), so the picture goes through these routes only
 * (platform/files/owned.ts):
 *
 *   POST /product/points-of-measure/:pomId/picture                      announced (a PHOTO), then the presigned PUT
 *   POST /product/points-of-measure/:pomId/picture/:fileId/complete     confirmed; once the file is AVAILABLE (scanned)
 *                                                                       it becomes the point's picture, in one command on
 *                                                                       the point (`point_of_measure.changed` PICTURE)
 *   GET  /product/points-of-measure/:pomId/picture                      a presigned look at the picture
 *   DELETE /product/points-of-measure/:pomId/picture?version            the point keeps no picture (the file stays)
 *
 * product.styles.manage (and .view to look) over the point's company; no files right of the person's: the files platform
 * runs as the tenant's system holding exactly the files permission over the point's company. An OFFICE file: the floor's
 * spec viewer (B-W2b-232) serves it through its own route.
 */

const RECORD = 'PointOfMeasure'

/** The office person's tenant (the routes are office only). */
function tenantOf(request: FastifyRequest): string {
  const context = contextOf(request)
  if (context.audience !== 'office') throw new ForbiddenError()
  return context.tenantId
}

/** The tenant's system holding exactly `permissions` over the point's company (every company for a tenant-wide point). */
function pictureCaller(request: FastifyRequest, tenantId: string, point: Pick<PomRowData, 'companyId'>, permissions: readonly Permission[]): CommandCaller {
  const view = Object.create(request) as FastifyRequest
  const grant: Grant = { permissions: [...permissions], companies: point.companyId === null ? 'all' : [point.companyId], sites: 'all', parties: 'all' }
  const context: SystemContext = Object.freeze({ audience: 'system', tenantId, actorId: SYSTEM_ACTOR_ID, requestId: String(request.id), grants: [grant] })
  view.factoryContext = context
  return view
}

async function writable(request: FastifyRequest, pomId: string): Promise<PomRowData> {
  const point = await readPomFor(request, pomId)
  assertMayWrite(contextOf(request), PRODUCT_STYLES_MANAGE, point.companyId, 'point of measure')
  if (point.status !== 'ACTIVE') throw new InvalidStateError(`Point of measure ${point.code} is archived: restore it before changing its picture.`)
  return point
}

/** POST /product/points-of-measure/:pomId/picture. */
export async function announcePicture(request: FastifyRequest, pomId: string, body: PomPictureBody, idempotencyKey?: string) {
  const point = await writable(request, pomId)
  if (point.version !== body.version) throw new InvalidStateError(`Point of measure ${point.code} changed since it was read: load it again.`)
  return requestUpload(
    processFiles(),
    pictureCaller(request, tenantOf(request), point, [FILES_UPLOAD]),
    { companyId: point.companyId, recordType: RECORD, recordId: point.id, kind: 'PHOTO', originalName: body.originalName, contentType: body.contentType, sizeBytes: body.sizeBytes, sha256: body.sha256 },
    idempotencyKey,
    { viaModule: true },
  )
}

/** POST /product/points-of-measure/:pomId/picture/:fileId/complete. */
export async function completePicture(request: FastifyRequest, pomId: string, fileId: string, idempotencyKey?: string): Promise<{ point: PomView; picture: { fileId: string; status: string; current: boolean } }> {
  const point = await writable(request, pomId)
  const caller = pictureCaller(request, tenantOf(request), point, [FILES_UPLOAD])
  const found = isUuid(fileId) ? await caller.withClient((client) => client.storedFile.findFirst({ where: { id: fileId, recordType: RECORD, recordId: point.id, kind: 'PHOTO' }, select: { id: true } })) : null
  if (!found) throw new NotFoundError('File not found.')
  const file = await completeUpload(processFiles(), caller, fileId, idempotencyKey, { viaModule: true })
  const available = file.status === 'AVAILABLE'
  if (available && point.pictureFileId !== fileId) {
    const { result } = await command(request, { name: 'product.measures.setPicture', idempotencyKey, input: { pomId, fileId }, record: { type: 'PointOfMeasure', id: pomId } }, async (tools) => {
      await tools.tx.pointOfMeasure.update({ where: { id: pomId }, data: { pictureFileId: fileId, updatedAt: tools.now }, select: { id: true } })
      tools.audit({ recordType: 'PointOfMeasure', recordId: pomId, companyId: point.companyId, before: { pictureFileId: point.pictureFileId }, after: { pictureFileId: fileId } })
      tools.emit({ type: 'point_of_measure.changed', subject: pomId, companyId: point.companyId, payload: { pointOfMeasureId: pomId, code: point.code, change: 'PICTURE' } })
      return pomViewInTx(tools.tx, pomId)
    })
    return { point: result, picture: { fileId, status: file.status, current: true } }
  }
  // Not available yet (waiting for its scan): the point keeps its picture; complete it again once the scan is done.
  return { point: await getPom(request, pomId), picture: { fileId, status: file.status, current: available } }
}

/** GET /product/points-of-measure/:pomId/picture. */
export async function lookAtPicture(request: FastifyRequest, pomId: string) {
  const point = await readPomFor(request, pomId)
  if (!point.pictureFileId) throw new NotFoundError(`Point of measure ${point.code} has no picture.`)
  const caller = pictureCaller(request, tenantOf(request), point, [FILES_READ])
  return { download: await downloadFile(processFiles(), { caller, system: systemCallerOf(request) }, point.pictureFileId, { viaModule: true }) }
}

/** DELETE /product/points-of-measure/:pomId/picture?version. */
export async function clearPicture(request: FastifyRequest, pomId: string, version: number, idempotencyKey?: string): Promise<PomView> {
  const point = await writable(request, pomId)
  if (!point.pictureFileId) throw new InvalidStateError(`Point of measure ${point.code} has no picture.`)
  const { result } = await command(request, { name: 'product.measures.clearPicture', idempotencyKey, input: { pomId, version }, record: { type: 'PointOfMeasure', id: pomId, expectedVersion: version } }, async (tools) => {
    await tools.tx.pointOfMeasure.update({ where: { id: pomId }, data: { pictureFileId: null, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ recordType: 'PointOfMeasure', recordId: pomId, companyId: point.companyId, before: { pictureFileId: point.pictureFileId }, after: { pictureFileId: null } })
    tools.emit({ type: 'point_of_measure.changed', subject: pomId, companyId: point.companyId, payload: { pointOfMeasureId: pomId, code: point.code, change: 'PICTURE' } })
    return pomViewInTx(tools.tx, pomId)
  })
  return result
}

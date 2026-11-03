import type { FastifyRequest } from 'fastify'
import { FILES_MANAGE, FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { PRODUCTION_CUT } from '@nexus/factory-domain/production/cutting/permissions'
import type { CommandCaller } from '../../../core/command'
import { SYSTEM_ACTOR_ID, type SystemContext } from '../../../core/context'
import { completeUpload, requestUpload } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { floorOf, mayCut } from './cut'
import { readHideById } from './store'

/**
 * The photo of a hide on the cutting table before the cut (B-W2b-103; MES-060; design floor.hidecut "Photo of the hide": "A
 * photo on the table before cutting, stored with the hide and its cut log"; warehouse.hides record "Photos taken at receipt,
 * at incoming inspection and at the cutting table"):
 *
 *   POST /production/cutting/hides/:hideId/photos                  a PHOTO of the hide (production.cut at its site): announced,
 *                                                                  then the presigned PUT
 *   POST /production/cutting/hides/:hideId/photos/:fileId/complete the store's check (size, type, SHA-256, the virus scan)
 *
 * The file is the hide's (recordType Hide, kind PHOTO), shared OFFICE + FLOOR at the hide's site, so the hide record shows it
 * beside its other photos; the cut that follows names it (CutLog.photoFileId, checked there: a stored photo of that hide). The
 * files go through platform/files as the tenant's system caller holding exactly files.upload and files.manage over the
 * hide's company and site, after the module's own check, as the station's machine photos (modules/plant/requests/files.ts).
 * Photos never show faces (COL-017): the screen says so. The site's "photo required" is not a setting yet: optional everywhere.
 */

export interface AnnouncePhoto {
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
}

/** The hide the photo is of: one the device's site cuts (else not found), with its company. */
async function hideOf(request: FastifyRequest, hideId: string): Promise<{ id: string; siteId: string; companyId: string }> {
  const context = floorOf(request)
  const found = await request.withClient(async (client) => {
    const hide = isUuid(hideId) ? await readHideById(client, hideId) : null
    if (!hide) return null
    const site = await client.site.findUnique({ where: { id: hide.siteId }, select: { id: true, companyId: true } })
    return site ? { id: hide.id, siteId: site.id, companyId: site.companyId } : null
  })
  if (!found || !mayCut(context, PRODUCTION_CUT, found)) throw new NotFoundError("Not a hide of this site: scan the hide's tag.")
  return found
}

/** The tenant's system caller for the hide's company and site only, holding exactly files.upload and files.manage. */
function siteCaller(request: FastifyRequest, owner: { readonly companyId: string; readonly siteId: string }): CommandCaller {
  const context = floorOf(request)
  const view = Object.create(request) as FastifyRequest
  const grant: Grant = { permissions: [FILES_UPLOAD, FILES_MANAGE], companies: [owner.companyId], sites: [owner.siteId], parties: 'all' }
  const system: SystemContext = Object.freeze({ audience: 'system', tenantId: context.tenantId, actorId: SYSTEM_ACTOR_ID, requestId: String(request.id), grants: [grant] })
  view.factoryContext = system
  return view
}

/** POST …/photos: the photo announced, then the presigned PUT. */
export async function announceHidePhoto(request: FastifyRequest, hideId: string, body: AnnouncePhoto, idempotencyKey?: string) {
  const hide = await hideOf(request, hideId)
  return requestUpload(
    processFiles(),
    siteCaller(request, hide),
    {
      companyId: hide.companyId,
      recordType: 'Hide',
      recordId: hide.id,
      kind: 'PHOTO',
      originalName: body.originalName,
      contentType: body.contentType,
      sizeBytes: body.sizeBytes,
      sha256: body.sha256,
      visibility: ['OFFICE', 'FLOOR'],
      floorSiteId: hide.siteId,
    },
    idempotencyKey,
  )
}

/** POST …/photos/:fileId/complete: a photo of this hide announced from the table, confirmed. */
export async function completeHidePhoto(request: FastifyRequest, hideId: string, fileId: string, idempotencyKey?: string) {
  const hide = await hideOf(request, hideId)
  const uploader = siteCaller(request, hide)
  const file = isUuid(fileId) ? await uploader.withClient((client) => client.storedFile.findFirst({ where: { id: fileId, recordType: 'Hide', recordId: hide.id, kind: 'PHOTO' }, select: { id: true } })) : null
  if (!file) throw new NotFoundError('File not found.')
  return { file: await completeUpload(processFiles(), uploader, fileId, idempotencyKey) }
}

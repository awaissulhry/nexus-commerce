import type { FastifyRequest } from 'fastify'
import { FILES_MANAGE, FILES_READ, FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { filesClosed, requestFilesClosed } from '@nexus/factory-domain/plant/jobs/close'
import { PLANT_JOBS_WORK, PLANT_REPORT, PLANT_VIEW } from '@nexus/factory-domain/plant/permissions'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { SYSTEM_ACTOR_ID, type SystemContext } from '../../../core/context'
import { completeUpload, downloadFile, requestUpload, systemCallerOf } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { contextOf, may, refused, type PlantContext } from '../access'

/**
 * Photos and voice notes of a machine request or a maintenance job (B-W2b-96; QHS-189; design floor.machine "Optional photo
 * or voice note", plant.jobs "Photos": "Photos with before / after tag, voice notes"), from the station, the technician's
 * tablet or the office:
 *
 *   POST /plant/requests/:id/files (+ /:fileId/complete)   a PHOTO or AUDIO file of the request (plant.report), while the
 *                                                         request is not merged or closed
 *   POST /plant/jobs/:id/files (+ /:fileId/complete)       a PHOTO (before or after the work: category BEFORE_WORK |
 *                                                         AFTER_WORK) or AUDIO file of the job (plant.jobs.work), while open
 *   GET  /plant/floor/files/:fileId/download              the floor's look at one (plant.report at its site): a floor role
 *                                                         holds no files right, so the module asks its own
 *
 * The files go through platform/files (the kind's types and size, the presigned PUT, the store's check, the virus scan) as
 * the tenant's system caller holding exactly files.upload and files.manage (files.read for the floor's look) over the
 * record's company and site, after the module's own checks: shared OFFICE + FLOOR at the record's site, as the dock's
 * photos (B-W2a-31) and the floor notes (B-W2b-47). Photos from the floor never show faces (COL-017): the screen says so.
 */

export type MediaKind = 'PHOTO' | 'AUDIO'
export type WorkCategory = 'BEFORE_WORK' | 'AFTER_WORK'

export interface AnnounceBody {
  readonly kind: MediaKind
  readonly category?: WorkCategory | null | undefined
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
}

interface Owner {
  readonly recordType: 'MaintenanceRequest' | 'MaintenanceJob'
  readonly id: string
  readonly companyId: string
  readonly siteId: string
}

/** The tenant's system caller for one record's company and site only. */
function siteCaller(request: FastifyRequest, tenantId: string, owner: Pick<Owner, 'companyId' | 'siteId'>, permissions: readonly Permission[]): CommandCaller {
  const view = Object.create(request) as FastifyRequest
  const grant: Grant = { permissions: [...permissions], companies: [owner.companyId], sites: [owner.siteId], parties: 'all' }
  const context: SystemContext = Object.freeze({ audience: 'system', tenantId, actorId: SYSTEM_ACTOR_ID, requestId: String(request.id), grants: [grant] })
  view.factoryContext = context
  return view
}

const tenantOf = (context: PlantContext) => context.tenantId

/** The request or job the file is for: seen and written by the caller (404 / 403), and still taking files. */
async function ownerOf(request: FastifyRequest, recordType: Owner['recordType'], id: string): Promise<{ owner: Owner; context: PlantContext }> {
  const context = contextOf(request)
  const write = recordType === 'MaintenanceRequest' ? PLANT_REPORT : PLANT_JOBS_WORK
  const row = !isUuid(id)
    ? null
    : recordType === 'MaintenanceRequest'
      ? await request.withClient((client) => client.maintenanceRequest.findUnique({ where: { id }, select: { id: true, companyId: true, siteId: true, status: true } }))
      : await request.withClient((client) => client.maintenanceJob.findUnique({ where: { id }, select: { id: true, companyId: true, siteId: true, status: true, number: true } }))
  if (!row || (!may(context, write, row) && (context.audience === 'floor' || !may(context, PLANT_VIEW, row)))) throw new NotFoundError(recordType === 'MaintenanceRequest' ? 'Request not found.' : 'Job not found.')
  if (!may(context, write, row)) throw new ForbiddenError(recordType === 'MaintenanceRequest' ? 'Photos and voice notes of a request are added by whoever reports machine problems (plant.report).' : "Photos and voice notes of a job are added by its technician (plant.jobs.work).")
  if (recordType === 'MaintenanceRequest' && (row.status === 'MERGED' || row.status === 'CLOSED')) refused(requestFilesClosed(row.status))
  if (recordType === 'MaintenanceJob' && (row.status === 'CLOSED' || row.status === 'CANCELLED')) refused(filesClosed((row as { number: string }).number, row.status))
  return { owner: { recordType, id: row.id, companyId: row.companyId, siteId: row.siteId }, context }
}

/** POST …/files: the file announced, then the presigned PUT. */
export async function announceMedia(request: FastifyRequest, recordType: Owner['recordType'], id: string, body: AnnounceBody, idempotencyKey?: string) {
  const { owner, context } = await ownerOf(request, recordType, id)
  const category = recordType === 'MaintenanceJob' && body.kind === 'PHOTO' ? (body.category ?? null) : null
  return requestUpload(
    processFiles(),
    siteCaller(request, tenantOf(context), owner, [FILES_UPLOAD, FILES_MANAGE]),
    {
      companyId: owner.companyId,
      recordType: owner.recordType,
      recordId: owner.id,
      kind: body.kind,
      originalName: body.originalName,
      contentType: body.contentType,
      sizeBytes: body.sizeBytes,
      sha256: body.sha256,
      visibility: ['OFFICE', 'FLOOR'],
      floorSiteId: owner.siteId,
      category,
    },
    idempotencyKey,
  )
}

/** POST …/files/:fileId/complete. */
export async function completeMedia(request: FastifyRequest, recordType: Owner['recordType'], id: string, fileId: string, idempotencyKey?: string) {
  const { owner, context } = await ownerOf(request, recordType, id)
  const uploader = siteCaller(request, tenantOf(context), owner, [FILES_UPLOAD, FILES_MANAGE])
  const file = isUuid(fileId) ? await uploader.withClient((client) => client.storedFile.findFirst({ where: { id: fileId, recordType: owner.recordType, recordId: owner.id, kind: { in: ['PHOTO', 'AUDIO'] } }, select: { id: true } })) : null
  if (!file) throw new NotFoundError('File not found.')
  return { file: await completeUpload(processFiles(), uploader, fileId, idempotencyKey) }
}

/** The photos and voice notes a request or job shows (available ones, oldest first). */
export async function mediaOf(client: Pick<CommandTx, 'storedFile'>, recordType: Owner['recordType'], recordId: string) {
  const rows = await client.storedFile.findMany({
    where: { recordType, recordId, status: 'AVAILABLE', kind: { in: ['PHOTO', 'AUDIO'] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, kind: true, category: true, originalName: true, contentType: true, sizeBytes: true, availableAt: true },
  })
  return rows.map((row) => ({ id: row.id, kind: row.kind as MediaKind, category: (row.category === 'BEFORE_WORK' || row.category === 'AFTER_WORK' ? row.category : null) as WorkCategory | null, originalName: row.originalName, contentType: row.contentType, sizeBytes: row.sizeBytes, availableAt: row.availableAt ? row.availableAt.toISOString() : null }))
}

/** GET /plant/floor/files/:fileId/download: a photo or voice note of a request or job of the device's site, shared with the floor. */
export async function floorDownload(request: FastifyRequest, fileId: string) {
  const context = contextOf(request)
  if (context.audience !== 'floor') throw new NotFoundError('Not found.')
  const file = isUuid(fileId)
    ? await request.withClient((client) => client.storedFile.findFirst({ where: { id: fileId, recordType: { in: ['MaintenanceRequest', 'MaintenanceJob'] }, kind: { in: ['PHOTO', 'AUDIO'] }, status: 'AVAILABLE', floorSiteId: context.siteId }, select: { id: true, companyId: true, recordType: true } }))
    : null
  if (!file || file.companyId === null || !may(context, PLANT_REPORT, { companyId: file.companyId, siteId: context.siteId })) throw new NotFoundError('File not found.')
  const reader = siteCaller(request, context.tenantId, { companyId: file.companyId, siteId: context.siteId }, [FILES_READ])
  return { download: await downloadFile(processFiles(), { caller: reader, system: systemCallerOf(request) }, file.id) }
}

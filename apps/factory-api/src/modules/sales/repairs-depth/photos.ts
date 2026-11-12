import type { FastifyInstance, FastifyRequest } from 'fastify'
import { InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { RepairStage } from '@nexus/factory-domain/sales/repairs/rules'
import { DEPTH_LIMITS, photosHeld } from '@nexus/factory-domain/sales/repairs-depth/rules'
import { systemCallerOf, completeUpload, requestUpload } from '../../../platform/files/files'
import { assertOutsideUploadsOpen } from '../../../platform/files/multipart/outside'
import { normaliseContentType } from '../../../platform/files/rules'
import type { FilesRuntime } from '../../../platform/files/service'
import { commandOn } from '../../../platform/portal/tasks/clock'
import { partyUploader, photoProblems, presignOpen, type OpenMode, type PhotoUpload } from '../portal-returns/files'
import type { Place } from '../portal-returns/store'

/**
 * The customer's damage photos of a repair from outside (B-W2b-342; SAL-385 "Damage photos at intake"; design links.claim
 * sec:photos "PhotoCapture, at least 2 for damage; markup to circle the problem"), the same for a portal person and a claim
 * link, as B-W2b-192's photos of a return: announced here (the repair is theirs and still takes photos: before the work
 * starts; at most 10 of theirs), PUT to the presigned URL, then confirmed. The partner role and a link may not write files:
 * the files module is called as the tenant's system with files.upload and files.manage over the repair's company and party
 * only, the photo a PHOTO of category DAMAGE_PHOTO shared with the party (OFFICE, PARTNER, LINK). An upload from outside
 * waits for the virus scanner in a live environment (B-W2b-160). Opening one of them is ONE logged command, then a
 * presigned GET of 60 s (a picture as its copy without location data).
 */

export type RepairPhotoUpload = PhotoUpload

export async function announceRepairPhoto(files: FilesRuntime, request: FastifyRequest, tenantId: string, place: Place, repair: { readonly id: string; readonly number: string; readonly stage: string }, body: RepairPhotoUpload, idempotencyKey?: string) {
  assertOutsideUploadsOpen()
  photoProblems(body)
  const held = photosHeld(repair.number, repair.stage as RepairStage)
  if (held) throw new InvalidStateError(held)
  const uploader = partyUploader(request, tenantId, place)
  const theirs = await uploader.withClient((client) => client.storedFile.count({ where: { recordType: 'RepairOrder', recordId: repair.id, partyId: place.partyId, category: 'DAMAGE_PHOTO', status: { not: 'DELETED' } } }))
  if (theirs >= DEPTH_LIMITS.photos) throw new InvalidStateError(`It holds ${DEPTH_LIMITS.photos} of your photos already: write to us in the messages.`)
  const answer = await requestUpload(
    files,
    uploader,
    { companyId: place.companyId, recordType: 'RepairOrder', recordId: repair.id, kind: 'PHOTO', category: 'DAMAGE_PHOTO', originalName: body.originalName, contentType: normaliseContentType(body.contentType), sizeBytes: body.sizeBytes, sha256: body.sha256, visibility: ['OFFICE', 'PARTNER', 'LINK'], partyId: place.partyId },
    idempotencyKey,
  )
  return { file: { id: answer.file.id, originalName: answer.file.originalName, sizeBytes: answer.file.sizeBytes, status: answer.file.status }, upload: answer.upload }
}

export async function completeRepairPhoto(files: FilesRuntime, request: FastifyRequest, tenantId: string, place: Place, repairIds: readonly string[], fileId: string, idempotencyKey?: string) {
  const uploader = partyUploader(request, tenantId, place)
  const file = isUuid(fileId) && repairIds.length > 0
    ? await uploader.withClient((client) => client.storedFile.findFirst({ where: { id: fileId, recordType: 'RepairOrder', recordId: { in: [...repairIds] }, partyId: place.partyId, category: 'DAMAGE_PHOTO' }, select: { id: true } }))
    : null
  if (!file) throw new NotFoundError('File not found.')
  const view = await completeUpload(files, uploader, fileId, idempotencyKey)
  return { file: { id: view.id, originalName: view.originalName, sizeBytes: view.sizeBytes, status: view.status } }
}

const STORE = { id: true, status: true, storeAccountId: true, storageKey: true, contentType: true, originalName: true, thumbnailKey: true, recordType: true, recordId: true, partyId: true, visibility: true, kind: true, sha256: true } as const

/** One of the customer's photos of their repairs (shared with the party): the open logged in ONE command, then presigned. */
export async function openRepairFile(
  files: FilesRuntime,
  app: FastifyInstance,
  request: FastifyRequest,
  who: { readonly tenantId: string; readonly place: Place; readonly repairIds: readonly string[]; readonly actor: { readonly sessionId: string | null; readonly linkId: string | null } },
  fileId: string,
  mode: OpenMode,
  idempotencyKey?: string,
) {
  const system = systemCallerOf(request)(who.tenantId)
  const row = isUuid(fileId)
    ? await system.withClient((client) => client.storedFile.findFirst({ where: { id: fileId, recordType: 'RepairOrder', recordId: { in: [...who.repairIds] }, partyId: who.place.partyId, category: 'DAMAGE_PHOTO' }, select: STORE }))
    : null
  if (!row || (!row.visibility.includes('PARTNER') && !row.visibility.includes('LINK'))) throw new NotFoundError('File not found.')
  await commandOn(app, system, { name: 'repairsDepth.openFile', idempotencyKey, input: { fileId, mode, ...who.actor } }, async (tools) => {
    tools.audit({ recordType: 'StoredFile', recordId: row.id, companyId: who.place.companyId, after: { mode, recordType: row.recordType, recordId: row.recordId, sha256: row.sha256, ...who.actor } })
    return null
  })
  return presignOpen(files, request, who.tenantId, row, mode)
}

import type { FastifyRequest } from 'fastify'
import { FILES_READ, FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { PRODUCTION_INSTRUCTIONS_MANAGE } from '@nexus/factory-domain/production/instructions/permissions'
import { mediaTypeProblem, type MediaKind } from '@nexus/factory-domain/production/instructions/rules'
import type { CommandCaller } from '../../../core/command'
import { SYSTEM_ACTOR_ID, type SystemContext } from '../../../core/context'
import { completeUpload, downloadFile, requestUpload, systemCallerOf } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { floorOf } from '../scans/access'
import { assertMay, FILE_RECORD, officeOf, readInstruction, refuse, type Db } from './store'

/**
 * The photos and short videos of a work instruction (B-W2b-214; PRD-117; design production.instructions › Media "upload;
 * attach to a step", floor.instructions "big photo or a muted looping video"):
 *
 *   POST /production/instructions/:id/files (+ /:fileId/complete)   the office announces a PHOTO or VIDEO, PUTs it to the
 *                                                                   presigned address, confirms it; the editor's save then
 *                                                                   puts it on a step of a draft (StoredFile of the
 *                                                                   instruction, OFFICE only)
 *   GET  /production/instructions/floor/media/:mediaId/download     a tablet's look at one medium of a published or
 *                                                                   superseded version
 *
 * The files go through platform/files (types, size, the presigned PUT, the store's check, the virus scan) as the tenant's
 * system caller holding exactly files.upload (files.read for the floor's look) over the instruction's company, after this
 * module's own check (production.instructions.manage; the floor: production.scan at its site). A video is a PHOTO file with a
 * video type and the PHOTO size limit (platform/files UploadPath.clip: no video kind of file yet). An instruction is often
 * for every style and seen on every site of its company: its files stay OFFICE files and a tablet gets them through this
 * module, never through the files routes (a floor file is pinned to one site).
 */

export interface AnnounceBody {
  readonly kind: MediaKind
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
}

/** The tenant's system caller for one company's files only. */
function companyCaller(request: FastifyRequest, tenantId: string, companyId: string, permissions: readonly Permission[]): CommandCaller {
  const view = Object.create(request) as FastifyRequest
  const grant: Grant = { permissions: [...permissions], companies: [companyId], sites: 'all', parties: 'all' }
  const context: SystemContext = Object.freeze({ audience: 'system', tenantId, actorId: SYSTEM_ACTOR_ID, requestId: String(request.id), grants: [grant] })
  view.factoryContext = context
  return view
}

/** POST /production/instructions/:instructionId/files. */
export async function announceMedia(request: FastifyRequest, instructionId: string, body: AnnounceBody, idempotencyKey?: string) {
  const context = officeOf(request)
  const instruction = await request.withClient((client) => readInstruction(client as Db, context, instructionId))
  assertMay(context, PRODUCTION_INSTRUCTIONS_MANAGE, instruction.companyId, 'You add photos and videos to work instructions only for the companies your role reaches (production.instructions.manage).')
  const wrong = mediaTypeProblem(body.kind, body.contentType.trim())
  if (wrong) throw new ValidationError(wrong, [{ path: 'body/contentType', message: wrong }])
  if (instruction.status !== 'ACTIVE') refuse({ code: 'ARCHIVED', message: `${instruction.number} is archived: restore it before adding photos or videos.` })
  return requestUpload(
    processFiles(),
    companyCaller(request, context.tenantId, instruction.companyId, [FILES_UPLOAD]),
    {
      companyId: instruction.companyId,
      recordType: FILE_RECORD,
      recordId: instruction.id,
      kind: 'PHOTO',
      originalName: body.originalName,
      contentType: body.contentType,
      sizeBytes: body.sizeBytes,
      sha256: body.sha256,
      visibility: ['OFFICE'],
    },
    idempotencyKey,
    body.kind === 'VIDEO' ? { clip: true } : {},
  )
}

/** POST /production/instructions/:instructionId/files/:fileId/complete. */
export async function completeMedia(request: FastifyRequest, instructionId: string, fileId: string, idempotencyKey?: string) {
  const context = officeOf(request)
  const instruction = await request.withClient((client) => readInstruction(client as Db, context, instructionId))
  assertMay(context, PRODUCTION_INSTRUCTIONS_MANAGE, instruction.companyId, 'You add photos and videos to work instructions only for the companies your role reaches (production.instructions.manage).')
  const uploader = companyCaller(request, context.tenantId, instruction.companyId, [FILES_UPLOAD])
  const file = isUuid(fileId) ? await uploader.withClient((client) => client.storedFile.findFirst({ where: { id: fileId, recordType: FILE_RECORD, recordId: instruction.id, kind: 'PHOTO' }, select: { id: true } })) : null
  if (!file) throw new NotFoundError('File not found.')
  return { file: await completeUpload(processFiles(), uploader, fileId, idempotencyKey) }
}

/**
 * GET /production/instructions/floor/media/:mediaId/download: one photo or video of a version the floor reads (published or
 * superseded: the floor role's policy hides the rest), of an instruction of the tablet's company.
 */
export async function floorMediaDownload(request: FastifyRequest, mediaId: string) {
  const context = floorOf(request)
  const medium = isUuid(mediaId) ? await request.withClient((client) => client.workInstructionMedia.findUnique({ where: { id: mediaId }, select: { id: true, versionId: true, fileId: true } })) : null
  if (!medium) throw new NotFoundError('Photo or video not found.')
  const owner = await request.withClient(async (client) => {
    const version = await client.workInstructionVersion.findUnique({ where: { id: medium.versionId }, select: { instructionId: true } })
    const instruction = version ? await client.workInstruction.findUnique({ where: { id: version.instructionId }, select: { companyId: true } }) : null
    const site = await client.site.findUnique({ where: { id: context.siteId }, select: { companyId: true } })
    return instruction && site && instruction.companyId === site.companyId ? instruction.companyId : null
  })
  if (!owner) throw new NotFoundError('Photo or video not found.')
  const reader = companyCaller(request, context.tenantId, owner, [FILES_READ])
  return { download: await downloadFile(processFiles(), { caller: reader, system: systemCallerOf(request) }, medium.fileId) }
}

import type { FastifyRequest } from 'fastify'
import { FILES_READ, FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { SALES_SAFETY_MANAGE } from '@nexus/factory-domain/sales/safety-reports/permissions'
import { SAFETY_LIMITS, SAFETY_REPORT_RECORD } from '@nexus/factory-domain/sales/safety-reports/rules'
import { command, type CommandCaller } from '../../../core/command'
import { SYSTEM_ACTOR_ID, type SystemContext } from '../../../core/context'
import { completeUpload, downloadFile, requestUpload, systemCallerOf } from '../../../platform/files/files'
import { normaliseContentType } from '../../../platform/files/rules'
import { processFiles } from '../../../platform/files/service'
import { held, officeReport } from './access'
import { photosHeld } from './store'

/**
 * A report's photos (B-W2b-351; SAL-415 "photos"; design links.claim "Damage and fit photos"). A photo may show an injury: every
 * one is OFFICE ONLY and this module's own (platform/files/owned.ts: no generic upload, no generic read: files.read never reaches
 * it). The bytes go through platform/files (types, size, presigned PUT, the store's check, the virus scan) as the tenant's
 * system caller holding exactly files.upload (files.read to open) over the report's company, after this module's checks:
 *
 *   POST /sales/safety-reports/:id/photos (+ /:fileId/complete)     office, sales.safety.manage; while the report is not closed
 *   POST /sales/safety-reports/:id/photos/:fileId/open              office, sales.safety.view; each opening an audit row on the
 *                                                                   report (who opened which photo), then a presigned GET
 *   the public DoC page and the portal: photos after the send (./outside.ts), within SAFETY_LIMITS.outsidePhotoMinutes of it
 *
 * At most SAFETY_LIMITS.photos per report, of category DAMAGE_PHOTO.
 */

const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic']
const PHOTO_MAX_BYTES = 15 * 1_048_576

export interface PhotoBody {
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
}

export function photoProblems(body: PhotoBody): void {
  const problems = [
    ...(PHOTO_TYPES.includes(normaliseContentType(body.contentType)) ? [] : [{ path: 'body/contentType', message: 'A photo: JPEG, PNG, WebP or HEIC.' }]),
    ...(body.sizeBytes <= PHOTO_MAX_BYTES ? [] : [{ path: 'body/sizeBytes', message: 'At most 15 MB.' }]),
  ]
  if (problems.length > 0) throw new ValidationError('The photo cannot be sent as it stands.', problems)
}

/** The tenant's system caller holding exactly these permissions over one company. */
export function companyCaller(request: FastifyRequest, tenantId: string, companyId: string, permissions: readonly Permission[]): CommandCaller {
  const view = Object.create(request) as FastifyRequest
  const grant: Grant = { permissions: [...permissions], companies: [companyId], sites: 'all', parties: 'all' }
  const context: SystemContext = Object.freeze({ audience: 'system', tenantId, actorId: SYSTEM_ACTOR_ID, requestId: String(request.id), grants: [grant] })
  view.factoryContext = context
  return view
}

/** A photo of the report announced (the limit counted first): the presigned PUT. */
export async function announceReportPhoto(request: FastifyRequest, tenantId: string, report: { readonly id: string; readonly number: string; readonly companyId: string }, body: PhotoBody, idempotencyKey?: string) {
  photoProblems(body)
  const uploader = companyCaller(request, tenantId, report.companyId, [FILES_UPLOAD])
  if ((await uploader.withClient((db) => photosHeld(db, report.id))) >= SAFETY_LIMITS.photos) throw held('NO_PHOTOS_LEFT', report.number)
  const answer = await requestUpload(
    processFiles(),
    uploader,
    { companyId: report.companyId, recordType: SAFETY_REPORT_RECORD, recordId: report.id, kind: 'PHOTO', category: 'DAMAGE_PHOTO', originalName: body.originalName, contentType: normaliseContentType(body.contentType), sizeBytes: body.sizeBytes, sha256: body.sha256, visibility: ['OFFICE'] },
    idempotencyKey,
    { viaModule: true },
  )
  return { file: { id: answer.file.id, originalName: answer.file.originalName, sizeBytes: answer.file.sizeBytes, status: answer.file.status }, upload: answer.upload }
}

/** A photo of the report confirmed once its bytes are in. */
export async function completeReportPhoto(request: FastifyRequest, tenantId: string, report: { readonly id: string; readonly companyId: string }, fileId: string, idempotencyKey?: string) {
  const uploader = companyCaller(request, tenantId, report.companyId, [FILES_UPLOAD])
  const file = isUuid(fileId) ? await uploader.withClient((db) => db.storedFile.findFirst({ where: { id: fileId, recordType: SAFETY_REPORT_RECORD, recordId: report.id, kind: 'PHOTO' }, select: { id: true } })) : null
  if (!file) throw new NotFoundError('File not found.')
  const view = await completeUpload(processFiles(), uploader, fileId, idempotencyKey, { viaModule: true })
  return { file: { id: view.id, originalName: view.originalName, sizeBytes: view.sizeBytes, status: view.status } }
}

/** POST /sales/safety-reports/:reportId/photos */
export async function announceOfficePhoto(request: FastifyRequest, reportId: string, body: PhotoBody, idempotencyKey?: string) {
  const { context, row } = await officeReport(request, reportId, SALES_SAFETY_MANAGE)
  if (row.status === 'CLOSED') throw held('CLOSED', row.number)
  return announceReportPhoto(request, context.tenantId, row, body, idempotencyKey)
}

/** POST /sales/safety-reports/:reportId/photos/:fileId/complete */
export async function completeOfficePhoto(request: FastifyRequest, reportId: string, fileId: string, idempotencyKey?: string) {
  const { context, row } = await officeReport(request, reportId, SALES_SAFETY_MANAGE)
  return completeReportPhoto(request, context.tenantId, row, fileId, idempotencyKey)
}

/** POST /sales/safety-reports/:reportId/photos/:fileId/open — the opening recorded on the report, then a presigned GET. */
export async function openPhoto(request: FastifyRequest, reportId: string, fileId: string, idempotencyKey?: string) {
  const { context, row } = await officeReport(request, reportId)
  const file = isUuid(fileId) ? await request.withClient((db) => db.storedFile.findFirst({ where: { id: fileId, recordType: SAFETY_REPORT_RECORD, recordId: row.id, kind: 'PHOTO', status: 'AVAILABLE' }, select: { id: true } })) : null
  if (!file) throw new NotFoundError('File not found.')
  await command(request, { name: 'safetyReports.photoOpened', idempotencyKey, input: { reportId: row.id, fileId: file.id } }, async (tools) => {
    tools.audit({ action: 'safetyReports.photoOpened', recordType: SAFETY_REPORT_RECORD, recordId: row.id, companyId: row.companyId, after: { fileId: file.id } })
    return { opened: true }
  })
  const reader = companyCaller(request, context.tenantId, row.companyId, [FILES_READ])
  return { download: await downloadFile(processFiles(), { caller: reader, system: systemCallerOf(request) }, file.id, { viaModule: true }) }
}

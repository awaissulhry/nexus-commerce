import type { FastifyRequest } from 'fastify'
import { FILES_MANAGE, FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ForbiddenError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Grant, type Permission } from '@nexus/factory-domain/core/permissions'
import { SALES_RETURNS_INSPECT, SALES_RETURNS_RECEIVE } from '@nexus/factory-domain/sales/returns/permissions'
import { isFinal, RETURN_LIMITS, type ReturnStatus } from '@nexus/factory-domain/sales/returns/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf, SYSTEM_ACTOR_ID, type SystemContext } from '../../../core/context'
import { completeUpload, requestUpload } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { dockReturn } from './access'
import { LINE_RECORD, RECEIPT_RECORD, type FloorRmaRow } from './store'

/**
 * Photos at the dock (B-W2a-43; LOG-114 "Condition with photos at the dock", QHS-117 "Return inspection with photos";
 * design floor.returnsin "photos of parcel and contents ('products only')", rma.inspection "Photos"). Each is a PHOTO file
 * (platform/files: JPEG, PNG, WebP, HEIC) of its record — a receipt's of the ReturnReceipt, a garment's of the
 * ReturnLine — announced here, PUT to the presigned URL, then confirmed with …/complete. As the receiving photos of
 * B-W2a-31:
 *
 *   POST /sales/returns/:returnId/receipts/:receiptId/photos (+ /:fileId/complete)   office and floor, sales.returns.receive
 *   POST /sales/returns/:returnId/lines/:lineId/photos (+ /:fileId/complete)         office and floor, sales.returns.inspect
 *
 * The office also needs files.upload over the RMA's company. A dock tablet may not write files itself (its role reads
 * its site's floor files only), so after the floor's own checks (the permission at the device's site, an RMA of that
 * site) the files module is called as the tenant's system caller holding exactly files.upload and files.manage over the
 * RMA's company and site: the photo is the office's and the site's floor files (OFFICE + FLOOR, floorSiteId the site),
 * never another site's or the customer's. At most RETURN_LIMITS.photos per record; none on a closed return.
 */

export interface PhotoUpload {
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
}

function siteUploader(request: FastifyRequest, tenantId: string, rma: FloorRmaRow): CommandCaller {
  const view = Object.create(request) as FastifyRequest
  const grant: Grant = { permissions: [FILES_UPLOAD, FILES_MANAGE], companies: [rma.companyId], sites: [rma.siteId], parties: 'all' }
  const context: SystemContext = Object.freeze({ audience: 'system', tenantId, actorId: SYSTEM_ACTOR_ID, requestId: String(request.id), grants: [grant] })
  view.factoryContext = context
  return view
}

/** The record a photo goes on and who uploads it: the office (with files.upload) or the dock (the site's system caller). */
async function photoTarget(request: FastifyRequest, returnId: string, permission: Permission, record: { readonly type: string; readonly id: string }) {
  const { context, rma } = await dockReturn(request, returnId, permission)
  if (context.audience === 'office' && !can(actorOf(context), FILES_UPLOAD, { companyId: rma.companyId, siteId: rma.siteId })) throw new ForbiddenError(`Adding a photo needs ${FILES_UPLOAD} over the company.`)
  const found = isUuid(record.id)
    ? record.type === RECEIPT_RECORD
      ? await request.withClient((client) => client.returnReceipt.findFirst({ where: { id: record.id, returnId: rma.id }, select: { id: true } }))
      : await request.withClient((client) => client.returnLine.findFirst({ where: { id: record.id, returnId: rma.id }, select: { id: true } }))
    : null
  if (!found) throw new NotFoundError(record.type === RECEIPT_RECORD ? 'Receipt not found.' : 'Return line not found.')
  const uploader = context.audience === 'floor' ? siteUploader(request, context.tenantId, rma) : request
  return { rma, uploader, floor: context.audience === 'floor' }
}

async function announce(request: FastifyRequest, returnId: string, permission: Permission, record: { readonly type: string; readonly id: string }, body: PhotoUpload, idempotencyKey?: string) {
  const { rma, uploader, floor } = await photoTarget(request, returnId, permission, record)
  if (isFinal(rma.status as ReturnStatus)) throw new InvalidStateError(`Return ${rma.number} is ${rma.status.toLowerCase()}: it takes no photo.`)
  const held = await uploader.withClient((client) => client.storedFile.count({ where: { recordType: record.type, recordId: record.id, kind: 'PHOTO', status: { not: 'DELETED' } } }))
  if (held >= RETURN_LIMITS.photos) throw new InvalidStateError(`It holds ${RETURN_LIMITS.photos} photos already.`)
  return requestUpload(
    processFiles(),
    uploader,
    {
      companyId: rma.companyId,
      recordType: record.type,
      recordId: record.id,
      kind: 'PHOTO',
      originalName: body.originalName,
      contentType: body.contentType,
      sizeBytes: body.sizeBytes,
      sha256: body.sha256,
      ...(floor ? { visibility: ['OFFICE', 'FLOOR'] as const, floorSiteId: rma.siteId } : {}),
    },
    idempotencyKey,
    { viaModule: true },
  )
}

async function complete(request: FastifyRequest, returnId: string, permission: Permission, record: { readonly type: string; readonly id: string }, fileId: string, idempotencyKey?: string) {
  const { uploader } = await photoTarget(request, returnId, permission, record)
  const file = isUuid(fileId) ? await uploader.withClient((client) => client.storedFile.findFirst({ where: { id: fileId, recordType: record.type, recordId: record.id, kind: 'PHOTO' }, select: { id: true } })) : null
  if (!file) throw new NotFoundError('Photo not found.')
  return { file: await completeUpload(processFiles(), uploader, fileId, idempotencyKey, { viaModule: true }) }
}

export const announceReceiptPhoto = (request: FastifyRequest, returnId: string, receiptId: string, body: PhotoUpload, key?: string) => announce(request, returnId, SALES_RETURNS_RECEIVE, { type: RECEIPT_RECORD, id: receiptId }, body, key)
export const completeReceiptPhoto = (request: FastifyRequest, returnId: string, receiptId: string, fileId: string, key?: string) => complete(request, returnId, SALES_RETURNS_RECEIVE, { type: RECEIPT_RECORD, id: receiptId }, fileId, key)
export const announceLinePhoto = (request: FastifyRequest, returnId: string, lineId: string, body: PhotoUpload, key?: string) => announce(request, returnId, SALES_RETURNS_INSPECT, { type: LINE_RECORD, id: lineId }, body, key)
export const completeLinePhoto = (request: FastifyRequest, returnId: string, lineId: string, fileId: string, key?: string) => complete(request, returnId, SALES_RETURNS_INSPECT, { type: LINE_RECORD, id: lineId }, fileId, key)

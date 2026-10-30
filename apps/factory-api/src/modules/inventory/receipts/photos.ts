import type { FastifyRequest } from 'fastify'
import { FILES_MANAGE, FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ForbiddenError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Grant } from '@nexus/factory-domain/core/permissions'
import { INVENTORY_RECEIVE } from '@nexus/factory-domain/inventory/permissions'
import { DISCREPANCY_LIMITS } from '@nexus/factory-domain/inventory/receipts/discrepancies'
import { INVENTORY_DISCREPANCIES_MANAGE } from '@nexus/factory-domain/inventory/receipts/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf, SYSTEM_ACTOR_ID, type FloorContext, type SystemContext } from '../../../core/context'
import { completeUpload, requestUpload } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { DISCREPANCY_RECORD } from './discrepancies'
import { visibleReceipt } from './read'
import { RECEIPT_COLUMNS, type Reader, type ReceiptRow } from './store'

/**
 * Photos at receiving (B-W2a-31): the supplier's delivery note (SCM-115; design floor.receive sec "ddt" and
 * warehouse.receipts rc-docs "the supplier DDT photo") and what was wrong with the goods (SCM-118, a discrepancy's
 * photos). Each is a PHOTO file (platform/files: JPEG, PNG, WebP, HEIC) of its record — the delivery note's of the
 * GoodsReceipt, a discrepancy's of the ReceiptDiscrepancy — announced here, PUT to the presigned URL, then confirmed
 * with …/complete (AVAILABLE, or QUARANTINED when what arrived differs). As the write-off's photos (B-W2a-11).
 *
 *   POST /inventory/receipts/:receiptId/ddt-photos (+ /:fileId/complete)   office and floor, inventory.receive
 *   POST /inventory/receipts/:receiptId/discrepancies/:discrepancyId/photos (+ /:fileId/complete)
 *                                                                           office, inventory.discrepancies.manage
 *
 * The office also needs files.upload over the receipt's company. A goods-in tablet may not write files (its role reads
 * its site's floor files only), so after the floor's own checks — inventory.receive at the device's site, a receipt of
 * that site — the files module is called as the tenant's system caller holding exactly files.upload and files.manage
 * over the receipt's company and site: the photo is the office's and the site's floor files (visibility OFFICE + FLOOR,
 * floorSiteId the site), never another site's or a party's. At most DISCREPANCY_LIMITS.photos per record.
 */

export interface PhotoUpload {
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
}

const RECEIPT_RECORD = 'GoodsReceipt'

/** The tenant's system caller with files.upload and files.manage over this receipt's company and site only. */
function siteUploader(request: FastifyRequest, tenantId: string, receipt: ReceiptRow): CommandCaller {
  const view = Object.create(request) as FastifyRequest
  const grant: Grant = { permissions: [FILES_UPLOAD, FILES_MANAGE], companies: [receipt.companyId], sites: [receipt.siteId], parties: 'all' }
  const context: SystemContext = Object.freeze({ audience: 'system', tenantId, actorId: SYSTEM_ACTOR_ID, requestId: String(request.id), grants: [grant] })
  view.factoryContext = context
  return view
}

/** The receipt a photo of its delivery note goes on: office (inventory.receive + files.upload) or the device's site. */
async function ddtReceipt(request: FastifyRequest, receiptId: string): Promise<{ receipt: ReceiptRow; uploader: CommandCaller; floor: FloorContext | null }> {
  const context = request.factoryContext
  if (context?.audience === 'floor') {
    const receipt = isUuid(receiptId) ? await request.withClient((client) => client.goodsReceipt.findUnique({ where: { id: receiptId }, select: RECEIPT_COLUMNS })) : null
    if (!receipt || receipt.siteId !== context.siteId || !can(actorOf(context), INVENTORY_RECEIVE, { companyId: receipt.companyId, siteId: receipt.siteId })) throw new NotFoundError('Goods receipt not found.')
    return { receipt, uploader: siteUploader(request, context.tenantId, receipt), floor: context }
  }
  const { context: office, receipt } = await visibleReceipt(request, receiptId, INVENTORY_RECEIVE)
  if (!can(actorOf(office), FILES_UPLOAD, { companyId: receipt.companyId, siteId: receipt.siteId })) throw new ForbiddenError(`Adding a photo needs ${FILES_UPLOAD} over the company.`)
  return { receipt, uploader: request, floor: null }
}

async function photoCount(db: Reader, recordType: string, recordId: string): Promise<number> {
  return db.storedFile.count({ where: { recordType, recordId, kind: 'PHOTO', status: { not: 'DELETED' } } })
}

/** POST /inventory/receipts/:receiptId/ddt-photos: a photo of the supplier's delivery note, then the presigned PUT. */
export async function announceDdtPhoto(request: FastifyRequest, receiptId: string, body: PhotoUpload, idempotencyKey?: string) {
  const { receipt, uploader, floor } = await ddtReceipt(request, receiptId)
  if (receipt.status === 'CANCELLED') throw new InvalidStateError(`Receipt ${receipt.number} was cancelled: it takes no photo.`)
  const held = await uploader.withClient((client) => photoCount(client, RECEIPT_RECORD, receipt.id))
  if (held >= DISCREPANCY_LIMITS.photos) throw new InvalidStateError(`Receipt ${receipt.number} holds ${DISCREPANCY_LIMITS.photos} photos already.`)
  return requestUpload(
    processFiles(),
    uploader,
    {
      companyId: receipt.companyId,
      recordType: RECEIPT_RECORD,
      recordId: receipt.id,
      kind: 'PHOTO',
      originalName: body.originalName,
      contentType: body.contentType,
      sizeBytes: body.sizeBytes,
      sha256: body.sha256,
      ...(floor ? { visibility: ['OFFICE', 'FLOOR'] as const, floorSiteId: receipt.siteId } : {}),
    },
    idempotencyKey,
    { viaModule: true },
  )
}

/** POST /inventory/receipts/:receiptId/ddt-photos/:fileId/complete */
export async function completeDdtPhoto(request: FastifyRequest, receiptId: string, fileId: string, idempotencyKey?: string) {
  const { receipt, uploader } = await ddtReceipt(request, receiptId)
  const file = isUuid(fileId) ? await uploader.withClient((client) => client.storedFile.findFirst({ where: { id: fileId, recordType: RECEIPT_RECORD, recordId: receipt.id, kind: 'PHOTO' }, select: { id: true } })) : null
  if (!file) throw new NotFoundError('Photo not found.')
  return { file: await completeUpload(processFiles(), uploader, fileId, idempotencyKey, { viaModule: true }) }
}

/** The discrepancy a photo goes on (office: inventory.discrepancies.manage at the receipt, files.upload), not CLOSED. */
async function discrepancyFor(caller: CommandCaller, receiptId: string, discrepancyId: string) {
  const { context, receipt } = await visibleReceipt(caller, receiptId, INVENTORY_DISCREPANCIES_MANAGE)
  if (!can(actorOf(context), FILES_UPLOAD, { companyId: receipt.companyId, siteId: receipt.siteId })) throw new ForbiddenError(`Adding a photo needs ${FILES_UPLOAD} over the company.`)
  const row = isUuid(discrepancyId) ? await caller.withClient((client) => client.receiptDiscrepancy.findFirst({ where: { id: discrepancyId, receiptId: receipt.id }, select: { id: true, seq: true, status: true } })) : null
  if (!row) throw new NotFoundError('Discrepancy not found.')
  return { receipt, row }
}

/** POST /inventory/receipts/:receiptId/discrepancies/:discrepancyId/photos */
export async function announceDiscrepancyPhoto(caller: CommandCaller, receiptId: string, discrepancyId: string, body: PhotoUpload, idempotencyKey?: string) {
  const { receipt, row } = await discrepancyFor(caller, receiptId, discrepancyId)
  if (row.status === 'CLOSED') throw new InvalidStateError(`Discrepancy ${row.seq} is closed: it takes no photo.`)
  const held = await caller.withClient((client) => photoCount(client, DISCREPANCY_RECORD, row.id))
  if (held >= DISCREPANCY_LIMITS.photos) throw new InvalidStateError(`Discrepancy ${row.seq} holds ${DISCREPANCY_LIMITS.photos} photos already.`)
  return requestUpload(
    processFiles(),
    caller,
    { companyId: receipt.companyId, recordType: DISCREPANCY_RECORD, recordId: row.id, kind: 'PHOTO', originalName: body.originalName, contentType: body.contentType, sizeBytes: body.sizeBytes, sha256: body.sha256 },
    idempotencyKey,
    { viaModule: true },
  )
}

/** POST /inventory/receipts/:receiptId/discrepancies/:discrepancyId/photos/:fileId/complete */
export async function completeDiscrepancyPhoto(caller: CommandCaller, receiptId: string, discrepancyId: string, fileId: string, idempotencyKey?: string) {
  const { row } = await discrepancyFor(caller, receiptId, discrepancyId)
  const file = isUuid(fileId) ? await caller.withClient((client) => client.storedFile.findFirst({ where: { id: fileId, recordType: DISCREPANCY_RECORD, recordId: row.id, kind: 'PHOTO' }, select: { id: true } })) : null
  if (!file) throw new NotFoundError('Photo not found.')
  return { file: await completeUpload(processFiles(), caller, fileId, idempotencyKey, { viaModule: true }) }
}

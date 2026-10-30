import type { FastifyRequest } from 'fastify'
import { FILES_MANAGE, FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { answerProblem } from '@nexus/factory-domain/purchasing/confirm/answer'
import { idempotencyKeyFrom, type CommandCaller, type CommandTx } from '../../../core/command'
import { SYSTEM_ACTOR_ID, type SystemContext } from '../../../core/context'
import { completeUpload, requestUpload } from '../../../platform/files/files'
import { normaliseContentType } from '../../../platform/files/rules'
import { processFiles } from '../../../platform/files/service'
import { linkUnavailable } from '../../../platform/links/authenticator'
import { confirmLinkOf } from './read'

/**
 * The supplier's own confirmation PDF on its PO_CONFIRM link (B-W1-33 for SCR-100; SCM-090; design links.po "answer":
 * "your confirmation PDF (optional upload)"), before it answers:
 *
 *   announce  POST /link/purchase-order/confirmation {originalName, contentType, sizeBytes, sha256} (links.confirm): the
 *             link's own order, still answerable (SENT), at most MAX_SUPPLIER_FILES of them; a PDF of at most 20 MB →
 *             platform/files requestUpload → the presigned PUT. The file is the order's (recordType PurchaseOrder,
 *             kind DOCUMENT), of the buying company, shared with the office and with link sessions of the supplier's
 *             party (so the answer, in the link's scope, can check it; the office sees it among the order's files).
 *   confirm   POST /link/purchase-order/confirmation/:fileId/complete → files completeUpload (AVAILABLE, or QUARANTINED
 *             when what arrived differs from what was announced).
 *   answer    POST /link/purchase-order/confirm {…, confirmationFileId}: the answer checks it is an AVAILABLE PDF of this
 *             order and records it with the answer (answer.ts).
 *
 * The link session may not write files (its role reads them only), so the files module is called as the tenant's system
 * caller holding exactly files.upload and files.manage over the order's company and the supplier's party, AFTER the link
 * was checked here: never a file of another order, company or party. Nothing here is a price.
 */

/** How many documents a supplier may put on one order through its links. */
export const MAX_SUPPLIER_FILES = 5
const MAX_BYTES = 20 * 1_048_576
const PDF = 'application/pdf'

export interface ConfirmationUpload {
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
}

/** The tenant's system caller with files.upload and files.manage over this order's company and party only. */
function supplierUploader(request: FastifyRequest, tenantId: string, companyId: string, partyId: string): CommandCaller {
  const view = Object.create(request) as FastifyRequest
  const grant: Grant = { permissions: [FILES_UPLOAD, FILES_MANAGE], companies: [companyId], sites: 'all', parties: [partyId] }
  const context: SystemContext = Object.freeze({ audience: 'system', tenantId, actorId: SYSTEM_ACTOR_ID, requestId: String(request.id), grants: [grant] })
  view.factoryContext = context
  return view
}

/** The link's order as its own scope sees it; answerable now (SENT), else why not. */
async function answerableOrder(request: FastifyRequest) {
  const link = confirmLinkOf(request)
  const order = await request.withClient((client) => client.purchaseOrder.findUnique({ where: { id: link.record.id }, select: { id: true, companyId: true, partyId: true, status: true } }))
  if (!order) throw linkUnavailable()
  const problem = answerProblem(order.status)
  if (problem) throw new InvalidStateError(problem)
  return { link, order }
}

const fileOf = (file: { id: string; originalName: string; sizeBytes: number; status: 'PENDING_UPLOAD' | 'AVAILABLE' | 'QUARANTINED' | 'DELETED' }) => ({ id: file.id, originalName: file.originalName, sizeBytes: file.sizeBytes, status: file.status })

/** POST /link/purchase-order/confirmation. */
export async function announceConfirmation(request: FastifyRequest, body: ConfirmationUpload) {
  const { link, order } = await answerableOrder(request)
  const problems = [
    ...(normaliseContentType(body.contentType) === PDF ? [] : [{ path: 'body/contentType', message: 'Your confirmation is a PDF (application/pdf).' }]),
    ...(body.sizeBytes <= MAX_BYTES ? [] : [{ path: 'body/sizeBytes', message: 'At most 20 MB.' }]),
  ]
  if (problems.length > 0) throw new ValidationError('The upload is not valid.', problems)
  const held = await request.withClient((client) => client.storedFile.count({ where: { recordType: 'PurchaseOrder', recordId: order.id, kind: 'DOCUMENT', status: { not: 'DELETED' } } }))
  if (held >= MAX_SUPPLIER_FILES) throw new InvalidStateError(`This order holds ${MAX_SUPPLIER_FILES} of your documents already: send your answer, or reply to our e-mail.`)
  const answer = await requestUpload(
    processFiles(),
    supplierUploader(request, link.tenantId, order.companyId, order.partyId),
    { companyId: order.companyId, recordType: 'PurchaseOrder', recordId: order.id, kind: 'DOCUMENT', originalName: body.originalName, contentType: PDF, sizeBytes: body.sizeBytes, sha256: body.sha256, visibility: ['OFFICE', 'LINK'], partyId: order.partyId },
    idempotencyKeyFrom(request),
  )
  return { file: fileOf(answer.file), upload: answer.upload }
}

/** POST /link/purchase-order/confirmation/:fileId/complete. */
export async function completeConfirmation(request: FastifyRequest, fileId: string) {
  const { link, order } = await answerableOrder(request)
  const file = isUuid(fileId)
    ? await request.withClient((client) => client.storedFile.findFirst({ where: { id: fileId, recordType: 'PurchaseOrder', recordId: order.id, kind: 'DOCUMENT' }, select: { id: true } }))
    : null
  if (!file) throw new NotFoundError('File not found.')
  const view = await completeUpload(processFiles(), supplierUploader(request, link.tenantId, order.companyId, order.partyId), fileId, idempotencyKeyFrom(request))
  return { file: fileOf(view) }
}

/** Inside the answer's command (the link's scope): the supplier's confirmation PDF it names, ready, of this order. */
export async function confirmationFileOf(tx: CommandTx, orderId: string, fileId: string | null | undefined) {
  if (!fileId) return null
  const file = isUuid(fileId)
    ? await tx.storedFile.findFirst({ where: { id: fileId, recordType: 'PurchaseOrder', recordId: orderId, kind: 'DOCUMENT', status: 'AVAILABLE', contentType: PDF }, select: { id: true, originalName: true, sizeBytes: true, status: true } })
    : null
  if (!file) {
    throw new ValidationError('Your confirmation PDF is not ready: upload it again, or send your answer without it.', [{ path: 'body/confirmationFileId', message: 'An uploaded PDF of this order.' }])
  }
  return fileOf(file)
}

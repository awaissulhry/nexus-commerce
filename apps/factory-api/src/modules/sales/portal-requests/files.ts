import type { FastifyInstance, FastifyRequest } from 'fastify'
import { DomainError, ForbiddenError } from '@nexus/factory-domain/core/errors'
import { isOpen, type InquiryStatus } from '@nexus/factory-domain/sales/inquiries/rules'
import { portalUploadWords } from '@nexus/factory-domain/threads/partner/uploads'
import type { FilesRuntime } from '../../../platform/files/service'
import { announcePartnerFile, completePartnerFile, postPartnerMessage, type PartnerFileBody } from '../../../platform/threads/partner/service'
import { portalReader } from '../portal-orders/access'
import { partnerRequest } from './views'

/**
 * B-TH-085 (threads plan TH-7, the rest of G1; P-CUS-NEW.files "Attach like an e-mail", X-P-CUS-REQ.thread; walls W25, W37): the
 * request takes files after Send. "New order" sends the words first (POST /portal/inquiries makes the request and its first
 * message); then each file goes up onto the request, and one more message of the customer carries them into the request's thread:
 *
 *   POST /portal/inquiries/:inquiryId/files                    a file announced (where to PUT its bytes, 5 minutes)
 *   POST /portal/inquiries/:inquiryId/files/:fileId/complete   its bytes arrived (with the virus scanner: held until clean)
 *   POST /portal/inquiries/:inquiryId/files/attach             one message of the customer with those files (and words, if any)
 *
 * Only the party's own request in the portal's company (another's is not found: W37), while the office has not decided it (NEW,
 * ASSIGNED, NEED_INFO; after that the request's messages take files: the thread composer's own route), by a person who sends
 * requests (portal.orderRequests.manage, the route) and holds the upload capability (portal.upload), never an office preview. The
 * rest — the outside-upload gate (closed on staging and production until the scanner runs), the record's own party, the kinds and
 * sizes, the measurement tick, the count — is platform/threads/partner's, the same for every record of the portal.
 */

/** The party's own request, still undecided, or the refusal in the person's words. */
async function openRequest(app: FastifyInstance, request: FastifyRequest, inquiryId: string) {
  const reader = portalReader(app, request)
  if (reader.session.preview) throw new ForbiddenError('A preview of the portal sends no file.')
  const row = await partnerRequest(request, reader.session.company.id, inquiryId)
  if (!isOpen(row.status as InquiryStatus)) {
    const words = portalUploadWords('REQUEST_CLOSED', reader.session.person.locale)
    throw new DomainError('invalid_state', words, [{ path: 'refusal/REQUEST_CLOSED', message: words }])
  }
  return row
}

export async function announceRequestFile(files: FilesRuntime, app: FastifyInstance, request: FastifyRequest, inquiryId: string, body: PartnerFileBody, idempotencyKey?: string) {
  const row = await openRequest(app, request, inquiryId)
  return announcePartnerFile(files, request, { type: 'Inquiry', id: row.id }, body, idempotencyKey, { requester: true })
}

export async function completeRequestFile(files: FilesRuntime, app: FastifyInstance, request: FastifyRequest, inquiryId: string, fileId: string, idempotencyKey?: string) {
  const row = await openRequest(app, request, inquiryId)
  return completePartnerFile(files, request, { type: 'Inquiry', id: row.id }, fileId, idempotencyKey, { requester: true })
}

export interface AttachBody {
  readonly fileIds: readonly string[]
  readonly body?: string | null | undefined
}

/** One message of the customer carrying the files it sent (each AVAILABLE, of the request, shared with the party). */
export async function attachRequestFiles(app: FastifyInstance, request: FastifyRequest, inquiryId: string, body: AttachBody, idempotencyKey?: string) {
  const row = await openRequest(app, request, inquiryId)
  return postPartnerMessage(request, { type: 'Inquiry', id: row.id }, { body: body.body ?? '', attachments: [...body.fileIds] }, idempotencyKey, { requester: true })
}

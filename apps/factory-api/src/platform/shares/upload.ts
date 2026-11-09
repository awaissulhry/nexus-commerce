import type { FastifyRequest } from 'fastify'
import { FILES_MANAGE, FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import type { CommandCaller } from '../../core/command'
import { SYSTEM_ACTOR_ID, type SystemContext } from '../../core/context'
import { completeUpload, requestUpload } from '../files/files'
import { assertOutsideUploadsOpen } from '../files/multipart/outside'
import { normaliseContentType, type FileStatus } from '../files/rules'
import { processFiles } from '../files/service'
import { linkCommand, useLink } from '../links/use'
import { inviteLinkOf, mayOf, requireLiveShare, SHARE_UPLOAD_ACTION, UPLOAD_RULE } from './page'
import { heldRefusal } from './post'

/**
 * An invited partner adds a file to the shared record (B-W2b-200; COL-062 "upload"; design links.invite › Shared files
 * "Upload (when allowed)", FileDropzone), as the supplier adds its confirmation PDF on its PO link (B-W1-33):
 *
 *   announce  POST /link/share/files {originalName, contentType, sizeBytes, sha256} (links.upload): the share allows UPLOAD now;
 *             an ATTACHMENT of at most 25 MB of the kinds platform/files takes (PDF, pictures, office documents, CSV, text) →
 *             platform/files requestUpload → the presigned PUT. The file is the record's, of its company, shared with the
 *             office and with its party's links (LINK + the party): the person sees it in Shared files once it is AVAILABLE.
 *   complete  POST /link/share/files/:fileId/complete → files completeUpload (AVAILABLE, or QUARANTINED when what arrived
 *             differs from what was announced; with a virus scanner AVAILABLE only once CLEAN), then the link's evidence
 *             UPLOADED (never a counted use) and the audit row whose actor is the link (`mine` on the page).
 *
 * The link session may not write files (its role reads them only), so platform/files is called as the tenant's system caller
 * holding exactly files.upload and files.manage over the record's company and the share's party, AFTER the share was checked
 * here. In a live environment uploads from outside wait for the virus scanner (B-W2b-160, GATE-SPEND): 503 in words.
 */

export interface ShareUpload {
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
}

function uploader(request: FastifyRequest, tenantId: string, companyId: string, partyId: string): CommandCaller {
  const view = Object.create(request) as FastifyRequest
  const grant: Grant = { permissions: [FILES_UPLOAD, FILES_MANAGE], companies: [companyId], sites: 'all', parties: [partyId] }
  const context: SystemContext = Object.freeze({ audience: 'system', tenantId, actorId: SYSTEM_ACTOR_ID, requestId: String(request.id), grants: [grant] })
  view.factoryContext = context
  return view
}

/** The live share of the link, allowing uploads now; else the refusal at `held/NO_UPLOAD`. */
async function uploadingShare(request: FastifyRequest) {
  const link = inviteLinkOf(request)
  const share = await request.withClient((client) => requireLiveShare(request, client))
  const may = mayOf(share, null, true)
  if (may.uploadHeld) throw heldRefusal(may.uploadHeld)
  return { link, share }
}

const fileOf = (file: { id: string; originalName: string; contentType: string; sizeBytes: number; status: FileStatus }) => ({ id: file.id, originalName: file.originalName, contentType: file.contentType, sizeBytes: file.sizeBytes, status: file.status })

/** POST /link/share/files. */
export async function announceShareUpload(request: FastifyRequest, body: ShareUpload, idempotencyKey?: string) {
  // B-W2b-160 (FV1:02): an upload from outside waits for the virus scanner in a live environment (GATE-SPEND).
  assertOutsideUploadsOpen()
  const { link, share } = await uploadingShare(request)
  const contentType = normaliseContentType(body.contentType)
  const problems = [
    ...((UPLOAD_RULE.contentTypes as readonly string[]).includes(contentType) ? [] : [{ path: 'body/contentType', message: 'A PDF, a picture, an office document, a CSV or a text file.' }]),
    ...(body.sizeBytes <= UPLOAD_RULE.maxBytes ? [] : [{ path: 'body/sizeBytes', message: 'At most 25 MB.' }]),
  ]
  if (problems.length > 0) throw new ValidationError('The upload is not valid.', problems)
  const answer = await requestUpload(
    processFiles(),
    uploader(request, link.tenantId, share.companyId, share.partyId),
    { companyId: share.companyId, recordType: share.recordType, recordId: share.recordId, kind: 'ATTACHMENT', originalName: body.originalName, contentType, sizeBytes: body.sizeBytes, sha256: body.sha256, visibility: ['OFFICE', 'LINK'], partyId: share.partyId },
    idempotencyKey,
  )
  return { file: fileOf(answer.file), upload: answer.upload }
}

/** POST /link/share/files/:fileId/complete. */
export async function completeShareUpload(request: FastifyRequest, fileId: string, idempotencyKey?: string) {
  const { link, share } = await uploadingShare(request)
  // A pending upload is not the partner role's to read: the uploader (the system, held to this record's company and party)
  // finds it, and only a file of this record, of this party, shared with its links.
  const files = uploader(request, link.tenantId, share.companyId, share.partyId)
  const found = isUuid(fileId)
    ? await files.withClient((client) => client.storedFile.findFirst({ where: { id: fileId, recordType: share.recordType, recordId: share.recordId, kind: 'ATTACHMENT', partyId: share.partyId, visibility: { has: 'LINK' } }, select: { id: true } }))
    : null
  if (!found) throw new NotFoundError('File not found.')
  const view = await completeUpload(processFiles(), files, fileId, idempotencyKey)
  await linkCommand(request, { name: SHARE_UPLOAD_ACTION, idempotencyKey: idempotencyKey ? `${idempotencyKey.slice(0, 118)}:evidence` : undefined, input: { fileId } }, async (tools) => {
    await requireLiveShare(request, tools.tx)
    await useLink(tools, request, { action: 'upload' })
    tools.audit({ action: SHARE_UPLOAD_ACTION, recordType: 'StoredFile', recordId: fileId, companyId: share.companyId, after: { shareId: share.id, recordType: share.recordType, recordId: share.recordId, status: view.status } })
    return null
  })
  return { file: fileOf(view) }
}

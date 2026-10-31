import { FILES_DELETE, FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ForbiddenError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { PURCHASING_CLAIMS_MANAGE } from '@nexus/factory-domain/purchasing/claims/permissions'
import { photoProblems, type ClaimStatus } from '@nexus/factory-domain/purchasing/claims/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { completeUpload, deleteFile, requestUpload } from '../../../platform/files/files'
import type { FilesRuntime } from '../../../platform/files/service'
import { CLAIM_RECORD, officeClaim, type ClaimRow } from './store'

/**
 * Photos of what is wrong, on the claim itself (B-W2b-14; SCM-135; Z1:08; design purchasing.claims rec "Claim": "found at
 * (receipt, cutting), photos, area affected"): PHOTO files (JPEG, PNG, WebP, HEIC) of the SupplierClaim, category
 * CLAIM_PHOTO, announced here, PUT to the presigned URL, then confirmed with …/complete (AVAILABLE, or QUARANTINED when
 * what arrived differs) — as a receipt's DDT photo (B-W2a-31). The office's files (no sharing: sharing with the supplier
 * is files.manage, COL-050); the claim letter counts them ("n photos, available on request"). The photos of a receipt
 * discrepancy the claim pursues stay the discrepancy's (the claim's record shows them beside its own).
 *
 *   POST   /purchasing/claims/:claimId/photos (+ /:fileId/complete)   purchasing.claims.manage + files.upload: not
 *          settled (closed or cancelled), at most CLAIM_LIMITS.photos
 *   DELETE /purchasing/claims/:claimId/photos/:fileId?version=         purchasing.claims.manage + files.delete: a draft's
 */

export interface PhotoUpload {
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
}

const facts = (claim: ClaimRow) => ({ number: claim.number, status: claim.status as ClaimStatus })

async function writableClaim(caller: CommandCaller, claimId: string, permission: typeof FILES_UPLOAD | typeof FILES_DELETE) {
  const { context, claim } = await officeClaim(caller, claimId, PURCHASING_CLAIMS_MANAGE)
  if (!can(actorOf(context), permission, { companyId: claim.companyId, siteId: claim.siteId })) throw new ForbiddenError(`${permission === FILES_UPLOAD ? 'Adding' : 'Removing'} a photo needs ${permission} over the company.`)
  return claim
}

const heldPhotos = (caller: CommandCaller, claimId: string) => caller.withClient((client) => client.storedFile.count({ where: { recordType: CLAIM_RECORD, recordId: claimId, kind: 'PHOTO', status: { not: 'DELETED' } } }))

/** POST /purchasing/claims/:claimId/photos: a photo of what is wrong, then the presigned PUT. */
export async function announceClaimPhoto(files: FilesRuntime, caller: CommandCaller, claimId: string, body: PhotoUpload, idempotencyKey?: string) {
  const claim = await writableClaim(caller, claimId, FILES_UPLOAD)
  const problems = photoProblems(facts(claim), 'add', await heldPhotos(caller, claim.id))
  if (problems.length > 0) throw new InvalidStateError(problems.join(' '))
  return requestUpload(
    files,
    caller,
    { companyId: claim.companyId, recordType: CLAIM_RECORD, recordId: claim.id, kind: 'PHOTO', category: 'CLAIM_PHOTO', originalName: body.originalName, contentType: body.contentType, sizeBytes: body.sizeBytes, sha256: body.sha256 },
    idempotencyKey,
    { viaModule: true },
  )
}

async function photoOf(caller: CommandCaller, claim: ClaimRow, fileId: string) {
  const file = isUuid(fileId) ? await caller.withClient((client) => client.storedFile.findFirst({ where: { id: fileId, recordType: CLAIM_RECORD, recordId: claim.id, kind: 'PHOTO' }, select: { id: true, status: true } })) : null
  if (!file || file.status === 'DELETED') throw new NotFoundError('Photo not found.')
  return file
}

/** POST /purchasing/claims/:claimId/photos/:fileId/complete */
export async function completeClaimPhoto(files: FilesRuntime, caller: CommandCaller, claimId: string, fileId: string, idempotencyKey?: string) {
  const claim = await writableClaim(caller, claimId, FILES_UPLOAD)
  await photoOf(caller, claim, fileId)
  return { file: await completeUpload(files, caller, fileId, idempotencyKey, { viaModule: true }) }
}

/** DELETE /purchasing/claims/:claimId/photos/:fileId?version=: a draft's photo (taken by mistake). */
export async function removeClaimPhoto(files: FilesRuntime, caller: CommandCaller, claimId: string, fileId: string, query: { readonly version: number }, idempotencyKey?: string) {
  const claim = await writableClaim(caller, claimId, FILES_DELETE)
  const problems = photoProblems(facts(claim), 'remove')
  if (problems.length > 0) throw new InvalidStateError(problems.join(' '))
  await photoOf(caller, claim, fileId)
  return { file: await deleteFile(files, caller, fileId, { version: query.version, reason: `Removed from claim ${claim.number}` }, idempotencyKey) }
}

import type { FastifyRequest } from 'fastify'
import { FILES_MANAGE, FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ConflictError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addressLine, legalFooter, legalLines, legalName } from '@nexus/factory-domain/documents/legal'
import type { DocumentLanguage, PostalAddress } from '@nexus/factory-domain/documents/model'
import { dispositionOf, PREVIEW_URL_SECONDS, previewModeOf, type PreviewMode } from '@nexus/factory-domain/files/preview/rules'
import { CASE_LIMITS } from '@nexus/factory-domain/sales/portal-returns/rules'
import { returnInstructions } from '@nexus/factory-domain/sales/portal-returns/label'
import type { CommandCaller } from '../../../core/command'
import { requireContext, SYSTEM_ACTOR_ID, type SystemContext } from '../../../core/context'
import { companyLegalOf } from '../../../platform/documents/documents'
import { completeUpload, presignedView, requestUpload, storeCall, systemCallerOf } from '../../../platform/files/files'
import { assertOutsideUploadsOpen } from '../../../platform/files/multipart/outside'
import { normaliseContentType } from '../../../platform/files/rules'
import type { FilesRuntime } from '../../../platform/files/service'
import { keyShownTo } from '../../../platform/files/thumbs/outside'
import { renderEightD } from '../../quality/capa/report-pdf'
import { policyOf } from '../returns/policy'
import { COMPLAINT_RECORD, LINE_RECORD, readLines, RETURN_RECORD, type CaseRma, type Place, type Reader } from './store'

/**
 * Files of a case from outside (B-W2b-192), the same for a portal person and a claim link:
 *
 *   photos         the customer's photos of what is wrong (design links.claim "Damage and fit photos", rec Return › Request
 *                  "Add photos or information while not yet decided"): a PHOTO of the request, one of its lines, or the
 *                  complaint, announced here, PUT to the presigned URL, then confirmed. The partner role and a link may not
 *                  write files: after this module's checks (the case is theirs, still open to photos, the person's upload
 *                  right) the files module is called as the tenant's system with files.upload and files.manage over the
 *                  case's company and party only, the photo shared with the party (OFFICE, PARTNER, LINK). An upload from
 *                  outside waits for the virus scanner in a live environment (B-W2b-160, GATE-SPEND).
 *   open           a file of the party's case it is shown (shared PARTNER or LINK, AVAILABLE): ONE command writes the audit
 *                  row of who opened what (a portal person, a link), then a presigned GET of 60 seconds as the tenant's
 *                  system; a picture only as its copy without location data (files thumbs/outside).
 *   instructions   the return instructions to print once the office authorised the return (the domain's
 *                  returnInstructions laid out as the factory's letters, painted by the 8D painter): never stored, made
 *                  when asked.
 */

const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic']
const PHOTO_MAX_BYTES = 15 * 1_048_576

export interface PhotoUpload {
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
}

/** The tenant's system caller holding files.upload and files.manage over one company and one party only. */
export function partyUploader(request: FastifyRequest, tenantId: string, place: Place): CommandCaller {
  const view = Object.create(request) as FastifyRequest
  const grant: Grant = { permissions: [FILES_UPLOAD, FILES_MANAGE], companies: [place.companyId], sites: 'all', parties: [place.partyId] }
  const context: SystemContext = Object.freeze({ audience: 'system', tenantId, actorId: SYSTEM_ACTOR_ID, requestId: String(request.id), grants: [grant] })
  view.factoryContext = context
  return view
}

export function photoProblems(body: PhotoUpload) {
  const problems = [
    ...(PHOTO_TYPES.includes(normaliseContentType(body.contentType)) ? [] : [{ path: 'body/contentType', message: 'A photo: JPEG, PNG, WebP or HEIC.' }]),
    ...(body.sizeBytes <= PHOTO_MAX_BYTES ? [] : [{ path: 'body/sizeBytes', message: 'At most 15 MB.' }]),
  ]
  if (problems.length > 0) throw new ValidationError('The photo cannot be sent as it stands.', problems)
}

/** The record a photo goes on: the return itself, one of its lines, or the complaint (checked by the caller). */
export interface PhotoTarget {
  readonly type: typeof RETURN_RECORD | typeof LINE_RECORD | typeof COMPLAINT_RECORD
  readonly id: string
}

/** The line of a return a photo names, or the return itself. */
export async function returnPhotoTarget(db: Reader, rma: Pick<CaseRma, 'id'>, lineId: string | null | undefined): Promise<PhotoTarget> {
  if (!lineId) return { type: RETURN_RECORD, id: rma.id }
  const lines = await readLines(db, [rma.id])
  if (!isUuid(lineId) || !lines.some((line) => line.id === lineId)) throw new ValidationError('Not a line of this return.', [{ path: 'body/lineId', message: 'Not a line of this return.' }])
  return { type: LINE_RECORD, id: lineId }
}

export async function announcePhoto(files: FilesRuntime, request: FastifyRequest, tenantId: string, place: Place, target: PhotoTarget, body: PhotoUpload, idempotencyKey?: string) {
  // B-W2b-160 (FV1:02): an upload from outside waits for the virus scanner in a live environment (GATE-SPEND).
  assertOutsideUploadsOpen()
  photoProblems(body)
  const uploader = partyUploader(request, tenantId, place)
  const held = await uploader.withClient((client) => client.storedFile.count({ where: { recordType: target.type, recordId: target.id, partyId: place.partyId, kind: 'PHOTO', status: { not: 'DELETED' } } }))
  if (held >= CASE_LIMITS.photos) throw new InvalidStateError(`It holds ${CASE_LIMITS.photos} of your photos already: write to us in the messages.`)
  const answer = await requestUpload(
    files,
    uploader,
    { companyId: place.companyId, recordType: target.type, recordId: target.id, kind: 'PHOTO', originalName: body.originalName, contentType: normaliseContentType(body.contentType), sizeBytes: body.sizeBytes, sha256: body.sha256, visibility: ['OFFICE', 'PARTNER', 'LINK'], partyId: place.partyId },
    idempotencyKey,
  )
  return { file: { id: answer.file.id, originalName: answer.file.originalName, sizeBytes: answer.file.sizeBytes, status: answer.file.status }, upload: answer.upload }
}

export async function completePhoto(files: FilesRuntime, request: FastifyRequest, tenantId: string, place: Place, targets: readonly PhotoTarget[], fileId: string, idempotencyKey?: string) {
  const uploader = partyUploader(request, tenantId, place)
  const file = isUuid(fileId)
    ? await uploader.withClient((client) => client.storedFile.findFirst({ where: { id: fileId, partyId: place.partyId, kind: 'PHOTO', recordId: { in: targets.map((target) => target.id) } }, select: { id: true, recordType: true, recordId: true } }))
    : null
  if (!file || !targets.some((target) => target.type === file.recordType && target.id === file.recordId)) throw new NotFoundError('File not found.')
  const view = await completeUpload(files, uploader, fileId, idempotencyKey)
  return { file: { id: view.id, originalName: view.originalName, sizeBytes: view.sizeBytes, status: view.status } }
}

const STORE = { id: true, status: true, storeAccountId: true, storageKey: true, contentType: true, originalName: true, thumbnailKey: true, recordType: true, recordId: true, partyId: true, visibility: true, kind: true, sha256: true } as const

/** A file of one of these records the party is shown, read as the tenant's system; null when it is not one. */
export async function sharedFile(db: Reader, place: Place, records: readonly { readonly type: string; readonly id: string }[], fileId: string) {
  if (!isUuid(fileId) || records.length === 0) return null
  const row = await db.storedFile.findUnique({ where: { id: fileId }, select: STORE })
  if (!row || row.partyId !== place.partyId || (!row.visibility.includes('PARTNER') && !row.visibility.includes('LINK'))) return null
  if (!records.some((record) => record.type === row.recordType && record.id === row.recordId)) return null
  return row
}

export type OpenMode = 'download' | 'preview'

/** The presigned GET of a file the caller checked (60 s): a picture outside the office only as its stripped copy. */
export async function presignOpen(files: FilesRuntime, request: FastifyRequest, tenantId: string, row: NonNullable<Awaited<ReturnType<typeof sharedFile>>>, mode: OpenMode) {
  if (row.status !== 'AVAILABLE') throw new ConflictError('This file cannot be opened right now; try again later.')
  const storeCaller = systemCallerOf(request)(tenantId)
  const key = await keyShownTo(files, requireContext(request), storeCaller, row)
  const shown: PreviewMode = mode === 'preview' ? previewModeOf(row.contentType) : 'download'
  const presigned = await storeCall(() =>
    files.storage.presignDownload(storeCaller, row.storeAccountId, { key, contentType: row.contentType, disposition: dispositionOf(shown, row.originalName), expiresInSeconds: PREVIEW_URL_SECONDS, now: files.clock.now() }),
  )
  return { file: { id: row.id, name: row.originalName, contentType: row.contentType }, download: { mode: shown, ...presignedView(presigned), method: 'GET' as const } }
}

const asAddress = (value: unknown): PostalAddress | null => {
  if (value === null || typeof value !== 'object') return null
  const entry = value as Record<string, unknown>
  return typeof entry.line1 === 'string' && typeof entry.postalCode === 'string' && typeof entry.city === 'string' && typeof entry.country === 'string'
    ? { line1: entry.line1, line2: typeof entry.line2 === 'string' ? entry.line2 : null, postalCode: entry.postalCode, city: entry.city, province: typeof entry.province === 'string' ? entry.province : null, country: entry.country }
    : null
}

/** The return instructions PDF (an AUTHORISED return only), in the customer's language. */
export async function instructionsPdf(request: FastifyRequest, tenantId: string, rma: CaseRma, language: DocumentLanguage, now: Date): Promise<{ pdf: Buffer; fileName: string }> {
  if (rma.status !== 'AUTHORISED') throw new InvalidStateError(rma.status === 'REQUESTED' ? 'We have not decided yet: the instructions come once we approve the return.' : 'The goods are on their way or back with us: no instructions to print.')
  const system = systemCallerOf(request)(tenantId)
  const company = await companyLegalOf(system, rma.companyId)
  const facts = await system.withClient(async (client) => ({
    site: await client.site.findUnique({ where: { id: rma.siteId }, select: { name: true, address: true } }),
    party: await client.party.findUnique({ where: { id: rma.partyId }, select: { legalName: true } }),
    lines: await readLines(client, [rma.id]),
    policy: await policyOf(client, rma.companyId),
  }))
  const address = asAddress(facts.site?.address)
  const report = returnInstructions({
    language,
    date: businessDate(now),
    company: { name: legalName(company, language), lines: legalLines(company, language), legal: legalFooter(company, language) },
    number: rma.number,
    customer: { name: facts.party?.legalName ?? '', reference: rma.customerRef },
    sendTo: { name: facts.site?.name ?? legalName(company, language), address: address ? addressLine(address, language) : null },
    goodsDueBy: rma.goodsDueBy ? rma.goodsDueBy.toISOString().slice(0, 10) : null,
    freightPaidBy: facts.policy.freightPaidBy,
    lines: facts.lines.map((line) => ({ seq: line.seq, description: line.description, size: line.size, quantity: line.quantity, serial: line.serial })),
    conditions: facts.policy.conditions,
  })
  return { pdf: await renderEightD(report), fileName: report.fileName }
}

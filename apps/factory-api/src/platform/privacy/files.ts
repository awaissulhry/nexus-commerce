import { FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { isLocale } from '@nexus/factory-domain/privacy/notices'
import { PRIVACY_MANAGE } from '@nexus/factory-domain/privacy/permissions'
import { can } from '@nexus/factory-domain/core/permissions'
import { command, type CommandCaller } from '../../core/command'
import { actorOf } from '../../core/context'
import type { FileView } from '../files/contract'
import { completeUpload, getFile, requestUpload } from '../files/files'
import { normaliseContentType } from '../files/rules'
import { processFiles } from '../files/service'
import { officeOf } from './access'
import { dpiaViewOf, readDpia, readDpiaRow } from './dpia'
import { NOTICE_SELECT, noticeViewOf, readNotice } from './notices'

/**
 * The privacy pack's PDFs (B-W1-36; Q15 "the worker notice as a PDF in each worker's language"; GAP-004 the signed DPIA):
 * files of the notice (record PrivacyNotice) and of the DPIA (record PrivacyDpia), written only through these routes
 * (platform/files owned.ts): a file slipped in through the generic POST /files would become the language's PDF or the
 * signed DPIA without these checks.
 *
 *   announce  …/pdf → files.requestUpload (kind DOCUMENT, application/pdf, the company's, office only) → the presigned PUT.
 *   confirm   …/pdf/:fileId/complete → files.completeUpload, then ONE command on the DRAFT notice or DPIA (its version
 *             bump locks it): the language's PDF (its fingerprint the PDF's SHA-256 when the language has no text), or
 *             the DPIA's PDF with its SHA-256. A published notice or a stored DPIA takes no new PDF.
 * privacy.manage over the company, and files.upload.
 */

const PDF = 'application/pdf'

export interface PdfUpload {
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
}

function assertPdf(body: PdfUpload): void {
  if (normaliseContentType(body.contentType) !== PDF) throw new ValidationError('The upload is not valid.', [{ path: 'body/contentType', message: 'A PDF (application/pdf).' }])
}

function mayUpload(caller: CommandCaller, companyId: string): void {
  if (!can(actorOf(officeOf(caller)), FILES_UPLOAD, { companyId })) throw new ForbiddenError()
}

const announce = (caller: CommandCaller, companyId: string, recordType: 'PrivacyNotice' | 'PrivacyDpia', recordId: string, body: PdfUpload, idempotencyKey?: string) =>
  requestUpload(
    processFiles(),
    caller,
    { companyId, recordType, recordId, kind: 'DOCUMENT', originalName: body.originalName, contentType: body.contentType, sizeBytes: body.sizeBytes, sha256: body.sha256 },
    idempotencyKey,
    { viaModule: true },
  )

/** The file of the record, confirmed: its row as it is now, or null when the store refused it (QUARANTINED). */
async function confirm(caller: CommandCaller, recordType: 'PrivacyNotice' | 'PrivacyDpia', recordId: string, fileId: string, idempotencyKey?: string): Promise<FileView | null> {
  const before = isUuid(fileId) ? await caller.withClient((client) => client.storedFile.findFirst({ where: { id: fileId, recordType, recordId, kind: 'DOCUMENT' }, select: { status: true } })) : null
  if (!before) throw new NotFoundError('File not found.')
  const file = await completeUpload(processFiles(), caller, fileId, idempotencyKey, { viaModule: true })
  return file.status === 'AVAILABLE' && file.contentType === PDF ? file : null
}

/** POST /privacy/notices/:noticeId/texts/:locale/pdf. */
export async function announceNoticePdf(caller: CommandCaller, noticeId: string, locale: string, body: PdfUpload, idempotencyKey?: string) {
  if (!isLocale(locale)) throw new ValidationError('The language is not valid.', [{ path: 'params/locale', message: 'A two-letter ISO 639-1 code.' }])
  const { row } = await readNotice(caller, noticeId, PRIVACY_MANAGE)
  mayUpload(caller, row.companyId)
  if (row.status !== 'DRAFT') throw new InvalidStateError(`Version ${row.label} is ${row.status.toLowerCase()}: it takes no new PDF.`)
  assertPdf(body)
  return announce(caller, row.companyId, 'PrivacyNotice', noticeId, body, idempotencyKey)
}

/** POST /privacy/notices/:noticeId/texts/:locale/pdf/:fileId/complete. */
export async function completeNoticePdf(caller: CommandCaller, noticeId: string, locale: string, fileId: string, idempotencyKey?: string) {
  if (!isLocale(locale)) throw new NotFoundError('File not found.')
  const { context, row } = await readNotice(caller, noticeId, PRIVACY_MANAGE)
  mayUpload(caller, row.companyId)
  if (row.status !== 'DRAFT') throw new InvalidStateError(`Version ${row.label} is ${row.status.toLowerCase()}: it takes no new PDF.`)
  const file = await confirm(caller, 'PrivacyNotice', noticeId, fileId, idempotencyKey)
  if (file) {
    await command(caller, { name: 'privacy.attachNoticePdf', idempotencyKey, input: { noticeId, locale, fileId }, record: { type: 'PrivacyNotice', id: noticeId } }, async (tools) => {
      const now = await tools.tx.privacyNotice.findUnique({ where: { id: noticeId }, select: { status: true, label: true } })
      if (now?.status !== 'DRAFT') throw new InvalidStateError(`Version ${now?.label ?? ''} is no longer a draft: it takes no new PDF.`)
      const existing = await tools.tx.privacyNoticeText.findFirst({ where: { noticeId, locale }, select: { id: true, body: true, fileId: true } })
      if (existing) await tools.tx.privacyNoticeText.update({ where: { id: existing.id }, data: { fileId, ...(existing.body === null ? { sha256: file.sha256 } : {}) }, select: { id: true } })
      else await tools.tx.privacyNoticeText.create({ data: { id: newId(), noticeId, locale, fileId, sha256: file.sha256, createdById: context.actorId }, select: { id: true } })
      tools.audit({ recordType: 'PrivacyNotice', recordId: noticeId, companyId: row.companyId, before: existing ? { locale, fileId: existing.fileId } : null, after: { locale, fileId, sha256: file.sha256 } })
      return { fileId }
    })
  }
  const notice = await caller.withClient(async (client) => noticeViewOf(client, (await client.privacyNotice.findUnique({ where: { id: noticeId }, select: NOTICE_SELECT }))!, true))
  return { notice, file: await getFile(caller, fileId) }
}

/** POST /privacy/dpia/:dpiaId/pdf. */
export async function announceDpiaPdf(caller: CommandCaller, dpiaId: string, body: PdfUpload, idempotencyKey?: string) {
  const { row } = await readDpia(caller, dpiaId, PRIVACY_MANAGE)
  mayUpload(caller, row.companyId)
  if (row.status !== 'DRAFT') throw new InvalidStateError(`DPIA version ${row.versionNo} is ${row.status.toLowerCase()}: it takes no new PDF.`)
  assertPdf(body)
  return announce(caller, row.companyId, 'PrivacyDpia', dpiaId, body, idempotencyKey)
}

/** POST /privacy/dpia/:dpiaId/pdf/:fileId/complete: the signed PDF of the DRAFT (a later upload replaces it). */
export async function completeDpiaPdf(caller: CommandCaller, dpiaId: string, fileId: string, idempotencyKey?: string) {
  const { row } = await readDpia(caller, dpiaId, PRIVACY_MANAGE)
  mayUpload(caller, row.companyId)
  if (row.status !== 'DRAFT') throw new InvalidStateError(`DPIA version ${row.versionNo} is ${row.status.toLowerCase()}: it takes no new PDF.`)
  const file = await confirm(caller, 'PrivacyDpia', dpiaId, fileId, idempotencyKey)
  if (file) {
    await command(caller, { name: 'privacy.attachDpiaPdf', idempotencyKey, input: { dpiaId, fileId }, record: { type: 'PrivacyDpia', id: dpiaId } }, async (tools) => {
      const now = await tools.tx.privacyDpia.findUnique({ where: { id: dpiaId }, select: { status: true, fileId: true } })
      if (now?.status !== 'DRAFT') throw new InvalidStateError('This DPIA is no longer a draft: it takes no new PDF.')
      await tools.tx.privacyDpia.update({ where: { id: dpiaId }, data: { fileId, fileSha256: file.sha256 }, select: { id: true } })
      tools.audit({ recordType: 'PrivacyDpia', recordId: dpiaId, companyId: row.companyId, before: { fileId: now.fileId }, after: { fileId, fileSha256: file.sha256 } })
      return { fileId }
    })
  }
  return { dpia: await caller.withClient(async (client) => dpiaViewOf((await readDpiaRow(client, dpiaId))!)), file: await getFile(caller, fileId) }
}


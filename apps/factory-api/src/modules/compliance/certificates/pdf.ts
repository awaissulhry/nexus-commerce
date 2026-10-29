import { FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import type { FileView } from '../../../platform/files/contract'
import { completeUpload, getFile, requestUpload, retainFilesInCommand } from '../../../platform/files/files'
import { normaliseContentType } from '../../../platform/files/rules'
import { processFiles } from '../../../platform/files/service'
import { certificateCommand, certificateDetail, dayOf, mayManage, officeOf, PDF_RETENTION_YEARS, pdfRetainUntil, readCertificate } from './certificates'
import type { CertificateDetail } from './contract'

/**
 * The notified body's PDF of a certificate (QHS-103; Reg. (EU) 2016/425 art. 8(3)). Since B-W1-20 a certificate's
 * CERTIFICATE files are written only through this module (platform/files/owned.ts): registering needs the PDF, so a file
 * slipped in through the generic POST /files would count without the register's permission.
 *
 *   announce  POST /compliance/certificates/:certificateId/pdf → files.requestUpload (kind CERTIFICATE, application/pdf, the
 *             certificate's company) → the presigned PUT. Not on a withdrawn or expired certificate.
 *   confirm   POST …/pdf/:fileId/complete → files.completeUpload, then one command on the certificate (its row read FOR
 *             SHARE, so a registration running at the same time is seen): a registered (VALID or SUSPENDED) certificate
 *             keeps the PDF ten years after its last valid day, as registering does for the PDFs it finds.
 *
 * compliance.certificates.manage over the certificate's company and holder, and files.upload.
 */

const PDF = 'application/pdf'

export interface PdfUpload {
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
}

async function writable(caller: CommandCaller, certificateId: string) {
  const row = await readCertificate(caller, certificateId)
  mayManage(caller, row)
  if (!can(actorOf(officeOf(caller)), FILES_UPLOAD, { companyId: row.companyId })) throw new ForbiddenError()
  if (row.status === 'WITHDRAWN' || row.status === 'EXPIRED') throw new InvalidStateError(`Certificate ${row.number} is ${row.status}: it takes no new PDF.`)
  return row
}

/** POST /compliance/certificates/:certificateId/pdf. */
export async function announcePdf(caller: CommandCaller, certificateId: string, body: PdfUpload, idempotencyKey?: string) {
  const row = await writable(caller, certificateId)
  if (normaliseContentType(body.contentType) !== PDF) {
    throw new ValidationError('The upload is not valid.', [{ path: 'body/contentType', message: "The certificate's file from the notified body is a PDF (application/pdf)." }])
  }
  return requestUpload(
    processFiles(),
    caller,
    { companyId: row.companyId, recordType: 'Certificate', recordId: certificateId, kind: 'CERTIFICATE', originalName: body.originalName, contentType: body.contentType, sizeBytes: body.sizeBytes, sha256: body.sha256 },
    idempotencyKey,
    { viaModule: true },
  )
}

/** POST /compliance/certificates/:certificateId/pdf/:fileId/complete. */
export async function completePdf(caller: CommandCaller, certificateId: string, fileId: string, idempotencyKey?: string): Promise<{ certificate: CertificateDetail; file: FileView }> {
  await writable(caller, certificateId)
  const before = isUuid(fileId)
    ? await caller.withClient((client) => client.storedFile.findFirst({ where: { id: fileId, recordType: 'Certificate', recordId: certificateId, kind: 'CERTIFICATE' }, select: { status: true } }))
    : null
  if (!before) throw new NotFoundError('File not found.')
  const file = await completeUpload(processFiles(), caller, fileId, idempotencyKey, { viaModule: true })
  if (file.status === 'AVAILABLE' && before.status !== 'AVAILABLE' && file.contentType === PDF) {
    await certificateCommand(caller, { name: 'compliance.certificates.attachPdf', idempotencyKey, input: { certificateId, fileId } }, async (tools) => {
      const [locked] = await tools.tx.$queryRaw<{ status: string; validTo: Date; companyId: string | null }[]>`
        SELECT "status"::text AS "status", "validTo", "companyId"::text AS "companyId" FROM "Certificate" WHERE "id" = ${certificateId}::uuid FOR SHARE`
      if (!locked) throw new NotFoundError('Certificate not found.')
      const registered = locked.status === 'VALID' || locked.status === 'SUSPENDED'
      const retainUntil = registered ? pdfRetainUntil(dayOf(locked.validTo)) : null
      if (retainUntil) {
        await retainFilesInCommand(tools, [fileId], retainUntil, `The certificate's PDF is kept ${PDF_RETENTION_YEARS} years after its last valid day, ${dayOf(locked.validTo)} (Reg. (EU) 2016/425 art. 8(3)).`)
      }
      const after = { pdfFileId: fileId, retainUntil: retainUntil ? toUtcIso(retainUntil) : null }
      tools.audit({ recordType: 'Certificate', recordId: certificateId, companyId: locked.companyId, after })
      return after
    })
  }
  // The file as it is now (its retention may have moved).
  return { certificate: await caller.withClient((client) => certificateDetail(client, certificateId)), file: await getFile(caller, fileId) }
}

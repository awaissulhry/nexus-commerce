import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ConflictError, DomainError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { dispositionOf, PREVIEW_URL_SECONDS, previewModeOf, type PreviewMode } from '@nexus/factory-domain/files/preview/rules'
import { maySee, type PortalDocumentKind } from '@nexus/factory-domain/sales/portal-documents/library'
import { requireContext } from '../../../core/context'
import { presignedView, storeCall, systemCallerOf } from '../../../platform/files/files'
import type { FilesRuntime } from '../../../platform/files/service'
import { keyShownTo } from '../../../platform/files/thumbs/outside'
import { appClock, commandOn } from '../../../platform/portal/tasks/clock'
import { DOWNLOAD_ACTION, entryOfFile, readLibrary, withdrawnCopy, type Replacement } from './library'
import { readForStore, type StoreRow } from './store'

/**
 * Open a document of the library (B-W2b-178; QHS-111 "customer document download", design "Preview · Download (logged)"):
 *
 *   POST /portal/customer-documents/:fileId/download {mode}   a file of a document the person sees (a shared file, or an
 *        issued invoice's PDF or XML): ONE command in the party's scope writes the audit row (who, which file, preview or
 *        download, what it is: the "downloads logged" of the plan), then a presigned GET of 60 seconds, as the tenant's
 *        system caller (the file store is the office's): `preview` opens a PDF or a picture in place, `download` saves it.
 *        A picture is served outside the office only as its copy without location data (files thumbs/outside.ts).
 *
 * A withdrawn document answers 409 naming the newer one; a document of a kind the role does not see, or not the party's,
 * is not found. An office preview of the portal is read-only (the portal authenticator refuses the POST).
 */

export type OpenMode = 'download' | 'preview'

/** The library's invoices: their PDF and XML are the office's fiscal archive, opened as the tenant's system. */
const INVOICE_KINDS: readonly PortalDocumentKind[] = ['INVOICE', 'DEPOSIT_INVOICE', 'CREDIT_NOTE']

function withdrawnError(replacedBy: Replacement | null): DomainError {
  const words = replacedBy ? `This version was withdrawn: open ${replacedBy.title.en} (version ${replacedBy.version}) instead.` : 'This version was withdrawn: ask us for the current one.'
  return new DomainError('conflict', words, [{ path: 'document/WITHDRAWN', message: words }])
}

export async function openDocument(app: FastifyInstance, files: FilesRuntime, request: FastifyRequest, fileId: string, body: { readonly mode: OpenMode }, idempotencyKey: string | undefined) {
  const now = appClock(app).now()
  const library = await readLibrary(app, request, now)
  const entry = entryOfFile(library, fileId)
  if (!entry || !maySee(library.access, entry.group)) {
    const withdrawn = entry ? null : await withdrawnCopy(request, library, fileId)
    if (withdrawn) throw withdrawnError(withdrawn.replacedBy)
    throw new NotFoundError('Document not found.')
  }
  if (entry.withdrawn) throw withdrawnError(entry.withdrawn.replacedBy)
  const ref = entry.files.find((file) => file.fileId === fileId)!

  // The object: a shared file in the party's own scope; an invoice's office-only PDF or XML in the tenant's (its invoice
  // was found in the party's scope above).
  const invoice = INVOICE_KINDS.includes(entry.kind)
  const row: StoreRow | null = invoice ? await library.reader.inTenant((client) => readForStore(client, fileId)) : await request.withClient((client) => readForStore(client, fileId))
  if (!row || row.status !== 'AVAILABLE') throw new ConflictError('This document cannot be opened right now; try again later.')

  await commandOn(app, request, { name: DOWNLOAD_ACTION, idempotencyKey, input: { fileId, mode: body.mode } }, async (tools) => {
    tools.audit({
      recordType: 'StoredFile',
      recordId: fileId,
      companyId: library.reader.session.company.id,
      after: { mode: body.mode, kind: entry.kind, title: entry.title.en, version: entry.version, sha256: row.sha256, format: ref.format, for: entry.for ? { type: entry.for.type, id: entry.for.id } : null },
    })
    return { fileId }
  })

  const storeCaller = systemCallerOf(request)(library.reader.session.tenantId)
  const key = await keyShownTo(files, requireContext(request), storeCaller, row)
  const mode: PreviewMode = body.mode === 'preview' ? previewModeOf(row.contentType) : 'download'
  const presigned = await storeCall(() =>
    files.storage.presignDownload(storeCaller, row.storeAccountId, {
      key,
      contentType: row.contentType,
      disposition: dispositionOf(mode, row.originalName),
      expiresInSeconds: PREVIEW_URL_SECONDS,
      now: files.clock.now(),
    }),
  )
  return {
    document: { id: entry.id, kind: entry.kind, title: entry.title, version: entry.version, format: ref.format, name: ref.name },
    download: { mode, ...presignedView(presigned), method: 'GET' as const },
  }
}

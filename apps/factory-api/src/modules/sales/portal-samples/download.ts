import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ConflictError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { dispositionOf, PREVIEW_URL_SECONDS, previewModeOf, type PreviewMode } from '@nexus/factory-domain/files/preview/rules'
import { audienceOfLayout } from '@nexus/factory-domain/product/techpack/rules'
import { formatTechPackCode, techPackCodeOf } from '@nexus/factory-domain/product/techpack/scan'
import { requireContext } from '../../../core/context'
import { presignedView, storeCall, systemCallerOf } from '../../../platform/files/files'
import type { FilesRuntime } from '../../../platform/files/service'
import { keyShownTo } from '../../../platform/files/thumbs/outside'
import { commandOn } from '../../../platform/portal/tasks/clock'
import { readForStore } from '../portal-documents/store'
import { portalReader } from '../portal-orders/access'
import { readTechPackVersion } from './store'

/**
 * Open the brand's tech pack PDF (B-W2b-262; design portal.customer.samples tab:techpack-pdf "Downloaded document";
 * B-W2b-230's lead note: an OFFICE file of the StyleRevision, a BRAND version only):
 *
 *   POST /portal/samples/tech-packs/:documentId/download {mode}   a TECH_PACK GeneratedDocument of a StyleRevision, its
 *        layout the BRAND one (never INTERNAL or SUBCONTRACTOR), made in the portal's company, of a style that is THIS
 *        party's private label (Style.brandPartyId = the session's party; a tenant-wide or another brand's style: not
 *        found — the same answer as an id that does not exist). ONE command in the party's scope writes the audit row (who,
 *        which version, preview or download), then a presigned GET of 60 seconds as the tenant's system caller (the file
 *        is the office's). A PDF never carries money (B-W2b-230), so no grain is asked.
 *
 * An office preview of the portal is read-only (the portal authenticator refuses the POST).
 */

export const TECH_PACK_OPEN_ACTION = 'portal.samples.techPackOpen'

export async function openTechPack(app: FastifyInstance, files: FilesRuntime, request: FastifyRequest, documentId: string, body: { readonly mode: 'download' | 'preview' }, idempotencyKey: string | undefined) {
  const reader = portalReader(app, request)
  const companyId = reader.session.company.id
  const partyId = reader.session.partyId
  const notFound = () => new NotFoundError('Tech pack not found.')
  if (!isUuid(documentId)) throw notFound()

  const found = await reader.inTenant(async (client) => {
    const document = await readTechPackVersion(client, documentId)
    if (!document || document.kind !== 'TECH_PACK' || document.recordType !== 'StyleRevision' || audienceOfLayout(document.layout) !== 'BRAND' || document.companyId !== companyId) return null
    const revision = await client.styleRevision.findUnique({ where: { id: document.recordId }, select: { id: true, styleId: true, revision: true } })
    if (!revision) return null
    const style = await client.style.findUnique({ where: { id: revision.styleId }, select: { id: true, code: true, brandPartyId: true, companyId: true } })
    // The brand's own private label only, of this company or every company's.
    if (!style || style.brandPartyId !== partyId || (style.companyId !== null && style.companyId !== companyId)) return null
    const file = await readForStore(client, document.fileId)
    return { document, revision, style, file }
  })
  if (!found) throw notFound()
  const { document, revision, style, file } = found
  if (!file || file.status !== 'AVAILABLE') throw new ConflictError('This tech pack cannot be opened right now; try again later.')

  const printed = formatTechPackCode(techPackCodeOf(document.id))
  await commandOn(app, request, { name: TECH_PACK_OPEN_ACTION, idempotencyKey, input: { documentId, mode: body.mode } }, async (tools) => {
    tools.audit({
      recordType: 'StoredFile',
      recordId: file.id,
      companyId,
      after: { mode: body.mode, kind: 'TECH_PACK', generatedDocumentId: document.id, styleId: style.id, styleCode: style.code, revisionId: revision.id, revision: revision.revision, version: document.version, language: document.language, code: printed, sha256: file.sha256 },
    })
    return { documentId }
  })

  const storeCaller = systemCallerOf(request)(reader.session.tenantId)
  const key = await keyShownTo(files, requireContext(request), storeCaller, file)
  const mode: PreviewMode = body.mode === 'preview' ? previewModeOf(file.contentType) : 'download'
  const name = `${style.code} tech pack r${revision.revision} v${document.version} ${document.language}.pdf`
  const presigned = await storeCall(() =>
    files.storage.presignDownload(storeCaller, file.storeAccountId, {
      key,
      contentType: file.contentType,
      disposition: dispositionOf(mode, name),
      expiresInSeconds: PREVIEW_URL_SECONDS,
      now: files.clock.now(),
    }),
  )
  return {
    techPack: { id: document.id, styleCode: style.code, revision: revision.revision, version: document.version, language: document.language, printed, name },
    download: { mode, ...presignedView(presigned), method: 'GET' as const },
  }
}

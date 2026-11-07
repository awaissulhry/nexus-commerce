import type { FastifyRequest } from 'fastify'
import { DomainError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { ACCEPTED_PROOFS_ACTION, PROOF_RECORD_TYPE, proofShapeOf, shownProofsRefusal } from '@nexus/factory-domain/sales/quote-proofs/rules'
import { versionOfLink } from '@nexus/factory-domain/sales/quotes/send'
import type { CommandTools } from '../../../core/command'
import { requireContext, type LinkContext } from '../../../core/context'
import { linkSessionOf, linkUnavailable } from '../../../platform/links/authenticator'
import { systemCallerOf } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { keyShownTo } from '../../../platform/files/thumbs/outside'
import { readCustomerVersions } from '../quotes/frozen'
import type { Reader } from '../quotes/store'

/**
 * The proofs on the customer's accept link (B-W2b-165; SAL-199; design links.quote "Proofs you accept with it"): the
 * version's proofs as the send froze them — the current version of each, shared with the party's links — read in the
 * link's party scope (factory_partner_runtime), so a proof the office never shared is never seen.
 *
 *   linkProofsOf             GET /link/quote's `quote.proofs` (quotes/accept.ts): name, type, size, SHA-256, version.
 *   acceptProofsInCommand    INSIDE the accept's command (quotes/accept.ts): the proofs the page showed (`proofFileIds`)
 *                            against the version's proofs now — a set that changed is refused, so the customer never
 *                            accepts a proof they did not see —, then ONE audit row on the version (ACCEPTED_PROOFS_ACTION)
 *                            naming each proof (name, SHA-256, its version, size, type) with the acceptance: the
 *                            evidence the office reads (GET /sales/quotes/:id/proofs) beside the QuoteAcceptance row.
 *   linkProofBytes           GET /link/quote/proofs/:fileId: one proof's bytes for the page's viewer (a QUOTE_ACCEPT
 *                            session reads no files through /files, links/purposes): a picture only as its copy without
 *                            camera and position data (B-W2b-160 keyShownTo); read by the tenant's system scope for THIS
 *                            link's version's proofs only. Opening one uses nothing up.
 */

const LINK_PROOF_COLUMNS = { id: true, seriesId: true, originalName: true, contentType: true, sizeBytes: true, sha256: true, versionNo: true } as const

/** The version's proofs the customer is shown, in the order they were added (a series' first id is a UUIDv7: time order). */
export async function linkProofsOf(db: Reader, versionId: string) {
  const rows = await db.storedFile.findMany({
    where: { recordType: PROOF_RECORD_TYPE, recordId: versionId, status: 'AVAILABLE', supersededAt: null, visibility: { has: 'LINK' } },
    select: LINK_PROOF_COLUMNS,
  })
  rows.sort((a, b) => ((a.seriesId ?? a.id) < (b.seriesId ?? b.id) ? -1 : 1))
  return rows.map((row) => ({ fileId: row.id, name: row.originalName, contentType: row.contentType, shape: proofShapeOf(row.contentType), sizeBytes: row.sizeBytes, sha256: row.sha256, versionNo: row.versionNo }))
}
export type LinkProof = Awaited<ReturnType<typeof linkProofsOf>>[number]

export interface AcceptedProofsTarget {
  readonly quote: { readonly id: string; readonly companyId: string }
  readonly version: { readonly id: string; readonly revision: number }
  readonly acceptanceId: string
  /** The proofs the page showed (undefined: the page did not say; the evidence names the version's proofs now). */
  readonly shown: readonly string[] | undefined
}

export async function acceptProofsInCommand(tools: Pick<CommandTools, 'tx' | 'audit' | 'now'>, target: AcceptedProofsTarget): Promise<LinkProof[]> {
  const proofs = await linkProofsOf(tools.tx, target.version.id)
  const refusal = shownProofsRefusal(target.shown, proofs.map((proof) => proof.fileId))
  if (refusal) throw new DomainError('conflict', refusal, [{ path: 'body/proofFileIds', message: refusal }])
  if (proofs.length === 0) return proofs
  tools.audit({
    action: ACCEPTED_PROOFS_ACTION,
    recordType: PROOF_RECORD_TYPE,
    recordId: target.version.id,
    companyId: target.quote.companyId,
    after: {
      quoteId: target.quote.id,
      versionId: target.version.id,
      revision: target.version.revision,
      acceptanceId: target.acceptanceId,
      at: toUtcIso(tools.now),
      proofs: proofs.map((proof) => ({ fileId: proof.fileId, name: proof.name, sha256: proof.sha256, versionNo: proof.versionNo, sizeBytes: proof.sizeBytes, contentType: proof.contentType })),
    },
  })
  return proofs
}

/** GET /link/quote/proofs/:fileId (see the module comment). */
export async function linkProofBytes(request: FastifyRequest, fileId: string): Promise<{ bytes: Buffer; contentType: string; fileName: string }> {
  const link = linkSessionOf(request)
  if (link.purpose !== 'QUOTE_ACCEPT' || link.record.type !== 'Quote') throw linkUnavailable()
  if (!isUuid(fileId)) throw new NotFoundError('Proof not found.')
  const context = requireContext(request) as LinkContext
  // The version the link was sent with, in the party's scope (as GET /link/quote reads it).
  const versionId = await request.withClient(async (client) => {
    const created = await client.oneOffLink.findUnique({ where: { id: link.id }, select: { createdAt: true } })
    if (!created) throw linkUnavailable()
    return versionOfLink(await readCustomerVersions(client, link.record.id), created.createdAt)?.id ?? null
  })
  if (!versionId) throw linkUnavailable()
  const system = systemCallerOf(request)(context.tenantId)
  const row = await system.withClient((client) =>
    client.storedFile.findFirst({
      where: { id: fileId, recordType: PROOF_RECORD_TYPE, recordId: versionId, partyId: link.partyId, status: 'AVAILABLE', supersededAt: null, visibility: { has: 'LINK' } },
      select: { id: true, originalName: true, contentType: true, sizeBytes: true, storeAccountId: true, storageKey: true, thumbnailKey: true },
    }),
  )
  if (!row) throw new NotFoundError('Proof not found.')
  const runtime = processFiles()
  const key = await keyShownTo(runtime, context, system, row)
  // A picture's copy without its metadata is never larger than the picture plus one small EXIF block.
  const bytes = await runtime.storage.read(system, row.storeAccountId, key, row.sizeBytes + 64 * 1024)
  if (!bytes) throw new NotFoundError('This proof is missing from the file store.')
  return { bytes, contentType: row.contentType, fileName: row.originalName }
}

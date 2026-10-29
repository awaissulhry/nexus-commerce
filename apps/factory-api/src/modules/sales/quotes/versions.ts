import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { quoteDocumentNumber } from '@nexus/factory-domain/sales/quotes/document'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { depositViewOf, DEPOSIT_COLUMNS } from '../deposits/deposits'
import { acceptLinksOf } from './accept-links'
import { dayOf } from './frozen'
import { officeQuote } from './store'

/**
 * A quote's versions and their documents (B-W1-24; A2 SCR-034 "Versions" and "Documents": the accept link, the
 * acceptance evidence, the deposit request; SAL-157): every version the customer saw or could see, who made and sent it,
 * its totals, what changed, its decision, its PDF (the StoredFile whose SHA-256 the version froze), the accept links
 * made for it (their state, never a token), the acceptance's evidence pack and the deposit request. quotes.view; money
 * marked (price).
 *
 * The evidence pack of an acceptance (CAD art. 20; eIDAS simple electronic signature; ported EPQ.5): the QuoteAcceptance
 * row (name as typed, email check, the PDF's SHA-256 and whether it is the stored PDF's, the terms version, the
 * no-withdrawal statement, the time, the channel) and the link's evidence row of the same request (hashed client
 * address, browser, the use number).
 */

export async function listVersions(caller: CommandCaller, quoteId: string) {
  const quote = await officeQuote(caller, quoteId)
  const now = serverClock.now()
  return caller.withClient(async (client) => {
    const versions = await client.quoteVersion.findMany({
      where: { quoteId: quote.id },
      orderBy: { revision: 'desc' },
      select: { id: true, revision: true, status: true, currency: true, netAmount: true, grossAmount: true, depositAmount: true, validUntil: true, firmOffer: true, changeNote: true, documentSha256: true, termsVersion: true, sentAt: true, sentById: true, closedAt: true, decisionNote: true, createdAt: true, createdById: true },
    })
    const hashes = versions.flatMap((version) => (version.documentSha256 ? [version.documentSha256] : []))
    const files = hashes.length > 0 ? await client.storedFile.findMany({ where: { recordType: 'Quote', recordId: quote.id, sha256: { in: hashes } }, select: { id: true, originalName: true, sha256: true, sizeBytes: true, status: true, createdAt: true } }) : []
    const acceptances = await client.quoteAcceptance.findMany({ where: { versionId: { in: versions.map((version) => version.id) } }, select: { id: true, versionId: true, channel: true, linkId: true, signerName: true, emailCheck: true, documentSha256: true, termsVersion: true, noWithdrawalAccepted: true, acceptedAt: true, requestId: true } })
    const evidence = acceptances.length > 0 ? await client.linkEvidence.findMany({ where: { requestId: { in: acceptances.map((row) => row.requestId) } }, select: { requestId: true, linkId: true, action: true, useNumber: true, ipHash: true, userAgent: true, at: true } }) : []
    const deposits = await client.depositRequest.findMany({ where: { quoteVersionId: { in: versions.map((version) => version.id) } }, select: DEPOSIT_COLUMNS })
    const links = await acceptLinksOf(client, quote.id, now)
    // A link answers the newest version sent at or before it was made.
    const sentAsc = versions.filter((version) => version.sentAt !== null).sort((a, b) => a.revision - b.revision)
    const versionOfLinkAt = (createdAt: string) => sentAsc.filter((version) => version.sentAt!.getTime() <= Date.parse(createdAt)).at(-1)?.id ?? null
    return {
      versions: versions.map((version) => {
        const file = files.find((row) => row.sha256 === version.documentSha256) ?? null
        const acceptance = acceptances.find((row) => row.versionId === version.id) ?? null
        const trail = acceptance ? (evidence.find((row) => row.requestId === acceptance.requestId && row.linkId === acceptance.linkId) ?? null) : null
        const deposit = deposits.find((row) => row.quoteVersionId === version.id) ?? null
        return {
          id: version.id,
          revision: version.revision,
          documentNumber: quoteDocumentNumber(quote.number, version.revision),
          status: version.status,
          currency: version.currency,
          netAmount: asMoney('price', version.netAmount),
          grossAmount: asMoney('price', version.grossAmount),
          depositAmount: asMoney('price', version.depositAmount),
          validUntil: dayOf(version.validUntil),
          firmOffer: version.firmOffer,
          changeNote: version.changeNote,
          createdAt: toUtcIso(version.createdAt),
          createdById: version.createdById,
          sentAt: version.sentAt === null ? null : toUtcIso(version.sentAt),
          sentById: version.sentById,
          closedAt: version.closedAt === null ? null : toUtcIso(version.closedAt),
          decisionNote: version.decisionNote,
          documentSha256: version.documentSha256,
          termsVersion: version.termsVersion,
          document: file ? { fileId: file.id, name: file.originalName, sha256: file.sha256, sizeBytes: file.sizeBytes, status: file.status } : null,
          links: links.filter((link) => versionOfLinkAt(link.createdAt) === version.id),
          acceptance: acceptance
            ? {
                id: acceptance.id,
                channel: acceptance.channel,
                linkId: acceptance.linkId,
                signerName: acceptance.signerName,
                emailCheck: acceptance.emailCheck,
                documentSha256: acceptance.documentSha256,
                /** The SHA-256 accepted is the stored PDF's: the customer accepted exactly this document. */
                documentMatches: file !== null && file.sha256 === acceptance.documentSha256,
                termsVersion: acceptance.termsVersion,
                noWithdrawalAccepted: acceptance.noWithdrawalAccepted,
                acceptedAt: toUtcIso(acceptance.acceptedAt),
                requestId: acceptance.requestId,
                evidence: trail ? { action: trail.action, useNumber: trail.useNumber, ipHash: trail.ipHash, userAgent: trail.userAgent, at: toUtcIso(trail.at) } : null,
              }
            : null,
          deposit: deposit ? (() => { const view = depositViewOf(deposit); return { ...view, amount: asMoney('price', view.amount) } })() : null,
        }
      }),
    }
  })
}

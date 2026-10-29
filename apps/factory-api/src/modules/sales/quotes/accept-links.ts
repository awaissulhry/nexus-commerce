import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { linkState, linkTerms } from '@nexus/factory-domain/links/purposes'
import { linkTokenHash, mintLinkToken } from '@nexus/factory-domain/links/token'
import { acceptLinkDays } from '@nexus/factory-domain/sales/quotes/send'
import type { CommandTools } from '../../../core/command'
import type { Reader } from './frozen'

/**
 * The quote's one-off accept links (B-W1-24; platform/links: purpose QUOTE_ACCEPT, record `Quote`; A1 §3.10 "Links"):
 * made by the send and by "send a new link", in their own command, never through the generic POST /links (no Quote
 * source is registered: the link always goes with the quote's mail). The token is minted BEFORE the command
 * (`mintAcceptLink`) and only its SHA-256 enters it; the token itself lives in memory until the mail that carries it
 * leaves (quotes/mail.ts), so no row, receipt, audit entry, event or answer holds it.
 *
 * Life: to the offer's last day plus a grace (factory-domain sales/quotes/send acceptLinkDays), so after the offer ends
 * the link still opens and says so; one counted use (the accept or the decline: links/purposes). Which version a link
 * answers: the one it was made for (send.ts versionOfLink: the newest version sent at or before its createdAt).
 */

export interface MintedLink {
  readonly linkId: string
  /** The bearer token: never stored, never answered. */
  readonly token: string
}

export interface AcceptLinkTerms {
  readonly expiresAt: Date
  readonly maxUses: number
}

/** The link's expiry and use limit for a version that stands until `validUntil` (the mail names the expiry day). */
export const acceptLinkTerms = (today: string, validUntil: string, now: Date): AcceptLinkTerms => linkTerms('QUOTE_ACCEPT', { expiresInDays: acceptLinkDays(today, validUntil) }, now)

export const mintAcceptLink = (tenantId: string, partyId: string): MintedLink => {
  const linkId = newId()
  return { linkId, token: mintLinkToken({ tenantId, partyId, linkId }).value }
}

/** Inside the command: the link row (hash only) for the quote, to the address it is mailed to, with its audit row. */
export async function insertAcceptLink(
  tools: CommandTools,
  link: MintedLink,
  quote: { readonly id: string; readonly companyId: string; readonly partyId: string },
  input: { readonly email: string; readonly terms: AcceptLinkTerms; readonly actorId: string },
): Promise<{ readonly linkId: string; readonly expiresAt: Date }> {
  const { terms } = input
  await tools.tx.oneOffLink.createMany({
    data: [
      {
        id: link.linkId,
        companyId: quote.companyId,
        partyId: quote.partyId,
        purpose: 'QUOTE_ACCEPT',
        recordType: 'Quote',
        recordId: quote.id,
        tokenHash: linkTokenHash(link.token),
        email: input.email.trim().toLowerCase(),
        expiresAt: terms.expiresAt,
        maxUses: terms.maxUses,
        createdAt: tools.now,
        updatedAt: tools.now,
        createdById: input.actorId,
      },
    ],
  })
  tools.audit({
    action: 'links.create',
    recordType: 'OneOffLink',
    recordId: link.linkId,
    companyId: quote.companyId,
    after: { purpose: 'QUOTE_ACCEPT', recordType: 'Quote', recordId: quote.id, partyId: quote.partyId, email: input.email.trim().toLowerCase(), expiresAt: toUtcIso(terms.expiresAt), maxUses: terms.maxUses },
  })
  return { linkId: link.linkId, expiresAt: terms.expiresAt }
}

/** Inside the command: every live accept link of the quote stops working (revoked; its evidence stays). Returns their ids. */
export async function revokeAcceptLinks(tools: CommandTools, quote: { readonly id: string; readonly companyId: string }, actorId: string | null): Promise<string[]> {
  const live = await tools.tx.oneOffLink.findMany({ where: { recordType: 'Quote', recordId: quote.id, purpose: 'QUOTE_ACCEPT', revokedAt: null }, select: { id: true, expiresAt: true, uses: true, maxUses: true, revokedAt: true } })
  const ids = live.filter((link) => linkState(link, tools.now) === 'LIVE').map((link) => link.id)
  if (ids.length === 0) return []
  await tools.tx.oneOffLink.updateMany({ where: { id: { in: ids }, revokedAt: null }, data: { revokedAt: tools.now, revokedById: actorId } })
  for (const id of ids) tools.audit({ action: 'links.revoke', recordType: 'OneOffLink', recordId: id, companyId: quote.companyId, after: { revokedAt: toUtcIso(tools.now) } })
  return ids
}

/** The quote's accept links (office scope), oldest first, with their state now. */
export async function acceptLinksOf(db: Reader, quoteId: string, now: Date) {
  const rows = await db.oneOffLink.findMany({
    where: { recordType: 'Quote', recordId: quoteId, purpose: 'QUOTE_ACCEPT' },
    select: { id: true, email: true, expiresAt: true, uses: true, maxUses: true, lastUsedAt: true, revokedAt: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    state: linkState(row, now),
    expiresAt: toUtcIso(row.expiresAt),
    uses: row.uses,
    maxUses: row.maxUses,
    lastUsedAt: row.lastUsedAt === null ? null : toUtcIso(row.lastUsedAt),
    revokedAt: row.revokedAt === null ? null : toUtcIso(row.revokedAt),
    createdAt: toUtcIso(row.createdAt),
  }))
}

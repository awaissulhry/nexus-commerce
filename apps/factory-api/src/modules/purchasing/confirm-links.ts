import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { linkState, linkTerms } from '@nexus/factory-domain/links/purposes'
import { linkTokenHash, mintLinkToken } from '@nexus/factory-domain/links/token'
import { confirmLinkDays } from '@nexus/factory-domain/purchasing/orders'
import type { CommandTools } from '../../core/command'
import type { Reader } from './store'

/**
 * The purchase order's one-off confirm links (B-W1-30; platform/links: purpose PO_CONFIRM, record `PurchaseOrder`; A1
 * §3.10 "Links"; PLAN §4.7 08-buy): made by the send and by "send a new link", in their own command, never through the
 * generic POST /links (no PurchaseOrder source is registered: the link always goes with the order's mail). The token is
 * minted BEFORE the command (`mintConfirmLink`) and only its SHA-256 enters it; the token itself lives in memory until the
 * mail that carries it leaves (purchasing/mail.ts), so no row, receipt, audit entry, event or answer holds it.
 *
 * A PO_CONFIRM session holds no money grain (links/purposes) and the partner role's column grants hide every price, so
 * the supplier's answer page (B-W1-31) shows quantities and dates only; the PDF with the prices is the mail's attachment
 * and is not shared with link sessions. Life: until the order's latest need date, at least 14 and at most 60 days
 * (purchasing/orders confirmLinkDays); one counted use (the confirm or the decline).
 */

export interface MintedLink {
  readonly linkId: string
  /** The bearer token: never stored, never answered. */
  readonly token: string
}

export interface ConfirmLinkTerms {
  readonly expiresAt: Date
  readonly maxUses: number
}

export const confirmLinkTerms = (today: string, latestNeedDate: string | null, now: Date): ConfirmLinkTerms => linkTerms('PO_CONFIRM', { expiresInDays: confirmLinkDays(today, latestNeedDate) }, now)

export const mintConfirmLink = (tenantId: string, partyId: string): MintedLink => {
  const linkId = newId()
  return { linkId, token: mintLinkToken({ tenantId, partyId, linkId }).value }
}

/** Inside the command: the link row (hash only) for the order, to the address it is mailed to, with its audit row. */
export async function insertConfirmLink(
  tools: CommandTools,
  link: MintedLink,
  order: { readonly id: string; readonly companyId: string; readonly siteId: string; readonly partyId: string },
  input: { readonly email: string; readonly terms: ConfirmLinkTerms; readonly actorId: string },
): Promise<{ readonly linkId: string; readonly expiresAt: Date }> {
  const email = input.email.trim().toLowerCase()
  await tools.tx.oneOffLink.createMany({
    data: [
      {
        id: link.linkId,
        companyId: order.companyId,
        partyId: order.partyId,
        purpose: 'PO_CONFIRM',
        recordType: 'PurchaseOrder',
        recordId: order.id,
        tokenHash: linkTokenHash(link.token),
        email,
        expiresAt: input.terms.expiresAt,
        maxUses: input.terms.maxUses,
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
    companyId: order.companyId,
    siteId: order.siteId,
    after: { purpose: 'PO_CONFIRM', recordType: 'PurchaseOrder', recordId: order.id, partyId: order.partyId, email, expiresAt: toUtcIso(input.terms.expiresAt), maxUses: input.terms.maxUses },
  })
  return { linkId: link.linkId, expiresAt: input.terms.expiresAt }
}

/** Inside the command: every live confirm link of the order stops working (revoked; its evidence stays). Returns their ids. */
export async function revokeConfirmLinks(tools: CommandTools, order: { readonly id: string; readonly companyId: string; readonly siteId: string }, actorId: string | null): Promise<string[]> {
  const rows = await tools.tx.oneOffLink.findMany({ where: { recordType: 'PurchaseOrder', recordId: order.id, purpose: 'PO_CONFIRM', revokedAt: null }, select: { id: true, expiresAt: true, uses: true, maxUses: true, revokedAt: true } })
  const ids = rows.filter((link) => linkState(link, tools.now) === 'LIVE').map((link) => link.id)
  if (ids.length === 0) return []
  await tools.tx.oneOffLink.updateMany({ where: { id: { in: ids }, revokedAt: null }, data: { revokedAt: tools.now, revokedById: actorId } })
  for (const id of ids) tools.audit({ action: 'links.revoke', recordType: 'OneOffLink', recordId: id, companyId: order.companyId, siteId: order.siteId, after: { revokedAt: toUtcIso(tools.now) } })
  return ids
}

/** The order's confirm links (office scope), oldest first, with their state now. */
export async function confirmLinksOf(db: Reader, orderId: string, now: Date) {
  const rows = await db.oneOffLink.findMany({
    where: { recordType: 'PurchaseOrder', recordId: orderId, purpose: 'PO_CONFIRM' },
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

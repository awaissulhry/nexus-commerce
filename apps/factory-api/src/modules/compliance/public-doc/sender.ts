import type { FactoryClient } from '@nexus/factory-db'
import { contactEmail } from '@nexus/factory-domain/compliance/operators/rules'
import type { PublicDocPage } from '@nexus/factory-domain/compliance/public-doc/contracts'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { declarationSender, type DeclarationSender } from '@nexus/factory-domain/product/style-texts/private-label'
import { operatorsFor } from '../operators/operators'
import { readSender, type CodeMatch } from './facts'

/**
 * Who sends the public DoC page (B-W2b-249; PRD-298; Owner 11-09, W2b-4 question 3, which also settles B-W2b-166's
 * question): a private-label style sold under the brand's name is the brand's — the page's head names the brand as the
 * economic operators say it (the MANUFACTURER row that applies to the style: style, then brand; else the brand party's
 * own name), with no logo of ours and the brand's e-mail when its row gives one; a style sold under our name, or one of
 * our own, is the company's (its public branding and conversation address, as B-W2b-166 built it). The page stays served
 * by the factory: the sender's companyId is the making company's (whose privacy notice covers the page's own processing).
 *
 * `makerRole` is the page's "legal maker" role (product.maker.role): BRAND only for the brand's own name (a brand style sold
 * under our name has our company as manufacturer). Read in the tenant's system scope (row-level security stays forced).
 */

export interface DocSender {
  readonly sender: PublicDocPage['sender']
  readonly contact: PublicDocPage['contact']
  readonly makerRole: DeclarationSender
}

/** The sender of one match's page; null when the tenant has no active company (the page is not shown). */
export async function readDocSender(client: FactoryClient, match: CodeMatch, companyId: string | null, today: BusinessDate): Promise<DocSender | null> {
  const head = await readSender(client, companyId)
  if (!head) return null
  const order = match.kind === 'BATCH' ? await client.workOrder.findUnique({ where: { id: match.id }, select: { styleId: true, releasedAt: true } }) : null
  const styleId = order?.styleId ?? match.id
  const style = await client.style.findUnique({ where: { id: styleId }, select: { id: true, code: true, name: true, companyId: true, brandPartyId: true, soldUnderOurName: true } })
  if (!style || declarationSender(style) === 'COMPANY') return { ...head, makerRole: 'COMPANY' }

  // The brand's own name: the manufacturer row that applied on the batch's release day (a style: today).
  const day = order?.releasedAt ? businessDate(order.releasedAt) : today
  const { resolved } = await operatorsFor(client, style, { marketCode: null, day, companyId: companyId ?? style.companyId })
  const maker = resolved.find((entry) => entry.role === 'MANUFACTURER' && (entry.level === 'STYLE' || entry.level === 'BRAND'))
  const brand = await client.party.findUnique({ where: { id: style.brandPartyId! }, select: { legalName: true, tradeName: true } })
  const name = maker?.row.printedName ?? brand?.legalName ?? brand?.tradeName ?? head.sender.companyName
  return {
    sender: { companyId: head.sender.companyId, name, companyName: name, logoPath: null, logoDarkPath: null, accentColour: null },
    contact: { email: contactEmail(maker?.row.contact ?? null) },
    makerRole: 'BRAND',
  }
}

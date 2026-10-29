import type { FastifyRequest } from 'fastify'
import { InvalidStateError } from '@nexus/factory-domain/core/errors'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { linkState } from '@nexus/factory-domain/links/purposes'
import { matchesLinkHash, parseLinkToken } from '@nexus/factory-domain/links/token'
import { RENEW_COALESCE_MS, renewalRefusal } from '@nexus/factory-domain/purchasing/confirm/renew'
import { purchaseOrderDocumentNumber, purchaseOrderMail } from '@nexus/factory-domain/purchasing/document'
import { newLinkProblem, supplierLanguageOf, type PurchaseOrderStatus } from '@nexus/factory-domain/purchasing/orders'
import { SYSTEM_ACTOR_ID, type RequestContext } from '../../../core/context'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import type { EmailRuntime } from '../../../platform/email-out/service'
import { LINK_HEADER } from '../../../platform/links/authenticator'
import { linkCommand } from '../../../platform/links/use'
import { systemContext } from '../../../platform/outbox/system'
import { confirmLinkTerms, insertConfirmLink, mintConfirmLink } from '../confirm-links'
import { deliverLinkMail, queueLinkMail } from '../mail'
import { dayOf, readLines, readOrder } from '../store'
import { writeBuyerNote } from './handler'

/**
 * "Ask for a new link" on a dead confirm link (B-W1-31; the links frame's end state; the B-W1-49 pattern): the public
 * route answers ONE thing at once, whatever the token (none, garbage, another tenant's, live, revoked, used, expired), and
 * this work runs after the answer (officeAuth afterAnswer), so neither what it says nor when it comes tells anything about
 * the token. A new link goes out only for an EXPIRED link of an order that still waits for its supplier (SENT, no live
 * link), only to the address the old link was sent to while it is still the order's ACTIVE contact's (never a typed one),
 * not twice in ten minutes (factory-domain purchasing/confirm/renew renewalRefusal). Then, as the tenant's system:
 *
 *   ONE command on the PurchaseOrder (its version CAS: a cancel, a new link from the office or a second request that
 *   committed meanwhile wins, and this one does nothing): the link (hash only; made by the system), the mail on the
 *   order's thread with the PDF the supplier got and WITHOUT the link (purchasing/mail.ts), an internal note for the
 *   buyer, purchase_order.link_sent; after the commit the mail leaves with the link, in this process.
 *
 * Every refusal is silent; the outcome is logged by its code only (never the token, the link or the address).
 */

/** The link token a request carries (the page sends the dead link's token in the same header). */
export const linkTokenOf = (request: FastifyRequest): unknown => request.headers[LINK_HEADER]

/** A view of the request in another context: `withClient` and command() follow it. */
function asContext(request: FastifyRequest, context: RequestContext): FastifyRequest {
  const view = Object.create(request) as FastifyRequest
  view.factoryContext = context
  return view
}

/** The purchasing office, as the system's mail and the thread show it. */
const SYSTEM_SENDER = { userId: SYSTEM_ACTOR_ID, name: 'Ufficio acquisti', email: null }

export async function renewConfirmLink(email: EmailRuntime, request: FastifyRequest, header: unknown): Promise<string> {
  const token = parseLinkToken(typeof header === 'string' ? header.trim() : undefined)
  if (!token) return 'NOT_A_TOKEN'
  const auth = officeAuthOf(request.server)
  const now = auth.clock.now()
  const requestId = String(request.id)
  const platform = asContext(request, { audience: 'platform', actorId: SYSTEM_ACTOR_ID, grants: [], requestId })
  const tenant = await platform.withClient((client) => client.tenant.findUnique({ where: { id: token.tenantId }, select: { status: true } }))
  if (tenant?.status !== 'ACTIVE') return 'UNKNOWN'
  const system = asContext(request, systemContext(token.tenantId, requestId))

  const found = await system.withClient(async (client) => {
    const link = await client.oneOffLink.findUnique({
      where: { id: token.linkId },
      select: { id: true, partyId: true, purpose: true, recordType: true, recordId: true, tokenHash: true, email: true, expiresAt: true, maxUses: true, uses: true, revokedAt: true },
    })
    // The token must be this link's (constant-time hash compare) and name its party.
    if (!link || link.partyId !== token.partyId || !matchesLinkHash(token, link.tokenHash)) return null
    const order = link.recordType === 'PurchaseOrder' ? await readOrder(client, link.recordId) : null
    if (order && order.partyId !== link.partyId) return null
    const links = order ? await client.oneOffLink.findMany({ where: { recordType: 'PurchaseOrder', recordId: order.id, purpose: 'PO_CONFIRM' }, select: { expiresAt: true, revokedAt: true, uses: true, maxUses: true, createdAt: true } }) : []
    const contact = order?.contactId ? await client.partyContact.findUnique({ where: { id: order.contactId }, select: { name: true, email: true, status: true, language: true } }) : null
    const party = order ? await client.party.findUnique({ where: { id: order.partyId }, select: { language: true } }) : null
    return { link, order, links, contact, party }
  })
  if (!found) return 'UNKNOWN'
  const { link, order, contact } = found
  const refusal = renewalRefusal({
    purpose: link.purpose,
    recordType: link.recordType,
    state: linkState(link, now),
    orderStatus: order?.status ?? null,
    liveLinks: found.links.filter((row) => linkState(row, now) === 'LIVE').length,
    email: link.email,
    contact: contact ? { email: contact.email, status: contact.status } : null,
    askedRecently: found.links.some((row) => row.createdAt.getTime() > now.getTime() - RENEW_COALESCE_MS),
  })
  if (refusal) return refusal

  // Outside any transaction: the PDF the supplier got (its newest stored print), the terms, the mail, the token.
  const prepared = await system.withClient(async (client) => {
    const file = await client.storedFile.findFirst({ where: { recordType: 'PurchaseOrder', recordId: order!.id, kind: 'FISCAL_ARCHIVE', status: 'AVAILABLE' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, originalName: true, sizeBytes: true, storeAccountId: true, storageKey: true } })
    const latestNeed = (await readLines(client, order!.id)).map((line) => dayOf(line.needDate)!).sort().at(-1) ?? null
    return { file, latestNeed }
  })
  if (!prepared.file) return 'NO_PDF'
  const pdf = await email.files().read(system, prepared.file.storeAccountId, prepared.file.storageKey, prepared.file.sizeBytes)
  if (!pdf) return 'NO_PDF'
  const language = supplierLanguageOf(contact!.language, found.party?.language ?? 'it')
  const terms = confirmLinkTerms(businessDate(now), prepared.latestNeed, now)
  const documentNumber = purchaseOrderDocumentNumber(order!.number, order!.revision)
  const mail = purchaseOrderMail({ language, number: documentNumber, recipientName: contact!.name, linkUntil: businessDate(terms.expiresAt), message: null, resend: true })
  const minted = mintConfirmLink(token.tenantId, order!.partyId)
  const to = link.email!
  const fileId = prepared.file.id

  let outboundId: string
  try {
    const { result } = await linkCommand(
      system,
      { name: 'purchasing.renewLink', input: { purchaseOrderId: order!.id, renewalOf: link.id }, record: { type: 'PurchaseOrder', id: order!.id, expectedVersion: order!.version } },
      async (tools) => {
        const current = (await readOrder(tools.tx, order!.id))!
        const problem = newLinkProblem(current.status as PurchaseOrderStatus)
        if (problem) throw new InvalidStateError(problem)
        const live = await tools.tx.oneOffLink.findMany({ where: { recordType: 'PurchaseOrder', recordId: current.id, purpose: 'PO_CONFIRM', revokedAt: null }, select: { expiresAt: true, revokedAt: true, uses: true, maxUses: true } })
        if (live.some((row) => linkState(row, tools.now) === 'LIVE')) throw new InvalidStateError('The order has a live link already.')
        const made = await insertConfirmLink(tools, minted, current, { email: to, terms, actorId: SYSTEM_ACTOR_ID })
        const queued = await queueLinkMail(tools, { orderId: current.id, sender: SYSTEM_SENDER, to, cc: [], subject: mail.subject, storedText: mail.stored, attachments: [fileId], locale: language })
        await writeBuyerNote(tools, current.id, `The supplier asked for a new link: the old one had expired before it was answered. A new one went to ${to} (valid until ${businessDate(made.expiresAt)}).`)
        tools.audit({ action: 'purchasing.renewLink', recordType: 'PurchaseOrder', recordId: current.id, companyId: current.companyId, siteId: current.siteId, after: { linkId: made.linkId, renewalOf: link.id, linkExpiresAt: toUtcIso(made.expiresAt), outboundId: queued.outbound.id, to } })
        tools.emit({ type: 'purchase_order.link_sent', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { purchaseOrderId: current.id, number: current.number, linkId: made.linkId, revokedLinkIds: [], outboundId: queued.outbound.id } })
        return { outboundId: queued.outbound.id }
      },
    )
    outboundId = result.outboundId
  } catch (error) {
    request.log.info({ kind: (error as Error).name }, 'a confirm link renewal lost to a newer change')
    return 'CHANGED'
  }
  const outcome = await deliverLinkMail(email, system, outboundId, { text: mail.withLink(auth.link('/l', minted.token)), attachment: { filename: prepared.file.originalName, content: pdf } })
  return outcome === 'sent' ? 'SENT' : 'MAIL_FAILED'
}


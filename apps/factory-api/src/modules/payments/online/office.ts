import type { FastifyRequest } from 'fastify'
import { InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { formatExpiry } from '@nexus/factory-domain/email/compose'
import { linkState, linkTerms } from '@nexus/factory-domain/links/purposes'
import { linkTokenHash, mintLinkToken } from '@nexus/factory-domain/links/token'
import { amountText, paymentLinkMail, START_REFUSALS } from '@nexus/factory-domain/payments/online/rules'
import { PAYMENTS_RECORD, PAYMENTS_VIEW } from '@nexus/factory-domain/payments/permissions'
import { command, type CommandCaller } from '../../../core/command'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import type { EmailRuntime } from '../../../platform/email-out/service'
import { systemCallerOf } from '../../../platform/files/files'
import { assertNoPayByLink } from '../../../platform/links/pay'
import { deliverLinkMail, queueLinkMail } from '../deposit-link'
import { assertMay, officeContextOf } from '../store'
import { INTENT_COLUMNS, officeIntentView, targetFacts } from './store'

/**
 * The office's side of paying online (B-W2b-185):
 *
 *   POST /payments/invoices/:invoiceId/link   payments.record over the invoice's company and customer: the page to pay an
 *                                             issued invoice that still asks money (a PAYMENT link: price grain, one
 *                                             payment, 30 days), mailed to the contact named, else the customer's INVOICES
 *                                             contact, else its ORDERS one, on the invoice's thread. As W1's deposit page: the
 *                                             token minted outside the command, only its hash stored; ONE command revokes
 *                                             the address's older live PAYMENT links of the invoice, makes the link, queues
 *                                             the mail without the link (the thread keeps that text), audits, emits
 *                                             payment_link.sent; after the commit the mail is composed WITH the link and
 *                                             sent once (never retried by a job). A deposit request needs no new link: its
 *                                             DEPOSIT_INFO page takes card and SEPA now.
 *   GET  /payments/intents?invoiceId|depositRequestId   payments.view: the online payments of a record (status, method,
 *                                             reason, the payment it recorded, where it started), newest first
 */

interface Contact {
  readonly email: string
  readonly name: string
}

async function contactOf(caller: CommandCaller, partyId: string, contactId: string | undefined): Promise<Contact> {
  return caller.withClient(async (client) => {
    const select = { id: true, name: true, email: true, status: true, partyId: true } as const
    if (contactId !== undefined) {
      const named = await client.partyContact.findUnique({ where: { id: contactId }, select })
      if (!named || named.partyId !== partyId || named.status !== 'ACTIVE' || !named.email) throw new ValidationError("Not an active contact of the customer with an e-mail address: pick another, or add the address to the customer's contact.", [{ path: 'body/contactId', message: 'Not an active contact with an address.' }])
      return { email: named.email.trim().toLowerCase(), name: named.name }
    }
    for (const role of ['INVOICES', 'ORDERS'] as const) {
      const found = await client.partyContact.findFirst({ where: { partyId, status: 'ACTIVE', roles: { has: role }, email: { not: null } }, select, orderBy: [{ name: 'asc' }, { id: 'asc' }] })
      if (found?.email) return { email: found.email.trim().toLowerCase(), name: found.name }
    }
    throw new InvalidStateError('The customer has no active invoices or orders contact with an e-mail address: add one (Customers › Contacts), or pick a contact, then send the payment page.')
  })
}

export async function sendPayLink(email: EmailRuntime, request: FastifyRequest, invoiceId: string, body: { readonly contactId?: string | undefined; readonly message?: string | undefined }, idempotencyKey?: string) {
  const context = officeContextOf(request)
  const facts = await request.withClient((db) => targetFacts(db, 'INVOICE', invoiceId))
  assertMay(context, PAYMENTS_VIEW, PAYMENTS_RECORD, facts ? { companyId: facts.companyId, partyId: facts.partyId } : null, 'Invoice')
  const invoice = facts!
  if (invoice.refusal === 'NOT_PAYABLE') throw new InvalidStateError(START_REFUSALS.NOT_PAYABLE)
  if (invoice.refusal === 'NOT_OPEN') throw new InvalidStateError('Nothing is open on this invoice: there is no payment page to send.')
  const contact = await contactOf(request, invoice.partyId, body.contactId)
  const party = await request.withClient((db) => db.party.findUnique({ where: { id: invoice.partyId }, select: { language: true } }))
  const locale = party?.language === 'en' ? 'en' : 'it'
  const linkId = newId()
  const token = mintLinkToken({ tenantId: context.tenantId, partyId: invoice.partyId, linkId }).value
  const mailFor = (expiresAt: Date, url: string | null) =>
    paymentLinkMail({ locale, what: invoice.label[locale], amount: amountText(invoice.open, invoice.currency), dueDate: invoice.dueDate ? (locale === 'it' ? invoice.dueDate.split('-').reverse().join('/') : invoice.dueDate) : null, expiresOn: formatExpiry(expiresAt, locale), message: body.message ?? null }, url)

  const { result, replayed } = await command(request, { name: 'payments.sendPayLink', idempotencyKey, input: { invoiceId, ...body } }, async (tools) => {
    const { tx, now } = tools
    await assertNoPayByLink(tx, { recordType: 'Invoice', recordId: invoiceId })
    const again = await targetFacts(tx, 'INVOICE', invoiceId)
    if (!again || again.open <= 0) throw new InvalidStateError('Nothing is open on this invoice: there is no payment page to send.')
    const older = await tx.oneOffLink.findMany({ where: { recordType: 'Invoice', recordId: invoiceId, purpose: 'PAYMENT', email: contact.email }, select: { id: true, revokedAt: true, expiresAt: true, uses: true, maxUses: true } })
    const revokedLinkIds: string[] = []
    for (const link of older.filter((entry) => linkState(entry, now) === 'LIVE')) {
      await tx.oneOffLink.updateMany({ where: { id: link.id, revokedAt: null }, data: { revokedAt: now, revokedById: context.actorId } })
      tools.audit({ action: 'links.revoke', recordType: 'OneOffLink', recordId: link.id, companyId: invoice.companyId, after: { revokedAt: toUtcIso(now) }, reason: 'Replaced by a new payment page link to the same address.' })
      revokedLinkIds.push(link.id)
    }
    const terms = linkTerms('PAYMENT', {}, now)
    await tx.oneOffLink.createMany({
      data: [{ id: linkId, companyId: invoice.companyId, partyId: invoice.partyId, purpose: 'PAYMENT', recordType: 'Invoice', recordId: invoiceId, tokenHash: linkTokenHash(token), email: contact.email, expiresAt: terms.expiresAt, maxUses: terms.maxUses, createdAt: now, updatedAt: now, createdById: context.actorId }],
    })
    tools.audit({ action: 'links.create', recordType: 'OneOffLink', recordId: linkId, companyId: invoice.companyId, after: { purpose: 'PAYMENT', recordType: 'Invoice', recordId: invoiceId, partyId: invoice.partyId, email: contact.email, expiresAt: toUtcIso(terms.expiresAt), maxUses: terms.maxUses } })
    const sender = await tx.user.findUnique({ where: { id: context.actorId }, select: { displayName: true, email: true } })
    const mail = mailFor(terms.expiresAt, null)
    const sent = await queueLinkMail(tools, { record: { type: 'Invoice', id: invoiceId }, sender: { userId: context.actorId, name: sender?.displayName ?? 'Ufficio amministrazione', email: sender?.email ?? null }, to: contact.email, subject: mail.subject, storedText: mail.body, locale })
    tools.audit({ action: 'payments.sendPayLink', recordType: 'Invoice', recordId: invoiceId, companyId: invoice.companyId, after: { linkId, linkExpiresAt: toUtcIso(terms.expiresAt), revokedLinkIds, outboundId: sent.outbound.id, to: contact.email } })
    tools.emit({ type: 'payment_link.sent', subject: invoiceId, companyId: invoice.companyId, payload: { linkId, partyId: invoice.partyId, target: 'INVOICE', targetId: invoiceId } })
    return { link: { id: linkId, expiresAt: toUtcIso(terms.expiresAt), to: contact.email, revokedLinkIds }, emailId: sent.outbound.id }
  })
  if (replayed) return { ...result, delivery: 'replayed' }
  const url = officeAuthOf(request.server).link('/l', token)
  const delivery = await deliverLinkMail(email, systemCallerOf(request)(context.tenantId), result.emailId, mailFor(new Date(result.link.expiresAt), url).body)
  return { ...result, delivery }
}

export async function officeIntents(request: FastifyRequest, query: { readonly invoiceId?: string | undefined; readonly depositRequestId?: string | undefined }) {
  const context = officeContextOf(request)
  if ((query.invoiceId === undefined) === (query.depositRequestId === undefined)) throw new ValidationError('Name one invoice or one deposit request.', [{ path: 'query', message: 'invoiceId or depositRequestId.' }])
  const target = query.invoiceId ? ('INVOICE' as const) : ('DEPOSIT_REQUEST' as const)
  const targetId = (query.invoiceId ?? query.depositRequestId)!
  return request.withClient(async (db) => {
    const facts = await targetFacts(db, target, targetId)
    if (!facts) throw new NotFoundError(target === 'INVOICE' ? 'Invoice not found.' : 'Deposit request not found.')
    assertMay(context, PAYMENTS_VIEW, PAYMENTS_VIEW, { companyId: facts.companyId, partyId: facts.partyId }, target === 'INVOICE' ? 'Invoice' : 'Deposit request')
    const rows = await db.paymentIntent.findMany({ where: target === 'INVOICE' ? { invoiceId: targetId } : { depositRequestId: targetId }, select: INTENT_COLUMNS, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 200 })
    return { intents: rows.map(officeIntentView) }
  })
}

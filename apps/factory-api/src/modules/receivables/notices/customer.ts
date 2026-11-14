import { businessDate } from '@nexus/factory-domain/core/time'
import { paymentNoticeMail, type NoticeHeld } from '@nexus/factory-domain/receivables/notices/notices'
import { SYSTEM_ACTOR_ID } from '../../../core/context'
import type { CommandCaller } from '../../../core/command'
import { sendEmail } from '../../../platform/email-out/outbound'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { invoiceContactsOf, receivablesCommand, type Reader } from '../store'
import { collectionsOf } from './settings'

/**
 * The payment received notice to the customer (B-W2b-402; FIN-128: "and to the customer behind its own switch (OFF)"; the
 * Owner's rule of 11-13). After a bank transfer is recorded (typed, matched from a bank line, or a Ri.Ba. instalment paid),
 * the worker's handler `receivables.paymentNotice` e-mails the customer's invoice contacts what arrived and what it paid, in
 * the customer's language, from the company's mail account (FAKE locally and in tests), on the customer's thread — ONLY
 * while the company's switch ReceivablesSettings.paymentNoticeToCustomerOn is on (its row, else the tenant's; OFF by
 * default). ONE command per payment (key payment-notice:<payment id>: a repeat sends nothing twice); the outbound row, its
 * audit row and payment.receipt_sent. A card or SEPA payment is told by its provider; a voided payment by nobody. The
 * wording is a placeholder to confirm with the accountant.
 */

/** Why the notice of a payment would not go now (null: it goes). */
export async function noticeHeldFor(db: Reader, paymentId: string): Promise<{ held: NoticeHeld | null; payment: { id: string; companyId: string; partyId: string; amount: number; currency: string; receivedOn: Date } | null }> {
  const payment = await db.payment.findUnique({ where: { id: paymentId }, select: { id: true, companyId: true, partyId: true, amount: true, currency: true, receivedOn: true, method: true, status: true } })
  if (!payment) return { held: 'VOIDED', payment: null }
  if (payment.status !== 'RECEIVED') return { held: 'VOIDED', payment }
  if (payment.method !== 'BANK_TRANSFER') return { held: 'NOT_A_TRANSFER', payment }
  if (!(await collectionsOf(db, payment.companyId)).paymentNoticeToCustomerOn) return { held: 'SWITCHED_OFF', payment }
  if ((await invoiceContactsOf(db, payment.partyId)).length === 0) return { held: 'NO_CONTACT', payment }
  return { held: null, payment }
}

/** Sends the notice of one payment when nothing holds it; answers the outbound id (null: held, and why). */
export async function sendPaymentNotice(caller: CommandCaller, paymentId: string, idempotencyKey?: string): Promise<{ outboundId: string | null; held: NoticeHeld | null }> {
  const peek = await caller.withClient((db) => noticeHeldFor(db, paymentId))
  if (peek.held !== null) return { outboundId: null, held: peek.held }
  const { result } = await receivablesCommand(caller, { name: 'receivables.paymentNotice', idempotencyKey, input: { paymentId } }, async (tools) => {
    const { tx } = tools
    const check = await noticeHeldFor(tx, paymentId)
    if (check.held !== null || !check.payment) return { outboundId: null, held: check.held }
    const payment = check.payment
    const party = await tx.party.findUniqueOrThrow({ where: { id: payment.partyId }, select: { legalName: true, language: true } })
    const company = await tx.company.findUniqueOrThrow({ where: { id: payment.companyId }, select: { legalName: true, tradeName: true } })
    const allocations = await tx.paymentAllocation.findMany({ where: { paymentId: payment.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { amount: true, invoice: { select: { number: true } }, depositRequest: { select: { order: { select: { number: true } } } } } })
    const placed = allocations.map((row) => ({ number: row.invoice?.number ?? row.depositRequest?.order?.number ?? '', amount: row.amount })).filter((row) => row.number !== '')
    const placedTotal = allocations.reduce((sum, row) => sum + row.amount, 0)
    const language = party.language === 'it' ? 'it' : 'en'
    const companyName = company.tradeName ?? company.legalName
    const mail = paymentNoticeMail({ language, companyName, customerName: party.legalName, currency: payment.currency, amount: payment.amount, receivedOn: businessDate(payment.receivedOn, 'UTC'), placed, unplaced: Math.max(0, payment.amount - placedTotal) })
    const contacts = await invoiceContactsOf(tx, payment.partyId)
    // The company's default identity (a tenant-wide customer's thread names no company), as the statement's mail.
    const identity = await tx.emailIdentity.findFirst({ where: { companyId: payment.companyId, kind: 'CONVERSATION', isDefault: true, status: 'ACTIVE' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true } })
    const sent = await sendEmail(tools, { record: { type: 'Party', id: payment.partyId }, sender: { userId: SYSTEM_ACTOR_ID, name: companyName, email: null }, to: contacts.map((contact) => contact.email), subject: mail.subject, body: mail.body, identityId: identity?.id ?? null, locale: language })
    tools.audit({ action: 'receivables.paymentNotice', recordType: 'Payment', recordId: payment.id, companyId: payment.companyId, after: { partyId: payment.partyId, outboundId: sent.outbound.id, recipients: contacts.length, language } })
    tools.emit({ type: 'payment.receipt_sent', subject: payment.id, companyId: payment.companyId, payload: { paymentId: payment.id, partyId: payment.partyId, outboundId: sent.outbound.id } })
    return { outboundId: sent.outbound.id, held: null }
  })
  return result
}

/** The worker's handler (background.ts W2B_402_HANDLERS). */
export function paymentNoticeHandler(): EventHandler {
  return defineHandler({
    name: 'receivables.paymentNotice',
    events: ['payment.recorded'],
    async handle(event, tools) {
      const paymentId = (event.payload as { paymentId?: unknown }).paymentId
      if (typeof paymentId !== 'string') return
      await sendPaymentNotice(tools.caller, paymentId, `payment-notice:${paymentId}`)
    },
  })
}

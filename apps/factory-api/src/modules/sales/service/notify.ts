import { InvalidStateError, ValidationError } from '@nexus/factory-domain/core/errors'
import { mailLanguageOf, statusMailOf } from '@nexus/factory-domain/sales/service/mail'
import { SERVICE_CASE_RECORD, type CaseStatus, type MoveTarget } from '@nexus/factory-domain/sales/service/rules'
import type { CommandTools } from '../../../core/command'
import { sendEmail } from '../../../platform/email-out/outbound'
import type { CaseRow } from './store'

/**
 * The customer told at a status change (B-W2b-345; SAL-436): when the case says so (`notifyCustomer`, OFF by default), the
 * move's own command queues a mail to the case's contact on the case's thread (email out: an OUTBOUND message on the thread,
 * an EmailOutbound row QUEUED, email.queued; the worker delivers it — FAKE locally and in tests, the real SES only on the
 * Owner's connection), sent as the person who moved the case, in the contact's language (else the customer's, else
 * Italian). A mail that cannot go (no contact with an e-mail any more, an address on the blocked list, no sending address
 * for the company) does not hold the move: the answer and the audit row say why, and the case shows it was not sent.
 */

export type Notified =
  | { readonly sent: true; readonly emailId: string; readonly to: string; readonly subject: string }
  | { readonly sent: false; readonly reason: 'NO_CONTACT_EMAIL' | 'NOT_SENT'; readonly words: string }

export async function tellCustomerInCommand(tools: CommandTools, row: CaseRow, move: { readonly from: CaseStatus; readonly to: MoveTarget; readonly message?: string | null | undefined }): Promise<Notified> {
  const { tx, context } = tools
  const contact = row.contactId ? await tx.partyContact.findUnique({ where: { id: row.contactId }, select: { name: true, email: true, language: true, status: true, erasedAt: true } }) : null
  if (!contact || !contact.email || contact.status !== 'ACTIVE' || contact.erasedAt !== null) {
    return { sent: false, reason: 'NO_CONTACT_EMAIL', words: `Case ${row.number}: the customer was not told: the case names no active contact with an e-mail.` }
  }
  const sender = context.audience === 'office' ? await tx.user.findUnique({ where: { id: context.actorId }, select: { id: true, displayName: true, email: true } }) : null
  if (!sender) return { sent: false, reason: 'NOT_SENT', words: `Case ${row.number}: the customer was not told: a status mail is sent as an office person.` }
  const party = row.partyId ? await tx.party.findUnique({ where: { id: row.partyId }, select: { language: true } }) : null
  const company = await tx.company.findUniqueOrThrow({ where: { id: row.companyId }, select: { legalName: true, tradeName: true } })
  const language = mailLanguageOf(contact.language, party?.language)
  const mail = statusMailOf({ language, number: row.number, from: move.from, to: move.to, contactName: contact.name, message: move.message, companyName: company.tradeName ?? company.legalName })
  try {
    const queued = await sendEmail(tools, {
      record: { type: SERVICE_CASE_RECORD, id: row.id },
      sender: { userId: sender.id, name: sender.displayName, email: sender.email },
      to: [contact.email],
      subject: mail.subject,
      body: mail.body,
      locale: language,
    })
    return { sent: true, emailId: queued.outbound.id, to: contact.email, subject: mail.subject }
  } catch (error) {
    // Refused before anything was written (the recipients, the sending address, a closed thread): the move goes on, said.
    if (error instanceof ValidationError || error instanceof InvalidStateError) {
      const why = error.issues && error.issues.length > 0 ? error.issues.map((issue) => issue.message).join(' ') : error.message
      return { sent: false, reason: 'NOT_SENT', words: `Case ${row.number}: the customer was not told: ${why}` }
    }
    throw error
  }
}

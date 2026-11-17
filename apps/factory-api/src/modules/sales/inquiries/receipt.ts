import type { FactoryClient } from '@nexus/factory-db'
import { DomainError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { formatDate } from '@nexus/factory-domain/documents/format'
import { footerOf, privacyNoticeUrl } from '@nexus/factory-domain/email/footer'
import { fromLine, messageIdFor, replyAddress } from '@nexus/factory-domain/email/headers'
import { buildMime } from '@nexus/factory-domain/email/mime'
import { normalizeAddress } from '@nexus/factory-domain/email/rules'
import { events as inquiryEvents } from '@nexus/factory-domain/sales-inquiries/events'
import { customerRefOf } from '@nexus/factory-domain/sales/customer-numbers'
import { composeWordsMail } from '@nexus/factory-domain/templates/compose'
import { codeWordsOf, companyValues, fillMail, type MailWords } from '@nexus/factory-domain/templates/mail'
import { messageLanguageOf, type MessageLanguage } from '@nexus/factory-domain/templates/message-languages'
import { COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandTools } from '../../../core/command'
import type { Clock } from '../../../core/time'
import { companyLegalOf } from '../../../platform/documents/documents'
import { deliverOutbound, sendingIdentity, suppressedAmong } from '../../../platform/email-out/outbound'
import { processEmail, type EmailRuntime } from '../../../platform/email-out/service'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { mailTemplateOf } from '../../../platform/templates/active'
import { inquirySubjectOf } from '../../../platform/templates/replies'

/**
 * th-backend-g step 2 (threads plan TH-6 B-TH-279 "request received — the receipt with its number"; P-CUS-NEW.receipt-F02 "a 'request
 * received' mail in their language; the page says so if it could not be sent"): the receipt of a customer's request, sent by Nexus to
 * the ONE person who sent it — never to anyone else:
 *
 *   PORTAL   the portal person who sent it, at once, by the send itself (modules/sales/portal-requests/requests.ts): its answer says
 *            whether the copy was mailed; the portal's own notice of it (portal.request.received) is not mailed to them as well
 *   MAIL     the customer's contact who wrote the mail it was made from (the worker's handler `sales.requestReceipt` of
 *            inquiry.received), only when the mail came from that contact's own address with a passing DMARC: a mail the office made
 *            into a request for another contact, a forward or a failing sender gets nothing
 *   others   typed by the office (a visit, a phone call, a fair), and a prospect's request (no customer yet): no receipt
 *
 * Its words: the e-mail template request.received in use in the recipient's message language (B-TH-098: their contact's language, the
 * customer's, the company's — the company's own version, else every company's), else the code's words; a German, French or Spanish
 * draft by Claude not read yet never goes on its own (the company's English version, else the code's English: codeWordsOf). The
 * numbers are the customer's OWN ("your request 7", §0.5), never the office's INQ-… series. The answer address is the request's thread
 * (the customer's reply lands on the request). Once per request (a second send finds the first); a suppressed address gets nothing. The
 * outbound row (record Inquiry, template request.received) keeps the subject only: the text is composed in memory.
 */

export const RECEIPT_TEMPLATE = 'request.received'
export const REQUEST_RECEIPT_HANDLER = 'sales.requestReceipt'

export interface ReceiptRecipient {
  readonly email: string
  readonly name: string | null
  /** Their own language as kept (their contact's), or null: the customer's, then the company's. */
  readonly language: string | null
}

export type ReceiptOutcome =
  | { readonly sent: true; readonly outboundId: string; readonly language: MessageLanguage }
  | { readonly sent: false; readonly reason: 'NOT_A_CUSTOMER' | 'SUPPRESSED' | 'NO_SENDER' | 'NOT_SENT' }

/** The receipt's words: the template in use in the language, else the code's (an unread draft: the company's English, else the code's). */
async function receiptWords(db: Pick<FactoryClient, 'emailTemplate'>, context: { readonly audience: string } | null | undefined, companyId: string, language: MessageLanguage): Promise<{ words: MailWords; language: MessageLanguage }> {
  const own = await mailTemplateOf(db, context, { companyId, event: RECEIPT_TEMPLATE, language })
  if (own) return { words: own, language }
  const code = codeWordsOf(RECEIPT_TEMPLATE, language)
  if (code.fellBack) {
    const english = await mailTemplateOf(db, context, { companyId, event: RECEIPT_TEMPLATE, language: 'en' })
    if (english) return { words: english, language: 'en' }
  }
  return { words: code.words, language: code.language }
}

/** What the receipt says and to whom it answers, read in the system's scope; null: the request is gone or has no customer. */
async function receiptOf(system: CommandCaller, inquiryId: string, to: ReceiptRecipient) {
  return system.withClient(async (db) => {
    const inquiry = await db.inquiry.findUnique({ where: { id: inquiryId }, select: { id: true, companyId: true, partyId: true, customerSeq: true, request: true, wantedDate: true, sourceEmailId: true } })
    if (!inquiry || inquiry.partyId === null) return null
    const party = await db.party.findUnique({ where: { id: inquiry.partyId }, select: { legalName: true, tradeName: true, language: true } })
    const company = await db.company.findUnique({ where: { id: inquiry.companyId }, select: { legalName: true, tradeName: true, locale: true } })
    if (!party || !company) return null
    const asked = messageLanguageOf({ contact: to.language, party: party.language, company: company.locale }).language
    const { words, language } = await receiptWords(db, system.factoryContext, inquiry.companyId, asked)
    const mail = inquiry.sourceEmailId ? await db.inboundEmail.findUnique({ where: { id: inquiry.sourceEmailId }, select: { subject: true } }) : null
    const thread = await db.thread.findFirst({ where: { recordType: 'Inquiry', recordId: inquiry.id }, select: { replyToken: true } })
    const filled = fillMail(words, {
      ...companyValues(company),
      // §0.5: the customer's own number of the request ("7", "#7"), never the office's series.
      'inquiry.yourNumber': inquiry.customerSeq !== null ? String(inquiry.customerSeq) : null,
      'inquiry.number': customerRefOf('REQUEST', inquiry.customerSeq),
      'inquiry.subject': inquirySubjectOf(mail?.subject ?? null, inquiry.request),
      'inquiry.wantedDate': inquiry.wantedDate ? formatDate(businessDate(inquiry.wantedDate, 'UTC'), language === 'en' ? 'en' : 'it') : null,
      'contact.name': to.name?.trim() || null,
      'party.name': party.tradeName?.trim() || party.legalName.trim(),
      'me.name': null,
    })
    return { companyId: inquiry.companyId, language, filled, replyToken: thread?.replyToken ?? null }
  })
}

/** The company's default notification address, else its default conversation one (ready ones only). */
async function identityOf(tools: Pick<CommandTools, 'tx'>, companyId: string) {
  try {
    return await sendingIdentity(tools.tx, companyId, null, 'NOTIFICATION')
  } catch (error) {
    if (error instanceof DomainError) return sendingIdentity(tools.tx, companyId, null, 'CONVERSATION')
    throw error
  }
}

/** Sends the receipt of one request to the one person given (see the module comment). Never throws for a mail that cannot go. */
export async function sendRequestReceipt(system: CommandCaller, runtime: EmailRuntime, input: { readonly inquiryId: string; readonly to: ReceiptRecipient; readonly clock?: Clock | undefined }): Promise<ReceiptOutcome> {
  const receipt = await receiptOf(system, input.inquiryId, input.to)
  if (!receipt) return { sent: false, reason: 'NOT_A_CUSTOMER' }
  const address = normalizeAddress(input.to.email)
  const outboundId = newId()
  let made: { id: string; replyDomain: string | null } | 'SUPPRESSED' | 'NO_SENDER'
  try {
    const { result } = await runCommand(
      system,
      { name: 'sales.requestReceipt', input: { inquiryId: input.inquiryId } },
      async (tools) => {
        const { tx, now } = tools
        // Once per request: a second send (a retry, the worker after the portal) finds the first.
        const first = await tx.emailOutbound.findFirst({ where: { recordType: 'Inquiry', recordId: input.inquiryId, templateKey: RECEIPT_TEMPLATE }, select: { id: true } })
        if (first) return { id: first.id, replyDomain: null, again: true }
        if ((await suppressedAmong(tx, [address])).size > 0) return 'SUPPRESSED' as const
        const identity = await identityOf(tools, receipt.companyId)
        const from = fromLine(identity, null)
        await tx.emailOutbound.create({
          data: {
            id: outboundId,
            companyId: identity.companyId,
            identityId: identity.id,
            recordType: 'Inquiry',
            recordId: input.inquiryId,
            templateKey: RECEIPT_TEMPLATE,
            locale: receipt.language,
            fromAddress: from.address,
            fromName: from.name,
            to: [address],
            subject: receipt.filled.subject,
            emailMessageId: messageIdFor(outboundId, identity.domain),
            status: 'QUEUED',
            queuedAt: now,
            createdAt: now,
            updatedAt: now,
          },
          select: { id: true },
        })
        // The audit row names the request and the language: never the address or the words.
        tools.audit({ recordType: 'EmailOutbound', recordId: outboundId, companyId: identity.companyId, after: { templateKey: RECEIPT_TEMPLATE, inquiryId: input.inquiryId, identityId: identity.id, language: receipt.language, status: 'QUEUED' } })
        return { id: outboundId, replyDomain: identity.replyDomain, again: false }
      },
      { ...COMMAND_SETTINGS, ...(input.clock ? { clock: input.clock } : {}) },
    )
    if (result === 'SUPPRESSED') made = 'SUPPRESSED'
    else if (result.again) return { sent: true, outboundId: result.id, language: receipt.language }
    else made = { id: result.id, replyDomain: result.replyDomain }
  } catch (error) {
    // No ready sending address for the company: the request stands, the receipt is not sent (said by the caller).
    if (error instanceof DomainError) made = 'NO_SENDER'
    else throw error
  }
  if (made === 'SUPPRESSED' || made === 'NO_SENDER') return { sent: false, reason: made }
  const legal = await companyLegalOf(system, receipt.companyId)
  const footer = footerOf(legal, privacyNoticeUrl(runtime.webOrigin, receipt.companyId), receipt.language === 'it' ? 'it' : 'en')
  const mail = composeWordsMail(receipt.filled, { text: ['', footer.text], html: footer.html })
  const replyTo = receipt.replyToken && made.replyDomain ? replyAddress(receipt.replyToken, made.replyDomain) : null
  const delivered = await deliverOutbound(runtime, system, made.id, {
    retry: false,
    ...(input.clock ? { clock: input.clock } : {}),
    build: async (row) =>
      buildMime({ id: row.id, from: { name: row.fromName, address: row.fromAddress }, to: row.to, cc: [], replyTo, subject: row.subject, messageId: row.emailMessageId, inReplyTo: null, references: [], date: (input.clock ?? COMMAND_SETTINGS.clock).now(), text: mail.text, html: mail.html, automatic: true }),
  })
  return delivered === 'sent' ? { sent: true, outboundId: made.id, language: receipt.language } : { sent: false, reason: 'NOT_SENT' }
}

// ---- the portal: the person who sent the request -----------------------------------------------------------------------------

/** A portal person as the receipt's recipient: their contact at the customer with the same address names their language. */
export async function portalRecipient(system: CommandCaller, partyId: string, person: { readonly email: string; readonly displayName: string }): Promise<ReceiptRecipient> {
  const contact = await system.withClient((db) => db.partyContact.findFirst({ where: { partyId, status: 'ACTIVE', email: { equals: person.email, mode: 'insensitive' } }, select: { language: true } }))
  return { email: person.email, name: person.displayName, language: contact?.language ?? null }
}

// ---- the worker: a request made from a customer's mail -------------------------------------------------------------------------

const receivedPayload = inquiryEvents.find((event) => event.type === 'inquiry.received')!.payload

/** The contact who wrote the mail a request was made from — only that contact's own address, with a passing DMARC; else null. */
async function mailSender(db: Pick<FactoryClient, 'inquiry' | 'partyContact' | 'inboundEmail'>, inquiryId: string): Promise<ReceiptRecipient | null> {
  const inquiry = await db.inquiry.findUnique({ where: { id: inquiryId }, select: { source: true, partyId: true, contactId: true, sourceEmailId: true } })
  if (!inquiry || inquiry.source !== 'MAIL' || !inquiry.partyId || !inquiry.contactId || !inquiry.sourceEmailId) return null
  const contact = await db.partyContact.findFirst({ where: { id: inquiry.contactId, partyId: inquiry.partyId }, select: { name: true, email: true, language: true, status: true, erasedAt: true } })
  const mail = await db.inboundEmail.findUnique({ where: { id: inquiry.sourceEmailId }, select: { fromAddress: true, dmarcVerdict: true } })
  if (!contact?.email || contact.status !== 'ACTIVE' || contact.erasedAt !== null || !mail?.fromAddress || mail.dmarcVerdict !== 'PASS') return null
  if (normalizeAddress(mail.fromAddress) !== normalizeAddress(contact.email)) return null
  return { email: contact.email, name: contact.name, language: contact.language }
}

/** The worker's handler (background.ts W2B_394_HANDLERS): the receipt of a request made from a customer's mail. */
export function requestReceiptHandler(options: { readonly runtime?: () => EmailRuntime; readonly clock?: Clock } = {}): EventHandler {
  return defineHandler({
    name: REQUEST_RECEIPT_HANDLER,
    events: ['inquiry.received'],
    async handle(event, tools) {
      const payload = receivedPayload.parse(event.payload) as { inquiryId: string; source: string; partyId: string | null }
      if (payload.source !== 'MAIL' || payload.partyId === null) return
      const to = await tools.caller.withClient((db) => mailSender(db, payload.inquiryId))
      if (!to) return
      await sendRequestReceipt(tools.caller, (options.runtime ?? processEmail)(), { inquiryId: payload.inquiryId, to, clock: options.clock })
    },
  })
}

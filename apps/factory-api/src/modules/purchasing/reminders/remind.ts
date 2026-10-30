import { InvalidStateError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { BUSINESS_TIME_ZONE, businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { purchaseOrderDocumentNumber } from '@nexus/factory-domain/purchasing/document'
import { MAX_TEXT, supplierLanguageOf } from '@nexus/factory-domain/purchasing/orders'
import { confirmationReminderMail, remindProblem } from '@nexus/factory-domain/purchasing/orders/delivery'
import { PURCHASING_SEND } from '@nexus/factory-domain/purchasing/permissions'
import type { CommandCaller, CommandTools } from '../../../core/command'
import { SYSTEM_ACTOR_ID } from '../../../core/context'
import { sendEmail } from '../../../platform/email-out/outbound'
import { detailInCommand, onOrder } from '../orders'
import { officeContextOf, officeOrder, senderOf, type OrderRow } from '../store'

/**
 * A reminder to confirm a purchase order (B-W2a-52; SCM-087 "Confirmation deadline and reminders"; design
 * purchasing.orders record › Sends "Reminders sent", the send dialog "Confirm by (default 48 h; reminder and buyer alert
 * after)"). THE one place a reminder is written, inside a command on the order:
 *
 *   1. only while the order waits for its supplier's answer (SENT; factory-domain remindProblem; the …_supply_w2a_guards
 *      trigger refuses any other), to the order's ACTIVE contact with an e-mail;
 *   2. the mail on the order's thread (email out's sendEmail: the worker sends it; FAKE in local and test) with the PDF of
 *      the current revision, and no link (a link is a bearer token kept nowhere: the mail says to use the one received,
 *      or to reply for a new one);
 *   3. the PurchaseOrderReminder row (append-only): the revision it reminds of, who (null: the daily run), the address,
 *      the mail's id; the audit row; purchase_order.reminder_sent.
 *
 * By the buyer: POST /purchasing/orders/:id/remind (purchasing.send), at any time while the order waits. By the daily run
 * (./daily.ts) only for a company whose automatic reminders are on — the Owner's switch, OFF until a setting holds it.
 * The buyer's alert after the deadline is the exception rule PO_NOT_CONFIRMED's (platform/alerts): no alert here.
 */

/** The purchasing office, as the daily run's mail and the thread show it (as the link renewal's, ../confirm/renew.ts). */
export const SYSTEM_SENDER = { userId: SYSTEM_ACTOR_ID, name: 'Ufficio acquisti', email: null } as const

export interface RemindBody {
  readonly version: number
  /** The buyer's own words, after the standard text. */
  readonly message?: string | null | undefined
}

/** Inside a command on the order (its version already compared and set): steps 1–3. */
export async function remindInCommand(tools: CommandTools, current: OrderRow, input: { readonly sender: { readonly userId: string; readonly name: string; readonly email: string | null }; readonly sentById: string | null; readonly message: string | null }) {
  const { tx, now } = tools
  const problem = remindProblem(current.status)
  if (problem) throw new InvalidStateError(problem)
  const contact = current.contactId ? await tx.partyContact.findUnique({ where: { id: current.contactId }, select: { name: true, email: true, language: true, status: true } }) : null
  if (!contact?.email || contact.status !== 'ACTIVE') throw new InvalidStateError('Choose an active contact with an e-mail: the reminder goes to them.')
  const party = await tx.party.findUniqueOrThrow({ where: { id: current.partyId }, select: { language: true } })
  const language = supplierLanguageOf(contact.language, party.language)
  // The PDF of the revision the supplier holds (the revision row's, else the order's newest print).
  const revisionRow = await tx.purchaseOrderRevision.findFirst({ where: { purchaseOrderId: current.id, revision: current.revision }, select: { documentFileId: true } })
  const file = revisionRow?.documentFileId
    ? { id: revisionRow.documentFileId }
    : await tx.storedFile.findFirst({ where: { recordType: 'PurchaseOrder', recordId: current.id, kind: 'FISCAL_ARCHIVE', status: 'AVAILABLE' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true } })
  const sentAt = current.sentAt ?? now
  const mail = confirmationReminderMail({
    language,
    number: purchaseOrderDocumentNumber(current.number, current.revision),
    recipientName: contact.name,
    sentOn: businessDate(sentAt),
    confirmBy: current.confirmBy ?? sentAt,
    timeZone: BUSINESS_TIME_ZONE,
    message: input.message,
  })
  const sent = await sendEmail(tools, { record: { type: 'PurchaseOrder', id: current.id }, sender: input.sender, to: [contact.email], subject: mail.subject, body: mail.body, attachments: file ? [file.id] : [], locale: language })
  const id = newId()
  await tx.purchaseOrderReminder.create({
    data: { id, purchaseOrderId: current.id, partyId: current.partyId, siteId: current.siteId, revision: current.revision, kind: 'CONFIRMATION', sentAt: now, sentById: input.sentById, toAddress: contact.email, emailOutboundId: sent.outbound.id, note: input.message, createdById: input.sentById },
    select: { id: true },
  })
  const automatic = input.sentById === null
  tools.audit({
    action: automatic ? 'purchasing.remindAutomatic' : 'purchasing.remind',
    recordType: 'PurchaseOrder',
    recordId: current.id,
    companyId: current.companyId,
    siteId: current.siteId,
    after: { reminderId: id, revision: current.revision, kind: 'CONFIRMATION', to: contact.email, outboundId: sent.outbound.id, confirmBy: current.confirmBy ? toUtcIso(current.confirmBy) : null, automatic },
  })
  tools.emit({ type: 'purchase_order.reminder_sent', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { purchaseOrderId: current.id, number: current.number, revision: current.revision, reminderId: id, outboundId: sent.outbound.id, automatic } })
  return { id, revision: current.revision, sentAt: toUtcIso(now), to: contact.email, emailId: sent.outbound.id, automatic }
}

/** POST /purchasing/orders/:purchaseOrderId/remind (purchasing.send): the buyer reminds the supplier now. */
export async function remindSupplier(caller: CommandCaller, orderId: string, body: RemindBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId, PURCHASING_SEND)
  const message = body.message?.trim() ? body.message.trim() : null
  if (message !== null && message.length > MAX_TEXT.message) throw new ValidationError('The message is too long.', [{ path: 'body/message', message: `At most ${MAX_TEXT.message} characters.` }])
  return onOrder(caller, order, { name: 'purchasing.remind', idempotencyKey, input: { orderId, ...body }, version: body.version }, async (tools, current) => {
    const reminder = await remindInCommand(tools, current, { sender: await senderOf(tools.tx, context), sentById: context.actorId, message })
    return { ...(await detailInCommand(tools, current.id)), reminder }
  })
}

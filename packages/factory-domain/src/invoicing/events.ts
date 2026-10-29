import { z } from 'zod'
import { defineEvent } from '../events/define'
import { INVOICE_DOC_TYPES, INVOICE_STATUSES } from './invoices'
import { SDI_NOTIFICATION_TYPES } from '../ports/sdi'
import { SDI_SEND_STATUSES } from './sdi/states'

/**
 * The invoicing module's events (plan A1 §3.4, §3.5; B-W1-28; FIN-054, FIN-057, FIN-061, FIN-066). apps/factory-api's
 * modules/invoicing emits them in the command that makes the change. Payloads carry ids, the type and the number only:
 * never an amount (money stays behind the price grain; a screen refetches what it shows) nor a name.
 *
 *   invoice.draft_saved     a draft was created, or its lines or text changed (the invoices list and record)
 *   invoice.draft_deleted   a draft was deleted (it had no number: no gap)
 *   invoice.issued          a draft was issued: its number and date (the payments matcher's open items, A2 SCR-082);
 *                           the worker makes its XML and PDF when the issuing request could not (invoicing files handler)
 *   invoice.files_attached  the issued invoice names its XML (the legal invoice) and its PDF courtesy copy
 *
 * SDI (B-W1-50; FIN-084, FIN-086, FIN-087, FIN-088, FIN-092; modules/invoicing/sdi):
 *   invoice.sdi_status_changed        a send moved (SENDING, SENT, FAILED, an outcome) and with it, maybe, the invoice:
 *                                     the SDI column, the record's SDI tab (live); the worker's courtesy copy (MC) and
 *                                     legal archive (an outcome that reached the buyer's side) handlers
 *   invoice.sdi_notification_received SDI's notification was recorded (once per message); `conflict`: it contradicts the
 *                                     send's recorded outcome and was not applied (a person looks)
 *   invoice.sdi_corrected             a rejected invoice was corrected (lines, totals, buyer and seller data)
 *   invoice.sdi_poll_due              the status poll asks the provider about one send (the worker's handler)
 *   invoice.sdi_archived              the sent invoice is in legal archiving (conservazione) at the intermediary
 *   invoice.courtesy_copy_queued      SDI could not deliver it: the customer's copy is queued by e-mail (FIN-088)
 *   invoice.courtesy_copy_missing     … and could not be: why (no contact with an address, no sender, no PDF …)
 *
 * Invoices from shipped goods, credit notes, the order settled (B-W1-51; FIN-054, FIN-069, FIN-078, FIN-121;
 * modules/invoicing/from-shipment, credit-note):
 *   invoice.refund_due     a credit note was issued on what is paid: a refund is due to the customer (refunds are W2b;
 *                          the needs-attention list)
 *   order.fully_settled    the order became settled: every line shipped, invoiced (SDI delivered or not deliverable) and
 *                          paid. Emitted once per change, by the command that completed it (a payment allocated, an SDI
 *                          outcome); B-W1-25's close command consumes it (the order's CLOSED state is sales')
 *   order.unsettled        a settled order is not settled any more (a credit note, an allocation reversed, a new invoice):
 *                          `missing` says what (factory-domain invoicing/from-shipment/settlement codes)
 */
const docType = z.enum(INVOICE_DOC_TYPES)
const live = { permission: 'invoices.view', fields: ['invoiceId', 'docType'] } as const
const sdiLive = { permission: 'invoices.view', fields: ['invoiceId'] } as const
const invoiceStatus = z.enum(INVOICE_STATUSES)

export const events = [
  defineEvent({
    type: 'invoice.draft_saved',
    context: 'invoicing',
    description: 'A draft invoice was created, or its lines or text changed.',
    payload: z.strictObject({ invoiceId: z.uuid(), docType, created: z.boolean() }),
    live,
  }),
  defineEvent({
    type: 'invoice.draft_deleted',
    context: 'invoicing',
    description: 'A draft invoice was deleted (it had no number).',
    payload: z.strictObject({ invoiceId: z.uuid(), docType }),
    live,
  }),
  defineEvent({
    type: 'invoice.issued',
    context: 'invoicing',
    description: 'An invoice was issued: it has its number and date from the fiscal series and never changes again.',
    payload: z.strictObject({ invoiceId: z.uuid(), docType, number: z.string(), issueDate: z.string(), partyId: z.uuid(), depositRequestId: z.uuid().nullable() }),
    live: { permission: 'invoices.view', fields: ['invoiceId', 'docType', 'number'] },
  }),
  defineEvent({
    type: 'invoice.files_attached',
    context: 'invoicing',
    description: 'An issued invoice names its FatturaPA XML and its PDF courtesy copy.',
    payload: z.strictObject({ invoiceId: z.uuid(), xmlFileId: z.uuid(), pdfFileId: z.uuid() }),
    live: { permission: 'invoices.view', fields: ['invoiceId'] },
  }),
  defineEvent({
    type: 'invoice.sdi_status_changed',
    context: 'invoicing',
    description: 'A send of an invoice to SDI moved, and the invoice with it when its sends decided so.',
    payload: z.strictObject({ invoiceId: z.uuid(), submissionId: z.uuid(), attempt: z.number().int().min(1), sendStatus: z.enum(SDI_SEND_STATUSES), invoiceStatus, previousStatus: invoiceStatus }),
    live: { permission: 'invoices.view', fields: ['invoiceId', 'sendStatus', 'invoiceStatus'] },
  }),
  defineEvent({
    type: 'invoice.sdi_notification_received',
    context: 'invoicing',
    description: "SDI's notification about a send was recorded (once per message).",
    payload: z.strictObject({ invoiceId: z.uuid(), submissionId: z.uuid(), notificationId: z.uuid(), type: z.enum(SDI_NOTIFICATION_TYPES), conflict: z.boolean() }),
    live: { permission: 'invoices.view', fields: ['invoiceId', 'type'] },
  }),
  defineEvent({
    type: 'invoice.sdi_corrected',
    context: 'invoicing',
    description: 'A rejected invoice was corrected before it is sent again under the same number and date.',
    payload: z.strictObject({ invoiceId: z.uuid(), linesReplaced: z.boolean() }),
    live: sdiLive,
  }),
  defineEvent({
    type: 'invoice.sdi_poll_due',
    context: 'invoicing',
    description: 'The status poll asks the SDI intermediary about one send that has no outcome yet.',
    payload: z.strictObject({ invoiceId: z.uuid(), submissionId: z.uuid() }),
  }),
  defineEvent({
    type: 'invoice.sdi_archived',
    context: 'invoicing',
    description: 'The sent invoice is in legal archiving (conservazione) at the SDI intermediary.',
    payload: z.strictObject({ invoiceId: z.uuid(), submissionId: z.uuid() }),
    live: sdiLive,
  }),
  defineEvent({
    type: 'invoice.courtesy_copy_queued',
    context: 'invoicing',
    description: 'SDI could not deliver the invoice: a copy is queued by e-mail to the customer, saying it is in their tax drawer.',
    payload: z.strictObject({ invoiceId: z.uuid(), submissionId: z.uuid(), outboundId: z.uuid() }),
    live: sdiLive,
  }),
  defineEvent({
    type: 'invoice.courtesy_copy_missing',
    context: 'invoicing',
    description: 'SDI could not deliver the invoice and its copy could not be e-mailed: a person sends it.',
    payload: z.strictObject({ invoiceId: z.uuid(), submissionId: z.uuid(), reason: z.string().max(500) }),
    live: sdiLive,
  }),
  defineEvent({
    type: 'invoice.refund_due',
    context: 'invoicing',
    description: 'A credit note was issued on an invoice paid beyond what it is now worth: a refund is due to the customer.',
    payload: z.strictObject({ invoiceId: z.uuid(), creditOfId: z.uuid(), partyId: z.uuid() }),
    live: { permission: 'invoices.view', fields: ['invoiceId', 'creditOfId'] },
  }),
  defineEvent({
    type: 'order.fully_settled',
    context: 'invoicing',
    description: 'The order is settled: every line shipped and invoiced, every fiscal document delivered by SDI, the balance paid.',
    payload: z.strictObject({ orderId: z.uuid(), partyId: z.uuid() }),
    live: { permission: 'invoices.view', fields: ['orderId'] },
  }),
  defineEvent({
    type: 'order.unsettled',
    context: 'invoicing',
    description: 'A settled order is not settled any more (a credit note, a payment taken back, a new invoice).',
    payload: z.strictObject({ orderId: z.uuid(), partyId: z.uuid(), missing: z.array(z.string().max(40)).max(20) }),
    live: { permission: 'invoices.view', fields: ['orderId'] },
  }),
] as const

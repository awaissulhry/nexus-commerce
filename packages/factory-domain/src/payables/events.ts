import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * The payables' events (plan A1 §3.4; B-W2a-62; FIN-136, FIN-137). apps/factory-api modules/payables emits them in the
 * commands that record a supplier invoice (from SDI or typed), change it, match it, accept a difference, send the
 * differences to the buyer, approve, dispute, pay or void it, and in the SDI pickup. Ids, states, kinds and counts only:
 * never an amount, a price or a text. Live on the screens of the people who hold payables.view for the company (design
 * finance.payables: "finance.sdi.inbound → New rows", "inventory.receipt.posted → Match results").
 *
 *   supplier_invoice.received             recorded: delivered by SDI (picked up), or typed in from its PDF
 *   supplier_invoice.changed              a typed one corrected, a line added, changed, removed or mapped, a file named
 *   supplier_invoice.matched              the three-way match was done (again) and its result changed or was asked for
 *   supplier_invoice.difference_accepted  a person accepted a difference outside the tolerance, in words
 *   supplier_invoice.sent_to_buyer        the differences were sent to the buyer (a note on the invoice's thread)
 *   supplier_invoice.approved             approved for payment (by another person than the one who registered it)
 *   supplier_invoice.approval_withdrawn   the approval was withdrawn before payment
 *   supplier_invoice.disputed             disputed with the supplier (a credit note is asked)
 *   supplier_invoice.reopened             a disputed one is back to be matched and approved
 *   supplier_invoice.paid                 the payment was recorded (the bank's date and reference)
 *   supplier_invoice.voided               a typed one was voided (typed by mistake, or a duplicate)
 *   supplier_invoice.claim_settled        a supplier credit note settled a supplier claim (the claim is closed)
 *   supplier_invoice.sdi_pickup_due       the scheduler asks the worker to pick up a company's invoices from SDI
 *   supplier_invoice.sdi_picked_up        a pickup ran: how many invoices were recorded and how many wait for a person
 *
 * B-W2b-21 (Z8:03, Z8:06, Z8:07):
 *   supplier_invoice.claim_matched        a supplier's credit note was matched to a claim closed before it arrived (the
 *                                         claim stays closed; claim_settled closes an accepted one)
 *   payables_settings.changed             the payables settings of a company (or every company) changed
 *   sdi_inbox_item.dismissed              a person dismissed a delivery waiting in the SDI inbox, with why
 *   sdi_inbox_item.reopened               a dismissed delivery is back in the inbox (the next pickup tries it again)
 */
const invoice = { supplierInvoiceId: z.uuid(), partyId: z.uuid() }
const source = z.enum(['SDI', 'EMAIL', 'MANUAL'])
const kind = z.enum(['INVOICE', 'CREDIT_NOTE'])
const matchStatus = z.enum(['PENDING', 'MATCHED', 'DIFFERENCES', 'NO_PO', 'WAITING_GOODS'])
const status = z.enum(['RECEIVED', 'APPROVED', 'PAID', 'DISPUTED', 'VOIDED'])
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const count = z.number().int().min(0)
const live = { permission: 'payables.view' as const, fields: ['supplierInvoiceId', 'partyId', 'status', 'matchStatus'] }

export const events = [
  defineEvent({
    type: 'supplier_invoice.received',
    context: 'payables',
    description: 'A supplier or subcontractor invoice was recorded: delivered by SDI, or typed in from its PDF.',
    payload: z.strictObject({ ...invoice, source, kind, status, matchStatus, lines: count, mapped: count }),
    live,
  }),
  defineEvent({
    type: 'supplier_invoice.changed',
    context: 'payables',
    description: "A supplier invoice changed: a typed one corrected, a line added, changed, removed or mapped to an order, or one of its files named.",
    payload: z.strictObject({ ...invoice, status, matchStatus, fields: z.array(z.string().min(1).max(60)).max(40) }),
    live,
  }),
  defineEvent({
    type: 'supplier_invoice.matched',
    context: 'payables',
    description: 'The three-way match of a supplier invoice (ordered, received, invoiced) was done again.',
    payload: z.strictObject({ ...invoice, status, matchStatus, previousMatchStatus: matchStatus, matches: count, outside: count, accepted: count, bySystem: z.boolean() }),
    live,
  }),
  defineEvent({
    type: 'supplier_invoice.difference_accepted',
    context: 'payables',
    description: 'A person accepted, in words, a difference of a supplier invoice outside the tolerance.',
    payload: z.strictObject({ ...invoice, status, matchStatus, matchId: z.uuid() }),
    live,
  }),
  defineEvent({
    type: 'supplier_invoice.sent_to_buyer',
    context: 'payables',
    description: "The differences of a supplier invoice were sent to the buyer: a note on the invoice's thread naming them.",
    payload: z.strictObject({ ...invoice, status, matchStatus, mentioned: count }),
    live,
  }),
  defineEvent({
    type: 'supplier_invoice.approved',
    context: 'payables',
    description: 'A supplier invoice was approved for payment.',
    payload: z.strictObject({ ...invoice, status, matchStatus }),
    live,
  }),
  defineEvent({
    type: 'supplier_invoice.approval_withdrawn',
    context: 'payables',
    description: 'The approval of a supplier invoice was withdrawn before payment.',
    payload: z.strictObject({ ...invoice, status, matchStatus }),
    live,
  }),
  defineEvent({
    type: 'supplier_invoice.disputed',
    context: 'payables',
    description: 'A supplier invoice was disputed with the supplier (a credit note is asked).',
    payload: z.strictObject({ ...invoice, status, matchStatus }),
    live,
  }),
  defineEvent({
    type: 'supplier_invoice.reopened',
    context: 'payables',
    description: 'A disputed supplier invoice is back to be matched and approved.',
    payload: z.strictObject({ ...invoice, status, matchStatus }),
    live,
  }),
  defineEvent({
    type: 'supplier_invoice.paid',
    context: 'payables',
    description: 'The payment of an approved supplier invoice was recorded.',
    payload: z.strictObject({ ...invoice, status, matchStatus, paidOn: day }),
    live,
  }),
  defineEvent({
    type: 'supplier_invoice.voided',
    context: 'payables',
    description: 'A supplier invoice typed by mistake (or a duplicate) was voided.',
    payload: z.strictObject({ ...invoice, status, matchStatus }),
    live,
  }),
  defineEvent({
    type: 'supplier_invoice.claim_settled',
    context: 'payables',
    description: "A supplier's credit note settled a supplier claim: the claim is closed.",
    payload: z.strictObject({ ...invoice, status, matchStatus, supplierClaimId: z.uuid() }),
    live: { permission: 'payables.view', fields: ['supplierInvoiceId', 'partyId', 'supplierClaimId'] },
  }),
  defineEvent({
    type: 'supplier_invoice.sdi_pickup_due',
    context: 'payables',
    description: "The scheduler asks the worker to pick up the invoices SDI delivered to a company (through its SDI intermediary).",
    payload: z.strictObject({ companyId: z.uuid(), accountId: z.uuid(), step: z.number().int().min(0) }),
  }),
  defineEvent({
    type: 'supplier_invoice.sdi_picked_up',
    context: 'payables',
    description: 'A pickup from SDI ran for a company: how many invoices it recorded, and how many wait for a person.',
    payload: z.strictObject({ companyId: z.uuid(), accountId: z.uuid(), listed: count, recorded: count, waiting: count, byPerson: z.boolean() }),
    live: { permission: 'payables.view', fields: ['companyId', 'recorded', 'waiting'] },
  }),
  // B-W2b-21.
  defineEvent({
    type: 'supplier_invoice.claim_matched',
    context: 'payables',
    description: "A supplier's credit note was matched to a supplier claim that was closed before it arrived.",
    payload: z.strictObject({ ...invoice, status, matchStatus, supplierClaimId: z.uuid() }),
    live: { permission: 'payables.view', fields: ['supplierInvoiceId', 'partyId', 'supplierClaimId'] },
  }),
  defineEvent({
    type: 'payables_settings.changed',
    context: 'payables',
    description: "The payables settings changed: the match's tolerances or billing basis, or who approves what SDI delivered.",
    payload: z.strictObject({ settingsId: z.uuid(), companyId: z.uuid().nullable(), fields: z.array(z.string().min(1).max(60)).max(20), created: z.boolean() }),
    live: { permission: 'payables.view', fields: ['settingsId', 'companyId'] },
  }),
  defineEvent({
    type: 'sdi_inbox_item.dismissed',
    context: 'payables',
    description: 'A person dismissed a delivery waiting in the SDI inbox (not ours, a test delivery …), with why.',
    payload: z.strictObject({ itemId: z.uuid(), companyId: z.uuid(), accountId: z.uuid() }),
    live: { permission: 'payables.view', fields: ['itemId', 'companyId'] },
  }),
  defineEvent({
    type: 'sdi_inbox_item.reopened',
    context: 'payables',
    description: 'A dismissed delivery is back in the SDI inbox: the next pickup tries it again.',
    payload: z.strictObject({ itemId: z.uuid(), companyId: z.uuid(), accountId: z.uuid() }),
    live: { permission: 'payables.view', fields: ['itemId', 'companyId'] },
  }),
] as const

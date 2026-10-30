import { z } from 'zod'
import { defineEvent } from '../events/define'
import { PARTY_TAX_MODES } from '../parties/tax'
import { SALES_ORDER_STATUSES } from './orders/orders'
import { LINK_QUOTE_STATES } from './quotes/acceptance'
import { APPROVAL_REASONS } from './quotes/quotes'
// B-W2a-43: customer returns.
import { RETURN_STATUSES } from './returns/rules'

/**
 * The sales module's events (plan A1 §3.4, §3.5; B-W1-21 quotes). apps/factory-api's modules/sales emits them in the
 * command that makes the change; the quotes list and record, and Home › Approvals, refetch on them (live: quotes.view).
 * Payloads carry ids, the number, the state and the rules' names only: never an amount, a price, a cost or a margin (a
 * screen refetches what it shows, with its viewer's grains), nor a name.
 *
 *   quote.created             a quote was made (its number from the company's QUOTE series), with its first DRAFT version
 *   quote.updated             its header or its DRAFT version's terms changed (which fields)
 *   quote.lines_changed       a line was added, changed or removed, or the version was recomputed (costs, VAT, rules)
 *   quote.approval_requested  the office asked for an approval: the rules the version breaks (its lines freeze)
 *   quote.approval_decided    an approver approved or rejected it
 *   quote.reopened            the version went back to DRAFT for a change (a waiting request is withdrawn)
 *   quote.cancelled           the office withdrew the quote (a sent one: its accept links revoked)
 *   sales_settings.changed    a company's or the tenant's quote rules changed (which fields)
 * B-W1-24 (send and accept):
 *   quote.sent                a version was frozen and sent: its PDF, its accept link, the versions it replaced
 *   quote.link_sent           the office sent a new accept link for the sent version (the older ones revoked)
 *   quote.revised             a new DRAFT version was made from a sent (or declined) one
 *   quote.accepted            the customer accepted the version through its link: what the order needs (B-W1-25 makes it
 *                             from the ACCEPTED version, in the system step after the acceptance)
 *   quote.declined            the customer declined the version through its link
 *   quote.link_requested      the customer asked for a new link (an ended offer, a replaced version)
 *   deposit_request.created   the deposit request of an accepted version (OPEN), with its fiscal decision
 *   company.bank_details_changed  a company's bank account was set, changed or removed (the IBAN masked): the owners and
 *                             administrators are told (live: companies.bank.view)
 * B-W1-25 (orders; live: orders.view):
 *   sales_order.created         the order of an accepted version was made (CONFIRMED), its deposit requests named
 *   sales_order.status_changed  it moved: production started, ready, partly shipped, shipped, closed or cancelled; `by`
 *                               says whether a person or the system (following work orders, shipments, the settlement)
 *   sales_order.promise_changed its promise date (or some lines') changed; the first promise stays
 * B-W2a-19 (the payment terms library and the price lists; live: paymentterms.view, pricelists.view):
 *   payment_terms.changed        terms were added to the library, edited, archived or reactivated
 *   price_list.changed           a price list was made, edited, archived or reactivated, or given to (or taken from)
 *                                customers
 *   price_list.version_changed   a version was made (the next one, its prices copied), its planned days or note changed,
 *                                its prices edited, it was deleted (a draft) or ended (an active one)
 *   price_list.version_activated a draft went live from a day; the version in force then ended the day before
 * B-W2a-30 (orders every day; live: orders.view):
 *   sales_order.created          also for an order typed by the office (quoteId and versionId null)
 *   sales_order.amended          a confirmed order was amended: its revision, the lines it changed, whether the customer
 *                                must accept it again (never an amount: the screen reads the amendment)
 *   sales_order.lines_closed     lines were closed short (what is left of them will not be made or shipped) or reopened
 *   sales_order.schedule_changed its payment schedule was made, made again after an amendment, a step paid (its
 *                                deposit) or cancelled with the order
 * B-W2a-43 (customer returns; live: sales.returns.view; the dock's events also reach the floor of the RMA's site):
 *   return.authorised            an RMA was made (AUTHORISED, numbered), with the lines that come back and the deadline
 *   return.lines_changed         lines were added, changed or removed before the goods arrived
 *   return.changed               its owner, deadline, customer reference or note changed (which fields)
 *   return.received              goods arrived at the dock (a receipt): the lines and pieces received
 *   return.graded                received lines were graded (grade, cause, condition)
 *   return.decided               graded lines were decided (what the customer gets, where the goods go); `inspected`
 *                                says the RMA became INSPECTED; the stock moves the outcomes posted
 *   return.credit_due            decided lines carry a credit: the credit note waits (B-W2a-61 listens; it reads the
 *                                lines' credit values itself, never from the payload)
 *   return.status_changed        it moved (received, inspected, more goods came, closed, cancelled)
 *   return.replacement_ordered   the replacement order was made for its REPLACE lines
 *   return_policy.changed        a company's or the tenant's return policy changed (which fields)
 */
const live = { permission: 'quotes.view', fields: ['quoteId', 'versionId'] } as const
const orderLive = { permission: 'orders.view', fields: ['orderId', 'number'] } as const
const orderStatus = z.enum(SALES_ORDER_STATUSES)
// B-W2a-43: customer returns.
const returnLive = { permission: 'sales.returns.view', fields: ['returnId', 'number'] } as const
const returnStatus = z.enum(RETURN_STATUSES)
const ids = { quoteId: z.uuid(), versionId: z.uuid() }

export const events = [
  defineEvent({
    type: 'quote.created',
    context: 'sales',
    description: 'A quote was made for a customer, with its number and a first draft version.',
    payload: z.strictObject({ ...ids, number: z.string(), partyId: z.uuid() }),
    live: { permission: 'quotes.view', fields: ['quoteId', 'versionId', 'number'] },
  }),
  defineEvent({
    type: 'quote.updated',
    context: 'sales',
    description: "A quote's header or its draft version's terms changed.",
    payload: z.strictObject({ ...ids, fields: z.array(z.string()) }),
    live,
  }),
  defineEvent({
    type: 'quote.lines_changed',
    context: 'sales',
    description: "A draft quote's lines changed (added, changed, removed) or it was recomputed: totals, costs, VAT and the approval rules follow.",
    payload: z.strictObject({ ...ids, change: z.enum(['added', 'changed', 'removed', 'recomputed']), lineId: z.uuid().nullable() }),
    live,
  }),
  defineEvent({
    type: 'quote.approval_requested',
    context: 'sales',
    description: 'The office asked for an approval of a quote version that breaks a rule (margin floor, discount limit); its lines are frozen while it waits.',
    payload: z.strictObject({ ...ids, approvalId: z.uuid(), reasons: z.array(z.enum(APPROVAL_REASONS)) }),
    live: { permission: 'quotes.view', fields: ['quoteId', 'versionId', 'approvalId', 'reasons'] },
  }),
  defineEvent({
    type: 'quote.approval_decided',
    context: 'sales',
    description: "An approver approved or rejected a quote version's approval request.",
    payload: z.strictObject({ ...ids, approvalId: z.uuid(), status: z.enum(['APPROVED', 'REJECTED']) }),
    live: { permission: 'quotes.view', fields: ['quoteId', 'versionId', 'approvalId', 'status'] },
  }),
  defineEvent({
    type: 'quote.reopened',
    context: 'sales',
    description: 'A quote version waiting for approval, or approved, went back to draft for a change; a waiting request was withdrawn.',
    payload: z.strictObject({ ...ids, withdrawnApprovalId: z.uuid().nullable() }),
    live,
  }),
  defineEvent({
    type: 'sales_settings.changed',
    context: 'sales',
    description: "A company's (or the tenant-wide) sales settings changed: the quote rules new quotes and every draft's next change are checked against.",
    payload: z.strictObject({ settingsId: z.uuid(), fields: z.array(z.string()) }),
    live: { permission: 'quotes.view', fields: ['settingsId'] },
  }),
  defineEvent({
    type: 'quote.cancelled',
    context: 'sales',
    description: 'The office withdrew a quote: before it was sent, or after (its accept links revoked, with a reason).',
    payload: z.strictObject(ids),
    live,
  }),
  defineEvent({
    type: 'quote.sent',
    context: 'sales',
    description: 'A quote version was frozen and sent to the customer: its PDF stored, its one-off accept link mailed; older sent versions are superseded.',
    payload: z.strictObject({ ...ids, revision: z.number().int(), number: z.string(), documentFileId: z.uuid(), linkId: z.uuid(), supersededVersionIds: z.array(z.uuid()) }),
    live: { permission: 'quotes.view', fields: ['quoteId', 'versionId', 'revision', 'number'] },
  }),
  defineEvent({
    type: 'quote.link_sent',
    context: 'sales',
    description: "The office sent the customer a new accept link for the quote's sent version; the older live links were revoked.",
    payload: z.strictObject({ ...ids, linkId: z.uuid(), revokedLinkIds: z.array(z.uuid()) }),
    live,
  }),
  defineEvent({
    type: 'quote.revised',
    context: 'sales',
    description: 'A new draft version of a sent (or declined) quote was made from it: its lines, sizes and costs copied.',
    payload: z.strictObject({ ...ids, fromVersionId: z.uuid(), revision: z.number().int() }),
    live,
  }),
  defineEvent({
    type: 'quote.accepted',
    context: 'sales',
    description: 'The customer accepted a sent quote version through its one-off link (typed name, evidence stored): the order and the deposit request are made from it.',
    payload: z.strictObject({
      ...ids,
      revision: z.number().int(),
      number: z.string(),
      companyId: z.uuid(),
      partyId: z.uuid(),
      acceptanceId: z.uuid(),
      channel: z.enum(['LINK', 'OFFICE']),
      acceptedAt: z.iso.datetime(),
      taxMode: z.enum(PARTY_TAX_MODES),
      currency: z.string(),
      promiseDate: z.iso.date().nullable(),
      /** The version asks a deposit: a deposit request follows (deposit_request.created). */
      depositAsked: z.boolean(),
      noWithdrawal: z.boolean(),
    }),
    live: { permission: 'quotes.view', fields: ['quoteId', 'versionId', 'revision', 'number'] },
  }),
  defineEvent({
    type: 'quote.declined',
    context: 'sales',
    description: 'The customer declined a sent quote version through its one-off link.',
    payload: z.strictObject({ ...ids, revision: z.number().int() }),
    live,
  }),
  defineEvent({
    type: 'quote.link_requested',
    context: 'sales',
    description: "The customer asked, through the quote's link, for a new one (the offer ended, or a newer version replaced it).",
    payload: z.strictObject({ ...ids, linkId: z.uuid(), state: z.enum(LINK_QUOTE_STATES) }),
    live,
  }),
  defineEvent({
    type: 'deposit_request.created',
    context: 'sales',
    description: 'The deposit request of an accepted quote version was made (OPEN), with its due date and fiscal decision.',
    payload: z.strictObject({ depositRequestId: z.uuid(), quoteId: z.uuid(), versionId: z.uuid(), partyId: z.uuid(), fiscalDocument: z.enum(['TD02', 'NONE']), dueDate: z.iso.date() }),
    live: { permission: 'quotes.view', fields: ['depositRequestId', 'quoteId', 'versionId'] },
  }),
  defineEvent({
    type: 'company.bank_details_changed',
    context: 'sales',
    description: "A company's bank account (where deposits are paid) was set, changed or removed: who did it is in the audit row; the IBAN is shown masked.",
    payload: z.strictObject({ companyId: z.uuid(), fields: z.array(z.string()), ibanBefore: z.string().nullable(), ibanAfter: z.string().nullable() }),
    live: { permission: 'companies.bank.view', fields: ['companyId', 'fields', 'ibanBefore', 'ibanAfter'] },
  }),
  defineEvent({
    type: 'sales_order.created',
    context: 'sales',
    description: 'The sales order of an accepted quote version was made (CONFIRMED), with its number; its deposit requests name it.',
    payload: z.strictObject({ orderId: z.uuid(), number: z.string(), quoteId: z.uuid().nullable(), versionId: z.uuid().nullable(), partyId: z.uuid(), depositRequestIds: z.array(z.uuid()) }),
    live: { permission: 'orders.view', fields: ['orderId', 'number', 'quoteId'] },
  }),
  defineEvent({
    type: 'sales_order.status_changed',
    context: 'sales',
    description: 'A sales order moved: production started, ready, partly shipped, shipped, closed or cancelled.',
    payload: z.strictObject({ orderId: z.uuid(), number: z.string(), from: orderStatus, to: orderStatus, by: z.enum(['person', 'system']) }),
    live: { ...orderLive, fields: ['orderId', 'number', 'from', 'to'] },
  }),
  defineEvent({
    type: 'sales_order.promise_changed',
    context: 'sales',
    description: "A sales order's promise date (or some of its lines') changed; its first promise stays.",
    payload: z.strictObject({ orderId: z.uuid(), number: z.string(), promiseDate: z.iso.date(), previous: z.iso.date().nullable(), lineIds: z.array(z.uuid()) }),
    live: orderLive,
  }),
  // B-W2a-19: the payment terms library and the price lists (ids, codes and what changed; never a price).
  defineEvent({
    type: 'payment_terms.changed',
    context: 'sales',
    description: 'Payment terms were added to the library, edited, archived or reactivated (documents already made keep their own copy).',
    payload: z.strictObject({ paymentTermsId: z.uuid(), code: z.string(), change: z.enum(['CREATED', 'UPDATED', 'ARCHIVED', 'REACTIVATED']), fields: z.array(z.string()) }),
    live: { permission: 'paymentterms.view', fields: ['paymentTermsId', 'code', 'change'] },
  }),
  defineEvent({
    type: 'price_list.changed',
    context: 'sales',
    description: 'A price list was made, edited, archived or reactivated, or given to customers or taken from them.',
    payload: z.strictObject({ listId: z.uuid(), code: z.string(), change: z.enum(['CREATED', 'UPDATED', 'ARCHIVED', 'REACTIVATED', 'CUSTOMERS']), fields: z.array(z.string()), partyIds: z.array(z.uuid()) }),
    live: { permission: 'pricelists.view', fields: ['listId', 'code', 'change'] },
  }),
  defineEvent({
    type: 'price_list.version_changed',
    context: 'sales',
    description: "A price list version was made (its prices copied from another), its planned days or note changed, a draft's prices edited, a draft deleted or an active version ended.",
    payload: z.strictObject({ listId: z.uuid(), versionId: z.uuid(), revision: z.number().int(), change: z.enum(['CREATED', 'UPDATED', 'PRICES', 'DELETED', 'ENDED']) }),
    live: { permission: 'pricelists.view', fields: ['listId', 'versionId', 'revision', 'change'] },
  }),
  defineEvent({
    type: 'price_list.version_activated',
    context: 'sales',
    description: 'A price list version went live from a day (its prices fixed for good); the version in force then ended the day before.',
    payload: z.strictObject({ listId: z.uuid(), versionId: z.uuid(), revision: z.number().int(), validFrom: z.iso.date(), validTo: z.iso.date().nullable(), endedVersionId: z.uuid().nullable() }),
    live: { permission: 'pricelists.view', fields: ['listId', 'versionId', 'revision', 'validFrom', 'validTo'] },
  }),
  // B-W2a-30: orders every day (ids, the revision and what changed; never an amount).
  defineEvent({
    type: 'sales_order.amended',
    context: 'sales',
    description: 'A confirmed sales order was amended (its lines, sizes or prices): the amendment keeps the order before and after; the customer accepts again when the net total changed.',
    payload: z.strictObject({ orderId: z.uuid(), number: z.string(), amendmentId: z.uuid(), revision: z.number().int(), reacceptanceNeeded: z.boolean(), lineIds: z.array(z.uuid()) }),
    live: { ...orderLive, fields: ['orderId', 'number', 'revision', 'reacceptanceNeeded'] },
  }),
  defineEvent({
    type: 'sales_order.lines_closed',
    context: 'sales',
    description: "Lines of a sales order were closed short (what is left of them will not be made or shipped), or reopened.",
    payload: z.strictObject({ orderId: z.uuid(), number: z.string(), change: z.enum(['CLOSED', 'REOPENED']), lineIds: z.array(z.uuid()) }),
    live: { ...orderLive, fields: ['orderId', 'number', 'change'] },
  }),
  defineEvent({
    type: 'sales_order.schedule_changed',
    context: 'sales',
    description: "A sales order's payment schedule was made, made again after an amendment, a step paid with its deposit, or its open steps cancelled with the order.",
    payload: z.strictObject({ orderId: z.uuid(), number: z.string(), change: z.enum(['MADE', 'REMADE', 'PAID', 'CANCELLED']), milestoneIds: z.array(z.uuid()) }),
    live: { ...orderLive, fields: ['orderId', 'number', 'change'] },
  }),
  // B-W2a-43: customer returns (ids, numbers and what changed; never an amount, a price or a credit value).
  defineEvent({
    type: 'return.authorised',
    context: 'sales',
    description: 'A customer return (RMA) was made and authorised: what comes back, from which invoiced or shipped lines, and by when the goods are due.',
    payload: z.strictObject({ returnId: z.uuid(), number: z.string(), partyId: z.uuid(), salesOrderId: z.uuid().nullable(), lineIds: z.array(z.uuid()), goodsDueBy: z.iso.date().nullable() }),
    live: { ...returnLive, floor: true },
  }),
  defineEvent({
    type: 'return.lines_changed',
    context: 'sales',
    description: "Lines of a customer return were added, changed or removed before the goods arrived (the dock's expected lines change).",
    payload: z.strictObject({ returnId: z.uuid(), number: z.string(), change: z.enum(['ADDED', 'CHANGED', 'REMOVED']), lineIds: z.array(z.uuid()) }),
    live: { ...returnLive, floor: true, fields: ['returnId', 'number', 'change'] },
  }),
  defineEvent({
    type: 'return.changed',
    context: 'sales',
    description: "A customer return's owner, deadline for the goods, customer reference or internal note changed.",
    payload: z.strictObject({ returnId: z.uuid(), number: z.string(), fields: z.array(z.string()) }),
    live: returnLive,
  }),
  defineEvent({
    type: 'return.received',
    context: 'sales',
    description: "A customer return's goods arrived at the dock: the receipt (parcels, condition, the customer's DDT) and the pieces of each line.",
    payload: z.strictObject({ returnId: z.uuid(), number: z.string(), receiptId: z.uuid(), lineIds: z.array(z.uuid()), pieces: z.number().int(), first: z.boolean() }),
    live: { ...returnLive, floor: true },
  }),
  defineEvent({
    type: 'return.graded',
    context: 'sales',
    description: "Received lines of a customer return were graded: the garments' grade, the cause found and their condition.",
    payload: z.strictObject({ returnId: z.uuid(), number: z.string(), lineIds: z.array(z.uuid()) }),
    live: { ...returnLive, floor: true },
  }),
  defineEvent({
    type: 'return.decided',
    context: 'sales',
    description: 'Graded lines of a customer return were decided: what the customer gets and where the goods go (the stock moves it posted); the return is inspected once every received line is decided.',
    payload: z.strictObject({ returnId: z.uuid(), number: z.string(), lineIds: z.array(z.uuid()), inspected: z.boolean(), moveIds: z.array(z.uuid()) }),
    live: { ...returnLive, floor: true, fields: ['returnId', 'number', 'inspected'] },
  }),
  defineEvent({
    type: 'return.credit_due',
    context: 'sales',
    description: "Decided lines of a customer return carry a credit for the customer: the credit note can be made (the lines' credit values are read from the return).",
    payload: z.strictObject({ returnId: z.uuid(), number: z.string(), partyId: z.uuid(), lineIds: z.array(z.uuid()) }),
    live: returnLive,
  }),
  defineEvent({
    type: 'return.status_changed',
    context: 'sales',
    description: 'A customer return moved: goods received, inspected and decided, more goods came, closed with its finish reason, or cancelled.',
    payload: z.strictObject({ returnId: z.uuid(), number: z.string(), from: returnStatus, to: returnStatus }),
    live: { ...returnLive, floor: true, fields: ['returnId', 'number', 'from', 'to'] },
  }),
  defineEvent({
    type: 'return.replacement_ordered',
    context: 'sales',
    description: "The replacement order of a customer return was made (a sales order of the same customer) for its lines decided Replace.",
    payload: z.strictObject({ returnId: z.uuid(), number: z.string(), orderId: z.uuid(), orderNumber: z.string(), lineIds: z.array(z.uuid()) }),
    live: { ...returnLive, fields: ['returnId', 'number', 'orderId', 'orderNumber'] },
  }),
  defineEvent({
    type: 'return_policy.changed',
    context: 'sales',
    description: "A company's or the tenant's return policy changed: the return window, the days for the goods, who pays the freight back, the restocking fee or the conditions.",
    payload: z.strictObject({ companyId: z.uuid().nullable(), fields: z.array(z.string()) }),
    live: { permission: 'sales.returns.view', fields: ['companyId', 'fields'] },
  }),
] as const

import { z } from 'zod'
import { defineEvent } from '../events/define'
import { PARTY_TAX_MODES } from '../parties/tax'
import { LINK_QUOTE_STATES } from './quotes/acceptance'
import { APPROVAL_REASONS } from './quotes/quotes'

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
 */
const live = { permission: 'quotes.view', fields: ['quoteId', 'versionId'] } as const
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
] as const

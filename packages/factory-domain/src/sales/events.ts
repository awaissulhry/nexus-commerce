import { z } from 'zod'
import { defineEvent } from '../events/define'
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
 *   quote.cancelled           the office withdrew the quote before sending it
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
    type: 'quote.cancelled',
    context: 'sales',
    description: 'The office withdrew a quote before it was sent.',
    payload: z.strictObject(ids),
    live,
  }),
] as const

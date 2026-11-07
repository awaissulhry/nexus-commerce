import { z } from 'zod'
import { defineEvent } from '../events/define'
import { DATE_DECISIONS } from '../purchasing/portal-jobs/jobs'
import { SUBCONTRACT_ORDER_STATUSES } from '../purchasing/subcontracting/rules'

/**
 * The workshop's answers on its subcontract jobs (B-W2b-176; SCM-154 to SCM-157, PLN-163). apps/factory-api's
 * modules/purchasing/portal-jobs emits them in the command that writes the answer, whoever gave it: the workshop in the
 * portal or by its JOB_ACCEPT link, or the office for a workshop without e-mail (Owner answer C3). Their own module folder
 * because check-event-contract wants `src/<module>/events.ts` (the code is purchasing/portal-jobs); the types stay
 * `subcontract_order.*`, so the office's subcontract order record refreshes on them as on W2a's.
 *
 *   subcontract_order.job_sent           the job went to the workshop by a JOB_ACCEPT link (mailed, or its address given once)
 *   subcontract_order.job_answered       the workshop accepted the job (as asked, or proposing another due-back date) or
 *                                        declined it
 *   subcontract_order.date_decided       the office accepted (the expected-back date moved) or refused the date proposed
 *   subcontract_order.kit_checked        the workshop confirmed kit lines it received (with a shortfall or not)
 *   subcontract_order.progress_reported  the workshop reported finished pieces (the work order sees them at once)
 *   subcontract_order.return_announced   the workshop announced what comes back (it prefills the receive back)
 *   subcontract_order.return_cancelled   the office cancelled an announced send-back with its reason
 *
 * Office screens: purchasing.view over the order's company (the record and the list refresh). Partner sessions: the portal's
 * own list (portal/notifications/live.ts) for the workshop's own party. Ids, numbers, counts, dates and states: never a fee,
 * an amount or a person's name.
 */

const live = { permission: 'purchasing.view', fields: ['subcontractOrderId', 'number', 'status', 'partyId'] } as const
const base = { subcontractOrderId: z.uuid(), number: z.string().min(1).max(40), status: z.enum(SUBCONTRACT_ORDER_STATUSES), partyId: z.uuid() }
const via = z.enum(['PORTAL', 'LINK', 'OFFICE'])
const day = z.iso.date()

export const events = [
  defineEvent({
    type: 'subcontract_order.job_sent',
    context: 'subcontract-jobs',
    description: 'A subcontract job went to its workshop by a one-off link to accept it, move its date or decline it (mailed, or its address given to the office once).',
    payload: z.strictObject({ ...base, linkId: z.uuid(), mailed: z.boolean(), expiresAt: z.iso.datetime() }),
    live,
  }),
  defineEvent({
    type: 'subcontract_order.job_answered',
    context: 'subcontract-jobs',
    description: 'The workshop accepted a subcontract job (as asked, or proposing another due-back date) or declined it, in the portal, by its link, or through the office.',
    payload: z.strictObject({ ...base, answer: z.enum(['ACCEPTED', 'DECLINED']), proposedDate: day.nullable(), via }),
    live,
  }),
  defineEvent({
    type: 'subcontract_order.date_decided',
    context: 'subcontract-jobs',
    description: "The office answered the due-back date a workshop proposed: accepted (the order's expected-back date moved to it) or refused.",
    payload: z.strictObject({ ...base, decision: z.enum(DATE_DECISIONS), expectedBackDate: day.nullable() }),
    live,
  }),
  defineEvent({
    type: 'subcontract_order.kit_checked',
    context: 'subcontract-jobs',
    description: 'The workshop confirmed kit lines of a subcontract job it received, with what was missing or damaged.',
    payload: z.strictObject({ ...base, kitLineIds: z.array(z.uuid()).min(1).max(200), short: z.number().int().min(0), via }),
    live,
  }),
  defineEvent({
    type: 'subcontract_order.progress_reported',
    context: 'subcontract-jobs',
    description: 'The workshop reported finished pieces of a subcontract job, per operation and size or bundle, and the day it will finish by.',
    payload: z.strictObject({ ...base, reportIds: z.array(z.uuid()).min(1).max(200), finished: z.number().int().min(1), finishBy: day.nullable(), via }),
    live,
  }),
  defineEvent({
    type: 'subcontract_order.return_announced',
    context: 'subcontract-jobs',
    description: 'The workshop announced goods coming back from a subcontract job (pieces, unused material, parcels, its DDT); nothing moves in stock until the office receives them.',
    payload: z.strictObject({ ...base, returnNoticeId: z.uuid(), seq: z.number().int().min(1), pieces: z.number().int().min(1), expectedDate: day, via }),
    live,
  }),
  defineEvent({
    type: 'subcontract_order.return_cancelled',
    context: 'subcontract-jobs',
    description: 'The office cancelled a send-back the workshop had announced, with its reason.',
    payload: z.strictObject({ ...base, returnNoticeId: z.uuid(), seq: z.number().int().min(1) }),
    live,
  }),
] as const

import { z } from 'zod'
import { defineEvent } from '../events/define'
import { ANSWER_CHANNELS, APPROVAL_DECISIONS, APPROVAL_KINDS } from './kinds' // B-PR-24: APPROVAL_DECISIONS

/**
 * Approval requests to partners (B-W2b-184). apps/factory-api's platform/approvals-out emits them; the office screens of the
 * record (its approvals panel, Home) refresh on them (partners.approvals.view over the event's company). The partner's own
 * screens follow its task (partner_task.*). Ids, kinds and states only: never a name, an address, the words or an amount.
 *
 *   approval_request.asked      the office asked (the request, its APPROVAL link and the partner's task in one command)
 *   approval_request.answered   the partner answered (APPROVED, APPROVED_WITH_CHANGES or REFUSED), by its link or portal
 *   approval_request.withdrawn  the office withdrew an open request (its link stops, its task is cancelled)
 *   approval_request.expired    nobody answered by the due time (the expiry job)
 *
 * B-PR-24 (production plan §3 "Full control: decide for a brand or undo, always with a reason it reads"; 08-backend §4.6, §6):
 *   approval_request.decided_for_party  an office person decided an open request for its party (production.brand.override,
 *                                       step-up; never the person who asked it; never a concession, a revised order, a
 *                                       signature or a proof) — the party reads why
 *   approval_request.reversed           an office person put the party's answer back, once, with why the party reads (the
 *                                       answer itself never changes; never on those four kinds)
 * Ids, kinds and the decision only: never the reason, the typed name or the person.
 */

const live = (fields: readonly string[]) => ({ permission: 'partners.approvals.view', fields }) as const
const kind = z.enum(APPROVAL_KINDS)
const about = { requestId: z.uuid(), kind, recordType: z.string(), recordId: z.uuid(), partyId: z.uuid() }
const FIELDS = ['requestId', 'kind', 'recordType', 'recordId', 'partyId'] as const

export const events = [
  defineEvent({
    type: 'approval_request.asked',
    context: 'approvals-out',
    description: 'The office asked a customer, supplier or outside signer to approve a record (by link and in its portal).',
    payload: z.strictObject({ ...about, dueAt: z.string(), linkId: z.uuid(), taskId: z.uuid(), files: z.number().int().min(0) }),
    live: live([...FIELDS]),
  }),
  defineEvent({
    type: 'approval_request.answered',
    context: 'approvals-out',
    description: 'A partner answered an approval request: approved, approved with changes or refused, signed with its typed name.',
    payload: z.strictObject({ ...about, status: z.enum(['APPROVED', 'APPROVED_WITH_CHANGES', 'REFUSED']), via: z.enum(ANSWER_CHANNELS), markedUp: z.boolean() }),
    live: live([...FIELDS, 'status', 'via']),
  }),
  defineEvent({
    type: 'approval_request.withdrawn',
    context: 'approvals-out',
    description: 'The office withdrew an open approval request: its link opens nothing any more, its task is cancelled.',
    payload: z.strictObject({ ...about }),
    live: live([...FIELDS]),
  }),
  defineEvent({
    type: 'approval_request.expired',
    context: 'approvals-out',
    description: 'Nobody answered an approval request by its due time: it expired, its link stopped, its task was cancelled.',
    payload: z.strictObject({ ...about }),
    live: live([...FIELDS]),
  }),
  // ---- B-PR-24: decided for the party, and its answer put back ---------------------------------------------------------------
  defineEvent({
    type: 'approval_request.decided_for_party',
    context: 'approvals-out',
    description: 'An office person decided an open approval request for its party, with a reason the party reads (never on a concession, a revised order, a signature or a proof).',
    payload: z.strictObject({ ...about, decision: z.enum(APPROVAL_DECISIONS) }),
    live: live([...FIELDS, 'decision']),
  }),
  defineEvent({
    type: 'approval_request.reversed',
    context: 'approvals-out',
    description: "An office person put a party's answer to an approval request back, once, with a reason the party reads; the answer itself is kept.",
    payload: z.strictObject({ ...about }),
    live: live([...FIELDS]),
  }),
] as const

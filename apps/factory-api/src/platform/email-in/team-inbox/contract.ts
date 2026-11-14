import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { INBOUND_STATUSES, MAIL_VERDICTS } from '@nexus/factory-domain/email-in/rules'
import { QUEUE_VIEWS, TEAM_INBOX_LIMITS, WORK_STATES } from '@nexus/factory-domain/mail-depth/rules'

/**
 * Team inboxes' contracts (B-W2b-394; COL-027; design home.mail "Team inboxes (orders@, quotes@)", "Assignee (team inbox)",
 * "assign to a person, close, snooze, follow-up that cancels itself when the partner replies"). Office only; codes, never
 * words (the screens draw them); no answer holds a mail's text, an address of a sender or a reply token.
 */

const version = z.number().int().min(1)
const inboxParams = input({ teamInboxId: id() })
const mailParams = input({ inboundEmailId: id() })
const person = output({ id: id(), name: z.string() })

export const teamInboxView = output({
  id: id(),
  companyId: id(),
  name: z.string(),
  localPart: z.string(),
  /** `<local part>@<the company's receiving domain>`; null while the company sends no mail (no identity). */
  address: z.string().nullable(),
  active: z.boolean(),
  members: z.array(person),
  /** The reader is a member (works its mail). */
  member: z.boolean(),
  /** Its mail now: open, open with nobody on it, open and the reader's, snoozed, waiting for a follow-up. */
  counts: output({ open: z.number().int(), unassigned: z.number().int(), mine: z.number().int(), snoozed: z.number().int(), followUp: z.number().int() }),
  version: z.number().int(),
})
export type TeamInboxView = z.infer<typeof teamInboxView>

export const listInboxesContract = defineContract({
  querystring: input({ companyId: id().optional(), includeOff: z.enum(['true', 'false']).optional() }),
  response: { 200: output({ inboxes: z.array(teamInboxView), mayManage: z.boolean() }) },
})

const memberIds = z.array(id()).max(TEAM_INBOX_LIMITS.members)

export const createInboxContract = defineContract({
  body: input({ companyId: id(), name: z.string().max(200), localPart: z.string().max(80), memberIds }),
  response: { 201: output({ inbox: teamInboxView }) },
})

export const updateInboxContract = defineContract({
  params: inboxParams,
  body: input({ version, name: z.string().max(200).optional(), localPart: z.string().max(80).optional(), memberIds: memberIds.optional(), active: z.boolean().optional() }),
  response: { 200: output({ inbox: teamInboxView }) },
})

export const inboxPeopleContract = defineContract({
  querystring: input({ companyId: id() }),
  /** Who may be a member: ACTIVE office people whose live roles sort mail of the company (names only, nobody counted). */
  response: { 200: output({ people: z.array(person) }) },
})

/** One mail of a team inbox's queue. */
export const queueMailView = output({
  id: id(),
  status: z.enum(INBOUND_STATUSES),
  receivedAt: instant(),
  from: output({ address: z.string().nullable(), name: z.string().nullable() }),
  subject: z.string().nullable(),
  verdicts: output({ dmarc: z.enum(MAIL_VERDICTS), spam: z.enum(MAIL_VERDICTS) }),
  attachmentCount: z.number().int(),
  /** The record its thread is of (MATCHED, or named while it waits). */
  thread: output({ id: id(), recordType: z.string(), recordId: id() }).nullable(),
  teamInboxId: id().nullable(),
  state: z.enum(WORK_STATES),
  assignee: person.nullable(),
  mine: z.boolean(),
  assignedAt: instant().nullable(),
  closedAt: instant().nullable(),
  snoozedUntil: instant().nullable(),
  followUpUntil: instant().nullable(),
  /** The inquiry it was made into, when one was (ML1:02). */
  inquiry: output({ id: id(), number: z.string() }).nullable(),
  version: z.number().int(),
})
export type QueueMailView = z.infer<typeof queueMailView>

export const queueContract = defineContract({
  params: inboxParams,
  querystring: input({ view: z.enum(QUEUE_VIEWS).default('OPEN'), cursor: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
  response: { 200: output({ mails: z.array(queueMailView), nextCursor: z.string().nullable() }) },
})

const answer = { 200: output({ mail: queueMailView }) }

export const assigneeContract = defineContract({ params: mailParams, body: input({ version, /** A member of the inbox (yourself: take it); null: give it back to the queue. */ assigneeId: id().nullable() }), response: answer })
export const closeContract = defineContract({ params: mailParams, body: input({ version }), response: answer })
export const reopenContract = defineContract({ params: mailParams, body: input({ version }), response: answer })
export const snoozeContract = defineContract({ params: mailParams, body: input({ version, /** Off the queue until then (5 minutes to 90 days ahead); null: back now. */ until: instant().nullable() }), response: answer })
export const followUpContract = defineContract({
  params: mailParams,
  body: input({ version, /** Back in the queue then unless the partner answers in the record's thread first (5 minutes to 90 days ahead); null: none. */ until: instant().nullable() }),
  response: answer,
})
export const moveContract = defineContract({ params: mailParams, body: input({ version, /** A switched-on inbox of the mail's company the person works. */ teamInboxId: id() }), response: answer })

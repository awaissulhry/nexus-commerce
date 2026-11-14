import { z } from 'zod'
import { INBOUND_STATUSES, MAIL_VERDICTS } from '@nexus/factory-domain/email-in/rules'
import { QUEUE_VIEWS, WORK_STATES, type QueueView } from '@nexus/factory-domain/mail-depth/rules'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import type { QueueMail, TeamInbox } from './model'

/**
 * Team inboxes' calls (apps/factory-api platform/email-in/team-inbox, B-W2b-394; design home.mail "Team inboxes (orders@,
 * quotes@)", "Assignee", "assign to a person, close, snooze, follow-up"), through the ONE client: the inboxes the person works
 * with their counts, an inbox's queue by view, and the work on one mail — each write with the mail's version as read (a mail
 * the worker or a colleague moved meanwhile is a 409, never overwritten) and its own Idempotency-Key.
 */

const person = z.object({ id: z.string(), name: z.string() })
const inboxSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  name: z.string(),
  localPart: z.string(),
  address: z.string().nullable(),
  active: z.boolean(),
  members: z.array(person),
  member: z.boolean(),
  counts: z.object({ open: z.number().int(), unassigned: z.number().int(), mine: z.number().int(), snoozed: z.number().int(), followUp: z.number().int() }),
  version: z.number().int(),
})
const mailSchema = z.object({
  id: z.string(),
  status: z.enum(INBOUND_STATUSES),
  receivedAt: z.string(),
  from: z.object({ address: z.string().nullable(), name: z.string().nullable() }),
  subject: z.string().nullable(),
  verdicts: z.object({ dmarc: z.enum(MAIL_VERDICTS), spam: z.enum(MAIL_VERDICTS) }),
  attachmentCount: z.number().int(),
  thread: z.object({ id: z.string(), recordType: z.string(), recordId: z.string() }).nullable(),
  teamInboxId: z.string().nullable(),
  state: z.enum(WORK_STATES),
  assignee: person.nullable(),
  mine: z.boolean(),
  assignedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  snoozedUntil: z.string().nullable(),
  followUpUntil: z.string().nullable(),
  inquiry: z.object({ id: z.string(), number: z.string() }).nullable(),
  version: z.number().int(),
})
const oneMail = z.object({ mail: mailSchema })

const enc = encodeURIComponent

/** GET /email/team-inboxes?companyId: the switched-on inboxes the person works (every one for a manager). */
export async function listInboxes(api: ApiClient, companyId: string, signal?: AbortSignal): Promise<{ inboxes: TeamInbox[]; mayManage: boolean }> {
  return api.get('/email/team-inboxes', { query: { companyId }, schema: z.object({ inboxes: z.array(inboxSchema), mayManage: z.boolean() }), signal })
}

/** GET /email/team-inboxes/:id/mail?view: one view of an inbox's queue, newest first, 50 at a time. */
export async function listQueue(api: ApiClient, inboxId: string, view: QueueView, cursor?: string | null, signal?: AbortSignal): Promise<{ mails: QueueMail[]; nextCursor: string | null }> {
  if (!QUEUE_VIEWS.includes(view)) throw new Error(`unknown view ${view}`)
  return api.get(`/email/team-inboxes/${enc(inboxId)}/mail`, { query: { view, cursor: cursor ?? undefined, limit: 50 }, schema: z.object({ mails: z.array(mailSchema), nextCursor: z.string().nullable() }), signal })
}

/** One change to a mail of an inbox, at the version read. */
export type WorkChange =
  | { readonly kind: 'assignee'; readonly assigneeId: string | null }
  | { readonly kind: 'close' }
  | { readonly kind: 'reopen' }
  | { readonly kind: 'snooze'; readonly until: string | null }
  | { readonly kind: 'followUp'; readonly until: string | null }
  | { readonly kind: 'move'; readonly teamInboxId: string }

const PATHS: Readonly<Record<WorkChange['kind'], string>> = { assignee: 'assignee', close: 'close', reopen: 'reopen', snooze: 'snooze', followUp: 'follow-up', move: 'team-inbox' }

/** POST /email/inbound/:id/assignee|close|reopen|snooze|follow-up|team-inbox with the mail's version. */
export async function workOn(api: ApiClient, mail: Pick<QueueMail, 'id' | 'version'>, change: WorkChange): Promise<QueueMail> {
  const { kind, ...fields } = change
  const answer = await api.post(`/email/inbound/${enc(mail.id)}/${PATHS[kind]}`, { body: { version: mail.version, ...fields }, schema: oneMail, idempotencyKey: newIdempotencyKey() })
  return answer.mail
}

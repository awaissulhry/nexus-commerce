import { z } from 'zod'
import { defineEvent } from '../events/define'
import { PARTNER_EMAIL_TOPICS } from './notifications/topics'
import { PARTNER_TASK_KINDS } from './tasks/kinds'

/**
 * Tasks and notifications for partners (B-W2b-167; COL-043, PLT-148, COL-063). apps/factory-api's platform/portal emits them
 * (tasks/, notifications/); their own module folder because check-event-contract wants `src/<module>/events.ts` (the code is
 * portal/tasks, portal/notifications, portal/home).
 *
 *   partner_task.opened          a request to a partner was opened (by a command that makes it, or an office person by hand)
 *   partner_task.closed          … answered (DONE: by the partner, in the portal or by a link, or by the command that took
 *                                the answer) or withdrawn (CANCELLED: by the office or the command that made it moot)
 *   partner_task.reopened        … opened again (the office, or the partner's Undo)
 *   partner_task.due_moved       … its due date moved
 *   partner_task.reminded        the reminder job reminded the partner of it (the notification fan-out tells its people)
 *   partner_task.assigned        B-W2b-F14: a partner person took it, gave it to a colleague or back to everyone, or the
 *                                person it was handed to was deactivated (it went back to everyone)
 *   partner_notification.created the fan-out told partner people of an event (the portal's bell reads again; nobody named)
 *   partner_notification.digest_sent  a partner person's daily or weekly summary went out
 *   partner_email.settings_changed    a partner person's e-mail settings changed (in the portal, or by the unsubscribe link)
 *
 * Office screens: partners.view over the event's company (the party's Portal access tab). Partner sessions: the portal's
 * own list (portal/notifications/live.ts), only their own party's. Ids, kinds and states only: never a name, an address or
 * an amount.
 */

const live = (fields: readonly string[]) => ({ permission: 'partners.view', fields }) as const
const kind = z.enum(PARTNER_TASK_KINDS)

export const events = [
  defineEvent({
    type: 'partner_task.opened',
    context: 'portal',
    description: 'A request to a customer, supplier or workshop was opened on a record (confirm, accept, approve, upload, answer, pay…).',
    payload: z.strictObject({ taskId: z.uuid(), partyId: z.uuid(), kind, recordType: z.string(), recordId: z.uuid(), dueAt: z.string().nullable(), byOffice: z.boolean() }),
    live: live(['taskId', 'partyId', 'kind', 'recordType', 'recordId']),
  }),
  defineEvent({
    type: 'partner_task.closed',
    context: 'portal',
    description: 'A request to a partner was answered (done) or withdrawn (cancelled).',
    payload: z.strictObject({ taskId: z.uuid(), partyId: z.uuid(), kind, status: z.enum(['DONE', 'CANCELLED']), byPartner: z.boolean() }),
    live: live(['taskId', 'partyId', 'kind', 'status']),
  }),
  defineEvent({
    type: 'partner_task.reopened',
    context: 'portal',
    description: 'A request to a partner was opened again (by the office, or undone by the partner).',
    payload: z.strictObject({ taskId: z.uuid(), partyId: z.uuid(), kind, byPartner: z.boolean() }),
    live: live(['taskId', 'partyId', 'kind']),
  }),
  defineEvent({
    type: 'partner_task.due_moved',
    context: 'portal',
    description: 'The due date of a request to a partner moved.',
    payload: z.strictObject({ taskId: z.uuid(), partyId: z.uuid(), kind, dueAt: z.string().nullable() }),
    live: live(['taskId', 'partyId', 'kind']),
  }),
  defineEvent({
    type: 'partner_task.reminded',
    context: 'portal',
    description: 'The partner was reminded of a request that is due soon or overdue.',
    payload: z.strictObject({ taskId: z.uuid(), partyId: z.uuid(), kind, dueAt: z.string() }),
  }),
  // B-W2b-F14 (PartnerTask.assigneeId): who of the party has it; no person named (the list reads it again).
  defineEvent({
    type: 'partner_task.assigned',
    context: 'portal',
    description: 'A request to a partner was taken by one of its people, handed to a colleague, or given back to everyone.',
    payload: z.strictObject({ taskId: z.uuid(), partyId: z.uuid(), kind, assigned: z.boolean(), why: z.enum(['TAKEN', 'GIVEN', 'RELEASED', 'LEFT']) }),
    live: live(['taskId', 'partyId', 'kind', 'assigned']),
  }),
  defineEvent({
    type: 'partner_notification.created',
    context: 'portal',
    description: 'Partner people were told of an event in their portal (their bell); nobody is named.',
    payload: z.strictObject({ partyId: z.uuid(), sourceEventId: z.uuid(), sourceType: z.string(), count: z.number().int().min(1) }),
    live: live(['partyId', 'count']),
  }),
  defineEvent({
    type: 'partner_notification.digest_sent',
    context: 'portal',
    description: "A partner person's daily or weekly e-mail summary was sent.",
    payload: z.strictObject({ userId: z.uuid(), partyId: z.uuid(), emailOutboundId: z.uuid(), count: z.number().int().min(1), weekly: z.boolean() }),
  }),
  defineEvent({
    type: 'partner_email.settings_changed',
    context: 'portal',
    description: "A partner person's e-mail settings changed (in the portal, or by the unsubscribe link in a mail).",
    payload: z.strictObject({ userId: z.uuid(), partyId: z.uuid(), topics: z.array(z.enum(PARTNER_EMAIL_TOPICS)), byLink: z.boolean() }),
  }),
] as const

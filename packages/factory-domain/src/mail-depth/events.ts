import { z } from 'zod'
import { defineEvent } from '../events/define'
import { BOUNCE_KINDS, WORK_CHANGES } from './rules'

/**
 * Mail in depth's events (B-W2b-394; COL-021, COL-027, COL-031; ML1:01). apps/factory-api's platform/email-in/{capture,
 * team-inbox} and platform/email-out/delivery-status emit them; none carries an address, a subject or a text:
 *   email.team_inbox_changed      a team inbox was set up, changed, switched off or on: Mail to sort's tiles refresh.
 *   email.capture_changed         a company's capture address was made, replaced, turned off, or its default inbox changed.
 *   email.inbound_worked          a mail of a team inbox moved: put in it (by its address or the capture address), taken or
 *                                 given to a member, closed, reopened, snoozed, woken, a follow-up asked or cleared, moved to
 *                                 another inbox; FOLLOW_UP_DUE: its follow-up came with no answer (it is open again). The queue
 *                                 refreshes; an assignment and a follow-up due tell the assignee (the notification rules).
 *   email.bounce_noted            a mail we sent was not delivered for now (a soft bounce: its status stays SENT): the thread's
 *                                 delivery status refreshes and the sender gets a task (a hard bounce is email.status_changed).
 *   email.webhook_secret_changed  a FAKE mail account's webhook secret was set or replaced (never the value).
 */
export const events = [
  defineEvent({
    type: 'email.team_inbox_changed',
    context: 'mail-depth',
    description: 'A team inbox was set up, changed, switched off or switched on.',
    payload: z.strictObject({ teamInboxId: z.uuid(), change: z.enum(['CREATED', 'CHANGED', 'SWITCHED_OFF', 'SWITCHED_ON']) }),
    live: { permission: 'email.triage', fields: ['teamInboxId', 'change'] },
  }),
  defineEvent({
    type: 'email.capture_changed',
    context: 'mail-depth',
    description: "A company's capture address was made, replaced or turned off, or the team inbox its unmatched mail lands in changed.",
    payload: z.strictObject({ captureAddressId: z.uuid(), change: z.enum(['CREATED', 'REPLACED', 'DEFAULT_CHANGED', 'TURNED_OFF']) }),
    live: { permission: 'email.send', fields: ['captureAddressId', 'change'] },
  }),
  defineEvent({
    type: 'email.inbound_worked',
    context: 'mail-depth',
    description: 'A mail of a team inbox was put in it, taken, given, closed, reopened, snoozed, woken, followed up or moved.',
    payload: z.strictObject({
      inboundEmailId: z.uuid(),
      teamInboxId: z.uuid().nullable(),
      change: z.enum(WORK_CHANGES),
      /** The person it is assigned to after the change (null: nobody). */
      assigneeId: z.uuid().nullable(),
      /** The office person who changed it (null: the system). */
      byId: z.uuid().nullable(),
    }),
    live: { permission: 'email.triage', fields: ['inboundEmailId', 'teamInboxId', 'change'] },
  }),
  defineEvent({
    type: 'email.bounce_noted',
    context: 'mail-depth',
    description: 'A mail we sent was not delivered for now (a soft bounce); it stays SENT.',
    payload: z.strictObject({
      outboundId: z.uuid(),
      threadId: z.uuid().nullable(),
      recordType: z.string().nullable(),
      recordId: z.uuid().nullable(),
      bounceKind: z.enum(BOUNCE_KINDS),
    }),
    live: { permission: 'threads.read', fields: ['outboundId', 'threadId', 'recordType', 'recordId', 'bounceKind'] },
  }),
  defineEvent({
    type: 'email.webhook_secret_changed',
    context: 'mail-depth',
    description: "A FAKE mail account's webhook secret was set or replaced.",
    payload: z.strictObject({ accountId: z.uuid(), replaced: z.boolean() }),
  }),
] as const

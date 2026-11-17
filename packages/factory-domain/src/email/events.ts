import { z } from 'zod'
import { defineEvent } from '../events/define'
import { OUTBOUND_STATUSES, SUPPRESSION_REASONS } from './rules'

/**
 * Email out's events (plan A1 §3.3 `email-out`, §3.4, §3.5; features PLT-139, PLT-149). apps/factory-api's
 * platform/email-out emits them; none carries an address, a subject or a text:
 *   email.queued              a mail on a record's thread was queued in the command that wrote its message: the
 *                             worker's handler (email.sendQueued) sends it — B-TH-048: not before its sendAfter, the end
 *                             of the 10 seconds its sender may take it back in. No live rule: the thread's own
 *                             thread.message_posted refreshes the screens.
 *   (B-TH-048) a mail taken back is email.status_changed with status WITHDRAWN.
 *   email.status_changed      a mail was sent, failed, was delivered, bounced or drew a complaint: the record's thread
 *                             panel refreshes its mail states for the office screens that may read the thread.
 *   email.address_suppressed  an address went on the suppression list (a permanent bounce, a complaint): the parties
 *                             module (W1) flags the contact that has it.
 */
export const events = [
  defineEvent({
    type: 'email.queued',
    context: 'email',
    description: 'A mail on a record thread was queued to be sent.',
    payload: z.strictObject({
      outboundId: z.uuid(),
      threadId: z.uuid(),
      messageId: z.uuid(),
      // B-TH-048 (undo send): a thread mail leaves only then (10 s after Send); the worker's job waits until it. Absent: at once.
      sendAfter: z.iso.datetime().optional(),
    }),
  }),
  defineEvent({
    type: 'email.status_changed',
    context: 'email',
    description: 'A mail was sent, failed, was delivered, bounced or drew a complaint.',
    payload: z.strictObject({
      outboundId: z.uuid(),
      threadId: z.uuid().nullable(),
      recordType: z.string().nullable(),
      recordId: z.uuid().nullable(),
      status: z.enum(OUTBOUND_STATUSES),
    }),
    live: { permission: 'threads.read', fields: ['outboundId', 'threadId', 'recordType', 'recordId', 'status'] },
  }),
  defineEvent({
    type: 'email.address_suppressed',
    context: 'email',
    description: 'An address went on the suppression list after a permanent bounce or a complaint.',
    payload: z.strictObject({
      suppressionId: z.uuid(),
      reason: z.enum(SUPPRESSION_REASONS),
      outboundId: z.uuid().nullable(),
    }),
  }),
] as const

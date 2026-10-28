import { z } from 'zod'
import { defineEvent } from '../events/define'
import { INBOUND_STATUSES } from './rules'

/**
 * Email in's events (plan A1 §3.3 `email-in`, §3.4, §3.5; features COL-020, COL-022, COL-023). apps/factory-api's
 * platform/email-in emits them; none carries an address, a subject or a text:
 *   email.inbound_received   SES received a mail for the tenant (an InboundEmail row, RECEIVED): the worker's handler
 *                            (emailIn.fetch) reads the raw mail through the gateway. No live rule.
 *   email.inbound_fetched    the raw mail was read, parsed and sanitised, its attachments stored: the worker's handler
 *                            (emailIn.sort) finds its place. No live rule.
 *   email.inbound_sorted     a mail's place was decided, by the worker or a person (MATCHED, TRIAGE, HELD, REJECTED,
 *                            FAILED): the "mail to sort" screen refreshes for the people who sort mail (email.triage).
 *                            A mail that joined a thread also has the thread's own thread.message_posted.
 */
export const events = [
  defineEvent({
    type: 'email.inbound_received',
    context: 'email-in',
    description: 'SES received a mail for the tenant; its raw mail waits to be read.',
    payload: z.strictObject({ inboundEmailId: z.uuid() }),
  }),
  defineEvent({
    type: 'email.inbound_fetched',
    context: 'email-in',
    description: 'A received mail was read, parsed and sanitised; it waits to be sorted.',
    payload: z.strictObject({ inboundEmailId: z.uuid() }),
  }),
  defineEvent({
    type: 'email.inbound_sorted',
    context: 'email-in',
    description: 'A received mail joined a thread, waits for a person, or was rejected.',
    payload: z.strictObject({
      inboundEmailId: z.uuid(),
      status: z.enum(INBOUND_STATUSES),
      threadId: z.uuid().nullable(),
      messageId: z.uuid().nullable(),
    }),
    live: { permission: 'email.triage', fields: ['inboundEmailId', 'status', 'threadId'] },
  }),
] as const

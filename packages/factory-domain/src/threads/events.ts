import { z } from 'zod'
import { defineEvent } from '../events/define'
import { MESSAGE_AUDIENCES, MESSAGE_DIRECTIONS } from './rules'

/**
 * The record threads' events (plan A1 §3.4, §3.5; features COL-001, COL-006, COL-077). apps/factory-api's
 * platform/threads emits them in the transaction that writes the message:
 *   thread.message_posted   a message entered a record's thread (an internal note now; the email steps' sent and
 *                           received mail later): the record's thread and timeline panels refresh on the office
 *                           screens that may read the record's thread. It names no text and no party.
 *   thread.user_mentioned   one per person a note mentions: the notification centre (COL-006, PLT-138) turns it into
 *                           that person's notification. No live rule: a live message reaches everyone who may read
 *                           the thread, not one person.
 */
export const events = [
  defineEvent({
    type: 'thread.message_posted',
    context: 'threads',
    description: 'A message entered the thread of a record.',
    payload: z.strictObject({
      threadId: z.uuid(),
      messageId: z.uuid(),
      recordType: z.string(),
      recordId: z.uuid(),
      direction: z.enum(MESSAGE_DIRECTIONS),
      audience: z.enum(MESSAGE_AUDIENCES),
      // B-TH-045 (production lane T6): the batch one action wrote several messages in (a note to N records, the answer to N
      // orders of one customer): their notifications fold into ONE bell item per reader. Absent: a message of its own.
      batchId: z.uuid().optional(),
    }),
    live: { permission: 'threads.read', fields: ['threadId', 'messageId', 'recordType', 'recordId'] },
  }),
  defineEvent({
    type: 'thread.user_mentioned',
    context: 'threads',
    description: 'An internal note on a record mentioned a person, who should be told.',
    payload: z.strictObject({
      threadId: z.uuid(),
      messageId: z.uuid(),
      recordType: z.string(),
      recordId: z.uuid(),
      userId: z.uuid(),
      authorId: z.uuid().nullable(),
      // B-TH-045: as thread.message_posted's batchId ("mentioned you on 12 orders" is one bell item).
      batchId: z.uuid().optional(),
    }),
  }),
  // B-W2a-20 (COL-011): someone followed, unfollowed or muted a record, or was added as its follower. The record's side
  // panel and the band's Follow toggle read its followers again. It names the record only.
  defineEvent({
    type: 'thread.followers_changed',
    context: 'threads',
    description: "A record's followers changed (someone followed, unfollowed or muted it, or was added).",
    payload: z.strictObject({ recordType: z.string(), recordId: z.uuid() }),
    live: { permission: 'threads.read', fields: ['recordType', 'recordId'] },
  }),
  // ---- B-TH-068 (threads plan TH-5, PROJ-G05): a colleague added by hand to a record (reason ADDED) — the notification centre
  // tells the person added ("Marco added you to …", platform/notifications/rules/projects.ts). No live rule: the bell's own
  // notification.created refreshes the screens. Ids only.
  defineEvent({
    type: 'thread.follower_added',
    context: 'threads',
    description: 'An office person was added by a colleague to the followers of a record (a project, an order …).',
    payload: z.strictObject({ recordType: z.string(), recordId: z.uuid(), userId: z.uuid(), byId: z.uuid() }),
  }),
  // ---- end B-TH-068
] as const

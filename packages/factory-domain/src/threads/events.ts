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
] as const

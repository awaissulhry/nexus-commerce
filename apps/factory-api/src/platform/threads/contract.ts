import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { grainedJson } from '@nexus/factory-domain/money/marked'
import { AUTHOR_KINDS, MAX_ATTACHMENTS, MAX_BODY_LENGTH, MAX_MENTIONS, MESSAGE_AUDIENCES, MESSAGE_CHANNELS, MESSAGE_DIRECTIONS, RECORD_TYPE, THREAD_STATUSES } from '@nexus/factory-domain/threads/rules'
import { TIMELINE_KINDS } from '@nexus/factory-domain/threads/timeline'
import { FILE_AUDIENCES, FILE_KINDS, FILE_STATUSES } from '../files/rules'

/**
 * The record threads' contracts (plan A1 §2.3, §3.7; A2 SCR-006 record panels: thread, timeline, files). A record is
 * named in the path (`/threads/<recordType>/<recordId>`); its thread exists once its first message was written. Pages
 * run newest first: send back `nextCursor` as `cursor` for the next one. What a portal or link session may not see is
 * left out of its answer (who in the office wrote a message, whom a note mentioned, the thread's last activity).
 */

const recordParams = input({ recordType: z.string().regex(RECORD_TYPE), recordId: id() })
const page = {
  /** `nextCursor` of the previous page. */
  cursor: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}

export const threadView = output({
  id: id(),
  recordType: z.string(),
  recordId: id(),
  companyId: id().nullable(),
  siteId: id().nullable(),
  /** The record's party: the only one its shared messages reach. */
  partyId: id().nullable(),
  status: z.enum(THREAD_STATUSES),
  /** Office only. */
  lastMessageAt: instant().nullable().optional(),
  version: z.number().int(),
  createdAt: instant(),
})
export type ThreadView = z.infer<typeof threadView>

/** A file attached to a message, as far as the reader may see it (the download is GET /files/:id/download). */
export const attachmentView = output({
  id: id(),
  kind: z.enum(FILE_KINDS),
  originalName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  status: z.enum(FILE_STATUSES),
})
export type AttachmentView = z.infer<typeof attachmentView>

export const messageView = output({
  id: id(),
  threadId: id(),
  direction: z.enum(MESSAGE_DIRECTIONS),
  audience: z.enum(MESSAGE_AUDIENCES),
  channel: z.enum(MESSAGE_CHANNELS),
  author: output({
    kind: z.enum(AUTHOR_KINDS),
    /** Office only. */
    id: id().nullable().optional(),
    name: z.string().nullable(),
  }),
  body: z.string(),
  /** The sanitised HTML of an inbound mail; null otherwise. */
  bodyHtml: z.string().nullable(),
  /** Office only: the people the note mentioned. */
  mentions: z.array(id()).optional(),
  /** The attached files the reader may see, in order; the others are left out. */
  attachments: z.array(attachmentView),
  at: instant(),
})
export type MessageView = z.infer<typeof messageView>

export const readThreadContract = defineContract({
  params: recordParams,
  querystring: input(page),
  response: {
    200: output({
      /** Null: the record has no message yet (or none this reader may see). */
      thread: threadView.nullable(),
      messages: z.array(messageView),
      nextCursor: z.string().nullable(),
    }),
  },
})

export const postNoteContract = defineContract({
  params: recordParams,
  body: input({
    body: z.string().max(MAX_BODY_LENGTH),
    /** Office users to tell (COL-006); each must be able to read the thread. */
    mentions: z.array(id()).max(MAX_MENTIONS).optional(),
    /** Files of this record to attach (AVAILABLE, and readable by the writer). */
    attachments: z.array(id()).max(MAX_ATTACHMENTS).optional(),
  }),
  response: { 201: output({ thread: threadView, message: messageView }) },
})

export const setStatusContract = defineContract({
  params: recordParams,
  body: input({
    status: z.enum(THREAD_STATUSES),
    /** The thread's version as read (edit-conflict guard). */
    version: z.number().int().min(1),
    /** Why (for the audit log). */
    reason: z.string().trim().min(3).max(500).optional(),
  }),
  response: { 200: output({ thread: threadView }) },
})

const actorView = output({ audience: z.enum(['OFFICE', 'FLOOR', 'PARTNER', 'LINK', 'SYSTEM']), id: id() })

/** One entry of the record's timeline (COL-002): a message, a change (an audit row of the record) or a file. */
export const timelineEntry = z.discriminatedUnion('kind', [
  output({
    kind: z.literal('message'),
    /** The message's id. */
    id: id(),
    at: instant(),
    direction: z.enum(MESSAGE_DIRECTIONS),
    audience: z.enum(MESSAGE_AUDIENCES),
    channel: z.enum(MESSAGE_CHANNELS),
    author: output({ kind: z.enum(AUTHOR_KINDS), id: id().nullable(), name: z.string().nullable() }),
    /** The start of its text, one line. */
    excerpt: z.string(),
    attachmentCount: z.number().int(),
  }),
  output({
    kind: z.literal('change'),
    /** The audit row's id. */
    id: id(),
    at: instant(),
    /** The command (`files.completeUpload`). */
    action: z.string(),
    actor: actorView,
    /** The status move it recorded, if any. */
    status: output({ from: z.string().nullable(), to: z.string().nullable() }).nullable(),
    /** The fields it changed; money ones only with their grain. */
    fields: z.array(z.string()),
    /** The values, only with audit.read over the row (and money only with its grain); null otherwise. */
    before: grainedJson(),
    after: grainedJson(),
    reason: z.string().nullable(),
  }),
  output({
    kind: z.literal('file'),
    /** The file's id. */
    id: id(),
    /** When it became available. */
    at: instant(),
    fileKind: z.enum(FILE_KINDS),
    originalName: z.string(),
    status: z.enum(FILE_STATUSES),
    visibility: z.array(z.enum(FILE_AUDIENCES)),
  }),
])
export type TimelineEntryView = z.infer<typeof timelineEntry>

export const timelineContract = defineContract({
  params: recordParams,
  querystring: input({
    ...page,
    /** Filter chips: a comma-separated list of message, change, file. Default every kind. */
    kinds: z
      .string()
      .max(40)
      .optional()
      .transform((value, context) => {
        if (value === undefined || value.trim() === '') return [...TIMELINE_KINDS]
        const kinds = [...new Set(value.split(',').map((kind) => kind.trim()))]
        const unknown = kinds.filter((kind) => !(TIMELINE_KINDS as readonly string[]).includes(kind))
        if (unknown.length > 0) context.addIssue({ code: 'custom', message: `Expected ${TIMELINE_KINDS.join(', ')}.` })
        return kinds as (typeof TIMELINE_KINDS)[number][]
      }),
  }),
  response: { 200: output({ entries: z.array(timelineEntry), nextCursor: z.string().nullable() }) },
})

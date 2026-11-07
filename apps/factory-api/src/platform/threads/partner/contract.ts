import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { MAX_ATTACHMENTS, MAX_BODY_LENGTH, MESSAGE_CHANNELS, RECORD_TYPE, THREAD_STATUSES } from '@nexus/factory-domain/threads/rules'
import { COMPOSER_REASONS, PARTNER_SIDES, PARTNER_THREADS_MAX, PARTNER_THREADS_PAGE } from '@nexus/factory-domain/threads/partner/rules'
import { attachmentView } from '../contract'

/**
 * A record's thread as the partner sees it (B-W2b-168; COL-059, COL-060; design portal.frame › thread, portal.customer.home
 * › recent-messages): the routes `/portal/threads…` of a portal session. Only what is shared with the party: our messages
 * and theirs, by mail or in the portal, never an internal note, never who in the office wrote what beyond the name on the
 * message, never the thread's last activity (internal notes move it). Pages run newest first: send back `nextCursor`.
 */

const recordParams = input({ recordType: z.string().regex(RECORD_TYPE), recordId: id() })

/** The record as the partner knows it (RefPair: their reference first, ours second). */
export const partnerRecordView = output({
  type: z.string(),
  id: id(),
  theirRef: z.string().nullable(),
  ourRef: z.string().nullable(),
  /** One line under it (the order a document belongs to; the account's name). */
  subtitle: z.string().nullable(),
  /** Its status code (the portal says it in the partner's words). */
  status: z.string().nullable(),
})

/** A message as the partner reads it. */
export const partnerMessageView = output({
  id: id(),
  /** COMPANY: we sent it; PARTNER: they wrote it (by mail or in the portal). */
  side: z.enum(PARTNER_SIDES),
  /** EMAIL: by mail (our mail, or their reply to it); PORTAL: written in the portal; APP: by us in the app. */
  channel: z.enum(MESSAGE_CHANNELS),
  author: output({
    /** The person's name; our company's name for a message the system wrote. */
    name: z.string().nullable(),
    /** The reader wrote it in the portal. */
    mine: z.boolean(),
  }),
  body: z.string(),
  /** The sanitised HTML of a reply by mail; null otherwise. */
  bodyHtml: z.string().nullable(),
  /** The attached files the reader may see (shared with the party, available), in order; the others are left out. */
  attachments: z.array(attachmentView),
  at: instant(),
})
export type PartnerMessageView = z.infer<typeof partnerMessageView>

const composerView = output({
  /** The person may write now. */
  canPost: z.boolean(),
  /** Why not (PREVIEW, NO_COMMENT: the person's access reads only, CLOSED: we closed the conversation). */
  reason: z.enum(COMPOSER_REASONS).nullable(),
  /** The reason in the person's language; null when they may write. */
  words: z.string().nullable(),
  /** Our mail on this thread carries its reply address: "You can also answer our e-mails". */
  replyByEmail: z.boolean(),
  /** That sentence in the person's language, or null. */
  hint: z.string().nullable(),
})

export const partnerThreadView = output({
  record: partnerRecordView,
  /** Null: no message yet (the first post makes the thread). */
  thread: output({ id: id(), status: z.enum(THREAD_STATUSES) }).nullable(),
  messages: z.array(partnerMessageView),
  nextCursor: z.string().nullable(),
  composer: composerView,
})

export const readPartnerThreadContract = defineContract({
  params: recordParams,
  querystring: input({
    /** `nextCursor` of the previous page. */
    cursor: z.string().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: { 200: partnerThreadView },
})

export const postPartnerMessageContract = defineContract({
  params: recordParams,
  body: input({
    body: z.string().max(MAX_BODY_LENGTH),
    /** Files of this record shared with you (available) to attach. */
    attachments: z.array(id()).max(MAX_ATTACHMENTS).optional(),
  }),
  response: { 201: output({ thread: output({ id: id(), status: z.enum(THREAD_STATUSES) }), message: partnerMessageView }) },
})

/** The party's conversations, newest message first (the Messages list; Home's "recent messages from us"). */
export const listPartnerThreadsContract = defineContract({
  querystring: input({
    /** company: the conversations with a message of ours, each by our newest one (Home's "Recent messages from us"); default any. */
    from: z.enum(['any', 'company']).default('any'),
    limit: z.coerce.number().int().min(1).max(PARTNER_THREADS_MAX).default(PARTNER_THREADS_PAGE),
  }),
  response: {
    200: output({
      conversations: z.array(
        output({
          record: partnerRecordView,
          thread: output({ id: id(), status: z.enum(THREAD_STATUSES) }),
          /** Its newest shared message (of ours, with from=company). */
          last: output({
            id: id(),
            side: z.enum(PARTNER_SIDES),
            channel: z.enum(MESSAGE_CHANNELS),
            authorName: z.string().nullable(),
            /** The start of its text, one line. */
            excerpt: z.string(),
            attachmentCount: z.number().int(),
            at: instant(),
          }),
        }),
      ),
    }),
  },
})

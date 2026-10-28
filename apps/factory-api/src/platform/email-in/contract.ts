import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { HELD_REASONS, INBOUND_STATUSES, MAIL_VERDICTS, MATCHED_BY, PERSON_REJECT_REASONS, REJECT_REASONS, SKIP_REASONS } from '@nexus/factory-domain/email-in/rules'
import { RECORD_TYPE, THREAD_STATUSES } from '@nexus/factory-domain/threads/rules'
import { attachmentView } from '../threads/contract'

/**
 * Email in's contracts (plan A1 §3.7; A2 SCR-019 "Mail to sort": incoming mail not yet matched to a record — match,
 * ignore; features COL-022, COL-023, COL-025, COL-026). Office only. No answer holds the raw mail, its place in S3, a
 * thread's reply address or a storage key; the HTML is the sanitised one (show it in a sandboxed frame, remote pictures
 * only when the person allows them: `data-remote-src`).
 */

const inboundParams = input({ inboundEmailId: id() })
/** The mail's version as read (edit-conflict guard): the worker moves it too. */
const version = z.number().int().min(1)

const verdictsView = output({
  spf: z.enum(MAIL_VERDICTS),
  dkim: z.enum(MAIL_VERDICTS),
  dmarc: z.enum(MAIL_VERDICTS),
  /** The sender domain's DMARC policy, when SES reported one with a failure. */
  dmarcPolicy: z.string().nullable(),
  spam: z.enum(MAIL_VERDICTS),
  virus: z.enum(MAIL_VERDICTS),
})

/** One received mail on the list. */
export const inboundSummaryView = output({
  id: id(),
  /** The SES account's company (null: tenant-wide). */
  companyId: id().nullable(),
  status: z.enum(INBOUND_STATUSES),
  receivedAt: instant(),
  from: output({ address: z.string().nullable(), name: z.string().nullable() }),
  subject: z.string().nullable(),
  /** The start of its text, one line (empty until it was read). */
  excerpt: z.string(),
  verdicts: verdictsView,
  heldReason: z.enum(HELD_REASONS).nullable(),
  rejectReason: z.enum(REJECT_REASONS).nullable(),
  matchedBy: z.enum(MATCHED_BY).nullable(),
  /** The thread it joined, or the one it names while it waits (a release writes there). */
  threadId: id().nullable(),
  /** The party (and contact) the sender is, or the party its company domain suggests. */
  suggestion: output({ partyId: id().nullable(), contactId: id().nullable() }),
  attachmentCount: z.number().int(),
  version: z.number().int(),
})
export type InboundSummaryView = z.infer<typeof inboundSummaryView>

/** One attachment as the mail had it: kept (with the file that holds it, as far as the reader may see it) or skipped. */
const attachmentEntry = output({
  name: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  kept: z.boolean(),
  /** Why it was not kept: a type files do not take, too large, empty, an inline picture, too many. */
  skipReason: z.enum(SKIP_REASONS).nullable(),
  file: attachmentView.nullable(),
})

export const inboundDetailView = inboundSummaryView.extend({
  to: z.array(z.string()),
  cc: z.array(z.string()),
  /** The plain text (null until it was read). */
  bodyText: z.string().nullable(),
  /** The sanitised HTML, or null. */
  bodyHtml: z.string().nullable(),
  attachments: z.array(attachmentEntry),
  /** The thread it joined or names, with its record. */
  thread: output({ id: id(), recordType: z.string(), recordId: id(), status: z.enum(THREAD_STATUSES) }).nullable(),
  /** The INBOUND message it became. */
  messageId: id().nullable(),
  attempts: z.number().int(),
  /** Why it could not be read (FAILED), in words without an address. */
  lastError: z.string().nullable(),
  fetchedAt: instant().nullable(),
  sortedAt: instant().nullable(),
  /** The person who assigned, released or rejected it (null: the worker). */
  sortedById: id().nullable(),
})
export type InboundDetailView = z.infer<typeof inboundDetailView>

export const listInboundContract = defineContract({
  querystring: input({
    /** One place; default the mail to sort (TRIAGE, HELD and FAILED). */
    status: z.enum(INBOUND_STATUSES).optional(),
    companyId: id().optional(),
    /** `nextCursor` of the previous page. */
    cursor: z.string().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: { 200: output({ mails: z.array(inboundSummaryView), nextCursor: z.string().nullable() }) },
})

export const getInboundContract = defineContract({
  params: inboundParams,
  response: { 200: output({ mail: inboundDetailView }) },
})

export const assignInboundContract = defineContract({
  params: inboundParams,
  body: input({
    /** The record whose thread the mail joins (it must have a customer or supplier). */
    recordType: z.string().regex(RECORD_TYPE),
    recordId: id(),
    version,
  }),
  response: { 200: output({ mail: inboundDetailView }) },
})

export const releaseInboundContract = defineContract({
  params: inboundParams,
  body: input({
    version,
    /** Why it may go on (for the audit log). */
    reason: z.string().trim().min(3).max(500).optional(),
  }),
  response: { 200: output({ mail: inboundDetailView }) },
})

export const rejectInboundContract = defineContract({
  params: inboundParams,
  body: input({
    reason: z.enum(PERSON_REJECT_REASONS),
    version,
    /** Why (for the audit log). */
    note: z.string().trim().min(3).max(500).optional(),
  }),
  response: { 200: output({ mail: inboundDetailView }) },
})

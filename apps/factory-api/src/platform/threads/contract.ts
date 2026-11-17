import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { grainedJson } from '@nexus/factory-domain/money/marked'
import { AUTHOR_KINDS, MAX_ATTACHMENTS, MAX_BODY_LENGTH, MAX_MENTIONS, MESSAGE_AUDIENCES, MESSAGE_CHANNELS, MESSAGE_DIRECTIONS, RECORD_TYPE, THREAD_STATUSES } from '@nexus/factory-domain/threads/rules'
import { FOLLOW_REASONS } from '@nexus/factory-domain/threads/followers'
import { TIMELINE_ASKABLE_KINDS, TIMELINE_KINDS } from '@nexus/factory-domain/threads/timeline'
import { WAITING_SIDES } from '@nexus/factory-domain/threads/view-gates' // B-TH-047
// ---- B-TH-049: the typed amount (price grain). B-TH-050: messages that point at messages.
import { currency } from '@nexus/factory-domain/core/contracts'
import { money } from '@nexus/factory-domain/money/marked'
import { MESSAGE_AMOUNT_MAX } from '@nexus/factory-domain/threads/price-check'
// ---- end B-TH-049 / B-TH-050
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
  /** B-TH-083: a measurement sheet this office reader may not open — no name ("Measurement sheet — you cannot open it"). */
  locked: z.literal('MEASUREMENTS').optional(),
})
export type AttachmentView = z.infer<typeof attachmentView>

// ---- B-TH-050 (thread-G20): a message another points at, as a card shows it ("In reply to Anna, 14 Nov: …", "Corrects …").
export const linkedMessageView = output({ id: id(), /** Null: a floor worker the site's gate keeps back. */ authorName: z.string().nullable(), excerpt: z.string(), at: instant() })
/** B-TH-050: what a new message answers or corrects — one at most, a message of the same conversation. */
export const messageLinkInput = {
  /** "Reply" on a message: the message it answers. */
  replyToMessageId: id().optional(),
  /** "Correct": the message it corrects (messages are never edited; the old one shows "Corrected below"). */
  correctsMessageId: id().optional(),
}
// ---- end B-TH-050

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
  /** Office only: a floor worker wrote it and the site's PERFORMANCE gate keeps back who (no id, no name). */
  authorHidden: z.boolean().optional(),
  /** Office only: the tablets read this note too (B-W2b-F5). */
  forFloor: z.boolean().optional(),
  body: z.string(),
  /** The sanitised HTML of an inbound mail; null otherwise. */
  bodyHtml: z.string().nullable(),
  /** Office only: the people the note mentioned. */
  mentions: z.array(id()).optional(),
  /** The attached files the reader may see, in order; the others are left out. */
  attachments: z.array(attachmentView),
  /** B-TH-231 (B-TH-029): how many attached files the reader may not see (left out above; absent when none): "One file you cannot open". */
  hiddenAttachments: z.number().int().min(1).optional(),
  // ---- B-TH-049 (N7, T8-F04): the price typed in the amount field (minor units of its currency); office only, and only for a reader
  // holding the price grain (money.price: the answer drops it for everyone else). Null: the note has none.
  amount: money.price(output({ value: z.number().int(), currency: z.string() }).nullable()),
  // ---- B-TH-050 (thread-G20): office only — what it answers or corrects, and the newest message that corrects it ("Corrected below").
  replyTo: linkedMessageView.nullable().optional(),
  corrects: linkedMessageView.nullable().optional(),
  correctedBy: output({ id: id(), at: instant() }).nullable().optional(),
  // ---- end B-TH-049 / B-TH-050
  at: instant(),
})
export type MessageView = z.infer<typeof messageView>

// ---- B-TH-027 (threads plan G10): the reader's own read mark ------------------------------------------------------------
/** The reader's own reading of a thread: their mark, what is new to them after it, the first new message. Never anyone else's. */
export const readingView = output({
  lastReadMessageId: id().nullable(),
  newCount: z.number().int(),
  /** "New since your last visit" sits above this message; null: nothing new. */
  firstNewMessageId: id().nullable(),
})
// ---- end B-TH-027

// ---- B-TH-028: who answers the conversation (null: the record's own, by the chain) ------------------------------------------
export const ownerView = output({ id: id(), name: z.string(), active: z.boolean(), source: z.enum(['SET', 'ASSIGNEE', 'SUPERVISOR', 'MAKER']) })
export const setOwnerContract = defineContract({
  params: recordParams,
  body: input({ /** An active office person who may read the conversation; null: the record's own (its assignee, supervisor or maker). */ ownerId: id().nullable() }),
  response: { 200: output({ owner: ownerView.nullable() }) },
})
// ---- end B-TH-028

export const readThreadContract = defineContract({
  params: recordParams,
  querystring: input(page),
  response: {
    200: output({
      /** Null: the record has no message yet (or none this reader may see). */
      thread: threadView.nullable(),
      messages: z.array(messageView),
      nextCursor: z.string().nullable(),
      /** B-TH-027: the reader's own reading (office and portal people; null for a link or before the first message). */
      reading: readingView.nullable().optional(),
      // ---- B-TH-028: who answers and what waits (the office only: a portal or link reader is never told either)
      head: output({
        owner: output({ id: id(), name: z.string(), active: z.boolean(), source: z.enum(['SET', 'ASSIGNEE', 'SUPERVISOR', 'MAKER']) }).nullable(),
        waiting: output({
          on: z.enum(['US', 'CUSTOMER']),
          since: instant(),
          /** Working minutes since, on the record's company calendar (clock minutes without a calendar: `calendar` false). */
          workingMinutes: z.number().int(),
          calendar: z.boolean(),
          /** Over the rule's threshold: a request after 1 working day, any other record after 3. */
          amber: z.boolean(),
          thresholdDays: z.number().int(),
        }).nullable(),
      }).optional(),
      // ---- end B-TH-028
    }),
  },
})

// ---- B-TH-027: mark read, mark unread, the counts of a page of records -----------------------------------------------------
export const markReadContract = defineContract({
  params: recordParams,
  body: input({ /** Read up to this message (default: the newest the reader may read); the mark only moves forward. */ messageId: id().optional() }),
  response: { 200: output({ reading: readingView }) },
})
export const markUnreadContract = defineContract({
  params: recordParams,
  body: input({ /** New again from this message on. */ messageId: id() }),
  response: { 200: output({ reading: readingView }) },
})
export const unreadContract = defineContract({
  body: input({ records: z.array(input({ recordType: z.string().regex(RECORD_TYPE), recordId: id() })).min(1).max(200) }),
  response: { 200: output({ counts: z.array(output({ recordType: z.string(), recordId: id(), newCount: z.number().int(), lastAt: instant().nullable() })) }) },
})
// ---- end B-TH-027

export const postNoteContract = defineContract({
  params: recordParams,
  body: input({
    body: z.string().max(MAX_BODY_LENGTH),
    /** Office users to tell (COL-006); each must be able to read the thread. */
    mentions: z.array(id()).max(MAX_MENTIONS).optional(),
    /** Files of this record to attach (AVAILABLE, and readable by the writer). */
    attachments: z.array(id()).max(MAX_ATTACHMENTS).optional(),
    /** "For the floor": the tablets working on the work order read it too. A work order's note only; default false, it stays in the office. */
    forFloor: z.boolean().optional(),
    /**
     * B-TH-049: a price in its own field, never in the words — minor units (cents) of an ISO 4217 currency. Only a reader holding
     * the price grain sends it (money.price: refused otherwise); never with "For the floor". A floor note whose words look like a
     * price is held (409 refusal/FLOOR_PRICE, the reason named).
     */
    amount: money.price(input({ value: z.number().int().min(0).max(MESSAGE_AMOUNT_MAX), currency: currency() })),
    // B-TH-050: the message it answers or corrects (an office note corrects an office note; a correction of a floor note goes to the floor).
    ...messageLinkInput,
  }),
  response: { 201: output({ thread: threadView, message: messageView }) },
})

// ---- B-TH-044 (G15): a reply the record's party reads in its portal, with no mail (OUTBOUND on the PORTAL channel). One action that
// replies on several records sends the same batchId with each (B-TH-045: one bell item per reader).
export const postReplyContract = defineContract({
  params: recordParams,
  body: input({
    body: z.string().max(MAX_BODY_LENGTH),
    /** Files of this record already shared with its party (AVAILABLE, readable by the writer). */
    attachments: z.array(id()).max(MAX_ATTACHMENTS).optional(),
    /** The batch of one action that replies on several records (the same id on each call). */
    batchId: id().optional(),
    // B-TH-050: the shared message it answers, or the portal reply of ours it corrects (a mail is corrected by mail).
    ...messageLinkInput,
  }),
  response: { 201: output({ thread: threadView, message: messageView }) },
})
// ---- end B-TH-044

/**
 * Who a note on the record may mention (COL-006; A2 SCR-006's composer): every ACTIVE person whose roles let them read
 * the record's thread, by name. Names only: no address, no role.
 */
export const mentionablePeopleContract = defineContract({
  params: recordParams,
  response: { 200: output({ people: z.array(output({ id: id(), name: z.string() })) }) },
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

/**
 * `id` is null for a floor worker the site's PERFORMANCE gate keeps back (B-W2b-F4): `actorHidden`. `name`: an office person's
 * (B-W2b-399), else null (a floor worker is never named here).
 */
const actorView = output({ audience: z.enum(['OFFICE', 'FLOOR', 'PARTNER', 'LINK', 'SYSTEM']), id: id().nullable(), name: z.string().nullable() })

/**
 * B-W2b-399 (PLT-076): one changed field of a change, "price 480 → 520" (platform/threads/timeline/field-lines.ts): the values
 * only for a reader who may see them (`hidden: 'VALUES'` otherwise), money only with its grain (a field of a grain the reader
 * lacks is not listed).
 */
export const fieldLineView = output({ field: z.string(), from: grainedJson(), to: grainedJson(), hidden: z.enum(['GRAIN', 'VALUES']).nullable() })

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
    /** A floor worker wrote it and the site's PERFORMANCE gate keeps back who (no id, no name). */
    authorHidden: z.boolean(),
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
    /** A floor worker did it and the site's PERFORMANCE gate keeps back who. */
    actorHidden: z.boolean(),
    /** The status move it recorded, if any. */
    status: output({ from: z.string().nullable(), to: z.string().nullable() }).nullable(),
    /** The fields it changed; money ones only with their grain. */
    fields: z.array(z.string()),
    /** B-W2b-399: the same fields as lines from → to. */
    lines: z.array(fieldLineView),
    /** The values, only with audit.read over the row (and money only with its grain), and not while the gate keeps back a worker the row is about; null otherwise. */
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
  // ---- B-TH-072: a project's linked record moved or was decided (asked with kinds=linked): one line per record per day, only of a
  // record the reader may open; its status move, the action and the office person — never a value.
  output({
    kind: z.literal('linked'),
    /** The linked record's audit row. */
    id: id(),
    at: instant(),
    recordType: z.string(),
    recordId: id(),
    /** Its number or code (SR-0042). */
    label: z.string(),
    action: z.string(),
    status: output({ from: z.string().nullable(), to: z.string().nullable() }).nullable(),
    actorName: z.string().nullable(),
    /** How many moves of the record that day this line stands for. */
    folded: z.number().int(),
  }),
  // ---- end B-TH-072
])
export type TimelineEntryView = z.infer<typeof timelineEntry>

export const timelineContract = defineContract({
  params: recordParams,
  querystring: input({
    ...page,
    /** Filter chips: a comma-separated list of message, change, file. Default every kind. B-TH-072: `linked` only when asked (a project). */
    kinds: z
      .string()
      .max(40)
      .optional()
      .transform((value, context) => {
        if (value === undefined || value.trim() === '') return [...TIMELINE_KINDS] as (typeof TIMELINE_ASKABLE_KINDS)[number][]
        const kinds = [...new Set(value.split(',').map((kind) => kind.trim()))]
        const unknown = kinds.filter((kind) => !(TIMELINE_ASKABLE_KINDS as readonly string[]).includes(kind))
        if (unknown.length > 0) context.addIssue({ code: 'custom', message: `Expected ${TIMELINE_ASKABLE_KINDS.join(', ')}.` })
        return kinds as (typeof TIMELINE_ASKABLE_KINDS)[number][]
      }),
  }),
  response: { 200: output({ entries: z.array(timelineEntry), nextCursor: z.string().nullable() }) },
})

// ---- followers (B-W2a-20; COL-011; design shell.panels popup followers) ------------------------------------------------

const followersView = output({
  record: output({ type: z.string(), id: id() }),
  /** Every follower, muted ones included (the list shows at most 200). */
  count: z.number().int(),
  /** My own follow: the band's Follow toggle. */
  me: output({ following: z.boolean(), muted: z.boolean(), reason: z.enum(FOLLOW_REASONS).nullable() }),
  followers: z.array(
    output({
      userId: id(),
      name: z.string(),
      me: z.boolean(),
      /** Why they first followed it: made it, were given something on it, were mentioned, chose to, were added (B-TH-068: ADDED). */
      reason: z.enum(FOLLOW_REASONS),
      /** Muted: the record's news does not reach them (a mention still does). */
      muted: z.boolean(),
      since: instant(),
      /** The colleague who added them, when someone else did. */
      addedBy: output({ id: id(), name: z.string() }).nullable(),
      // B-TH-068: a portal person of the record's outside company (a project's brand member), not one of our colleagues.
      outside: z.boolean(),
    }),
  ),
})

export const followersContract = defineContract({ params: recordParams, response: { 200: followersView } })

export const setMyFollowContract = defineContract({
  params: recordParams,
  body: input({
    /** False: unfollow (the follow is removed; a later mention follows again). */
    following: z.boolean(),
    /** True: keep following without the record's news (M on a notification); nothing follows me again on its own. */
    muted: z.boolean().default(false),
  }),
  response: { 200: followersView },
})

export const addFollowerContract = defineContract({
  params: recordParams,
  body: input({ /** An active colleague who may read the record's thread. */ userId: id() }),
  response: { 200: followersView },
})

// ---- B-TH-047 (N10, N25, X-G06): conversations waiting on us across records — "Customer replies" (Incoming) and "Supplier replies"
// (Purchasing › Orders). Each row only for a reader who may open its record (threads.read and the type's own view permission).
const waitingRowView = output({
  recordType: z.string(),
  recordId: id(),
  /** The record as a chip shows it (its number, code or name). */
  label: z.string(),
  companyId: id().nullable(),
  /** The customer or supplier the conversation is with (the record's party). */
  party: output({ id: id(), code: z.string(), name: z.string() }),
  /** The message that waits: the customer's or supplier's newest shared one. */
  lastMessage: output({ id: id(), at: instant(), channel: z.enum(MESSAGE_CHANNELS), authorName: z.string().nullable(), excerpt: z.string() }),
  /** Since when it waits on us, in working minutes on the record's company calendar (`calendar` false: clock minutes); amber over the rule's days. */
  waiting: output({ since: instant(), workingMinutes: z.number().int(), calendar: z.boolean(), amber: z.boolean(), thresholdDays: z.number().int() }),
})
export const waitingContract = defineContract({
  querystring: input({
    /** CUSTOMER: the customer wrote last ("Customer replies"); SUPPLIER: the supplier did ("Supplier replies"). */
    side: z.enum(WAITING_SIDES),
    /** One record type of the side only (e.g. PurchaseOrder). */
    recordType: z.string().regex(RECORD_TYPE).optional(),
    companyId: id().optional(),
    partyId: id().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    /** `next` of the page before, as it came. */
    cursor: z.string().min(1).max(200).optional(),
  }),
  response: {
    200: output({
      rows: z.array(waitingRowView),
      /** Every conversation of the side that waits on us and the reader may open (oldest first). */
      count: z.number().int(),
      /** false: more conversations wait than one read keeps (the list and its count are partial). */
      complete: z.boolean(),
      next: z.string().nullable(),
    }),
  },
})
// ---- end B-TH-047

// ---- B-TH-076 (X-G01; PL5, O-REC-ANY.summary-F01, P-ANY.summary): one summary row for any record — its type in words, its label, its
// state and its parent as a link; the office in its scope, the portal through the partner view only (404 in neutral words otherwise).
const summaryWords = output({ it: z.string(), en: z.string() })
const summaryLink = output({
  recordType: z.string(),
  recordId: id(),
  /** The record type in words ("Delivery note" / "Documento di trasporto"). */
  type: summaryWords,
  /** Its number or code as a chip shows it (the portal: our number, else their reference); null when it has none. */
  label: z.string().nullable(),
})
export const recordSummaryContract = defineContract({
  params: recordParams,
  response: {
    200: output({
      summary: output({
        recordType: z.string(),
        recordId: id(),
        type: summaryWords,
        label: z.string().nullable(),
        /** The portal reader's own reference (their PO number); null in the office answer and when they gave none. */
        theirRef: z.string().nullable(),
        /** Its state code and the state in words; null: a record with no state (a rider's measurements). */
        state: output({ code: z.string(), words: summaryWords }).nullable(),
        /** The record it belongs to (a delivery's order, a receipt's PO), only when the reader may open it; null: none or not theirs. */
        parent: summaryLink.nullable(),
      }),
    }),
  },
})
// ---- end B-TH-076

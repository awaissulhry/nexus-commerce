import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { messageSchema, threadSchema, type RecordKey } from '../../../record-panels/api'
import { CHECK_WARNINGS, RECIPIENT_KINDS, type SendCheck } from '../../../lib/record-thread/send-check/model'

/**
 * The office thread's own calls (B-TH-212), beside the record panels' (record-panels/api.ts: emails, files, people, timeline,
 * uploads, status), through the ONE client. Each answer is checked against the shape the thread reads. Writes carry the caller's
 * Idempotency-Key, so "Retry" after a lost answer sends the SAME key and never posts twice (T3-F13).
 */

const enc = encodeURIComponent
const threadPath = (record: RecordKey) => `/threads/${enc(record.type)}/${enc(record.id)}`

/** A page of messages ("Show 50 earlier"; the API allows up to 200), newest first. */
export const THREAD_PAGE = 50

// ---- B-TH-229: the reader's own reading (B-TH-027) and the office head — who answers, what waits (B-TH-028)
export const readingSchema = z.object({ lastReadMessageId: z.string().nullable(), newCount: z.number().int(), firstNewMessageId: z.string().nullable() })
export type Reading = z.infer<typeof readingSchema>
const ownerSchema = z.object({ id: z.string(), name: z.string(), active: z.boolean(), source: z.enum(['SET', 'ASSIGNEE', 'SUPERVISOR', 'MAKER']) })
export const headSchema = z.object({
  owner: ownerSchema.nullable(),
  waiting: z.object({ on: z.enum(['US', 'CUSTOMER']), since: z.string(), workingMinutes: z.number().int(), calendar: z.boolean(), amber: z.boolean(), thresholdDays: z.number().int() }).nullable(),
})
export type ThreadHead = z.infer<typeof headSchema>
// ---- end B-TH-229

// ---- B-TH-255 (B-TH-079; T3-F14, T3-F15, T4-F10): the office read's depth — a message erased after a privacy request, an inbound mail's
// files not kept (never a signature logo), and the mail for this conversation that waits for a person. Codes stay strings here (an
// unknown one is said plainly, never a failed read): the card and the feed name each in words.
const skippedSchema = z.object({ name: z.string(), contentType: z.string(), sizeBytes: z.number().int(), reason: z.string() })
export const officeMessageSchema = messageSchema.extend({ erased: z.boolean().optional(), skippedAttachments: z.array(skippedSchema).optional() })
export type OfficeMessage = z.infer<typeof officeMessageSchema>
export const waitingMailSchema = z.object({ count: z.number().int(), reasons: z.array(z.string()), mayReview: z.boolean() })
export type WaitingMail = z.infer<typeof waitingMailSchema>
// ---- end B-TH-255

const page = z.object({
  thread: threadSchema.nullable(),
  messages: z.array(officeMessageSchema /* B-TH-255 */),
  nextCursor: z.string().nullable(),
  reading: readingSchema.nullable().optional(),
  head: headSchema.optional(),
  waitingMail: waitingMailSchema.nullable().optional() /* B-TH-255 */,
})
export type ThreadPageAnswer = z.infer<typeof page>

export function readThreadPage(api: ApiClient, record: RecordKey, cursor: string | null, signal?: AbortSignal): Promise<ThreadPageAnswer> {
  return api.get(threadPath(record), { query: { cursor: cursor ?? undefined, limit: THREAD_PAGE }, schema: page, signal })
}

// ---- B-TH-255 (B-TH-079, T1-F05): how many messages new to the reader the Head's View hides — the timeline read with the view's
// audience and kinds (one entry is enough: only `hiddenNew` is used; the entries are the timeline's own page).
const hiddenAnswer = z.object({ hiddenNew: z.number().int() })
export async function readHiddenNew(api: ApiClient, record: RecordKey, query: { audience: 'ALL' | 'PARTNER' | 'OFFICE'; kinds: 'message' | 'change' }, signal?: AbortSignal): Promise<number> {
  const answer = await api.get(`${threadPath(record)}/timeline`, { query: { audience: query.audience, kinds: query.kinds, limit: 1 }, schema: hiddenAnswer, signal })
  return answer.hiddenNew
}
// ---- end B-TH-255

// ---- B-TH-229 (B-TH-027 / B-TH-028): the person's own read mark; who answers the thread ---------------------------------------
/** POST …/read: the person read the thread up to this message (the mark only moves forward); their reading after it. */
export async function markThreadRead(api: ApiClient, record: RecordKey, messageId: string): Promise<Reading> {
  const answer = await api.post(`${threadPath(record)}/read`, { body: { messageId }, schema: z.object({ reading: readingSchema }), idempotencyKey: globalThis.crypto.randomUUID() })
  return answer.reading
}

/** PUT …/owner: who answers the thread (an office person who reads it), or null: the record's own (assignee, supervisor, maker). */
export async function setThreadOwner(api: ApiClient, record: RecordKey, ownerId: string | null): Promise<ThreadHead['owner']> {
  const answer = await api.request('PUT', `${threadPath(record)}/owner`, { body: { ownerId }, schema: z.object({ owner: ownerSchema.nullable() }), idempotencyKey: globalThis.crypto.randomUUID() })
  return answer.owner
}
// ---- end B-TH-229

const posted = z.object({ message: z.object({ id: z.string() }).passthrough() }).passthrough()
// B-TH-236 (B-TH-048): the answer names the mail and until when its sender may take it back.
const sent = z.object({ messageId: z.string(), email: z.object({ id: z.string(), undoUntil: z.string().nullable().optional() }).passthrough().optional() }).passthrough()

/** B-TH-236 (B-TH-050): what a new message answers or corrects (one at most; a message of this conversation). */
export interface MessageLinks {
  replyToMessageId?: string
  correctsMessageId?: string
}

/**
 * POST …/notes with the caller's key: an Office note (never reaches a customer; a work order's may go to the floor). B-TH-236: the
 * amount in its own field (price readers only, never with "For the floor") and the message it answers or corrects.
 */
export async function postNoteKeyed(
  api: ApiClient,
  record: RecordKey,
  input: { body: string; mentions: readonly string[]; attachments: readonly string[]; forFloor: boolean; amount?: { value: number; currency: string } | null } & MessageLinks,
  idempotencyKey: string,
): Promise<string> {
  const answer = await api.post(`${threadPath(record)}/notes`, {
    body: {
      body: input.body,
      mentions: [...input.mentions],
      attachments: [...input.attachments],
      ...(input.forFloor ? { forFloor: true } : {}),
      ...(input.amount ? { amount: input.amount } : {}),
      ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
      ...(input.correctsMessageId ? { correctsMessageId: input.correctsMessageId } : {}),
    },
    schema: posted,
    idempotencyKey,
  })
  return answer.message.id
}

/**
 * POST …/emails with the caller's key: the reply to the record's customer, To and Cc apart, with the recorded tick when given.
 * B-TH-236: the message it answers or corrects; the answer's mail and its Undo time (10 seconds after Send).
 */
export async function sendReplyKeyed(
  api: ApiClient,
  record: RecordKey,
  body: { to: string[]; cc?: string[]; subject?: string; body: string; attachments: string[]; sendOutside?: true } & MessageLinks,
  idempotencyKey: string,
): Promise<{ messageId: string; email: { id: string; undoUntil: string | null } | null }> {
  const answer = await api.post(`${threadPath(record)}/emails`, { body, schema: sent, idempotencyKey })
  return { messageId: answer.messageId, email: answer.email ? { id: answer.email.id, undoUntil: answer.email.undoUntil ?? null } : null }
}

// ---- B-TH-237 (B-TH-044): a reply the customer reads in its portal, no e-mail ----------------------------------------------------
/** POST …/replies with the caller's key: OUTBOUND on the PORTAL channel; files already shared with the record's customer. */
export async function postPortalReplyKeyed(api: ApiClient, record: RecordKey, input: { body: string; attachments: readonly string[] } & MessageLinks, idempotencyKey: string): Promise<string> {
  const answer = await api.post(`${threadPath(record)}/replies`, {
    body: {
      body: input.body,
      attachments: [...input.attachments],
      ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
      ...(input.correctsMessageId ? { correctsMessageId: input.correctsMessageId } : {}),
    },
    schema: posted,
    idempotencyKey,
  })
  return answer.message.id
}
// ---- end B-TH-237

// ---- B-TH-236 (B-TH-048): take a mail back in its 10 seconds; its text comes back for the box --------------------------------
const takenBack = z.object({
  email: z.object({ id: z.string(), status: z.string() }).passthrough(),
  text: z.object({
    to: z.array(z.string()),
    cc: z.array(z.string()),
    bcc: z.array(z.string()),
    subject: z.string(),
    body: z.string(),
    attachments: z.array(z.string()),
    replyToMessageId: z.string().nullable().optional(),
    correctsMessageId: z.string().nullable().optional(),
  }),
})
export type TakenBack = z.infer<typeof takenBack>

/** POST …/emails/<emailId>/undo (its sender, in the window): WITHDRAWN; the text, recipients, files and links of the mail. */
export function takeBackMail(api: ApiClient, record: RecordKey, emailId: string): Promise<TakenBack> {
  return api.post(`${threadPath(record)}/emails/${enc(emailId)}/undo`, { body: {}, schema: takenBack, idempotencyKey: globalThis.crypto.randomUUID() })
}
// ---- end B-TH-236

const organisation = z.object({ id: z.string(), name: z.string() })
const checkSchema = z.object({
  party: organisation.nullable(),
  recipients: z.array(z.object({ address: z.string(), kind: z.enum(RECIPIENT_KINDS), source: z.string().nullable(), organisation: organisation.nullable(), personName: z.string().nullable() })),
  warnings: z.array(z.object({ code: z.enum(CHECK_WARNINGS), items: z.array(z.string()) })),
  attachments: z.array(z.object({ id: z.string(), name: z.string(), sizeBytes: z.number().int(), audience: z.enum(['PARTY', 'OFFICE']) })),
  outsideCustomer: z.array(z.string()).default([]),
})

/** POST …/emails/check: the mis-send read of what would go (every address of To and Cc, the text, the files). Changes nothing. */
export function checkReply(api: ApiClient, record: RecordKey, draft: { addresses: readonly string[]; subject: string; body: string; attachments: readonly string[] }, signal?: AbortSignal): Promise<SendCheck> {
  const subject = draft.subject.trim()
  return api.post(`${threadPath(record)}/emails/check`, {
    body: { to: [...draft.addresses], ...(subject ? { subject } : {}), body: draft.body, attachments: [...draft.attachments] },
    schema: checkSchema,
    signal,
  })
}

const deliveries = z.object({
  messages: z.array(z.object({ messageId: z.string().nullable(), task: z.object({ id: z.string(), status: z.enum(['OPEN', 'DONE', 'CANCELLED']) }).nullable() }).passthrough()),
})

/** GET /email/delivery-status: each mail's delivery and the task its bounce made (office only; never an address). */
export function readDeliveries(api: ApiClient, record: RecordKey, signal?: AbortSignal): Promise<z.infer<typeof deliveries>> {
  return api.get('/email/delivery-status', { query: { recordType: record.type, recordId: record.id }, schema: deliveries, signal })
}

const party = z.object({ party: z.object({ id: z.string(), contacts: z.array(z.object({ name: z.string(), email: z.string().nullable(), status: z.string() }).passthrough()).default([]) }).passthrough() })

/** GET /parties/<id>: the record's customer's active contacts with an address (To's suggestions, W21). */
export async function readContacts(api: ApiClient, partyId: string, signal?: AbortSignal): Promise<Array<{ name: string; email: string }>> {
  const answer = await api.get(`/parties/${enc(partyId)}`, { schema: party, signal })
  return answer.party.contacts.flatMap((contact) => (contact.email && contact.status === 'ACTIVE' ? [{ name: contact.name, email: contact.email }] : []))
}

const fileAnswer = z.object({ file: z.object({ id: z.string(), version: z.number().int(), visibility: z.array(z.string()) }).passthrough() })

/**
 * PUT /files/<id>/visibility: share a file of the record with its customer ("Share with <customer>", files.manage). The API shares
 * a file only with its own record's customer (B-TH-003) and records who did it.
 */
export async function shareWithParty(api: ApiClient, file: { id: string; version: number; visibility: readonly string[] }, partyId: string): Promise<void> {
  const visibility = [...new Set(['OFFICE', ...file.visibility, 'PARTNER'])]
  await api.request('PUT', `/files/${enc(file.id)}/visibility`, { body: { visibility, partyId, version: file.version }, schema: fileAnswer, idempotencyKey: globalThis.crypto.randomUUID() })
}

// ---- B-TH-300: the Files view's bulk work (the API checks each file's record and right again) ----

/** PUT /files/<id>/visibility to the office only ("Make office only", files.manage): no customer, floor or link sees it any more. */
export async function officeOnly(api: ApiClient, file: { id: string; version: number }): Promise<void> {
  await api.request('PUT', `/files/${enc(file.id)}/visibility`, { body: { visibility: ['OFFICE'], partyId: null, version: file.version }, schema: fileAnswer, idempotencyKey: globalThis.crypto.randomUUID() })
}

/** DELETE /files/<id> ("Delete", files.delete): a legal hold refuses it in the API too. */
export async function removeFile(api: ApiClient, file: { id: string; version: number }): Promise<void> {
  await api.request('DELETE', `/files/${enc(file.id)}`, { query: { version: file.version }, schema: fileAnswer })
}

// ---- B-TH-231: carry a file to another record (B-TH-024) and the records it may go to (same customer or none) ----
const targetsAnswer = z.object({
  tooShort: z.boolean(),
  targets: z.array(z.object({ recordType: z.string(), recordId: z.string(), number: z.string().nullable(), title: z.string(), subtitle: z.string().nullable(), area: z.string(), partyId: z.string().nullable() })),
})

/** GET /files/<id>/use-on/targets?q=: the records of the file's customer, or of none, the person may add files to. */
export function readUseOnTargets(api: ApiClient, fileId: string, q: string, signal?: AbortSignal): Promise<z.infer<typeof targetsAnswer>> {
  return api.get(`/files/${enc(fileId)}/use-on/targets`, { query: { q }, schema: targetsAnswer, signal })
}

/**
 * POST /files/<id>/use-on: a copy onto the chosen record (kind and category kept, naming its source); the office only, or also
 * the target's own customer (files.manage). The caller's key: "Retry" after a lost answer never copies twice.
 */
export async function useFileOn(api: ApiClient, fileId: string, target: { recordType: string; recordId: string; share: boolean }, idempotencyKey: string): Promise<{ id: string }> {
  const answer = await api.post(`/files/${enc(fileId)}/use-on`, {
    body: { recordType: target.recordType, recordId: target.recordId, visibility: target.share ? ['OFFICE', 'PARTNER'] : ['OFFICE'] },
    schema: z.object({ file: z.object({ id: z.string() }).passthrough() }),
    idempotencyKey,
  })
  return { id: answer.file.id }
}
// ---- end B-TH-231

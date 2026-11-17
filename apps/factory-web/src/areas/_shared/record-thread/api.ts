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

const page = z.object({ thread: threadSchema.nullable(), messages: z.array(messageSchema), nextCursor: z.string().nullable(), reading: readingSchema.nullable().optional(), head: headSchema.optional() })
export type ThreadPageAnswer = z.infer<typeof page>

export function readThreadPage(api: ApiClient, record: RecordKey, cursor: string | null, signal?: AbortSignal): Promise<ThreadPageAnswer> {
  return api.get(threadPath(record), { query: { cursor: cursor ?? undefined, limit: THREAD_PAGE }, schema: page, signal })
}

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
const sent = z.object({ messageId: z.string() }).passthrough()

/** POST …/notes with the caller's key: an Office note (never reaches a customer; a work order's may go to the floor). */
export async function postNoteKeyed(api: ApiClient, record: RecordKey, input: { body: string; mentions: readonly string[]; attachments: readonly string[]; forFloor: boolean }, idempotencyKey: string): Promise<string> {
  const answer = await api.post(`${threadPath(record)}/notes`, {
    body: { body: input.body, mentions: [...input.mentions], attachments: [...input.attachments], ...(input.forFloor ? { forFloor: true } : {}) },
    schema: posted,
    idempotencyKey,
  })
  return answer.message.id
}

/** POST …/emails with the caller's key: the reply to the record's customer, To and Cc apart, with the recorded tick when given. */
export async function sendReplyKeyed(
  api: ApiClient,
  record: RecordKey,
  body: { to: string[]; cc?: string[]; subject?: string; body: string; attachments: string[]; sendOutside?: true },
  idempotencyKey: string,
): Promise<string> {
  const answer = await api.post(`${threadPath(record)}/emails`, { body, schema: sent, idempotencyKey })
  return answer.messageId
}

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

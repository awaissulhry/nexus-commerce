import { z } from 'zod'
import type { ReplyRecordType } from '@nexus/factory-domain/templates/replies'
import { newIdempotencyKey, type ApiClient } from '../../../../../lib/api/client'
import { replySchema, type SavedReply } from '../../../../_shared/document-send/template/api'

/**
 * B-TH-279 — Admin › Documents › E-mail templates › Saved replies: the calls of the view that keeps them (B-W2b-422's saved replies;
 * B-TH-046 added the requests of Sales › Incoming). The send panel and the thread only pick and fill them
 * (`_shared/document-send/template/api.ts`); this view lists, writes, changes and deletes. Mirrors apps/factory-api
 * platform/templates contract.ts (listRepliesContract …). Nothing here sends a mail.
 *
 *   GET    /templates/replies?companyId&language&recordType   the reader's own and the shared ones they may use (email.send)
 *   POST   /templates/replies                                 a new one: own, or shared (email.replies.share)
 *   PUT    /templates/replies/:id                             change it at the version read (its owner; shared: email.replies.share)
 *   DELETE /templates/replies/:id?version                     delete it at the version read
 */

export type { SavedReply }

const listAnswer = z.object({ replies: z.array(replySchema), placeholders: z.record(z.string(), z.array(z.string())), mayShare: z.boolean() })
export type SavedRepliesAnswer = z.infer<typeof listAnswer>
const one = z.object({ reply: replySchema })

const path = (replyId: string) => `/templates/replies/${encodeURIComponent(replyId)}`

/** Every saved reply the reader keeps or may use for a company (its own and every company's), any language and record. */
export const listSavedReplies = (api: ApiClient, query: { companyId?: string | null; language?: 'it' | 'en' | null; recordType?: ReplyRecordType | null } = {}, signal?: AbortSignal) =>
  api.get('/templates/replies', { query: { companyId: query.companyId ?? undefined, language: query.language ?? undefined, recordType: query.recordType ?? undefined }, schema: listAnswer, signal })

export interface SavedReplyBody {
  name: string
  language: 'it' | 'en'
  body: string
  recordType: ReplyRecordType | null
  companyId: string | null
}

export const createSavedReply = (api: ApiClient, body: SavedReplyBody & { shared: boolean }, idempotencyKey: string = newIdempotencyKey()) =>
  api.post('/templates/replies', { body, idempotencyKey, schema: one }).then((answer) => answer.reply)

export const updateSavedReply = (api: ApiClient, reply: Pick<SavedReply, 'id' | 'version'>, body: Partial<SavedReplyBody>, idempotencyKey: string = newIdempotencyKey()) =>
  api.request('PUT', path(reply.id), { body: { version: reply.version, ...body }, idempotencyKey, schema: one }).then((answer) => answer.reply)

export const deleteSavedReply = (api: ApiClient, reply: Pick<SavedReply, 'id' | 'version'>, idempotencyKey: string = newIdempotencyKey()) =>
  api.request('DELETE', path(reply.id), { query: { version: reply.version }, idempotencyKey, schema: z.object({ deleted: z.string() }) }).then((answer) => answer.deleted)

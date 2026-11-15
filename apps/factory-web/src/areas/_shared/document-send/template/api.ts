import { z } from 'zod'
import { REPLY_RECORD_TYPES } from '@nexus/factory-domain/templates/replies'
import { TEMPLATE_LANGUAGES } from '@nexus/factory-domain/templates/language'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * The send panel's message templates (B-W2b-432 on B-W2b-422's saved replies; COL-016): the reader's own and the shared
 * ones of a language for a record type (with those for any record), and one filled with the record's values (`POST …/fill`:
 * only returned — the person reads and changes it before sending). email.send. Mirrors platform/templates/contract.ts.
 */

export type ReplyRecordType = (typeof REPLY_RECORD_TYPES)[number]

export const replySchema = z.object({
  id: z.string(),
  companyId: z.string().nullable(),
  name: z.string(),
  language: z.string(),
  body: z.string(),
  recordType: z.string().nullable(),
  shared: z.boolean(),
  owner: z.object({ id: z.string(), name: z.string() }).nullable(),
  mayChange: z.boolean(),
  updatedAt: z.string(),
  version: z.number(),
})
export type SavedReply = z.infer<typeof replySchema>

const listAnswer = z.object({ replies: z.array(replySchema), placeholders: z.record(z.string(), z.array(z.string())), mayShare: z.boolean() })
const fillAnswer = z.object({ body: z.string(), language: z.enum(TEMPLATE_LANGUAGES), missing: z.array(z.string()) })
export type FilledReply = z.infer<typeof fillAnswer>

export const listReplies = (api: ApiClient, query: { language: 'it' | 'en'; recordType: ReplyRecordType; companyId?: string | null }, signal?: AbortSignal) =>
  api.get('/templates/replies', { query: { language: query.language, recordType: query.recordType, companyId: query.companyId ?? undefined }, schema: listAnswer, signal }).then((answer) => answer.replies)

export const fillReply = (api: ApiClient, replyId: string, body: { recordType: ReplyRecordType; recordId: string; contactId?: string | null }) =>
  api.post(`/templates/replies/${encodeURIComponent(replyId)}/fill`, { body: { recordType: body.recordType, recordId: body.recordId, ...(body.contactId ? { contactId: body.contactId } : {}) }, schema: fillAnswer })

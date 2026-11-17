import { z } from 'zod'
import { REPLY_AUDIENCES, REPLY_RECORD_TYPES } from '@nexus/factory-domain/templates/replies'
import { MESSAGE_LANGUAGES, type MessageLanguage } from '@nexus/factory-domain/templates/message-languages'
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
// B-TH-098 web half (th-backend-g step 3): a reply is written in any of the five message languages (it, en, de, fr, es).
// th-backend-g step 1 (§0.5): who the text was filled for, and the record numbers it names in both forms (office, customer's own).
const numberPair = z.object({ placeholder: z.string(), office: z.string(), customer: z.string().nullable() })
const fillAnswer = z.object({ body: z.string(), language: z.enum(MESSAGE_LANGUAGES), missing: z.array(z.string()), audience: z.enum(REPLY_AUDIENCES).optional(), numbers: z.array(numberPair).optional() })
export type FilledReply = z.infer<typeof fillAnswer>
export type ReplyAudience = (typeof REPLY_AUDIENCES)[number]

/** The replies of a language for a record type (with those for any record); no language: every language's (th-backend-g step 3). */
export const listReplies = (api: ApiClient, query: { language?: MessageLanguage; recordType: ReplyRecordType; companyId?: string | null }, signal?: AbortSignal) =>
  api.get('/templates/replies', { query: { language: query.language, recordType: query.recordType, companyId: query.companyId ?? undefined }, schema: listAnswer, signal }).then((answer) => answer.replies)

/** th-backend-g step 1: `audience` OFFICE for an office note (the office's numbers); else the customer's own numbers (the default). */
export const fillReply = (api: ApiClient, replyId: string, body: { recordType: ReplyRecordType; recordId: string; contactId?: string | null; audience?: ReplyAudience }) =>
  api.post(`/templates/replies/${encodeURIComponent(replyId)}/fill`, { body: { recordType: body.recordType, recordId: body.recordId, ...(body.contactId ? { contactId: body.contactId } : {}), ...(body.audience ? { audience: body.audience } : {}) }, schema: fillAnswer })

// ---- th-backend-g step 2 (B-TH-279: the new mail templates are read) --------------------------------------------------------------
/**
 * A mail's starting words for a record (POST /templates/mail/events/:event/fill): the company's template in use in the recipient's
 * language, else the code's words — the dialogs' "Ask for info" (request.need_info) and "Decline" (request.declined) start from them.
 * Only returned: the person reads, writes the question or the reason where "…" stands, and sends. A German, French or Spanish text
 * by Claude not read yet comes in English (`fellBack`, `words` say why). Mirrors platform/templates/contract.ts fillMailEventContract.
 */
const mailFillAnswer = z.object({
  subject: z.string(),
  body: z.string(),
  language: z.enum(MESSAGE_LANGUAGES),
  source: z.enum(['TEMPLATE', 'CODE']),
  read: z.boolean(),
  fellBack: z.boolean(),
  words: z.object({ it: z.string(), en: z.string() }).nullable(),
  missing: z.array(z.string()),
})
export type MailStart = z.infer<typeof mailFillAnswer>
export type StartEvent = 'request.need_info' | 'request.declined'

export const fillMailEvent = (api: ApiClient, event: StartEvent, body: { recordType: ReplyRecordType; recordId: string }, signal?: AbortSignal) =>
  api.post(`/templates/mail/events/${encodeURIComponent(event)}/fill`, { body: { recordType: body.recordType, recordId: body.recordId }, schema: mailFillAnswer, signal })
// ---- end th-backend-g step 2

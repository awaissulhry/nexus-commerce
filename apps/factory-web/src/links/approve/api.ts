import { z } from 'zod'
import { APPROVAL_KINDS, APPROVAL_STATUSES } from '@nexus/factory-domain/approvals-out/kinds'
import { newIdempotencyKey, type ApiClient } from '../../lib/api/client'
import { previewLink } from '../../record-panels/files/api'
import { readFromStore } from '../../record-panels/store'

/**
 * The partner's approval link (apps/factory-api platform/approvals-out, B-W2b-184; APPROVAL on an ApprovalRequest;
 * COL-064, SAL-222, SAL-294, QHS-085): what we ask (`GET /link/approval`: the request, the kind's own facts in the
 * reader's language, a revised order line by line old → new with the party's OWN prices under the link's price grain,
 * the request's files, what may be answered and why not), and the one answer — approve, approve with changes, refuse —
 * signed with a typed name, with an optional markup on one of the request's photos (an overlay: nothing is uploaded).
 * Reading uses nothing; the answer uses the link's one use, so the page shows the end from the answer it gets back.
 * The token travels only in `x-factory-link` (the client the link landing made); never in an address or in storage.
 */

export const LINK_KINDS = APPROVAL_KINDS
export const LINK_STATUSES = APPROVAL_STATUSES

const fileSchema = z.object({ id: z.string(), originalName: z.string(), contentType: z.string(), sizeBytes: z.number() })
export type ApprovalFile = z.infer<typeof fileSchema>

const lineSchema = z.object({
  change: z.enum(['ADDED', 'REMOVED', 'CHANGED']).catch('CHANGED'),
  lineId: z.string(),
  seq: z.number(),
  style: z.object({ code: z.string(), name: z.string() }),
  colour: z.object({ code: z.string(), name: z.string() }),
  piecesBefore: z.number(),
  piecesAfter: z.number(),
  sizes: z.array(z.object({ size: z.string(), before: z.number(), after: z.number() })),
  priceChanged: z.boolean(),
})
export type RevisedLine = z.infer<typeof lineSchema>

/** Amounts in minor units (cents); the money fields come only with the link's price grain (a revised order of the party's own). */
const revisedOrderSchema = z.object({
  orderNumber: z.string(),
  revision: z.number(),
  reason: z.string(),
  currency: z.string(),
  lines: z.array(lineSchema),
  header: z.array(z.object({ field: z.enum(['customerRef', 'requestedDate']), before: z.string().nullable(), after: z.string().nullable() })),
  prices: z.array(z.object({ lineId: z.string(), unitPrice: z.object({ before: z.string().nullable(), after: z.string().nullable() }).nullable(), netBefore: z.number(), netAfter: z.number() })).optional(),
  netAmountBefore: z.number().optional(),
  netAmountAfter: z.number().optional(),
  grossAmountBefore: z.number().optional(),
  grossAmountAfter: z.number().optional(),
})
export type RevisedOrder = z.infer<typeof revisedOrderSchema>

export const approvalPageSchema = z.object({
  request: z.object({
    id: z.string(),
    kind: z.enum(APPROVAL_KINDS),
    kindName: z.string(),
    label: z.string(),
    question: z.string(),
    from: z.object({ companyName: z.string() }),
    dueAt: z.string(),
    dueWords: z.string(),
    status: z.enum(APPROVAL_STATUSES),
    stateWords: z.string(),
    decided: z.string().nullable(),
    answer: z.object({ at: z.string(), typedName: z.string(), words: z.string().nullable(), markupFileId: z.string().nullable() }).nullable(),
    version: z.number(),
  }),
  content: z.object({ facts: z.array(z.object({ label: z.string(), value: z.string() })), revisedOrder: revisedOrderSchema.nullable() }),
  files: z.array(fileSchema),
  may: z.object({ answer: z.boolean(), withChanges: z.boolean(), held: z.string().nullable() }),
  locale: z.enum(['it', 'en']),
  link: z.object({ expiresAt: z.string(), usesLeft: z.number() }).optional(),
  /** After an answer: how the receipt mail went (null: none to send). */
  receipt: z.enum(['SENT', 'FAILED', 'QUEUED']).nullable().optional(),
})
export type ApprovalPage = z.infer<typeof approvalPageSchema>

export type LinkDecision = 'APPROVED' | 'APPROVED_WITH_CHANGES' | 'REFUSED'

/** One markup on one of the request's files (an overlay; a PDF names its page). */
export interface MarkupBody {
  fileId: string
  page: number | null
  shapes: ReadonlyArray<{ kind: 'arrow'; from: { x: number; y: number }; to: { x: number; y: number } } | { kind: 'circle'; center: { x: number; y: number }; radius: number }>
  note: string | null
}

export interface AnswerBody {
  decision: LinkDecision
  answer: string | null
  typedName: string
  markup: MarkupBody | null
}

/** `GET /link/approval?language=` — the page in the reader's language. */
export function readLinkApproval(api: ApiClient, language: 'it' | 'en', signal?: AbortSignal): Promise<ApprovalPage> {
  return api.get('/link/approval', { query: { language }, schema: approvalPageSchema, signal })
}

/**
 * The answer (`POST /link/approval/approve` or `…/refuse`): the page comes back with the end (`request.decided`) and how
 * the receipt went. One answer per request: the link opens nothing afterwards.
 */
export function answerLinkApproval(api: ApiClient, body: AnswerBody, language: 'it' | 'en'): Promise<ApprovalPage> {
  const markup = body.markup ? { fileId: body.markup.fileId, page: body.markup.page, shapes: body.markup.shapes.map((shape) => ({ ...shape })), note: body.markup.note } : null
  if (body.decision === 'REFUSED') {
    return api.post('/link/approval/refuse', { query: { language }, body: { answer: body.answer, typedName: body.typedName, markup }, schema: approvalPageSchema, idempotencyKey: newIdempotencyKey() })
  }
  return api.post('/link/approval/approve', { query: { language }, body: { decision: body.decision, answer: body.answer, typedName: body.typedName, markup }, schema: approvalPageSchema, idempotencyKey: newIdempotencyKey() })
}

/** One of the request's files as the link may read it (the generic files route, presigned for 60 s, read once). */
export async function linkFileBytes(api: ApiClient, fileId: string): Promise<Uint8Array> {
  const { preview } = await previewLink(api, fileId)
  return readFromStore({ method: 'GET', url: preview.url, headers: preview.headers, expiresAt: preview.expiresAt })
}

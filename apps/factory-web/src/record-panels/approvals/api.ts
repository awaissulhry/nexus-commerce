import { z } from 'zod'
import { APPROVAL_KINDS, APPROVAL_STATUSES, type ApprovalKind } from '@nexus/factory-domain/approvals-out/kinds'
import { newIdempotencyKey, type ApiClient } from '../../lib/api/client'
import type { RecordKey } from '../api'

/**
 * "Ask a partner to approve" from a record (apps/factory-api platform/approvals-out office.ts, B-W2b-184; COL-064): the
 * record's requests (`GET /approvals-out?recordType&recordId`: the kinds it takes, why it may not be asked now, each
 * request with its state, answer, markup and links), the ask (`POST /approvals-out`: ONE command makes the request, its
 * APPROVAL link and the partner's task; `send` mails the link, else the API gives the link ONCE to pass on), and the
 * withdraw (`POST /approvals-out/:id/withdraw {version}`). Office only: partners.approvals.view / .ask plus the record's own
 * permission (the API checks both). No money here: only a revised order's link page shows the party its own prices.
 */

const words = z.object({ it: z.string(), en: z.string() })

export const officeRequestSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  kind: z.enum(APPROVAL_KINDS),
  /** B-W2b-F16: the record's label in both languages; the kind, state and due are shown in our words from the codes. */
  record: z.object({ type: z.string(), id: z.string(), words }),
  party: z.object({ id: z.string(), name: z.string() }),
  contactId: z.string().nullable(),
  question: z.string(),
  dueAt: z.string(),
  status: z.enum(APPROVAL_STATUSES),
  answer: z
    .object({
      at: z.string(),
      typedName: z.string(),
      words: z.string().nullable(),
      via: z.enum(['LINK', 'PORTAL']),
      personName: z.string().nullable(),
      markup: z.object({ fileId: z.string(), page: z.number().nullable(), shapes: z.array(z.unknown()), note: z.string().nullable() }).nullable(),
    })
    .nullable(),
  withdrawn: z.object({ at: z.string(), byName: z.string().nullable(), reason: z.string().nullable() }).nullable(),
  askedBy: z.string().nullable(),
  createdAt: z.string(),
  files: z.array(z.object({ id: z.string(), originalName: z.string(), contentType: z.string(), sizeBytes: z.number() })),
  links: z.array(z.object({ id: z.string(), email: z.string().nullable(), expiresAt: z.string(), used: z.boolean(), revoked: z.boolean(), lastUsedAt: z.string().nullable() })),
  may: z.object({ withdraw: z.boolean() }),
  version: z.number(),
})
export type OfficeRequest = z.infer<typeof officeRequestSchema>

export const recordRequestsSchema = z.object({
  record: z.object({ type: z.string(), id: z.string(), words }),
  kinds: z.array(z.enum(APPROVAL_KINDS)),
  held: z.string().nullable(),
  requests: z.array(officeRequestSchema),
})
export type RecordRequests = z.infer<typeof recordRequestsSchema>

export const askAnswerSchema = z.object({ request: officeRequestSchema, url: z.string().nullable(), delivery: z.enum(['SENT', 'FAILED', 'QUEUED']).nullable() })
export type AskAnswer = z.infer<typeof askAnswerSchema>

export interface AskBody {
  kind: ApprovalKind
  recordType: string
  recordId: string
  question: string
  dueAt: string
  fileIds: string[]
  send: boolean
  email?: string
  language?: 'it' | 'en'
}

export function readRecordRequests(api: ApiClient, record: RecordKey, signal?: AbortSignal): Promise<RecordRequests> {
  return api.get('/approvals-out', { query: { recordType: record.type, recordId: record.id }, schema: recordRequestsSchema, signal })
}

export function askApproval(api: ApiClient, body: AskBody): Promise<AskAnswer> {
  return api.post('/approvals-out', { body, schema: askAnswerSchema, idempotencyKey: newIdempotencyKey() })
}

export function withdrawApproval(api: ApiClient, requestId: string, version: number, reason: string | null): Promise<{ request: OfficeRequest }> {
  return api.post(`/approvals-out/${encodeURIComponent(requestId)}/withdraw`, { body: { version, reason }, schema: z.object({ request: officeRequestSchema }), idempotencyKey: newIdempotencyKey() })
}

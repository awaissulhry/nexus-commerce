import { z } from 'zod'
import { APPROVAL_KINDS, APPROVAL_STATUSES } from '@nexus/factory-domain/approvals-out/kinds'
import type { ApiClient } from '../../../lib/api/client'

/**
 * F-PR-14 — what Waiting for you reads (production plan §5; 06-tree B.3; wall PW-P05), each answer checked: GET /portal/approvals
 * (B-W2b-184; B-PR-29 `waitingFor`, the named approver's name to the others; F-PR-14 `waitingForBuyer`, a priced counter-offer the
 * reader may not answer) — the session's own party only. The answer itself is the Approve pop-up's (home/api: the request's page,
 * its files, POST …/answer); the payments are the documents' open items (documents/api). The web reads only what it uses.
 */

const words = z.object({ it: z.string(), en: z.string() })

export const waitingApprovalSchema = z.object({
  id: z.string(),
  kind: z.enum(APPROVAL_KINDS),
  /** The record's label in both languages ("PP sample · JK-210", "SO-… · new date"). */
  words,
  question: z.string(),
  dueAt: z.string(),
  status: z.enum(APPROVAL_STATUSES),
  /** B-PR-29: another colleague answers it (the customer's named approver): their name; null: the reader may. */
  waitingFor: z.string().nullable().catch(null),
  /** F-PR-14: a priced counter-offer the reader may not answer: their buyer does (an older answer without it: false). */
  waitingForBuyer: z.boolean().default(false),
})
export type WaitingApproval = z.infer<typeof waitingApprovalSchema>

export const waitingListSchema = z.object({ state: z.enum(['OPEN', 'DONE']), items: z.array(waitingApprovalSchema) })
export type WaitingList = z.infer<typeof waitingListSchema>

/** What we ask the organisation now (OPEN), the soonest due first (the API's order). */
export const fetchWaiting = (api: ApiClient, signal?: AbortSignal): Promise<WaitingList> => api.get('/portal/approvals', { query: { state: 'OPEN' }, schema: waitingListSchema, signal })

// The answer (the request's page, its files, the signed answer) is the Approve pop-up's own: one answering family.
export { answerApproval, approvalFileBytes, fetchApproval, type ApprovalAnswer, type ApprovalRead } from '../home/api'
// The payments that wait: the documents' open items (deposits and invoices; amounts only with the price grain).
export { fetchOpenItems, type OpenItemsRead } from '../documents/api'

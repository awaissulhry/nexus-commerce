import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'

/**
 * The approval history of a record (B-W2b-307 on B-W2b-282's route; PLT-104): `GET /approvals/history/:recordType/:recordId`
 * (approvals.view and the record's own view permission over its place; a type with no history answers 404). Newest first,
 * an offset cursor. People come as {kind, id, name, me}: a floor worker is named only inside one record.
 */

export const APPROVAL_MEANINGS = ['REVIEWED', 'APPROVED', 'RELEASED', 'VERIFIED'] as const
export type ApprovalMeaning = (typeof APPROVAL_MEANINGS)[number]
export const HISTORY_ACTIONS = ['REQUESTED', 'COMMENTED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'STALE', 'SIGNED'] as const
export type HistoryAction = (typeof HISTORY_ACTIONS)[number]

export const historyLineSchema = z.object({
  id: z.string(),
  source: z.string(),
  action: z.enum(HISTORY_ACTIONS),
  at: z.string(),
  by: z.object({ kind: z.enum(['PERSON', 'WORKER', 'SYSTEM']), id: z.string().nullable(), name: z.string(), me: z.boolean() }),
  words: z.string().nullable(),
  reasonCode: z.string().nullable(),
  meaning: z.enum(APPROVAL_MEANINGS).nullable(),
  taskId: z.string().nullable(),
})
export type HistoryLine = z.infer<typeof historyLineSchema>

const historySchema = z.object({ record: z.object({ type: z.string(), id: z.string() }), lines: z.array(historyLineSchema), nextCursor: z.string().nullable() })
export type HistoryAnswer = z.infer<typeof historySchema>

export async function fetchHistory(api: ApiClient, record: { readonly type: string; readonly id: string }, cursor: string | null, signal?: AbortSignal): Promise<HistoryAnswer> {
  return api.get(`/approvals/history/${encodeURIComponent(record.type)}/${encodeURIComponent(record.id)}`, { query: { cursor: cursor ?? undefined, limit: 50 }, schema: historySchema, signal })
}

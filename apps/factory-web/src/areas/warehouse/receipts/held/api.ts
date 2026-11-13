import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'
import { taskRowSchema } from '../../../home/approvals/api'
import { receiptSchema, recordedSchema, type Recorded, type Receipt } from '../api'
import type { HeldRequests } from './model'

/**
 * The calls of a receipt that waits for a yes (B-W2b-382 on B-W2b-377's routes): Post once every line has its yes
 * (`POST /inventory/receipts/:id/post`, inventory.receive: 201 as a recorded receipt; a held line 409 in words), Cancel
 * (`POST …/cancel {reason}`: the OPEN receipt CANCELLED, its requests withdrawn) and its lines' requests
 * (`GET /approvals/tasks?recordType=GoodsReceiptLine&recordId=…&status=ALL`, approvals.view: the reader's visible ones).
 */

export const postHeldReceipt = (api: ApiClient, receiptId: string, idempotencyKey: string): Promise<Recorded> =>
  api.post(`/inventory/receipts/${encodeURIComponent(receiptId)}/post`, { body: {}, schema: recordedSchema, idempotencyKey })

export const cancelHeldReceipt = (api: ApiClient, receiptId: string, reason: string, idempotencyKey: string): Promise<Receipt> =>
  api.post(`/inventory/receipts/${encodeURIComponent(receiptId)}/cancel`, { body: { reason }, schema: z.object({ receipt: receiptSchema }), idempotencyKey }).then((answer) => answer.receipt)

const tasksSchema = z.object({ rows: z.array(taskRowSchema) })

/** The newest request of each held line the reader may see (a line with none seen is left out). */
export async function heldRequests(api: ApiClient, lineIds: readonly string[], signal?: AbortSignal): Promise<HeldRequests> {
  const pairs = await Promise.all(
    lineIds.map(async (lineId) => {
      const answer = await api.get('/approvals/tasks', { query: { recordType: 'GoodsReceiptLine', recordId: lineId, kind: 'RECEIPT_OVER_TOLERANCE', status: 'ALL', limit: 5 }, schema: tasksSchema, signal })
      const newest = [...answer.rows].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0]
      return newest ? ([lineId, { id: newest.id, status: newest.status, approver: newest.approver, decidedAt: newest.decidedAt }] as const) : null
    }),
  )
  return Object.fromEntries(pairs.filter((pair): pair is NonNullable<typeof pair> => pair !== null))
}

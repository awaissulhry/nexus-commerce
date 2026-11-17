import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'

/**
 * B-TH-274 (P-ANY.summary; back end B-TH-076): one summary row for any record the person opens in the portal —
 * GET /records/:type/:id/summary through the record type's partner view only (another customer's record, a type the portal does
 * not show, a record not yet sent: 404 in neutral words). Its type in words, its label (our number, else their reference: a
 * customer's own number for an order, a request or a quote — never the office's series), their own reference, the state in words
 * and the record it belongs to, only when the person opens that one too.
 */

const words = z.object({ it: z.string(), en: z.string() })

export const recordSummarySchema = z.object({
  summary: z.object({
    recordType: z.string(),
    recordId: z.string(),
    type: words,
    label: z.string().nullable(),
    theirRef: z.string().nullable(),
    state: z.object({ code: z.string(), words }).nullable(),
    parent: z.object({ recordType: z.string(), recordId: z.string(), type: words, label: z.string().nullable() }).nullable(),
  }),
})
export type RecordSummary = z.infer<typeof recordSummarySchema>['summary']

export const fetchRecordSummary = (api: ApiClient, type: string, id: string, signal?: AbortSignal) =>
  api.get(`/records/${encodeURIComponent(type)}/${encodeURIComponent(id)}/summary`, { schema: recordSummarySchema, signal })

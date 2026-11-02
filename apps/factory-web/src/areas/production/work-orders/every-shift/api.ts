import { z } from 'zod'
import { BULK_REFUSALS, type BulkApplyRow } from '@nexus/factory-domain/views/bulk/rules'
import type { ApiClient } from '../../../../lib/api/client'
import { workOrderSchema, type WorkOrder } from '../../_shared/api'

/**
 * The calls of the work order every shift (B-W2b-59, on B-W2b-51's API): Release N through the list frame's bulk target
 * `production.work-orders.release` (the preview names what holds each row: the frame's own schema drops `reasons`), the
 * split's preview and the split, the travellers as PDF bytes (the company header goes with them). No money, no person.
 */

const RELEASE_TARGET = 'production.work-orders.release'
const bulkValue = z.union([z.string(), z.number(), z.null()])
const refusal = z.object({ code: z.enum(BULK_REFUSALS), field: z.string().nullable().optional(), status: z.string().nullable().optional(), reasons: z.array(z.string()).optional() })
const previewSchema = z.object({
  rows: z.array(z.object({ id: z.string(), label: z.string(), version: z.number(), changes: z.array(z.object({ field: z.string(), now: bulkValue, next: bulkValue })), refusal: refusal.nullable() })),
})
export type ReleasePreviewRow = z.infer<typeof previewSchema>['rows'][number]
const applySchema = z.object({ results: z.array(z.object({ id: z.string(), label: z.string(), ok: z.boolean(), refusal: refusal.nullable(), version: z.number() })) })
export type ReleaseResultRow = z.infer<typeof applySchema>['results'][number]

export async function previewRelease(api: ApiClient, ids: readonly string[]): Promise<ReleasePreviewRow[]> {
  return (await api.post('/views/bulk/preview', { body: { listKey: RELEASE_TARGET, ids, changes: { status: 'RELEASED' } }, schema: previewSchema })).rows
}

export async function applyRelease(api: ApiClient, rows: readonly BulkApplyRow[], idempotencyKey: string): Promise<ReleaseResultRow[]> {
  return (await api.post('/views/bulk/apply', { body: { listKey: RELEASE_TARGET, rows }, idempotencyKey, schema: applySchema })).results
}

// ---- split ----------------------------------------------------------------------------------------------------------------

const splitSide = z.object({
  pieces: z.number(),
  cells: z.array(z.object({ fromCellId: z.string(), colourwayCode: z.string(), size: z.string(), quantity: z.number() })),
  materials: z.array(z.object({ itemId: z.string(), itemCode: z.string(), itemName: z.string(), itemColourId: z.string().nullable(), colourCode: z.string().nullable(), baseUom: z.string(), planned: z.string() })),
})
const splitPreviewSchema = z.object({
  refusal: z.string().nullable(),
  problems: z.array(z.object({ path: z.string(), message: z.string() })),
  numberPreview: z.string().nullable(),
  parent: splitSide.nullable(),
  child: splitSide.nullable(),
})
export type SplitPreview = z.infer<typeof splitPreviewSchema>
export type SplitAsk = { cellId: string; quantity: number }

export const previewSplit = (api: ApiClient, id: string, cells: readonly SplitAsk[], signal?: AbortSignal): Promise<SplitPreview> =>
  api.post(`/production/work-orders/${encodeURIComponent(id)}/split/preview`, { body: { cells }, schema: splitPreviewSchema, signal })

export interface SplitBody {
  version: number
  cells: readonly SplitAsk[]
  dueDate: string | null
  priority: number
  rush: boolean
  note: string | null
}

export async function splitWorkOrder(api: ApiClient, id: string, body: SplitBody, idempotencyKey: string): Promise<{ workOrder: WorkOrder; parent: WorkOrder }> {
  return api.post(`/production/work-orders/${encodeURIComponent(id)}/split`, { body, schema: z.object({ workOrder: workOrderSchema, parent: workOrderSchema }), idempotencyKey })
}

// ---- the traveller ------------------------------------------------------------------------------------------------------------

/** One work order's traveller, or several in one PDF in the order asked (workorders.view; stored nowhere). */
export function travellerPdf(api: ApiClient, ids: readonly string[], language: 'it' | 'en', signal?: AbortSignal): Promise<Uint8Array> {
  if (ids.length === 1) return api.bytes(`/production/work-orders/${encodeURIComponent(ids[0]!)}/traveller`, { query: { language }, signal })
  return api.bytes('/production/work-orders/travellers', { query: { ids: ids.join(','), language }, signal })
}

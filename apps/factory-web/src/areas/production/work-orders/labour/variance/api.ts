import { z } from 'zod'
import type { ApiClient } from '../../../../../lib/api/client'
import { closeRecordSchema, varianceLineSchema } from '../../close/api'

/**
 * B-W2b-424 — the variance at close on the work order's Labour & cost tab (design production.workorders rec:labour wo-cost
 * "W2b variance at close (MES-012)") on B-W2b-411's GET /costing/work-orders/:id/close (costing.view): every close of the
 * work order, newest first, with its variance lines, its closing entry and how many VARIANCE and CLOSE entries it wrote.
 * Every amount is the cost grain (absent without it). The entries are counted only: their amounts are in the cost ledger.
 */

const closesSchema = z.object({
  workOrder: z.object({ id: z.string(), number: z.string(), status: z.string() }),
  currency: z.string(),
  closes: z.array(
    closeRecordSchema.extend({
      lines: z.array(varianceLineSchema),
      closing: z.number().nullable().optional(),
      entries: z.array(z.object({ id: z.string(), reversalOfId: z.string().nullable() })),
    }),
  ),
})
export type WorkOrderCloses = z.infer<typeof closesSchema>
export type StoredClose = WorkOrderCloses['closes'][number]

export const getWorkOrderCloses = (api: ApiClient, workOrderId: string, signal?: AbortSignal): Promise<WorkOrderCloses> =>
  api.get(`/costing/work-orders/${encodeURIComponent(workOrderId)}/close`, { schema: closesSchema, signal })

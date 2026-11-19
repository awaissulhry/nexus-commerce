import { z } from 'zod'
import type { ApiClient } from '../../api/client'

/**
 * F-OP-115 (B-OP-024; review R-16) — what cancelling a work order would meet, read before Cancel… (workorders.view): the pieces
 * already cut (a cancel with any is refused in words — "{n} pieces are cut: lower the work order to the cut instead" — so the row
 * offers no outcome to pick), the stock issued to it (it stays on it until returned) and the subcontract orders at a workshop.
 * Another customer's work order answers as an unknown one. Non-strict: a field the API adds later is read past.
 */
const words = z.object({ it: z.string(), en: z.string() })

export const cancelCheckSchema = z.object({
  workOrderId: z.string(),
  number: z.string(),
  status: z.string(),
  version: z.number(),
  /** The machine takes a cancel now and nothing is cut. */
  cancellable: z.boolean(),
  /** Why a cancel is refused for what is cut (null: nothing cut). */
  refusal: words.nullable(),
  cut: z.object({ pieces: z.number(), cells: z.array(z.object({ cellId: z.string(), size: z.string(), colourwayId: z.string(), quantity: z.number(), cut: z.number() })) }),
  issued: z.array(z.object({ itemId: z.string(), itemColourId: z.string().nullable(), label: z.string(), baseUom: z.string(), quantity: z.string() })),
  atWorkshop: z.array(z.object({ subcontractOrderId: z.string(), number: z.string() })),
})
export type WorkOrderCancelCheck = z.infer<typeof cancelCheckSchema>

export function getWorkOrderCancelCheck(api: ApiClient, workOrderId: string, signal?: AbortSignal): Promise<WorkOrderCancelCheck> {
  return api.get(`/production/work-orders/${encodeURIComponent(workOrderId)}/cancel-check`, { schema: cancelCheckSchema, signal })
}

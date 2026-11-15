import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * Today's flow with its value per stage (B-W2b-435; design home.today `flow` "value per stage (cost) for people with cost rights"):
 * GET /home/flow/value, checked by its schema. The value is cost (absent for a reader without the cost grain).
 */

export const flowValueSchema = z.object({
  asOf: z.string(),
  lens: z.literal('WORK_ORDERS'),
  valued: z.boolean(),
  currency: z.string().nullable(),
  mixedCurrencies: z.boolean(),
  complete: z.boolean(),
  stages: z.array(z.object({ key: z.string(), workOrders: z.number(), value: z.number().nullable().optional() })),
})
export type FlowValue = z.infer<typeof flowValueSchema>

export function getFlowValue(api: ApiClient, scope: { siteId?: string | null }, signal?: AbortSignal): Promise<FlowValue> {
  return api.get('/home/flow/value', { query: scope.siteId ? { siteId: scope.siteId } : {}, schema: flowValueSchema, signal })
}

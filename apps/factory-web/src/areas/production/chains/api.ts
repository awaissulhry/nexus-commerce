import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { departmentSchema } from '../baskets/api'

/**
 * owb-fl9 step 3 — the office's Chains (contract common § 3 "fl4", server B): the chains (a `Line` with its work orders) and one chain's
 * lots × steps, with the slowest step. This web's own zod: what the page draws is required, the rest optional.
 *
 *   GET /production/chains                   → { lines: [{ id, code, name, workOrders }] }
 *   GET /production/chains/:lineId?operationId= → { line, steps: [{ operationId, name, department, waiting, done, slowest }],
 *                                                lots: [{ workOrderSizeId, model, size, perStep: [{ operationId, done, waiting }] }] }
 */

export const linesSchema = z.object({ lines: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), workOrders: z.number().optional() })) })
export type ChainLine = z.infer<typeof linesSchema>['lines'][number]

export const chainSchema = z.object({
  line: z.object({ id: z.string(), code: z.string().optional(), name: z.string() }),
  steps: z.array(z.object({ operationId: z.string(), name: z.string(), department: departmentSchema.nullable().optional(), waiting: z.number(), done: z.number(), slowest: z.boolean() })),
  lots: z.array(
    z.object({
      workOrderSizeId: z.string(),
      model: z.string(),
      size: z.string(),
      /** The lot's pieces (when the server gives them: "done of all"). */
      quantity: z.number().optional(),
      /** One bundle's pieces (the "+12"), when the server gives it. */
      bundleSize: z.number().optional(),
      perStep: z.array(z.object({ operationId: z.string(), done: z.number(), waiting: z.number() })),
    }),
  ),
})
export type Chain = z.infer<typeof chainSchema>
export type ChainLot = Chain['lots'][number]
export type ChainStep = Chain['steps'][number]

export const readLines = (api: ApiClient, signal?: AbortSignal) => api.get('/production/chains', { schema: linesSchema, signal })

export const readChain = (api: ApiClient, lineId: string, operationId?: string | null, signal?: AbortSignal) =>
  api.get(`/production/chains/${encodeURIComponent(lineId)}`, { query: { operationId: operationId ?? undefined }, schema: chainSchema, signal })

import { z } from 'zod'
import type { ApiClient } from '../../../../../lib/api/client'

/**
 * B-W2b-GB02 (G053; B-W2b-424's gap 5) — the scrap and rework cost of one work order on its Labour & cost tab (design
 * production.workorders rec:labour wo-cost) on B-W2b-411's GET /costing/work-orders/:id/scrap-rework (costing.view): per
 * reason, the garments scrapped and their value, the material scrapped from stock for it, the garments reworked with their
 * standard minutes and cost, and the totals. Every amount is the cost grain (absent without it; the rework cost null when no
 * cost per minute is in force). Per work order and reason: never per person. The API's English words are never drawn.
 */

const cost = <T extends z.ZodTypeAny>(schema: T) => schema.optional()

const rowSchema = z.object({
  reasonCode: z.string(),
  scrappedGarments: z.number(),
  scrapValue: cost(z.number()),
  stockScrapValue: cost(z.number()),
  reworkGarments: z.number(),
  reworkMinutes: z.string(),
  reworkCost: cost(z.number().nullable()),
  total: cost(z.number().nullable()),
})
export type ScrapReworkRow = z.infer<typeof rowSchema>

const scrapReworkSchema = z.object({
  workOrder: z.object({ id: z.string(), number: z.string(), status: z.string() }),
  currency: z.string(),
  rows: z.array(rowSchema),
  totals: rowSchema.omit({ reasonCode: true }),
})
export type ScrapRework = z.infer<typeof scrapReworkSchema>

export const getScrapRework = (api: ApiClient, workOrderId: string, signal?: AbortSignal): Promise<ScrapRework> =>
  api.get(`/costing/work-orders/${encodeURIComponent(workOrderId)}/scrap-rework`, { schema: scrapReworkSchema, signal })

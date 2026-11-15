import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * Production › Reports › WIP ageing (B-W2b-435; design production.reports `prr-wip`, ANA-015): the metric layer's WIP drill
 * (GET /insights/kpis/drills/wip of B-W2b-429, the same reader as the KPIs production.wip_pieces and production.wip_age_days),
 * checked by its schema (unknown fields dropped). Garments, work orders and days only here; the value at cost is left out.
 */

export const AGE_BANDS = ['D0_2', 'D3_5', 'D6_10', 'D11_PLUS'] as const
export type AgeBand = (typeof AGE_BANDS)[number]

const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })

export const wipSchema = z.object({
  asOf: z.string(),
  overall: z.object({ workOrders: z.number(), pieces: z.number(), waiting: z.number() }),
  stages: z.array(z.object({ line: ref.nullable(), operation: z.object({ code: z.string(), name: z.string() }), workOrders: z.number(), waiting: z.number(), ageing: z.object({ D0_2: z.number(), D3_5: z.number(), D6_10: z.number(), D11_PLUS: z.number() }) })),
  rows: z.array(
    z.object({
      record: z.object({ type: z.string(), id: z.string(), label: z.string() }),
      line: ref.nullable(),
      waitedDays: z.number(),
      band: z.enum(AGE_BANDS),
      pieces: z.number(),
      stages: z.array(z.object({ code: z.string(), name: z.string(), waiting: z.number() })),
    }),
  ),
  more: z.number(),
})
export type WipAgeing = z.infer<typeof wipSchema>

export function getWipAgeing(api: ApiClient, siteId: string, signal?: AbortSignal): Promise<WipAgeing> {
  return api.get('/insights/kpis/drills/wip', { query: { siteId }, schema: wipSchema, signal })
}

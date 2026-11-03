import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * B-W2b-81 — a work order's off-standard time (`GET /production/offstandard/work-orders/:id/minutes`,
 * production.offstandard.view; apps/factory-api modules/production/offstandard/work-order.ts): minutes per state and per
 * code, never per person; no money. Checked against the fields the card reads.
 */

const minutes = z.number()
const code = z.object({ code: z.string(), labelIt: z.string(), labelEn: z.string(), labelI18n: z.record(z.string(), z.string()) })

export const offStandardSchema = z.object({
  minutes,
  approved: minutes,
  waiting: minutes,
  running: minutes,
  blocks: z.number(),
  codes: z.array(z.object({ code, minutes, blocks: z.number() })),
})
export type OffStandardMinutes = z.infer<typeof offStandardSchema>

export const getOffStandardMinutes = (api: ApiClient, workOrderId: string): Promise<OffStandardMinutes> => api.get(`/production/offstandard/work-orders/${encodeURIComponent(workOrderId)}/minutes`, { schema: offStandardSchema })

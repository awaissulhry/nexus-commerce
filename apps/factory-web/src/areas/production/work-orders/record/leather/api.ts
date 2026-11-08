import { z } from 'zod'
import type { ApiClient } from '../../../../../lib/api/client'

/**
 * The work order's Leather panel (B-W2b-130; SCR-070 Materials, design wo-leather "lot(s) and shade group … W2b one shade lot rule ·
 * hides"; SCM-206): GET /production/cutboard/work-orders/:id/leather, checked by its schema. The shape mirrors apps/factory-api
 * modules/production/cutboard/contract.ts. Counts only: no money, no person.
 */

export const SHADE_RULES = ['ORDER', 'GARMENT', 'OFF'] as const
export const SHADE_VERDICTS = ['NONE', 'ONE', 'MIXED'] as const

const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })
const count = z.object({ held: z.number(), reserved: z.number(), cut: z.number() })

export const workOrderLeatherSchema = z.object({
  workOrder: z.object({ id: z.string(), number: z.string(), status: z.string() }),
  rule: z.enum(SHADE_RULES),
  materials: z.array(
    z.object({
      item: ref.extend({ uom: z.string() }),
      colour: ref.nullable(),
      verdict: z.enum(SHADE_VERDICTS),
      breaksRule: z.boolean(),
      outOfShade: z.boolean(),
      lots: z.array(count.extend({ key: z.string(), lot: z.object({ id: z.string(), code: z.string(), supplierLotRef: z.string().nullable() }), shade: z.string().nullable(), outOfShade: z.boolean() })),
      hides: count,
    }),
  ),
})
export type WorkOrderLeather = z.infer<typeof workOrderLeatherSchema>
export type LeatherMaterial = WorkOrderLeather['materials'][number]

export function getWorkOrderLeather(api: ApiClient, workOrderId: string, signal?: AbortSignal): Promise<WorkOrderLeather> {
  return api.get(`/production/cutboard/work-orders/${encodeURIComponent(workOrderId)}/leather`, { schema: workOrderLeatherSchema, signal })
}

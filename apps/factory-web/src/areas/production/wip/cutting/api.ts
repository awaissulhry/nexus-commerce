import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * Floor now's Cutting room (B-W2b-130; SCR-073 fn-cutting; MES-163): GET /production/cutboard, one site's day, checked by its
 * schema (unknown fields dropped). The shape mirrors apps/factory-api modules/production/cutboard/contract.ts. Garments, counts,
 * areas and lengths only: no money, and nobody who cut (Statuto dei Lavoratori art. 4).
 */

export const CUT_ORDER_KINDS = ['LEATHER', 'FABRIC'] as const
export const CUT_ORDER_STATUSES = ['PLANNED', 'RELEASED', 'IN_PROGRESS', 'CUT', 'RECONCILED', 'CANCELLED'] as const

const site = z.object({ id: z.string(), code: z.string(), name: z.string() })
const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })

export const leatherDaySchema = z.object({
  uom: z.string(),
  hides: z.number(),
  used: z.string(),
  pattern: z.string(),
  unmatched: z.string(),
  yieldPct: z.string().nullable(),
  plannedPct: z.string().nullable(),
  variancePct: z.string().nullable(),
})
export type LeatherDay = z.infer<typeof leatherDaySchema>

export const cutboardSchema = z.object({
  asOf: z.string(),
  site: site.extend({ timeZone: z.string() }),
  sites: z.array(site),
  day: z.string(),
  today: z.string(),
  tiles: z.object({ planned: z.number(), released: z.number(), inProgress: z.number(), late: z.number() }),
  lays: z.object({ atTable: z.number(), waitingFabric: z.number() }),
  plan: z.object({ planned: z.number(), cut: z.number(), cutThatDay: z.number(), pct: z.number().nullable() }),
  cut: z.object({ cutOrders: z.number(), lays: z.number(), leatherPieces: z.number() }),
  hides: z.number(),
  leather: z.array(leatherDaySchema),
  fabric: z.object({ lays: z.number(), confirmed: z.number(), estimated: z.string(), used: z.string(), differencePct: z.string().nullable() }),
  orders: z.array(
    z.object({
      id: z.string(),
      number: z.string(),
      kind: z.enum(CUT_ORDER_KINDS),
      status: z.enum(CUT_ORDER_STATUSES),
      companyId: z.string(),
      siteId: z.string(),
      item: ref,
      colour: ref.nullable(),
      dueDate: z.string().nullable(),
      late: z.boolean(),
      garments: z.number(),
      lays: z.object({ cut: z.number(), of: z.number() }).nullable(),
      workOrders: z.array(z.object({ id: z.string(), number: z.string() })),
    }),
  ),
  more: z.number(),
})
export type Cutboard = z.infer<typeof cutboardSchema>
export type CutboardOrder = Cutboard['orders'][number]

export function getCutboard(api: ApiClient, siteId: string | null, signal?: AbortSignal): Promise<Cutboard> {
  return api.get('/production/cutboard', { query: { siteId: siteId ?? undefined }, schema: cutboardSchema, signal })
}

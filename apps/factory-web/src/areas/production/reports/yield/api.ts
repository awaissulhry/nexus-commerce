import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * Production reports' Cutting and yield (B-W2b-130; SCR-240 prr-yield; MES-302): GET /production/cutboard/yield, checked by its
 * schema (unknown fields dropped). The shape mirrors apps/factory-api modules/production/cutboard/contract.ts. Garments, metres,
 * areas and percentages only: no money, and never by cutter (SCM-255).
 */

const site = z.object({ id: z.string(), code: z.string(), name: z.string() })
const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })
const lot = z.object({ id: z.string(), code: z.string(), supplierLotRef: z.string().nullable() })
const supplier = z.object({ id: z.string(), name: z.string() }).nullable()
const figures = {
  used: z.string(),
  unmatched: z.string(),
  pattern: z.string(),
  remnant: z.string(),
  waste: z.string(),
  wastePct: z.string().nullable(),
  yieldPct: z.string().nullable(),
  plannedPct: z.string().nullable(),
  variancePct: z.string().nullable(),
}

export const cutYieldSchema = z.object({
  asOf: z.string(),
  site: site.extend({ timeZone: z.string() }),
  sites: z.array(site),
  from: z.string(),
  to: z.string(),
  today: z.string(),
  cut: z.object({ orders: z.number(), ordered: z.number(), cut: z.number(), difference: z.number(), pct: z.number().nullable(), waiting: z.number(), variances: z.number() }),
  orders: z.array(
    z.object({
      id: z.string(),
      number: z.string(),
      kind: z.enum(['LEATHER', 'FABRIC']),
      status: z.string(),
      companyId: z.string(),
      siteId: z.string(),
      cutAt: z.string(),
      item: ref,
      colour: ref.nullable(),
      ordered: z.number(),
      cut: z.number().nullable(),
      reconciled: z.boolean(),
    }),
  ),
  more: z.number(),
  fabric: z.object({
    lays: z.number(),
    waiting: z.number(),
    estimated: z.string(),
    used: z.string(),
    differencePct: z.string().nullable(),
    materials: z.array(z.object({ item: ref, colour: ref.nullable(), lays: z.number(), estimated: z.string(), used: z.string(), differencePct: z.string().nullable() })),
  }),
  leather: z.object({
    units: z.array(z.object({ uom: z.string(), hides: z.number(), ...figures })),
    materials: z.array(z.object({ item: ref, colour: ref.nullable(), uom: z.string(), hides: z.number(), ...figures })),
    lots: z.array(z.object({ lot, supplier, item: ref, uom: z.string(), hides: z.number(), ...figures })),
    suppliers: z.array(z.object({ supplier, uom: z.string(), lots: z.number(), hides: z.number(), ...figures })),
  }),
})
export type CutYield = z.infer<typeof cutYieldSchema>
export type YieldLot = CutYield['leather']['lots'][number]
export type YieldSupplier = CutYield['leather']['suppliers'][number]

export function getCutYield(api: ApiClient, query: { siteId?: string | null; from: string | null; to: string | null }, signal?: AbortSignal): Promise<CutYield> {
  return api.get('/production/cutboard/yield', { query: { siteId: query.siteId ?? undefined, from: query.from ?? undefined, to: query.to ?? undefined }, schema: cutYieldSchema, signal })
}

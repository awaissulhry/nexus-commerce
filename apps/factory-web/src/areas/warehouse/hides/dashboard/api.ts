import { z } from 'zod'
import { AREA_UOMS } from '@nexus/factory-domain/inventory/hides/area'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * The leather dashboard's reads (B-W2b-131; SCM-285, design warehouse.hides sec hd-dashboard), each panel its own call so a
 * failed read fails one panel only:
 *   GET /costing/valuation/leather      area on hand per article and colour (B-W2a-29); `value` only with the cost grain
 *                                       (absent, never null, without it: money.cost)
 *   GET /inventory/leather/grade-mix    the grade mix per lot as delivered, what is left, the remnants (B-W2b-94)
 *   GET /inventory/leather/dashboard    what lies at subcontractors and what is on hold (B-W2b-131)
 *   GET /production/yield               the yield of the last 30 days per style and supplier lot (production.cutting.view;
 *                                       never per cutter)
 * The shapes mirror the API's contracts; unknown fields are dropped; the API's English (`words`) is never drawn.
 */

const areaUom = z.enum(AREA_UOMS)
const named = z.object({ id: z.string(), code: z.string(), name: z.string() })
const clean = (query: Record<string, string | null | undefined>) => Object.fromEntries(Object.entries(query).filter(([, value]) => value !== null && value !== undefined && value !== ''))

// ---- area on hand and its value (GET /costing/valuation/leather) ----------------------------------------------------------

const areaFigures = {
  hides: z.number(),
  quantity: z.string(),
  areaM2: z.string().nullable(),
  /** Minor units, cost grain only. */
  value: z.number().optional(),
  valuePerM2: z.string().nullable().optional(),
}
const leatherRow = z.object({
  site: z.object({ id: z.string(), code: z.string() }),
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), baseUom: z.string() }),
  colour: named.nullable(),
  ...areaFigures,
  currency: z.string().nullable(),
  lots: z.array(z.object({ lot: z.object({ id: z.string(), code: z.string(), qualityStatus: z.string() }), ...areaFigures })),
})
export type LeatherValueRow = z.infer<typeof leatherRow>
const leatherSchema = z.object({ rows: z.array(leatherRow), hides: z.number(), areaM2: z.string(), value: z.number().nullable().optional(), currency: z.string().nullable(), notArea: z.number() })
export type LeatherValue = z.infer<typeof leatherSchema>
export const leatherValue = (api: ApiClient, query: { siteId: string | null }, signal?: AbortSignal) =>
  api.get('/costing/valuation/leather', { query: clean({ siteId: query.siteId }), schema: leatherSchema, signal })

// ---- the grade mix per lot (GET /inventory/leather/grade-mix?groupBy=lot) -------------------------------------------------

const gradeRef = z.object({ id: z.string(), code: z.string(), labelIt: z.string(), labelEn: z.string(), active: z.boolean() })
const mixGroup = z.object({
  item: named,
  colour: named.nullable(),
  lot: z.object({ id: z.string(), code: z.string(), dyeBatch: z.string().nullable(), receivedAt: z.string().nullable() }).nullable(),
  uom: areaUom,
  hides: z.number(),
  measured: z.string(),
  left: z.string(),
  usable: z.string(),
  ungradedLeft: z.string(),
  grades: z.array(z.object({ grade: gradeRef.nullable(), texts: z.array(z.string()), hides: z.number(), left: z.string(), usable: z.string().nullable(), percentOfArea: z.string() })),
  remnants: z.object({ pieces: z.number(), area: z.string() }),
})
export type MixGroup = z.infer<typeof mixGroup>
const mixSchema = z.object({
  groupBy: z.enum(['article', 'lot']),
  groups: z.array(mixGroup),
  totals: z.array(z.object({ uom: areaUom, hides: z.number(), left: z.string(), usable: z.string(), ungradedLeft: z.string(), remnants: z.object({ pieces: z.number(), area: z.string() }) })),
})
export type GradeMix = z.infer<typeof mixSchema>
export const gradeMix = (api: ApiClient, query: { siteId: string | null; groupBy: 'article' | 'lot' }, signal?: AbortSignal) =>
  api.get('/inventory/leather/grade-mix', { query: clean({ siteId: query.siteId, groupBy: query.groupBy }), schema: mixSchema, signal })

// ---- at subcontractors, on hold (GET /inventory/leather/dashboard) --------------------------------------------------------

const figure = z.object({ hides: z.number(), area: z.string() })
const dashboardSchema = z.object({
  asOf: z.string(),
  atSubcontractors: z.object({
    rows: z.array(z.object({ location: named, party: z.object({ id: z.string(), name: z.string() }).nullable(), item: named, colour: named.nullable(), uom: areaUom, hides: z.number(), area: z.string() })),
    sums: z.array(z.object({ uom: areaUom, hides: z.number(), area: z.string() })),
  }),
  onHold: z.object({
    rows: z.array(z.object({ item: named, colour: named.nullable(), uom: areaUom, lotNotReleased: figure, qualityHold: figure })),
    sums: z.array(z.object({ uom: areaUom, lotNotReleased: figure, qualityHold: figure })),
  }),
})
export type LeatherDashboard = z.infer<typeof dashboardSchema>
export const leatherDashboard = (api: ApiClient, query: { siteId: string | null }, signal?: AbortSignal) =>
  api.get('/inventory/leather/dashboard', { query: clean({ siteId: query.siteId }), schema: dashboardSchema, signal })

// ---- the yield of the last 30 days (GET /production/yield) ----------------------------------------------------------------

const pct = z.string().nullable()
const yieldRow = z.object({
  style: named,
  lot: z.object({ id: z.string(), code: z.string(), supplierLotRef: z.string().nullable() }),
  supplier: z.object({ id: z.string(), name: z.string() }).nullable(),
  hides: z.number(),
  used: z.string(),
  pattern: z.string(),
  yieldPct: pct,
  plannedPct: pct,
  variancePct: pct,
})
export type YieldRow = z.infer<typeof yieldRow>
const yieldSchema = z.object({ byStyleAndLot: z.array(yieldRow), overall: z.object({ used: z.string(), yieldPct: pct, plannedPct: pct, variancePct: pct }) })
export type CuttingYield = z.infer<typeof yieldSchema>
export const cuttingYield = (api: ApiClient, query: { siteId: string | null; from: string; to: string }, signal?: AbortSignal) =>
  api.get('/production/yield', { query: clean({ siteId: query.siteId, from: query.from, to: query.to }), schema: yieldSchema, signal })

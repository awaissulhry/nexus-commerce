import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { UOMS } from '@nexus/factory-domain/product/units/units'

/**
 * Every call of Warehouse › Reports (SCR-257, B-W2b-356), with the answer's shape checked (zod; unknown fields are dropped). The
 * shapes mirror apps/factory-api modules/inventory/reports/contract.ts; the lists mirror factory-domain inventory/reports/rules
 * (reports.vitest.test.ts holds them equal). Read only: no call writes. Every value is the cost grain's: the API leaves it out for
 * a reader without it (so each is optional here). Nothing names a person.
 */

export const AGE_BUCKETS = ['d0to90', 'd91to180', 'd181to365', 'overYear'] as const
export type AgeBucket = (typeof AGE_BUCKETS)[number]
export const MATERIAL_TYPES = ['LEATHER', 'TEXTILE', 'LINING', 'MEMBRANE', 'PADDING', 'THREAD', 'TRIM', 'HARDWARE', 'PROTECTOR', 'LABEL', 'PACKAGING', 'COMPONENT', 'FINISHED'] as const
export type MaterialType = (typeof MATERIAL_TYPES)[number]

const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })
export type Ref = z.infer<typeof ref>
const uom = z.enum(UOMS)
const value = z.number().nullable().optional()
const head = {
  company: ref.nullable(),
  site: ref.nullable(),
  sites: z.array(ref),
  from: z.string(),
  to: z.string(),
  today: z.string(),
  asOf: z.string(),
}
const sight = z.object({ stock: z.boolean(), values: z.boolean() })
export type Sight = z.infer<typeof sight>
const unitQuantity = z.object({ uom, quantity: z.string() })
export type UnitQuantity = z.infer<typeof unitQuantity>

const bucket = z.object({ quantities: z.array(unitQuantity), value, share: z.string().nullable() })
export type BucketFigures = z.infer<typeof bucket>
const figures = {
  buckets: z.object({ d0to90: bucket, d91to180: bucket, d181to365: bucket, overYear: bucket }),
  undated: z.array(unitQuantity),
  whole: z.object({ quantities: z.array(unitQuantity), value }),
  currency: z.string().nullable(),
  mixedCurrencies: z.boolean(),
  unvalued: z.number(),
  averageDays: z.string().nullable(),
  oldestDays: z.number().nullable(),
  keys: z.number(),
}
const ageingArticle = z.object({ item: ref, colour: ref.nullable(), tracked: z.boolean(), ...figures })
export type AgeingArticle = z.infer<typeof ageingArticle>
const ageingType = z.object({ type: z.enum(MATERIAL_TYPES), ...figures, articles: z.array(ageingArticle), more: z.number() })
export type AgeingType = z.infer<typeof ageingType>
const ageingSchema = z.object({
  ...head,
  sight,
  asAt: z.string(),
  types: z.array(ageingType),
  all: z.object({ value, currency: z.string().nullable(), mixedCurrencies: z.boolean(), unvalued: z.number() }),
  customerOwned: z.number(),
})
export type Ageing = z.infer<typeof ageingSchema>

const quantities = z.object({
  start: z.string(),
  received: z.string(),
  issued: z.string(),
  returned: z.string(),
  remnant: z.string(),
  cut: z.string(),
  scrapped: z.string(),
  other: z.string(),
  end: z.string(),
})
export type LeatherQuantities = z.infer<typeof quantities>
export const LEATHER_MEASURES = ['received', 'cut', 'remnant', 'scrapped', 'end'] as const
export type LeatherMeasure = (typeof LEATHER_MEASURES)[number]
const leatherFigures = z.object({
  uom: uom.nullable(),
  base: quantities.nullable(),
  m2: quantities.nullable(),
  addsUp: z.boolean(),
  hidesReceived: z.number(),
  hidesOnHand: z.number(),
  values: z.object({ start: value, received: value, cut: value, scrapped: value, end: value }),
  currency: z.string().nullable(),
})
export type LeatherFigures = z.infer<typeof leatherFigures>
const leatherLot = z.object({
  lot: z.object({ id: z.string(), code: z.string() }).nullable(),
  supplier: ref.nullable(),
  supplierLotRef: z.string().nullable(),
  dyeBatch: z.string().nullable(),
  children: z.number(),
  figures: leatherFigures,
})
export type LeatherLot = z.infer<typeof leatherLot>
const leatherArticle = z.object({ item: ref, colour: ref.nullable(), figures: leatherFigures, lots: z.array(leatherLot) })
export type LeatherArticle = z.infer<typeof leatherArticle>
const leatherSchema = z.object({ ...head, sight, articles: z.array(leatherArticle), all: leatherFigures, more: z.number(), unvaluedMoves: z.number() })
export type Leather = z.infer<typeof leatherSchema>

export interface ReportsScope {
  readonly siteId: string | null
  readonly from: string | null
  readonly to: string | null
}

const queryOf = (scope: ReportsScope): Record<string, string> => {
  const query: Record<string, string> = {}
  if (scope.siteId) query.siteId = scope.siteId
  if (scope.from) query.from = scope.from
  if (scope.to) query.to = scope.to
  return query
}

/** GET /inventory/reports/ageing — stock ageing by material type (wr-ageing). */
export const getAgeing = (api: ApiClient, scope: ReportsScope, signal?: AbortSignal) => api.get('/inventory/reports/ageing', { query: queryOf(scope), schema: ageingSchema, signal })

/** GET /inventory/reports/leather — leather use by article and supplier lot (wr-leather). */
export const getLeather = (api: ApiClient, scope: ReportsScope, signal?: AbortSignal) => api.get('/inventory/reports/leather', { query: queryOf(scope), schema: leatherSchema, signal })

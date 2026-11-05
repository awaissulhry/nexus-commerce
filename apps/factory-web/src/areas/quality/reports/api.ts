import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'

/**
 * Every call of Quality › Reports (SCR-147, B-W2b-138), with the answer's shape checked (zod; unknown fields are dropped). The
 * shapes mirror apps/factory-api modules/quality/reports/contract.ts; the lists mirror factory-domain quality/reports/rules
 * (reports.vitest.test.ts holds them equal). Read only: no call writes. No call takes a person key and no answer carries a
 * person: a group too small to hide one person answers `tooFew` with no figure (ANA-075; Statuto dei Lavoratori art. 4).
 */

export const DIMENSIONS = ['line', 'operation', 'supplier', 'style'] as const
export type Dimension = (typeof DIMENSIONS)[number]
export const KPI_KEYS = ['fpy', 'dhu', 'aqlPass', 'ncrOpen', 'capaOnTime', 'holdsOld'] as const
export type KpiKey = (typeof KPI_KEYS)[number]

const one = z.string().nullable()
const site = z.object({ id: z.string(), code: z.string(), name: z.string(), timeZone: z.string() })
const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })
const change = z.object({ direction: z.enum(['UP', 'DOWN', 'SAME']), by: z.string(), better: z.boolean().nullable() }).nullable()
export type Change = z.infer<typeof change>
const head = {
  site,
  sites: z.array(z.object({ id: z.string(), code: z.string(), name: z.string() })),
  from: z.string(),
  to: z.string(),
  today: z.string(),
  asOf: z.string(),
  minimumGroupSize: z.number(),
}
const sight = z.object({ inprocess: z.boolean(), inspections: z.boolean(), ncr: z.boolean(), capa: z.boolean(), holds: z.boolean(), incoming: z.boolean(), lots: z.boolean() })
export type Sight = z.infer<typeof sight>

const rate = z.object({
  tooFew: z.boolean(),
  value: one,
  part: z.number().nullable(),
  whole: z.number().nullable(),
  checks: z.number().nullable(),
  previous: z.object({ tooFew: z.boolean(), value: one }).nullable(),
  change,
  weeks: z.array(z.object({ week: z.string(), from: z.string(), to: z.string(), tooFew: z.boolean(), value: one })),
})
export type Rate = z.infer<typeof rate>
const count = z.object({ value: z.number(), averageAgeDays: one, previous: z.object({ value: z.number(), averageAgeDays: one }).nullable(), change })
export type Count = z.infer<typeof count>

const kpisSchema = z.object({
  ...head,
  previous: z.object({ from: z.string(), to: z.string() }).nullable(),
  sight,
  kpis: z.object({ fpy: rate.nullable(), dhu: rate.nullable(), aqlPass: rate.nullable(), ncrOpen: count.nullable(), capaOnTime: rate.nullable(), holdsOld: count.nullable() }),
  amendments: z.object({ signed: z.number() }).nullable(),
})
export type Kpis = z.infer<typeof kpisSchema>

const aql = z.object({ passed: z.number(), decided: z.number(), pct: one }).nullable()
const weekSchema = z.object({
  week: z.string(),
  from: z.string(),
  to: z.string(),
  tooFew: z.boolean(),
  fpy: one,
  dhu: one,
  pieces: z.number().nullable(),
  defects: z.number().nullable(),
  checks: z.number().nullable(),
  aql,
  aqlTooFew: z.boolean(),
  capaClosed: z.object({ count: z.number(), capas: z.array(z.object({ id: z.string(), number: z.string() })) }).nullable(),
})
export type TrendWeek = z.infer<typeof weekSchema>
const trendSchema = z.object({ ...head, sight, lineId: z.string().nullable(), lines: z.array(ref), weeks: z.array(weekSchema) })
export type Trend = z.infer<typeof trendSchema>

const rowSchema = z.object({
  key: z.string(),
  ref: z.object({ id: z.string().nullable(), code: z.string(), name: z.string() }).nullable(),
  tooFew: z.boolean(),
  inspected: z.number().nullable(),
  defects: z.number().nullable(),
  dhu: one,
  aql,
  ncrs: z.number().nullable(),
})
export type CompareRow = z.infer<typeof rowSchema>
const compareSchema = z.object({ ...head, by: z.enum(DIMENSIONS), sight: z.object({ counts: z.boolean(), aql: z.boolean(), ncrs: z.boolean() }), rows: z.array(rowSchema), hidden: z.number() })
export type Compare = z.infer<typeof compareSchema>

const supplierSchema = z.object({
  party: ref.nullable(),
  workshop: z.boolean(),
  lotsReceived: z.number().nullable(),
  rejected: z.number().nullable(),
  crViFails: z.number().nullable(),
  averageQuarantineDays: one,
  inQuarantine: z.number().nullable(),
  inspections: z.number().nullable(),
  inspectionsFailed: z.number().nullable(),
})
export type SupplierRow = z.infer<typeof supplierSchema>
const incomingSchema = z.object({ ...head, sight: z.object({ incoming: z.boolean(), lots: z.boolean() }), suppliers: z.array(supplierSchema) })
export type Incoming = z.infer<typeof incomingSchema>

export interface Scope {
  readonly siteId: string
  readonly from: string | null
  readonly to: string | null
}
const scopeQuery = (scope: Scope) => ({ siteId: scope.siteId, from: scope.from ?? undefined, to: scope.to ?? undefined })

export const getKpis = (api: ApiClient, scope: Scope & { compare: boolean }, signal?: AbortSignal): Promise<Kpis> =>
  api.get('/quality/reports/kpis', { query: { ...scopeQuery(scope), compare: scope.compare ? 'previous' : undefined }, schema: kpisSchema, signal })

export const getTrend = (api: ApiClient, scope: Scope & { lineId: string | null }, signal?: AbortSignal): Promise<Trend> =>
  api.get('/quality/reports/trend', { query: { ...scopeQuery(scope), lineId: scope.lineId ?? undefined }, schema: trendSchema, signal })

export const getCompare = (api: ApiClient, scope: Scope & { by: Dimension }, signal?: AbortSignal): Promise<Compare> =>
  api.get('/quality/reports/compare', { query: { ...scopeQuery(scope), by: scope.by }, schema: compareSchema, signal })

export const getIncoming = (api: ApiClient, scope: Scope, signal?: AbortSignal): Promise<Incoming> => api.get('/quality/reports/incoming', { query: scopeQuery(scope), schema: incomingSchema, signal })

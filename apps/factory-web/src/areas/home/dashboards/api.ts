import { z } from 'zod'
import { ATTENTION_KINDS, SEVERITIES } from '@nexus/factory-domain/insights/attention'
import { BOARD_PANELS, DASHBOARD_KEYS, DASHBOARD_PERIODS, PANEL_WIDTHS } from '@nexus/factory-domain/insights/dashboards/boards'
import { KPI_DRILL_KINDS, KPI_GRAINS, KPI_UNITS } from '@nexus/factory-domain/insights/kpis/catalogue'
import { MEASURE_SOURCES } from '@nexus/factory-domain/insights/kpis/measures'
import { WIP_AGE_BUCKETS } from '@nexus/factory-domain/insights/kpis/wip'
import { PERIOD_KINDS } from '@nexus/factory-domain/insights/periods/periods'
import type { ApiClient } from '../../../lib/api/client'
import { newIdempotencyKey } from '../../../lib/api/client'
import { KPI_PROBLEMS } from '../kpis/api'

/**
 * Every call of Home › Insights › Dashboards (SCR-031 the role dashboards, SCR-103 the Owner's group view, SCR-490 Present) on
 * B-W2b-434's routes, the answers checked with zod (unknown fields dropped). The shapes mirror apps/factory-api
 * modules/insights/dashboards/contract.ts. A KPI's name, definition and formula are DATA of its version (Italian and English);
 * units, problems, sources, kinds, age bands and every other code are said by this app's catalogues (`home-dashboards`, with
 * `home-kpis` for a KPI's units and problems, `home` for Today's kinds). A value marked with a money grain is dropped by the
 * API's grain filter for anyone without it: an absent value reads as null.
 */

export { BOARD_PANELS, DASHBOARD_KEYS, DASHBOARD_PERIODS, MEASURE_SOURCES, PANEL_WIDTHS, WIP_AGE_BUCKETS }
export type DashboardKey = (typeof DASHBOARD_KEYS)[number]
export type BoardPanel = (typeof BOARD_PANELS)[number]
export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number]
export type PanelWidth = (typeof PANEL_WIDTHS)[number]
export type MeasureSource = (typeof MEASURE_SOURCES)[number]
export type WipAgeBucket = (typeof WIP_AGE_BUCKETS)[number]

const marked = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((value) => (value === undefined || value === null ? null : String(value)))

const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })
export type Ref = z.infer<typeof ref>
const said = z.object({ it: z.string(), en: z.string() })
export type Said = z.infer<typeof said>
const period = z.object({ kind: z.enum(PERIOD_KINDS), key: z.string(), from: z.string(), to: z.string() })
export type DashPeriod = z.infer<typeof period>

const freshness = {
  currency: z.string().nullable(),
  converted: z.array(z.string()),
  asOf: z.string().nullable(),
  stale: z.boolean(),
  live: z.boolean(),
  missingDays: z.number(),
  problem: z.enum(KPI_PROBLEMS).nullable(),
}

const boardsSchema = z.object({
  asOf: z.string(),
  boards: z.array(z.object({ key: z.enum(DASHBOARD_KEYS), mine: z.boolean(), panels: z.array(z.enum(BOARD_PANELS)) })),
  companies: z.array(ref.extend({ sites: z.array(ref) })),
})
export type Boards = z.infer<typeof boardsSchema>
export type BoardEntry = Boards['boards'][number]
export type ScopeCompany = Boards['companies'][number]

const kpiOf = { kpiKey: z.string(), unit: z.enum(KPI_UNITS), grain: z.enum(KPI_GRAINS).nullable(), name: said }

const numberSchema = z.object({
  ...kpiOf,
  definition: said,
  formula: said,
  standsFor: z.object({ kpiKey: z.string(), name: said }).nullable(),
  sources: z.array(z.enum(MEASURE_SOURCES)),
  wholeCompany: z.boolean(),
  period,
  value: marked,
  ...freshness,
  periods: z.array(period.extend({ value: marked })),
  drill: z.object({ kind: z.enum(KPI_DRILL_KINDS), key: z.string().nullable(), api: z.string().nullable(), terms: z.record(z.string(), z.string()) }).nullable(),
})
export type DashNumber = z.infer<typeof numberSchema>

const numbersSchema = z.object({ board: z.enum(DASHBOARD_KEYS), asOf: z.string(), period: z.enum(DASHBOARD_PERIODS), numbers: z.array(numberSchema), withheld: z.array(z.string()) })
export type Numbers = z.infer<typeof numbersSchema>

const cellSchema = z.object({ kpiKey: z.string(), value: marked, perCompanyOnly: z.boolean(), ...freshness })
export type ByCompanyCell = z.infer<typeof cellSchema>
const byCompanySchema = z.object({
  board: z.enum(DASHBOARD_KEYS),
  asOf: z.string(),
  period,
  columns: z.array(z.object({ ...kpiOf, perSite: z.boolean() })),
  rows: z.array(z.object({ company: ref, site: ref.nullable(), cells: z.array(cellSchema), sites: z.object({ read: z.number(), of: z.number() }).nullable() })),
})
export type ByCompany = z.infer<typeof byCompanySchema>
export type ByCompanyRow = ByCompany['rows'][number]

const needsSchema = z.object({
  asOf: z.string(),
  rows: z.array(z.object({ kind: z.enum(ATTENTION_KINDS), count: z.number(), severity: z.enum(SEVERITIES), oldestDays: z.number().nullable(), complete: z.boolean() })),
  all: z.number(),
  complete: z.boolean(),
})
export type NeedsAction = z.infer<typeof needsSchema>
export type NeedsRow = NeedsAction['rows'][number]

const trendsSchema = z.object({
  kpi: z.object(kpiOf),
  target: z.number(),
  weeks: z.array(period),
  values: z.array(marked),
  series: z.array(z.object({ company: ref, values: z.array(marked) })),
  ...freshness,
})
export type Trends = z.infer<typeof trendsSchema>

const ageing = z.object(Object.fromEntries(WIP_AGE_BUCKETS.map((bucket) => [bucket, z.number()])) as Record<WipAgeBucket, z.ZodNumber>)
const wipSchema = z.object({
  asOf: z.string(),
  kpiKey: z.string(),
  overall: z.object({ workOrders: z.number(), pieces: z.number(), waiting: z.number() }),
  stages: z.array(z.object({ code: z.string(), name: z.string(), workOrders: z.number(), waiting: z.number(), ageing })),
})
export type Wip = z.infer<typeof wipSchema>
export type WipStage = Wip['stages'][number]

const layoutPanel = z.object({ id: z.string(), hidden: z.boolean(), width: z.enum(PANEL_WIDTHS) })
export type LayoutPanel = z.infer<typeof layoutPanel>
const layoutSchema = z.object({ board: z.enum(DASHBOARD_KEYS), panels: z.array(layoutPanel), saved: z.boolean(), version: z.number(), updatedAt: z.string().nullable() })
export type DashLayout = z.infer<typeof layoutSchema>

export interface DashScope {
  readonly companyId: string | null
  readonly siteId: string | null
}

const scopeQuery = (scope: DashScope) => ({ companyId: scope.companyId ?? undefined, siteId: scope.siteId ?? undefined })

/** GET /insights/dashboards: every dashboard (mine first, with the panels I may see) and the scope's companies and sites. */
export function getBoards(api: ApiClient, signal?: AbortSignal): Promise<Boards> {
  return api.get('/insights/dashboards', { schema: boardsSchema, signal })
}

/** GET /insights/dashboards/:board/numbers: the five numbers over the period and the 11 before it, in the scope. */
export function getNumbers(api: ApiClient, board: DashboardKey, query: DashScope & { period: DashboardPeriod }, signal?: AbortSignal): Promise<Numbers> {
  return api.get(`/insights/dashboards/${board}/numbers`, { query: { ...scopeQuery(query), period: query.period }, schema: numbersSchema, signal })
}

/** GET /insights/dashboards/:board/by-company: the Owner's group view. */
export function getByCompany(api: ApiClient, board: DashboardKey, query: { period: DashboardPeriod }, signal?: AbortSignal): Promise<ByCompany> {
  return api.get(`/insights/dashboards/${board}/by-company`, { query: { period: query.period }, schema: byCompanySchema, signal })
}

export function getNeedsAction(api: ApiClient, scope: DashScope, signal?: AbortSignal): Promise<NeedsAction> {
  return api.get('/insights/dashboards/needs-action', { query: scopeQuery(scope), schema: needsSchema, signal })
}

export function getTrends(api: ApiClient, scope: DashScope, signal?: AbortSignal): Promise<Trends> {
  return api.get('/insights/dashboards/trends', { query: { companyId: scope.companyId ?? undefined }, schema: trendsSchema, signal })
}

export function getWip(api: ApiClient, scope: DashScope, signal?: AbortSignal): Promise<Wip> {
  return api.get('/insights/dashboards/wip', { query: scopeQuery(scope), schema: wipSchema, signal })
}

export function getLayout(api: ApiClient, board: DashboardKey, signal?: AbortSignal): Promise<DashLayout> {
  return api.get(`/insights/dashboards/${board}/layout`, { schema: layoutSchema, signal })
}

/** PUT /insights/dashboards/:board/layout: my arrangement (order, widths, shown, pinned reports) at the version read. */
export function saveLayout(api: ApiClient, board: DashboardKey, body: { panels: readonly LayoutPanel[]; version: number }): Promise<DashLayout> {
  return api.request('PUT', `/insights/dashboards/${board}/layout`, { body, schema: layoutSchema, idempotencyKey: newIdempotencyKey() })
}

/** DELETE /insights/dashboards/:board/layout: back to the dashboard's own order. */
export function resetLayout(api: ApiClient, board: DashboardKey, version: number): Promise<DashLayout> {
  return api.request('DELETE', `/insights/dashboards/${board}/layout`, { query: { version }, schema: layoutSchema, idempotencyKey: newIdempotencyKey() })
}

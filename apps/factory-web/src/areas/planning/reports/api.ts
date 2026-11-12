import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'

/**
 * Every call of Planning › Reports (SCR-254, B-W2b-349), with the answer's shape checked (zod; unknown fields are dropped, so a
 * new API field never breaks the page). The shapes mirror apps/factory-api modules/planning/reports/contract.ts; the lists mirror
 * factory-domain planning/reports/rules (reports.vitest.test.ts holds them equal). No money on this page: minutes, days and
 * quantities only. Nothing names a person: work is per line, work centre, the plant and workshop.
 */

export const ADHERENCE_STATES = ['ON_TIME', 'LATE', 'NOT_PLANNED'] as const
export type AdherenceState = (typeof ADHERENCE_STATES)[number]
export const LANE_KINDS = ['PLANT', 'LINE', 'WORK_CENTRE', 'WORKSHOP'] as const
export type ReportLaneKind = (typeof LANE_KINDS)[number]
export const COVER_STATES = ['SHORT_NOW', 'STOCK_OUT', 'BELOW_SAFETY', 'COVERED'] as const
export type CoverState = (typeof COVER_STATES)[number]
export const HEAT_BANDS = ['LOW', 'MEDIUM', 'HIGH', 'OVER', 'UNKNOWN'] as const
export type HeatBand = (typeof HEAT_BANDS)[number]

const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })
export type Ref = z.infer<typeof ref>
const site = z.object({ id: z.string(), companyId: z.string(), code: z.string(), name: z.string(), timeZone: z.string() })
const head = { site, from: z.string(), to: z.string(), today: z.string(), asOf: z.string() }

// ---- schedule adherence ------------------------------------------------------------------------------------------------------

const figures = z.object({
  finished: z.number(),
  planned: z.number(),
  onTime: z.number(),
  late: z.number(),
  notPlanned: z.number(),
  onTimePct: z.string().nullable(),
  startedLate: z.number(),
  meanFinishDays: z.string().nullable(),
  meanStartDays: z.string().nullable(),
})
export type AdherenceFigures = z.infer<typeof figures>
const week = z.object({ key: z.string(), from: z.string(), to: z.string() })

const adherenceSchema = z.object({
  ...head,
  weeks: z.array(week.extend({ figures })),
  lines: z.array(z.object({ line: ref.nullable(), figures, weeks: z.array(z.object({ key: z.string(), figures })) })),
  all: figures,
  complete: z.boolean(),
})
export type Adherence = z.infer<typeof adherenceSchema>
export type AdherenceLine = Adherence['lines'][number]

const adherenceRowsSchema = z.object({
  ...head,
  line: ref.nullable(),
  week: week.nullable(),
  figures,
  rows: z.array(
    z.object({
      workOrder: z.object({ id: z.string(), number: z.string(), kind: z.string(), status: z.string(), dueDate: z.string().nullable(), rush: z.boolean(), style: ref }),
      line: ref.nullable(),
      planned: z.object({ source: z.enum(['PUBLISHED', 'WORKING']), number: z.number().nullable(), startAt: z.string(), endAt: z.string() }).nullable(),
      actual: z.object({ startAt: z.string().nullable(), finishAt: z.string() }),
      state: z.enum(ADHERENCE_STATES),
      startDays: z.number().nullable(),
      finishDays: z.number().nullable(),
    }),
  ),
  more: z.number(),
})
export type AdherenceRows = z.infer<typeof adherenceRowsSchema>
export type AdherenceRow = AdherenceRows['rows'][number]

// ---- the utilisation trend -------------------------------------------------------------------------------------------------------

const reportWeek = z.object({ key: z.string(), from: z.string(), to: z.string(), actual: z.boolean(), ahead: z.boolean(), actualDays: z.object({ from: z.string(), to: z.string() }).nullable() })
export type ReportWeek = z.infer<typeof reportWeek>
const cell = z.object({
  key: z.string(),
  earnedMinutes: z.string().nullable(),
  availableMinutes: z.string().nullable(),
  utilisationPct: z.string().nullable(),
  booked: z.string().nullable(),
  capacity: z.string().nullable(),
  loadPct: z.string().nullable(),
  band: z.enum(HEAT_BANDS),
})
export type UtilisationCell = z.infer<typeof cell>
const lane = z.object({
  kind: z.enum(LANE_KINDS),
  id: z.string().nullable(),
  code: z.string().nullable(),
  name: z.string().nullable(),
  workCentreKind: z.string().nullable(),
  unit: z.string().nullable(),
  plannedEfficiencyPct: z.string().nullable(),
  cells: z.array(cell),
})
export type UtilisationLane = z.infer<typeof lane>
const utilisationSchema = z.object({ ...head, weeks: z.array(reportWeek), lanes: z.array(lane) })
export type Utilisation = z.infer<typeof utilisationSchema>

const workOrderRef = z.object({ id: z.string(), number: z.string(), status: z.string(), style: ref })
const operationRef = z.object({ id: z.string(), seq: z.number(), code: z.string(), name: z.string() })
const laneRef = z.object({ kind: z.enum(['LINE', 'WORK_CENTRE']), code: z.string() })
const utilisationRowsSchema = z.object({
  ...head,
  lane: z.object({ kind: z.enum(LANE_KINDS), id: z.string().nullable(), code: z.string().nullable(), name: z.string().nullable() }),
  week: reportWeek,
  earned: z.object({ minutes: z.string(), rows: z.array(z.object({ workOrder: workOrderRef, operation: operationRef, lane: laneRef, garments: z.number(), minutes: z.string() })), more: z.number() }).nullable(),
  booked: z.object({ minutes: z.string(), rows: z.array(z.object({ workOrder: workOrderRef, operation: operationRef, lane: laneRef, pieces: z.number(), minutes: z.string(), placedBy: z.enum(['SLOT', 'DUE_DATE']) })), more: z.number() }).nullable(),
})
export type UtilisationRows = z.infer<typeof utilisationRowsSchema>

// ---- material cover ----------------------------------------------------------------------------------------------------------------

const coverSchema = z.object({
  site,
  today: z.string(),
  asOf: z.string(),
  horizon: z.object({ from: z.string(), to: z.string(), weeks: z.number(), days: z.number() }),
  counts: z.object({ materials: z.number(), shortNow: z.number(), stockOut: z.number(), belowSafety: z.number(), covered: z.number() }),
  rows: z.array(
    z.object({
      item: z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.string(), baseUom: z.string() }),
      colour: ref.nullable(),
      action: z.enum(['BUY', 'MAKE']),
      onHand: z.string(),
      safetyStock: z.string().nullable(),
      demand: z.string(),
      receipts: z.string(),
      projectedEnd: z.string(),
      stockOutOn: z.string().nullable(),
      belowSafetyOn: z.string().nullable(),
      daysOfCover: z.number().nullable(),
      state: z.enum(COVER_STATES),
      firstShort: z.string().nullable(),
      uncovered: z.string(),
      openPurchases: z.object({ orders: z.number(), lines: z.number(), quantity: z.string(), next: z.object({ day: z.string(), purchaseOrderId: z.string(), number: z.string(), quantity: z.string() }).nullable() }),
    }),
  ),
  more: z.number(),
})
export type Cover = z.infer<typeof coverSchema>
export type CoverRow = Cover['rows'][number]

// ---- the calls ------------------------------------------------------------------------------------------------------------------

export interface ReportsScope {
  readonly siteId: string
  readonly from: string | null
  readonly to: string | null
}

const scopeQuery = (scope: ReportsScope): Record<string, string> => ({ siteId: scope.siteId, ...(scope.from ? { from: scope.from } : {}), ...(scope.to ? { to: scope.to } : {}) })

/** GET /planning/reports/adherence — the finished work orders against plan, per week and line (sec adherence). */
export const getAdherence = (api: ApiClient, scope: ReportsScope, signal?: AbortSignal) => api.get('/planning/reports/adherence', { query: scopeQuery(scope), schema: adherenceSchema, signal })

/** GET /planning/reports/adherence/work-orders — the work orders behind a bar (pop drill). */
export const getAdherenceRows = (api: ApiClient, scope: ReportsScope, behind: { lineId?: string | null; week?: string | null; state?: AdherenceState | null }, signal?: AbortSignal) =>
  api.get('/planning/reports/adherence/work-orders', { query: { ...scopeQuery(scope), ...(behind.lineId ? { lineId: behind.lineId } : {}), ...(behind.week ? { week: behind.week } : {}), ...(behind.state ? { state: behind.state } : {}) }, schema: adherenceRowsSchema, signal })

/** GET /planning/reports/utilisation — every lane, the plant and each workshop week by week (sec utilisation). */
export const getUtilisation = (api: ApiClient, scope: ReportsScope, ahead: number, signal?: AbortSignal) => api.get('/planning/reports/utilisation', { query: { ...scopeQuery(scope), ahead: String(ahead) }, schema: utilisationSchema, signal })

/** GET /planning/reports/utilisation/work-orders — the work orders behind one point (pop drill). */
export const getUtilisationRows = (api: ApiClient, scope: ReportsScope, ahead: number, point: { laneKind: 'PLANT' | 'LINE' | 'WORK_CENTRE'; laneId: string | null; week: string }, signal?: AbortSignal) =>
  api.get('/planning/reports/utilisation/work-orders', { query: { ...scopeQuery(scope), ahead: String(ahead), laneKind: point.laneKind, ...(point.laneId ? { laneId: point.laneId } : {}), week: point.week }, schema: utilisationRowsSchema, signal })

/** GET /planning/reports/cover — the materials by how soon they run out (sec cover). */
export const getCover = (api: ApiClient, siteId: string, weeks: number, signal?: AbortSignal) => api.get('/planning/reports/cover', { query: { siteId, weeks: String(weeks) }, schema: coverSchema, signal })

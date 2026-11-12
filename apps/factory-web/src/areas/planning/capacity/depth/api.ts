import { z } from 'zod'
import { HEAT_BANDS } from '@nexus/factory-domain/planning/heatmap/bands'
import { CAPACITY_UNITS, JOB_KINDS } from '@nexus/factory-domain/planning/subcontract-capacity/rules'
import type { ApiClient } from '../../../../lib/api/client'
import type { CapacityBucket } from '../api'

/**
 * The W2b reads of Planning › Capacity & load (SCR-123; B-W2b-338 on the API of B-W2b-321, apps/factory-api
 * modules/planning/subcontract-capacity contract.ts and heatmap/contract.ts), the answers' shapes checked with zod
 * (unknown fields dropped): the workshops' capacity lines per bucket (the same period and buckets as GET
 * /planning/capacity), the work behind one workshop cell, and the load heatmap (lanes down, weeks across). Amounts are
 * decimal strings in the line's unit (minutes or garments); `available: null` is "not known", never 0. The API's English
 * (`words`, the legend's words) is never drawn. Read only. No money, no person.
 */

const unit = z.enum(CAPACITY_UNITS)
export type CapacityUnit = z.infer<typeof unit>
const site = z.object({ id: z.string(), companyId: z.string(), code: z.string(), name: z.string(), timeZone: z.string() })

const lineCell = z.object({
  key: z.string(),
  from: z.string(),
  to: z.string(),
  available: z.string().nullable(),
  booked: z.string(),
  proposed: z.string(),
  loadPct: z.string().nullable(),
  over: z.boolean(),
  openDays: z.number(),
  closedDays: z.number(),
})
export type WorkshopCell = z.infer<typeof lineCell>

const lineSchema = z.object({
  kind: z.literal('WORKSHOP'),
  id: z.string(),
  code: z.string(),
  name: z.string(),
  location: z.object({ id: z.string(), code: z.string() }).nullable(),
  workCentreKind: z.string().nullable(),
  unit: unit.nullable(),
  known: z.boolean(),
  capacity: z.array(z.object({ id: z.string(), perWeek: z.number(), validFrom: z.string(), validTo: z.string().nullable() })),
  cells: z.array(lineCell),
  overall: z.object({ available: z.string().nullable(), booked: z.string(), proposed: z.string(), loadPct: z.string().nullable(), over: z.boolean() }),
})
export type WorkshopLine = z.infer<typeof lineSchema>

const subcontractorsSchema = z.object({
  site,
  from: z.string(),
  to: z.string(),
  bucket: z.string(),
  today: z.string(),
  asOf: z.string(),
  buckets: z.array(z.object({ key: z.string(), kind: z.string(), from: z.string(), to: z.string() })),
  lanes: z.array(lineSchema),
  tiles: z.object({ subcontractorsOverThisWeek: z.number(), workshopsWithoutCapacity: z.number() }),
})
export type Subcontractors = z.infer<typeof subcontractorsSchema>

/** The workshops' capacity lines over the same period and buckets as Capacity & load. */
export function getSubcontractorCapacity(api: ApiClient, query: { siteId: string; from?: string | null; to?: string | null; bucket?: CapacityBucket | null }, signal?: AbortSignal): Promise<Subcontractors> {
  return api.get('/planning/capacity/subcontractors', { query: { siteId: query.siteId, from: query.from ?? undefined, to: query.to ?? undefined, bucket: query.bucket ?? undefined }, schema: subcontractorsSchema, signal })
}

const workshopCellSchema = z.object({
  workshop: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  workCentreKind: z.string().nullable(),
  unit: unit.nullable(),
  from: z.string(),
  to: z.string(),
  available: z.string().nullable(),
  booked: z.string(),
  proposed: z.string(),
  loadPct: z.string().nullable(),
  jobs: z.array(
    z.object({
      kind: z.enum(JOB_KINDS),
      id: z.string(),
      number: z.string().nullable(),
      status: z.string(),
      proposed: z.boolean(),
      workOrder: z.object({ id: z.string(), number: z.string().nullable() }).nullable(),
      style: z.string().nullable(),
      from: z.string(),
      to: z.string(),
      garments: z.number(),
      share: z.string(),
      sharePct: z.string(),
    }),
  ),
})
export type WorkshopCellJobs = z.infer<typeof workshopCellSchema>

/** The work behind one workshop cell (a subcontract order, a part on the allocation board, a planned order). */
export function getWorkshopCell(api: ApiClient, query: { siteId: string; partyId: string; workCentreKind: string | null; from: string; to: string }, signal?: AbortSignal): Promise<WorkshopCellJobs> {
  return api.get('/planning/capacity/subcontractors/cell', { query: { siteId: query.siteId, partyId: query.partyId, workCentreKind: query.workCentreKind ?? undefined, from: query.from, to: query.to }, schema: workshopCellSchema, signal })
}

const heatCell = z.object({ key: z.string(), from: z.string(), to: z.string(), loadPct: z.string().nullable(), band: z.enum(HEAT_BANDS), text: z.string(), available: z.string().nullable(), booked: z.string(), over: z.boolean() })
export type HeatCell = z.infer<typeof heatCell>
const heatLane = z.object({ kind: z.enum(['LINE', 'WORK_CENTRE', 'WORKSHOP']), id: z.string(), code: z.string(), name: z.string(), workCentreKind: z.string().nullable(), unit: unit.nullable(), cells: z.array(heatCell) })
export type HeatLane = z.infer<typeof heatLane>

const heatmapSchema = z.object({
  site,
  from: z.string(),
  to: z.string(),
  today: z.string(),
  asOf: z.string(),
  weeks: z.array(z.object({ key: z.string(), from: z.string(), to: z.string() })),
  lanes: z.array(heatLane),
  counts: z.object({ cellsOver: z.number(), lanesOver: z.number() }),
})
export type Heatmap = z.infer<typeof heatmapSchema>

/** The heatmap's weeks: 8 by default, at most 26 (B-W2b-321's DEFAULT_WEEKS, MAX_WEEKS). */
export const HEAT_WEEKS = 8

/** The load heatmap from the Monday of `from` (default: this week), `weeks` weeks. */
export function getHeatmap(api: ApiClient, query: { siteId: string; from?: string | null; weeks?: number }, signal?: AbortSignal): Promise<Heatmap> {
  return api.get('/planning/heatmap', { query: { siteId: query.siteId, from: query.from ?? undefined, weeks: query.weeks === undefined ? undefined : String(query.weeks) }, schema: heatmapSchema, signal })
}

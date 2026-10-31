import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'

/**
 * Every call of Planning › Capacity & load (SCR-123), the answer's shape checked with zod (unknown fields dropped, so a
 * new API field never breaks the page). The shapes mirror apps/factory-api modules/planning/capacity/contract.ts
 * (B-W2a-16). Minutes and percents are decimal strings (one decimal), efficiency two decimals; dates are the site's days.
 * The API's English (`words`) is never drawn: the screen says how a capacity is made from the numbers. Per line, work
 * centre and work order only — no person, no money.
 */

export const CAPACITY_BUCKETS = ['DAY', 'WEEK', 'MONTH'] as const
export type CapacityBucket = (typeof CAPACITY_BUCKETS)[number]
export const LANE_KINDS = ['LINE', 'WORK_CENTRE'] as const
export type LaneKind = (typeof LANE_KINDS)[number]

const named = z.object({ id: z.string(), code: z.string(), name: z.string() })

const cellSchema = z.object({
  key: z.string(),
  from: z.string(),
  to: z.string(),
  workingDays: z.number(),
  workingMinutes: z.string(),
  minutesPerDay: z.string().nullable(),
  availableMinutes: z.string(),
  bookedMinutes: z.string(),
  scheduledMinutes: z.string(),
  loadPct: z.string().nullable(),
  overMinutes: z.string(),
  people: z.number(),
  efficiencyPct: z.string(),
  closedDays: z.array(z.object({ date: z.string(), reason: z.enum(['HOLIDAY', 'CLOSURE']), name: z.string() })),
  noShiftDays: z.array(z.string()),
})
export type CapacityCell = z.infer<typeof cellSchema>

const laneSchema = z.object({
  kind: z.enum(LANE_KINDS),
  id: z.string(),
  code: z.string(),
  name: z.string(),
  workCentreKind: z.string().nullable(),
  stations: z.number(),
  efficiencyPct: z.string(),
  efficiencySource: z.enum(['LANE', 'SITE', 'DEFAULT']),
  people: z.number(),
  peopleSource: z.enum(['CAPACITY', 'STATIONS']),
  pattern: z.object({ id: z.string(), code: z.string(), name: z.string(), source: z.enum(['CALENDAR', 'DEFAULT']) }),
  calendars: z.array(z.object({ id: z.string(), scope: z.string(), name: z.string() })),
  does: z.array(named).nullable(),
  cells: z.array(cellSchema),
  overall: z.object({ availableMinutes: z.string(), bookedMinutes: z.string(), loadPct: z.string().nullable(), overMinutes: z.string() }),
  unplaced: z.object({ pastDueMinutes: z.string(), undatedMinutes: z.string() }),
  heldWorkOrders: z.number(),
})
export type CapacityLane = z.infer<typeof laneSchema>

const capacitySchema = z.object({
  site: z.object({ id: z.string(), companyId: z.string(), code: z.string(), name: z.string(), timeZone: z.string() }),
  from: z.string(),
  to: z.string(),
  bucket: z.string(),
  today: z.string(),
  asOf: z.string(),
  buckets: z.array(z.object({ key: z.string(), kind: z.string(), from: z.string(), to: z.string() })),
  lanes: z.array(laneSchema),
  tiles: z.object({
    lanesOverThisWeek: z.number(),
    freeMinutesNext4Weeks: z.object({ lines: z.string(), workCentres: z.string() }),
    mostLoadedThisWeek: z.object({ kind: z.enum(LANE_KINDS), id: z.string(), code: z.string(), loadPct: z.string() }).nullable(),
  }),
  workOrdersWithoutLine: z.number(),
})
export type Capacity = z.infer<typeof capacitySchema>

export interface CapacityQuery {
  siteId: string
  from?: string | null
  to?: string | null
  bucket?: CapacityBucket | null
}

export function getCapacity(api: ApiClient, query: CapacityQuery, signal?: AbortSignal): Promise<Capacity> {
  return api.get('/planning/capacity', { query: { siteId: query.siteId, from: query.from ?? undefined, to: query.to ?? undefined, bucket: query.bucket ?? undefined }, schema: capacitySchema, signal })
}

const cellOrdersSchema = z.object({
  lane: z.object({ kind: z.enum(LANE_KINDS), id: z.string(), code: z.string(), name: z.string() }),
  from: z.string(),
  to: z.string(),
  availableMinutes: z.string(),
  bookedMinutes: z.string(),
  loadPct: z.string().nullable(),
  orders: z.array(
    z.object({
      workOrder: z.object({ id: z.string(), number: z.string(), status: z.string(), dueDate: z.string().nullable(), style: named }),
      operation: z.object({ id: z.string(), seq: z.number(), code: z.string(), name: z.string(), standardMinutes: z.string() }),
      pieces: z.number(),
      minutes: z.string(),
      sharePct: z.string(),
      placedBy: z.enum(['SLOT', 'DUE_DATE']),
      slot: z.object({ id: z.string(), startAt: z.string(), endAt: z.string() }).nullable(),
    }),
  ),
})
export type CellOrders = z.infer<typeof cellOrdersSchema>

/** The orders booked in one lane's days (the DetailModal of a cell), the largest first. */
export function getCellOrders(api: ApiClient, query: { siteId: string; laneKind: LaneKind; laneId: string; from: string; to: string }, signal?: AbortSignal): Promise<CellOrders> {
  return api.get('/planning/capacity/cell', { query, schema: cellOrdersSchema, signal })
}

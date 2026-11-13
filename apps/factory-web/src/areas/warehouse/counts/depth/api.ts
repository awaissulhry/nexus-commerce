import { z } from 'zod'
import { COUNT_ITEM_KINDS } from '@nexus/factory-domain/inventory/counts/rules'
import { ABC_CLASSES } from '@nexus/factory-domain/inventory/counts-depth/schedules'
import { BLOCK_REASONS } from '@nexus/factory-domain/inventory/locations-depth/blocks'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'

/**
 * B-W2b-320 — the W2b calls of Warehouse › Counts (SCR-132, SCR-132-record) on B-W2b-299's API (apps/factory-api
 * modules/inventory/counts-depth) and B-W2b-289's blocked places (locations-depth): the count schedules (the Due counts
 * section, the "Due this week" tile, the Count schedule dialog, Start count) and the places a running count blocks. The
 * schedule's `scope` words come from the API in both languages; the screens compose their own from the fields. No money;
 * no person.
 */

export type AbcClass = (typeof ABC_CLASSES)[number]
export type DueState = 'OVERDUE' | 'DUE_TODAY' | 'DUE_SOON' | 'LATER' | 'RETIRED'

const scheduleSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  siteId: z.string(),
  name: z.string(),
  location: z.object({ id: z.string(), code: z.string(), name: z.string(), path: z.string() }).nullable(),
  abcClass: z.enum(ABC_CLASSES).nullable(),
  itemKind: z.enum(COUNT_ITEM_KINDS).nullable(),
  everyDays: z.number(),
  nextDueOn: z.string(),
  lastCountedOn: z.string().nullable(),
  lastCount: z.object({ id: z.string(), number: z.string() }).nullable(),
  active: z.boolean(),
  note: z.string().nullable(),
  due: z.enum(['OVERDUE', 'DUE_TODAY', 'DUE_SOON', 'LATER', 'RETIRED']),
  overdueDays: z.number(),
  openTaskId: z.string().nullable(),
  version: z.number(),
})
export type Schedule = z.infer<typeof scheduleSchema>

const dueSchema = z.object({ today: z.string(), tiles: z.object({ overdue: z.number(), dueToday: z.number(), dueThisWeek: z.number() }), rows: z.array(scheduleSchema) })
export type DueCounts = z.infer<typeof dueSchema>

type Query = Readonly<Record<string, string | number | boolean | null | undefined>>
const clean = (query: Query): Query => Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== ''))
const seg = (value: string) => encodeURIComponent(value)
const key = () => ({ idempotencyKey: newIdempotencyKey() })
const one = z.object({ schedule: scheduleSchema })

/** The Due counts section and its tiles: the active schedules due this week, most overdue first. */
export const dueCounts = (api: ApiClient, siteId: string | null, signal?: AbortSignal) => api.get('/inventory/count-schedules/due', { query: clean({ siteId }), schema: dueSchema, signal })

/** Every schedule of a site (or of the person's sites), active, retired or both. */
export const listSchedules = (api: ApiClient, siteId: string | null, active: 'true' | 'false' | 'all', signal?: AbortSignal) =>
  api.get('/inventory/count-schedules', { query: clean({ siteId, active }), schema: z.object({ schedules: z.array(scheduleSchema) }), signal }).then((answer) => answer.schedules)

export interface ScheduleBody {
  siteId: string
  name: string
  locationId?: string | null
  abcClass?: AbcClass | null
  itemKind?: (typeof COUNT_ITEM_KINDS)[number] | null
  everyDays: number
  nextDueOn?: string
  note?: string | null
}
export const createSchedule = (api: ApiClient, body: ScheduleBody) => api.post('/inventory/count-schedules', { body, schema: one, ...key() }).then((answer) => answer.schedule)

export type ScheduleChange = Partial<Omit<ScheduleBody, 'siteId'>> & { version: number; active?: boolean }
export const changeSchedule = (api: ApiClient, id: string, body: ScheduleChange) => api.request('PATCH', `/inventory/count-schedules/${seg(id)}`, { body, schema: one, ...key() }).then((answer) => answer.schedule)

/** "Start count": the schedule's own count, frozen by default (its lines hold their moves until counted). */
export const startSchedule = (api: ApiClient, id: string, freeze = true) =>
  api.post(`/inventory/count-schedules/${seg(id)}/start`, { body: { freeze }, schema: z.object({ countId: z.string(), number: z.string(), lines: z.number() }), ...key() })

const blockedSchema = z.object({
  locations: z.array(
    z.object({
      id: z.string(),
      siteId: z.string(),
      siteCode: z.string(),
      code: z.string(),
      name: z.string(),
      block: z.object({ reason: z.enum(BLOCK_REASONS), until: z.string().nullable(), holds: z.boolean(), countNumber: z.string().nullable() }).nullable(),
    }),
  ),
})
export type BlockedPlace = z.infer<typeof blockedSchema>['locations'][number]
/** The blocked places of a site (inventory.locations.view): a running count's places are among them, with its number. */
export const blockedPlaces = (api: ApiClient, siteId: string | null, signal?: AbortSignal) => api.get('/inventory/locations/blocked', { query: clean({ siteId }), schema: blockedSchema, signal }).then((answer) => answer.locations)

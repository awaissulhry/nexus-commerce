import { z } from 'zod'
import { DISPATCH_STATES } from '@nexus/factory-domain/planning/schedule/dispatch'
import { MATERIAL_SCOPES, MATERIAL_STATES } from '@nexus/factory-domain/production/dispatch/material'
import { FLOOR_RULE_MODES } from '@nexus/factory-domain/production/settings/floor-rules'
import type { ApiClient } from '../../../lib/api/client'
import { AsOfMemory, type Remembered } from '../shared/as-of'
import { floorRead, type TaskOutcome } from '../shared/task-api'
import { listOf, type DispatchList, type MyList, type MyMessages, type StationHelp } from './model'

/**
 * SCR-089's reads (apps/factory-api modules/production/dispatch, floor + floor.work): the device's own station's queue
 * from the site's current published plan (Owner answer P3). The last answer is kept for the visit, so an offline
 * tablet still shows its queue "from this tablet, as of …" (design floor.mywork "queue" offline).
 *
 * B-W2b-71: the person's list (`GET /production/dispatch/mine`), the open messages on my work orders (`…/mine/messages`) and
 * who to call for material (`GET /production/calls/station`), each kept for the visit the same way. The call itself goes
 * through the tablet's queue (kind `andon.call.send`), so it works offline; the API's English `words` are never shown.
 */

const named = z.object({ id: z.string(), code: z.string(), name: z.string() })

const entry = z.object({
  slotId: z.string(),
  workOrder: z.object({
    id: z.string(),
    number: z.string(),
    status: z.string(),
    priority: z.number(),
    rush: z.boolean(),
    dueDate: z.string().nullable(),
    style: z.object({ code: z.string(), name: z.string() }),
    holdReason: z.string().nullable(),
  }),
  operation: z.object({ id: z.string(), seq: z.number(), code: z.string(), name: z.string() }),
  previous: z.object({ seq: z.number(), code: z.string(), name: z.string() }).nullable(),
  startAt: z.string(),
  endAt: z.string(),
  garments: z.number(),
  minutes: z.string(),
  state: z.enum(DISPATCH_STATES),
  words: z.string(),
  arrived: z.number(),
  waiting: z.number(),
  done: z.number(),
  sequence: z.object({ rule: z.enum(FLOOR_RULE_MODES), state: z.string(), words: z.string().nullable() }).nullable().optional(),
  // B-W2b-88: `scope` OPERATION when the BOM ties lines to steps (a list kept from before has none: the work order's).
  material: z.object({ state: z.enum(MATERIAL_STATES), date: z.string().nullable(), scope: z.enum(MATERIAL_SCOPES).optional() }).nullable().optional(),
})

const myEntry = entry.extend({ station: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(), bundles: z.number(), current: z.boolean() })

export const dispatchSchema = z.object({
  site: z.object({ id: z.string(), code: z.string(), name: z.string(), timeZone: z.string() }),
  target: z.object({ kind: z.enum(['LINE', 'WORK_CENTRE', 'STATION']), id: z.string(), code: z.string(), name: z.string(), line: named.nullable(), workCentre: named.nullable() }).nullable(),
  asOf: z.string(),
  version: z.object({ id: z.string(), number: z.number(), coversFrom: z.string(), coversTo: z.string(), effectiveFrom: z.string(), publishedAt: z.string() }).nullable(),
  upcoming: z.object({ id: z.string(), number: z.number(), effectiveFrom: z.string() }).nullable(),
  next: entry.nullable(),
  entries: z.array(entry),
  words: z.string().nullable(),
}) satisfies z.ZodType<DispatchList>

export const mineSchema = z.object({
  version: dispatchSchema.shape.version,
  entries: z.array(myEntry),
}) satisfies z.ZodType<MyList>

export const messagesSchema = z.object({
  asOf: z.string(),
  messages: z.array(z.object({ id: z.string(), workOrder: z.object({ id: z.string(), number: z.string() }), from: z.enum(['OFFICE', 'FLOOR']), text: z.string(), cut: z.boolean(), at: z.string() })),
}) satisfies z.ZodType<MyMessages>

export const helpSchema = z.object({
  station: z.object({ id: z.string(), code: z.string() }).nullable(),
  tiles: z.array(z.object({ type: z.object({ id: z.string(), code: z.string(), kind: z.string(), labelIt: z.string(), labelEn: z.string() }), open: z.object({ id: z.string() }).nullable() })),
}) satisfies z.ZodType<StationHelp>

const KEPT = new AsOfMemory<DispatchList>(4)
const KEPT_MESSAGES = new AsOfMemory<MyMessages>(1)
const KEPT_HELP = new AsOfMemory<StationHelp>(1)
const KEY = 'station'

/**
 * The list to work from, kept for the visit: the person's when the day names them for open work, else the station's queue.
 * The station's answer decides (place, plan, states); a person's list that cannot be read leaves the station's queue.
 */
export async function fetchWorkList(api: ApiClient): Promise<TaskOutcome<DispatchList>> {
  const [station, mine] = await Promise.all([floorRead(api, '/production/dispatch/station', { schema: dispatchSchema }), floorRead(api, '/production/dispatch/mine', { schema: mineSchema })])
  if (!station.ok) return station
  const value = listOf(station.value, mine.ok ? mine.value : null)
  KEPT.keep(KEY, value)
  return { ok: true, value }
}

/** The list this tablet read last in this visit, with its as-of time; null when none. */
export function keptWorkList(): Remembered<DispatchList> | null {
  return KEPT.get(KEY)
}

/** The open messages on my work orders, kept for the visit. */
export async function fetchMyMessages(api: ApiClient): Promise<TaskOutcome<MyMessages>> {
  const answer = await floorRead(api, '/production/dispatch/mine/messages', { schema: messagesSchema })
  if (answer.ok) KEPT_MESSAGES.keep(KEY, answer.value)
  return answer
}

export function keptMyMessages(): Remembered<MyMessages> | null {
  return KEPT_MESSAGES.get(KEY)
}

/** The station's help types and open calls, kept for the visit: offline, a call still knows its type. */
export async function fetchStationHelp(api: ApiClient): Promise<TaskOutcome<StationHelp>> {
  const answer = await floorRead(api, '/production/calls/station', { schema: helpSchema })
  if (answer.ok) KEPT_HELP.keep(KEY, answer.value)
  return answer
}

export function keptStationHelp(): Remembered<StationHelp> | null {
  return KEPT_HELP.get(KEY)
}

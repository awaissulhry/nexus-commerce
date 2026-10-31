import { z } from 'zod'
import { DISPATCH_STATES } from '@nexus/factory-domain/planning/schedule/dispatch'
import type { ApiClient } from '../../../lib/api/client'
import { AsOfMemory, type Remembered } from '../shared/as-of'
import { floorRead, type TaskOutcome } from '../shared/task-api'
import type { DispatchList } from './model'

/**
 * SCR-089's read (apps/factory-api modules/production/dispatch, floor + floor.work): the device's own station's queue
 * from the site's current published plan (Owner answer P3). The last answer is kept for the visit, so an offline
 * tablet still shows its queue "from this tablet, as of …" (design floor.mywork "queue" offline).
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
})

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

const KEPT = new AsOfMemory<DispatchList>(4)
const KEY = 'station'

/** The station's queue from the office, kept for the visit. */
export async function fetchStationQueue(api: ApiClient): Promise<TaskOutcome<DispatchList>> {
  const answer = await floorRead(api, '/production/dispatch/station', { schema: dispatchSchema })
  if (answer.ok) KEPT.keep(KEY, answer.value)
  return answer
}

/** The queue this tablet read last in this visit, with its as-of time; null when none. */
export function keptStationQueue(): Remembered<DispatchList> | null {
  return KEPT.get(KEY)
}

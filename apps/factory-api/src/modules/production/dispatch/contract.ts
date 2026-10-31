import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { DISPATCH_STATES } from '@nexus/factory-domain/planning/schedule/dispatch'

/**
 * The dispatch list per line or station (B-W2a-34; MES-021; design floor.mywork "Next" and "Then", the office's view of
 * the same list): read from the site's CURRENT published version of the plan (Owner answer P3), never the working plan.
 * Per work order, operation, line and station: no person, no money (Statuto dei Lavoratori art. 4; a floor session holds
 * no price, cost or margin grain).
 */

const named = output({ id: id(), code: z.string(), name: z.string() })

const entryView = output({
  slotId: id(),
  workOrder: output({
    id: id(),
    number: z.string(),
    status: z.string(),
    priority: z.number().int(),
    /** Rush (priority above 0): first in the list, with an icon and a word on the floor. */
    rush: z.boolean(),
    dueDate: businessDate().nullable(),
    style: output({ code: z.string(), name: z.string() }),
    holdReason: z.string().nullable(),
  }),
  operation: output({ id: id(), seq: z.number().int(), code: z.string(), name: z.string() }),
  /** The operation before it on the work order (B-W2a-74: the floor says "Waiting for Op 20 …" in its own words); null: the first. */
  previous: output({ seq: z.number().int(), code: z.string(), name: z.string() }).nullable(),
  startAt: instant(),
  endAt: instant(),
  /** The garments it is about: the work order's (a part of an order: the part's). */
  garments: z.number().int(),
  /** Standard minutes of the entry (standard minutes × garments still to do). */
  minutes: z.string(),
  state: z.enum(DISPATCH_STATES),
  /** The status word's sentence ("Waiting for Op 20 Sewing"). */
  words: z.string(),
  /** From the floor's scans at the operation: garments arrived, waiting (arrived, not reported), done (good + scrapped). */
  arrived: z.number().int(),
  waiting: z.number().int(),
  done: z.number().int(),
})

export const dispatchView = output({
  site: output({ id: id(), code: z.string(), name: z.string(), timeZone: z.string() }),
  target: output({ kind: z.enum(['LINE', 'WORK_CENTRE', 'STATION']), id: id(), code: z.string(), name: z.string(), line: named.nullable(), workCentre: named.nullable() }).nullable(),
  asOf: instant(),
  /** The version the floor works to now; null: nothing published (or started) yet. */
  version: output({ id: id(), number: z.number().int(), coversFrom: businessDate(), coversTo: businessDate(), effectiveFrom: instant(), publishedAt: instant() }).nullable(),
  /** A later version waiting for its start ("New schedule v13 from 06:00"). */
  upcoming: output({ id: id(), number: z.number().int(), effectiveFrom: instant() }).nullable(),
  /** The one next task (the first READY entry). */
  next: entryView.nullable(),
  entries: z.array(entryView),
  /** The empty or held state in words; null when there are entries. */
  words: z.string().nullable(),
})

export const officeDispatchContract = defineContract({
  querystring: input({ lineId: id().optional(), workCentreId: id().optional(), stationId: id().optional() }),
  response: { 200: dispatchView },
})
export type OfficeDispatchQuery = z.infer<typeof officeDispatchContract.querystring>

export const stationDispatchContract = defineContract({
  response: { 200: dispatchView },
})

import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { BUCKET_KINDS } from '@nexus/factory-domain/planning/settings/buckets'
import { LANE_KINDS } from '@nexus/factory-domain/planning/capacity/load'

/**
 * Capacity & load (B-W2a-16; PLN-115 capacity per line and work centre, PLN-116 load in standard minutes; design
 * planning.capacity, SCR-123, and the planning board's "Load per lane"): per lane (each ACTIVE line and work centre of a
 * site) and bucket, the minutes available (people × working minutes × efficiency, from the calendars service), the
 * standard minutes booked by the open work orders' frozen routings, and the load; how each available number is made;
 * the orders behind a cell. Minutes are decimal strings with one decimal, percents with one; dates are the site's days.
 * Per line, work centre and work order only: no person (Statuto dei Lavoratori art. 4). No money.
 */

export const CAPACITY_BUCKETS = [...BUCKET_KINDS, 'PLAN'] as const
/** The longest period one answer covers (a two-year plan horizon fits). */
export const CAPACITY_MAX_DAYS = 735

const named = output({ id: id(), code: z.string(), name: z.string() })
const minutes = () => z.string()

const bucketView = output({ key: z.string(), kind: z.enum(BUCKET_KINDS), from: businessDate(), to: businessDate() })

const cellView = output({
  key: z.string(),
  from: businessDate(),
  to: businessDate(),
  workingDays: z.number().int(),
  workingMinutes: minutes(),
  minutesPerDay: minutes().nullable(),
  availableMinutes: minutes(),
  /** Every open work order's minutes placed in the bucket; of them those placed by the board (`scheduledMinutes`). */
  bookedMinutes: minutes(),
  scheduledMinutes: minutes(),
  /** booked / available × 100; null when nothing is available. */
  loadPct: z.string().nullable(),
  overMinutes: minutes(),
  /** "How this capacity is made": the people, efficiency and days behind `availableMinutes`, in words too. */
  people: z.number().int(),
  efficiencyPct: z.string(),
  closedDays: z.array(output({ date: businessDate(), reason: z.enum(['HOLIDAY', 'CLOSURE']), name: z.string() })),
  /** Working weekdays the shift pattern has no shift on. */
  noShiftDays: z.array(businessDate()),
  words: z.string(),
})

export const capacityLaneView = output({
  kind: z.enum(LANE_KINDS),
  id: id(),
  code: z.string(),
  name: z.string(),
  workCentreKind: z.string().nullable(),
  stations: z.number().int(),
  /** Row end: the efficiency used and where it comes from, the people (or units) and where they come from. */
  efficiencyPct: z.string(),
  efficiencySource: z.enum(['LANE', 'SITE', 'DEFAULT']),
  people: z.number().int(),
  peopleSource: z.enum(['CAPACITY', 'STATIONS']),
  /** The shift pattern of its calendars (DEFAULT: none set). */
  pattern: output({ id: z.string(), code: z.string(), name: z.string(), source: z.enum(['CALENDAR', 'DEFAULT']) }),
  /** The ACTIVE calendars its days are read from, most specific first; empty: the planning default (no calendar). */
  calendars: z.array(output({ id: id(), scope: z.string(), name: z.string() })),
  /** A line: the work centres it does (its active stations'); null: every operation (no stations) or a work centre. */
  does: z.array(named).nullable(),
  cells: z.array(cellView),
  /** The whole period. */
  overall: output({ availableMinutes: minutes(), bookedMinutes: minutes(), loadPct: z.string().nullable(), overMinutes: minutes() }),
  /** Open load not on the board and in no bucket: due before the period's first day (past due), or with no due date. */
  unplaced: output({ pastDueMinutes: minutes(), undatedMinutes: minutes() }),
  /** Work orders on hold that would load it (they book nothing while held). */
  heldWorkOrders: z.number().int(),
})
export type CapacityLaneView = z.infer<typeof capacityLaneView>

const query = {
  siteId: id(),
  /** Default: today (the site's day). */
  from: businessDate().optional(),
  /** Default: four weeks on from `from` (the plan's horizon for PLAN). */
  to: businessDate().optional(),
  /** DAY, WEEK (default) or MONTH buckets; PLAN: the site's planning buckets from `from`. */
  bucket: z.enum(CAPACITY_BUCKETS).optional(),
}

export const capacityContract = defineContract({
  querystring: input(query),
  response: {
    200: output({
      site: output({ id: id(), companyId: id(), code: z.string(), name: z.string(), timeZone: z.string() }),
      from: businessDate(),
      to: businessDate(),
      bucket: z.enum(CAPACITY_BUCKETS),
      today: businessDate(),
      asOf: instant(),
      buckets: z.array(bucketView),
      lanes: z.array(capacityLaneView),
      /** Capacity at a glance: this week (Monday to Sunday) and the next four weeks from today, whatever the period. */
      tiles: output({
        lanesOverThisWeek: z.number().int(),
        freeMinutesNext4Weeks: output({ lines: minutes(), workCentres: minutes() }),
        mostLoadedThisWeek: output({ kind: z.enum(LANE_KINDS), id: id(), code: z.string(), loadPct: z.string() }).nullable(),
      }),
      /** Open work orders on no line: not on a line slot of the board and not allocated to a line. */
      workOrdersWithoutLine: z.number().int(),
    }),
  },
})
export type CapacityQuery = z.infer<typeof capacityContract.querystring>

export const capacityCellContract = defineContract({
  querystring: input({ siteId: id(), laneKind: z.enum(LANE_KINDS), laneId: id(), from: businessDate(), to: businessDate() }),
  response: {
    200: output({
      lane: output({ kind: z.enum(LANE_KINDS), id: id(), code: z.string(), name: z.string() }),
      from: businessDate(),
      to: businessDate(),
      availableMinutes: minutes(),
      bookedMinutes: minutes(),
      loadPct: z.string().nullable(),
      words: z.string(),
      /** The open work orders' operations booked in these days, the largest first. */
      orders: z.array(
        output({
          workOrder: output({ id: id(), number: z.string(), status: z.string(), dueDate: businessDate().nullable(), style: named }),
          operation: output({ id: id(), seq: z.number().int(), code: z.string(), name: z.string(), standardMinutes: z.string() }),
          /** Garments still to do at the operation. */
          pieces: z.number().int(),
          minutes: minutes(),
          /** Of the cell's booked minutes, one decimal. */
          sharePct: z.string(),
          /** SLOT: the planning board's working plan; DUE_DATE: not on the board, on its due date. */
          placedBy: z.enum(['SLOT', 'DUE_DATE']),
          slot: output({ id: id(), startAt: instant(), endAt: instant() }).nullable(),
        }),
      ),
    }),
  },
})
export type CapacityCellQuery = z.infer<typeof capacityCellContract.querystring>

import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { HEAT_BANDS } from '@nexus/factory-domain/planning/heatmap/bands'
import { ADHERENCE_STATES, COVER_STATES, LANE_KINDS, PLAN_SOURCES, PLANNING_REPORT_LIMITS } from '@nexus/factory-domain/planning/reports/rules'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { WORK_ORDER_STATUSES } from '@nexus/factory-domain/production/work-orders/machine'

/**
 * Planning reports (B-W2b-349; design planning.reports SCR-254: sec adherence, sec utilisation, sec cover, pop drill). Office
 * only, read only, one site. No money in this page: minutes and days are decimal strings or integers, quantities decimal
 * strings in the material's base unit (four decimals). No field names a person: work is per line, work centre, the plant and
 * workshop. The querystrings are strict: an unknown key is refused.
 */

const siteView = output({ id: id(), companyId: id(), code: z.string(), name: z.string(), timeZone: z.string() })
const scope = {
  siteId: id(),
  /** Default this month so far (the site's days): the monthly planning review. */
  from: businessDate().optional(),
  to: businessDate().optional(),
}
const head = { site: siteView, from: businessDate(), to: businessDate(), today: businessDate(), asOf: instant() }
const ref = output({ id: id(), code: z.string(), name: z.string() })
const pct = () => z.string().regex(/^\d{1,5}\.\d$/).nullable()
const weekKey = () => z.string().regex(/^\d{4}-W\d{2}$/)

// ---- schedule adherence (PLN-202) --------------------------------------------------------------------------------------------

const adherenceFigures = output({
  finished: z.number().int(),
  /** On a plan (measured), on time, late, on no plan (counted apart). */
  planned: z.number().int(),
  onTime: z.number().int(),
  late: z.number().int(),
  notPlanned: z.number().int(),
  /** On time ÷ measured (null: none measured). */
  onTimePct: pct(),
  startedLate: z.number().int(),
  /** Mean days late (+) or early (−) at finish and start, one decimal. */
  meanFinishDays: z.string().nullable(),
  meanStartDays: z.string().nullable(),
})
const week = output({ key: weekKey(), from: businessDate(), to: businessDate() })

export const adherenceContract = defineContract({
  querystring: input(scope),
  response: {
    200: output({
      ...head,
      /** The period's weeks (the first and last clipped), each with the work orders finished in it. */
      weeks: z.array(output({ ...week.shape, figures: adherenceFigures })),
      /** Per line the work orders are allocated to (line null: not allocated to a line), by code. */
      lines: z.array(output({ line: ref.nullable(), figures: adherenceFigures, weeks: z.array(output({ key: weekKey(), figures: adherenceFigures })) })),
      all: adherenceFigures,
      /** Every finished work order of the period was read (at most 5,000). */
      complete: z.boolean(),
    }),
  },
})
export type AdherenceQuery = z.infer<typeof adherenceContract.querystring>

export const adherenceWorkOrdersContract = defineContract({
  querystring: input({
    ...scope,
    /** A line's work orders, or `none` (not allocated to a line); default every line. */
    lineId: z.union([id(), z.literal('none')]).optional(),
    /** One week of the period (2026-W46); default the whole period. */
    week: weekKey().optional(),
    state: z.enum(ADHERENCE_STATES).optional(),
  }),
  response: {
    200: output({
      ...head,
      line: ref.nullable(),
      week: week.nullable(),
      figures: adherenceFigures,
      rows: z.array(
        output({
          workOrder: output({ id: id(), number: z.string(), kind: z.string(), status: z.enum(WORK_ORDER_STATUSES), dueDate: businessDate().nullable(), rush: z.boolean(), style: ref }),
          line: ref.nullable(),
          /** The plan it is measured against (null: never on the board). */
          planned: output({ source: z.enum(PLAN_SOURCES), number: z.number().int().nullable(), startAt: instant(), endAt: instant() }).nullable(),
          actual: output({ startAt: instant().nullable(), finishAt: instant() }),
          state: z.enum(ADHERENCE_STATES),
          startDays: z.number().int().nullable(),
          finishDays: z.number().int().nullable(),
        }),
      ),
      /** Rows beyond the first 500. */
      more: z.number().int(),
    }),
  },
})
export type AdherenceWorkOrdersQuery = z.infer<typeof adherenceWorkOrdersContract.querystring>

// ---- the utilisation trend (PLN-204) -------------------------------------------------------------------------------------------

const ahead = z.coerce.number().int().min(PLANNING_REPORT_LIMITS.ahead.min).max(PLANNING_REPORT_LIMITS.ahead.max).optional()
const reportWeek = output({
  key: weekKey(),
  from: businessDate(),
  to: businessDate(),
  /** Days of the period (what happened) / this week or later (the plan's load). */
  actual: z.boolean(),
  ahead: z.boolean(),
  actualDays: output({ from: businessDate(), to: businessDate() }).nullable(),
})

export const utilisationContract = defineContract({
  querystring: input({ ...scope, ahead }),
  response: {
    200: output({
      ...head,
      weeks: z.array(reportWeek),
      lanes: z.array(
        output({
          kind: z.enum(LANE_KINDS),
          /** The line, work centre or workshop (null: the plant, every line and work centre of the site). */
          id: id().nullable(),
          code: z.string().nullable(),
          name: z.string().nullable(),
          workCentreKind: z.string().nullable(),
          /** A workshop's capacity unit (MINUTES, PIECES); in-house lanes count minutes. */
          unit: z.string().nullable(),
          /** The lane's planned efficiency (Planning settings), the utilisation's yardstick (null: the plant, a workshop). */
          plannedEfficiencyPct: z.string().nullable(),
          cells: z.array(
            output({
              key: weekKey(),
              /** What happened (the period's days): earned standard minutes ÷ the minutes its people were there (people × working time). */
              earnedMinutes: z.string().nullable(),
              availableMinutes: z.string().nullable(),
              utilisationPct: pct(),
              /** The plan's load (this week and later): booked ÷ capacity in the lane's unit, as Capacity & load and the heatmap count it. */
              booked: z.string().nullable(),
              capacity: z.string().nullable(),
              loadPct: pct(),
              band: z.enum(HEAT_BANDS),
            }),
          ),
        }),
      ),
    }),
  },
})
export type UtilisationQuery = z.infer<typeof utilisationContract.querystring>

export const utilisationWorkOrdersContract = defineContract({
  querystring: input({ ...scope, ahead, laneKind: z.enum(['PLANT', 'LINE', 'WORK_CENTRE']), laneId: id().optional(), week: weekKey() }),
  response: {
    200: output({
      ...head,
      lane: output({ kind: z.enum(LANE_KINDS), id: id().nullable(), code: z.string().nullable(), name: z.string().nullable() }),
      week: reportWeek,
      /** The work orders whose scans earned the minutes (the period's days of the week; null: none of the period). */
      earned: output({
        minutes: z.string(),
        rows: z.array(
          output({
            workOrder: output({ id: id(), number: z.string(), status: z.enum(WORK_ORDER_STATUSES), style: ref }),
            operation: output({ id: id(), seq: z.number().int(), code: z.string(), name: z.string() }),
            lane: output({ kind: z.enum(['LINE', 'WORK_CENTRE']), code: z.string() }),
            /** Good whole garments reported at the operation that week. */
            garments: z.number().int(),
            minutes: z.string(),
          }),
        ),
        more: z.number().int(),
      }).nullable(),
      /** The work orders that book the plan's load (this week or later; null: a past week). */
      booked: output({
        minutes: z.string(),
        rows: z.array(
          output({
            workOrder: output({ id: id(), number: z.string(), status: z.enum(WORK_ORDER_STATUSES), style: ref }),
            operation: output({ id: id(), seq: z.number().int(), code: z.string(), name: z.string() }),
            lane: output({ kind: z.enum(['LINE', 'WORK_CENTRE']), code: z.string() }),
            pieces: z.number().int(),
            minutes: z.string(),
            placedBy: z.enum(['SLOT', 'DUE_DATE']),
          }),
        ),
        more: z.number().int(),
      }).nullable(),
    }),
  },
})
export type UtilisationWorkOrdersQuery = z.infer<typeof utilisationWorkOrdersContract.querystring>

// ---- material cover (PLN-207) --------------------------------------------------------------------------------------------------

export const coverContract = defineContract({
  querystring: input({ siteId: id(), weeks: z.coerce.number().int().min(PLANNING_REPORT_LIMITS.coverWeeks.min).max(PLANNING_REPORT_LIMITS.coverWeeks.max).optional() }),
  response: {
    200: output({
      site: siteView,
      today: businessDate(),
      asOf: instant(),
      /** The weeks from this week's Monday (the item profile's horizon). */
      horizon: output({ from: businessDate(), to: businessDate(), weeks: z.number().int(), days: z.number().int() }),
      counts: output({ materials: z.number().int(), shortNow: z.number().int(), stockOut: z.number().int(), belowSafety: z.number().int(), covered: z.number().int() }),
      rows: z.array(
        output({
          item: output({ id: id(), code: z.string(), name: z.string(), kind: z.string(), baseUom: z.enum(UOMS) }),
          colour: ref.nullable(),
          /** BUY or MAKE (the plan's line). */
          action: z.enum(['BUY', 'MAKE']),
          onHand: z.string(),
          safetyStock: z.string().nullable(),
          /** Within the horizon: what the orders still need (late demand included) and the open purchase lines due. */
          demand: z.string(),
          receipts: z.string(),
          projectedEnd: z.string(),
          stockOutOn: businessDate().nullable(),
          belowSafetyOn: businessDate().nullable(),
          daysOfCover: z.number().int().nullable(),
          state: z.enum(COVER_STATES),
          /** The item profile's first short week (2026-W47, PAST, LATER; null: none). */
          firstShort: z.string().nullable(),
          /** What the plan still has to order (after a firm planned order). */
          uncovered: z.string(),
          /** The open purchase order lines of the material (all of them, also overdue ones). */
          openPurchases: output({
            orders: z.number().int(),
            lines: z.number().int(),
            quantity: z.string(),
            next: output({ day: businessDate(), purchaseOrderId: id(), number: z.string(), quantity: z.string() }).nullable(),
          }),
        }),
      ),
      /** Materials beyond the first 500 (counted in `counts`). */
      more: z.number().int(),
    }),
  },
})
export type CoverQuery = z.infer<typeof coverContract.querystring>

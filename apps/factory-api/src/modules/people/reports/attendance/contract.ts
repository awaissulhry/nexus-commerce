import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { CORRECTION_KINDS } from '@nexus/factory-domain/people/close/rules'
import { MATCH_STATES, REPORT_GROUPS } from '@nexus/factory-domain/people/reports/attendance/report'

/**
 * The attendance report and attendance against production minutes (B-W2b-48; MES-303, MES-236; design people.reports
 * "Attendance report"). Office only, no money. A list carries a group's sums, never a person (Owner answer W1); a group under
 * the company's minimum size carries none (ANA-075); one person's month opens one record.
 */

const month = z.string().regex(/^\d{4}-\d{2}$/)
const count = z.number().int().min(0)

const groupFigures = output({
  ordinaryMinutes: count,
  presentMinutes: count,
  nightMinutes: count,
  holidayMinutes: count,
  overtimeDayMinutes: count,
  overtimeNightMinutes: count,
  overtimeHolidayMinutes: count,
  absenceMinutes: count,
  absences: z.array(output({ code: z.string(), minutes: count })),
})

const reportQuery = input({
  siteId: id(),
  month: month.optional(),
  teamId: id().optional(),
  lineId: id().optional(),
  /** Refused when it names a person (a list never filters or groups by person, Owner answer W1). */
  employeeId: z.string().max(64).optional(),
  groupBy: z.enum([...REPORT_GROUPS, 'employeeId', 'workerId', 'personId']).optional(),
})
export type ReportQuery = z.infer<typeof reportQuery>

export const reportContract = defineContract({
  querystring: reportQuery,
  response: {
    200: output({
      siteId: id(),
      month,
      groupBy: z.enum(REPORT_GROUPS),
      groups: z.array(output({ id: id().nullable(), code: z.string().nullable(), name: z.string().nullable(), people: count.nullable(), tooFew: z.boolean(), words: z.string().nullable(), figures: groupFigures.nullable() })),
      /** Null: too few people, or the sum would give away a hidden group. */
      summary: output({ people: count, figures: groupFigures }).nullable(),
      /** "Matches the closed LUL for October" or "Differs in 2 cells". */
      match: output({ state: z.enum(MATCH_STATES), cells: count, words: z.string() }),
      /** The month is closed: only a correction changes these figures. */
      final: z.boolean(),
      words: z.array(z.string()),
    }),
  },
})

const differencesQuery = input({ siteId: id(), month })
export type DifferencesQuery = z.infer<typeof differencesQuery>

export const differencesContract = defineContract({
  querystring: differencesQuery,
  response: { 200: output({ siteId: id(), month, cells: z.array(output({ dayId: id(), date: businessDate(), kind: z.enum(CORRECTION_KINDS), absenceCode: z.string().nullable() })), words: z.array(z.string()) }) },
})

const personMonthQuery = input({ month: month.optional() })
export type PersonMonthQuery = z.infer<typeof personMonthQuery>

export const personMonthContract = defineContract({
  params: input({ employeeId: id() }),
  querystring: personMonthQuery,
  response: {
    200: output({
      person: output({ employeeId: id(), name: z.string(), displayName: z.string().nullable(), employeeCode: z.string().nullable(), siteId: id() }),
      month,
      monthState: z.enum(['OPEN', 'CLOSED']),
      closedAt: instant().nullable(),
      figures: groupFigures,
      daysShown: count,
      differs: z.boolean(),
      days: z.array(output({ id: id(), date: businessDate(), status: z.string(), manual: z.boolean(), corrected: z.boolean() })),
    }),
  },
})

const attendedQuery = input({ siteId: id(), month: month.optional(), lineId: id().optional() })
export type AttendedQuery = z.infer<typeof attendedQuery>

const attendedFigures = output({ attendedMinutes: count, productionMinutes: z.string(), offStandardMinutes: count, gapMinutes: z.string(), coveredPct: z.string().nullable() })

export const attendedContract = defineContract({
  querystring: attendedQuery,
  response: {
    200: output({
      siteId: id(),
      month,
      lines: z.array(output({ line: output({ id: id(), code: z.string(), name: z.string() }), people: count.nullable(), tooFew: z.boolean(), words: z.string().nullable(), figures: attendedFigures.nullable() })),
      summary: output({ people: count, figures: attendedFigures }).nullable(),
      words: z.array(z.string()),
    }),
  },
})

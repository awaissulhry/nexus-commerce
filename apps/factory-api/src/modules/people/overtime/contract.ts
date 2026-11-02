import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { ABSENCE_CATEGORIES } from '@nexus/factory-domain/people/attendance/absences'
import { DAY_STATUSES } from '@nexus/factory-domain/people/attendance/rules'
import { CHECKED_LIMITS, LIMIT_STATES } from '@nexus/factory-domain/people/limits/checks'
import { RULE_ACTIONS } from '@nexus/factory-domain/people/limits/rules'
import { ENTRY_HOLDS, ENTRY_STATUSES, OVERTIME_CLASSES, OVERTIME_RULES } from '@nexus/factory-domain/people/overtime/rules'
import { TIMESHEET_HOLDS, TIMESHEET_RULES, TIMESHEET_STAGES, TIMESHEET_STATUSES } from '@nexus/factory-domain/people/overtime/timesheets'
import { OVERTIME_STATUSES } from '@nexus/factory-domain/people/shifts/rules'
import { checkOut } from '../limits/contract'

/**
 * Overtime worked and timesheets (B-W2b-42; MES-229, MES-230; design people.attendance "Overtime to approve", pop-up
 * "Reject overtime", new tab "Person timesheet"). Office only. No money. A list never names a person nor carries one
 * person's minutes (Owner answer W1; Statuto dei Lavoratori art. 4): its rows carry a state and a tone per limit; the name
 * and the figures open one record at a time. Every write carries the version read.
 */

const version = z.number().int().min(1)
const reason = z.string().min(OVERTIME_RULES.reasonMin).max(OVERTIME_RULES.reasonMax)
const month = z.string().regex(/^\d{4}-\d{2}$/)

const tone = output({ rule: z.enum(CHECKED_LIMITS), state: z.enum(LIMIT_STATES), level: z.enum(RULE_ACTIONS) })
const entryRow = output({
  id: id(),
  date: businessDate(),
  siteId: id(),
  teamId: id().nullable(),
  lineId: id().nullable(),
  class: z.enum(OVERTIME_CLASSES),
  status: z.enum(ENTRY_STATUSES),
  /** The planned request it was worked for; null: nobody planned it. */
  requestId: id().nullable(),
  checks: z.array(tone),
  version: z.number().int(),
})

export const entriesContract = defineContract({
  querystring: input({
    siteId: id(),
    from: businessDate().optional(),
    to: businessDate().optional(),
    teamId: id().optional(),
    lineId: id().optional(),
    status: z.enum(ENTRY_STATUSES).optional(),
    class: z.enum(OVERTIME_CLASSES).optional(),
    planned: z.enum(['true', 'false']).optional(),
    /** Refused when it names a person (a list never filters or groups by person, Owner answer W1). */
    employeeId: z.string().max(64).optional(),
    groupBy: z.enum(['date', 'team', 'line', 'employeeId', 'workerId', 'personId']).optional(),
    cursor: z.string().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(OVERTIME_RULES.listLimit).optional(),
  }),
  response: { 200: output({ siteId: id(), from: businessDate(), to: businessDate(), entries: z.array(entryRow), nextCursor: z.string().nullable(), words: z.array(z.string()) }) },
})

const tile = z.number().int().min(0).nullable()
export const entryCountsContract = defineContract({
  querystring: input({ siteId: id(), from: businessDate().optional(), to: businessDate().optional(), teamId: id().optional(), lineId: id().optional() }),
  response: {
    200: output({
      siteId: id(),
      from: businessDate(),
      to: businessDate(),
      /** The people in the selection (null: too few to show any figure). */
      people: tile,
      tooFew: z.boolean(),
      words: z.string().nullable(),
      tiles: output({ waitingEntries: tile, waitingMinutes: tile, notPlanned: tile }),
    }),
  },
})

export const entryOut = output({
  id: id(),
  date: businessDate(),
  siteId: id(),
  companyId: id(),
  class: z.enum(OVERTIME_CLASSES),
  minutes: z.number().int(),
  status: z.enum(ENTRY_STATUSES),
  version: z.number().int(),
  person: output({ employeeId: id(), name: z.string(), displayName: z.string(), employeeCode: z.string().nullable() }),
  day: output({ id: id(), status: z.enum(DAY_STATUSES), overtimeMinutes: z.number().int(), nightMinutes: z.number().int(), holidayMinutes: z.number().int(), manual: z.boolean() }).nullable(),
  request: output({ id: id(), date: businessDate(), minutes: z.number().int(), status: z.enum(OVERTIME_STATUSES) }).nullable(),
  beyondRequestMinutes: z.number().int().nullable(),
  decision: output({ approvedAt: instant().nullable(), approvedBy: z.string().nullable(), rejectedAt: instant().nullable(), rejectedBy: z.string().nullable(), rejectReason: z.string().nullable() }),
  /** The year's cap, the rest and the weekly average, each with the law in words. */
  checks: z.array(checkOut),
  holds: z.array(output({ code: z.enum(ENTRY_HOLDS), words: z.string() })),
  actions: output({ approve: z.boolean(), reject: z.boolean(), reopen: z.boolean() }),
  words: z.array(z.string()),
})

export const entryDetailContract = defineContract({ params: input({ entryId: id() }), response: { 200: entryOut } })

export const approveEntryContract = defineContract({
  params: input({ entryId: id() }),
  /** overrideReason: a limit that blocks stands, and why (the hours were worked). */
  body: input({ version, overrideReason: reason.optional() }),
  response: { 200: entryOut },
})

export const rejectEntryContract = defineContract({ params: input({ entryId: id() }), body: input({ version, reason }), response: { 200: entryOut } })
export const reopenEntryContract = defineContract({ params: input({ entryId: id() }), body: input({ version, reason }), response: { 200: entryOut } })

// ---- timesheets --------------------------------------------------------------------------------------------------------

export const timesheetsContract = defineContract({
  querystring: input({
    siteId: id(),
    month: month.optional(),
    teamId: id().optional(),
    lineId: id().optional(),
    status: z.enum(TIMESHEET_STATUSES).optional(),
    /** Refused when it names a person (Owner answer W1). */
    employeeId: z.string().max(64).optional(),
    cursor: id().optional(),
    limit: z.coerce.number().int().min(1).max(TIMESHEET_RULES.listLimit).optional(),
  }),
  response: {
    200: output({
      siteId: id(),
      month: z.string(),
      timesheets: z.array(
        output({
          id: id(),
          periodStart: businessDate(),
          periodEnd: businessDate(),
          status: z.enum(TIMESHEET_STATUSES),
          /** Whose turn: the lead, HR, nobody. */
          stage: z.enum(TIMESHEET_STAGES),
          teamId: id().nullable(),
          lineId: id().nullable(),
          ready: z.boolean(),
          returned: z.boolean(),
          version: z.number().int(),
        }),
      ),
      nextCursor: id().nullable(),
      canPrepare: z.boolean(),
      words: z.array(z.string()),
    }),
  },
})

export const prepareTimesheetsContract = defineContract({
  body: input({ siteId: id(), month }),
  response: { 200: output({ siteId: id(), month: z.string(), created: z.number().int(), existing: z.number().int() }) },
})

const holds = z.array(output({ code: z.enum(TIMESHEET_HOLDS), words: z.string() }))

export const timesheetOut = output({
  id: id(),
  periodStart: businessDate(),
  periodEnd: businessDate(),
  status: z.enum(TIMESHEET_STATUSES),
  stage: z.enum(TIMESHEET_STAGES),
  version: z.number().int(),
  person: output({ employeeId: id(), name: z.string(), displayName: z.string(), employeeCode: z.string().nullable(), siteId: id() }),
  lead: output({ approvedAt: instant().nullable(), approvedBy: z.string().nullable() }),
  hr: output({ approvedAt: instant().nullable(), approvedBy: z.string().nullable() }),
  returned: output({ at: instant(), by: z.string().nullable(), reason: z.string() }).nullable(),
  /** False: a lead's view, each day's state and no minutes. */
  figuresShown: z.boolean(),
  days: z.array(
    output({
      id: id(),
      date: businessDate(),
      status: z.enum(DAY_STATUSES),
      plannedLabel: z.string().nullable(),
      presence: z.boolean(),
      absent: z.boolean(),
      anomaliesOpen: z.number().int(),
      manual: z.boolean(),
      figures: output({ firstInAt: instant().nullable(), lastOutAt: instant().nullable(), presentMinutes: z.number().int(), ordinaryMinutes: z.number().int(), nightMinutes: z.number().int(), holidayMinutes: z.number().int(), absenceMinutes: z.number().int() }).nullable(),
      absences: z.array(output({ code: z.string(), category: z.enum(ABSENCE_CATEGORIES), minutes: z.number().int() })).nullable(),
      overtime: z.array(output({ class: z.enum(OVERTIME_CLASSES), minutes: z.number().int(), status: z.enum(ENTRY_STATUSES) })).nullable(),
    }),
  ),
  summary: output({ daysPresent: z.number().int(), presentMinutes: z.number().int(), ordinaryMinutes: z.number().int(), nightMinutes: z.number().int(), holidayMinutes: z.number().int(), absenceMinutes: z.number().int(), overtimeApprovedMinutes: z.number().int(), overtimePendingMinutes: z.number().int(), overtimeRejectedMinutes: z.number().int() }).nullable(),
  holds: output({ lead: holds, hr: holds }),
  /** An approved timesheet whose days moved since (a late event): send it back. */
  changedSince: z.boolean(),
  actions: output({ leadApprove: z.boolean(), hrApprove: z.boolean(), sendBack: z.boolean() }),
  words: z.array(z.string()),
})

export const timesheetDetailContract = defineContract({ params: input({ timesheetId: id() }), response: { 200: timesheetOut } })
export const approveTimesheetContract = defineContract({ params: input({ timesheetId: id() }), body: input({ version }), response: { 200: timesheetOut } })
export const sendBackContract = defineContract({ params: input({ timesheetId: id() }), body: input({ version, reason: z.string().min(TIMESHEET_RULES.reasonMin).max(TIMESHEET_RULES.reasonMax) }), response: { 200: timesheetOut } })

export type EntriesQuery = z.infer<typeof entriesContract.querystring>
export type EntryCountsQuery = z.infer<typeof entryCountsContract.querystring>
export type TimesheetsQuery = z.infer<typeof timesheetsContract.querystring>

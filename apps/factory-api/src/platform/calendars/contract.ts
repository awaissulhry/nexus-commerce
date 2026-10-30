import { z } from 'zod'
import { CALENDAR_LIMITS } from '@nexus/factory-domain/calendars/rules'
import { HOLIDAY_SETS, HOLIDAY_YEARS } from '@nexus/factory-domain/calendars/holidays'
import { PATTERN_CODE, PATTERN_LIMITS, SEGMENT_KINDS } from '@nexus/factory-domain/calendars/patterns'
import { CALENDAR_SCOPES, DAY_KINDS } from '@nexus/factory-domain/calendars/working-time'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'

/**
 * Business calendars and shift patterns (B-W2a-08; PLT-103, PLN-001, PLN-002; design planning.settings "Calendars &
 * shifts", admin.org "Working days and holidays", Purchasing › Supplier closures): the calendars of companies, sites,
 * lines, workshops and suppliers with their dated days (holidays, closures, extra working days), the shift patterns
 * with their shifts and breaks, and the questions every module asks the same way: working time over days, working
 * minutes between two times, the next working day, a supplier's closed days and the order-by date across them.
 * Every write carries the version it read (days: optional); calendars and patterns are archived, never deleted.
 */

export const MASTER_STATUSES = ['ACTIVE', 'ARCHIVED'] as const
const DAY_REASONS = ['WEEK', 'DAY_OFF', 'HOLIDAY', 'CLOSURE', 'WORKING'] as const

const version = z.number().int().min(1)
const name = () => z.string().trim().min(1).max(CALENDAR_LIMITS.name)
const reason = z.string().trim().min(1).max(CALENDAR_LIMITS.reason).optional()
const weekdays = z.array(z.number().int().min(1).max(7)).min(1).max(7)
const flag = z.enum(['true', 'false']).optional()

export const patternRef = output({ id: id(), code: z.string(), name: z.string(), status: z.enum(MASTER_STATUSES) })

export const calendarView = output({
  id: id(),
  scope: z.enum(CALENDAR_SCOPES),
  companyId: id().nullable(),
  siteId: id().nullable(),
  lineId: id().nullable(),
  workCentreId: id().nullable(),
  partyId: id().nullable(),
  /** Whose calendar it is, as the screens name it: the owner's code and name. */
  owner: output({ code: z.string(), name: z.string() }),
  name: z.string(),
  workingWeekdays: z.array(z.number().int()),
  shiftPattern: patternRef.nullable(),
  status: z.enum(MASTER_STATUSES),
  /** Dated days set on it (every date). */
  exceptions: z.number().int(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type CalendarView = z.infer<typeof calendarView>

export const dayView = output({
  id: id(),
  date: businessDate(),
  kind: z.enum(DAY_KINDS),
  name: z.string(),
  shiftPattern: patternRef.nullable(),
  note: z.string().nullable(),
  /** The public holiday list it was loaded from (`IT`); null: set by a person. */
  holidaySet: z.string().nullable(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type DayView = z.infer<typeof dayView>

const segmentView = output({
  id: id(),
  weekday: z.number().int(),
  kind: z.enum(SEGMENT_KINDS),
  label: z.string().nullable(),
  startMinute: z.number().int(),
  endMinute: z.number().int(),
  /** `HH:MM` (a night shift's end is the next morning's time). */
  start: z.string(),
  end: z.string(),
})
const weekdayView = output({
  weekday: z.number().int(),
  /** Nominal working minutes (the wall clock): the shifts less their breaks. */
  minutes: z.number().int(),
  shifts: z.array(
    output({
      label: z.string().nullable(),
      startMinute: z.number().int(),
      endMinute: z.number().int(),
      minutes: z.number().int(),
      breaks: z.array(output({ label: z.string().nullable(), startMinute: z.number().int(), endMinute: z.number().int() })),
    }),
  ),
})
export const patternView = output({
  id: id(),
  companyId: id().nullable(),
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  /** The shifts in one line ("06:00-14:00 and 14:00-22:00, Monday to Friday"). */
  summary: z.string(),
  status: z.enum(MASTER_STATUSES),
  segments: z.array(segmentView),
  weekdays: z.array(weekdayView),
  weeklyMinutes: z.number().int(),
  /** When the shifts end (`HH:MM`): what the site's floor sign-out times would be if taken from this pattern. */
  shiftEnds: z.array(z.string()),
  /** ACTIVE calendars that use it. */
  calendars: z.number().int(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type PatternView = z.infer<typeof patternView>

const segmentInput = input({
  weekday: z.number().int(),
  kind: z.enum(SEGMENT_KINDS),
  label: z.string().trim().max(PATTERN_LIMITS.label).nullable().optional(),
  startMinute: z.number().int(),
  endMinute: z.number().int(),
})
export type SegmentInput = z.infer<typeof segmentInput>

// ---- calendars ------------------------------------------------------------------------------------------------------

export const listCalendarsContract = defineContract({
  querystring: input({ scope: z.enum(CALENDAR_SCOPES).optional(), companyId: id().optional(), siteId: id().optional(), partyId: id().optional(), includeArchived: flag }),
  response: { 200: output({ calendars: z.array(calendarView) }) },
})

export const getCalendarContract = defineContract({
  params: input({ calendarId: id() }),
  querystring: input({ from: businessDate().optional(), to: businessDate().optional() }),
  response: {
    200: output({
      calendar: calendarView,
      /** The ACTIVE calendars it reads from, the next one first (a line: its site's, then its company's). */
      above: z.array(calendarView),
      from: businessDate(),
      to: businessDate(),
      days: z.array(dayView),
    }),
  },
})

export const createCalendarContract = defineContract({
  body: input({
    scope: z.enum(CALENDAR_SCOPES),
    /** The company, site, line, work centre or supplier (party) whose calendar it is. */
    ownerId: id(),
    name: name().optional(),
    workingWeekdays: weekdays.optional(),
    shiftPatternId: id().nullable().optional(),
  }),
  response: { 201: output({ calendar: calendarView }) },
})
export type CreateCalendarBody = z.infer<typeof createCalendarContract.body>

export const editCalendarContract = defineContract({
  params: input({ calendarId: id() }),
  body: input({ version, name: name().optional(), workingWeekdays: weekdays.optional(), shiftPatternId: id().nullable().optional(), reason }),
  response: { 200: output({ calendar: calendarView }) },
})
export type EditCalendarBody = z.infer<typeof editCalendarContract.body>

export const archiveCalendarContract = defineContract({
  params: input({ calendarId: id() }),
  body: input({ version, reason }),
  response: { 200: output({ calendar: calendarView }) },
})

export const setDaysContract = defineContract({
  params: input({ calendarId: id() }),
  body: input({
    version: version.optional(),
    from: businessDate(),
    /** The last day of a closure or holiday range; default `from`. */
    to: businessDate().optional(),
    kind: z.enum(DAY_KINDS),
    name: z.string().trim().min(1).max(CALENDAR_LIMITS.dayName),
    /** Only on a WORKING day of ours: that day's pattern (an extra shift, a short day). */
    shiftPatternId: id().nullable().optional(),
    note: z.string().trim().max(CALENDAR_LIMITS.note).nullable().optional(),
    /** Replace the days already set in the range (else they are refused, each named). */
    replace: z.boolean().optional(),
  }),
  response: { 200: output({ calendar: calendarView, days: z.array(dayView), replaced: z.number().int() }) },
})
export type SetDaysBody = z.infer<typeof setDaysContract.body>

export const removeDaysContract = defineContract({
  params: input({ calendarId: id() }),
  body: input({ version: version.optional(), from: businessDate(), to: businessDate().optional() }),
  response: { 200: output({ calendar: calendarView, removed: z.array(businessDate()) }) },
})
export type RemoveDaysBody = z.infer<typeof removeDaysContract.body>

export const loadHolidaysContract = defineContract({
  params: input({ calendarId: id() }),
  body: input({ version: version.optional(), set: z.enum(HOLIDAY_SETS).optional(), year: z.number().int().min(HOLIDAY_YEARS.from).max(HOLIDAY_YEARS.to) }),
  response: {
    200: output({
      calendar: calendarView,
      added: z.array(dayView),
      /** The list's days the calendar already has a day for (kept as they are). */
      skipped: z.array(output({ date: businessDate(), name: z.string() })),
    }),
  },
})
export type LoadHolidaysBody = z.infer<typeof loadHolidaysContract.body>

// ---- shift patterns -------------------------------------------------------------------------------------------------

const patternCode = () => z.string().trim().toUpperCase().regex(PATTERN_CODE, 'Use 1 to 20 capital letters, digits or hyphens.')

export const listPatternsContract = defineContract({
  querystring: input({ companyId: id().optional(), includeArchived: flag }),
  response: { 200: output({ patterns: z.array(patternView) }) },
})

export const getPatternContract = defineContract({
  params: input({ patternId: id() }),
  response: { 200: output({ pattern: patternView, calendars: z.array(calendarView) }) },
})

export const createPatternContract = defineContract({
  body: input({
    /** The company that uses it; null or left out: every company's calendars (tenant-wide). */
    companyId: id().nullable().optional(),
    code: patternCode(),
    name: z.string().trim().min(1).max(PATTERN_LIMITS.name),
    description: z.string().trim().max(PATTERN_LIMITS.description).nullable().optional(),
    segments: z.array(segmentInput).max(PATTERN_LIMITS.segments),
  }),
  response: { 201: output({ pattern: patternView }) },
})
export type CreatePatternBody = z.infer<typeof createPatternContract.body>

export const editPatternContract = defineContract({
  params: input({ patternId: id() }),
  body: input({ version, name: z.string().trim().min(1).max(PATTERN_LIMITS.name).optional(), description: z.string().trim().max(PATTERN_LIMITS.description).nullable().optional(), reason }),
  response: { 200: output({ pattern: patternView }) },
})
export type EditPatternBody = z.infer<typeof editPatternContract.body>

export const saveSegmentsContract = defineContract({
  params: input({ patternId: id() }),
  body: input({ version, segments: z.array(segmentInput).max(PATTERN_LIMITS.segments), reason }),
  response: { 200: output({ pattern: patternView }) },
})
export type SaveSegmentsBody = z.infer<typeof saveSegmentsContract.body>

export const archivePatternContract = defineContract({
  params: input({ patternId: id() }),
  body: input({ version, reason }),
  response: { 200: output({ pattern: patternView }) },
})

// ---- the questions --------------------------------------------------------------------------------------------------

/** Exactly one owner: a company, a site, a line or a work centre (a workshop). */
const ownerQuery = { companyId: id().optional(), siteId: id().optional(), lineId: id().optional(), workCentreId: id().optional() }
export type OwnerQuery = { companyId?: string | undefined; siteId?: string | undefined; lineId?: string | undefined; workCentreId?: string | undefined }

const ownerView = output({
  scope: z.enum(CALENDAR_SCOPES),
  id: id(),
  code: z.string(),
  name: z.string(),
  companyId: id().nullable(),
  siteId: id().nullable(),
  timeZone: z.string(),
  /** The ACTIVE calendars its days are read from, most specific first (none: the planning default). */
  calendars: z.array(output({ id: id(), scope: z.enum(CALENDAR_SCOPES), name: z.string() })),
})

const workingDayView = output({
  date: businessDate(),
  weekday: z.number().int(),
  open: z.boolean(),
  working: z.boolean(),
  reason: z.enum(DAY_REASONS),
  name: z.string().nullable(),
  decidedBy: output({ calendarId: id(), scope: z.enum(CALENDAR_SCOPES) }).nullable(),
  /** The pattern in force; id `DEFAULT` is the planning default (one shift, Monday to Friday). */
  pattern: output({ id: z.string(), code: z.string(), name: z.string(), source: z.enum(['DAY', 'CALENDAR', 'DEFAULT']), calendarId: id().nullable() }).nullable(),
  shiftsOfWeekday: z.number().int().nullable(),
  /** Real working minutes (a night shift across the clock change counts what is worked); null for a supplier. */
  minutes: z.number().nullable(),
  shifts: z.array(
    output({
      label: z.string().nullable(),
      start: instant(),
      end: instant(),
      minutes: z.number(),
      breaks: z.array(output({ label: z.string().nullable(), start: instant(), end: instant() })),
    }),
  ),
  issue: z.enum(['NO_SHIFTS']).nullable(),
})
export type WorkingDayView = z.infer<typeof workingDayView>

export const workingTimeContract = defineContract({
  querystring: input({ ...ownerQuery, from: businessDate(), to: businessDate() }),
  response: { 200: output({ owner: ownerView, from: businessDate(), to: businessDate(), workingDays: z.number().int(), minutes: z.number(), days: z.array(workingDayView) }) },
})

export const workingMinutesContract = defineContract({
  querystring: input({ ...ownerQuery, from: instant(), to: instant() }),
  response: { 200: output({ owner: ownerView, from: instant(), to: instant(), minutes: z.number() }) },
})

export const nextWorkingDayContract = defineContract({
  querystring: input({ ...ownerQuery, after: businessDate(), days: z.coerce.number().int().min(-366).max(366).optional() }),
  response: {
    200: output({
      owner: ownerView,
      after: businessDate(),
      days: z.number().int(),
      /** The working day reached; null when none is in the next three years (a calendar closed for good). */
      date: businessDate().nullable(),
    }),
  },
})

const partyRef = output({ id: id(), code: z.string(), name: z.string() })
const closedDay = output({ date: businessDate(), kind: z.enum(['HOLIDAY', 'CLOSURE']), name: z.string() })
const closedSpan = output({ from: businessDate(), to: businessDate(), kind: z.enum(['HOLIDAY', 'CLOSURE']), name: z.string(), days: z.number().int() })

export const supplierClosedDaysContract = defineContract({
  querystring: input({ partyId: id(), from: businessDate(), to: businessDate() }),
  response: {
    200: output({
      party: partyRef,
      calendar: output({ id: id(), name: z.string() }).nullable(),
      from: businessDate(),
      to: businessDate(),
      /** ISO weekdays it never works in a normal week. */
      weeklyDaysOff: z.array(z.number().int()),
      closedDays: z.array(closedDay),
      spans: z.array(closedSpan),
    }),
  },
})

export const supplierOrderByContract = defineContract({
  querystring: input({ partyId: id(), needDate: businessDate(), leadTimeDays: z.coerce.number().int().min(0).max(3650) }),
  response: {
    200: output({
      party: partyRef,
      calendar: output({ id: id(), name: z.string() }).nullable(),
      needDate: businessDate(),
      leadTimeDays: z.number().int(),
      /** The need date less the lead time, the supplier's closed days not counted. */
      orderBy: businessDate(),
      skipped: z.array(closedDay),
      spans: z.array(closedSpan),
      /** More closed days than a year were skipped: the date is not reliable. */
      capped: z.boolean(),
    }),
  },
})

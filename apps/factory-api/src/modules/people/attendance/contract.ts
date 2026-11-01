import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { CLOCK_FLAGS, CLOCK_KINDS, CLOCK_SOURCES } from '@nexus/factory-domain/people/clock/rules'
import { ABSENCE_CATEGORIES, ABSENCE_STATES } from '@nexus/factory-domain/people/attendance/absences'
import { ANOMALY_KINDS, ANOMALY_RESOLUTIONS, APPROVAL_HOLDS, ATTENDANCE_RULES, DAY_STATUSES, MANUAL_REASONS, ROUNDING_CHOICES } from '@nexus/factory-domain/people/attendance/rules'

/**
 * Attendance days (B-W2b-37; MES-225, MES-226, MES-228, MES-233, MES-238; design people.attendance SCR-157, people.settings
 * "Rounding, tolerance and grace" and "Absence codes"). Office only. No money anywhere. A list never names a person nor
 * carries one person's minutes (Owner answer W1; Statuto dei Lavoratori art. 4): its rows are days with their state;
 * one person's day (name, clock events, minutes) opens one record at a time. Every write carries the version read and,
 * for a manual entry or a fix, its reason.
 */

const reason = z.string().min(ATTENDANCE_RULES.reasonMin).max(ATTENDANCE_RULES.reasonMax)
const version = z.number().int().min(1)

const plannedOut = output({ label: z.string().nullable(), startMinute: z.number().int(), endMinute: z.number().int(), minutes: z.number().int() }).nullable()

/** A day as a list shows it: no name, no minutes (Owner answer W1). */
const dayRowOut = output({
  id: id(),
  date: businessDate(),
  siteId: id(),
  teamId: id().nullable(),
  lineId: id().nullable(),
  status: z.enum(DAY_STATUSES),
  planned: plannedOut,
  /** Someone clocked in that day (the inline absence code is offered only when nobody did). */
  presence: z.boolean(),
  anomalies: output({ open: z.number().int().min(0), kinds: z.array(z.enum(ANOMALY_KINDS)) }),
  manual: z.boolean(),
  absence: z.enum(ABSENCE_STATES),
  approvedAt: instant().nullable(),
  version: z.number().int(),
})

export const listDaysContract = defineContract({
  querystring: input({
    siteId: id(),
    from: businessDate().optional(),
    to: businessDate().optional(),
    teamId: id().optional(),
    lineId: id().optional(),
    status: z.enum(DAY_STATUSES).optional(),
    anomaly: z.enum(ANOMALY_KINDS).optional(),
    manual: z.enum(['true', 'false']).optional(),
    /** Refused when it names a person (a list never filters or groups by person, Owner answer W1). */
    employeeId: z.string().max(64).optional(),
    groupBy: z.enum(['date', 'team', 'line', 'employeeId', 'workerId', 'personId']).optional(),
    cursor: z.string().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(ATTENDANCE_RULES.listLimit).optional(),
  }),
  response: { 200: output({ siteId: id(), from: businessDate(), to: businessDate(), today: businessDate(), days: z.array(dayRowOut), nextCursor: z.string().nullable(), words: z.array(z.string()) }) },
})

const tile = z.number().int().min(0).nullable()
export const countsContract = defineContract({
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
      tiles: output({ openAnomalies: tile, daysToApprove: tile, cleanDaysToApprove: tile, absencesWithoutCode: tile, manualDays: tile, clockedInNow: tile }),
    }),
  },
})

const eventOut = output({
  id: id(),
  kind: z.enum(CLOCK_KINDS),
  source: z.enum(CLOCK_SOURCES),
  occurredAt: instant(),
  siteId: id(),
  flags: z.array(z.enum(CLOCK_FLAGS)),
  /** MANUAL, VOID: the reason; AUTO: the rule in words. */
  reason: z.string().nullable(),
  offSite: z.boolean(),
  voidsEventId: id().nullable(),
  /** Voided by a later VOID event (kept, marked void). */
  voided: z.boolean(),
  /** "Badge on the tablet", "Name and PIN (forgot the badge)", "Automatic clock-out", "Entered by hand". */
  words: z.string(),
})

const anomalyOut = output({
  id: id(),
  kind: z.enum(ANOMALY_KINDS),
  ruleKey: z.string(),
  clockEventId: id().nullable(),
  workingTimeRuleId: id().nullable(),
  /** The anomaly in words. */
  words: z.string(),
  /** "How this anomaly is found": the rule and its setting. */
  rule: z.string(),
  raisedAt: instant(),
  resolution: z.enum(ANOMALY_RESOLUTIONS).nullable(),
  resolvedAt: instant().nullable(),
  resolutionNote: z.string().nullable(),
})

const absenceOut = output({
  id: id(),
  codeId: id(),
  code: z.string(),
  label: z.record(z.string(), z.string()),
  category: z.enum(ABSENCE_CATEGORIES),
  lulCode: z.string().nullable(),
  minutes: z.number().int(),
  /** A certificate's protocol number, never its content. */
  documentRef: z.string().nullable(),
  version: z.number().int(),
})

const figuresOut = output({
  firstInAt: instant().nullable(),
  lastOutAt: instant().nullable(),
  presentMinutes: z.number().int(),
  breakMinutes: z.number().int(),
  ordinaryMinutes: z.number().int(),
  overtimeMinutes: z.number().int(),
  nightMinutes: z.number().int(),
  holidayMinutes: z.number().int(),
  absenceMinutes: z.number().int(),
})

/** One person's day (design people.attendance "Day detail"): one record, the name inside it. */
export const dayDetailOut = output({
  id: id(),
  date: businessDate(),
  siteId: id(),
  companyId: id(),
  status: z.enum(DAY_STATUSES),
  version: z.number().int(),
  person: output({ employeeId: id(), name: z.string(), displayName: z.string(), employeeCode: z.string().nullable() }),
  planned: plannedOut,
  figures: figuresOut,
  computedAt: instant().nullable(),
  manual: z.boolean(),
  approvedAt: instant().nullable(),
  approvedById: id().nullable(),
  events: z.array(eventOut),
  anomalies: z.array(anomalyOut),
  absences: z.array(absenceOut),
  /** Why it cannot be approved now (empty: it can), each with its words. */
  holds: z.array(output({ code: z.enum(APPROVAL_HOLDS), words: z.string() })),
  actions: output({ approve: z.boolean(), fix: z.boolean(), reopen: z.boolean() }),
  words: z.array(z.string()),
})

export const dayDetailContract = defineContract({ params: input({ dayId: id() }), response: { 200: dayDetailOut } })

export const employeeDaysContract = defineContract({
  params: input({ employeeId: id() }),
  querystring: input({ from: businessDate().optional(), to: businessDate().optional() }),
  response: {
    200: output({
      person: output({ employeeId: id(), name: z.string(), displayName: z.string(), siteId: id() }),
      from: businessDate(),
      to: businessDate(),
      days: z.array(output({ id: id(), date: businessDate(), siteId: id(), status: z.enum(DAY_STATUSES), planned: plannedOut, figures: figuresOut, manual: z.boolean(), anomaliesOpen: z.number().int(), absences: z.array(output({ code: z.string(), category: z.enum(ABSENCE_CATEGORIES), minutes: z.number().int() })), version: z.number().int() })),
    }),
  },
})

// ---- writes -----------------------------------------------------------------------------------------------------------

const absenceIn = input({ codeId: id(), minutes: z.number().int().min(1).max(1440).optional(), documentRef: z.string().max(40).nullable().optional() })

/** Manual entry (design pop-up "Manual entry"): person, date, in / out or an absence code, the reason. */
export const manualEntryContract = defineContract({
  body: input({
    employeeId: id(),
    date: businessDate(),
    /** The site the person worked at that day (default: their own). */
    siteId: id().optional(),
    in: instant().optional(),
    out: instant().optional(),
    /** Work outside the plant (a customer visit, a fair): counted as presence. */
    offSite: z.boolean().optional(),
    absence: absenceIn.optional(),
    reasonCode: z.enum(MANUAL_REASONS).optional(),
    reason,
  }),
  response: { 200: dayDetailOut, 201: dayDetailOut },
})

const fixAction = z.discriminatedUnion('kind', [
  input({ kind: z.literal('ADD_EVENT'), event: z.enum(['IN', 'OUT', 'BREAK_OUT', 'BREAK_IN']), at: instant(), offSite: z.boolean().optional() }),
  input({ kind: z.literal('VOID_EVENT'), clockEventId: id() }),
  input({ kind: z.literal('SET_ABSENCE'), codeId: id(), minutes: z.number().int().min(1).max(1440).optional(), documentRef: z.string().max(40).nullable().optional() }),
  input({ kind: z.literal('REMOVE_ABSENCE'), absenceId: id() }),
])

/** Fix a day (design pop-up "Fix a day"): add a clock event, void a duplicate, set or remove an absence; the reason. */
export const fixDayContract = defineContract({
  params: input({ dayId: id() }),
  body: input({ version, action: fixAction, reasonCode: z.enum(MANUAL_REASONS).optional(), reason }),
  response: { 200: dayDetailOut },
})

/** The inline absence code of a day nobody clocked in (autosave with the version read; null clears it). */
export const dayAbsenceContract = defineContract({
  params: input({ dayId: id() }),
  body: input({ version, codeId: id().nullable(), minutes: z.number().int().min(1).max(1440).optional(), documentRef: z.string().max(40).nullable().optional() }),
  response: { 200: dayDetailOut },
})

export const approveDayContract = defineContract({ params: input({ dayId: id() }), body: input({ version }), response: { 200: dayDetailOut } })

export const approveDaysContract = defineContract({
  body: input({ dayIds: z.array(id()).min(1).max(200) }),
  response: { 200: output({ approved: z.array(id()), held: z.array(output({ dayId: id(), codes: z.array(z.enum(APPROVAL_HOLDS)), words: z.string() })), words: z.string() }) },
})

export const reopenDayContract = defineContract({ params: input({ dayId: id() }), body: input({ version, reason }), response: { 200: dayDetailOut } })

export const acceptAnomalyContract = defineContract({ params: input({ anomalyId: id() }), body: input({ note: reason }), response: { 200: dayDetailOut } })

// ---- absence codes ------------------------------------------------------------------------------------------------------

const label = z.record(z.string().regex(/^[a-z]{2}$/), z.string().max(80))

export const codeOut = output({
  id: id(),
  companyId: id().nullable(),
  code: z.string(),
  labelI18n: z.record(z.string(), z.string()),
  category: z.enum(ABSENCE_CATEGORIES),
  lulCode: z.string().nullable(),
  paid: z.boolean(),
  documentRequired: z.boolean(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  /** Days with this code (archived codes stay readable on them). */
  inUse: z.number().int().min(0),
  version: z.number().int(),
})

export const listCodesContract = defineContract({
  querystring: input({ companyId: id().optional(), status: z.enum(['ACTIVE', 'ARCHIVED', 'ALL']).optional() }),
  response: { 200: output({ codes: z.array(codeOut), standardMissing: z.array(z.string()), words: z.array(z.string()) }) },
})

export const createCodeContract = defineContract({
  body: input({ companyId: id().nullable(), code: z.string().max(8), labelI18n: label, category: z.enum(ABSENCE_CATEGORIES), lulCode: z.string().max(16).nullable().optional(), paid: z.boolean(), documentRequired: z.boolean().optional() }),
  response: { 200: codeOut, 201: codeOut },
})

export const editCodeContract = defineContract({
  params: input({ codeId: id() }),
  body: input({ version, labelI18n: label.optional(), category: z.enum(ABSENCE_CATEGORIES).optional(), lulCode: z.string().max(16).nullable().optional(), paid: z.boolean().optional(), documentRequired: z.boolean().optional() }),
  response: { 200: codeOut },
})

export const codeStateContract = defineContract({ params: input({ codeId: id() }), body: input({ version }), response: { 200: codeOut } })

export const standardCodesContract = defineContract({
  body: input({ companyId: id().nullable() }),
  response: { 200: output({ added: z.array(codeOut), skipped: z.array(z.string()) }) },
})

// ---- People settings: rounding, tolerance and grace -----------------------------------------------------------------

const settingsOut = output({
  companyId: id(),
  /** null: the company has no People settings yet (the defaults). */
  version: z.number().int().nullable(),
  earlyClockInFromShiftStart: z.boolean(),
  lateGraceMinutes: z.number().int(),
  overtimeUnitMinutes: z.number().int(),
  roundingMinutes: z.number().int(),
  autoClockOutAfterMinutes: z.number().int().nullable(),
  fixedBreaks: z.boolean(),
  /** The worked example ("A clock-in at 05:52 for a 06:00 shift counts from 06:00"), one line per rule. */
  example: z.array(z.string()),
})

export const settingsContract = defineContract({ querystring: input({ companyId: id() }), response: { 200: settingsOut } })

export const saveSettingsContract = defineContract({
  body: input({
    companyId: id(),
    version: version.nullable(),
    earlyClockInFromShiftStart: z.boolean(),
    lateGraceMinutes: z.number().int().min(0).max(60),
    overtimeUnitMinutes: z.number().int().min(1).max(60),
    /** ROUNDING_CHOICES: none, 5 or 15 minutes. */
    roundingMinutes: z.union([z.literal(ROUNDING_CHOICES[0]), z.literal(ROUNDING_CHOICES[1]), z.literal(ROUNDING_CHOICES[2])]),
    autoClockOutAfterMinutes: z.number().int().min(0).max(720).nullable(),
    fixedBreaks: z.boolean(),
  }),
  response: { 200: settingsOut },
})

// ---- who is in now ------------------------------------------------------------------------------------------------------

const count = z.number().int().min(0).nullable()
export const whoIsInContract = defineContract({
  querystring: input({ siteId: id() }),
  response: {
    200: output({
      siteId: id(),
      asOf: instant(),
      people: count,
      tooFew: z.boolean(),
      areas: z.array(output({ areaId: id().nullable(), code: z.string().nullable(), name: z.string().nullable(), people: count, tooFew: z.boolean(), lines: z.array(output({ lineId: id().nullable(), code: z.string().nullable(), name: z.string().nullable(), people: count, tooFew: z.boolean() })) })),
      words: z.string().nullable(),
    }),
  },
})

export const rollCallContract = defineContract({
  body: input({ siteId: id() }),
  response: {
    200: output({
      siteId: id(),
      asOf: instant(),
      people: z.number().int().min(0),
      groups: z.array(output({ areaId: id().nullable(), areaName: z.string().nullable(), lineId: id().nullable(), lineName: z.string().nullable(), people: z.array(output({ employeeId: id(), name: z.string(), onBreak: z.boolean() })) })),
      words: z.string(),
    }),
  },
})

export type ListDaysQuery = z.infer<typeof listDaysContract.querystring>
export type CountsQuery = z.infer<typeof countsContract.querystring>
export type ManualEntryBody = z.infer<typeof manualEntryContract.body>
export type FixDayBody = z.infer<typeof fixDayContract.body>
export type DayAbsenceBody = z.infer<typeof dayAbsenceContract.body>
export type CreateCodeBody = z.infer<typeof createCodeContract.body>
export type EditCodeBody = z.infer<typeof editCodeContract.body>
export type SaveSettingsBody = z.infer<typeof saveSettingsContract.body>

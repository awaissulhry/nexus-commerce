import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { LIMIT_KINDS, LIMIT_LEVELS } from '@nexus/factory-domain/people/shifts/limits'
import { CELL_ISSUES, CELL_SOURCES, OVERTIME_ANSWERS, OVERTIME_STATUSES, ROSTER_KINDS, ROSTER_STATUSES, SHIFT_LIMITS } from '@nexus/factory-domain/people/shifts/rules'
import { refOut } from '../employees/contract'

/**
 * People › Shifts (B-W2b-32; MES-218, MES-222; design people.shifts SCR-263): the roster sheet, its writes (cells,
 * Assign, Copy last week, Publish), the planned overtime requests, and the worker's own shifts and asks on the tablet.
 * A roster names people inside the sheet (rows grouped by line and team); no figure about one person's work, no
 * filter or group by person (Owner answers W1, F2). Planned time only: what a person did is Attendance's.
 */

const version = () => z.number().int().min(1)
const minute = () => z.number().int().min(0).max(2879)

/** What a cell is set to: a day off, a shift of a planning pattern (its label, and its start when the label is there twice), or a shift typed by hand. */
const shiftSet = z.discriminatedUnion('kind', [
  input({ kind: z.literal('OFF') }),
  input({
    kind: z.literal('WORK'),
    /** The planning pattern the shift is taken from; null or left out: typed by hand (start, end and break). */
    patternId: id().nullable().optional(),
    label: z.string().trim().min(1).max(SHIFT_LIMITS.label).nullable().optional(),
    startMinute: minute().optional(),
    endMinute: minute().optional(),
    breakMinutes: z.number().int().min(0).max(1439).optional(),
  }),
])
export type ShiftSet = z.infer<typeof shiftSet>

const windowOut = output({ label: z.string().nullable(), startMinute: z.number().int(), endMinute: z.number().int(), breakMinutes: z.number().int() })
const valueOut = output({ kind: z.enum(ROSTER_KINDS), shift: windowOut.nullable(), patternId: id().nullable() })

export const warningOut = output({
  rule: z.enum(LIMIT_KINDS),
  level: z.enum(LIMIT_LEVELS),
  date: z.string(),
  law: z.string(),
  words: z.string(),
  values: z.record(z.string(), z.union([z.number(), z.string()])),
  /** Brought by the write or the overtime being checked. */
  isNew: z.boolean(),
})

const overtimeInCell = output({ requestId: id(), agreementId: id(), startMinute: z.number().int().nullable(), minutes: z.number().int(), stage: z.enum(OVERTIME_STATUSES), answer: z.enum(OVERTIME_ANSWERS) })

export const cellOut = output({
  date: z.string(),
  /** ROSTER: a roster row (bold); DEFAULT: the default shift (faint); NONE: no shift. */
  source: z.enum(CELL_SOURCES),
  value: valueOut.nullable(),
  issue: z.enum(CELL_ISSUES).nullable(),
  entry: output({ id: id(), status: z.enum(ROSTER_STATUSES), version: z.number().int(), note: z.string().nullable() }).nullable(),
  /** The default shift the day returns to when its row is cleared (Delete). */
  fallback: valueOut.nullable(),
  /** The business calendar keeps the day open for the person (holidays and shutdowns shade the column). */
  open: z.boolean(),
  /** Planned overtime the person is asked or agreed to that day ('+2 h'). */
  overtime: z.array(overtimeInCell),
  /** An absence recorded in Attendance (read only), where the site's ATTENDANCE gate is open. */
  absence: output({ kind: z.enum(['HOLIDAY', 'PERMIT', 'ABSENT']), code: z.string().nullable(), minutes: z.number().int() }).nullable(),
  warnings: z.array(warningOut),
})

const dayOut = output({ date: z.string(), weekday: z.number().int(), open: z.boolean(), reason: z.enum(['WEEK', 'DAY_OFF', 'HOLIDAY', 'CLOSURE', 'WORKING']), name: z.string().nullable() })
const ruleOut = output({
  kind: z.enum(LIMIT_KINDS),
  limitMinutes: z.number().int(),
  breakMinutes: z.number().int().nullable(),
  referenceMonths: z.number().int().nullable(),
  action: z.enum(LIMIT_LEVELS),
  source: z.enum(['LAW', 'CCNL', 'DEFAULT']),
  legalReference: z.string(),
  scope: z.enum(['SITE', 'COMPANY', 'TENANT', 'DEFAULT']),
})
export const choiceOut = output({
  patternId: id(),
  patternCode: z.string(),
  patternName: z.string(),
  label: z.string().nullable(),
  startMinute: z.number().int(),
  endMinute: z.number().int(),
  breakMinutes: z.number().int(),
  weekdays: z.array(z.number().int()),
  key: z.string().nullable(),
})

export const rowOut = output({
  employeeId: id(),
  name: z.string(),
  displayName: z.string(),
  site: refOut,
  /** The line the row is grouped under: the person's team's line, else their home line. */
  line: refOut.nullable(),
  team: refOut.nullable(),
  isLead: z.boolean(),
  defaultPattern: refOut.nullable(),
  /** The last working day of an open leaver case (no shift after it). */
  lastWorkingDay: z.string().nullable(),
  /** The caller may plan this person's roster (every roster, or a team they lead). */
  canEdit: z.boolean(),
  cells: z.array(cellOut),
})

export const rosterContract = defineContract({
  querystring: input({ siteId: id().optional(), from: businessDate(), to: businessDate(), lineId: id().optional(), teamId: id().optional() }),
  response: {
    200: output({
      from: z.string(),
      to: z.string(),
      today: z.string(),
      sites: z.array(
        output({
          site: refOut,
          timeZone: z.string(),
          /** The site's business calendar for each day. */
          days: z.array(dayOut),
          /** The working-time limits in force (People settings, else the law's value). */
          rules: z.array(ruleOut),
          /** Absences are read here (the ATTENDANCE gate is open); else the words say why not. */
          absences: output({ shown: z.boolean(), words: z.string().nullable() }),
        }),
      ),
      choices: z.array(choiceOut),
      rows: z.array(rowOut),
      /** People per shift for each line and day (a headcount of the plan). */
      footer: z.array(output({ siteId: id(), lineId: id().nullable(), date: z.string(), shifts: z.array(output({ label: z.string().nullable(), startMinute: z.number().int(), endMinute: z.number().int(), people: z.number().int() })), off: z.number().int(), none: z.number().int() })),
      /** ALL: every roster here; TEAM: the teams the caller leads; NONE: read only. */
      canEdit: z.enum(['ALL', 'TEAM', 'NONE']),
    }),
  },
})

const changedCell = output({ employeeId: id(), name: z.string(), date: z.string(), cell: cellOut })

export const writeCellsContract = defineContract({
  body: input({
    cells: z
      .array(
        input({
          employeeId: id(),
          date: businessDate(),
          /** The row's version when the cell had one; null when it showed the default (no row). */
          version: version().nullable(),
          /** The new value; null: back to the default shift (the row is removed). */
          set: shiftSet.nullable(),
          note: z.string().trim().max(SHIFT_LIMITS.note).nullable().optional(),
        }),
      )
      .min(1)
      .max(SHIFT_LIMITS.cells),
  }),
  response: { 200: output({ cells: z.array(changedCell), warnings: z.number().int() }) },
})

const skippedOut = output({ employeeId: id(), name: z.string(), date: z.string(), why: z.enum(['NOT_EMPLOYED', 'AFTER_LAST_DAY', 'CLOSED', 'ABSENT', 'NO_EDIT']) })
const changeOut = output({ employeeId: id(), name: z.string(), date: z.string(), from: valueOut.nullable(), fromSource: z.enum(CELL_SOURCES), to: valueOut.nullable(), toSource: z.enum(CELL_SOURCES) })
const previewOut = output({
  changes: z.array(changeOut),
  skipped: z.array(skippedOut),
  warnings: z.array(output({ employeeId: id(), name: z.string(), warning: warningOut })),
  /** New warnings whose rule blocks: the write is held until they are solved. */
  blocked: z.number().int(),
  people: z.number().int(),
  /** Absences were read for the conflicts (the ATTENDANCE gate is open at the site); else the words say why not. */
  absences: output({ shown: z.boolean(), words: z.string().nullable() }),
})

const assignBody = input({
  employeeIds: z.array(id()).min(1).max(SHIFT_LIMITS.assignPeople),
  from: businessDate(),
  to: businessDate(),
  /** The weekdays to set (ISO, 1 Monday … 7 Sunday); default every day of the range. */
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
  /** The shift or the day off; null: back to the default shift. */
  set: shiftSet.nullable(),
  /** Leave the days the calendar closes (holidays, shutdowns, outside the working week) as they are; default true. */
  skipClosedDays: z.boolean().optional(),
})
export type AssignBody = z.infer<typeof assignBody>

export const assignPreviewContract = defineContract({ body: assignBody, response: { 200: previewOut } })
export const assignContract = defineContract({ body: assignBody, response: { 200: output({ changed: z.number().int(), people: z.number().int(), skipped: z.number().int(), warnings: z.number().int() }) } })

const copyBody = input({
  siteId: id(),
  /** The week to fill (its Monday): last week's cells are copied onto it. */
  week: businessDate(),
  lineId: id().optional(),
  teamId: id().optional(),
  employeeIds: z.array(id()).min(1).max(SHIFT_LIMITS.rosterPeople).optional(),
})
export type CopyBody = z.infer<typeof copyBody>

export const copyWeekPreviewContract = defineContract({ body: copyBody, response: { 200: previewOut } })
export const copyWeekContract = defineContract({ body: copyBody, response: { 200: output({ changed: z.number().int(), people: z.number().int(), skipped: z.number().int(), warnings: z.number().int() }) } })

export const publishContract = defineContract({
  body: input({ siteId: id(), from: businessDate(), to: businessDate(), lineId: id().optional(), teamId: id().optional(), employeeIds: z.array(id()).min(1).max(SHIFT_LIMITS.rosterPeople).optional() }),
  response: { 200: output({ published: z.number().int(), people: z.number().int(), warnings: z.number().int() }) },
})

// ---- overtime ---------------------------------------------------------------------------------------------------------

const countsOut = output({ asked: z.number().int(), agreed: z.number().int(), declined: z.number().int(), pending: z.number().int() })

export const requestOut = output({
  id: id(),
  companyId: id(),
  site: refOut,
  line: refOut.nullable(),
  date: z.string(),
  startMinute: z.number().int().nullable(),
  minutes: z.number().int(),
  reason: z.string(),
  status: z.enum(OVERTIME_STATUSES),
  /** The status shown: ASKED reads AGREED once somebody said yes (approved only after). */
  stage: z.enum(OVERTIME_STATUSES),
  counts: countsOut,
  askedAt: z.string().nullable(),
  askedBy: z.string().nullable(),
  approvedAt: z.string().nullable(),
  approvedBy: z.string().nullable(),
  doneAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  createdBy: z.string().nullable(),
  version: z.number().int(),
})

const personOut = output({
  agreementId: id(),
  employeeId: id(),
  name: z.string(),
  displayName: z.string(),
  answer: z.enum(OVERTIME_ANSWERS),
  answeredAt: z.string().nullable(),
  via: z.enum(['FLOOR', 'OFFICE']).nullable(),
  /** OFFICE: who recorded what the person said. */
  recordedBy: z.string().nullable(),
  version: z.number().int(),
  /** The limit checks as if the person works it: rest, break, the week's average, the year's cap. */
  checks: z.array(warningOut),
})

const recordOut = output({ request: requestOut, people: z.array(personOut), canManage: z.boolean(), canApprove: z.boolean(), today: z.string() })

export const listRequestsContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    lineId: id().optional(),
    from: businessDate().optional(),
    to: businessDate().optional(),
    stage: z.enum(OVERTIME_STATUSES).optional(),
  }),
  response: { 200: output({ requests: z.array(requestOut.extend({ checks: output({ warn: z.number().int(), block: z.number().int() }) })), today: z.string() }) },
})

export const requestRecordContract = defineContract({ params: input({ requestId: id() }), response: { 200: recordOut } })

const planBody = {
  date: businessDate(),
  startMinute: z.number().int().min(0).max(1439).nullable().optional(),
  minutes: z.number().int().min(SHIFT_LIMITS.overtimeMinutes.min).max(SHIFT_LIMITS.overtimeMinutes.max),
}

export const checkRequestContract = defineContract({
  body: input({ siteId: id(), ...planBody, employeeIds: z.array(id()).min(1).max(SHIFT_LIMITS.overtimePeople), requestId: id().optional() }),
  response: { 200: output({ people: z.array(output({ employeeId: id(), name: z.string(), displayName: z.string(), checks: z.array(warningOut) })) }) },
})

export const createRequestContract = defineContract({
  body: input({
    siteId: id(),
    lineId: id().nullable().optional(),
    ...planBody,
    reason: z.string().trim().min(1).max(SHIFT_LIMITS.reason),
    employeeIds: z.array(id()).min(1).max(SHIFT_LIMITS.overtimePeople),
    /** Ask the people at once (design "Ask 6 people"); false or left out: a draft. */
    ask: z.boolean().optional(),
  }),
  response: { 200: recordOut, 201: recordOut },
})

export const editRequestContract = defineContract({
  params: input({ requestId: id() }),
  body: input({ version: version(), date: businessDate().optional(), startMinute: z.number().int().min(0).max(1439).nullable().optional(), minutes: planBody.minutes.optional(), lineId: id().nullable().optional(), reason: z.string().trim().min(1).max(SHIFT_LIMITS.reason).optional() }),
  response: { 200: recordOut },
})

export const requestPeopleContract = defineContract({
  params: input({ requestId: id() }),
  body: input({ version: version(), add: z.array(id()).max(SHIFT_LIMITS.overtimePeople).optional(), remove: z.array(id()).max(SHIFT_LIMITS.overtimePeople).optional() }),
  response: { 200: recordOut },
})

export const askRequestContract = defineContract({ params: input({ requestId: id() }), body: input({ version: version() }), response: { 200: recordOut } })

export const recordAnswerContract = defineContract({
  params: input({ requestId: id(), agreementId: id() }),
  body: input({ version: version(), answer: z.enum(['AGREED', 'DECLINED']) }),
  response: { 200: recordOut },
})

export const approveRequestContract = defineContract({ params: input({ requestId: id() }), body: input({ version: version() }), response: { 200: recordOut } })

export const cancelRequestContract = defineContract({
  params: input({ requestId: id() }),
  body: input({ version: version(), reason: z.string().trim().min(1).max(SHIFT_LIMITS.reason) }),
  response: { 200: recordOut },
})

// ---- the floor -------------------------------------------------------------------------------------------------------

const askOut = output({
  agreementId: id(),
  requestId: id(),
  date: z.string(),
  startMinute: z.number().int().nullable(),
  minutes: z.number().int(),
  reason: z.string(),
  line: refOut.nullable(),
  stage: z.enum(OVERTIME_STATUSES),
  answer: z.enum(OVERTIME_ANSWERS),
  answeredAt: z.string().nullable(),
  /** The worker may still answer (the request is asked and not approved; its day has not passed). */
  canAnswer: z.boolean(),
  version: z.number().int(),
})

export const myShiftsContract = defineContract({
  querystring: input({ days: z.coerce.number().int().min(1).max(31).optional() }),
  response: {
    200: output({
      /** The signed-in worker's employee record (null: none linked, so no roster). */
      employeeId: id().nullable(),
      today: z.string(),
      days: z.array(output({ date: z.string(), source: z.enum(CELL_SOURCES), value: valueOut.nullable(), overtime: z.array(overtimeInCell) })),
      asks: z.array(askOut),
    }),
  },
})

export const floorAnswerContract = defineContract({
  params: input({ agreementId: id() }),
  body: input({ version: version(), answer: z.enum(['AGREED', 'DECLINED']), deviceTime: instant().optional() }),
  response: { 200: output({ ask: askOut }) },
})

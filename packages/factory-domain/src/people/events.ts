import { z } from 'zod'
// B-W2b-32: shifts and overtime requests.
import { OVERTIME_ANSWERS } from './shifts/rules'
import { defineEvent } from '../events/define'
import { EMPLOYEE_KINDS } from './employees/rules'
import { LEAVER_STEP_KINDS, LEAVER_STEP_STATUSES } from './leavers/rules'
import { GATE_PURPOSES } from './privacy/purposes'
import { SKILL_KINDS, SKILL_LEVELS } from './skills/rules'
// B-W2b-34
import { VERSION_STATUSES } from './piecerates/rates'
// B-W2b-33: clock in and out.
import { CLOCK_ACTIONS } from './clock/rules'
// B-W2b-38: incentive schemes.
import { SCHEME_STATUSES } from './schemes/rules'
// B-W2b-37: attendance days.
import { ANOMALY_KINDS, DAY_CHANGES, DAY_STATUSES } from './attendance/rules'

/**
 * The people module's events (B-W2b-26 employees and teams; design people.employees "Live": employee.created / updated
 * → the row in place, leaver.step_done → the Leavers panel). apps/factory-api's modules/people emits them in the commands
 * that make the change. Ids, codes, kinds and states only: no name, no employee code, no date about a person, no reason
 * a person typed, never a figure about one person's work (Statuto dei Lavoratori art. 4).
 *
 *   employee.created     an employee record was made: new, from a floor worker, from an office user, or by an import
 *   employee.updated     its identity, job or contract changed, it moved site, or its floor sign-in or office account
 *                        was linked or unlinked (the names of the fields only)
 *   team.changed         a team was added, changed or archived, its lead set, or people moved into or out of it
 *   line_loan.changed    a person was lent to another line, a loan ended early or was removed before it began
 *   org_area.changed     a site's area was added, changed or archived, or a line moved into or out of it
 *   leaver.started       leaver steps started for a person (how many steps)
 *   leaver.step_done     a leaver step was ticked, skipped or reopened (by a person or by the system)
 *   leaver.ended         the leaving closed (DONE: the person left) or was cancelled
 *
 * Every one reaches the People screens of the office (people.view). The floor receives none (its crews read the teams
 * when they open).
 *
 * B-W2b-27 (privacy) and the later People steps add their events below, one block each.
 *
 * B-W2b-27 (privacy of people data), emitted by apps/factory-api modules/people/privacy in the command that makes the
 * change. Ids, purposes, states and counts only: never a person, a basis text, a reason or a figure.
 *
 *   legal_gate.changed               a purpose of people data was switched on or off at a site, or its leads choice
 *                                    widened or narrowed: the People screens and Admin › Privacy re-read the gate
 *   people_settings.privacy_changed  a company's minimum group size or the roles that see one person's figures changed
 *
 * Both reach the office screens of people.privacy.view holders; the floor receives none (it reads no legal basis).
 *
 * B-W2b-39 (skills and machine authorisations), emitted by apps/factory-api modules/people/skills in the command that
 * makes the change. Ids, codes, kinds, levels and states only: never a name, a reason or a figure about one person's work
 * (a level is a qualification a person judged, MES-281).
 *
 *   skill.changed                   a skill was added, renamed or re-ordered, archived or restored
 *   employee_skill.changed          a person's level was set or changed, a trainee period given or moved, a trainee
 *                                   signed off, or a level removed: the matrix cell and the employee's Skills tab re-read
 *   machine_authorisation.changed   a person was authorised on a class of machine, its end moved, it was revoked, or an
 *                                   ended one was closed by a new authorisation
 *
 * All three reach the office screens of people.skills.view holders; the floor receives none (a tablet checks when work
 * starts).
 *
 * B-W2b-33 (clock in and out), emitted by apps/factory-api modules/people/clock in the command that records the clock
 * event (from the floor, a badge or a name and PIN, online or kept offline, or the automatic clock-out). Ids, kinds and
 * sources only: no name, no time of a person (the record has it), no reason.
 *
 *   attendance.clock_event   a person clocked in, out, or started or ended a break (design people.attendance "Live":
 *                            the day row and Who is in now; the worker's own tablet reads its clock again)
 *   clock.out                a person clocked out (on the floor, kept offline, or by the automatic clock-out): the steps
 *                            that stop work at clock-out listen to it (B-W2b-40 pauses the open operations, MES-117)
 *
 * attendance.clock_event reaches the office screens of people.attendance.view holders and the tablets of the site
 * (floor.work; no person in the message: each tablet reads its own state again); clock.out reaches no screen.
 * B-W2b-37 adds MANUAL to both sources: a clock-in or clock-out a person entered in the office with a reason.
 *
 * B-W2b-37 (attendance days), emitted by apps/factory-api modules/people/attendance (attendanceEvents, at the end of the
 * file). Ids, kinds and states only: no name, no time, no minutes, no reason.
 */

export const SKILL_CHANGES = ['CREATED', 'EDITED', 'ARCHIVED', 'RESTORED'] as const
export const EMPLOYEE_SKILL_CHANGES = ['SET', 'CHANGED', 'TRAINEE_SET', 'SIGNED_OFF', 'REMOVED'] as const
export const MACHINE_AUTHORISATION_CHANGES = ['AUTHORISED', 'VALIDITY_CHANGED', 'REVOKED', 'ENDED'] as const

export const LEGAL_GATE_CHANGES = ['SWITCHED_ON', 'SWITCHED_OFF', 'LEADS_WIDENED', 'LEADS_NARROWED'] as const
export const PRIVACY_SETTINGS_CHANGES = ['WIDENED', 'NARROWED'] as const

// B-W2b-34
export const PIECE_RATE_TABLE_CHANGES = ['CREATED', 'EDITED', 'ARCHIVED'] as const
export const PIECE_RATE_VERSION_CHANGES = ['CREATED', 'EDITED', 'RATES_SET', 'IN_FORCE', 'CONFIRMED', 'SUPERSEDED', 'CANCELLED'] as const
export const PIECE_PAY_SWITCH_CHANGES = ['PRECONDITIONS_RECORDED', 'SWITCHED_ON', 'SWITCHED_OFF'] as const
// B-W2b-38
export const INCENTIVE_SCHEME_CHANGES = ['CREATED', 'EDITED', 'ACTIVATED', 'RETIRED', 'ENDED', 'DELETED'] as const

const by = z.enum(['OFFICE', 'SYSTEM', 'IMPORT'])

export const events = [
  // B-W2b-32: shifts and overtime requests (shiftEvents, at the end of the file).
  ...shiftEvents(),
  // B-W2b-37: attendance days (attendanceEvents, at the end of the file).
  ...attendanceEvents(),
  defineEvent({
    type: 'employee.created',
    context: 'people',
    description: 'An employee record was made: new, from a floor worker, from an office user, or by an import of the payroll file.',
    payload: z.strictObject({ employeeId: z.uuid(), kind: z.enum(EMPLOYEE_KINDS), source: z.enum(['NEW', 'WORKER', 'USER', 'IMPORT']), workerId: z.uuid().nullable(), linkedUser: z.boolean() }),
    live: { permission: 'people.view', fields: ['employeeId', 'kind', 'source'] },
  }),
  defineEvent({
    type: 'employee.updated',
    context: 'people',
    description: "An employee record changed: identity, job or contract, a move to another site, or its floor sign-in or office account linked or unlinked (the names of the fields only).",
    payload: z.strictObject({ employeeId: z.uuid(), change: z.enum(['EDITED', 'MOVED_SITE', 'WORKER_LINKED', 'WORKER_UNLINKED', 'ACCOUNT_LINKED', 'ACCOUNT_UNLINKED', 'LEFT']), fields: z.array(z.string()), workerId: z.uuid().nullable(), by }),
    live: { permission: 'people.view', fields: ['employeeId', 'change', 'fields'] },
  }),
  defineEvent({
    type: 'team.changed',
    context: 'people',
    description: 'A team was added, changed or archived, its lead was set, or people moved into or out of it (their record ids).',
    payload: z.strictObject({ teamId: z.uuid(), code: z.string(), change: z.enum(['CREATED', 'EDITED', 'ARCHIVED', 'LEAD_SET', 'MEMBERS_MOVED']), employeeIds: z.array(z.uuid()) }),
    live: { permission: 'people.view', fields: ['teamId', 'code', 'change'] },
  }),
  defineEvent({
    type: 'line_loan.changed',
    context: 'people',
    description: 'A person was lent to another line of their site, a loan ended early, or a loan that had not begun was removed.',
    payload: z.strictObject({ loanId: z.uuid(), employeeId: z.uuid(), toLineId: z.uuid(), toTeamId: z.uuid().nullable(), change: z.enum(['MADE', 'ENDED', 'REMOVED']) }),
    live: { permission: 'people.view', fields: ['loanId', 'toLineId', 'change'] },
  }),
  defineEvent({
    type: 'org_area.changed',
    context: 'people',
    description: "A site's area (a hall, a room) was added, changed or archived, or a line moved into or out of it.",
    payload: z.strictObject({ areaId: z.uuid().nullable(), code: z.string().nullable(), change: z.enum(['CREATED', 'EDITED', 'ARCHIVED', 'LINE_MOVED']), lineIds: z.array(z.uuid()) }),
    live: { permission: 'sites.view', fields: ['areaId', 'change'] },
  }),
  defineEvent({
    type: 'leaver.started',
    context: 'people',
    description: 'Leaver steps started for a person: their case and how many steps it has.',
    payload: z.strictObject({ caseId: z.uuid(), employeeId: z.uuid(), steps: z.array(z.enum(LEAVER_STEP_KINDS)), by }),
    live: { permission: 'people.view', fields: ['caseId', 'employeeId'] },
  }),
  defineEvent({
    type: 'leaver.step_done',
    context: 'people',
    description: 'A leaver step was ticked, skipped or reopened, by a person or by the system (an automatic step).',
    payload: z.strictObject({ caseId: z.uuid(), employeeId: z.uuid(), stepId: z.uuid(), kind: z.enum(LEAVER_STEP_KINDS), status: z.enum(LEAVER_STEP_STATUSES), by }),
    live: { permission: 'people.view', fields: ['caseId', 'employeeId', 'kind', 'status'] },
  }),
  defineEvent({
    type: 'leaver.ended',
    context: 'people',
    description: 'A leaving closed: DONE (every step done: the person left) or CANCELLED (before the last day).',
    payload: z.strictObject({ caseId: z.uuid(), employeeId: z.uuid(), outcome: z.enum(['DONE', 'CANCELLED']), by }),
    live: { permission: 'people.view', fields: ['caseId', 'employeeId', 'outcome'] },
  }),
  // B-W2b-27: privacy of people data.
  defineEvent({
    type: 'legal_gate.changed',
    context: 'people',
    description: "A purpose of people data (attendance, one person's work figures) was switched on or off at a site, or whether leads see one person's figures there changed.",
    payload: z.strictObject({
      gateId: z.uuid(),
      siteId: z.uuid(),
      purpose: z.enum(GATE_PURPOSES),
      change: z.enum(LEGAL_GATE_CHANGES),
      open: z.boolean(),
      leadsSeeFigures: z.boolean(),
    }),
    live: { permission: 'people.privacy.view', fields: ['gateId', 'siteId', 'purpose', 'change', 'open'] },
  }),
  defineEvent({
    type: 'people_settings.privacy_changed',
    context: 'people',
    description: "A company's minimum group size for people figures, or the roles that see one person's figures, changed.",
    payload: z.strictObject({
      companyId: z.uuid(),
      minimumGroupSize: z.number().int().min(3),
      figureRoleCount: z.number().int().min(0),
      change: z.enum(PRIVACY_SETTINGS_CHANGES),
    }),
    live: { permission: 'people.privacy.view', fields: ['companyId', 'minimumGroupSize', 'change'] },
  }),
  // B-W2b-39: skills and machine authorisations.
  defineEvent({
    type: 'skill.changed',
    context: 'people',
    description: 'A skill (an operation, a class of machine or a general skill) was added, renamed or re-ordered, archived or restored.',
    payload: z.strictObject({ skillId: z.uuid(), code: z.string(), kind: z.enum(SKILL_KINDS), change: z.enum(SKILL_CHANGES) }),
    live: { permission: 'people.skills.view', fields: ['skillId', 'code', 'change'] },
  }),
  defineEvent({
    type: 'employee_skill.changed',
    context: 'people',
    description: "A person's level in a skill was set or changed, a trainee period given or moved, the trainee signed off, or the level removed.",
    payload: z.strictObject({ levelId: z.uuid(), employeeId: z.uuid(), skillId: z.uuid(), level: z.enum(SKILL_LEVELS), trainee: z.boolean(), change: z.enum(EMPLOYEE_SKILL_CHANGES) }),
    live: { permission: 'people.skills.view', fields: ['levelId', 'employeeId', 'skillId', 'change'] },
  }),
  defineEvent({
    type: 'machine_authorisation.changed',
    context: 'people',
    description: 'A person was authorised on a class of machine, the last day of an authorisation moved, it was revoked, or an ended one was closed by a new authorisation.',
    payload: z.strictObject({ authorisationId: z.uuid(), employeeId: z.uuid(), machineClassId: z.uuid(), change: z.enum(MACHINE_AUTHORISATION_CHANGES) }),
    live: { permission: 'people.skills.view', fields: ['authorisationId', 'employeeId', 'machineClassId', 'change'] },
  }),
  // B-W2b-34: piece rates and the legal switch of piece pay (MES-254, MES-255, MES-262; c.c. arts. 2100-2101), emitted by
  // apps/factory-api modules/people/piecerates in the command that makes the change. Ids, numbers, states and counts
  // only: never a rate, an amount, a worker or a reason. They reach the office screens of people.piecerates.view holders
  // (the rate table, "Read by n of m", the legal switch); the floor receives none (a worker reads their rates when they
  // open them).
  defineEvent({
    type: 'piece_rate_table.changed',
    context: 'people',
    description: 'A piece-rate table of a site was added, changed or archived.',
    payload: z.strictObject({ tableId: z.uuid(), siteId: z.uuid(), change: z.enum(PIECE_RATE_TABLE_CHANGES) }),
    live: { permission: 'people.piecerates.view', fields: ['tableId', 'siteId', 'change'] },
  }),
  defineEvent({
    type: 'piece_rate_version.changed',
    context: 'people',
    description: 'A version of piece rates was made, changed, put in force (provisional or confirmed), confirmed after its trial, superseded by a later one, or cancelled as a draft.',
    payload: z.strictObject({ versionId: z.uuid(), tableId: z.uuid(), siteId: z.uuid(), versionNo: z.number().int().min(1), change: z.enum(PIECE_RATE_VERSION_CHANGES), status: z.enum(VERSION_STATUSES) }),
    live: { permission: 'people.piecerates.view', fields: ['versionId', 'tableId', 'siteId', 'versionNo', 'change', 'status'] },
  }),
  defineEvent({
    type: 'rate_publication.changed',
    context: 'people',
    description: 'A version of piece rates was published to workers of its site (on the floor, on paper or both), or a publication of a draft was withdrawn.',
    payload: z.strictObject({ publicationId: z.uuid(), versionId: z.uuid(), siteId: z.uuid(), lineId: z.uuid().nullable(), change: z.enum(['PUBLISHED', 'WITHDRAWN']), workers: z.number().int().min(0) }),
    live: { permission: 'people.piecerates.view', fields: ['publicationId', 'versionId', 'siteId', 'change', 'workers'] },
  }),
  defineEvent({
    type: 'rate.read',
    context: 'people',
    description: "Workers acknowledged a publication of piece rates: on a floor device, or on a signed paper copy the office recorded (how many, never who): the 'Read by' counts.",
    payload: z.strictObject({ publicationId: z.uuid(), versionId: z.uuid(), siteId: z.uuid(), channel: z.enum(['DEVICE', 'PAPER']), receipts: z.number().int().min(1) }),
    live: { permission: 'people.piecerates.view', fields: ['publicationId', 'versionId', 'siteId', 'channel', 'receipts'] },
  }),
  defineEvent({
    type: 'piece_pay.switched',
    context: 'people',
    description: "The legal switch of piece pay at a site: its preconditions recorded, piece pay started from a day, or stopped (by a person, or because the site's gate for one person's work figures was switched off).",
    payload: z.strictObject({
      siteId: z.uuid(),
      change: z.enum(PIECE_PAY_SWITCH_CHANGES),
      state: z.enum(['OFF', 'ON']),
      onFrom: z.iso.date().nullable(),
      offFrom: z.iso.date().nullable(),
      by: z.enum(['OFFICE', 'GATE_OFF']),
    }),
    live: { permission: 'people.piecerates.view', fields: ['siteId', 'change', 'state', 'onFrom', 'offFrom'] },
  }),
  // B-W2b-38: incentive schemes (MES-253, MES-257, MES-258, MES-259; c.c. arts. 2100-2101), emitted by apps/factory-api
  // modules/people/schemes in the command that makes the change. Ids and states only: never a rate, an amount or a
  // reason. They reach the office screens of people.piecerates.view holders (the page's "Scheme" section and the legal
  // switch's scheme); the floor receives none.
  defineEvent({
    type: 'incentive_scheme.changed',
    context: 'people',
    description: 'An incentive scheme of a company or a line was drafted, changed or deleted as a draft, started (the scheme before it ended the day before and retired), or ended.',
    payload: z.strictObject({ schemeId: z.uuid(), companyId: z.uuid(), lineId: z.uuid().nullable(), change: z.enum(INCENTIVE_SCHEME_CHANGES), status: z.enum(SCHEME_STATUSES) }),
    live: { permission: 'people.piecerates.view', fields: ['schemeId', 'companyId', 'lineId', 'change', 'status'] },
  }),
  // B-W2b-33: clock in and out.
  defineEvent({
    type: 'attendance.clock_event',
    context: 'people',
    description: 'A person clocked in or out, or started or ended a break: at a tablet with a badge or by name and PIN, kept offline with the tablet time, or by the automatic clock-out at the shift end.',
    payload: z.strictObject({
      clockEventId: z.uuid(),
      siteId: z.uuid(),
      employeeId: z.uuid(),
      kind: z.enum(CLOCK_ACTIONS),
      source: z.enum(['BADGE', 'NAME_PIN', 'OFFLINE', 'AUTO', 'MANUAL']),
      flagged: z.boolean(),
    }),
    live: { permission: 'people.attendance.view', floor: 'floor.work', fields: ['clockEventId', 'siteId', 'kind'] },
  }),
  defineEvent({
    type: 'clock.out',
    context: 'people',
    description: 'A person clocked out (on the floor, kept offline, or by the automatic clock-out): what stops at clock-out (open operations) listens to it.',
    payload: z.strictObject({
      clockEventId: z.uuid(),
      siteId: z.uuid(),
      employeeId: z.uuid(),
      workerId: z.uuid().nullable(),
      source: z.enum(['BADGE', 'NAME_PIN', 'OFFLINE', 'AUTO', 'MANUAL']),
    }),
  }),
] as const

/**
 * B-W2b-32: shifts and overtime requests (design people.shifts "Live": shift.assigned → the cell, overtime.agreed (floor) →
 * the request row), emitted by apps/factory-api modules/people/shifts. The roster is planning; these name ids, the days of
 * the roster and states, never a figure about one person's work. roster.published and overtime.asked also reach the
 * tablets of the site (floor.work): the worker's own shifts and asks are read again when they come.
 *
 *   shift.assigned            roster cells set or cleared (back to the default shift), assigned to many, or last week copied
 *   roster.published          what the workers read changed: a range published, or a published cell changed or cleared
 *   overtime_request.changed  a request made, changed, its people added or taken off, approved or cancelled
 *   overtime.asked            people were asked (on the tablet's My day, or by the lead)
 *   overtime.answered         a person answered: on the tablet (FLOOR), or the lead recorded what they said (OFFICE)
 *
 * A function (hoisted), so the list above can spread it while this block stays apart at the end of the file.
 */
function shiftEvents() {
  const change = z.enum(['SET', 'CLEARED', 'ASSIGNED', 'COPIED', 'PUBLISHED'])
  const day = z.iso.date()
  return [
    defineEvent({
      type: 'shift.assigned',
      context: 'people',
      description: "Roster cells changed: shifts set or cleared (back to the default shift), assigned to many people, or last week copied (the people's record ids and the days).",
      payload: z.strictObject({ siteId: z.uuid(), employeeIds: z.array(z.uuid()), from: day, to: day, cells: z.number().int().min(0), change }),
      live: { permission: 'people.shifts.view', fields: ['siteId', 'from', 'to', 'cells', 'change'] },
    }),
    defineEvent({
      type: 'roster.published',
      context: 'people',
      description: 'The roster the workers read changed: a range published, or a published cell changed or cleared.',
      payload: z.strictObject({ siteId: z.uuid(), employeeIds: z.array(z.uuid()), from: day, to: day, cells: z.number().int().min(0), change }),
      live: { permission: 'people.shifts.view', floor: 'floor.work', fields: ['siteId', 'from', 'to', 'cells'] },
    }),
    defineEvent({
      type: 'overtime_request.changed',
      context: 'people',
      description: 'A planned overtime request was made, changed, its people added or taken off, approved or cancelled.',
      payload: z.strictObject({ requestId: z.uuid(), lineId: z.uuid().nullable(), date: day, change: z.enum(['CREATED', 'EDITED', 'PEOPLE_ADDED', 'PEOPLE_REMOVED', 'APPROVED', 'CANCELLED']), asked: z.number().int().min(0), agreed: z.number().int().min(0) }),
      live: { permission: 'people.shifts.view', fields: ['requestId', 'date', 'change', 'asked', 'agreed'] },
    }),
    defineEvent({
      type: 'overtime.asked',
      context: 'people',
      description: "People were asked to work a planned overtime (each answers on the tablet's My day, or tells the lead).",
      payload: z.strictObject({ requestId: z.uuid(), date: day, employeeIds: z.array(z.uuid()) }),
      live: { permission: 'people.shifts.view', floor: 'floor.work', fields: ['requestId', 'date'] },
    }),
    defineEvent({
      type: 'overtime.answered',
      context: 'people',
      description: 'A person asked to work a planned overtime answered: on the tablet (FLOOR), or the lead recorded what they said (OFFICE).',
      payload: z.strictObject({ requestId: z.uuid(), agreementId: z.uuid(), employeeId: z.uuid(), answer: z.enum(OVERTIME_ANSWERS), via: z.enum(['FLOOR', 'OFFICE']), agreed: z.number().int().min(0), asked: z.number().int().min(0) }),
      live: { permission: 'people.shifts.view', fields: ['requestId', 'answer', 'via', 'agreed', 'asked'] },
    }),
  ] as const
}

/**
 * B-W2b-37: attendance days (design people.attendance "Live": attendance.clock_event → the day row and Who is in now,
 * attendance.anomaly_raised → the tiles), emitted by apps/factory-api modules/people/attendance in the command that
 * makes the change. Ids, kinds and states only: never a name, a time, a minute figure or a reason about a person.
 *
 *   attendance.day_changed              a person's day was computed again (a clock event, the time passing), fixed by
 *                                       hand, given an absence, approved, reopened, or an anomaly accepted
 *   attendance.anomaly_raised           a computation found something wrong with a day (the kind; the rule is on the row)
 *   absence_code.changed                an absence code was added, changed, archived or restored, or the standard list
 *                                       was added
 *   people_settings.attendance_changed  how clock events become hours changed for a company (rounding, grace, the
 *                                       overtime unit, the automatic clock-out, fixed breaks)
 *
 * All four reach the office screens of people.attendance.view holders; the floor receives none.
 */
function attendanceEvents() {
  return [
    defineEvent({
      type: 'attendance.day_changed',
      context: 'people',
      description: "A person's attendance day changed: computed again from the clock events, fixed by hand with a reason, given an absence code, approved, reopened, or an anomaly accepted.",
      payload: z.strictObject({ dayId: z.uuid(), siteId: z.uuid(), employeeId: z.uuid(), status: z.enum(DAY_STATUSES), change: z.enum(DAY_CHANGES) }),
      live: { permission: 'people.attendance.view', fields: ['dayId', 'siteId', 'status', 'change'] },
    }),
    defineEvent({
      type: 'attendance.anomaly_raised',
      context: 'people',
      description: 'A computation found something wrong with an attendance day (a missing clock-out, a double clock-in, no shift planned …), with the rule that found it on the record.',
      payload: z.strictObject({ anomalyId: z.uuid(), dayId: z.uuid(), siteId: z.uuid(), employeeId: z.uuid(), kind: z.enum(ANOMALY_KINDS) }),
      live: { permission: 'people.attendance.view', fields: ['anomalyId', 'dayId', 'siteId', 'kind'] },
    }),
    defineEvent({
      type: 'absence_code.changed',
      context: 'people',
      description: "An absence code (with the labour consultant's LUL code) was added, changed, archived or restored, or the standard list was added.",
      payload: z.strictObject({ absenceCodeId: z.uuid().nullable(), companyId: z.uuid().nullable(), change: z.enum(['CREATED', 'EDITED', 'ARCHIVED', 'RESTORED', 'STANDARD']), codes: z.number().int().min(0) }),
      live: { permission: 'people.attendance.view', fields: ['absenceCodeId', 'companyId', 'change', 'codes'] },
    }),
    defineEvent({
      type: 'people_settings.attendance_changed',
      context: 'people',
      description: "How clock events become hours changed for a company: rounding, lateness grace, the overtime unit, the automatic clock-out or fixed breaks.",
      payload: z.strictObject({ companyId: z.uuid(), version: z.number().int().min(1) }),
      live: { permission: 'people.attendance.view', fields: ['companyId', 'version'] },
    }),
  ] as const
}

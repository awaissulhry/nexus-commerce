import { z } from 'zod'
// B-W2b-32: shifts and overtime requests.
import { OVERTIME_ANSWERS } from './shifts/rules'
import { defineEvent } from '../events/define'
import { EMPLOYEE_KINDS } from './employees/rules'
import { LEAVER_STEP_KINDS, LEAVER_STEP_STATUSES } from './leavers/rules'

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
 */

const by = z.enum(['OFFICE', 'SYSTEM', 'IMPORT'])

export const events = [
  // B-W2b-32: shifts and overtime requests (shiftEvents, at the end of the file).
  ...shiftEvents(),
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

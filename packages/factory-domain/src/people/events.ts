import { z } from 'zod'
import { defineEvent } from '../events/define'
import { EMPLOYEE_KINDS } from './employees/rules'
import { LEAVER_STEP_KINDS, LEAVER_STEP_STATUSES } from './leavers/rules'
import { GATE_PURPOSES } from './privacy/purposes'
// B-W2b-34
import { VERSION_STATUSES } from './piecerates/rates'

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
 */

export const LEGAL_GATE_CHANGES = ['SWITCHED_ON', 'SWITCHED_OFF', 'LEADS_WIDENED', 'LEADS_NARROWED'] as const
export const PRIVACY_SETTINGS_CHANGES = ['WIDENED', 'NARROWED'] as const

// B-W2b-34
export const PIECE_RATE_TABLE_CHANGES = ['CREATED', 'EDITED', 'ARCHIVED'] as const
export const PIECE_RATE_VERSION_CHANGES = ['CREATED', 'EDITED', 'RATES_SET', 'IN_FORCE', 'CONFIRMED', 'SUPERSEDED', 'CANCELLED'] as const
export const PIECE_PAY_SWITCH_CHANGES = ['PRECONDITIONS_RECORDED', 'SWITCHED_ON', 'SWITCHED_OFF'] as const

const by = z.enum(['OFFICE', 'SYSTEM', 'IMPORT'])

export const events = [
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
] as const

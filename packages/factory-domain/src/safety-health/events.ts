import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * Health surveillance (B-W2b-135; QHS-252, QHS-253, QHS-254; design plant.health). apps/factory-api's modules/safety/health
 * emits them in the commands that make the change. Their own module folder (the safety events file is B-W2b-120's), as
 * safety-rolesheets and safety-risk.
 *
 *   health_plan.changed        a role's plan changed (how often, the doctor, the end-of-employment visit): no person in it.
 *                              Reaches the safety pages (safety.view).
 *   health_visit.changed       a visit was planned, booked, unbooked, moved, done or cancelled: its id and state only.
 *   fitness_judgement.changed  a judgement was recorded or voided: its id only (its copy is a file: file.available).
 *
 * A visit's or a judgement's event carries NO person, no visit type, no outcome, no limit, no absence and no reason (GDPR art. 9:
 * the outbox keeps its rows; a listener that needs more reads the row by its id in its own scope, behind the module's rules), and
 * reaches only the health readers (safety.health.view), never the floor.
 */

export const PLAN_CHANGES = ['EDITED'] as const
export const VISIT_CHANGES = ['PLANNED', 'BOOKED', 'UNBOOKED', 'MOVED', 'DONE', 'CANCELLED'] as const
export const JUDGEMENT_CHANGES = ['RECORDED', 'VOIDED'] as const
export const HEALTH_CHANGE_SOURCES = ['OFFICE', 'SYSTEM'] as const

export const events = [
  defineEvent({
    type: 'health_plan.changed',
    context: 'safety-health',
    description: 'A role’s health surveillance plan changed: how often a visit is due, the doctor, or whether the end of the employment asks a visit (no person in a plan).',
    payload: z.strictObject({ planId: z.uuid(), roleSheetId: z.uuid(), change: z.enum(PLAN_CHANGES), fields: z.array(z.string()) }),
    live: { permission: 'safety.view', fields: ['planId', 'roleSheetId'] },
  }),
  defineEvent({
    type: 'health_visit.changed',
    context: 'safety-health',
    description: 'A health surveillance visit was planned, booked, unbooked, moved, done or cancelled (its id and state only: never the person, the type or a reason).',
    payload: z.strictObject({ visitId: z.uuid(), change: z.enum(VISIT_CHANGES), status: z.enum(['DUE', 'BOOKED', 'DONE', 'CANCELLED']), by: z.enum(HEALTH_CHANGE_SOURCES) }),
    live: { permission: 'safety.health.view', fields: ['visitId', 'status'] },
  }),
  defineEvent({
    type: 'fitness_judgement.changed',
    context: 'safety-health',
    description: 'A fitness judgement was recorded or voided (its id only: never the person, the outcome or the limits).',
    payload: z.strictObject({ judgementId: z.uuid(), change: z.enum(JUDGEMENT_CHANGES) }),
    live: { permission: 'safety.health.view', fields: ['judgementId', 'change'] },
  }),
] as const

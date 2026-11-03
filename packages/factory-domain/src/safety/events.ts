import { z } from 'zod'
import { defineEvent } from '../events/define'
import { DEADLINE_KINDS } from './calendar/rules'
import { SAFETY_ROLES } from './organisation/rules'

/**
 * Safety at work (B-W2b-120; QHS-224, QHS-226, QHS-227; design plant.calendar "live: appointment.signed → organisation;
 * training, visit, check, incident deadlines change → items move"). apps/factory-api's modules/safety emits them in the
 * commands that make the change. The module's events file: the later safety steps (the DVR, incidents, training, PPE,
 * health) add their own blocks below, each with its own lines.
 *
 *   safety_appointment.changed  a safety role was appointed, signed by the appointee, ended or its note edited
 *   rls_notice.changed          an RLS notice to INAIL was opened (with an RLS), its due day set, recorded filed or cancelled
 *   safety_deadline.changed     a deadline typed on the safety calendar was added, changed, done (with the next occurrence of
 *                               a repeating one) or cancelled
 *
 * Reach the safety calendar of the office (safety.view over the record's company): ids, roles, kinds and states only; never
 * a person's name, never a health value. Never the floor.
 */

const live = (fields: readonly string[]) => ({ permission: 'safety.view', fields }) as const

export const APPOINTMENT_CHANGES = ['MADE', 'SIGNED', 'ENDED', 'EDITED'] as const
export const RLS_NOTICE_CHANGES = ['CREATED', 'DUE_SET', 'FILED', 'CANCELLED'] as const
export const DEADLINE_CHANGES = ['ADDED', 'EDITED', 'DONE', 'CANCELLED'] as const

export const events = [
  defineEvent({
    type: 'safety_appointment.changed',
    context: 'safety',
    description: "A safety role was appointed (a person of the company or an outside contact), signed by the appointee, ended, or its note edited.",
    payload: z.strictObject({ appointmentId: z.uuid(), role: z.enum(SAFETY_ROLES), change: z.enum(APPOINTMENT_CHANGES), noticeId: z.uuid().nullable() }),
    live: live(['appointmentId', 'role', 'change']),
  }),
  defineEvent({
    type: 'rls_notice.changed',
    context: 'safety',
    description: 'An RLS notice to INAIL was opened with the RLS appointment, its due day set, recorded as filed on the INAIL portal, or cancelled.',
    payload: z.strictObject({ noticeId: z.uuid(), appointmentId: z.uuid(), change: z.enum(RLS_NOTICE_CHANGES) }),
    live: live(['noticeId', 'appointmentId', 'change']),
  }),
  defineEvent({
    type: 'safety_deadline.changed',
    context: 'safety',
    description: 'A deadline typed on the safety calendar was added, changed, marked done (a repeating one with its next occurrence) or cancelled.',
    payload: z.strictObject({ deadlineId: z.uuid(), kind: z.enum(DEADLINE_KINDS), change: z.enum(DEADLINE_CHANGES), nextId: z.uuid().nullable() }),
    live: live(['deadlineId', 'kind', 'change']),
  }),
] as const

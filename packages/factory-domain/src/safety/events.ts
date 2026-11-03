import { z } from 'zod'
import { defineEvent } from '../events/define'
import { DEADLINE_KINDS } from './calendar/rules'
import { SAFETY_ROLES } from './organisation/rules'
// B-W2b-125: incidents.
import { ACTION_LINKS, FILING_STATUSES, INCIDENT_KINDS, INCIDENT_STATUSES, REPORTED_VIA } from './incidents/rules'

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

// ---- B-W2b-125: incidents, near misses and hazards (QHS-265, QHS-268, QHS-270; design plant.incidents "live": "incident.reported
// (floor) → row, tiles; injury with absence → deadline Banner", "inail.filed → Countdown cleared"; floor.incident "The safety
// officer opens it → 'Seen by safety at 10:45'"). apps/factory-api's modules/safety/incidents emits them. Ids, kinds, states
// and the INAIL deadline only: never a person, an injury, a filing's type, absence or certificate (protected, GDPR art. 9),
// never who sent a report without a name. Live to safety.incidents.view over the incident's company and site; only "seen"
// reaches the site's tablets (the reporting one knows its own report's id; nothing on the server names the tablet).
export const INCIDENT_CHANGES = ['EDITED', 'CLOSED', 'REOPENED', 'CANCELLED', 'PEOPLE_CHANGED'] as const
export const INCIDENT_ACTION_CHANGES = ['ADDED', 'EDITED', 'MADE', 'DONE', 'CANCELLED'] as const
export const INAIL_FILING_CHANGES = ['ADDED', 'EDITED', 'CERTIFICATE', 'FILED', 'NOT_NEEDED', 'NEEDED', 'RECEIPT'] as const

const incidentLive = (fields: readonly string[]) => ({ permission: 'safety.incidents.view', fields }) as const

export const incidentEvents = [
  defineEvent({
    type: 'incident.reported',
    context: 'safety',
    description: 'An incident, a near miss or a hazard was reported: from a tablet (with the worker, or without a name) or from the office; or opened by the system from a machine locked as unsafe.',
    payload: z.strictObject({ incidentId: z.uuid(), number: z.string(), kind: z.enum(INCIDENT_KINDS), reportedVia: z.enum(REPORTED_VIA), anonymous: z.boolean(), fromRequestId: z.uuid().nullable() }),
    live: incidentLive(['incidentId', 'number', 'kind', 'reportedVia']),
  }),
  defineEvent({
    type: 'incident.changed',
    context: 'safety',
    description: 'An incident was corrected, closed, reopened or cancelled, or its people involved changed.',
    payload: z.strictObject({ incidentId: z.uuid(), number: z.string(), change: z.enum(INCIDENT_CHANGES), status: z.enum(INCIDENT_STATUSES) }),
    live: incidentLive(['incidentId', 'number', 'change', 'status']),
  }),
  defineEvent({
    type: 'incident.seen',
    context: 'safety',
    description: 'A safety role opened an incident for the first time ("Seen by safety").',
    payload: z.strictObject({ incidentId: z.uuid(), number: z.string(), seenAt: z.string() }),
    live: { permission: 'safety.incidents.view', floor: 'floor.work', fields: ['incidentId', 'number', 'seenAt'] },
  }),
  defineEvent({
    type: 'incident_action.changed',
    context: 'safety',
    description: "An incident's action was added, changed, made into a maintenance job, a measure of the improvement plan or a training session, done or cancelled.",
    payload: z.strictObject({ incidentId: z.uuid(), actionId: z.uuid(), change: z.enum(INCIDENT_ACTION_CHANGES), madeInto: z.enum(ACTION_LINKS).nullable(), recordId: z.uuid().nullable() }),
    live: incidentLive(['incidentId', 'actionId', 'change', 'madeInto']),
  }),
  defineEvent({
    type: 'inail_filing.changed',
    context: 'safety',
    description: "An INAIL filing of an incident was added, its certificate recorded (the 48-hour clock starts), its filing on the INAIL portal recorded with INAIL's receipt, or it was marked not needed or needed again.",
    payload: z.strictObject({ incidentId: z.uuid(), filingId: z.uuid(), change: z.enum(INAIL_FILING_CHANGES), status: z.enum(FILING_STATUSES), dueAt: z.string().nullable() }),
    live: incidentLive(['incidentId', 'filingId', 'change', 'status', 'dueAt']),
  }),
] as const

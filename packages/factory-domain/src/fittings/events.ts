import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * Fittings, alterations and remakes (B-W2b-360; SAL-054, SAL-297, SAL-353; the code is factory-domain sales/fittings).
 * apps/factory-api's modules/sales/fittings emits them in the command that makes the change. A module folder of its own
 * (check-event-contract wants src/<module>/events.ts).
 *
 *   appointment.booked        a fitting, a showroom visit or a measuring session was booked with a customer
 *   appointment.changed       a booked one moved (time, place, who, rider, profile revision), or its notes changed, or a done
 *                             one named the revision it led to
 *   appointment.closed        it took place (DONE), the rider did not come (MISSED) or it was CANCELLED
 *   appointment.mailed        the rider was sent the invite (.ics), its update, the reminder or the cancellation
 *   fitting_result.recorded   what a fitting found: OK, ALTER (per point the change asked) or REMAKE
 *   fitting_result.linked     a fitting result named the alteration it opened or the new measurement revision it led to
 *   remake_order.made         a return's made-to-measure units decided REMAKE got their remake order
 *
 * They reach the office's made-to-measure screens (sales.measurements.view over the customer) and, for the remake order, the
 * returns (sales.returns.view): ids, kinds and states only; never a measure, a name, a place or words.
 */
export const APPOINTMENT_MAILS = ['INVITE', 'UPDATE', 'REMINDER', 'CANCEL'] as const

const kind = z.enum(['FITTING', 'SHOWROOM', 'MEASURING'])

export const events = [
  defineEvent({
    type: 'appointment.booked',
    context: 'fittings',
    description: 'A fitting, a showroom visit or a measuring session was booked with a customer.',
    payload: z.strictObject({ appointmentId: z.uuid(), partyId: z.uuid(), kind, profileId: z.uuid().nullable(), startsAt: z.string() }),
    live: { permission: 'sales.measurements.view', fields: ['appointmentId', 'partyId', 'kind', 'profileId', 'startsAt'] },
  }),
  defineEvent({
    type: 'appointment.changed',
    context: 'fittings',
    description: 'A booked appointment moved (time, place, who, rider or profile revision), its notes changed, or a done one named the revision it led to.',
    payload: z.strictObject({ appointmentId: z.uuid(), partyId: z.uuid(), fields: z.array(z.string()) }),
    live: { permission: 'sales.measurements.view', fields: ['appointmentId', 'partyId', 'fields'] },
  }),
  defineEvent({
    type: 'appointment.closed',
    context: 'fittings',
    description: 'An appointment took place, the rider did not come, or it was cancelled.',
    payload: z.strictObject({ appointmentId: z.uuid(), partyId: z.uuid(), kind, status: z.enum(['DONE', 'MISSED', 'CANCELLED']) }),
    live: { permission: 'sales.measurements.view', fields: ['appointmentId', 'partyId', 'kind', 'status'] },
  }),
  defineEvent({
    type: 'appointment.mailed',
    context: 'fittings',
    description: 'The rider was sent the invite of an appointment (.ics), its update, the reminder or the cancellation.',
    payload: z.strictObject({ appointmentId: z.uuid(), partyId: z.uuid(), mail: z.enum(APPOINTMENT_MAILS), outboundId: z.uuid() }),
    live: { permission: 'sales.measurements.view', fields: ['appointmentId', 'partyId', 'mail'] },
  }),
  defineEvent({
    type: 'fitting_result.recorded',
    context: 'fittings',
    description: 'What a fitting of a made-to-measure unit found was recorded: it fits, it needs an alteration, or it is remade.',
    payload: z.strictObject({ resultId: z.uuid(), partyId: z.uuid(), profileId: z.uuid(), verdict: z.enum(['OK', 'ALTER', 'REMAKE']), appointmentId: z.uuid().nullable(), salesOrderLineId: z.uuid().nullable() }),
    live: { permission: 'sales.measurements.view', fields: ['resultId', 'partyId', 'profileId', 'verdict', 'appointmentId', 'salesOrderLineId'] },
  }),
  defineEvent({
    type: 'fitting_result.linked',
    context: 'fittings',
    description: 'A fitting result named the alteration it opened or the new measurement revision it led to.',
    payload: z.strictObject({ resultId: z.uuid(), partyId: z.uuid(), alterationRepairId: z.uuid().nullable(), newProfileId: z.uuid().nullable() }),
    live: { permission: 'sales.measurements.view', fields: ['resultId', 'partyId', 'alterationRepairId', 'newProfileId'] },
  }),
  defineEvent({
    type: 'remake_order.made',
    context: 'fittings',
    description: "A return's made-to-measure units decided Remake got their remake order (a new unit at no price, made to the measures named).",
    payload: z.strictObject({ returnId: z.uuid(), number: z.string(), orderId: z.uuid(), orderNumber: z.string(), lineIds: z.array(z.uuid()), waits: z.boolean() }),
    live: { permission: 'sales.returns.view', fields: ['returnId', 'number', 'orderId', 'orderNumber', 'lineIds', 'waits'] },
  }),
] as const

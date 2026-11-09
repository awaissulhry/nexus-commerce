import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * Measurements by link (B-W2b-171; SAL-096, SAL-286). apps/factory-api's modules/sales/measure-link emits them in the
 * command that makes the move. Their own module folder (as portal-returns/events.ts: check-event-contract wants
 * src/<module>/events.ts); the code is factory-domain sales/measure-link.
 *
 *   measure_link.sent           the office made a MEASUREMENTS link for a rider's measurement profile: ids, whether it was
 *                               mailed and whether photos are asked; never the token or the address
 *   measurements.submitted      a rider sent measurements through the link: a new revision of the profile (who sent it is the
 *                               link), with how many photos; never a value
 *   measurement_photos.deleted  the body photos of a revision were deleted (their retention ended, or the office set the day):
 *                               the numbers stay
 *
 * Reach the office's measurement screens (sales.measurements.view over the profile's company and customer): ids and counts
 * only; never a measurement, a name or an address.
 */

export const events = [
  defineEvent({
    type: 'measure_link.sent',
    context: 'measure-link',
    description: "A link to send measurements was made for a rider's measurement profile (mailed, or handed over by the office).",
    payload: z.strictObject({ linkId: z.uuid(), profileId: z.uuid(), partyId: z.uuid(), mailed: z.boolean(), photos: z.enum(['REQUIRED', 'OPTIONAL']), expiresAt: z.iso.datetime() }),
    live: { permission: 'sales.measurements.view', fields: ['linkId', 'profileId', 'partyId'] },
  }),
  defineEvent({
    type: 'measurements.submitted',
    context: 'measure-link',
    description: 'A rider sent measurements through a link: a new revision of the measurement profile waits for the office to review it.',
    payload: z.strictObject({ profileId: z.uuid(), supersedesId: z.uuid(), linkId: z.uuid(), partyId: z.uuid(), revision: z.number().int().min(2), photos: z.number().int().min(0).max(3) }),
    live: { permission: 'sales.measurements.view', fields: ['profileId', 'supersedesId', 'partyId', 'revision'] },
  }),
  defineEvent({
    type: 'measurement_photos.deleted',
    context: 'measure-link',
    description: 'The body photos of a measurement revision were deleted when their retention ended; the measurements stay.',
    payload: z.strictObject({ profileId: z.uuid(), partyId: z.uuid(), files: z.number().int().min(1).max(3) }),
    live: { permission: 'sales.measurements.view', fields: ['profileId', 'partyId'] },
  }),
] as const

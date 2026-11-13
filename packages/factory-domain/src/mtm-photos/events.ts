import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * Made-to-measure office photos (B-W2b-371, XF2:01; the code is factory-domain sales/mtm-photos). apps/factory-api's
 * modules/sales/mtm/photos emits them in the command that makes the change. A module folder of its own (check-event-contract
 * wants src/<module>/events.ts).
 *
 *   measurement_photo.added   an office photo of a rider's profile revision (MTM_PHOTO) or of a fitting (FITTING_PHOTO) arrived
 *   measurement_photo.dated   a photo's delete date was set or moved (by a person, or by the job once the garment shipped)
 *   measurement_photo.deleted the photos of a rider's profile (its revisions' and its fittings') whose delete date came were deleted
 *
 * They reach the rider profile (sales.measurements.view over the customer): ids, codes and counts only; never a photo, a name or a
 * measure. (B-W2b-171's measurement_photos.deleted is the body photos sent by link, at most three a revision.)
 */
const category = z.enum(['MTM_PHOTO', 'FITTING_PHOTO'])

export const events = [
  defineEvent({
    type: 'measurement_photo.added',
    context: 'mtm-photos',
    description: "An office photo of a rider's measurement profile revision or of a fitting arrived.",
    payload: z.strictObject({ profileId: z.uuid(), partyId: z.uuid(), fileId: z.uuid(), category, resultId: z.uuid().nullable() }),
    live: { permission: 'sales.measurements.view', fields: ['profileId', 'partyId', 'fileId', 'category', 'resultId'] },
  }),
  defineEvent({
    type: 'measurement_photo.dated',
    context: 'mtm-photos',
    description: "A made-to-measure photo's delete date was set or moved.",
    payload: z.strictObject({ profileId: z.uuid(), partyId: z.uuid(), fileId: z.uuid(), category, deleteAfter: z.string() }),
    live: { permission: 'sales.measurements.view', fields: ['profileId', 'partyId', 'fileId', 'category', 'deleteAfter'] },
  }),
  defineEvent({
    type: 'measurement_photo.deleted',
    context: 'mtm-photos',
    description: "The made-to-measure photos of a rider's profile whose delete date came were deleted.",
    payload: z.strictObject({ profileId: z.uuid(), partyId: z.uuid(), files: z.number().int().min(1) }),
    live: { permission: 'sales.measurements.view', fields: ['profileId', 'partyId', 'files'] },
  }),
] as const

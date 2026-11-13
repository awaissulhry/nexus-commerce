import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * The made-to-measure office (B-W2b-358; SAL-291, SAL-292, SAL-303; the code is factory-domain sales/mtm). apps/factory-api's
 * modules/sales/mtm and modules/product/measures (templates-write.ts) emit them in the command that makes the change. A module
 * folder of its own (check-event-contract wants src/<module>/events.ts).
 *
 *   measurement_profile.recorded   the office recorded a rider's measurements: a new revision, WAITING for the factory review
 *   measurement_profile.reviewed   the factory review: CONFIRMED, or NEED_MORE (the words mailed to the rider or dealer)
 *   mtm_worksheet.made             a version of the made-to-measure worksheet and order form (PDF) was kept
 *   measurement_template.changed   a measurement template was created, its header or points changed, archived or restored
 *
 * Profiles reach the office's made-to-measure screens (sales.measurements.view over the profile's customer), templates the size
 * library (product.styles.view): ids, codes and states only; never a measurement, a name or the review's words.
 */
export const MEASUREMENT_TEMPLATE_CHANGES = ['CREATED', 'UPDATED', 'POINTS', 'ARCHIVED', 'RESTORED'] as const

export const events = [
  defineEvent({
    type: 'measurement_profile.recorded',
    context: 'mtm-office',
    description: "The office recorded a rider's measurements: a new revision of the measurement profile waits for the factory review.",
    payload: z.strictObject({ profileId: z.uuid(), partyId: z.uuid(), garmentType: z.string(), revision: z.number().int().min(1), supersedesId: z.uuid().nullable() }),
    live: { permission: 'sales.measurements.view', fields: ['profileId', 'partyId', 'garmentType', 'revision', 'supersedesId'] },
  }),
  defineEvent({
    type: 'measurement_profile.reviewed',
    context: 'mtm-office',
    description: "The factory reviewed a rider's measurements: confirmed, or more was asked of the rider or dealer.",
    payload: z.strictObject({ profileId: z.uuid(), partyId: z.uuid(), revision: z.number().int().min(1), status: z.enum(['CONFIRMED', 'NEED_MORE']), mailed: z.boolean(), ordersGoneOn: z.number().int().min(0) }),
    live: { permission: 'sales.measurements.view', fields: ['profileId', 'partyId', 'revision', 'status'] },
  }),
  defineEvent({
    type: 'mtm_worksheet.made',
    context: 'mtm-office',
    description: 'A version of the made-to-measure worksheet and order form of a measurement profile revision was kept.',
    payload: z.strictObject({ profileId: z.uuid(), partyId: z.uuid(), version: z.number().int().min(1), generatedDocumentId: z.uuid(), fileId: z.uuid() }),
    live: { permission: 'sales.measurements.view', fields: ['profileId', 'partyId', 'version'] },
  }),
  defineEvent({
    type: 'measurement_template.changed',
    context: 'mtm-office',
    description: 'A measurement template was created, its header or points changed, or it was archived or restored.',
    payload: z.strictObject({ templateId: z.uuid(), code: z.string(), change: z.enum(MEASUREMENT_TEMPLATE_CHANGES) }),
    live: { permission: 'product.styles.view', fields: ['templateId', 'code', 'change'] },
  }),
] as const

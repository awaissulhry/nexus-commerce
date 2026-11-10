import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * The prepacks' event (B-W2b-233; the code is factory-domain product/prepacks). A module folder of its own, as
 * product-measures and product-options (the event guard wants `src/<module>/events.ts`). apps/factory-api's
 * modules/product/prepacks emits it in the command that makes the change.
 *
 *   prepack.changed   a prepack of a style or of a size scale was added, its code or name changed, its lines changed,
 *                     archived or restored (`styleId` null: a prepack of every style of the scale)
 *
 * Live on the style's Sizes & measurements tab for product.styles.view. Ids, codes and what changed only: no person, no
 * money (W2b-5's orders read the prepack again).
 */
export const PREPACK_CHANGES = ['CREATED', 'UPDATED', 'LINES', 'ARCHIVED', 'RESTORED'] as const

export const events = [
  defineEvent({
    type: 'prepack.changed',
    context: 'product-prepacks',
    description: 'A prepack (a fixed mix of pieces per size, and colourway, that dealers order) of a style or of every style of a size scale was added, renamed, its lines changed, archived or restored.',
    payload: z.strictObject({ prepackId: z.uuid(), code: z.string(), sizeScaleId: z.uuid(), styleId: z.uuid().nullable(), change: z.enum(PREPACK_CHANGES) }),
    live: { permission: 'product.styles.view', fields: ['prepackId', 'code', 'sizeScaleId', 'styleId', 'change'] },
  }),
] as const

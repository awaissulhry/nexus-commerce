import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * Protector placement's event (B-W2b-233; the code is factory-domain product/protectors). A module folder of its own, as
 * product-measures (the event guard wants `src/<module>/events.ts`). apps/factory-api's modules/product/protectors emits it
 * in the command that makes the change.
 *
 *   style.protectors_changed   a draft revision's protector placement changed: a placement added, changed (pocket,
 *                              protector, standard, level, sizes, where the pocket sits), removed, or the list reordered
 *
 * Live on the style's Sizes & measurements tab for product.bom.view. Ids, codes and what changed only: no person, no money.
 * A copied revision's placements come with W1's revision event (modules/product/measures/copy.ts).
 */
export const PROTECTOR_CHANGES = ['ADDED', 'UPDATED', 'REMOVED', 'ORDERED'] as const

export const events = [
  defineEvent({
    type: 'style.protectors_changed',
    context: 'product-protectors',
    description: "A draft revision's protector placement changed: which protector goes in which pocket, its standard, level and sizes, where the pocket sits, or the order.",
    payload: z.strictObject({ styleId: z.uuid(), code: z.string(), revisionId: z.uuid(), revision: z.number().int(), change: z.enum(PROTECTOR_CHANGES), placementIds: z.array(z.uuid()) }),
    live: { permission: 'product.bom.view', fields: ['styleId', 'code', 'revisionId', 'revision', 'change'] },
  }),
] as const

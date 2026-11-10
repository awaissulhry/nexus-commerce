import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * The colour library and the brands' branding sets (B-W2b-247; the code is factory-domain product/colours and
 * product/branding-sets). A module folder of its own, as product-images (the event guard wants `src/<module>/events.ts`).
 * apps/factory-api's modules/product/colours and modules/product/branding-sets emit them in the command that makes the
 * change.
 *
 *   colour.changed         a library colour added, changed (names, system, reference, family, hex), archived or restored
 *   branding_set.changed   a brand's set started (its old one archived in the same command), changed (name, note, colours,
 *                          packaging rules, file order), given a file, archived or restored
 *
 * Live on Products › Colours & artwork for product.styles.view; the search index follows both. Ids, codes and what changed
 * only: no person, no money.
 */
export const COLOUR_CHANGES = ['CREATED', 'UPDATED', 'ARCHIVED', 'RESTORED'] as const
export const BRANDING_SET_CHANGES = ['CREATED', 'UPDATED', 'FILE_ADDED', 'ARCHIVED', 'RESTORED'] as const

export const events = [
  defineEvent({
    type: 'colour.changed',
    context: 'product-colours',
    description: 'A colour of the library was added, changed (names, system, reference, family or hex), archived or restored.',
    payload: z.strictObject({ colourId: z.uuid(), code: z.string(), change: z.enum(COLOUR_CHANGES), fields: z.array(z.string()) }),
    live: { permission: 'product.styles.view', fields: ['colourId', 'code', 'change', 'fields'] },
  }),
  defineEvent({
    type: 'branding_set.changed',
    context: 'product-colours',
    description: "A private-label brand's branding set was started, changed (name, note, brand colours, packaging rules or files), given a file, archived or restored.",
    payload: z.strictObject({ brandingSetId: z.uuid(), partyId: z.uuid(), code: z.string(), change: z.enum(BRANDING_SET_CHANGES), fields: z.array(z.string()) }),
    live: { permission: 'product.styles.view', fields: ['brandingSetId', 'partyId', 'code', 'change', 'fields'] },
  }),
] as const

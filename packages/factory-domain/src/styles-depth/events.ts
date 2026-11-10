import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * Styles in depth events (B-W2b-227; the code is factory-domain product/{style-texts,gtin,where-used}). A module folder of
 * its own, as product-lifecycle (the event guard wants `src/<module>/events.ts`). apps/factory-api's
 * modules/product/{style-texts,gtin} emit them in the command that makes the change. A private label set or changed is W1's
 * style.updated (fields brandPartyId, soldUnderOurName); GTINs given to SKUs (typed, imported or from a range) are W1's
 * style.skus_changed (`updated`).
 *
 *   style.texts_changed    a style's name and descriptions in one language were written or removed (the search re-reads
 *                          the style's names)
 *   gtin_range.changed     a GS1 GTIN range was added, changed, archived or restored, or gave numbers
 *
 * Live for product.styles.view. Ids, codes and counts only: no person, no money.
 */
export const TEXT_CHANGES = ['SET', 'REMOVED'] as const
export const GTIN_RANGE_CHANGES = ['CREATED', 'UPDATED', 'ARCHIVED', 'RESTORED', 'ASSIGNED'] as const

export const events = [
  defineEvent({
    type: 'style.texts_changed',
    context: 'styles-depth',
    description: "A style's name and descriptions in one language were written or removed.",
    payload: z.strictObject({ styleId: z.uuid(), code: z.string(), language: z.string(), change: z.enum(TEXT_CHANGES) }),
    live: { permission: 'product.styles.view', fields: ['styleId', 'code', 'language', 'change'] },
  }),
  defineEvent({
    type: 'gtin_range.changed',
    context: 'styles-depth',
    description: "A GS1 GTIN range of a company was added, changed, archived or restored, or gave GTINs to a style's SKUs.",
    payload: z.strictObject({ gtinRangeId: z.uuid(), companyId: z.uuid(), name: z.string(), change: z.enum(GTIN_RANGE_CHANGES), given: z.number().int() }),
    live: { permission: 'product.styles.view', fields: ['gtinRangeId', 'companyId', 'name', 'change', 'given'] },
  }),
] as const

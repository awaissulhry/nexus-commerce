import { z } from 'zod'
import { defineEvent } from '../events/define'
import { MINIMUM_CHANGES } from '../sales/pricing-depth/rules'

/**
 * Price lists in depth (B-W2b-325; SAL-166, SAL-167, SAL-178, SAL-180). apps/factory-api's modules/sales/pricing-depth
 * emits them in the command that makes the change. Their own module folder (the event guard wants src/<module>/events.ts):
 * the code is factory-domain sales/pricing-depth. A version's dated prices and imported prices move W2a's
 * `price_list.version_changed` (change PRICES); the discount shown on documents moves `price_list.changed` (UPDATED).
 *
 *   price_list.rules_changed       a draft version's quantity breaks or size surcharges were set or removed
 *   style.size_surcharges_changed  a style's own size surcharges (whatever list prices it) were set or removed
 *   minimum_order.changed          a minimum order quantity was made, edited, archived, reactivated or removed
 *
 * Reach the office's price list screens (pricelists.view): ids, codes and what changed; never a price.
 */

export const events = [
  defineEvent({
    type: 'price_list.rules_changed',
    context: 'sales-pricing',
    description: "A draft price list version's quantity breaks or size surcharges were set or removed.",
    payload: z.strictObject({ listId: z.uuid(), versionId: z.uuid(), revision: z.number().int(), change: z.enum(['BREAKS', 'SIZE_SURCHARGES']), rows: z.number().int().min(1) }),
    live: { permission: 'pricelists.view', fields: ['listId', 'versionId', 'revision', 'change'] },
  }),
  defineEvent({
    type: 'style.size_surcharges_changed',
    context: 'sales-pricing',
    description: "A style's own size surcharges (what a big size adds, whatever list prices the style) were set or removed.",
    payload: z.strictObject({ styleId: z.uuid(), code: z.string(), sizes: z.array(z.string()) }),
    live: { permission: 'pricelists.view', fields: ['styleId', 'code', 'sizes'] },
  }),
  defineEvent({
    type: 'minimum_order.changed',
    context: 'sales-pricing',
    description: 'A minimum order quantity (of a style, a kind of garment or a material) was made, edited, archived, reactivated or removed.',
    // `listId`: the price list whose customers it binds (null: every customer; a live field may not look like money).
    payload: z.strictObject({ ruleId: z.uuid(), companyId: z.uuid().nullable(), listId: z.uuid().nullable(), change: z.enum(MINIMUM_CHANGES), fields: z.array(z.string()) }),
    live: { permission: 'pricelists.view', fields: ['ruleId', 'listId', 'change'] },
  }),
] as const

import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * The option library's event (B-W2b-229; the code is factory-domain product/options). A module folder of its own, as
 * product-lifecycle and routing-depth (the event guard wants `src/<module>/events.ts`). apps/factory-api's
 * modules/product/options emits it in the command that makes the change; a style's offers changed are W1's style.updated
 * (field `optionGroups`), a draft BOM line's option W1's style.bom_changed.
 *
 *   option_group.changed   a group was added, changed, archived or restored, or its values, rules, effects or prices
 *                          changed (`valueIds`: the values concerned, empty for the group's own fields and its rules)
 *
 * Live on the Options & rules screens for product.styles.view. Ids, codes and what changed only: never a price (the screen
 * refetches with its viewer's grains).
 */
export const OPTION_GROUP_CHANGES = ['CREATED', 'UPDATED', 'ARCHIVED', 'RESTORED', 'VALUES', 'RULES', 'EFFECTS', 'PRICES'] as const

export const events = [
  defineEvent({
    type: 'option_group.changed',
    context: 'product-options',
    description: 'An option group was added, changed, archived or restored, or its values, requires and excludes rules, effects or price surcharges changed.',
    payload: z.strictObject({ optionGroupId: z.uuid(), code: z.string(), change: z.enum(OPTION_GROUP_CHANGES), valueIds: z.array(z.uuid()) }),
    live: { permission: 'product.styles.view', fields: ['optionGroupId', 'code', 'change'] },
  }),
] as const

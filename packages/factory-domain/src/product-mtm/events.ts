import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * The made-to-measure rules' event (B-W2b-248; the code is factory-domain product/mtm-rules). A module folder of its own,
 * as product-measures (the event guard wants `src/<module>/events.ts`). apps/factory-api's modules/product/mtm-rules emits
 * it in the command that makes the change; marking a BOM line to scale emits W1's `style.bom_changed`.
 *
 *   measurement_template.mtm_rules_changed   a template's plausibility rules, base size rule or alteration limits saved
 *                                            (RULES), or the rules turned on (ON) or off (OFF)
 *
 * Live on the Sizes & measurements library for product.styles.view. Ids, codes and what changed only: no person.
 */
export const MTM_RULE_CHANGES = ['RULES', 'ON', 'OFF'] as const

export const events = [
  defineEvent({
    type: 'measurement_template.mtm_rules_changed',
    context: 'product-mtm',
    description: "A measurement template's made-to-measure rules were saved (plausibility rules, base size rule, alteration limits), or turned on or off.",
    payload: z.strictObject({ templateId: z.uuid(), code: z.string(), change: z.enum(MTM_RULE_CHANGES) }),
    live: { permission: 'product.styles.view', fields: ['templateId', 'code', 'change'] },
  }),
] as const

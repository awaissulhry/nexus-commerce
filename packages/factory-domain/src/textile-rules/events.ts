import { z } from 'zod'
import { defineEvent } from '../events/define'
import { SWITCHABLE_RULES } from '../compliance/textile-rules/rules'

/**
 * The textile, leather and origin checks' event (B-W2b-208; the code is factory-domain compliance/textile-rules). A module
 * folder of its own, as plant-dies and portal-ordering (the event guard wants `src/<module>/events.ts`).
 * apps/factory-api's modules/compliance/textile-rules emits it in the command that makes the change.
 *
 *   textile_rule.switched   a person switched the 80 % textile threshold, the care label or the "Made in Italy" check on
 *                           or off for the whole factory, with the reason
 *
 * Live on the label screens for compliance.certificates.view (their Rule checks change); the gate of B-W2b-254 may follow
 * it. The rule and its new state only.
 */
export const events = [
  defineEvent({
    type: 'textile_rule.switched',
    context: 'textile-rules',
    description: 'A person switched a textile, care or origin check on or off for the whole factory, with the reason.',
    payload: z.strictObject({ rule: z.enum(SWITCHABLE_RULES), on: z.boolean() }),
    live: { permission: 'compliance.certificates.view', fields: ['rule', 'on'] },
  }),
] as const

import { z } from 'zod'
import { defineEvent } from '../events/define'
import { MATERIAL_APPROVALS } from '../product/bom-structure/rules'

/**
 * Materials in depth events (B-W2b-238; the code is factory-domain product/materials-depth). A module folder of its own, as
 * styles-depth (the event guard wants `src/<module>/events.ts`). apps/factory-api's modules/product/materials-depth emits it
 * in the command that decides. The typed properties of a material are W1's material.updated (`fields: ['properties']`).
 *
 *   material.approval_changed   a material was approved, approved on a condition, blocked or sent back to pending (the
 *                               material list and record, the BOM check and the style's Compliance tab read it again)
 *
 * Live for product.materials.view. Ids, codes and the decision only: no person, no reason, no money.
 */
export const events = [
  defineEvent({
    type: 'material.approval_changed',
    context: 'materials-depth',
    description: 'A material was approved, approved on a condition, blocked or sent back to pending.',
    payload: z.strictObject({ itemId: z.uuid(), code: z.string(), approval: z.enum(MATERIAL_APPROVALS), previous: z.enum(MATERIAL_APPROVALS) }),
    live: { permission: 'product.materials.view', fields: ['itemId', 'code', 'approval', 'previous'] },
  }),
] as const

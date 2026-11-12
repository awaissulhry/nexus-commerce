import { z } from 'zod'
import { defineEvent } from '../events/define'
import { SUBSTITUTE_KINDS, SUBSTITUTION_CHANGES, SUBSTITUTION_STATUSES } from '../inventory/substitutions/rules'

/**
 * The events of substitutes with a yes (B-W2b-298; MES-139; apps/factory-api modules/inventory/substitutions). Context
 * `inventory-substitutions`, its own module folder (as inventory-tasks, B-W2b-292: the inventory events file is other steps').
 * It reaches the office's warehouse and work-order screens (inventory.stock.view: "Substitutes waiting for approval") and the
 * tablets of the work order's site (floor.work: an approved substitute appears on the pick list by bin). No money, never who.
 *
 *   inventory.substitution_changed   once per substitute asked, approved (by its yes, or at once when nobody's is needed),
 *                                    refused, withdrawn or issued
 */
export const events = [
  defineEvent({
    type: 'inventory.substitution_changed',
    context: 'inventory-substitutions',
    description: 'A substitute material on a work order was asked for, approved, refused, withdrawn or issued.',
    payload: z.strictObject({
      substitutionId: z.uuid(),
      workOrderId: z.uuid(),
      bomLineId: z.uuid(),
      kind: z.enum(SUBSTITUTE_KINDS),
      fromItemId: z.uuid(),
      toItemId: z.uuid(),
      toLotId: z.uuid().nullable(),
      status: z.enum(SUBSTITUTION_STATUSES),
      change: z.enum(SUBSTITUTION_CHANGES),
      /** The request for its yes (an approval task), or null: none was asked. */
      approvalTaskId: z.uuid().nullable(),
      /** The ISSUE moves (ISSUED only). */
      moveIds: z.array(z.uuid()),
    }),
    live: { permission: 'inventory.stock.view', floor: 'floor.work', fields: ['substitutionId', 'workOrderId', 'status', 'change'] },
  }),
] as const

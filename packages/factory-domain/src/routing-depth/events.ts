import { z } from 'zod'
import { defineEvent } from '../events/define'
import { RECORD_KINDS } from '../quality/triggers/rules'

/**
 * A routing in depth (B-W2b-225; PRD-119). apps/factory-api's modules/product/routing-depth emits it: the worker's handler
 * `product.routingCheckpoints`, in the system command that opens the check. Its own module folder: the product events file
 * is W1's and the quality ones are other steps' (as quality-triggers). The step's other changes are W1's events
 * (`style.routing_changed` for a draft step, `operation.updated` for a library operation's settings).
 *
 *   routing_checkpoint.check_opened   a routing step's quality checkpoint opened an in-process check of a bundle at its
 *                                     operation (a cutting, roving, first-piece or end-of-line check)
 *
 * It reaches the office's inspection screens and the site's benches (quality.inspections.view, which the floor holds): a
 * new check to do. Ids, codes and kinds only, never a person.
 */
export const events = [
  defineEvent({
    type: 'routing_checkpoint.check_opened',
    context: 'routing-depth',
    description: "A routing step's quality checkpoint opened an in-process check of a bundle at its operation (cutting, roving, first piece or end of line).",
    payload: z.strictObject({
      routingStepId: z.uuid(),
      recordId: z.uuid(),
      kind: z.enum(RECORD_KINDS),
      planId: z.uuid(),
      planVersionId: z.uuid(),
      workOrderId: z.uuid(),
      workOrderOperationId: z.uuid(),
      bundleId: z.uuid(),
    }),
    live: { permission: 'quality.inspections.view', floor: 'quality.inspections.view', fields: ['recordId', 'kind', 'workOrderId', 'workOrderOperationId', 'bundleId'] },
  }),
] as const

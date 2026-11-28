import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { CLIENT_SCAN_ID } from '@nexus/factory-domain/production/scans/rules'
import { departmentLook } from '../baskets/board-contract'

/**
 * Chains (owb- order workflow, S5 fl4 step 3; `_owb-fl-common.md` § 3 "fl4", settle 10). Garments, never money; no customer
 * (a lot is a model and a size); no person.
 */

const lineView = output({ id: id(), code: z.string(), name: z.string() })

export const chainsContract = defineContract({
  response: { 200: output({ lines: z.array(lineView.extend({ workOrders: z.number().int() })) }) },
})

export const chainContract = defineContract({
  params: input({ lineId: id() }),
  /** One step only (the floor's chain screen): its numbers and the lots' at it. */
  querystring: input({ operationId: id().optional() }),
  response: {
    200: output({
      line: lineView,
      steps: z.array(output({ operationId: id(), workOrderId: id(), name: z.string(), department: departmentLook.nullable(), waiting: z.number().int(), done: z.number().int(), slowest: z.boolean() })),
      lots: z.array(
        output({
          workOrderSizeId: id(),
          workOrderId: id(),
          /** The model: the style's code and the colourway's. */
          model: z.string(),
          size: z.string(),
          perStep: z.array(output({ operationId: id(), done: z.number().int(), waiting: z.number().int() })),
        }),
      ),
    }),
  },
})

export const chainReportContract = defineContract({
  body: input({
    lineId: id(),
    operationId: id(),
    workOrderSizeId: id(),
    /** The phone's id for the "+12" (the scan's client scan id): a resent tap reports once. */
    clientEventId: z.string().regex(CLIENT_SCAN_ID, 'Expected 8 to 64 letters, digits, dots, colons, underscores or hyphens.'),
  }),
  response: {
    201: output({ scan: output({ id: id() }), bundle: output({ id: id(), code: z.string(), quantity: z.number().int() }), operationId: id(), replayed: z.boolean() }),
    200: output({ scan: output({ id: id() }), bundle: output({ id: id(), code: z.string(), quantity: z.number().int() }), operationId: id(), replayed: z.boolean() }),
  },
})

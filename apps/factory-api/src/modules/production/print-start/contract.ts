import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { CHECK_CLASSES } from '@nexus/factory-domain/production/print-start/checks'

/**
 * "Print and start the work" (owb- order workflow, S3 ss2 step 2.2; the Shape of build/briefs/owb-ss2.md, FIXED: web A ss4 codes
 * against it). No money anywhere. A version is the ORDER's version as read. A refused print answers 409 with every problem as an
 * issue of the API's error envelope (`problem/<CODE>`, the words; S3 lead settle 09:13); a refusal of the order itself
 * `refusal/<CODE>` (PRINTED, NOT_CONFIRMED, SITE, BASKETS_*).
 */

const orderParams = input({ orderId: id() })

const problem = output({ code: z.string(), class: z.enum(CHECK_CLASSES), workOrderNumber: z.string().nullable(), words: z.string() })

export const printStartPreviewContract = defineContract({
  params: orderParams,
  response: {
    200: output({
      orderId: id(),
      version: z.number().int(),
      state: z.enum(['READY', 'PRINTED', 'NOT_CONFIRMED']),
      printedAt: instant().nullable(),
      /** The site switch: some making site makes its baskets at print. */
      basketsAtPrint: z.boolean(),
      /** null id: a work order the print will make. */
      workOrders: z.array(output({ workOrderId: id().nullable(), number: z.string().nullable(), styleCode: z.string(), pieces: z.number().int(), status: z.string().nullable() })),
      problems: z.array(problem),
      refused: z.boolean(),
      needsMaterialReason: z.boolean(),
      /** count 0 when no making site makes baskets at print. */
      baskets: output({ count: z.number().int(), lines: z.array(output({ salesOrderLineId: id(), label: z.string(), baskets: z.number().int() })) }),
      pages: z.array(output({ salesOrderLineId: id(), label: z.string(), fileId: id().nullable(), pageCount: z.number().int().nullable(), placed: z.boolean() })),
      placed: output({ done: z.number().int(), of: z.number().int() }),
    }),
  },
})

export const printAndStartContract = defineContract({
  params: orderParams,
  body: input({ version: z.number().int().min(1).optional(), materialReason: z.string().trim().min(3).max(500).optional() }),
  response: { 200: output({ printId: id(), orderId: id(), workOrders: z.array(output({ id: id(), number: z.string() })), baskets: z.number().int(), version: z.number().int() }) },
})

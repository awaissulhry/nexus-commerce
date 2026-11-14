import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { TRACKING_EXCEPTION_KINDS } from '@nexus/factory-domain/shipping/exceptions/rules'

/** Tracking problems (B-W2b-398; LOG-063). Codes only: the screens say them in the reader's language. No money, no person. */

const problem = output({
  id: id(),
  kind: z.enum(TRACKING_EXCEPTION_KINDS),
  raisedAt: instant(),
  resolvedAt: instant().nullable(),
  /** The task a person works it in (collab Task of the shipment). */
  taskId: id().nullable(),
})

const shipmentProblems = output({
  shipment: output({ id: id(), number: z.string(), status: z.string() }),
  /** The daily check's "no carrier news" threshold, in days. */
  noScanDays: z.number().int(),
  problems: z.array(problem.extend({ taskStatus: z.string().nullable(), raisedBySystem: z.boolean() })),
})

export const shipmentProblemsContract = defineContract({
  params: input({ shipmentId: id() }),
  response: { 200: shipmentProblems },
})

export const listProblemsContract = defineContract({
  querystring: input({ siteId: id().optional(), open: z.enum(['true', 'false']).optional() }),
  response: {
    200: output({
      problems: z.array(problem.extend({ shipment: output({ id: id(), number: z.string(), status: z.string(), siteId: id(), carrierName: z.string().nullable(), expectedDeliveryAt: instant().nullable() }) })),
      truncated: z.boolean(),
    }),
  },
})

export const resolveProblemContract = defineContract({
  params: input({ shipmentId: id(), exceptionId: id() }),
  /** What was done about it (kept on the audit row). */
  body: input({ note: z.string().max(500).optional() }),
  response: { 200: shipmentProblems },
})

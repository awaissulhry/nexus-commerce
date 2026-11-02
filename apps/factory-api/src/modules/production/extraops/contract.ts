import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { WORK_CENTRE_KINDS } from '@nexus/factory-domain/product/routing/operations'
import { EXTRA_REASON_CODES } from '@nexus/factory-domain/production/extraops/rules'

/**
 * An unplanned operation (B-W2b-47; MES-086). Standard minutes are no money; nothing names a person: who added it stays in
 * the audit log, `addedOn` says where. An invalid move answers 409 invalid_state in words.
 */

const workOrderParams = input({ workOrderId: id() })
const operation = output({ id: id(), code: z.string(), name: z.string(), workCentreKind: z.enum(WORK_CENTRE_KINDS), standardMinutes: z.string() })
const record = output({ id: id(), at: instant(), operation, reasonCode: z.enum(EXTRA_REASON_CODES), reason: z.string().nullable(), addedOn: z.enum(['FLOOR', 'OFFICE']) })
const workOrder = output({ id: id(), number: z.string() })

export const choicesContract = defineContract({
  params: workOrderParams,
  response: {
    200: output({
      workOrder,
      /** The library's active operations the routing does not have. */
      operations: z.array(operation),
      reasons: z.array(output({ code: z.enum(EXTRA_REASON_CODES), label: output({ it: z.string(), en: z.string() }), needsNote: z.boolean() })),
      /** The ones added so far, oldest first. */
      added: z.array(record),
    }),
  },
})

export const addContract = defineContract({
  params: workOrderParams,
  body: input({
    /** An operation of the library. */
    operationId: id(),
    reasonCode: z.enum(EXTRA_REASON_CODES),
    /** A few words; required with OTHER. */
    note: z.string().trim().min(3).max(200).optional(),
  }),
  response: { 200: record, 201: record },
})

export const listContract = defineContract({ params: workOrderParams, response: { 200: output({ workOrder, added: z.array(record) }) } })

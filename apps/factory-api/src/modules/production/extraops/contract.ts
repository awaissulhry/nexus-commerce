import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { WORK_CENTRE_KINDS } from '@nexus/factory-domain/product/routing/operations'
import { EXTRA_PAYS, EXTRA_REASON_CODES } from '@nexus/factory-domain/production/extraops/rules'

/**
 * An unplanned operation (B-W2b-47, B-W2b-82; MES-086). Standard minutes are no money, and `pays` is a word, never a figure;
 * nothing names a person: who added it stays in the audit log, `addedOn` says where. `workOrderOperationId` is the step a
 * bundle is scanned at (null: a record from before B-W2b-82). An invalid move answers 409 invalid_state in words.
 */

const workOrderParams = input({ workOrderId: id() })
const operation = output({ id: id(), code: z.string(), name: z.string(), workCentreKind: z.enum(WORK_CENTRE_KINDS), standardMinutes: z.string() })
const pays = z.enum(EXTRA_PAYS)
const record = output({ id: id(), workOrderOperationId: id().nullable(), seq: z.number().int().nullable(), at: instant(), operation, reasonCode: z.enum(EXTRA_REASON_CODES), reason: z.string().nullable(), addedOn: z.enum(['FLOOR', 'OFFICE']) })
const workOrder = output({ id: id(), number: z.string() })

export const choicesContract = defineContract({
  params: workOrderParams,
  response: {
    200: output({
      workOrder,
      /** The library's active operations the work order does not have, and what a report at each pays today. */
      operations: z.array(operation.extend({ pays })),
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
  response: { 200: record.extend({ pays }), 201: record.extend({ pays }) },
})

export const listContract = defineContract({ params: workOrderParams, response: { 200: output({ workOrder, added: z.array(record) }) } })

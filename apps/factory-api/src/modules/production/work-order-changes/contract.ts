import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { EXTRA_OUTCOMES, MAX_CHANGE_CELLS, MAX_CHANGE_PIECES, MAX_CHANGE_REASON, MAX_DECISION_NOTE, WORK_ORDER_CHANGE_KINDS, WORK_ORDER_CHANGE_STATUSES } from '@nexus/factory-domain/order-apply/rules'
import { WORK_ORDER_STATUSES } from '@nexus/factory-domain/production/work-orders/machine'

/**
 * B-SA-041 (sales page plan, lead picks P6', R1; 13-backend B4b): the work-order changes an accepted change of a sales order
 * proposes (factory-db WorkOrderChange). Office only. Ids, numbers, sizes and pieces; the proposer and the decider by name
 * inside the record (as an approval names them); never a price, never a person of the customer, never another customer.
 */

const version = z.number().int().min(1)
const words = output({ it: z.string(), en: z.string() })
const pieces = () => z.number().int().min(0).max(MAX_CHANGE_PIECES)
const size = () => z.string().trim().min(1).max(40)

const cellIn = input({ salesOrderLineId: id(), size: size(), from: pieces(), to: pieces(), workOrderSizeId: id().nullable() })
const extraIn = input({ workOrderSizeId: id(), salesOrderLineId: id(), size: size(), count: z.number().int().min(1).max(MAX_CHANGE_PIECES) })

const cellOut = output({ salesOrderLineId: id(), lineSeq: z.number().int().nullable(), size: z.string(), from: z.number().int(), to: z.number().int(), workOrderSizeId: id().nullable() })
const extraOut = output({ workOrderSizeId: id(), salesOrderLineId: id(), size: z.string(), count: z.number().int(), words })
const person = output({ id: id(), name: z.string() }).nullable()

export const changeSchema = output({
  id: id(),
  status: z.enum(WORK_ORDER_CHANGE_STATUSES),
  kind: z.enum(WORK_ORDER_CHANGE_KINDS),
  partyId: id(),
  salesOrder: output({ id: id(), number: z.string() }),
  /** The work order it changes (null: a MAKE_MORE that makes a new DRAFT, madeWorkOrder once applied). */
  workOrder: output({ id: id(), number: z.string(), status: z.enum(WORK_ORDER_STATUSES) }).nullable(),
  requestId: id().nullable(),
  amendmentId: id().nullable(),
  cells: z.array(cellOut),
  /** LOWER_TO_ORDER only: the pieces already cut beyond the new figure, and what happens to them. */
  extra: z.array(extraOut),
  extraOutcome: z.enum(EXTRA_OUTCOMES).nullable(),
  reason: z.string(),
  /** A failed apply's words (it stays PROPOSED: never a silent half-update). */
  lastError: z.string().nullable(),
  proposedBy: person,
  proposedAt: instant(),
  decidedAt: instant().nullable(),
  decidedBy: person,
  /** Words of a decline ("Left as is"). */
  decisionNote: z.string().nullable(),
  madeWorkOrder: output({ id: id(), number: z.string() }).nullable(),
  version: z.number().int(),
  /** What the person may do now (workorders.manage over the work order, while PROPOSED). */
  mayDecide: z.boolean(),
  words: output({ title: words, status: words, cells: z.string() }),
})

const oneChange = output({ change: changeSchema })

export const listContract = defineContract({
  querystring: input({
    salesOrderId: id().optional(),
    workOrderId: id().optional(),
    status: z.enum([...WORK_ORDER_CHANGE_STATUSES, 'ALL']).default('PROPOSED'),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: { 200: output({ items: z.array(changeSchema), live: output({ events: z.array(z.string()) }) }) },
})

const changeParams = input({ changeId: id() })

export const getContract = defineContract({ params: changeParams, response: { 200: oneChange } })

export const proposeContract = defineContract({
  body: input({
    salesOrderId: id(),
    /** LOWER_TO_ORDER: required; MAKE_MORE: the open DRAFT whose cells grow, or none (a new DRAFT). */
    workOrderId: id().nullish(),
    requestId: id().nullish(),
    amendmentId: id().nullish(),
    kind: z.enum(WORK_ORDER_CHANGE_KINDS),
    cells: z.array(cellIn).min(1).max(MAX_CHANGE_CELLS),
    extra: z.array(extraIn).min(1).max(MAX_CHANGE_CELLS).nullish(),
    extraOutcome: z.enum(EXTRA_OUTCOMES).nullish(),
    reason: z.string().trim().min(1).max(MAX_CHANGE_REASON),
  }),
  response: { 201: oneChange },
})

export const applyContract = defineContract({
  params: changeParams,
  body: input({ version }),
  response: {
    200: output({
      change: changeSchema,
      /** The work order it changed or made. */
      workOrder: output({ id: id(), number: z.string(), status: z.enum(WORK_ORDER_STATUSES), version: z.number().int() }),
      /** A traveller printed before the change is out of date (a released work order lowered). */
      reprint: output({ traveller: z.boolean(), words: words.nullable() }),
    }),
  },
})

export const declineContract = defineContract({
  params: changeParams,
  body: input({ version, words: z.string().trim().min(1).max(MAX_DECISION_NOTE) }),
  response: { 200: oneChange },
})

// ── B-OP-012 (order page plan N2, D1; review R-17): what an office change's work orders did in its own command ──
/**
 * The answer of an office change of the order (amend, priced change, put-back, close lines, cancel, accept): the work-order changes
 * it carried out (the web never applies them again) and those that wait, PROPOSED, with why. A work order's id and number only for a
 * person who reaches it with workorders.view (a mixed one: every customer); else "a work order" in words that name none.
 */
export const followedView = output({
  applied: z.array(output({ changeId: id(), workOrderId: id().nullable(), number: z.string().nullable(), route: z.enum(['SET_DRAFT_CELLS', 'LOWER_RELEASED', 'CANCEL_WORK_ORDER', 'NEW_DRAFT']), reprint: z.boolean() })),
  waiting: z.array(output({ changeId: id(), workOrderId: id().nullable(), number: z.string().nullable(), words })),
})
// ── end B-OP-012 ──

import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { notMoney } from '@nexus/factory-domain/money/marked'
import { ORDER_APPROVAL_STATES } from '@nexus/factory-domain/purchasing/po-approvals/approvals'
import { MAX_COPY_LINES } from '@nexus/factory-domain/purchasing/po-approvals/duplicate'
import { PURCHASE_ORDER_STATUSES } from '@nexus/factory-domain/purchasing/orders'
import { orderView } from '../contract'
import { waitingView } from './waiting'

/**
 * The contracts of PO approvals and duplicate (B-W2b-305; SCM-078, SCM-080, SCM-057). No money in an approval's view (the
 * request's change, with the order's value by its grain, is the engine's GET /approvals/tasks/:id); a copy's lines name
 * where their price came from, not the price (the order's view carries it with the cost grain).
 */

const version = z.number().int().min(1)
const orderParams = input({ purchaseOrderId: id() })
const person = output({ id: id(), name: z.string() })

export const approvalView = output({
  orderId: id(),
  number: z.string(),
  status: z.enum(PURCHASE_ORDER_STATUSES),
  version: z.number().int(),
  state: z.enum(ORDER_APPROVAL_STATES),
  words: z.string(),
  task: output({
    id: id(),
    status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'STALE']),
    requestedAt: instant(),
    requestedBy: person.nullable(),
    approver: waitingView.shape.approver,
    dueAt: instant().nullable(),
    decidedAt: instant().nullable(),
    decidedBy: person.nullable(),
    comment: z.string().nullable(),
    rejectReasonCode: z.string().nullable(),
    rejectReason: z.string().nullable(),
    signatureMeaning: z.string().nullable(),
  }).nullable(),
  approvedAsItIs: z.boolean(),
  wouldAsk: output({ rule: output({ id: id(), name: z.string() }).nullable(), approver: waitingView.shape.approver, namesYou: z.boolean() }).nullable(),
})

export const getApprovalContract = defineContract({ params: orderParams, response: { 200: output({ approval: approvalView }) } })

export const withdrawApprovalContract = defineContract({
  params: orderParams,
  body: input({ version, note: z.string().trim().max(4000).nullish() }),
  response: { 200: output({ order: orderView }) },
})

export const duplicateContract = defineContract({
  params: orderParams,
  body: input({ lineIds: z.array(id()).min(1).max(MAX_COPY_LINES).optional(), needDate: businessDate().nullish() }),
  response: {
    201: output({
      order: orderView,
      copiedFrom: output({ id: id(), number: z.string() }),
      lines: z.array(
        output({
          fromLineId: id(),
          lineId: id(),
          seq: z.number().int(),
          needDate: z.string(),
          /** Where the copied line's unit price came from (no price here: the order's view has it by the cost grain). */
          priceFrom: notMoney(z.enum(['SOURCE', 'COPIED'])),
        }),
      ),
    }),
  },
})

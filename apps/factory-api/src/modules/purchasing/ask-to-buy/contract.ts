import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { PURCHASE_ORDER_STATUSES } from '@nexus/factory-domain/purchasing/orders'
import { ASK_LIMITS, PURCHASE_REQUEST_SOURCES, PURCHASE_REQUEST_STATUSES, SHORTAGE_THEN } from '@nexus/factory-domain/purchasing/ask-to-buy/ask-to-buy'

/**
 * Ask to buy (B-W2b-332; SCM-035, SCM-037; design purchasing.requests pop-up "Ask to buy"). No money anywhere here: the
 * value of a request is the approval rule's fact (the cost grain), and what a request buys at is the buyer's queue
 * (purchasing/requests, money.cost). Quantities are decimal texts in the unit named beside them.
 */

const version = z.number().int().min(1)
const words = z.string().trim().min(1).max(ASK_LIMITS.words)
const quantity = z.string().trim().min(1).max(24)

const requestView = output({
  id: id(),
  companyId: id(),
  siteId: id(),
  site: output({ code: z.string(), name: z.string() }),
  source: z.enum(PURCHASE_REQUEST_SOURCES),
  status: z.enum(PURCHASE_REQUEST_STATUSES),
  version: z.number().int(),
  requestedBy: output({ id: id(), name: z.string() }),
  requestedAt: instant(),
  /** You asked it. */
  mine: z.boolean(),
  item: output({ id: id(), code: z.string(), name: z.string(), kind: z.string() }).nullable(),
  colour: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  description: z.string().nullable(),
  quantity: z.string(),
  uom: z.enum(UOMS),
  needDate: z.string(),
  reason: z.string(),
  workOrder: output({ id: id(), number: z.string() }).nullable(),
  shortage: output({ word: z.enum(['NOT_ENOUGH', 'DELAYED']), short: z.string(), uom: z.string(), needDate: z.string(), runId: z.string().nullable(), workOrderNumber: z.string() }).nullable(),
  approvalTaskId: id().nullable(),
  rejected: output({ at: instant(), by: z.string(), reason: z.string() }).nullable(),
  converted: output({ at: instant(), by: z.string(), purchaseOrder: output({ id: id(), number: z.string(), status: z.enum(PURCHASE_ORDER_STATUSES) }).nullable() }).nullable(),
  cancelled: output({ at: instant(), reason: z.string() }).nullable(),
  /** May the caller take it back now (and why not). */
  cancel: output({ allowed: z.boolean(), why: z.string().nullable() }),
})

const approvalView = output({
  /** true: a switched-on rule asked a yes; the request waits for it. */
  asked: z.boolean(),
  taskId: id().nullable(),
  approverRoleId: id().nullable(),
  approverUserId: id().nullable(),
  dueAt: instant().nullable(),
})

const askBody = {
  siteId: id(),
  itemId: id(),
  itemColourId: id().nullable().optional(),
  /** Words of one's own about it (size, model, brand), at most 2000 characters. */
  description: z.string().max(ASK_LIMITS.description).nullable().optional(),
  quantity,
  uom: z.enum(UOMS),
  needDate: businessDate(),
  reason: z.string().max(ASK_LIMITS.words + 200),
  workOrderId: id().nullable().optional(),
  /** Words for the approver when a rule asks a yes (the request's note), at most 4000 characters. */
  note: z.string().max(4000).nullable().optional(),
}

/** "Send request": asked by hand. */
export const askContract = defineContract({
  body: input(askBody),
  response: { 201: output({ request: requestView, approval: approvalView }) },
})

/** A line of the shortage list asked (anyone who may ask and reads the plan), or drafted at once (a buyer). */
export const fromShortageContract = defineContract({
  body: input({
    siteId: id(),
    workOrderId: id(),
    itemId: id(),
    itemColourId: id().nullable().optional(),
    reason: z.string().max(ASK_LIMITS.words + 200),
    /** REQUEST: to the buyers' queue (default); DRAFT: a purchase order line now (purchasing.manage). */
    then: z.enum(SHORTAGE_THEN).default('REQUEST'),
    /** DRAFT: the supplier (default the queue's own choice) and the draft to add to (null: a new one). */
    supplierId: id().optional(),
    purchaseOrderId: id().nullable().optional(),
    note: z.string().max(4000).nullable().optional(),
  }),
  response: {
    201: output({
      request: requestView,
      approval: approvalView.nullable(),
      draft: output({ purchaseOrderId: id(), number: z.string(), created: z.boolean(), purchaseOrderLineId: id() }).nullable(),
    }),
  },
})

export const listContract = defineContract({
  querystring: input({
    /** LIVE (default): open or waiting for a yes; ALL; or one status. */
    status: z.enum(['LIVE', 'ALL', ...PURCHASE_REQUEST_STATUSES]).default('LIVE'),
    /** Only my own requests (default false: mine, and the site's when I may see purchasing). */
    mine: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
    siteId: id().optional(),
    source: z.enum(PURCHASE_REQUEST_SOURCES).optional(),
    workOrderId: id().optional(),
    cursor: z.string().min(1).max(60).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  }),
  response: { 200: output({ asOf: instant(), requests: z.array(requestView), nextCursor: z.string().nullable() }) },
})

export const getContract = defineContract({
  params: input({ requestId: id() }),
  response: {
    200: output({
      request: requestView,
      /** The request for a yes on it (the latest), when a rule asked one. */
      approval: output({ id: id(), status: z.string(), approver: z.string().nullable(), requestedAt: instant(), dueAt: instant().nullable(), decidedAt: instant().nullable(), decidedBy: z.string().nullable() }).nullable(),
    }),
  },
})

const many = z.array(input({ id: id(), version })).min(1).max(ASK_LIMITS.batch)

export const cancelContract = defineContract({
  body: input({ requests: many, reason: words }),
  response: { 200: output({ requests: z.array(requestView) }) },
})

export const rejectContract = defineContract({
  body: input({ requests: many, reason: words }),
  response: { 200: output({ requests: z.array(requestView) }) },
})

export const optionsContract = defineContract({
  querystring: input({ siteId: id().optional(), q: z.string().trim().min(1).max(60).optional() }),
  response: {
    200: output({
      /** The sites the caller may ask for. */
      sites: z.array(output({ id: id(), companyId: id(), code: z.string(), name: z.string() })),
      siteId: id().nullable(),
      today: z.string(),
      /** Active materials we buy (not finished products), with their active colours and the units each converts. */
      materials: z.array(
        output({
          id: id(),
          code: z.string(),
          name: z.string(),
          kind: z.string(),
          baseUom: z.enum(UOMS),
          purchaseUom: z.enum(UOMS),
          units: z.array(z.enum(UOMS)),
          colours: z.array(output({ id: id(), code: z.string(), name: z.string() })),
        }),
      ),
      /** The site's open work orders (newest first). */
      workOrders: z.array(output({ id: id(), number: z.string(), style: z.string().nullable(), dueDate: z.string().nullable() })),
      /** More materials than shown: search to narrow. */
      more: z.boolean(),
    }),
  },
})

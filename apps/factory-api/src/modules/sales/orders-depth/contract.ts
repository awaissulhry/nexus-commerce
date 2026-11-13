import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { DOCUMENT_LANGUAGES } from '@nexus/factory-domain/documents/model'
import { ORDERS_DEPTH_LIMITS, SALES_ORDER_PRIORITY_LEVELS } from '@nexus/factory-domain/sales/orders-depth/rules'
import { SEASON_STATUSES } from '@nexus/factory-domain/sales/seasons/rules'
import { MAX_TEXT } from '@nexus/factory-domain/sales/quotes/quotes'
import { orderView } from '../orders/contract'

/** The orders-in-depth routes (B-W2b-303; modules/sales/orders-depth). No money but the split's order view (W1's, by grain). */

const words = output({ en: z.string(), it: z.string() })
const orderParams = input({ orderId: id() })
const version = z.number().int().min(1)
const level = z.enum(SALES_ORDER_PRIORITY_LEVELS)
const reason = z.string().max(ORDERS_DEPTH_LIMITS.urgentReason + 10).nullable().optional()

const priorityOut = output({ level, words, urgentReason: z.string().nullable(), number: z.number().int() })

export const setPriorityContract = defineContract({
  params: orderParams,
  body: input({ version, priorityLevel: level, urgentReason: reason, priority: z.number().int().optional() }),
  response: { 200: output({ priority: output({ orderId: id(), number: z.string(), changed: z.boolean(), priorityLevel: level, urgentReason: z.string().nullable(), priority: z.number().int(), version: z.number().int() }) }) },
})

export const setPrioritiesContract = defineContract({
  body: input({ orderIds: z.array(id()).min(1).max(ORDERS_DEPTH_LIMITS.bulkPriority), priorityLevel: level, urgentReason: reason }),
  response: { 200: output({ priorityLevel: level, changed: z.array(id()), unchanged: z.array(id()), skipped: z.array(output({ orderId: id(), number: z.string(), why: z.string() })), unknown: z.number().int() }) },
})

const sizes = z.array(input({ size: z.string().min(1).max(20), quantity: z.number().int() })).max(200)
export const splitContract = defineContract({
  params: orderParams,
  body: input({
    version,
    reason: z.string().max(ORDERS_DEPTH_LIMITS.splitReason + 10).nullable().optional(),
    parts: z
      .array(
        input({
          lines: z.array(input({ lineId: id(), sizes: sizes.optional() })).max(200),
          shipToAddressId: id().nullable().optional(),
          customerRef: z.string().max(MAX_TEXT.customerRef + 10).nullable().optional(),
          requestedDate: businessDate().nullable().optional(),
          promiseDate: businessDate().nullable().optional(),
        }),
      )
      .max(ORDERS_DEPTH_LIMITS.splitParts),
  }),
  response: { 201: output({ order: orderView, amendment: output({ id: id(), revision: z.number().int() }), orders: z.array(output({ id: id(), number: z.string() })) }) },
})

const waitReason = z.enum(['REQUEST_PENDING', 'NO_REQUEST', 'CREDIT_HOLD'])
export const approvalStateContract = defineContract({
  params: orderParams,
  response: {
    200: output({
      orderId: id(),
      number: z.string(),
      status: z.string(),
      waiting: z.boolean(),
      reasons: z.array(output({ reason: waitReason, words })),
      creditHold: output({ checkId: id(), requestTaskId: id().nullable() }).nullable(),
      requests: z.array(
        output({ id: id(), status: z.string(), requestedAt: instant(), requestedBy: z.string().nullable(), approver: z.string().nullable(), dueAt: instant().nullable(), decidedAt: instant().nullable(), decidedBy: z.string().nullable(), reason: z.string().nullable(), mine: z.boolean() }),
      ),
      may: output({ ask: z.boolean(), withdraw: z.boolean() }),
    }),
  },
})
export const askApprovalContract = defineContract({ params: orderParams, body: input({ note: z.string().max(4000).nullable().optional() }), response: { 201: output({ taskId: id() }) } })
export const withdrawApprovalContract = defineContract({ params: orderParams, body: input({ words: z.string().max(2000).nullable().optional() }), response: { 200: output({ withdrawn: z.number().int() }) } })

const confirmationState = output({
  orderId: id(),
  number: z.string(),
  status: z.string(),
  orderVersion: z.number().int(),
  sentAt: instant().nullable(),
  sentVersion: z.number().int().nullable(),
  /** The newest version still shows the order as it is (null: none yet, or the order may not have one). */
  upToDate: z.boolean().nullable(),
  mayMake: z.boolean(),
  versions: z.array(output({ id: id(), version: z.number().int(), number: z.string().nullable(), language: z.string(), fileId: id(), createdAt: instant(), createdBy: z.string().nullable(), sent: z.boolean() })),
})
export const getConfirmationContract = defineContract({ params: orderParams, response: { 200: output({ confirmation: confirmationState }) } })
export const makeConfirmationContract = defineContract({
  params: orderParams,
  body: input({ language: z.enum(DOCUMENT_LANGUAGES).optional() }),
  response: { 201: output({ made: z.boolean(), version: z.number().int(), fileId: id(), confirmation: confirmationState }) },
})
const address = z.string().trim().email().max(254)
export const sendConfirmationContract = defineContract({
  params: orderParams,
  body: input({ to: z.array(address).max(10).optional(), cc: z.array(address).max(10).optional(), subject: z.string().max(200).nullable().optional(), message: z.string().max(10_000).nullable().optional(), language: z.enum(DOCUMENT_LANGUAGES).optional() }),
  response: { 201: output({ version: z.number().int(), made: z.boolean(), outboundId: id(), threadId: id(), confirmation: confirmationState }) },
})

const season = output({ id: id(), code: z.string(), name: z.string(), status: z.enum(SEASON_STATUSES), notice: words.nullable() })
export const orderDepthContract = defineContract({
  params: orderParams,
  response: {
    200: output({
      orderId: id(),
      number: z.string(),
      status: z.string(),
      priority: priorityOut,
      season: season.nullable(),
      waiting: output({ requestTaskId: id().nullable(), creditHold: z.boolean() }).nullable(),
      confirmation: output({ versions: z.number().int(), sentAt: instant().nullable(), sentVersion: z.number().int().nullable() }),
      sameQuote: z.array(output({ id: id(), number: z.string(), status: z.string() })),
    }),
  },
})
export const ordersDepthContract = defineContract({
  querystring: input({ orderIds: z.string().min(1).max(200 * 37) }),
  response: {
    200: output({
      orders: z.array(output({ orderId: id(), number: z.string(), priority: priorityOut, season: output({ id: id(), code: z.string() }).nullable(), waitingForYes: z.boolean(), requestPending: z.boolean(), confirmationSentAt: instant().nullable() })),
    }),
  },
})

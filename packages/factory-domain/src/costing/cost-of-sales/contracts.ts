import { z } from 'zod'
import { businessDate, id, input, instant, output } from '../../core/contracts'
import { money, notMoney } from '../../money/marked'
import { COGS_WAITS } from './rules'

/**
 * The contracts of cost of goods sold (B-W2b-407; FIN-043; design finance.accounting "cost of goods sold and variances").
 * Every amount and cost per garment is `money.cost` (dropped for a caller without the cost grain); garments, shipments,
 * customers and words are shown to every caller with costing.view. No person is named.
 */

const partyRef = output({ id: id(), name: z.string() })

export const cogsEntryView = output({
  id: id(),
  companyId: id(),
  customer: partyRef,
  shipment: output({ id: id(), number: z.string() }),
  line: output({ id: id(), size: z.string(), salesOrderLineId: id(), workOrder: output({ id: id(), number: z.string() }) }),
  /** The SHIPMENT move it names (one move: its valuation is the layer), else null. */
  stockMoveId: id().nullable(),
  postedAt: instant(),
  day: businessDate(),
  /** Garments (a reversal: the opposite). */
  quantity: z.string(),
  materialAmount: money.cost(z.number().int()),
  labourAmount: money.cost(z.number().int()),
  subcontractAmount: money.cost(z.number().int()),
  overheadAmount: money.cost(z.number().int()),
  amount: money.cost(z.number().int()),
  /** amount ÷ garments. */
  unitCost: money.cost(z.string().nullable()),
  currency: z.string(),
  reversalOfId: id().nullable(),
  reversedBy: output({ id: id(), postedAt: instant(), reason: z.string().nullable() }).nullable(),
  reason: z.string().nullable(),
})
export type CogsEntryView = z.infer<typeof cogsEntryView>

export const cogsQuery = input({
  companyId: id().optional(),
  partyId: id().optional(),
  shipmentId: id().optional(),
  from: businessDate().optional(),
  to: businessDate().optional(),
  cursor: id().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})
export type CogsQuery = z.infer<typeof cogsQuery>

const total = output({
  currency: z.string(),
  materialAmount: money.cost(z.number().int()),
  labourAmount: money.cost(z.number().int()),
  subcontractAmount: money.cost(z.number().int()),
  overheadAmount: money.cost(z.number().int()),
  amount: money.cost(z.number().int()),
  entries: z.number().int(),
})

export const cogsAnswer = output({
  entries: z.array(cogsEntryView),
  nextCursor: id().nullable(),
  /** Per currency: every figure inside is money.cost. */
  totals: notMoney(z.array(total)),
  waits: z.string().nullable(),
  empty: z.string(),
})
export type CogsAnswer = z.infer<typeof cogsAnswer>

export const cogsWaitingView = output({ lineId: id(), size: z.string(), code: z.enum(COGS_WAITS), words: z.string() })
export type CogsWaitingView = z.infer<typeof cogsWaitingView>

/** POST /costing/cost-of-sales/post: a shipment's cost of goods sold now (what the worker does when it leaves). */
export const cogsPostBody = input({ shipmentId: id() })
export const cogsPostAnswer = output({ posted: z.array(cogsEntryView), waiting: z.array(cogsWaitingView), replayed: z.boolean() })

export const cogsReverseBody = input({ reason: z.string().trim().min(3).max(1000) })
export const cogsReverseAnswer = output({ entry: cogsEntryView, reversal: cogsEntryView, replayed: z.boolean() })

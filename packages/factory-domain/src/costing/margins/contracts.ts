import { z } from 'zod'
import { businessDate, id, input, output } from '../../core/contracts'
import { money } from '../../money/marked'
import { WORK_ORDER_KINDS, WORK_ORDER_STATUSES } from '../../production/work-orders/machine'
import { SALES_ORDER_STATUSES } from '../../sales/orders/orders'
import { COSTING_METHODS } from '../ledger/entries'
import { WATERFALL_REASONS } from './rules'

/**
 * The contracts of order margin from estimate to actual (B-W2a-29; FIN-047; design finance.margins SCR-155 and its
 * DetailModal, sales.orders Margin tab). Each figure carries its own grain and the server drops what a caller does not
 * hold: the value is `money.price`, costs `money.cost`, margin % `money.margin`. A margin AMOUNT (and every step of where
 * it went) is `money.margin` and is sent only to a caller who also holds the cost grain: with the price it would give the
 * cost away (Owner answer S2: sales see margin %, never cost amounts). No person is named.
 */

const statusList = z
  .string()
  .transform((value) => value.split(',').map((part) => part.trim()).filter((part) => part.length > 0))
  .pipe(z.array(z.enum(SALES_ORDER_STATUSES)))

/** B-W2b-22 (Z9:05): comma-separated order ids, at most 100 (the orders a list shows). */
const idList = z
  .string()
  .transform((value) => [...new Set(value.split(',').map((part) => part.trim()).filter((part) => part.length > 0))])
  .pipe(z.array(id()).min(1).max(100))

export const marginsQuery = input({
  /** B-W2b-22: only these orders (the list's Margin % column asks for the rows on screen); the tiles and groups are then over them. */
  ids: idList.optional(),
  companyId: id().optional(),
  partyId: id().optional(),
  /** Orders with a line of this style. */
  styleId: id().optional(),
  /** Comma-separated order statuses (default: every one but CANCELLED). */
  status: statusList.optional(),
  /** The order date, Europe/Rome days, both included. */
  from: businessDate().optional(),
  to: businessDate().optional(),
  /** The order's number or the customer's reference. */
  q: z.string().trim().min(1).max(100).optional(),
  cursor: id().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
export type MarginsQuery = z.infer<typeof marginsQuery>

/** One figure's margin: the value, the cost and what is left. */
const figure = {
  margin: money.margin(z.number().int().nullable()),
  marginPct: money.margin(z.string().nullable()),
}

export const orderMarginRowView = output({
  order: output({ id: id(), number: z.string(), status: z.enum(SALES_ORDER_STATUSES), orderDate: businessDate(), companyId: id(), party: output({ id: id(), name: z.string() }), customerRef: z.string().nullable() }),
  currency: z.string(),
  /** The net as sold. */
  quotedValue: money.price(z.number().int()),
  /** The net of what is still to deliver (pieces closed short taken off). */
  value: money.price(z.number().int()),
  /** At quote: the lines' cost from the cost sheet (null: a line has none). */
  quotedCost: money.cost(z.number().int().nullable()),
  quotedMargin: money.margin(z.number().int().nullable()),
  quotedMarginPct: money.margin(z.string().nullable()),
  /** As estimated now (null: a part of it cannot be told). */
  estimateCost: money.cost(z.number().int().nullable()),
  estimateMargin: money.margin(z.number().int().nullable()),
  estimateMarginPct: money.margin(z.string().nullable()),
  /** The cost ledger's so far (the final cost once `final`). */
  actualCost: money.cost(z.number().int()),
  actualMargin: money.margin(z.number().int().nullable()),
  actualMarginPct: money.margin(z.string().nullable()),
  /** estimate − quoted margin (below 0: margin lost since the quote). */
  marginChange: money.margin(z.number().int().nullable()),
  /** Every work order of it is done and every piece is made: the actual is the final cost. */
  final: z.boolean(),
  /** A cost entry is posted on one of its work orders. */
  started: z.boolean(),
  workOrders: z.number().int(),
  /** Below the company's margin floor (W2b: null). */
  belowFloor: z.boolean().nullable(),
  method: z.enum(COSTING_METHODS),
  provisional: z.boolean(),
})
export type OrderMarginRowView = z.infer<typeof orderMarginRowView>

export const marginTilesView = output({
  /** Σ margin ÷ Σ value as estimated now, over the orders with a known cost. */
  averageMarginPct: money.margin(z.string().nullable()),
  /** W2b: the floor flag. */
  belowFloor: z.number().int().nullable(),
  /** Σ (quoted − estimated margin) over the orders with both (gains offset losses; above 0: lost). */
  marginLostSinceQuote: money.margin(z.number().int().nullable()),
  orders: z.number().int(),
  /** Orders whose cost cannot be told yet (a line without a quoted cost, another currency). */
  unknown: z.number().int(),
  currency: z.string().nullable(),
  words: z.string().nullable(),
})

const groupFigures = {
  orders: z.number().int(),
  value: money.price(z.number().int()),
  estimateCost: money.cost(z.number().int().nullable()),
  marginPct: money.margin(z.string().nullable()),
}

export const marginsAnswer = output({
  rows: z.array(orderMarginRowView),
  nextCursor: id().nullable(),
  tiles: marginTilesView,
  /** Profitability per customer and per style (the BarList), over every order in scope, as estimated now. */
  byCustomer: z.array(output({ party: output({ id: id(), name: z.string() }), ...groupFigures })),
  byStyle: z.array(output({ style: output({ id: id(), code: z.string(), name: z.string() }), ...groupFigures })),
})

const partsView = output({
  material: money.cost(z.number().int()),
  labour: money.cost(z.number().int()),
  subcontract: money.cost(z.number().int()),
  overhead: money.cost(z.number().int()),
  adjustment: money.cost(z.number().int()),
})

/** price − material − labour − subcontract − overhead − adjustment = margin, at one stage. */
const stageView = output({
  value: money.price(z.number().int()),
  cost: money.cost(z.number().int().nullable()),
  parts: partsView.nullable(),
  ...figure,
})

export const orderMarginView = orderMarginRowView.extend({
  quoted: stageView,
  estimate: stageView,
  actual: stageView,
  /** Quoted → now: the value's change and each part's, adding up to the margin change (null without both costs). */
  waterfall: z.array(output({ reason: z.enum(WATERFALL_REASONS), amount: money.margin(z.number().int()) })).nullable(),
  /** The leather in the cost: at quote (the cost sheet's) and issued so far (the ledger's). */
  leather: output({ quoted: money.cost(z.number().int().nullable()), actual: money.cost(z.number().int()) }),
  /** No freight cost is recorded on an order yet: the margin leaves it out. */
  freight: output({ cost: money.cost(z.number().int().nullable()), words: z.string() }),
  lines: z.array(
    output({
      id: id(),
      seq: z.number().int(),
      style: output({ id: id(), code: z.string(), name: z.string() }),
      colourway: output({ id: id(), code: z.string() }),
      quantity: z.number().int(),
      closedShort: z.number().int(),
      /** Garments of it the work orders make. */
      inWorkOrders: z.number().int(),
      quotedValue: money.price(z.number().int()),
      value: money.price(z.number().int()),
      quotedCost: money.cost(z.number().int().nullable()),
      estimateCost: money.cost(z.number().int().nullable()),
      actualCost: money.cost(z.number().int()),
      quotedMarginPct: money.margin(z.string().nullable()),
      estimateMarginPct: money.margin(z.string().nullable()),
      actualMarginPct: money.margin(z.string().nullable()),
    }),
  ),
  /** The work orders behind the cost, each a link (Finance › Standard vs actual). */
  workOrderShares: z.array(
    output({
      workOrder: output({ id: id(), number: z.string(), kind: z.enum(WORK_ORDER_KINDS), status: z.enum(WORK_ORDER_STATUSES) }),
      /** Its garments for this order, of all its garments. */
      pieces: z.number().int(),
      ofPieces: z.number().int(),
      done: z.boolean(),
      /** What its estimate rests on: its frozen standards, its estimate at release, its garments' quoted cost, or its actual. */
      plan: z.enum(['STANDARD', 'ESTIMATE', 'QUOTED', 'ACTUAL']),
      estimateCost: money.cost(z.number().int().nullable()),
      actualCost: money.cost(z.number().int()),
      method: z.enum(COSTING_METHODS),
      provisional: z.boolean(),
    }),
  ),
  words: z.string(),
})
export type OrderMarginView = z.infer<typeof orderMarginView>

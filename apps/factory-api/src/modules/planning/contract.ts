import { z } from 'zod'
import { amountMinor, businessDate, currency, defineContract, id, input, instant, output, unitPrice } from '@nexus/factory-domain/core/contracts'
import { NOT_COUNTED_REASONS } from '@nexus/factory-domain/planning/usable'
import { BRIDGE_STEPS } from '@nexus/factory-domain/planning/explain'
import { REQUIREMENT_ACTIONS, WARNING_CODES } from '@nexus/factory-domain/planning/explode'
import { DECISIONS, MAX_DECIDED_LINES, MAX_NOTE, RUN_STATUSES, SET_ASIDE_REASONS } from '@nexus/factory-domain/planning/decisions'
import { LOT_QUALITY_STATUSES } from '@nexus/factory-domain/inventory/stock/overview'
import { CR_VI_STATUSES } from '@nexus/factory-domain/planning/usable'
import { money } from '@nexus/factory-domain/money/marked'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { PURCHASE_ORDER_STATUSES } from '@nexus/factory-domain/purchasing/orders'
import { PEGGING_DEMAND_KINDS, PEGGING_SUPPLY_KINDS } from '@nexus/factory-domain/planning/pegging/pegging'

/**
 * "What to buy & make" (B-W1-29; PLN-062 to PLN-066; A2 SCR-055; design 02): the planning runs of a site, their lines
 * with the netting as numbers, a sentence and a ladder, the orders behind each line, the stock the plan may not use with
 * its reason, and the decisions on a line. Quantities are decimal strings with four decimals in the item's base unit
 * unless a field says otherwise; dates are calendar days. Money only in fields marked with the cost grain.
 */

const flag = () => z.enum(['true', 'false']).transform((value) => value === 'true')
const quantity = () => z.string()
const named = output({ id: id(), code: z.string(), name: z.string() })
const uom = z.enum(UOMS)

export const TRIGGERS = ['MANUAL', 'ORDER', 'SCHEDULED'] as const
export type Trigger = (typeof TRIGGERS)[number]

const warning = output({
  code: z.enum(WARNING_CODES),
  message: z.string(),
  orderId: id().optional(),
  orderLineId: id().optional(),
  itemId: id().optional(),
  size: z.string().optional(),
})

export const runView = output({
  id: id(),
  companyId: id(),
  siteId: id(),
  trigger: z.enum(TRIGGERS),
  status: z.enum(RUN_STATUSES),
  /** Order lines exploded. */
  orderLines: z.number().int(),
  startedAt: instant(),
  finishedAt: instant().nullable(),
  error: z.string().nullable(),
  note: z.string().nullable(),
  warnings: z.array(warning),
  createdById: id().nullable(),
  /** Lines, and of them those short (net above 0). */
  requirements: z.number().int(),
  short: z.number().int(),
  version: z.number().int(),
})
export type RunView = z.infer<typeof runView>

const source = output({
  orderId: id(),
  orderNumber: z.string(),
  orderLineId: id(),
  lineSeq: z.number().int(),
  size: z.string(),
  pieces: z.number().int(),
  made: z.number().int(),
  quantity: quantity(),
  issued: quantity(),
  dueDate: businessDate().nullable(),
  workOrders: z.array(z.string()),
})

const orderBy = output({
  date: businessDate(),
  /** null: no lead time on record (the date is the need date). */
  leadTimeDays: z.number().int().nullable(),
  passed: z.boolean(),
  /** B-W2a-22: the supplier's closed days the walk back skipped (its calendar, B-W2a-08). */
  closedDaysSkipped: z.number().int(),
})

/** B-W2a-22 (PLN-075): a line's firm planned order. */
const firmView = output({
  /** In the line's suggested unit, and in the base unit. */
  quantity: quantity(),
  uom,
  baseQuantity: quantity(),
  date: businessDate(),
  supplier: named.nullable(),
  firmedAt: instant(),
  firmedById: id().nullable(),
  /** Made firm on an earlier plan and carried by this one. */
  carried: z.boolean(),
})

export const lineView = output({
  id: id(),
  runId: id(),
  seq: z.number().int(),
  version: z.number().int(),
  action: z.enum(REQUIREMENT_ACTIONS),
  item: output({ id: id(), code: z.string(), name: z.string(), kind: z.string(), baseUom: uom, purchaseUom: uom, requiresCrViTest: z.boolean() }),
  colour: named.nullable(),
  uom,
  grossQuantity: quantity(),
  usableStock: quantity(),
  heldStock: quantity(),
  onOrder: quantity(),
  netQuantity: quantity(),
  /** In `suggestedUom` (a BUY: the purchase unit; a MAKE: the base unit). */
  suggestedQuantity: quantity(),
  suggestedUom: uom,
  /** What the suggestion brings in the base unit. */
  suggestedBaseQuantity: quantity(),
  /** Leather: about how many hides; null without a hide factor. */
  estimatedHides: z.number().int().nullable(),
  needDate: businessDate(),
  /** A BUY: the order-by day from today's terms of the supplier; null for a MAKE line. */
  orderBy: orderBy.nullable(),
  supplier: named.nullable(),
  /** The netting in one line (no money). */
  why: z.string(),
  /** The orders behind it (the For-orders chips). */
  orders: z.array(output({ id: id(), number: z.string() })),
  sources: z.array(source),
  decision: z.enum(DECISIONS),
  /** A set-aside line: its reason and note. */
  decisionReason: z.enum(SET_ASIDE_REASONS).nullable(),
  decisionNote: z.string().nullable(),
  purchaseOrderLineId: id().nullable(),
  /** The purchase order an ordered line went into (its number and state: "In draft PO-…", "Ordered PO-… (sent)"). */
  purchaseOrder: output({ id: id(), number: z.string(), status: z.enum(PURCHASE_ORDER_STATUSES) }).nullable(),
  decidedAt: instant().nullable(),
  /** B-W2a-22: the firm planned order; null: the line is planned (the run may change it). */
  firm: firmView.nullable(),
  /** The item's standard cost per suggested unit, and the suggestion's expected value in minor units (cost grain). */
  unitCost: money.cost(unitPrice().nullable()),
  expectedAmount: money.cost(amountMinor().nullable()),
  currency: currency(),
})
export type LineView = z.infer<typeof lineView>

const linesQuery = {
  itemId: id().optional(),
  supplierId: id().optional(),
  action: z.enum(REQUIREMENT_ACTIONS).optional(),
  decision: z.enum(DECISIONS).optional(),
  /** Only lines that are short (net above 0). */
  shortOnly: flag().optional(),
}

const planView = output({
  /** The latest DONE run (or the run asked for); null: no plan yet. */
  run: runView.nullable(),
  /** A newer run that is not DONE (it failed, or is running): the plan shown stays the older one. */
  latestAttempt: runView.nullable(),
  /** The tiles: counts of the whole run, never of the filtered lines. */
  summary: output({
    toBuy: z.number().int(),
    orderByPassed: z.number().int(),
    toMake: z.number().int(),
    inDraftPurchaseOrder: z.number().int(),
    ordered: z.number().int(),
    setAside: z.number().int(),
    /** Lines short although stock exists that the plan may not use. */
    shortWithHeldStock: z.number().int(),
    /** B-W2a-22: firm planned orders (made firm here, or carried). */
    firm: z.number().int(),
  }),
  /**
   * B-W2a-22 (the W1 leftover "out of date since the run"): what changed at the site since the plan shown finished:
   * orders confirmed, receipts posted, lots released or held. null: no plan shown, or nothing changed.
   */
  outOfDate: output({
    since: instant(),
    ordersConfirmed: z.array(output({ id: id(), number: z.string() })),
    receiptsPosted: z.array(output({ id: id(), number: z.string() })),
    lotsReleased: z.array(output({ id: id(), code: z.string() })),
    lotsHeld: z.array(output({ id: id(), code: z.string() })),
  }).nullable(),
  lines: z.array(lineView),
})

export const runPlanContract = defineContract({
  body: input({ siteId: id(), note: z.string().trim().max(MAX_NOTE).optional() }),
  response: { 201: output({ run: runView, replayed: z.boolean() }) },
})

export const listRunsContract = defineContract({
  querystring: input({ siteId: id().optional(), limit: z.coerce.number().int().min(1).max(100).optional() }),
  response: { 200: output({ runs: z.array(runView) }) },
})

export const latestPlanContract = defineContract({
  querystring: input({ siteId: id(), ...linesQuery }),
  response: { 200: planView },
})

export const runPlanViewContract = defineContract({
  params: input({ runId: id() }),
  querystring: input(linesQuery),
  response: { 200: planView },
})

const stockLine = output({
  item: output({ id: id(), code: z.string(), name: z.string(), baseUom: uom }),
  colour: named.nullable(),
  lot: output({
    id: id(),
    code: z.string(),
    qualityStatus: z.enum(LOT_QUALITY_STATUSES),
    crViStatus: z.enum(CR_VI_STATUSES),
    qualityNote: z.string().nullable(),
    receivedAt: instant().nullable(),
    qualityDecidedAt: instant().nullable(),
  }).nullable(),
  quantity: quantity(),
  hides: z.number().int(),
  /** null: counted as usable. */
  reason: z.enum(NOT_COUNTED_REASONS).nullable(),
  /** The reason in words. */
  words: z.string().nullable(),
  /** Held stock (quarantine, blocked): may still become usable. */
  held: z.boolean(),
})

/** B-W2a-22 (PLN-071): one demand of a requirement with its supplies (the run's pegging rows). */
export const pegSupply = output({
  seq: z.number().int(),
  kind: z.enum(PEGGING_SUPPLY_KINDS),
  quantity: quantity(),
  /** PURCHASE_ORDER: the line's (confirmed, else asked) date; PLANNED: the planned order's (the firm date, or the need date). */
  date: businessDate().nullable(),
  reservation: output({ id: id(), kind: z.string(), lot: output({ id: id(), code: z.string() }).nullable(), hide: output({ id: id(), code: z.string() }).nullable() }).nullable(),
  purchaseOrder: output({ id: id(), number: z.string(), status: z.string(), lineId: id(), seq: z.number().int() }).nullable(),
  /** PLANNED: the planned order is firm. */
  firm: z.boolean(),
})
export const pegDemand = output({
  requirementId: id(),
  kind: z.enum(PEGGING_DEMAND_KINDS),
  order: output({ id: id(), number: z.string() }).nullable(),
  orderLine: output({ id: id(), seq: z.number().int() }).nullable(),
  /** The size of a size grid; null for a made-to-measure unit. */
  size: z.string().nullable(),
  workOrder: output({ id: id(), number: z.string(), status: z.string() }).nullable(),
  demandDate: businessDate(),
  quantity: quantity(),
  /** Of it, planned (not covered by a reservation, stock or a purchase line). */
  planned: quantity(),
  supplies: z.array(pegSupply),
})

export const explainContract = defineContract({
  params: input({ requirementId: id() }),
  response: {
    200: output({
      run: runView,
      line: lineView,
      sentence: z.string(),
      /** B-W2a-22 (PLN-071): which supply covers which order line, size and work order, as the run pegged it. */
      pegging: z.array(pegDemand),
      bridge: z.array(output({ step: z.enum(BRIDGE_STEPS), label: z.string(), quantity: quantity(), uom })),
      rounding: z.array(output({ rule: z.enum(['WHOLE_UNITS', 'MINIMUM', 'MULTIPLE']), quantity: quantity() })),
      /** Today's stock and open purchase lines, netted against the line's demand (the run's numbers stay its snapshot). */
      now: output({
        /** B-W2a-22: usable stock reserved for other demand (not counted for this line). */
        reservedForOthers: quantity(),
        usableStock: quantity(),
        heldStock: quantity(),
        onOrder: quantity(),
        netQuantity: quantity(),
        /** Today's figures differ from the run's: run the plan again. */
        changedSinceRun: z.boolean(),
        stock: z.array(stockLine),
        purchases: z.array(
          output({
            purchaseOrderId: id(),
            purchaseOrderNumber: z.string(),
            purchaseOrderStatus: z.string(),
            purchaseOrderLineId: id(),
            seq: z.number().int(),
            openQuantity: quantity(),
            dueDate: businessDate(),
            confirmed: z.boolean(),
            counted: quantity(),
            notCounted: quantity(),
            why: z.enum(['TOO_LATE', 'NOT_NEEDED']).nullable(),
          }),
        ),
      }),
    }),
  },
})

const decided = output({ runId: id(), decision: z.enum(DECISIONS), lines: z.array(output({ id: id(), version: z.number().int() })), replayed: z.boolean() })
const lineRefs = z.array(input({ id: id(), version: z.number().int().min(1) })).min(1).max(MAX_DECIDED_LINES)

export const setAsideContract = defineContract({
  body: input({ lines: lineRefs, reason: z.enum(SET_ASIDE_REASONS), note: z.string().max(MAX_NOTE).optional() }),
  response: { 200: decided },
})

export const reopenContract = defineContract({
  body: input({ lines: lineRefs }),
  response: { 200: decided },
})

export const unusableStockContract = defineContract({
  querystring: input({ siteId: id(), itemId: id().optional() }),
  response: { 200: output({ siteId: id(), lines: z.array(stockLine) }) },
})

// ---- B-W2a-22: firm planned orders (PLN-075) ----------------------------------------------------------------------------

export const firmContract = defineContract({
  params: input({ requirementId: id() }),
  body: input({
    version: z.number().int().min(1),
    /** In the line's suggested unit, four decimals at most. */
    quantity: z.string().trim().max(24),
    date: z.string().trim().max(10),
    /** A buy only; left out: the line's supplier. */
    supplierId: id().optional(),
  }),
  response: { 200: output({ line: lineView, replayed: z.boolean() }) },
})

export const unfirmContract = defineContract({
  params: input({ requirementId: id() }),
  body: input({ version: z.number().int().min(1) }),
  response: { 200: output({ line: lineView, replayed: z.boolean() }) },
})

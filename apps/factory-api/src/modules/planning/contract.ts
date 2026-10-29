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
  decidedAt: instant().nullable(),
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
  }),
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

export const explainContract = defineContract({
  params: input({ requirementId: id() }),
  response: {
    200: output({
      run: runView,
      line: lineView,
      sentence: z.string(),
      bridge: z.array(output({ step: z.enum(BRIDGE_STEPS), label: z.string(), quantity: quantity(), uom })),
      rounding: z.array(output({ rule: z.enum(['WHOLE_UNITS', 'MINIMUM', 'MULTIPLE']), quantity: quantity() })),
      /** Today's stock and open purchase lines, netted against the line's demand (the run's numbers stay its snapshot). */
      now: output({
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

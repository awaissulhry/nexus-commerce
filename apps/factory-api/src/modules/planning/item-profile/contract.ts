import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { ALLOCATIONS } from '@nexus/factory-domain/planning/allocation-priority/rank'
import { DELAY_SOURCES } from '@nexus/factory-domain/planning/item-profile/delays'
import { LOT_SIZINGS } from '@nexus/factory-domain/planning/lot-sizing/parameters'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { notMoney } from '@nexus/factory-domain/money/marked'

/**
 * The item's requirement profile and the calculated delays (B-W2b-318; PLN-084, PLN-082; design planning.mrp pop-up
 * "Projected stock — <material>" (the Material cell ⋯ › Projected stock), the To make section's "calculated earliest date
 * and the reason"): read with planning.view over the site, from the site's plan computed now (the same netting as a run).
 * Quantities are decimal strings in the material's base unit (four decimals); days are site days. No money, no person:
 * orders are named by their numbers, never their customers.
 */

const ref = output({ id: id(), code: z.string(), name: z.string() })
const siteView = output({ id: id(), companyId: id(), code: z.string(), name: z.string(), timeZone: z.string() })
const order = output({ id: id(), number: z.string(), rank: z.number().int().nullable() })
const orderLine = output({ id: id(), seq: z.number().int() })
const workOrder = output({ id: id(), number: z.string() }).nullable()

const demandRef = output({ order, orderLine, size: z.string().nullable(), workOrder, day: businessDate(), quantity: z.string() })
const receiptRef = output({
  kind: z.enum(['PURCHASE_ORDER', 'FIRM']),
  day: businessDate(),
  quantity: z.string(),
  /** PURCHASE_ORDER: the order and its line. */
  purchaseOrder: output({ id: id(), number: z.string(), lineId: id(), lineSeq: z.number().int() }).nullable(),
  /** FIRM: the latest plan's line it is carried on (null: the plan computed now carries it, the run has none yet). */
  requirementId: id().nullable(),
})
const plannedRef = output({ seq: z.number().int(), day: businessDate(), quantity: z.string() })

export const profileRow = output({
  /** An ISO week (2026-W47), PAST (before this week) or LATER (after the horizon). */
  key: z.string(),
  from: businessDate().nullable(),
  to: businessDate().nullable(),
  demand: z.string(),
  receipts: z.string(),
  planned: z.string(),
  /** On hand + receipts − demand, cumulative; with the plan: + the planned orders too. */
  projected: z.string(),
  projectedWithPlan: z.string(),
  atp: z.string(),
  short: z.boolean(),
  belowSafety: z.boolean(),
  demandRefs: z.array(demandRef),
  receiptRefs: z.array(receiptRef),
  plannedRefs: z.array(plannedRef),
})

const delayView = output({
  order,
  orderLine,
  size: z.string().nullable(),
  workOrder,
  /** The day it is needed, the earliest day its material is usable, and the days between. */
  needDate: businessDate(),
  earliest: businessDate(),
  daysLate: z.number().int(),
  source: z.enum(DELAY_SOURCES),
  arrival: businessDate(),
  words: z.string(),
})

const material = output({
  item: output({ id: id(), code: z.string(), name: z.string(), kind: z.string(), baseUom: z.enum(UOMS) }),
  colour: ref.nullable(),
})

export const itemProfileContract = defineContract({
  querystring: input({
    siteId: id(),
    itemId: id(),
    /** The colour; `none` (or left out): the material without colours, or its every-colour line. */
    itemColourId: z.union([id(), z.literal('none')]).optional(),
    weeks: z.coerce.number().int().min(1).max(52).optional(),
  }),
  response: {
    200: output({
      site: siteView,
      asOf: instant(),
      today: businessDate(),
      ...material.shape,
      uom: z.enum(UOMS),
      /** The site's row of the material (null: planned by its defaults) and what its rules do. */
      parameters: output({
        itemPlanningId: id(),
        method: z.string(),
        lotSizing: z.enum(LOT_SIZINGS),
        safetyStock: z.string().nullable(),
        delayDays: z.number().int().nullable(),
        words: output({ lotSizing: z.string().nullable(), scrapYield: z.string().nullable(), delay: z.string().nullable() }),
      }).nullable(),
      /** The latest DONE run's line(s) of the material (the MRP grid's rows; empty: none). */
      requirements: z.array(output({ runId: id(), id: id(), seq: z.number().int() })),
      horizon: output({ from: businessDate(), to: businessDate(), weeks: z.number().int() }),
      onHand: z.string(),
      safetyStock: z.string().nullable(),
      /** Quantities of the material (base unit), never money. */
      totals: notMoney(output({ demand: z.string(), receipts: z.string(), planned: z.string() })),
      rows: z.array(profileRow),
      firstShort: z.string().nullable(),
      firstBelowSafety: z.string().nullable(),
      /** The plan's numbers now: net (before a firm planned order) and still to order (after it). */
      net: z.string(),
      uncovered: z.string(),
      /** How scarce supply was shared: DATE (by the day needed) or PRIORITY (the backlog's rank, PLN-088). */
      allocation: z.enum(ALLOCATIONS),
      /** The plan's orders still to place (lot sizing, PLN-006). */
      lots: output({ words: z.string(), list: z.array(output({ seq: z.number().int(), date: businessDate(), quantity: z.string(), covers: output({ from: businessDate(), to: businessDate() }) })) }),
      /** A new order placed today: its earliest arrival and the day it can be used (PLN-082). */
      earliest: output({ leadTimeDays: z.number().int().nullable(), delayDays: z.number().int().nullable(), arrival: businessDate(), usable: businessDate(), words: z.string() }),
      delays: z.array(delayView),
    }),
  },
})
export type ItemProfileQuery = z.infer<typeof itemProfileContract.querystring>

export const delaysContract = defineContract({
  querystring: input({ siteId: id() }),
  response: {
    200: output({
      site: siteView,
      asOf: instant(),
      today: businessDate(),
      tiles: output({ delayedDemands: z.number().int(), delayedOrders: z.number().int(), materials: z.number().int(), mostDaysLate: z.number().int().nullable() }),
      /** One per order line, size and work order whose material cannot be there in time: the material that sets the day first. */
      demands: z.array(output({ ...delayView.shape, setBy: material, materials: z.array(output({ ...material.shape, earliest: businessDate(), daysLate: z.number().int(), source: z.enum(DELAY_SOURCES) })) })),
      /** Per material: a new order's earliest arrival and use, and how many demands it delays. */
      materials: z.array(output({ ...material.shape, action: z.enum(['BUY', 'MAKE']), leadTimeDays: z.number().int().nullable(), delayDays: z.number().int().nullable(), arrival: businessDate(), usable: businessDate(), delayed: z.number().int() })),
    }),
  },
})

import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { LEAD_KINDS } from '@nexus/factory-domain/insights/kpis/lead-times'
import { OTIF_OUTCOMES, OTIF_PROMISES } from '@nexus/factory-domain/insights/kpis/otif'
import { WIP_AGE_BUCKETS } from '@nexus/factory-domain/insights/kpis/wip'
import { money } from '@nexus/factory-domain/money/marked'
import { ITEM_KINDS } from '@nexus/factory-domain/product/materials/rules'
import { PRODUCT_TYPES } from '@nexus/factory-domain/product/styles/rules'
import { SALES_ORDER_PRIORITY_LEVELS } from '@nexus/factory-domain/sales/orders-depth/rules'

/**
 * The drills of the ready KPIs (B-W2b-429; follow-up KP2:01): each KPI's records with the filters it needs — period, style,
 * season, priority and customer for the orders; line and week for the work orders; supplier and category for the purchase
 * lines; article and age for the leather on hand — and the groups the plan names (customer, site and month; product family;
 * line and stage; grade, supplier lot and style; customer and style; supplier). Codes for words (the web's catalogue says
 * them); money marked by grain (the grain filter drops it); a record a row opens is `record` (type, id, label).
 */

const ref = output({ id: id(), code: z.string(), name: z.string() })
const record = output({ type: z.string(), id: id(), label: z.string() })
const period = output({ from: businessDate(), to: businessDate() })
const rate = { due: z.number().int(), onTime: z.number().int(), pct: z.string().nullable() }
const ISO_WEEK = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/

const span = { from: businessDate().optional(), to: businessDate().optional() }

// ---- on-time in full -------------------------------------------------------------------------------------------------------

export const otifDrillContract = defineContract({
  querystring: input({
    ...span,
    promise: z.enum(OTIF_PROMISES).optional(),
    outcome: z.enum(OTIF_OUTCOMES).optional(),
    companyId: id().optional(),
    siteId: id().optional(),
    partyId: id().optional(),
    styleId: id().optional(),
    seasonId: id().optional(),
    priority: z.enum(SALES_ORDER_PRIORITY_LEVELS).optional(),
  }),
  response: {
    200: output({
      kpiKey: z.string(),
      promise: z.enum(OTIF_PROMISES),
      period,
      asOf: instant(),
      overall: output({ ...rate, late: z.number().int() }),
      byCustomer: z.array(output({ customer: ref.nullable(), ...rate })),
      bySite: z.array(output({ site: ref.nullable(), ...rate })),
      byMonth: z.array(output({ month: z.string(), ...rate })),
      rows: z.array(
        output({
          record,
          lineId: id(),
          seq: z.number().int(),
          order: output({ id: id(), number: z.string() }),
          customer: ref.nullable(),
          style: ref.nullable(),
          family: z.enum(PRODUCT_TYPES).nullable(),
          site: ref.nullable(),
          season: ref.nullable(),
          priority: z.enum(SALES_ORDER_PRIORITY_LEVELS),
          due: z.number().int(),
          firstPromise: businessDate().nullable(),
          currentPromise: businessDate().nullable(),
          promise: businessDate(),
          shippedByPromise: z.number().int(),
          completeOn: businessDate().nullable(),
          outcome: z.enum(OTIF_OUTCOMES),
          lateDays: z.number().int(),
        }),
      ),
      more: z.number().int(),
    }),
  },
})

// ---- lead times ----------------------------------------------------------------------------------------------------------

const summary = {
  orders: z.number().int(),
  medianDays: z.string().nullable(),
  p25Days: z.string().nullable(),
  p75Days: z.string().nullable(),
  spreadDays: z.string().nullable(),
  averageDays: z.string().nullable(),
  minDays: z.number().int().nullable(),
  maxDays: z.number().int().nullable(),
}

export const leadDrillContract = defineContract({
  querystring: input({
    ...span,
    kind: z.enum(LEAD_KINDS).optional(),
    companyId: id().optional(),
    partyId: id().optional(),
    styleId: id().optional(),
    seasonId: id().optional(),
    priority: z.enum(SALES_ORDER_PRIORITY_LEVELS).optional(),
    family: z.enum(PRODUCT_TYPES).optional(),
  }),
  response: {
    200: output({
      kpiKey: z.string(),
      kind: z.enum(LEAD_KINDS),
      period,
      asOf: instant(),
      overall: output(summary),
      families: z.array(output({ family: z.enum(PRODUCT_TYPES).nullable(), ...summary })),
      rows: z.array(
        output({
          record,
          order: output({ id: id(), number: z.string(), orderDate: businessDate() }),
          customer: ref.nullable(),
          family: z.enum(PRODUCT_TYPES).nullable(),
          season: ref.nullable(),
          priority: z.enum(SALES_ORDER_PRIORITY_LEVELS),
          fromDay: businessDate(),
          toDay: businessDate(),
          days: z.number().int(),
        }),
      ),
      more: z.number().int(),
    }),
  },
})

// ---- work in progress ----------------------------------------------------------------------------------------------------

const ageing = output(Object.fromEntries(WIP_AGE_BUCKETS.map((bucket) => [bucket, z.number().int()])) as Record<(typeof WIP_AGE_BUCKETS)[number], z.ZodNumber>)

export const wipDrillContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    /** A line of the site, or `none`: the work orders on no line. */
    lineId: z.union([id(), z.literal('none')]).optional(),
    /** The ISO week the work order was released in (`2026-W46`). */
    week: z.string().regex(ISO_WEEK).optional(),
    minWaitDays: z.coerce.number().int().min(0).max(3650).optional(),
  }),
  response: {
    200: output({
      kpiKey: z.string(),
      asOf: instant(),
      overall: output({ workOrders: z.number().int(), pieces: z.number().int(), waiting: z.number().int(), value: money.cost(z.number().int().nullable()), currency: z.string().nullable() }),
      stages: z.array(output({ line: ref.nullable(), operation: output({ code: z.string(), name: z.string() }), workOrders: z.number().int(), waiting: z.number().int(), ageing })),
      rows: z.array(
        output({
          record,
          workOrder: output({ id: id(), number: z.string(), status: z.string() }),
          site: ref.nullable(),
          line: ref.nullable(),
          style: ref.nullable(),
          releasedOn: businessDate(),
          week: z.string(),
          pieces: z.number().int(),
          ageDays: z.number().int(),
          waitedDays: z.number().int(),
          band: z.enum(WIP_AGE_BUCKETS),
          value: money.cost(z.number().int().nullable()),
          currency: z.string().nullable(),
          stages: z.array(output({ code: z.string(), name: z.string(), waiting: z.number().int() })),
        }),
      ),
      more: z.number().int(),
    }),
  },
})

// ---- leather yield -------------------------------------------------------------------------------------------------------

const areas = { cutM2: z.string(), patternM2: z.string(), wasteM2: z.string(), yieldPct: z.string().nullable(), wastePct: z.string().nullable(), hides: z.number().int() }

export const leatherDrillContract = defineContract({
  querystring: input({ ...span, siteId: id().optional(), grade: z.string().min(1).max(40).optional(), supplierId: id().optional(), lotId: id().optional(), styleId: id().optional() }),
  response: {
    200: output({
      kpiKey: z.string(),
      period,
      asOf: instant(),
      overall: output(areas),
      byGrade: z.array(output({ grade: z.string().nullable(), ...areas })),
      byLot: z.array(output({ lot: output({ id: id(), code: z.string(), supplierLotRef: z.string().nullable() }), supplier: ref.nullable(), ...areas })),
      byStyle: z.array(output({ style: ref.nullable(), ...areas })),
      rows: z.array(
        output({
          record,
          hide: output({ id: id(), code: z.string(), grade: z.string().nullable() }),
          lot: output({ id: id(), code: z.string(), supplierLotRef: z.string().nullable() }),
          supplier: ref.nullable(),
          site: ref.nullable(),
          workOrder: output({ id: id(), number: z.string() }),
          style: ref.nullable(),
          lastCutOn: businessDate(),
          cutM2: z.string(),
          patternM2: z.string(),
          yieldPct: z.string().nullable(),
        }),
      ),
      more: z.number().int(),
    }),
  },
})

// ---- margin --------------------------------------------------------------------------------------------------------------

const figures = {
  value: money.price(z.number().int()),
  quotedCost: money.cost(z.number().int()),
  actualCost: money.cost(z.number().int()),
  /** Margin amounts: only with the cost grain too (with the price they would give the cost, Owner answer S2). */
  quotedMargin: money.margin(z.number().int().nullable()),
  actualMargin: money.margin(z.number().int().nullable()),
  quotedPct: money.margin(z.string().nullable()),
  actualPct: money.margin(z.string().nullable()),
  changePts: money.margin(z.string().nullable()),
}

export const marginDrillContract = defineContract({
  querystring: input({ ...span, companyId: id().optional(), partyId: id().optional(), styleId: id().optional(), seasonId: id().optional() }),
  response: {
    200: output({
      kpiKey: z.string(),
      period,
      asOf: instant(),
      currency: z.string().nullable(),
      /** Currencies counted in `currency` at each day's rate. */
      converted: z.array(z.string()),
      /** Garments left out for want of a rate of their day. */
      unconverted: z.number().int(),
      overall: output({ ...figures, garments: z.number().int(), orders: z.number().int() }),
      byCustomer: z.array(output({ customer: ref.nullable(), orders: z.number().int(), garments: z.number().int(), ...figures })),
      byStyle: z.array(output({ style: ref.nullable(), garments: z.number().int(), ...figures })),
      rows: z.array(output({ record, order: output({ id: id(), number: z.string() }), customer: ref.nullable(), season: ref.nullable(), lastShippedOn: businessDate(), garments: z.number().int(), ...figures })),
      more: z.number().int(),
    }),
  },
})

// ---- supplier on-time, shortages, cover ----------------------------------------------------------------------------------

export const supplyDrillContract = defineContract({
  querystring: input({
    ...span,
    siteId: id().optional(),
    supplierId: id().optional(),
    category: z.enum(ITEM_KINDS).optional(),
    /** The leather on hand: one article, and only what has lain at least this many days (its oldest lot). */
    itemId: id().optional(),
    minAgeDays: z.coerce.number().int().min(0).max(3650).optional(),
  }),
  response: {
    200: output({
      kpiKey: z.string(),
      period,
      asOf: instant(),
      overall: output({ received: z.number().int(), onTime: z.number().int(), late: z.number().int(), pct: z.string().nullable() }),
      bySupplier: z.array(output({ supplier: ref.nullable(), received: z.number().int(), onTime: z.number().int(), pct: z.string().nullable(), worstLateDays: z.number().int() })),
      rows: z.array(
        output({
          record,
          purchaseOrder: output({ id: id(), number: z.string() }),
          seq: z.number().int(),
          receipt: output({ id: id(), number: z.string() }),
          supplier: ref.nullable(),
          item: ref.nullable(),
          category: z.enum(ITEM_KINDS),
          site: ref.nullable(),
          due: businessDate(),
          postedOn: businessDate(),
          onTime: z.boolean(),
          lateDays: z.number().int(),
        }),
      ),
      more: z.number().int(),
      /** Open shortages per work order, from the latest plan of each site I plan (null: I plan no site). */
      shortages: output({
        workOrders: z.array(output({ record, workOrder: output({ id: id(), number: z.string(), status: z.string() }), site: ref.nullable(), style: ref.nullable(), shortages: z.number().int(), materials: z.array(z.string()), neededBy: businessDate() })),
        materials: z.number().int(),
        more: z.number().int(),
      }).nullable(),
      /** Days of cover of the leathers open work orders still need (null: I may not see stock). */
      cover: output({
        windowDays: z.number().int(),
        rows: z.array(
          output({
            site: ref.nullable(),
            item: ref.nullable(),
            colour: ref.nullable(),
            uom: z.string(),
            onHand: z.string(),
            hides: z.number().int(),
            usedInWindow: z.string(),
            perDay: z.string(),
            coverDays: z.string().nullable(),
            oldestLotDays: z.number().int().nullable(),
          }),
        ),
      }).nullable(),
    }),
  },
})

import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output, quantity } from '@nexus/factory-domain/core/contracts'
import { SHADE_RULES } from '@nexus/factory-domain/inventory/reservations/shade'
import { SHADE_VERDICTS } from '@nexus/factory-domain/production/cutboard/shade'
import { CUT_ORDER_KINDS, CUT_ORDER_STATUSES } from '@nexus/factory-domain/production/cutorders/rules'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { WORK_ORDER_STATUSES } from '@nexus/factory-domain/production/work-orders/machine'

/**
 * The cutting room board and the cutting and yield report (B-W2b-130; MES-163, MES-302; design production.floor "Cutting room",
 * production.reports "Cutting and yield", production.workorders "Materials & leather" › Leather). Garments and counts are
 * integers; areas and lengths decimal strings with four places (leather in its article's area unit, fabric in metres);
 * percentages strings (yield two places, a length's difference one place) or whole numbers. No field carries money and no field
 * names a person: per site, cut order, lay, hide, lot, supplier and work order only (Statuto dei Lavoratori art. 4; SCM-255).
 */

const site = output({ id: id(), code: z.string(), name: z.string() })
const ref = output({ id: id(), code: z.string(), name: z.string() })
const colour = output({ id: id(), code: z.string(), name: z.string() }).nullable()
const pct2 = () => z.string().regex(/^-?\d{1,6}\.\d{2}$/).nullable()
const pct1 = () => z.string().regex(/^-?\d{1,9}\.\d$/).nullable()

/** A leather yield over cut log entries (factory-domain production/yield figures), in the article's area unit. */
const yieldFigures = {
  used: quantity(),
  unmatched: quantity(),
  pattern: quantity(),
  remnant: quantity(),
  waste: quantity(),
  wastePct: pct2(),
  yieldPct: pct2(),
  plannedPct: pct2(),
  variancePct: pct2(),
}

// ---- GET /production/cutboard -------------------------------------------------------------------------------------------------

export const boardContract = defineContract({
  querystring: input({
    /** Default: the first site (by code) where the caller reads the cutting room. */
    siteId: id().optional(),
    /** Default: today at the site. */
    date: businessDate().optional(),
  }),
  response: {
    200: output({
      asOf: instant(),
      site: site.extend({ timeZone: z.string() }),
      /** Every site of the screen's company where the caller reads the cutting room. */
      sites: z.array(site),
      day: businessDate(),
      today: businessDate(),
      /** Cut orders by state now (open ones only); late = open and due before the day. */
      tiles: output({ planned: z.number().int(), released: z.number().int(), inProgress: z.number().int(), late: z.number().int() }),
      /** Lays at the tables now (spread or counted, not yet cut), and cut lays whose fabric used is not confirmed yet. */
      lays: output({ atTable: z.number().int(), waitingFabric: z.number().int() }),
      /** Cut against plan on the day, in garments (factory-domain production/cutboard/board dayPlan). */
      plan: output({ planned: z.number().int(), cut: z.number().int(), cutThatDay: z.number().int(), pct: z.number().int().nullable() }),
      /** What was cut on the day: cut orders and lays finished, leather pieces from the cut log. */
      cut: output({ cutOrders: z.number().int(), lays: z.number().int(), leatherPieces: z.number().int() }),
      /** Hides cut on the day (several units: one row each; the hide count is of every unit). */
      hides: z.number().int(),
      leather: z.array(output({ uom: z.enum(UOMS), hides: z.number().int(), ...yieldFigures })),
      /** Fabric of the lays cut on the day, in metres: the estimate and what the table confirmed (lays still to confirm apart). */
      fabric: output({ lays: z.number().int(), confirmed: z.number().int(), estimated: quantity(), used: quantity(), differencePct: pct1() }),
      orders: z.array(
        output({
          id: id(),
          number: z.string(),
          kind: z.enum(CUT_ORDER_KINDS),
          status: z.enum(CUT_ORDER_STATUSES),
          companyId: id(),
          siteId: id(),
          item: ref,
          colour,
          dueDate: businessDate().nullable(),
          late: z.boolean(),
          garments: z.number().int(),
          /** FABRIC: its live lays and how many are cut; LEATHER: null. */
          lays: output({ cut: z.number().int(), of: z.number().int() }).nullable(),
          workOrders: z.array(output({ id: id(), number: z.string() })),
        }),
      ),
      /** Open cut orders past the list. */
      more: z.number().int(),
    }),
  },
})

// ---- GET /production/cutboard/yield -------------------------------------------------------------------------------------------

const lotRef = output({ id: id(), code: z.string(), supplierLotRef: z.string().nullable() })
const supplierRef = output({ id: id(), name: z.string() }).nullable()

export const yieldReportContract = defineContract({
  querystring: input({
    /** Default: the first site (by code) where the caller reads the production reports. */
    siteId: id().optional(),
    /** The period's last day, included (default: today at the site). */
    to: businessDate().optional(),
    /** The period's first day, included (default: 30 days back from `to`; at most a year before it). */
    from: businessDate().optional(),
  }),
  response: {
    200: output({
      asOf: instant(),
      site: site.extend({ timeZone: z.string() }),
      sites: z.array(site),
      from: businessDate(),
      to: businessDate(),
      today: businessDate(),
      /** Cut vs ordered of the cut orders cut in the period (factory-domain production/cutboard/yield cutSums). */
      cut: output({
        orders: z.number().int(),
        ordered: z.number().int(),
        cut: z.number().int(),
        difference: z.number().int(),
        pct: z.number().int().nullable(),
        waiting: z.number().int(),
        variances: z.number().int(),
      }),
      /** The cut orders cut in the period, newest cut first (at most 50; `more` counts the rest). */
      orders: z.array(
        output({
          id: id(),
          number: z.string(),
          kind: z.enum(CUT_ORDER_KINDS),
          status: z.enum(CUT_ORDER_STATUSES),
          companyId: id(),
          siteId: id(),
          cutAt: instant(),
          item: ref,
          colour,
          ordered: z.number().int(),
          /** null: a leather line waits for its reconciliation. */
          cut: z.number().int().nullable(),
          reconciled: z.boolean(),
        }),
      ),
      more: z.number().int(),
      /** Fabric used in metres per material, of the lays cut in the period whose fabric was confirmed. */
      fabric: output({
        lays: z.number().int(),
        waiting: z.number().int(),
        estimated: quantity(),
        used: quantity(),
        differencePct: pct1(),
        materials: z.array(output({ item: ref, colour, lays: z.number().int(), estimated: quantity(), used: quantity(), differencePct: pct1() })),
      }),
      /** Leather from the cut log of the period: per area unit, per material, per hide lot and per supplier (each in its area unit). */
      leather: output({
        /** Every hide of the period together, per area unit (never added across units). */
        units: z.array(output({ uom: z.enum(UOMS), hides: z.number().int(), ...yieldFigures })),
        materials: z.array(output({ item: ref, colour, uom: z.enum(UOMS), hides: z.number().int(), ...yieldFigures })),
        lots: z.array(output({ lot: lotRef, supplier: supplierRef, item: ref, uom: z.enum(UOMS), hides: z.number().int(), ...yieldFigures })),
        suppliers: z.array(output({ supplier: supplierRef, uom: z.enum(UOMS), lots: z.number().int(), hides: z.number().int(), ...yieldFigures })),
      }),
    }),
  },
})

// ---- GET /production/cutboard/work-orders/:workOrderId/leather ---------------------------------------------------------------

export const workOrderLeatherContract = defineContract({
  params: input({ workOrderId: id() }),
  response: {
    200: output({
      workOrder: output({ id: id(), number: z.string(), status: z.enum(WORK_ORDER_STATUSES) }),
      /** The site's shade rule (B-W2b-100; ORDER: one shade lot per order). */
      rule: z.enum(SHADE_RULES),
      materials: z.array(
        output({
          item: ref.extend({ uom: z.enum(UOMS) }),
          colour,
          verdict: z.enum(SHADE_VERDICTS),
          breaksRule: z.boolean(),
          outOfShade: z.boolean(),
          /** Each shade lot (a lot and its shade group, else its W1 shade text) with the hides the work order holds, has reserved and cut. */
          lots: z.array(
            output({
              key: z.string(),
              lot: lotRef,
              shade: z.string().nullable(),
              outOfShade: z.boolean(),
              held: z.number().int(),
              reserved: z.number().int(),
              cut: z.number().int(),
            }),
          ),
          hides: output({ held: z.number().int(), reserved: z.number().int(), cut: z.number().int() }),
        }),
      ),
    }),
  },
})

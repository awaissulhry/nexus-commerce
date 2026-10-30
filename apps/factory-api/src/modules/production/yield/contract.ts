import { z } from 'zod'
import { defineContract, id, input, output, quantity } from '@nexus/factory-domain/core/contracts'
import { HIDE_STATES } from '@nexus/factory-domain/inventory/issue/rules'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { WORK_ORDER_STATUSES } from '@nexus/factory-domain/production/work-orders/machine'

/**
 * Hide yield (B-W2a-13; MES-057, SCM-255): areas in the leather's base unit (four places), percentages with two places
 * (null when nothing was used, or the plan is unknown). Never by cutter. No money.
 */

const pct = () => z.string().regex(/^-?\d{1,6}\.\d{2}$/).nullable()

const figures = {
  /** The area the cuts used (pieces and the waste around them). */
  used: quantity(),
  /** Area used by cuts of single parts, whose pattern is not known: left out of the yield and the waste. */
  unmatched: quantity(),
  /** The pieces' net area (the BOM need without wastage). */
  pattern: quantity(),
  /** Offcuts set aside as remnants. */
  remnant: quantity(),
  waste: quantity(),
  wastePct: pct(),
  /** pattern / used. */
  yieldPct: pct(),
  /** The style's planned hide yield, else what the BOM's wastage expects. */
  plannedPct: pct(),
  /** yield − planned, percentage points. */
  variancePct: pct(),
}

const hideRow = output({
  hide: output({ id: id(), code: z.string(), grade: z.string().nullable(), shade: z.string().nullable(), state: z.enum(HIDE_STATES) }),
  lot: output({ id: id(), code: z.string(), supplierLotRef: z.string().nullable() }),
  supplier: output({ id: id(), name: z.string() }).nullable(),
  item: output({ id: id(), code: z.string(), uom: z.enum(UOMS) }),
  /** The hide's area at receipt. */
  areaIn: quantity(),
  ...figures,
})

export const workOrderYieldContract = defineContract({
  params: input({ workOrderId: id() }),
  response: {
    200: output({
      workOrder: output({ id: id(), number: z.string(), status: z.enum(WORK_ORDER_STATUSES) }),
      /** Where the plan comes from: the style revision's planned hide yield, or the BOM's wastage. */
      plannedSource: z.enum(['STYLE', 'BOM']),
      /** Every hide together. */
      overall: output(figures),
      hides: z.array(hideRow),
    }),
  },
})

export const cuttingYieldContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    styleId: id().optional(),
    lotId: id().optional(),
    from: z.iso.datetime({ offset: true }).transform((value) => new Date(value)).optional(),
    to: z.iso.datetime({ offset: true }).transform((value) => new Date(value)).optional(),
  }),
  response: {
    200: output({
      hides: z.array(hideRow),
      /** Planned against actual per style and supplier lot (MES-057). */
      byStyleAndLot: z.array(
        output({
          style: output({ id: id(), code: z.string(), name: z.string() }),
          lot: output({ id: id(), code: z.string(), supplierLotRef: z.string().nullable() }),
          supplier: output({ id: id(), name: z.string() }).nullable(),
          hides: z.number().int(),
          ...figures,
        }),
      ),
      /** Every hide together. */
      overall: output(figures),
    }),
  },
})

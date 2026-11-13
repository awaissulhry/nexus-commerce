import { z } from 'zod'
import { id, output } from '../../core/contracts'
import { REVIEW_STATUSES } from './rules'

/**
 * Where a measurement template is used, beyond counts (B-W2b-371, XF2:04; design products.sizes template.whereused "Styles that use
 * it and rider profiles measured with it"): the styles measured with it (flagged made to measure or not) and the open orders whose
 * made-to-measure units it serves (a unit of a style measured with it, or a rider measured for its garment type). No money. The
 * orders only for a reader of orders (orders.view, its companies and customers: `orders` null otherwise); a unit's rider only for a
 * reader of measurements (sales.measurements.view over the customer: `rider` null otherwise).
 */
export const whereUsedView = output({
  template: output({ id: id(), code: z.string() }),
  styles: z.array(output({ id: id(), code: z.string(), name: z.string(), season: z.string().nullable(), status: z.string(), lifecycle: z.string(), madeToMeasure: z.boolean(), companyId: id().nullable() })),
  orders: z
    .array(
      output({
        id: id(),
        number: z.string(),
        status: z.string(),
        companyId: id(),
        customer: output({ id: id(), code: z.string(), name: z.string() }),
        units: z.array(
          output({
            lineId: id(),
            seq: z.number().int(),
            style: output({ id: id(), code: z.string() }),
            colourway: z.string(),
            baseSize: z.string().nullable(),
            profile: output({ id: id(), revision: z.number().int(), review: z.enum(REVIEW_STATUSES) }),
            rider: z.string().nullable(),
          }),
        ),
      }),
    )
    .nullable(),
  /** The open orders beyond the ones answered (at most 100 are listed). */
  moreOrders: z.boolean(),
})
export type WhereUsedView = z.output<typeof whereUsedView>

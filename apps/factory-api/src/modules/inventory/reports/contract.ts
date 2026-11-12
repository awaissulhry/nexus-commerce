import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { AGE_BUCKETS, MATERIAL_TYPES } from '@nexus/factory-domain/inventory/reports/rules'
import { money } from '@nexus/factory-domain/money/marked'
import { UOMS } from '@nexus/factory-domain/product/units/units'

/**
 * Warehouse reports (B-W2b-356; design warehouse.reports SCR-257). Office only, read only. Quantities are decimal strings with
 * four places, per unit (never summed across units); shares and average ages one decimal, null when they cannot be said (several
 * units, nothing on hand) — the screen says "—", never 0. Every value is money.cost (minor units), dropped for a caller without
 * the cost grain. No field names a person. The querystrings are strict: an unknown key is refused.
 */

const scope = {
  /** One site of the screen's company; default every site of it the reader may see the stock of. */
  siteId: id().optional(),
  /** Default this month so far (Rome): the monthly stock review. */
  from: businessDate().optional(),
  to: businessDate().optional(),
}

const ref = output({ id: id(), code: z.string(), name: z.string() })
const uom = z.enum(UOMS)
const quantity = () => z.string().regex(/^-?\d{1,14}\.\d{4}$/)
const one = () => z.string().regex(/^\d{1,9}\.\d$/).nullable()
const head = {
  /** The screen's company (null: every company the reader reaches). */
  company: ref.nullable(),
  /** The site asked (null: every site read). */
  site: ref.nullable(),
  /** The sites read (the reader's, of the company). */
  sites: z.array(ref),
  from: businessDate(),
  to: businessDate(),
  today: businessDate(),
  asOf: instant(),
}
/** Which records the reader may see: the stock (inventory.stock.view at some site of the company) and its values (money.cost). */
const sight = output({ stock: z.boolean(), cost: z.boolean() })
const unitQuantity = output({ uom, quantity: quantity() })

const bucket = output({
  quantities: z.array(unitQuantity),
  value: money.cost(z.number().int().nullable()),
  /** The bucket's share of the group's quantity, one decimal; null with several units. */
  share: one(),
})
/** The design's buckets (AGE_BUCKETS): 0–90, 91–180, 181–365 days, over a year. */
const buckets = output({ d0to90: bucket, d91to180: bucket, d181to365: bucket, overYear: bucket } satisfies Record<(typeof AGE_BUCKETS)[number], typeof bucket>)
const figures = {
  buckets,
  /** What no move dates (never on a consistent ledger). */
  undated: z.array(unitQuantity),
  whole: output({ quantities: z.array(unitQuantity), value: money.cost(z.number().int().nullable()) }),
  currency: z.string().nullable(),
  mixedCurrencies: z.boolean(),
  /** Parts without a value: customer-owned stock, or moves not valued yet. */
  unvalued: z.number().int(),
  /** Weighted by quantity, one decimal; null with several units. */
  averageDays: one(),
  oldestDays: z.number().int().nullable(),
  /** The stock keys counted: lots, hides, untracked articles by colour and site. */
  keys: z.number().int(),
}

export const ageingContract = defineContract({
  querystring: input(scope),
  response: {
    200: output({
      ...head,
      sight,
      /** The day the stock is aged at: the period's last day. */
      asAt: businessDate(),
      types: z.array(
        output({
          type: z.enum(MATERIAL_TYPES),
          ...figures,
          /** Its articles (item and colour), the most on hand over a year first, at most 50; `more` counts the rest. */
          articles: z.array(output({ item: ref, colour: ref.nullable(), tracked: z.boolean(), ...figures })),
          more: z.number().int(),
        }),
      ),
      /** Every type's value together (quantities are never summed across types). */
      all: output({ value: money.cost(z.number().int().nullable()), currency: z.string().nullable(), mixedCurrencies: z.boolean(), unvalued: z.number().int() }),
      /** Stock keys of customer-owned lots: counted, never valued. */
      customerOwned: z.number().int(),
    }),
  },
})
export type AgeingQuery = z.infer<typeof ageingContract.querystring>

const leatherQuantities = output({
  start: quantity(),
  received: quantity(),
  issued: quantity(),
  returned: quantity(),
  remnant: quantity(),
  cut: quantity(),
  scrapped: quantity(),
  other: quantity(),
  end: quantity(),
})
const leatherFigures = output({
  /** In the article's base unit (null for an article total over several base units). */
  uom: uom.nullable(),
  base: leatherQuantities.nullable(),
  /** The same in m² (null when the unit is not an area). */
  m2: leatherQuantities.nullable(),
  /** start + received − cut − scrapped + other = end. */
  addsUp: z.boolean(),
  hidesReceived: z.number().int(),
  hidesOnHand: z.number().int(),
  values: output({
    start: money.cost(z.number().int().nullable()),
    received: money.cost(z.number().int().nullable()),
    cut: money.cost(z.number().int().nullable()),
    scrapped: money.cost(z.number().int().nullable()),
    end: money.cost(z.number().int().nullable()),
  }),
  currency: z.string().nullable(),
})

export const leatherContract = defineContract({
  querystring: input(scope),
  response: {
    200: output({
      ...head,
      sight,
      articles: z.array(
        output({
          item: ref,
          colour: ref.nullable(),
          figures: leatherFigures,
          lots: z.array(
            output({
              /** The supplier lot: our lot code (a split lot's parent: its children count with it). */
              lot: output({ id: id(), code: z.string() }).nullable(),
              supplier: ref.nullable(),
              supplierLotRef: z.string().nullable(),
              dyeBatch: z.string().nullable(),
              /** Child lots made by a split (B-W2b-313), counted here. */
              children: z.number().int(),
              figures: leatherFigures,
            }),
          ),
        }),
      ),
      all: leatherFigures,
      /** Supplier lots left out (more than 500). */
      more: z.number().int(),
      /** Moves of the period without a value yet (their quantities are counted). */
      unvaluedMoves: z.number().int(),
    }),
  },
})
export type LeatherQuery = z.infer<typeof leatherContract.querystring>

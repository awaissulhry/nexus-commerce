import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { money } from '@nexus/factory-domain/money/marked'
import { PURCHASE_ORDER_STATUSES } from '@nexus/factory-domain/purchasing/orders'
import { SPEND_GROUPS, SPEND_KINDS } from '@nexus/factory-domain/purchasing/reports/rules'
import { UOMS } from '@nexus/factory-domain/product/units/units'

/**
 * Purchasing reports (B-W2b-350; design purchasing.reports SCR-255 sec spend and pop drill). Office only, read only. Every
 * amount is money.cost in minor units, dropped for a caller without the cost grain (so is the share: a share of spend says how
 * the amounts compare); counts stay. Amounts are never summed across currencies: `byCurrency` lists each, and `production` /
 * `samples` are set only when a group is in one currency. No field names a person. The late lines are the expediting worklist's
 * own route (GET /purchasing/expediting, B-W2b-305). The querystrings are strict: an unknown key is refused.
 */

const scope = {
  /** One site of the screen's company; default every site of it. */
  siteId: id().optional(),
  /** Default this month so far (Rome): the monthly buying review. */
  from: businessDate().optional(),
  to: businessDate().optional(),
}

const ref = output({ id: id(), code: z.string(), name: z.string() })
const head = {
  /** The screen's company (null: every company the reader reaches). */
  company: ref.nullable(),
  /** The site asked (null: every site). */
  site: ref.nullable(),
  from: businessDate(),
  to: businessDate(),
  today: businessDate(),
  asOf: instant(),
}
/** What the reader may see: the orders (purchasing.view over some site of the company) and their amounts (`values`: the cost grain). */
const sight = output({ orders: z.boolean(), values: z.boolean() })
const share = () => z.string().regex(/^\d{1,3}\.\d$/).nullable()

const counts = {
  /** Distinct production orders and their lines; distinct sample and development orders and their lines (apart). */
  orders: z.number().int(),
  lines: z.number().int(),
  sampleOrders: z.number().int(),
  sampleLines: z.number().int(),
}
const figures = {
  /** Each currency's spend (the company's first). */
  byCurrency: z.array(output({ currency: z.string(), production: money.cost(z.number().int()), samples: money.cost(z.number().int()) })),
  /** In `currency` when the figures are in one; null when in several (then `byCurrency` says each). */
  production: money.cost(z.number().int().nullable()),
  samples: money.cost(z.number().int().nullable()),
  currency: z.string().nullable(),
  mixedCurrencies: z.boolean(),
  ...counts,
}
const monthFigures = output({ month: z.string().regex(/^\d{4}-\d{2}$/), production: money.cost(z.number().int().nullable()), samples: money.cost(z.number().int().nullable()), currency: z.string().nullable(), ...counts })

export const spendContract = defineContract({
  querystring: input({ ...scope, by: z.enum(SPEND_GROUPS).default('supplier') }),
  response: {
    200: output({
      ...head,
      sight,
      by: z.enum(SPEND_GROUPS),
      /** The months (YYYY-MM) of the period: the pivot's columns. */
      months: z.array(z.string()),
      /** The company's currency (null: no company on screen). */
      companyCurrency: z.string().nullable(),
      all: output(figures),
      groups: z.array(
        output({
          /** The group: a supplier, material or company id, a category (the material's kind) or a month (YYYY-MM). */
          key: z.string(),
          /** Its code and name (a category or a month: the key; the screen says it in words). */
          code: z.string().nullable(),
          name: z.string(),
          /** Its share of the production spend, one decimal (null: no amounts, several currencies or no spend). */
          share: share(),
          ...figures,
          months: z.array(monthFigures),
        }),
      ),
      /** Groups beyond the first 50 (counted in `all`). */
      more: z.number().int(),
      /** Every line of the period was read (at most 20,000). */
      complete: z.boolean(),
    }),
  },
})
export type SpendQuery = z.infer<typeof spendContract.querystring>

export const spendLinesContract = defineContract({
  querystring: input({ ...scope, by: z.enum(SPEND_GROUPS), key: z.string().min(1).max(64), kind: z.enum(['all', ...SPEND_KINDS] as const).default('all') }),
  response: {
    200: output({
      ...head,
      sight,
      by: z.enum(SPEND_GROUPS),
      key: z.string(),
      code: z.string().nullable(),
      name: z.string(),
      figures: output(figures),
      lines: z.array(
        output({
          lineId: id(),
          seq: z.number().int(),
          purchaseOrderId: id(),
          number: z.string(),
          status: z.enum(PURCHASE_ORDER_STATUSES),
          kind: z.enum(SPEND_KINDS),
          /** The day the order was first sent (revision 1). */
          placedOn: businessDate(),
          supplier: ref,
          item: ref,
          category: z.string(),
          colour: output({ code: z.string(), name: z.string() }).nullable(),
          quantity: z.string(),
          uom: z.enum(UOMS),
          /** CLOSED_SHORT: counted for what came. */
          ended: z.enum(['CLOSED_SHORT']).nullable(),
          /** The line's spend in `currency` (the company's at the rate of the order, else the order's own). */
          spend: money.cost(z.number().int()),
          currency: z.string(),
        }),
      ),
      /** Lines beyond the first 500. */
      more: z.number().int(),
    }),
  },
})
export type SpendLinesQuery = z.infer<typeof spendLinesContract.querystring>

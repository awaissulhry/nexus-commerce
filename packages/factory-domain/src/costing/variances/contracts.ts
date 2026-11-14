import { z } from 'zod'
import { businessDate, id, input, instant, output } from '../../core/contracts'
import { money, notMoney } from '../../money/marked'
import { UOMS } from '../../product/units/units'
import { VARIANCE_CATEGORIES } from './split'

/**
 * The contracts of the variances per work order (B-W2b-411; FIN-029, FIN-030; design finance.costing's bridge "biggest
 * reason", production.workorders "Labour & cost"): the variance lines of the closes across work orders, and the scrap and
 * rework cost of one work order per reason. Every amount is `money.cost` in minor units (dropped without the cost grain);
 * counts, minutes, categories and reasons are not money. Per work order, line or reason: never per person.
 */

const categoryList = z
  .string()
  .transform((value) => value.split(',').map((part) => part.trim()).filter((part) => part.length > 0))
  .pipe(z.array(z.enum(VARIANCE_CATEGORIES)))

/** GET /costing/variances */
export const variancesQuery = input({
  companyId: id().optional(),
  siteId: id().optional(),
  workOrderId: id().optional(),
  /** Comma-separated categories. */
  category: categoryList.optional(),
  /** Europe/Rome days of the closes, both included. */
  from: businessDate().optional(),
  to: businessDate().optional(),
  /** Only the lines of closes that stand (default), or of undone ones too. */
  live: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  cursor: id().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
export type VariancesQuery = z.infer<typeof variancesQuery>

const itemRef = output({ id: id(), code: z.string(), name: z.string(), baseUom: z.enum(UOMS) })

export const varianceRowView = output({
  id: id(),
  closeId: id(),
  workOrder: output({ id: id(), number: z.string() }),
  companyId: id(),
  siteId: id(),
  category: z.enum(VARIANCE_CATEGORIES),
  item: itemRef.nullable(),
  standardQuantity: z.string().nullable(),
  actualQuantity: z.string().nullable(),
  standardUnitCost: money.cost(z.string().nullable()),
  actualUnitCost: money.cost(z.string().nullable()),
  amount: money.cost(z.number().int()),
  currency: z.string(),
  closedAt: instant(),
  /** The close stands (not undone). */
  live: z.boolean(),
  note: z.string().nullable(),
})

export const variancesAnswer = output({
  rows: z.array(varianceRowView),
  /** Over every line the filters find (not only the page), per currency and category; the amounts marked inside. */
  totals: notMoney(z.array(output({ currency: z.string(), category: z.enum(VARIANCE_CATEGORIES), lines: z.number().int(), amount: money.cost(z.number().int()) }))),
  nextCursor: id().nullable(),
  /** The words while the company's figures for the accountant are off (one company asked), else null. */
  waits: z.string().nullable(),
})

const scrapReworkRow = output({
  reasonCode: z.string(),
  scrappedGarments: z.number().int(),
  scrapValue: money.cost(z.number().int()),
  stockScrapValue: money.cost(z.number().int()),
  reworkGarments: z.number().int(),
  reworkMinutes: z.string(),
  reworkCost: money.cost(z.number().int().nullable()),
  total: money.cost(z.number().int().nullable()),
})

/** GET /costing/work-orders/:workOrderId/scrap-rework */
export const scrapReworkView = output({
  workOrder: output({ id: id(), number: z.string(), status: z.string() }),
  currency: z.string(),
  rows: z.array(scrapReworkRow),
  /** The money inside is marked field by field. */
  totals: notMoney(scrapReworkRow.omit({ reasonCode: true })),
  words: z.string(),
})
export type ScrapReworkView = z.infer<typeof scrapReworkView>

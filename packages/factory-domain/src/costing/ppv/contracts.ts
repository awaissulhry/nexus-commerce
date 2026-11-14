import { z } from 'zod'
import { businessDate, id, input, instant, output } from '../../core/contracts'
import { money } from '../../money/marked'
import { UOMS } from '../../product/units/units'
import { PPV_AT, PPV_SKIPS } from './rules'

/**
 * The contracts of the purchase price variance (B-W2b-407; FIN-031; design finance.costing "Purchase price variance":
 * material, supplier, standard, paid, difference). Unit costs and differences are `money.cost` (dropped for a caller
 * without the cost grain: the design draws no value column then); quantities, materials, suppliers, documents and words
 * are shown to every caller with costing.view. No person is named.
 */

const itemRef = output({ id: id(), code: z.string(), name: z.string(), baseUom: z.enum(UOMS) })
const partyRef = output({ id: id(), name: z.string() })

/** The document a variance comes from: a goods receipt's line or a supplier invoice's line. */
export const ppvSourceView = output({
  at: z.enum(PPV_AT),
  /** The receipt's or the invoice's id and number, and the line. */
  documentId: id(),
  number: z.string(),
  lineId: id(),
  seq: z.number().int(),
})

export const ppvRowView = output({
  id: id(),
  companyId: id(),
  supplier: partyRef,
  item: itemRef,
  source: ppvSourceView,
  postedAt: instant(),
  /** The Europe/Rome day the period lock reads. */
  day: businessDate(),
  /** Base units (a reversal: the opposite). */
  quantity: z.string(),
  standardUnitCost: money.cost(z.string()),
  paidUnitCost: money.cost(z.string()),
  /** Minor units: above 0 paid more than standard. */
  differenceAmount: money.cost(z.number().int()),
  currency: z.string(),
  standardId: id().nullable(),
  reversalOfId: id().nullable(),
  reversedBy: output({ id: id(), postedAt: instant(), reason: z.string().nullable() }).nullable(),
  reason: z.string().nullable(),
  words: money.cost(z.string()),
})
export type PpvRowView = z.infer<typeof ppvRowView>

export const ppvQuery = input({
  companyId: id().optional(),
  partyId: id().optional(),
  itemId: id().optional(),
  at: z.enum(PPV_AT).optional(),
  /** Europe/Rome days of postedAt, both included. */
  from: businessDate().optional(),
  to: businessDate().optional(),
  receiptId: id().optional(),
  supplierInvoiceId: id().optional(),
  cursor: id().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})
export type PpvQuery = z.infer<typeof ppvQuery>

const total = output({ currency: z.string(), differenceAmount: money.cost(z.number().int()), rows: z.number().int() })

export const ppvAnswer = output({
  rows: z.array(ppvRowView),
  nextCursor: id().nullable(),
  /** Σ the differences of the rows of the query (every page), per currency. */
  totals: z.array(total),
  /** The asked company's switch: the words while its figures wait for the accountant (null: on, or no company asked). */
  waits: z.string().nullable(),
  empty: z.string(),
})
export type PpvAnswer = z.infer<typeof ppvAnswer>

/** POST /costing/ppv/post: a receipt's or an invoice's variances now (what the worker does after its event). */
export const ppvPostBody = input({ receiptId: id().optional(), supplierInvoiceId: id().optional() }).refine((body) => (body.receiptId === undefined) !== (body.supplierInvoiceId === undefined), {
  message: 'Name a goods receipt or a supplier invoice, one of them.',
})
export type PpvPostBody = z.infer<typeof ppvPostBody>

export const ppvSkipView = output({ lineId: id(), seq: z.number().int(), code: z.enum(PPV_SKIPS), words: z.string() })
export type PpvSkipView = z.infer<typeof ppvSkipView>

export const ppvPostAnswer = output({ posted: z.array(ppvRowView), skipped: z.array(ppvSkipView), replayed: z.boolean() })

export const ppvReverseBody = input({ reason: z.string().trim().min(3).max(1000) })
export const ppvReverseAnswer = output({ variance: ppvRowView, reversal: ppvRowView, replayed: z.boolean() })

import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { money, notMoney } from '@nexus/factory-domain/money/marked'
import { QUOTE_SECTION_IDS } from '@nexus/factory-domain/sales/quote-compare/rules'

/**
 * Two versions of a quote compared (B-W2b-302; SAL-158), in VersionCompare's shape (B-W2b-207; as B-W2b-220's style compare):
 * `sections` (terms, lines: no money; their totals are counts), `prices` (the price grain: left out without it) and `margin`
 * (the margin grain). A line's id is the second version's line id (the first's for a removed line; the terms line is "terms").
 */

const written = () => z.string().nullable()
const compareSide = output({ fields: z.record(z.string(), written()), sizes: z.record(z.string(), z.string()).optional() })
const compareLine = output({ id: z.string(), label: z.string(), detail: z.string().nullable(), before: compareSide.nullable(), after: compareSide.nullable() })
const compareField = output({ id: z.string(), label: z.string() })
const compareTotal = output({ id: z.string(), label: z.string(), before: written(), after: written() })
const summary = output({ added: z.number().int(), removed: z.number().int(), changed: z.number().int(), unchanged: z.number().int() })
const shape = { id: z.enum(QUOTE_SECTION_IDS), label: z.string(), fields: z.array(compareField), sizes: z.array(z.string()), lines: z.array(compareLine), summary }

/** Terms and lines: the totals are counts (lines, pieces). */
const plainSection = output({ ...shape, totals: notMoney(z.array(compareTotal)) })
const head = output({ id: id(), revision: z.number().int(), label: z.string(), note: z.string(), documentNumber: z.string() })
const differs = output({ section: z.enum(QUOTE_SECTION_IDS), label: z.string(), added: z.number().int(), removed: z.number().int(), changed: z.number().int() })

export const compareVersionsContract = defineContract({
  params: input({ quoteId: id() }),
  querystring: input({ from: z.coerce.number().int().min(1).optional(), to: z.coerce.number().int().min(1).optional() }),
  response: {
    200: output({
      quote: output({ id: id(), number: z.string(), currentRevision: z.number().int() }),
      before: head,
      after: head,
      currency: z.string(),
      sections: z.array(plainSection),
      /** Unit and list prices, discount, prices by size, net, the reason; totals net, VAT, gross, deposit. */
      prices: money.price(output({ ...shape, totals: money.price(z.array(compareTotal)) })),
      /** Each line's margin % and the version's. */
      margin: money.margin(output({ ...shape, totals: money.margin(z.array(compareTotal)) })),
      /** The sections that differ, among those the reader may see. */
      differs: z.array(differs),
      words: z.string(),
      /** A plain change note from what the reader may see ("Use as change note"; at most W1's change-note length). */
      changeNote: z.string(),
    }),
  },
})

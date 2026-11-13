import { z } from 'zod'
import { defineContract, id, input, output, unitPrice } from '@nexus/factory-domain/core/contracts'
import { money, notMoney } from '@nexus/factory-domain/money/marked'
import { START_KINDS } from '@nexus/factory-domain/sales/price-waterfall/rules'
import { GOAL_KINDS } from '@nexus/factory-domain/sales/quote-goalseek/rules'
import { quoteView } from '../quotes/contract'

/**
 * Target price goal-seek (B-W2b-302; SAL-150). The target's figure is the price grain (a unit price, a discount, a total) or
 * the margin grain (a margin, which also needs the cost grain: refused in words without it); a body that sends a marked
 * field without its grain is refused before the handler. Every figure of the answer is marked: prices and the waterfall the
 * price grain, margins and the floor marks the margin grain, the margin AMOUNT only with the cost grain too. The held lines,
 * the approval words and `words` carry no figure.
 */

const pct = () => z.string().trim().refine((value) => /^\d{1,3}(\.\d{1,4})?$/.test(value), { message: 'Expected a percent with at most 4 decimals.' })
const reasonCode = () => z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'Expected a reason code (capitals, digits and _).')
const steps = () => money.price(z.array(z.record(z.string(), z.unknown())))
const amounts = () => money.price(output({ netAmount: money.price(z.number().int()), vatAmount: money.price(z.number().int()), grossAmount: money.price(z.number().int()) }))

export const goalSeekContract = defineContract({
  params: input({ quoteId: id() }),
  body: input({
    /** The quote's version (the edit-conflict guard; checked by the preview too). */
    version: z.number().int().min(1),
    /** The lines to price (default: every size-grid line of the current version). */
    lineIds: z.array(id()).min(1).max(200).optional(),
    target: input({
      kind: z.enum(GOAL_KINDS),
      /** UNIT_PRICE: on the quote's basis. */
      unitPrice: money.price(unitPrice().nullish()),
      /** DISCOUNT: off each line's start. */
      pct: money.price(pct().nullish()),
      /** MARGIN: percent of the net (the cost grain too). */
      marginPct: money.margin(pct().nullish()),
      /** TOTAL: the quote's total on its basis (net for a business, VAT included for a consumer). */
      amount: money.price(unitPrice().nullish()),
    }),
    /** The PRICE_ADJUSTMENT reason written (default TARGET_PRICE); one that needs words takes `note`. */
    reasonCode: reasonCode().optional(),
    note: z.string().trim().max(500).nullish(),
    /** true: the answer only (nothing written); else the same plan written in one command. */
    preview: z.boolean().optional(),
  }),
  response: {
    200: output({
      preview: z.boolean(),
      quoteId: id(),
      versionId: id(),
      revision: z.number().int(),
      currency: z.string(),
      priceBasis: notMoney(z.enum(['NET', 'GROSS'])),
      target: output({ kind: z.enum(GOAL_KINDS), unitPrice: money.price(z.string().nullable()), pct: money.price(z.string().nullable()), marginPct: money.margin(z.string().nullable()), amount: money.price(z.string().nullable()), reasonCode: z.string() }),
      lines: z.array(
        output({
          lineId: id(),
          seq: z.number().int(),
          description: z.string().nullable(),
          styleId: id(),
          colourwayId: id(),
          pieces: z.number().int(),
          /** The start the waterfall keeps (LIST, SUGGESTED, MANUAL) and its unit price. */
          start: output({ kind: z.enum(START_KINDS), unitPrice: money.price(z.string().nullable()) }),
          from: output({ unitPrice: money.price(z.string()), marginPct: money.margin(z.string().nullable()) }),
          to: output({ unitPrice: money.price(z.string()), marginPct: money.margin(z.string().nullable()), marginAmount: money.margin(z.number().int().nullable()) }),
          /** "Discount needed": off the start, percent (below 0: a raise). */
          discountPct: money.price(z.string().nullable()),
          /** The waterfall the line gets (B-W2b-330's steps). */
          steps: steps(),
          belowFloor: money.margin(z.boolean()),
          belowCost: money.margin(z.boolean()),
        }),
      ),
      totals: money.price(output({ before: amounts(), after: amounts(), target: money.price(z.number().int().nullable()), gap: money.price(z.number().int().nullable()) })),
      margin: money.margin(output({ before: money.margin(z.string().nullable()), after: money.margin(z.string().nullable()), floorPct: money.margin(z.string()), floorRole: z.string().nullable() })),
      /** After the change: an approval is needed, and the rules that break (in words, no figure). */
      approval: output({ neededBefore: z.boolean(), neededAfter: z.boolean(), rules: z.array(z.string()) }),
      /** Lines goal-seek does not write, each in words: BELOW_COST (an approver must allow it: price it by hand), REFUSED. */
      held: z.array(output({ lineId: id(), seq: z.number().int(), code: z.enum(['BELOW_COST', 'REFUSED']), words: z.string() })),
      words: z.string(),
      quote: quoteView.optional(),
    }),
  },
})

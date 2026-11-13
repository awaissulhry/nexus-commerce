import { z } from 'zod'
import { defineContract, id, input, output, unitPrice } from '@nexus/factory-domain/core/contracts'
import { money, notMoney } from '@nexus/factory-domain/money/marked'
import { PASTE_LIMITS, SIZE_CHANGE_KINDS } from '@nexus/factory-domain/sales/quote-bulk/rules'
import { MAX_QUOTE_LINES, MAX_SIZE_QUANTITY } from '@nexus/factory-domain/sales/quotes/quotes'
import { SIZE_CURVE_LIMITS } from '@nexus/factory-domain/sales/size-curves/rules'
import { quoteView } from '../quotes/contract'

/**
 * Paste lines, change a size run in bulk, fill by a size curve or a prepack (B-W2b-302; SAL-160, SAL-269, QT2:01). Pieces only:
 * no money in the answers (a pasted unit price is the price grain in the body, and only a NEW line takes it). Every route
 * answers the review with `preview: true` and writes the same plan without it (the quote's `version` guards both).
 */

const version = z.number().int().min(1)
const pieces = z.record(z.string(), z.number().int())
const move = output({ size: z.string(), from: z.number().int(), to: z.number().int() })
const problem = output({ code: z.enum(['GRID', 'SCHEDULE', 'EMPTY', 'LINE']), path: z.string(), message: z.string() })
const lineResult = output({
  lineId: id(),
  seq: z.number().int(),
  /** "10 · SEED-JKT-01 BLK". */
  label: z.string(),
  before: pieces,
  after: pieces,
  moves: z.array(move),
  pieces: output({ before: z.number().int(), after: z.number().int() }),
  problems: z.array(problem),
  words: z.string(),
})
const quoteParams = input({ quoteId: id() })

export const bulkSizesContract = defineContract({
  params: quoteParams,
  body: input({
    version,
    /** Default: every size-grid line of the current version. */
    lineIds: z.array(id()).min(1).max(MAX_QUOTE_LINES).optional(),
    /** Only these sizes (default: every size). */
    sizes: z.array(z.string().trim().min(1).max(40)).min(1).max(100).optional(),
    change: input({ kind: z.enum(SIZE_CHANGE_KINDS), pct: z.string().trim().max(12).nullish(), pieces: z.number().int().min(-MAX_SIZE_QUANTITY).max(MAX_SIZE_QUANTITY).nullish() }),
    preview: z.boolean().optional(),
  }),
  response: {
    200: output({
      preview: z.boolean(),
      lines: z.array(lineResult),
      counts: output({ lines: z.number().int(), changing: z.number().int(), unchanged: z.number().int(), problems: z.number().int() }),
      words: z.string(),
      quote: quoteView.optional(),
    }),
  },
})

export const fillLinesContract = defineContract({
  params: quoteParams,
  body: input({
    version,
    /** A size curve (pieces per line) or a prepack (packs per line): one of the two. */
    curveId: id().nullish(),
    prepackId: id().nullish(),
    lines: z
      .array(input({ lineId: id(), pieces: z.number().int().min(1).max(SIZE_CURVE_LIMITS.total).nullish(), packs: z.number().int().min(1).max(SIZE_CURVE_LIMITS.packs).nullish() }))
      .min(1)
      .max(MAX_QUOTE_LINES),
    preview: z.boolean().optional(),
  }),
  response: {
    200: output({
      preview: z.boolean(),
      source: output({ kind: z.enum(['CURVE', 'PREPACK']), id: id(), name: z.string(), words: z.string() }),
      lines: z.array(lineResult.extend({ fill: output({ leftOut: z.array(z.string()), remainder: output({ size: z.string(), pieces: z.number().int() }).nullable(), words: z.string() }).nullable() })),
      counts: output({ lines: z.number().int(), changing: z.number().int(), problems: z.number().int() }),
      words: z.string(),
      quote: quoteView.optional(),
    }),
  },
})

export const pasteLinesContract = defineContract({
  params: quoteParams,
  body: input({
    version,
    /** The cells as copied from a sheet: a first row naming Style, Colourway, an optional Price and the size codes. */
    text: z.string().max(PASTE_LIMITS.text).optional(),
    /** Or the rows already split. */
    rows: z
      .array(input({ style: z.string().trim().min(1).max(60), colourway: z.string().trim().min(1).max(120), sizes: z.record(z.string(), z.number().int().min(0).max(MAX_SIZE_QUANTITY)), unitPrice: money.price(unitPrice().nullish()), /** B-W2b-374: a new line's options ("LINER:YES, NAME:NAME=BIANCHI"). */ options: z.string().trim().max(1000).nullish() }))
      .min(1)
      .max(PASTE_LIMITS.rows)
      .optional(),
    preview: z.boolean().optional(),
  }),
  response: {
    200: output({
      preview: z.boolean(),
      rows: z.array(
        output({
          row: z.number().int(),
          style: z.string(),
          colourway: z.string(),
          action: z.enum(['ADD', 'CHANGE', 'SKIP']),
          lineId: id().nullable(),
          /** The pieces that land, per size. */
          sizes: pieces,
          before: pieces.nullable(),
          after: pieces.nullable(),
          /** A new line's price: TYPED, LIST (the customer's list), NONE (0 until priced); KEPT on a line already there. */
          priceFrom: notMoney(z.enum(['TYPED', 'LIST', 'NONE', 'KEPT']).nullable()),
          /** B-W2b-374 (XF3:01): the options a new line takes from the Options column (what could not be read is in leftOut). */
          options: z.number().int(),
          leftOut: z.array(output({ size: z.string().nullable(), message: z.string() })),
          words: z.string(),
        }),
      ),
      counts: output({ rows: z.number().int(), added: z.number().int(), changed: z.number().int(), skipped: z.number().int(), cellsLanded: z.number().int(), cellsLeftOut: z.number().int() }),
      words: z.string(),
      quote: quoteView.optional(),
    }),
  },
})

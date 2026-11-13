import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { quoteSchema, type QuoteDetail } from '../api'

/**
 * Paste lines (B-W2b-316 on B-W2b-302's POST /sales/quotes/:quoteId/lines/paste, SAL-160): the cells as copied from a sheet,
 * asked with `preview: true` (what lands, row by row) and then written with the same text. Pieces only (no money in the
 * answer). Each row's `leftOut[].message` is English: the screen says its own words (paste/model.ts).
 */

const pieces = z.record(z.string(), z.number())

const rowSchema = z.object({
  row: z.number(),
  style: z.string(),
  colourway: z.string(),
  action: z.enum(['ADD', 'CHANGE', 'SKIP']),
  lineId: z.string().nullable(),
  sizes: pieces,
  before: pieces.nullable(),
  after: pieces.nullable(),
  priceFrom: z.enum(['TYPED', 'LIST', 'NONE', 'KEPT']).nullable(),
  /** B-W2b-374: the options a new line takes from the Options column. */
  options: z.number().optional(),
  leftOut: z.array(z.object({ size: z.string().nullable(), message: z.string() })),
})
export type PastedRow = z.infer<typeof rowSchema>

const pasteSchema = z.object({
  preview: z.boolean(),
  rows: z.array(rowSchema),
  counts: z.object({ rows: z.number(), added: z.number(), changed: z.number(), skipped: z.number(), cellsLanded: z.number(), cellsLeftOut: z.number() }),
  quote: quoteSchema.optional(),
})
export type PasteAnswer = z.infer<typeof pasteSchema>

export function pasteLines(api: ApiClient, quote: Pick<QuoteDetail, 'id' | 'version'>, text: string, preview: boolean, idempotencyKey?: string, signal?: AbortSignal): Promise<PasteAnswer> {
  return api.post(`/sales/quotes/${encodeURIComponent(quote.id)}/lines/paste`, {
    body: { version: quote.version, text, preview },
    schema: pasteSchema,
    signal,
    ...(preview ? {} : { idempotencyKey: idempotencyKey ?? newIdempotencyKey() }),
  })
}

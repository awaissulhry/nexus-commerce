import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../../../lib/api/client'
import { quoteSchema, type QuoteDetail } from '../../api'

/**
 * Target price (B-W2b-316 on B-W2b-302's POST /sales/quotes/:quoteId/goal-seek, SAL-150) and the customer's target from the
 * inquiry the quote came from (B-W2b-295's GET /sales/inquiries/source?quoteId=). Every figure is marked by grain: prices
 * the price grain, margins the margin grain, a margin AMOUNT the cost grain too — absent, never 0. The goal-seek writes
 * through B-W2b-330's price writer (a waterfall with the reason TARGET_PRICE); the screen never writes a price itself.
 */

const enc = encodeURIComponent

export const GOAL_KINDS = ['UNIT_PRICE', 'DISCOUNT', 'MARGIN', 'TOTAL'] as const
export type GoalKind = (typeof GOAL_KINDS)[number]

const amounts = z.object({ netAmount: z.number().optional(), vatAmount: z.number().optional(), grossAmount: z.number().optional() })

const goalLineSchema = z.object({
  lineId: z.string(),
  seq: z.number(),
  styleId: z.string(),
  colourwayId: z.string(),
  pieces: z.number(),
  start: z.object({ kind: z.enum(['LIST', 'SUGGESTED', 'MANUAL']), unitPrice: z.string().nullable().optional() }),
  from: z.object({ unitPrice: z.string().optional(), marginPct: z.string().nullable().optional() }),
  to: z.object({ unitPrice: z.string().optional(), marginPct: z.string().nullable().optional(), marginAmount: z.number().nullable().optional() }),
  discountPct: z.string().nullable().optional(),
  belowFloor: z.boolean().optional(),
  belowCost: z.boolean().optional(),
})
export type GoalLine = z.infer<typeof goalLineSchema>

const goalSchema = z.object({
  preview: z.boolean(),
  quoteId: z.string(),
  revision: z.number(),
  currency: z.string(),
  priceBasis: z.enum(['NET', 'GROSS']),
  lines: z.array(goalLineSchema),
  totals: z.object({ before: amounts.optional(), after: amounts.optional(), target: z.number().nullable().optional(), gap: z.number().nullable().optional() }).optional(),
  margin: z.object({ before: z.string().nullable().optional(), after: z.string().nullable().optional(), floorPct: z.string().optional() }).optional(),
  approval: z.object({ neededBefore: z.boolean(), neededAfter: z.boolean() }),
  held: z.array(z.object({ lineId: z.string(), seq: z.number(), code: z.enum(['BELOW_COST', 'REFUSED']) })),
  quote: quoteSchema.optional(),
})
export type GoalAnswer = z.infer<typeof goalSchema>

export interface GoalTarget {
  kind: GoalKind
  unitPrice?: string
  pct?: string
  marginPct?: string
  amount?: string
}

/** The plan (preview) or its write (one command, all or none: a held line refuses it). */
export function goalSeek(api: ApiClient, quote: Pick<QuoteDetail, 'id' | 'version'>, body: { lineIds?: string[]; target: GoalTarget }, preview: boolean, idempotencyKey?: string): Promise<GoalAnswer> {
  return api.post(`/sales/quotes/${enc(quote.id)}/goal-seek`, {
    body: { version: quote.version, ...(body.lineIds && body.lineIds.length > 0 ? { lineIds: body.lineIds } : {}), target: body.target, preview },
    schema: goalSchema,
    ...(preview ? {} : { idempotencyKey: idempotencyKey ?? newIdempotencyKey() }),
  })
}

const sourceSchema = z.object({
  inquiry: z
    .object({
      id: z.string(),
      number: z.string(),
      status: z.string(),
      wantedDate: z.string().nullable(),
      targetUnitPrice: z.string().nullable().optional(),
      currency: z.string(),
    })
    .nullable(),
})
export type QuoteSource = z.infer<typeof sourceSchema>['inquiry']

/** The inquiry this quote came from (null: none, or the person does not see inquiries). */
export async function quoteSource(api: ApiClient, quoteId: string, signal?: AbortSignal): Promise<QuoteSource> {
  return (await api.get('/sales/inquiries/source', { query: { quoteId }, schema: sourceSchema, signal })).inquiry
}

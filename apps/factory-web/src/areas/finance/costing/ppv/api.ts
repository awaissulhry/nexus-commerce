import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * B-W2b-424 — Finance › Costing › Purchase price variance (design finance.costing sec:ppv: "Material, supplier, standard,
 * paid, difference"; FIN-031) on B-W2b-407's GET /costing/ppv (costing.view over the company and the supplier): the
 * variances newest first, a page at a time, the totals per currency over every page, and the company's switch in words
 * while its figures wait for the accountant. Unit costs and differences are the cost grain (absent without it: the screen
 * draws no value column then). PPV_AT mirrors factory-domain costing/ppv/rules (ppv.vitest.test.ts holds it equal). The
 * API's English words are never drawn. No person is named.
 */

export const PPV_AT = ['RECEIPT', 'INVOICE'] as const

const cost = <T extends z.ZodTypeAny>(schema: T) => schema.optional()

const ppvRowSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  supplier: z.object({ id: z.string(), name: z.string() }),
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), baseUom: z.string() }),
  source: z.object({ at: z.enum(PPV_AT), documentId: z.string(), number: z.string(), lineId: z.string(), seq: z.number() }),
  postedAt: z.string(),
  day: z.string(),
  quantity: z.string(),
  standardUnitCost: cost(z.string()),
  paidUnitCost: cost(z.string()),
  differenceAmount: cost(z.number()),
  currency: z.string(),
  reversalOfId: z.string().nullable(),
  reversedBy: z.object({ id: z.string(), postedAt: z.string(), reason: z.string().nullable() }).nullable(),
  reason: z.string().nullable(),
})
export type PpvRow = z.infer<typeof ppvRowSchema>

const ppvAnswerSchema = z.object({
  rows: z.array(ppvRowSchema),
  nextCursor: z.string().nullable(),
  totals: z.array(z.object({ currency: z.string(), differenceAmount: cost(z.number()), rows: z.number() })),
  /** The API's words while the company's figures wait for the accountant (the screen says its own); null while on. */
  waits: z.string().nullable(),
})
export type PpvAnswer = z.infer<typeof ppvAnswerSchema>

export interface PpvQuery {
  readonly companyId: string | null
  /** Europe/Rome days of the posting, both included (the page's period). */
  readonly from: string
  readonly to: string
  readonly cursor?: string | null
  readonly limit?: number
}

/** GET /costing/ppv: the period's purchase price variances, newest first. */
export function getPpv(api: ApiClient, query: PpvQuery, signal?: AbortSignal): Promise<PpvAnswer> {
  const params: Record<string, string | number> = { from: query.from, to: query.to, limit: query.limit ?? 50 }
  if (query.companyId) params.companyId = query.companyId
  if (query.cursor) params.cursor = query.cursor
  return api.get('/costing/ppv', { query: params, schema: ppvAnswerSchema, signal })
}

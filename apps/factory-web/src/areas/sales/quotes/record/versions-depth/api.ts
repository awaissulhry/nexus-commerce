import { z } from 'zod'
import type { ApiClient } from '../../../../../lib/api/client'

/**
 * Compare two versions (B-W2b-316 on B-W2b-302's GET /sales/quotes/:quoteId/versions/compare?from=&to=, SAL-158), in the DS
 * VersionCompare's shape: sections terms and lines (no money), prices (the price grain: absent without it) and margin (the
 * margin grain). Fields come written language-free (codes, exact decimals, YYYY-MM-DD); the screen relabels them by id and
 * never shows the answer's English labels, `words` or `changeNote` (VersionCompare writes the note in the page's words).
 */

const enc = encodeURIComponent

const side = z.object({ fields: z.record(z.string(), z.string().nullable()), sizes: z.record(z.string(), z.string()).optional() })
const line = z.object({ id: z.string(), label: z.string(), detail: z.string().nullable(), before: side.nullable(), after: side.nullable() })
const total = z.object({ id: z.string(), before: z.string().nullable(), after: z.string().nullable() })
const sectionSchema = z.object({
  id: z.enum(['terms', 'lines', 'prices', 'margin']),
  fields: z.array(z.object({ id: z.string() })),
  sizes: z.array(z.string()),
  lines: z.array(line),
  totals: z.array(total),
  summary: z.object({ added: z.number(), removed: z.number(), changed: z.number(), unchanged: z.number() }),
})
export type CompareSection = z.infer<typeof sectionSchema>
const head = z.object({ id: z.string(), revision: z.number(), documentNumber: z.string() })

const compareSchema = z.object({
  quote: z.object({ id: z.string(), number: z.string(), currentRevision: z.number() }),
  before: head,
  after: head,
  currency: z.string(),
  sections: z.array(sectionSchema),
  prices: sectionSchema.optional(),
  margin: sectionSchema.optional(),
  differs: z.array(z.object({ section: z.string(), added: z.number(), removed: z.number(), changed: z.number() })),
})
export type VersionsCompared = z.infer<typeof compareSchema>

export function compareVersions(api: ApiClient, quoteId: string, from: number, to: number, signal?: AbortSignal): Promise<VersionsCompared> {
  return api.get(`/sales/quotes/${enc(quoteId)}/versions/compare`, { query: { from, to }, schema: compareSchema, signal })
}

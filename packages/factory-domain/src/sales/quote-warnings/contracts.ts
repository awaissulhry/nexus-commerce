import { z } from 'zod'
import { id, input, output } from '../../core/contracts'
import { grainedJson } from '../../money/marked'

/**
 * The quote's Warnings section (B-W2b-294; SAL-147; design sales.quotes quote.lines.warnings "What could stop this deal,
 * before anyone sends it"): what apps/factory-api's modules/sales/quote-warnings answers. Each warning is in words, with the
 * place that settles it; BLOCKS stops the send, WARNING is said, INFO is a fact ("Estimate — not released"). An amount
 * (what is overdue) is only in `details`, marked money.price: dropped without the price grain.
 */

export const warningsParams = input({ quoteId: id() })

export const WARNING_SEVERITIES = ['BLOCKS', 'WARNING', 'INFO'] as const
export type WarningSeverity = (typeof WARNING_SEVERITIES)[number]

/** Where a warning comes from: a line rule (modules/sales/line-checks, the same for orders) or the quote's own checks (W1). */
export const WARNING_SOURCES = ['LINE_RULE', 'QUOTE'] as const

export const warningView = output({
  code: z.string(),
  severity: z.enum(WARNING_SEVERITIES),
  source: z.enum(WARNING_SOURCES),
  /** The line rule's key (`minimums`, `private-label`, …); null for the quote's own checks. */
  check: z.string().nullable(),
  message: z.string(),
  lineIds: z.array(id()),
  seqs: z.array(z.number().int()),
  /** The record that settles it (the screen's Fix or Open); null: the quote itself. */
  open: output({ recordType: z.string(), recordId: id(), tab: z.string().nullable() }).nullable(),
  /** The rule's own facts (free JSON; amounts marked by grain). */
  details: grainedJson(),
})

export const warningsView = output({
  quoteId: id(),
  versionId: id(),
  revision: z.number().int(),
  /** Counted per severity. */
  counts: output({ blocks: z.number().int(), warnings: z.number().int(), info: z.number().int() }),
  warnings: z.array(warningView),
})

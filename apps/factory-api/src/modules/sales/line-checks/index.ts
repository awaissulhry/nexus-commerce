import type { Reader } from '../quotes/store'
import { minimumsCheck } from './minimums'

/**
 * The rules a quote's or an order's lines must meet (plan W2b-5: "each line rule is a file in modules/sales/line-checks,
 * run by quotes and orders alike"). A rule reads the document (its company, the price list that prices it, its goods
 * lines) and answers findings in words: BLOCKS stops the quote's send and refuses an order typed by the office; WARNING
 * is said and never stops anything. quotes/send.ts and orders/manual.ts run them through ./documents.ts; the screens read
 * them at GET /sales/quotes/:quoteId/line-checks and GET /sales/orders/:orderId/line-checks (modules/sales/pricing-depth).
 *
 * A new rule is one file here and one line in LINE_CHECKS (a merge point: keep every line).
 */

/** One goods line of the document (FEE lines are not goods: they never reach a rule). */
export interface LineCheckLine {
  readonly id: string | null
  readonly seq: number
  readonly styleId: string
  readonly colourwayId: string
  readonly styleRevisionId: string | null
  /** Pieces. */
  readonly quantity: number
  /** Materials chosen on the line as options (leather by article). */
  readonly optionItemIds: readonly string[]
}

export interface LineCheckDocument {
  readonly kind: 'QUOTE' | 'ORDER'
  readonly companyId: string
  /** The price list that prices it (the version it keeps, else the customer's list chain's first); null: none. */
  readonly priceListId: string | null
  readonly currency: string
  readonly lines: readonly LineCheckLine[]
}

export interface LineFinding {
  /** The rule's key (`minimums`). */
  readonly check: string
  readonly code: string
  readonly severity: 'BLOCKS' | 'WARNING'
  /** The lines it is about (none: the whole document). */
  readonly lineIds: readonly string[]
  readonly seqs: readonly number[]
  /** In the rule's words, without an amount. */
  readonly message: string
  /** The rule's own details (a minimum: its rule, count and small-run surcharge): free JSON, money marked with markMoney. */
  readonly details: Readonly<Record<string, unknown>>
}

export interface LineCheck {
  readonly key: string
  run(db: Reader, document: LineCheckDocument): Promise<readonly LineFinding[]>
}

export const LINE_CHECKS: readonly LineCheck[] = Object.freeze([
  // B-W2b-325 (SAL-178): minimum order quantities per style, kind of garment or material.
  minimumsCheck,
])

/** Every rule over the document, in LINE_CHECKS order; the BLOCKS first. */
export async function runLineChecks(db: Reader, document: LineCheckDocument, checks: readonly LineCheck[] = LINE_CHECKS): Promise<LineFinding[]> {
  if (document.lines.length === 0) return []
  const findings: LineFinding[] = []
  for (const check of checks) findings.push(...(await check.run(db, document)))
  return [...findings.filter((finding) => finding.severity === 'BLOCKS'), ...findings.filter((finding) => finding.severity !== 'BLOCKS')]
}

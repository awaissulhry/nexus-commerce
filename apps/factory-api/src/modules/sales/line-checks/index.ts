import type { Reader } from '../quotes/store'
import { minimumsCheck } from './minimums'
// B-W2b-294 (SAL-147; QT1:01, QT1:02): the customer and product warnings.
import { privateLabelCheck } from './private-label'
import { releasedScopeCheck } from './released-scope'
import { lifecycleCheck } from './lifecycle'
import { marketsCheck } from './markets'
import { materialsCheck } from './materials'
// B-W2b-358 (MM1:01; PRD-017, SAL-292): the made-to-measure units' rule (its own file in modules/sales/mtm).
import { mtmLineCheck } from '../mtm/line-check'
// B-W2b-340 (CF1:01; SAL-133, SAL-136): the configurator's rule (its own file in modules/sales/configurator).
import { configuratorLineCheck } from '../configurator/line-check'

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
  /** B-W2b-294: the sizes the line has pieces of (a size grid line); none known: the size rules skip the line. */
  readonly sizes?: readonly string[] | undefined
}

export interface LineCheckDocument {
  readonly kind: 'QUOTE' | 'ORDER'
  readonly companyId: string
  /** The price list that prices it (the version it keeps, else the customer's list chain's first); null: none. */
  readonly priceListId: string | null
  readonly currency: string
  readonly lines: readonly LineCheckLine[]
  /** B-W2b-294: the customer (the private-label rule); none: the rule skips the document. */
  readonly partyId?: string | null | undefined
  /** B-W2b-294: the country the goods go to (its delivery address, ISO 3166-1); none: the market rule skips it. */
  readonly shipToCountry?: string | null | undefined
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
  // B-W2b-294 (QT1:02, QT1:01; SAL-147): another customer's private-label style and a cell outside the released scope
  // (BLOCKS), a style being phased out, a market it is not sold in, a blocked material (WARNING).
  privateLabelCheck,
  releasedScopeCheck,
  lifecycleCheck,
  marketsCheck,
  materialsCheck,
  // B-W2b-358 (MM1:01): a made-to-measure unit: not started / outside the certified range (BLOCKS), measures not confirmed, not
  // the newest revision, older than 12 months (WARNING).
  mtmLineCheck,
  // B-W2b-340: options that no longer pass their rules, a choice the style asks and nobody made (BLOCKS a quote), an option
  // outside the certificate, options the price does not hold (WARNING); an order only warns.
  configuratorLineCheck,
])

/** Every rule over the document, in LINE_CHECKS order; the BLOCKS first. */
export async function runLineChecks(db: Reader, document: LineCheckDocument, checks: readonly LineCheck[] = LINE_CHECKS): Promise<LineFinding[]> {
  if (document.lines.length === 0) return []
  const findings: LineFinding[] = []
  for (const check of checks) findings.push(...(await check.run(db, document)))
  return [...findings.filter((finding) => finding.severity === 'BLOCKS'), ...findings.filter((finding) => finding.severity !== 'BLOCKS')]
}

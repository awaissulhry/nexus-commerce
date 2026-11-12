import type { BusinessDate } from '../../core/time'
import { inScope, sizeWords, type ReleaseScope } from '../../product/release/scope'
import { partyMaySee } from '../../product/style-texts/private-label'
import { daysFrom } from '../quote-terms/rules'
import type { WarningCode } from './codes'

/**
 * What could stop a deal, in words (B-W2b-294; SAL-147 "Customer and product warnings"; follow-ups QT1:01 "Quote lines refuse a
 * colourway or size outside the released scope", QT1:02 "Quotes refuse another customer's private-label style"; design
 * sales.quotes quote.lines.warnings), pure. apps/factory-api runs each but the overdue account as a line rule of
 * modules/sales/line-checks, so quotes and orders read the same findings: BLOCKS stops a quote's send and refuses an office
 * order (a quote started from a template leaves such a line out), WARNING is said and stops nothing.
 *
 *   PRIVATE_LABEL           BLOCKS   another customer's private-label style (Style.brandPartyId): only its brand, or a rider
 *                                    of the brand's team, buys it
 *   OUTSIDE_RELEASED_SCOPE  BLOCKS   a colourway or size its released revision is not released for (release/scope inScope);
 *                                    a style with no released revision is an estimate (W1's COST_ESTIMATE, INFO), not this
 *   STYLE_PHASE_OUT         WARNING  the style is being phased out (and what replaces it), or discontinued
 *   NOT_SOLD_IN_MARKET      WARNING  the style is not sold in the market the goods go to (Style.marketCodes; none: every one)
 *   BLOCKED_MATERIAL        WARNING  a material of the line (its BOM, a material chosen as an option) is refused for use
 *   ACCOUNT_OVERDUE         WARNING  the customer has invoices of the company past their due day (the amount: price grain);
 *                                    said in the quote's Warnings only (modules/sales/quote-warnings): the send's and the
 *                                    order's credit check is B-W2b-304's
 */

export { LINE_RULE_CODES, WARNING_CODES, type WarningCode } from './codes'

export type FindingSeverity = 'BLOCKS' | 'WARNING'

/** The record that settles a finding (the screen's "Fix" or "Open"). */
export interface FindingOpen {
  readonly recordType: 'Party' | 'Style' | 'Item' | 'Quote' | 'SalesOrder'
  readonly recordId: string
  /** The tab or section that settles it ("release", "markets", "holds", "receivables"). */
  readonly tab: string | null
}

export interface RuleFinding {
  readonly code: WarningCode
  readonly severity: FindingSeverity
  readonly message: string
  readonly open: FindingOpen | null
}

export interface LineLabel {
  readonly seq: number
  /** "SEED-JKT-01 BLK". */
  readonly label: string
}

const lineWords = (line: LineLabel): string => `Line ${line.seq} (${line.label})`

// ---- private label ------------------------------------------------------------------------------------------------------

export interface PrivateLabelStyle {
  readonly id: string
  readonly code: string
  readonly brandPartyId: string | null
}

/**
 * A private-label style is its brand's: a quote or order for anyone else is refused. A rider of the brand's team buys the
 * team's kit (B-W2b-290 riders: a person whose team is the brand).
 */
export function privateLabelFinding(line: LineLabel, style: PrivateLabelStyle, party: { readonly id: string; readonly teamPartyId: string | null }, brandName: string | null): RuleFinding | null {
  if (partyMaySee(style, party.id)) return null
  if (style.brandPartyId !== null && party.teamPartyId === style.brandPartyId) return null
  return {
    code: 'PRIVATE_LABEL',
    severity: 'BLOCKS',
    message: `${lineWords(line)}: ${style.code} is ${brandName ? `${brandName}'s` : "another customer's"} private-label style; it is made and sold for that brand only.`,
    open: { recordType: 'Style', recordId: style.id, tab: 'private-label' },
  }
}

// ---- the released scope ---------------------------------------------------------------------------------------------------

/**
 * A line of a released revision names a colourway or sizes that revision is not released for (PRD-191: released for some
 * colourways or sizes, the others waiting). `scope` null: the line's revision is not released (an estimate): no finding.
 */
export function scopeFinding(line: LineLabel & { readonly colourwayId: string; readonly sizes: readonly string[] }, style: { readonly id: string; readonly code: string; readonly sizes: readonly string[] }, revision: { readonly revision: number }, scope: ReleaseScope | null, colourwayCode: string): RuleFinding | null {
  if (scope === null) return null
  const colourwayOut = scope.colourwayIds.length > 0 && !scope.colourwayIds.includes(line.colourwayId)
  const sizesOut = colourwayOut ? [] : line.sizes.filter((size) => !inScope(scope, line.colourwayId, size))
  if (!colourwayOut && sizesOut.length === 0) return null
  const what = colourwayOut ? `colourway ${colourwayCode}` : `size${sizesOut.length === 1 ? '' : 's'} ${sizeWords(sizesOut, style.sizes)}`
  return {
    code: 'OUTSIDE_RELEASED_SCOPE',
    severity: 'BLOCKS',
    message: `${lineWords(line)}: ${style.code} revision ${revision.revision} is not released for ${what} yet. Release it for them first (the style's release), or quote what is released.`,
    open: { recordType: 'Style', recordId: style.id, tab: 'release' },
  }
}

// ---- the style's lifecycle --------------------------------------------------------------------------------------------------

export function lifecycleFinding(line: LineLabel, style: { readonly id: string; readonly code: string; readonly lifecycle: string }, replacedByCode: string | null): RuleFinding | null {
  if (style.lifecycle === 'PHASE_OUT') {
    return {
      code: 'STYLE_PHASE_OUT',
      severity: 'WARNING',
      message: `${lineWords(line)}: ${style.code} is being phased out: made and sold while stock and orders last${replacedByCode ? `; ${replacedByCode} replaces it` : ''}.`,
      open: { recordType: 'Style', recordId: style.id, tab: null },
    }
  }
  if (style.lifecycle === 'DISCONTINUED') {
    return {
      code: 'STYLE_PHASE_OUT',
      severity: 'WARNING',
      message: `${lineWords(line)}: ${style.code} is discontinued${replacedByCode ? `; ${replacedByCode} replaces it` : ''}: check it can still be made before it is promised.`,
      open: { recordType: 'Style', recordId: style.id, tab: null },
    }
  }
  return null
}

// ---- the market -------------------------------------------------------------------------------------------------------------

/**
 * The style names the markets it is sold in (Style.marketCodes; empty: every market) and the goods go elsewhere. `market`
 * is the market of the delivery address (its country, or its alias UK/GB, EL/GR); null: the address names none we know.
 */
export function marketFinding(line: LineLabel, style: { readonly id: string; readonly code: string; readonly marketCodes: readonly string[] }, market: { readonly code: string; readonly name: string } | null, country: string | null): RuleFinding | null {
  if (style.marketCodes.length === 0 || country === null) return null
  if (market !== null && style.marketCodes.includes(market.code)) return null
  const where = market ? `${market.name} (${market.code})` : country
  return {
    code: 'NOT_SOLD_IN_MARKET',
    severity: 'WARNING',
    message: `${lineWords(line)}: ${style.code} is not sold in ${where}, where the goods go (it is sold in ${style.marketCodes.join(', ')}): its labels, declaration and certificates may not cover that market.`,
    open: { recordType: 'Style', recordId: style.id, tab: 'markets' },
  }
}

// ---- materials ---------------------------------------------------------------------------------------------------------------

export interface MaterialFacts {
  readonly id: string
  readonly code: string
  /** Item.approval: BLOCKED is refused for use. */
  readonly approval: string
  readonly approvalNote: string | null
  /** MaterialComplianceProfile.state: BLOCKED may not be used. */
  readonly complianceState: string | null
  readonly complianceReason: string | null
}

export function materialFindings(line: LineLabel, materials: readonly MaterialFacts[]): RuleFinding[] {
  return materials.flatMap((material): RuleFinding[] => {
    const why = material.approval === 'BLOCKED' ? (material.approvalNote ?? 'refused for use') : material.complianceState === 'BLOCKED' ? (material.complianceReason ?? 'its compliance is blocked') : null
    if (why === null) return []
    return [{ code: 'BLOCKED_MATERIAL', severity: 'WARNING', message: `${lineWords(line)}: material ${material.code} is blocked (${why}): it may not be used until it is approved again or replaced.`, open: { recordType: 'Item', recordId: material.id, tab: null } }]
  })
}

// ---- the customer's account -----------------------------------------------------------------------------------------------

export interface OverdueInstalment {
  readonly invoiceNumber: string
  readonly dueDate: BusinessDate
  /** What is still open of it (minor units of `currency`). */
  readonly open: number
  readonly currency: string
}

export interface OverdueSummary {
  readonly invoices: number
  /** Per currency, what is past due (minor units; price grain). */
  readonly amounts: readonly { readonly currency: string; readonly amount: number }[]
  readonly oldestDueDate: BusinessDate
  readonly daysLate: number
}

/** The customer's instalments past their due day (open, due before today), summed; null: nothing is overdue. */
export function overdueOf(instalments: readonly OverdueInstalment[], today: BusinessDate): OverdueSummary | null {
  const late = instalments.filter((entry) => entry.open > 0 && entry.dueDate < today)
  if (late.length === 0) return null
  const amounts = new Map<string, number>()
  for (const entry of late) amounts.set(entry.currency, (amounts.get(entry.currency) ?? 0) + entry.open)
  const oldest = late.map((entry) => entry.dueDate).sort()[0]!
  return {
    invoices: new Set(late.map((entry) => entry.invoiceNumber)).size,
    amounts: [...amounts.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([currency, amount]) => ({ currency, amount })),
    oldestDueDate: oldest,
    daysLate: daysFrom(oldest, today),
  }
}

/** The words of an overdue account, without an amount (the amount is in the finding's details, price grain). */
export function overdueFinding(party: { readonly id: string; readonly legalName: string }, summary: OverdueSummary): RuleFinding {
  return {
    code: 'ACCOUNT_OVERDUE',
    severity: 'WARNING',
    message: `${party.legalName} has ${summary.invoices === 1 ? 'an invoice' : `${summary.invoices} invoices`} past due with this company, the oldest by ${summary.daysLate} day${summary.daysLate === 1 ? '' : 's'}: ask about the payment before the deal grows.`,
    open: { recordType: 'Party', recordId: party.id, tab: 'receivables' },
  }
}

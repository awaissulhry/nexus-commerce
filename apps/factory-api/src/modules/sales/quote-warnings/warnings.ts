import { businessDate } from '@nexus/factory-domain/core/time'
import type { QuoteIssue } from '@nexus/factory-domain/sales/quotes/quotes'
import type { WarningSeverity } from '@nexus/factory-domain/sales/quote-warnings/contracts'
import { COMMAND_SETTINGS, type CommandCaller } from '../../../core/command'
import { quoteDocumentOf } from '../line-checks/documents'
import { runLineChecks, type LineFinding } from '../line-checks/index'
import { officeQuote, type QuoteRow } from '../quotes/store'
import { readFacts } from '../quotes/views'
import { overdueWarning } from './overdue'

/**
 * The quote's Warnings section (B-W2b-294; SAL-147 "Customer and product warnings"; design sales.quotes quote.lines.warnings
 * "What could stop this deal, before anyone sends it"): GET /sales/quotes/:quoteId/warnings (quotes.view). One list, BLOCKS
 * first, each in words with the record that settles it:
 *
 *   the line rules      every rule of modules/sales/line-checks over the current version (the same ones orders run): another
 *                       customer's private-label style and a cell outside the released scope (BLOCKS), a minimum order
 *                       quantity (B-W2b-325), a style being phased out, a market it is not sold in, a blocked material
 *   the customer        an overdue account with the quote's company (./overdue.ts; the amount in details, price grain)
 *   the quote's own     W1's issues that are about the deal: the customer blocked or archived (BLOCKS), on hold for the company
 *                       (B-W2b-290), the VAT number not proven by VIES ("VAT charged at 22 %"), a size not covered by a valid
 *                       certificate at the promise date, a line costed from a draft revision ("Estimate — not released", INFO)
 *
 * The send dialog's checks read the same line rules (quotes/send.ts through line-checks/documents.ts).
 */

const QUOTE_CODES = ['PARTY_NOT_QUOTABLE', 'ACCOUNT_ON_HOLD', 'VIES_NOT_PROVEN', 'CERTIFICATE', 'COST_ESTIMATE'] as const

const severityOf = (issue: QuoteIssue): WarningSeverity => (issue.severity === 'BLOCKS' || issue.severity === 'BLOCKS_SEND' ? 'BLOCKS' : issue.severity === 'INFO' ? 'INFO' : 'WARNING')

/** Where W1's issue is settled: the customer's record (its holds, its tax identity) or the line's style. */
function openOf(issue: QuoteIssue, quote: QuoteRow, styleOfLine: ReadonlyMap<string, string>) {
  if (issue.code === 'PARTY_NOT_QUOTABLE') return { recordType: 'Party', recordId: quote.partyId, tab: null }
  if (issue.code === 'ACCOUNT_ON_HOLD') return { recordType: 'Party', recordId: quote.partyId, tab: 'holds' }
  if (issue.code === 'VIES_NOT_PROVEN') return { recordType: 'Party', recordId: quote.partyId, tab: 'tax' }
  const styleId = issue.lineId ? styleOfLine.get(issue.lineId) : undefined
  if (!styleId) return null
  return { recordType: 'Style', recordId: styleId, tab: issue.code === 'CERTIFICATE' ? 'certificates' : 'release' }
}

const openOfFinding = (finding: LineFinding) => {
  const open = (finding.details as { open?: { recordType: string; recordId: string; tab: string | null } | null }).open
  return open ? { recordType: open.recordType, recordId: open.recordId, tab: open.tab } : null
}

const detailsOf = (finding: LineFinding): Record<string, unknown> => {
  const { open: _open, ...rest } = finding.details as Record<string, unknown>
  return rest
}

/** GET /sales/quotes/:quoteId/warnings */
export async function quoteWarnings(caller: CommandCaller, quoteId: string) {
  const quote = await officeQuote(caller, quoteId)
  const now = COMMAND_SETTINGS.clock.now()
  return caller.withClient(async (db) => {
    const facts = await readFacts(db, quote, now)
    const document = await quoteDocumentOf(db, quote, facts.version, facts.lines, facts.party, now)
    const findings = await runLineChecks(db, document)
    const styleOfLine = new Map(facts.lines.map((line) => [line.id, line.styleId]))
    const seqOfLine = new Map(facts.lines.map((line) => [line.id, line.seq]))
    const fromRules = findings.map((finding) => ({
      code: finding.code,
      severity: finding.severity as WarningSeverity,
      source: 'LINE_RULE' as const,
      check: finding.check,
      message: finding.message,
      lineIds: [...finding.lineIds],
      seqs: [...finding.seqs],
      open: openOfFinding(finding),
      details: detailsOf(finding),
    }))
    const fromQuote = facts.issues
      .filter((issue) => (QUOTE_CODES as readonly string[]).includes(issue.code))
      .map((issue) => ({
        code: issue.code,
        severity: severityOf(issue),
        source: 'QUOTE' as const,
        check: null,
        message: issue.message,
        lineIds: issue.lineId ? [issue.lineId] : [],
        seqs: issue.lineId && seqOfLine.has(issue.lineId) ? [seqOfLine.get(issue.lineId)!] : [],
        open: openOf(issue, quote, styleOfLine),
        details: issue.size ? { size: issue.size } : {},
      }))
    const overdue = await overdueWarning(db, { companyId: quote.companyId, partyId: quote.partyId }, businessDate(now))
    const fromCustomer = overdue
      ? [{ code: overdue.finding.code, severity: overdue.finding.severity as WarningSeverity, source: 'QUOTE' as const, check: null, message: overdue.finding.message, lineIds: [] as string[], seqs: [] as number[], open: overdue.finding.open, details: overdue.details }]
      : []
    const rank: Record<WarningSeverity, number> = { BLOCKS: 0, WARNING: 1, INFO: 2 }
    const warnings = [...fromRules, ...fromCustomer, ...fromQuote].sort((a, b) => rank[a.severity] - rank[b.severity])
    return {
      quoteId: quote.id,
      versionId: facts.version.id,
      revision: facts.version.revision,
      counts: { blocks: warnings.filter((entry) => entry.severity === 'BLOCKS').length, warnings: warnings.filter((entry) => entry.severity === 'WARNING').length, info: warnings.filter((entry) => entry.severity === 'INFO').length },
      warnings,
    }
  })
}

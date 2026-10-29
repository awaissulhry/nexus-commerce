import type { MinorUnits } from '../core/money'
import type { PartyWarning } from '../parties/warnings'
import type { ViesState } from '../parties/vies'
import type { PartyTaxMode } from '../parties/tax'
import type { FatturaPaIssue } from './fatturapa/types'
import { amountText, DOC_TYPE_WORDS, type InvoiceDocType, type InvoiceTotals, type StoredTotals, totalsMatch } from './invoices'

/**
 * The checks before an invoice is issued (A2 SCR-081 "Before you issue"; FIN-085 pre-check; FIN-098, FIN-099; art. 41
 * DL 331/1993; DPR 633/1972 art. 21, 26), pure: each problem in plain words, with where to fix it. The API answers 409
 * with these before it takes a number, and the issue command checks the money ones again under its locks (the
 * …_money_guards triggers hold them for every login). An empty list: the invoice may be issued.
 *
 *   PARTY_BLOCKED / PARTY_ARCHIVED   the customer is blocked (a credit decision) or archived
 *   PARTY_WARNING                    a warning of the customer's record that stops an invoice (blocksInvoice: no tax
 *                                    identity, no registered office, a name an e-invoice cannot carry)
 *   NO_VIES_PROOF                    a zero-rated line to an EU business without a current VIES proof
 *   NO_LINES / TOTALS                no line, or totals that are not what the lines add up to
 *   SELLER / BUYER                   the company's or the customer's data FatturaPA needs
 *   FATTURAPA                        what the FatturaPA builder refuses (SDI's own rules, offline)
 *   DEPOSIT_*                        a TD02's deposit request: OPEN or PAID, its currency, never invoiced beyond its amount
 *   CURRENCY                         W1 invoices in euro only
 */

export interface IssueProblem {
  readonly code: string
  /** Where to fix it: `party`, `party/taxIdentity`, `company/regimeFiscale`, `lines/2/vat`, `depositRequest`… */
  readonly path: string
  readonly message: string
}

export interface IssueFacts {
  readonly docType: InvoiceDocType
  readonly currency: string
  readonly party: { readonly status: string; readonly legalName: string }
  readonly taxMode: PartyTaxMode | null
  /** The customer's record warnings at the invoice date (parties/warnings). */
  readonly warnings: readonly PartyWarning[]
  /** Where the customer stands with VIES at the invoice date (parties/vies). */
  readonly vies: { readonly state: ViesState; readonly message: string }
  /** The lines' VAT: the Natura of each zero-rated line (null when taxable). */
  readonly lineNatures: readonly (string | null)[]
  readonly stored: StoredTotals
  /** The totals the lines compute now (null when a line cannot be computed: its problems are in `lineIssues`). */
  readonly computed: InvoiceTotals | null
  readonly lineIssues: readonly { readonly path: string; readonly message: string }[]
  /** The company's and the customer's data problems (sellerOf, billToOf). */
  readonly dataIssues: readonly { readonly path: string; readonly message: string }[]
  /** What the FatturaPA builder refuses, with a stand-in number (the real one is taken at issue). */
  readonly fatturaPa: readonly FatturaPaIssue[]
  /** TD02: its deposit request and the gross of its other issued TD02s (less their credit notes). */
  readonly deposit?: { readonly status: string; readonly currency: string; readonly amount: MinorUnits; readonly invoicedGross: MinorUnits } | null
}

/** Zero-rated codes that rest on the buyer's VIES registration (intra-EU goods; B2B services, art. 7-ter). */
const VIES_NATURES = new Set(['N3.2', 'N2.1'])

export function issueProblems(facts: IssueFacts): IssueProblem[] {
  const problems: IssueProblem[] = []
  const add = (code: string, path: string, message: string) => problems.push({ code, path, message })
  const words = DOC_TYPE_WORDS[facts.docType].toLowerCase()

  if (facts.party.status === 'BLOCKED') add('PARTY_BLOCKED', 'party', `${facts.party.legalName} is blocked: no ${words} is issued to a blocked customer. Unblock it first, if that is right.`)
  else if (facts.party.status === 'ARCHIVED') add('PARTY_ARCHIVED', 'party', `${facts.party.legalName} is archived: reactivate the customer before invoicing it.`)
  for (const warning of facts.warnings.filter((entry) => entry.blocksInvoice)) add('PARTY_WARNING', `party/${warning.code}`, warning.message)

  if (facts.taxMode === 'EU_B2B' && facts.lineNatures.some((nature) => nature !== null && VIES_NATURES.has(nature)) && facts.vies.state !== 'VALID') {
    add('NO_VIES_PROOF', 'party/vies', `A sale to a business in another EU state is zero-rated only with a current VIES proof (art. 41 DL 331/1993). ${facts.vies.message} Run the VIES check, or charge Italian VAT on the lines.`)
  }

  if (facts.currency !== 'EUR') add('CURRENCY', 'currency', `Invoices are issued in euro; this one is in ${facts.currency}.`)
  if (facts.stored.lines.length === 0) add('NO_LINES', 'lines', `The ${words} has no line: add what it bills.`)
  for (const issue of facts.lineIssues) add('LINE', issue.path, issue.message)
  if (facts.computed !== null && facts.stored.lines.length > 0 && !totalsMatch(facts.stored, facts.computed)) {
    add(
      'TOTALS',
      'totals',
      `The totals do not add up: the ${words} says ${amountText(facts.stored.grossTotal, facts.currency)} in total, its lines make ${amountText(facts.computed.grossTotal, facts.currency)}. Save its lines again to compute them.`,
    )
  }
  for (const issue of facts.dataIssues) add(issue.path.startsWith('company') ? 'SELLER' : 'BUYER', issue.path, issue.message)
  for (const issue of facts.fatturaPa) add('FATTURAPA', issue.path, `The e-invoice would be refused: ${issue.path} ${issue.message}.`)

  if (facts.docType === 'TD02') {
    const deposit = facts.deposit
    if (!deposit) add('DEPOSIT_MISSING', 'depositRequest', 'A deposit invoice invoices a deposit request; this one names none.')
    else {
      if (deposit.status !== 'OPEN' && deposit.status !== 'PAID') add('DEPOSIT_STATE', 'depositRequest', `The deposit request is ${deposit.status}: a deposit invoice is issued only for an OPEN or PAID request.`)
      if (deposit.currency !== facts.currency) add('DEPOSIT_CURRENCY', 'depositRequest', `The deposit request is in ${deposit.currency}, the invoice in ${facts.currency}.`)
      if (deposit.invoicedGross + facts.stored.grossTotal > deposit.amount) {
        add(
          'DEPOSIT_OVER_REQUEST',
          'depositRequest',
          `The deposit request asks for ${amountText(deposit.amount, deposit.currency)} and ${amountText(deposit.invoicedGross, deposit.currency)} of it is invoiced already: this deposit invoice of ${amountText(facts.stored.grossTotal, facts.currency)} would pass it.`,
        )
      }
      if (facts.stored.grossTotal <= 0) add('DEPOSIT_ZERO', 'totals', 'A deposit invoice has a total above 0.')
    }
  }
  return problems
}

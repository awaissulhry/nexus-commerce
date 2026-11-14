import type { Issue } from '../../core/errors'
import { fitsDecimal, type MinorUnits } from '../../core/money'
import { formatMoney } from '../../documents/format'
import { DEPOSIT_KIND_WORDS } from '../../sales/order-changes/priced'
import { Dec, parseDecimal } from '../../tax/decimal'

/**
 * The deposit when an order is cancelled (B-W2b-396; FIN-080 "Deposit on cancellation"; c.c. artt. 1385, 1386; D.Lgs.
 * 206/2005 art. 59 c.1 lett. c: no right of withdrawal for goods made to the consumer's measure), pure.
 *
 * A company keeps rules (factory-db tax.prisma DepositCancellationRule, B-W2b-369): for a kind of deposit (an advance
 * ACCONTO, a caparra confirmatoria CAPARRA, a caparra penitenziale), who cancels (the CUSTOMER or the COMPANY) and which
 * orders (made to measure, the others, or any), what is paid back (REFUND_ALL; KEEP_PERCENT: a share is kept, 100 = all;
 * REFUND_DOUBLE: twice the deposit, only a caparra when the company cancels) and which document follows for what is paid
 * back (a credit note TD04 of the deposit invoice TD02, or none). The rule of an exact order type wins over an "any" one.
 *
 * When an order is cancelled, each deposit request it was paid on gets its outcome: what is kept, what is paid back (and
 * the extra half of a double), and the credit note's amount: the part paid back that a deposit invoice billed and no credit
 * note gave back yet. No rule → everything is paid back (nothing is kept without a rule the company set), with a credit
 * note of what was invoiced. The refund itself is paid in Finance › Payments (the credit note leaves it due).
 *
 * UNVERIFIED (GATE-ACCOUNTANT, `DEPOSIT_CANCELLATION_RULE`): the document for a kept caparra (damages, outside VAT: art.
 * 15 DPR 633/1972) and the extra half of a double are the accountant's; no rule row is made by itself.
 */

export const CANCELLED_BY = ['CUSTOMER', 'COMPANY'] as const
export type CancelledBy = (typeof CANCELLED_BY)[number]
export const REFUND_RULES = ['REFUND_ALL', 'KEEP_PERCENT', 'REFUND_DOUBLE'] as const
export type RefundRule = (typeof REFUND_RULES)[number]
export const CANCELLATION_DOCUMENTS = ['CREDIT_NOTE', 'NONE'] as const
export type CancellationDocument = (typeof CANCELLATION_DOCUMENTS)[number]
export const CANCELLATION_DEPOSIT_KINDS = ['ACCONTO', 'CAPARRA', 'CAPARRA_PENITENZIALE'] as const
export type CancellationDepositKind = (typeof CANCELLATION_DEPOSIT_KINDS)[number]
export const RULE_NOTE_MAX = 500

export const DEPOSIT_CANCELLATION_RULE = Object.freeze({
  status: 'UNVERIFIED' as const,
  gate: 'GATE-ACCOUNTANT' as const,
  words: 'What is kept or paid back when an order is cancelled follows the company’s own rules; without one, everything is paid back. Your accountant confirms the document for a kept caparra and for the extra half paid back.',
})

const CANCELLED_BY_WORDS: Readonly<Record<CancelledBy, string>> = { CUSTOMER: 'the customer cancels', COMPANY: 'we cancel' }

export interface RuleInput {
  readonly depositKind: CancellationDepositKind
  readonly cancelledBy: CancelledBy
  readonly madeToMeasure: boolean | null
  readonly refundRule: RefundRule
  readonly keepPct: string
  readonly documentKind: CancellationDocument
  readonly note: string | null
}

/** A rule as given, checked as the database checks it, each problem in words. */
export function ruleProblems(input: RuleInput, path = 'body'): Issue[] {
  const issues: Issue[] = []
  const pct = parseDecimal(input.keepPct)
  if (pct === null || !fitsDecimal(input.keepPct, 7, 4) || pct.lt(0) || pct.gt(100)) issues.push({ path: `${path}/keepPct`, message: 'The share kept is 0 to 100 percent, with at most 4 decimals.' })
  else if (input.refundRule === 'KEEP_PERCENT' && pct.lte(0)) issues.push({ path: `${path}/keepPct`, message: 'Keeping a percent keeps above 0 percent (pay all back with REFUND_ALL).' })
  else if (input.refundRule !== 'KEEP_PERCENT' && !pct.eq(0)) issues.push({ path: `${path}/keepPct`, message: 'Only KEEP_PERCENT keeps a share: send 0.' })
  if (input.refundRule === 'REFUND_DOUBLE' && !(input.cancelledBy === 'COMPANY' && (input.depositKind === 'CAPARRA' || input.depositKind === 'CAPARRA_PENITENZIALE'))) {
    issues.push({ path: `${path}/refundRule`, message: 'Twice the deposit is paid back only for a caparra, when we cancel (c.c. artt. 1385, 1386).' })
  }
  if (input.refundRule === 'KEEP_PERCENT' && pct !== null && pct.eq(100) && input.documentKind !== 'NONE') {
    issues.push({ path: `${path}/documentKind`, message: 'All of it is kept: nothing is paid back, so no document follows (NONE).' })
  }
  if (input.note !== null && (input.note.trim() === '' || input.note.length > RULE_NOTE_MAX)) issues.push({ path: `${path}/note`, message: `A note of 1 to ${RULE_NOTE_MAX} characters, or none.` })
  return issues
}

export interface RuleFacts extends RuleInput {
  readonly id: string
}

/** The rule for a deposit of this kind, side and order: the exact order type's first, else the "any" one; null: none. */
export function pickRule<Rule extends RuleFacts>(rules: readonly Rule[], ask: { readonly depositKind: string; readonly cancelledBy: CancelledBy; readonly madeToMeasure: boolean }): Rule | null {
  const fitting = rules.filter((rule) => rule.depositKind === ask.depositKind && rule.cancelledBy === ask.cancelledBy)
  return fitting.find((rule) => rule.madeToMeasure === ask.madeToMeasure) ?? fitting.find((rule) => rule.madeToMeasure === null) ?? null
}

export interface DepositFacts {
  readonly depositKind: string
  readonly currency: string
  /** What was paid on the request (its allocations), minor units. */
  readonly paid: MinorUnits
  /** What its issued deposit invoices billed, less their credit notes (gross), minor units. */
  readonly invoiced: MinorUnits
}

export interface DepositOutcome {
  readonly source: 'RULE' | 'NO_RULE'
  readonly refundRule: RefundRule
  readonly keepPct: string
  readonly kept: MinorUnits
  /** Paid back of the deposit itself. */
  readonly refund: MinorUnits
  /** REFUND_DOUBLE: the second half paid back (outside the deposit invoice). */
  readonly extra: MinorUnits
  readonly document: CancellationDocument
  /** The credit note's gross: the part paid back that a deposit invoice billed (0: none). */
  readonly creditAmount: MinorUnits
  readonly words: string
}

const keptOf = (paid: MinorUnits, pct: string): MinorUnits => Number.parseInt(new Dec(paid).times(new Dec(pct)).dividedBy(100).toDecimalPlaces(0, Dec.ROUND_HALF_UP).toFixed(0), 10)

/** What happens to one paid deposit when its order is cancelled by `cancelledBy`, under `rule` (null: none). */
export function depositOutcomeOf(deposit: DepositFacts, rule: RuleFacts | null, cancelledBy: CancelledBy): DepositOutcome {
  const refundRule: RefundRule = rule?.refundRule ?? 'REFUND_ALL'
  const keepPct = rule ? new Dec(rule.keepPct).toFixed(4) : '0.0000'
  const paid = Math.max(0, deposit.paid)
  const kept = refundRule === 'KEEP_PERCENT' ? Math.min(paid, keptOf(paid, keepPct)) : 0
  const refund = paid - kept
  const extra = refundRule === 'REFUND_DOUBLE' ? paid : 0
  const document: CancellationDocument = rule ? rule.documentKind : 'CREDIT_NOTE'
  const creditAmount = document === 'CREDIT_NOTE' ? Math.max(0, Math.min(refund, deposit.invoiced)) : 0
  const money = (amount: MinorUnits) => formatMoney(amount, deposit.currency, 'en')
  const kind = (DEPOSIT_KIND_WORDS as Record<string, { en: string }>)[deposit.depositKind]?.en ?? deposit.depositKind
  const head = rule ? `${kind}, ${CANCELLED_BY_WORDS[cancelledBy]}: the company's rule` : `${kind}, ${CANCELLED_BY_WORDS[cancelledBy]}: no rule of the company, so all of it is paid back`
  const what =
    paid === 0
      ? 'nothing was paid on it.'
      : refundRule === 'REFUND_DOUBLE'
        ? `pay back twice the deposit, ${money(refund + extra)} (${money(extra)} of it outside the deposit invoice).`
        : kept === paid
          ? `keep all of it, ${money(kept)}.`
          : kept > 0
            ? `keep ${money(kept)} (${new Dec(keepPct).toString()}%) and pay back ${money(refund)}.`
            : `pay back ${money(refund)}.`
  const doc = creditAmount > 0 ? ` A credit note of ${money(creditAmount)} follows for the deposit invoice.` : document === 'NONE' && refund > 0 ? ' No document follows (the rule says none).' : ''
  return { source: rule ? 'RULE' : 'NO_RULE', refundRule, keepPct, kept, refund, extra, document, creditAmount, words: `${head}: ${what}${doc}` }
}

/** An order is made to measure (for these rules) when a line of goods names a measurement profile, or the order says so. */
export const madeToMeasureOf = (order: { readonly noWithdrawal: boolean; readonly lines: readonly { readonly kind: string; readonly measurementProfileId: string | null }[] }): boolean =>
  order.noWithdrawal || order.lines.some((line) => line.kind !== 'FEE' && line.measurementProfileId !== null)
